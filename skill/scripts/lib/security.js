import { findSecrets } from './redact.js';
import { stripComments } from './gradle.js';

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
const SOURCE_RE = /\.(?:java|kt)$/;
const GRADLE_RE = /(?:^|\/)[^/]*\.(?:gradle|gradle\.kts)$/;
const PROPERTIES_RE = /\.properties$/;
const NETWORK_CONFIG_RE = /(?:^|\/)src\/[^/]+\/res\/xml\/[^/]+\.xml$/;
const MAX_TAG = 4000;

const SENSITIVE_LOG_CALL = /\b(?:Log|Timber)\.[vdiwe]\(/;
const SENSITIVE_WORD = /password|token|secret|pin\b|otp\b/i;
const WEBVIEW_FILE_ACCESS = /\b(?:setAllowFileAccess|setAllowUniversalAccessFromFileURLs|setAllowFileAccessFromFileURLs)\(\s*true\s*\)/;

const RELEASE_HEADER = /^(?:release|(?:getByName|named|maybeCreate)\s*\(\s*["']release["']\s*\))$/;
const DEBUGGABLE_TRUE = /^(?:debuggable\s*(?:=\s*)?true|isDebuggable\s*=\s*true)\b/;
const MINIFY_FALSE = /^(?:minifyEnabled\s*(?:=\s*)?false|isMinifyEnabled\s*=\s*false)\b/;

function finding(id, severity, file, line, detail) {
  return { id, severity, file, line, detail };
}

/** Blank out XML comments, keeping every newline so line numbers hold. */
function stripXmlComments(text) {
  let out = '';
  let i = 0;
  for (;;) {
    const start = text.indexOf('<!--', i);
    if (start < 0) return out + text.slice(i);
    const end = text.indexOf('-->', start + 4);
    const stop = end < 0 ? text.length : end + 3;
    out += text.slice(i, start) + text.slice(start, stop).replace(/[^\n]/g, ' ');
    i = stop;
  }
}

/** Returns a function mapping a character offset to a 1-based line number. */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function scanManifest(file, lines, out) {
  const text = stripXmlComments(lines.join('\n'));
  const lineAt = lineIndex(text);
  const tagRe = new RegExp(`<(application|activity|service|receiver|provider)(?=[\\s>/])[^>]{0,${MAX_TAG}}>`, 'g');
  const attr = (tag, name) => new RegExp(`\\bandroid:${name}\\s*=\\s*"([^"]{0,200})"`).exec(tag);
  const attrLine = (m, tag, name) => {
    const a = new RegExp(`\\bandroid:${name}\\s*=`).exec(tag);
    return lineAt(m.index + (a ? a.index : 0));
  };
  let m;
  while ((m = tagRe.exec(text))) {
    const [tag, name] = m;
    if (attr(tag, 'debuggable')?.[1] === 'true') {
      out.push(finding('debuggable-release', 'high', file, attrLine(m, tag, 'debuggable'), 'android:debuggable="true" in the manifest'));
    }
    if (name === 'application') {
      if (attr(tag, 'usesCleartextTraffic')?.[1] === 'true') {
        out.push(finding('cleartext-traffic', 'high', file, attrLine(m, tag, 'usesCleartextTraffic'), 'android:usesCleartextTraffic="true" allows plain HTTP'));
      }
      if (attr(tag, 'allowBackup')?.[1] === 'true' && !attr(tag, 'dataExtractionRules') && !attr(tag, 'fullBackupContent')) {
        out.push(finding('allow-backup', 'medium', file, attrLine(m, tag, 'allowBackup'), 'android:allowBackup="true" without dataExtractionRules or fullBackupContent'));
      }
      continue;
    }
    if (attr(tag, 'exported')?.[1] !== 'true' || attr(tag, 'permission')) continue;
    if (name === 'activity' && !tag.endsWith('/>')) {
      const close = text.indexOf('</activity>', m.index + tag.length);
      const body = text.slice(m.index + tag.length, close < 0 ? text.length : close);
      if (body.includes('android.intent.category.LAUNCHER')) continue;
    }
    out.push(finding('exported-component', 'medium', file, attrLine(m, tag, 'exported'), `exported ${name} without android:permission`));
  }
}

function scanNetworkConfig(file, lines, out) {
  lines.forEach((text, i) => {
    if (/cleartextTrafficPermitted\s*=\s*"true"/.test(text)) {
      out.push(finding('cleartext-traffic', 'high', file, i + 1, 'network security config permits cleartext traffic'));
    }
  });
}

/** Brace tracking over comment-stripped Gradle text; release is only a build type inside `buildTypes`. */
function scanGradleBuildTypes(file, lines, out) {
  const clean = stripComments(lines.join('\n')).split('\n');
  const stack = [];
  const inRelease = () => stack.some((b) => b.release);
  const test = (segment, line) => {
    const s = segment.trim();
    if (!inRelease() || !s) return;
    if (DEBUGGABLE_TRUE.test(s)) out.push(finding('debuggable-release', 'high', file, line, 'debuggable is enabled in the release build type'));
    if (MINIFY_FALSE.test(s)) out.push(finding('minify-disabled-release', 'low', file, line, 'code shrinking (R8) is disabled in the release build type'));
  };
  clean.forEach((text, i) => {
    let buf = '';
    const flushStatements = () => {
      for (const part of buf.split(';')) test(part, i + 1);
      buf = '';
    };
    for (const ch of text) {
      if (ch === '{') {
        const header = buf.trim();
        const release = RELEASE_HEADER.test(header) && stack.some((b) => /^buildTypes\b/.test(b.header));
        stack.push({ header, release });
        buf = '';
      } else if (ch === '}') {
        flushStatements();
        stack.pop();
      } else {
        buf += ch;
      }
    }
    flushStatements();
  });
}

function scanSource(file, lines, out) {
  lines.forEach((text, i) => {
    const line = i + 1;
    if (text.includes('addJavascriptInterface(')) out.push(finding('webview-js-interface', 'medium', file, line, 'WebView exposes a Java object to JavaScript'));
    if (WEBVIEW_FILE_ACCESS.test(text)) out.push(finding('webview-file-access', 'medium', file, line, 'WebView file access is enabled'));
    if (SENSITIVE_LOG_CALL.test(text) && SENSITIVE_WORD.test(text)) out.push(finding('sensitive-log', 'low', file, line, 'log statement mentions a sensitive word'));
  });
}

function scanSecrets(file, lines, out) {
  for (const hit of findSecrets(lines.join('\n'))) out.push(finding('hardcoded-secret', 'high', file, hit.line, hit.kind));
}

/** Deterministic Android security signals from manifests, Gradle files and sources. */
export function securityFindings(ctx) {
  const out = [];
  const manifests = new Set(ctx.manifests);
  for (const file of ctx.files) {
    const isManifest = manifests.has(file);
    const isNetworkConfig = NETWORK_CONFIG_RE.test(file);
    const isSource = SOURCE_RE.test(file);
    const isGradle = GRADLE_RE.test(file);
    if (!isManifest && !isNetworkConfig && !isSource && !isGradle && !PROPERTIES_RE.test(file)) continue;
    const lines = ctx.read(file);
    if (!lines) continue;
    if (isManifest) scanManifest(file, lines, out);
    if (isNetworkConfig) scanNetworkConfig(file, lines, out);
    if (isGradle) scanGradleBuildTypes(file, lines, out);
    if (isSource) scanSource(file, lines, out);
    if (isSource || isGradle || PROPERTIES_RE.test(file)) scanSecrets(file, lines, out);
  }
  const seen = new Set();
  return out
    .filter((f) => {
      const k = `${f.id}\0${f.file}\0${f.line}\0${f.detail}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
