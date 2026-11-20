// Platform compliance advice: the targetSdk policy plus dated policy entries from the catalog (compliance.json).
// Everything here is a linear, bounded scan of files already read by the shared detection context. Where a
// policy applies but the project cannot be verified statically the status is `check` (or `unknown` when the
// target level is not resolvable); `ok` is only reported with evidence or when the policy does not bite yet.

import { stripCode, stripXmlComments } from './strip.js';

const COMPLIANCE_DIM = 'compliance';
const TARGET_SDK_MIN = 'targetSdkMin';
const PAGE_SIZE = 'pageSizeBytes';
const MAX_SERVICE_LINES = 20;
const tagStart = (text, tag) => {
  // `<service` but not `<service-alias` or `<serviceX`.
  let from = 0;
  for (;;) {
    const i = text.indexOf(tag, from);
    if (i < 0) return false;
    if (!/[-\w]/.test(text[i + tag.length] ?? ' ')) return true;
    from = i + tag.length;
  }
};

/** One pass over manifests, sources and build files: first evidence ({ file, line }) per signal, plus service counts. */
function scanSignals(ctx) {
  const ev = {};
  const mark = (key, file, line) => {
    if (ev[key] === undefined) ev[key] = { file, line };
  };
  const services = { typed: 0, untyped: 0 };
  for (const f of ctx.manifests) {
    const raw = ctx.read(f);
    if (!raw) continue;
    const lines = stripXmlComments(raw);
    lines.forEach((text, i) => {
      const t = text.trim();
      if (t.includes('SCHEDULE_EXACT_ALARM') || t.includes('USE_EXACT_ALARM')) mark('exactAlarmManifest', f, i + 1);
      if (t.includes('POST_NOTIFICATIONS')) mark('postNotifications', f, i + 1);
      if (t.includes('READ_EXTERNAL_STORAGE')) {
        let tag = t;
        for (let j = i + 1; j < lines.length && j < i + MAX_SERVICE_LINES && !tag.includes('>'); j++) tag += ' ' + lines[j];
        mark(tag.includes('maxSdkVersion') ? 'readExternalScoped' : 'readExternalStorage', f, i + 1);
      }
      if (t.includes('READ_MEDIA_')) mark('readMedia', f, i + 1);
      if (t.includes('enableOnBackInvokedCallback') && /enableOnBackInvokedCallback\s*=\s*"true"/.test(t)) mark('backCallback', f, i + 1);
      if (tagStart(t, '<service')) {
        let text = t;
        for (let j = i + 1; j < lines.length && j < i + MAX_SERVICE_LINES && !text.includes('>'); j++) text += ' ' + lines[j];
        if (text.includes('foregroundServiceType')) services.typed++;
        else {
          services.untyped++;
          mark('untypedService', f, i + 1);
        }
      }
    });
  }
  for (const f of ctx.sourceFiles) {
    const raw = ctx.read(f);
    if (!raw) continue;
    stripCode(raw).forEach((text, i) => {
      const t = text.trim();
      if (t.includes('startForeground(')) mark('startForeground', f, i + 1);
      if (t.includes('NotificationManager')) mark('notificationManager', f, i + 1);
      if (t.includes('setExact')) mark('exactAlarmCall', f, i + 1);
      if (t.includes('canScheduleExactAlarms')) mark('canScheduleExact', f, i + 1);
      if (t.includes('enableEdgeToEdge(')) mark('edgeToEdge', f, i + 1);
    });
  }
  for (const f of ctx.files) {
    if (f.endsWith('.so') && f.split('/').includes('jniLibs')) mark('nativeLib', f, null);
    if (/\.gradle(\.kts)?$/.test(f)) {
      const lines = ctx.read(f);
      if (lines) stripCode(lines).forEach((text, i) => {
        if (text.includes('externalNativeBuild')) mark('nativeBuild', f, i + 1);
        else if (/\bndk\s*\{/.test(text)) mark('nativeBuild', f, i + 1);
      });
    }
  }
  return { ev, services };
}

const at = (e) => (e ? (e.line === null ? e.file : `${e.file}:${e.line}`) : '');

/** Signal presence for appliesWhen (booleans) from the scan. */
function signalValues({ ev }) {
  return {
    hasNative: ev.nativeLib !== undefined || ev.nativeBuild !== undefined,
    usesForegroundService: ev.startForeground !== undefined,
    usesExactAlarm: ev.exactAlarmManifest !== undefined || ev.exactAlarmCall !== undefined,
    usesNotifications: ev.notificationManager !== undefined || ev.postNotifications !== undefined,
    usesMediaStorage: ev.readExternalStorage !== undefined || ev.readExternalScoped !== undefined || ev.readMedia !== undefined,
  };
}

function appliesWhen(aw, sig, sdk) {
  for (const [k, want] of Object.entries(aw)) {
    if (k === TARGET_SDK_MIN) {
      if (sdk.targetSdk === null || sdk.targetSdk < want) return false;
    } else if (sig[k] !== want) return false;
  }
  return true;
}

const below = (sdk, v) => `targetSdk ${sdk.targetSdk} is below ${v}, the level that enforces this`;

// Per-policy judgement. Each returns { status, detail } and runs only when the entry applies and targetSdk is
// resolvable (or the entry is not level-based). `enforced` is targetSdk >= policy value.
const JUDGE = {
  'page-size-16kb': ({ s }) => ({
    status: 'check',
    detail: `native code present (${at(s.ev.nativeLib ?? s.ev.nativeBuild)}); 16 KB page alignment of the .so files cannot be verified statically, check the ELF alignment and the NDK/AGP versions manually`,
  }),
  'fgs-types': ({ s, sdk, value }) => {
    const { ev, services } = s;
    if (sdk.targetSdk < value) return { status: 'ok', detail: `${below(sdk, value)}; ${at(ev.startForeground)} calls startForeground(` };
    const found = services.typed + services.untyped;
    const call = ev.startForeground === undefined ? 'no startForeground( call' : `startForeground( at ${at(ev.startForeground)}`;
    if (found === 0) {
      return { status: 'check', detail: `${call}, but no <service> was found in the scanned manifests; services can be declared by dependencies or unscanned manifests, confirm android:foregroundServiceType in the merged manifest` };
    }
    if (services.untyped === 0) return { status: 'ok', detail: `${call}; every <service> found declares android:foregroundServiceType` };
    if (ev.startForeground !== undefined && services.typed === 0) {
      return { status: 'gap', detail: `statically detected likely violation: startForeground( at ${at(ev.startForeground)} and the <service> at ${at(ev.untypedService)} declares no android:foregroundServiceType; confirm in the merged manifest` };
    }
    return { status: 'check', detail: `${call}; some <service> declarations have no android:foregroundServiceType (${at(ev.untypedService)}) and a call cannot be matched to its service statically` };
  },
  'post-notifications': ({ s, sdk, value }) => {
    const { ev } = s;
    if (sdk.targetSdk < value) return { status: 'ok', detail: below(sdk, value) };
    if (ev.postNotifications !== undefined) return { status: 'ok', detail: `POST_NOTIFICATIONS declared at ${at(ev.postNotifications)}; the runtime request flow is not verified` };
    return { status: 'check', detail: `notifications are used (${at(ev.notificationManager)}); POST_NOTIFICATIONS not found in the scanned manifests; confirm in the merged manifest (dependencies can add it)` };
  },
  'media-permissions': ({ s, sdk, value }) => {
    const { ev } = s;
    if (sdk.targetSdk < value) return { status: 'ok', detail: below(sdk, value) };
    if (ev.readMedia !== undefined) return { status: 'ok', detail: `READ_MEDIA_* declared at ${at(ev.readMedia)}` };
    if (ev.readExternalStorage !== undefined) {
      return { status: 'gap', detail: `statically detected likely violation: READ_EXTERNAL_STORAGE declared at ${at(ev.readExternalStorage)} without maxSdkVersion and no READ_MEDIA_* permission; confirm in the merged manifest` };
    }
    return { status: 'check', detail: `READ_EXTERNAL_STORAGE is scoped with maxSdkVersion at ${at(ev.readExternalScoped)} and no READ_MEDIA_* permission was found in the scanned manifests; confirm media access (READ_MEDIA_* or the photo picker) in the merged manifest` };
  },
  'exact-alarm': ({ s, sdk, value }) => {
    const { ev } = s;
    const where = at(ev.exactAlarmCall ?? ev.exactAlarmManifest);
    if (sdk.targetSdk < value) return { status: 'ok', detail: `${below(sdk, value)}; exact alarms used at ${where}` };
    if (ev.canScheduleExact !== undefined) return { status: 'ok', detail: `canScheduleExactAlarms is checked at ${at(ev.canScheduleExact)}` };
    return { status: 'check', detail: `exact alarms used at ${where}; the grant (SCHEDULE_EXACT_ALARM or USE_EXACT_ALARM eligibility) and the denied-by-default case cannot be verified statically` };
  },
  'edge-to-edge': ({ s }) => (s.ev.edgeToEdge === undefined
    ? { status: 'check', detail: 'edge-to-edge is enforced at this target level; no enableEdgeToEdge( call found, check window insets handling on every screen manually' }
    : { status: 'ok', detail: `enableEdgeToEdge( called at ${at(s.ev.edgeToEdge)}; insets handling per screen is not verified` }),
  'predictive-back': ({ s }) => (s.ev.backCallback === undefined
    ? { status: 'check', detail: 'predictive back is the default at this target level; android:enableOnBackInvokedCallback="true" not found, check custom back handling manually' }
    : { status: 'ok', detail: `android:enableOnBackInvokedCallback="true" at ${at(s.ev.backCallback)}` }),
};

/**
 * Compliance items: the applied targetSdk policy (highest targetSdkMin entry effective by the catalog asOf date),
 * then every dated policy entry whose `appliesWhen` signals hold, as { id, status: ok|gap|unknown|check, detail, source? }.
 */
export function evaluateCompliance(ctx, sdk, catalog) {
  const asOf = String(catalog.asOf ?? '');
  const entries = catalog.dimensions.find((d) => d.id === COMPLIANCE_DIM)?.entries ?? [];
  const out = [];
  const applied = entries
    .filter((e) => e.policy?.kind === TARGET_SDK_MIN && typeof e.policy.effective === 'string' && e.policy.effective <= asOf)
    .sort((a, b) => b.policy.value - a.policy.value)[0];
  if (applied) {
    const { value, effective } = applied.policy;
    if (sdk.targetSdk === null) out.push({ id: applied.id, status: 'unknown', detail: 'targetSdk not statically resolvable' });
    else {
      out.push({
        id: applied.id,
        status: sdk.targetSdk >= value ? 'ok' : 'gap',
        detail: `max targetSdk is ${sdk.targetSdk}; Google Play minimum is ${value} since ${effective}, per catalog asOf ${asOf}`,
      });
    }
  }
  const policies = entries.filter((e) => e.policy && e.policy.kind !== TARGET_SDK_MIN && isPlainObject(e.appliesWhen));
  if (policies.length === 0) return out;
  const s = scanSignals(ctx);
  const sig = signalValues(s);
  for (const e of policies) {
    const aw = e.appliesWhen;
    // A level-gated entry cannot be judged while targetSdk is unresolved; the target row already says unknown.
    if (aw[TARGET_SDK_MIN] !== undefined && sdk.targetSdk === null) continue;
    if (!appliesWhen(aw, sig, sdk)) continue;
    const { value, effective } = e.policy;
    let r;
    if (e.policy.kind !== PAGE_SIZE && sdk.targetSdk === null) r = { status: 'unknown', detail: 'targetSdk not statically resolvable' };
    else {
      const judge = JUDGE[e.id] ?? (() => ({ status: 'check', detail: 'the policy applies; this project cannot be verified statically, check it manually' }));
      r = e.policy.kind !== PAGE_SIZE && sdk.targetSdk < value && !JUDGE[e.id]
        ? { status: 'ok', detail: below(sdk, value) }
        : judge({ s, sdk, value });
    }
    if (typeof effective === 'string' && effective > asOf) {
      r = { status: r.status === 'gap' ? 'check' : r.status, detail: `upcoming (effective ${effective}, after catalog asOf ${asOf}): ${r.detail}` };
    }
    out.push({ id: e.id, status: r.status, detail: r.detail, ...(e.source ? { source: e.source } : {}) });
  }
  return out;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
