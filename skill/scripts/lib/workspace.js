import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from './gradle.js';
import { discoverModules } from './modules.js';
import { listFiles } from './walk.js';

const PUBLISH_PLUGINS = ['maven-publish', 'com.vanniktech.maven.publish'];
const SETTINGS_OR_BUILD = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'];
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const posix = (p) => p.split(path.sep).join('/');

function readStripped(root, rel) {
  try {
    return stripComments(fs.readFileSync(path.join(root, rel), 'utf8').replace(/^﻿/, ''));
  } catch {
    return '';
  }
}

/** First quoted literal assigned to `key` (`key = "x"` or `key 'x'`); values with `$` interpolation are unresolvable. */
function literals(text, key) {
  const re = new RegExp(`(?:^|[\\s;{(])${key}\\s*(?:=\\s*|\\s+)(["'])([^"'\\n]*)\\1`, 'g');
  return [...text.matchAll(re)].map((m) => m[2]).filter((v) => v && !v.includes('$'));
}

function appliesPublish(module, text) {
  if (module.build.plugins.some((p) => PUBLISH_PLUGINS.includes(p.id))) return true;
  return PUBLISH_PLUGINS.some((id) => text.includes(`"${id}"`) || text.includes(`'${id}'`) || text.includes('`' + id + '`'));
}

function moduleRows(root) {
  const modules = discoverModules(root, listFiles(root));
  const rootBuild = ['build.gradle.kts', 'build.gradle'].find((f) => fs.existsSync(path.join(root, f)));
  const rootText = rootBuild ? readStripped(root, rootBuild) : '';
  return { modules, rootText };
}

/** Published coordinates (`group:name`) of a repo, sorted. */
export function publishedArtifacts(root) {
  const { modules, rootText } = moduleRows(root);
  const out = new Set();
  for (const m of modules) {
    if (!m.buildFile) continue;
    const text = readStripped(root, m.buildFile);
    if (!appliesPublish(m, text)) continue;
    const groups = [...literals(text, 'groupId'), ...literals(text, 'group')];
    if (!groups.length) groups.push(...literals(rootText, 'group'));
    const names = literals(text, 'artifactId');
    if (!names.length) names.push(m.dir ? path.posix.basename(m.dir) : path.basename(fs.realpathSync(root)));
    for (const g of new Set(groups.slice(0, 1))) for (const n of names) out.add(`${g}:${n}`);
  }
  return [...out].sort(byText);
}

/** Sibling directories of hubRoot that look like Gradle repos, absolute and sorted. */
export function siblingRepos(hubRoot) {
  const hub = fs.realpathSync(hubRoot);
  const parent = path.dirname(hub);
  const out = [];
  for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
    const abs = path.join(parent, e.name);
    if (abs === hub || e.name.startsWith('.')) continue;
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (SETTINGS_OR_BUILD.some((f) => fs.existsSync(path.join(abs, f)))) out.push(abs);
  }
  return out.sort(byText);
}

/** Build the repos.json content for a hub and its member repos. */
export function linkWorkspace(hubRoot, repoPaths, { confirmed }) {
  const hub = fs.realpathSync(hubRoot);
  const all = [hub, ...repoPaths.map((p) => fs.realpathSync(p))];
  const infos = all.map((abs, i) => ({
    abs,
    name: path.basename(abs),
    path: i === 0 ? '.' : posix(path.relative(hub, abs)),
    artifacts: publishedArtifacts(abs),
  }));
  const links = [];
  for (const consumer of infos) {
    const { modules } = moduleRows(consumer.abs);
    for (const m of modules) {
      if (!m.buildFile) continue;
      for (const d of m.build.dependencies) {
        if (!d.group || !d.name) continue;
        const key = `${d.group}:${d.name}`;
        for (const producer of infos) {
          if (producer === consumer || !producer.artifacts.includes(key)) continue;
          links.push({
            consumer: consumer.name,
            producer: producer.name,
            artifact: key,
            version: d.version ?? null,
            file: m.buildFile,
            line: d.line,
          });
        }
      }
    }
  }
  links.sort((a, b) => byText(a.consumer, b.consumer) || byText(a.producer, b.producer) || byText(a.artifact, b.artifact) || byText(a.file, b.file) || a.line - b.line);
  return {
    schemaVersion: 1,
    hub: '.',
    repos: infos.map(({ name, path: p, artifacts }) => ({ name, path: p, artifacts, confirmed })),
    links,
  };
}
