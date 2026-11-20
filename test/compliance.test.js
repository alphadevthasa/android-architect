import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog, validateEntry } from '../skill/scripts/lib/catalog.js';
import { detectStack } from '../skill/scripts/lib/detect.js';
import { renderProfileMarkdown } from '../skill/scripts/lib/report.js';

const catalog = loadCatalog();

function withProject(files, fn, cat = catalog) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-compliance-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
    return fn(detectStack(dir, cat), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const gradle = (target) => `android {\n  defaultConfig {\n    targetSdk = ${target}\n  }\n}\n`;
const base = (target = 35) => ({ 'settings.gradle.kts': 'include(":app")\n', 'app/build.gradle.kts': gradle(target) });
const item = (p, id) => p.compliance.find((c) => c.id === id);
const MANIFEST_SVC = '<manifest>\n<application>\n<service android:name=".Sync"/>\n</application>\n</manifest>\n';
const MANIFEST_SVC_TYPED = '<manifest>\n<application>\n<service android:name=".Sync" android:foregroundServiceType="dataSync"/>\n</application>\n</manifest>\n';
const SVC_KT = 'class Sync {\n  fun go() {\n    startForeground(1, n)\n  }\n}\n';

test('native libraries yield a check item for 16 KB page size, no native code none', () => {
  withProject({ ...base(), 'app/src/main/jniLibs/arm64-v8a/libfoo.so': 'x' }, (p) => {
    const c = item(p, 'page-size-16kb');
    assert.equal(c.status, 'check');
    assert.match(c.detail, /jniLibs\/arm64-v8a\/libfoo\.so/);
    assert.match(c.source, /^https:\/\/developer\.android\.com\//);
  });
  withProject({ ...base(), 'app/build.gradle.kts': gradle(35) + 'android {\n  externalNativeBuild {\n  }\n}\n' }, (p) => {
    assert.equal(item(p, 'page-size-16kb').status, 'check');
  });
  withProject({ ...base(), 'app/build.gradle': 'android {\n  defaultConfig {\n    ndk {\n      abiFilters "arm64-v8a"\n    }\n  }\n}\n' }, (p) => {
    assert.equal(item(p, 'page-size-16kb').status, 'check');
  });
  withProject(base(), (p) => assert.equal(item(p, 'page-size-16kb'), undefined));
});

test('foreground service without a declared type is a gap at targetSdk 34+, ok when declared, ok below', () => {
  const kt = { 'app/src/main/java/Sync.kt': SVC_KT };
  withProject({ ...base(34), ...kt, 'app/src/main/AndroidManifest.xml': MANIFEST_SVC }, (p) => {
    const c = item(p, 'fgs-types');
    assert.equal(c.status, 'gap');
    assert.match(c.detail, /likely violation/);
    assert.match(c.detail, /startForeground/);
    assert.match(c.detail, /Sync\.kt:3/);
  });
  withProject({ ...base(34), ...kt, 'app/src/main/AndroidManifest.xml': MANIFEST_SVC_TYPED }, (p) => assert.equal(item(p, 'fgs-types').status, 'ok'));
  withProject({ ...base(33), ...kt, 'app/src/main/AndroidManifest.xml': MANIFEST_SVC }, (p) => assert.equal(item(p, 'fgs-types').status, 'ok'));
  withProject({ ...base(34), 'app/src/main/AndroidManifest.xml': MANIFEST_SVC }, (p) => assert.equal(item(p, 'fgs-types'), undefined));
  withProject({ ...base('compute()'), ...kt, 'app/src/main/AndroidManifest.xml': MANIFEST_SVC }, (p) => assert.equal(item(p, 'fgs-types').status, 'unknown'));
});

test('some services typed and some not cannot be matched to the call: check', () => {
  const m = '<manifest>\n<application>\n<service android:name=".A" android:foregroundServiceType="dataSync"/>\n<service\n  android:name=".B"/>\n</application>\n</manifest>\n';
  withProject({ ...base(35), 'app/src/main/java/A.kt': SVC_KT, 'app/src/main/AndroidManifest.xml': m }, (p) => assert.equal(item(p, 'fgs-types').status, 'check'));
});

test('a policy effective after the catalog asOf is upcoming and never a gap', () => {
  const old = { ...catalog, asOf: '2024-01-01' };
  withProject({ ...base(34), 'app/src/main/java/Sync.kt': SVC_KT, 'app/src/main/AndroidManifest.xml': MANIFEST_SVC }, (p) => {
    const c = item(p, 'fgs-types');
    assert.notEqual(c.status, 'gap');
    assert.match(c.detail, /^upcoming \(effective 2024-08-31/);
  }, old);
  // No policy item may be a gap while upcoming, whatever the signals.
  withProject({ ...base(35) }, (p) => {
    for (const c of p.compliance) if (/^upcoming/.test(c.detail)) assert.notEqual(c.status, 'gap');
  }, old);
});

test('notification, media and exact alarm advice', () => {
  const kt = (s) => ({ 'app/src/main/java/N.kt': s });
  withProject({ ...base(34), ...kt('val m: NotificationManager = x\n'), 'app/src/main/AndroidManifest.xml': '<manifest>\n</manifest>\n' }, (p) => { assert.equal(item(p, 'post-notifications').status, 'check'); assert.match(item(p, 'post-notifications').detail, /confirm in the merged manifest/); });
  withProject({ ...base(34), ...kt('val m: NotificationManager = x\n'), 'app/src/main/AndroidManifest.xml': '<manifest>\n<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>\n</manifest>\n' }, (p) => assert.equal(item(p, 'post-notifications').status, 'ok'));
  withProject({ ...base(32), ...kt('val m: NotificationManager = x\n') }, (p) => assert.equal(item(p, 'post-notifications').status, 'ok'));
  withProject(base(34), (p) => assert.equal(item(p, 'post-notifications'), undefined));
  withProject({ ...base(34), 'app/src/main/AndroidManifest.xml': '<manifest>\n<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"/>\n</manifest>\n' }, (p) => assert.equal(item(p, 'media-permissions').status, 'gap'));
  withProject({ ...base(34), 'app/src/main/AndroidManifest.xml': '<manifest>\n<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"\n  android:maxSdkVersion="32"/>\n</manifest>\n' }, (p) => assert.equal(item(p, 'media-permissions').status, 'check'));
  withProject({ ...base(34), 'app/src/main/AndroidManifest.xml': '<manifest>\n<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"/>\n<uses-permission android:name="android.permission.READ_MEDIA_IMAGES"/>\n</manifest>\n' }, (p) => assert.equal(item(p, 'media-permissions').status, 'ok'));
  withProject({ ...base(34), ...kt('alarm.setExactAndAllowWhileIdle(a, b, c)\n') }, (p) => assert.equal(item(p, 'exact-alarm').status, 'check'));
  withProject({ ...base(34), ...kt('if (alarm.canScheduleExactAlarms()) alarm.setExact(a, b, c)\n') }, (p) => assert.equal(item(p, 'exact-alarm').status, 'ok'));
  withProject({ ...base(33), ...kt('alarm.setExact(a, b, c)\n') }, (p) => assert.equal(item(p, 'exact-alarm').status, 'ok'));
});

test('edge-to-edge and predictive back are check items from their target level, ok with evidence', () => {
  withProject(base(35), (p) => {
    assert.equal(item(p, 'edge-to-edge').status, 'check');
    assert.equal(item(p, 'predictive-back'), undefined);
  });
  withProject({ ...base(35), 'app/src/main/java/A.kt': 'class A {\n  fun f() {\n    enableEdgeToEdge()\n  }\n}\n' }, (p) => assert.equal(item(p, 'edge-to-edge').status, 'ok'));
  withProject({ ...base(36), 'app/src/main/AndroidManifest.xml': '<manifest>\n<application android:enableOnBackInvokedCallback="true">\n</application>\n</manifest>\n' }, (p) => assert.equal(item(p, 'predictive-back').status, 'ok'));
  withProject(base(34), (p) => assert.equal(item(p, 'edge-to-edge'), undefined));
});

test('policy rows render in the profile Markdown with source and hostile paths neutralised', () => {
  withProject({ ...base(34), 'app/src/main/jniLibs/arm64-v8a/lib\n# Forged.so': 'x' }, (p) => {
    const md = renderProfileMarkdown(p);
    assert.match(md, /16 KB memory page size support: check/);
    assert.ok(!/\n# Forged/.test(md));
  });
});

test('validateEntry strictly checks appliesWhen and source', () => {
  const ctx = { hasDimension: () => true, hasEntry: () => true };
  const e = (extra) => ({ id: 'x', name: 'x', era: 5, status: 'current', successors: [], detect: { computed: true }, ...extra });
  const errs = (extra) => validateEntry('compliance', e(extra), ctx);
  assert.deepEqual(errs({ appliesWhen: { targetSdkMin: 34, hasNative: true }, source: 'https://developer.android.com/x', policy: { kind: 'pageSizeBytes', value: 16384, effective: '2025-11-01' } }), []);
  assert.ok(errs({ appliesWhen: { bogus: true } }).some((m) => m.includes('appliesWhen.bogus')));
  assert.ok(errs({ appliesWhen: { hasNative: 'yes' } }).some((m) => m.includes('appliesWhen.hasNative')));
  assert.ok(errs({ appliesWhen: { targetSdkMin: '34' } }).some((m) => m.includes('appliesWhen.targetSdkMin')));
  assert.ok(errs({ appliesWhen: [] }).some((m) => m.includes('appliesWhen')));
  assert.ok(errs({ source: 'http://developer.android.com/x' }).some((m) => m.includes('source')));
  assert.ok(errs({ source: 'https://evil.example/x' }).some((m) => m.includes('source')));
  assert.ok(errs({ source: 'https://developer.android.com.evil.example/x' }).some((m) => m.includes('source')));
  assert.ok(errs({ source: 'https://u:p@developer.android.com/x' }).some((m) => m.includes('source')));
  assert.ok(errs({ policy: { kind: 'mystery', value: 1 } }).some((m) => m.includes('policy.kind')));
  assert.ok(errs({ policy: { kind: 'targetSdkEnforced', value: 'x' } }).some((m) => m.includes('policy.value')));
});

test('shipped compliance entries carry sources on allowed hosts and apply signals', () => {
  const dim = catalog.dimensions.find((d) => d.id === 'compliance');
  const ids = dim.entries.map((e) => e.id);
  for (const id of ['page-size-16kb', 'edge-to-edge', 'predictive-back', 'fgs-types', 'post-notifications', 'media-permissions', 'exact-alarm']) {
    assert.ok(ids.includes(id), id);
    const entry = dim.entries.find((e) => e.id === id);
    assert.ok(entry.appliesWhen && entry.source, id);
  }
});

test('foreground service evidence: no service found is check, string literals and comments are not signals', () => {
  withProject({ ...base(35), 'app/src/main/java/Sync.kt': SVC_KT }, (p) => {
    const c = item(p, 'fgs-types');
    assert.equal(c.status, 'check');
    assert.match(c.detail, /merged manifest/);
  });
  const quiet = { ...base(35), 'app/src/main/AndroidManifest.xml': MANIFEST_SVC };
  withProject({ ...quiet, 'app/src/main/java/A.kt': 'val s = "startForeground(1, n)"\n' }, (p) => assert.equal(item(p, 'fgs-types'), undefined));
  const raw = '// startForeground(1, n)\n/* a\n startForeground(2, n)\n*/\nval t = """\nstartForeground(3)\n"""\n';
  withProject({ ...quiet, 'app/src/main/java/A.kt': raw }, (p) => assert.equal(item(p, 'fgs-types'), undefined));
  const man = '<manifest>\n<!--\n<service android:foregroundServiceType="x"/>\n-->\n<service android:name=".S"/>\n</manifest>\n';
  withProject({ ...base(35), 'app/src/main/java/A.kt': 'fun f() {\n  startForeground(1, n) // go\n}\n', 'app/src/main/AndroidManifest.xml': man }, (p) => assert.equal(item(p, 'fgs-types').status, 'gap'));
});

test('commented-out or quoted native build signals are ignored', () => {
  withProject({ ...base(35), 'app/build.gradle.kts': gradle(35) + '// externalNativeBuild {\n/* ndk {\n} */\nval x = "ndk { }"\n' }, (p) => assert.equal(item(p, 'page-size-16kb'), undefined));
});

test('hostile inputs stay linear', () => {
  const big = 'a'.repeat(1024 * 1000 - 10);
  const t0 = Date.now();
  withProject({
    ...base(35),
    'app/src/main/java/A.kt': `/* ${big}`,
    'app/src/main/java/B.kt': `val s = "${big}`,
    'app/src/main/java/C.kt': `${big} startForeground(`,
    'app/src/main/AndroidManifest.xml': `<manifest>\n<!-- ${big}`,
    'app/build.gradle': `x = '${big}`,
  }, (p) => assert.ok(p.compliance.length > 0));
  assert.ok(Date.now() - t0 < 5000);
});

test('modern-compose emits the edge-to-edge check row', () => {
  const fx = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'modern-compose');
  assert.equal(item(detectStack(fx, catalog), 'edge-to-edge').status, 'check');
});

test('dimension asOf, verified and dataNote are validated; minVersion is numeric', async () => {
  const { validateCatalog } = await import('../skill/scripts/lib/catalog.js');
  const meta = { schemaVersion: 1, catalogVersion: 'x', asOf: '2026-01-01' };
  const e = { id: 'a', name: 'a', era: 1, status: 'current', successors: [], detect: { computed: true } };
  const run = (extra, entry = e) => validateCatalog({ meta, dimensions: [{ id: 'compliance', name: 'c', entries: [entry], ...extra }] });
  assert.deepEqual(run({ asOf: '2026-11-20', verified: false, dataNote: 'x' }), []);
  assert.ok(run({ asOf: 'soon' }).some((m) => m.includes('asOf')));
  assert.ok(run({ verified: 'no' }).some((m) => m.includes('verified')));
  assert.ok(run({ dataNote: '' }).some((m) => m.includes('dataNote')));
  assert.ok(run({}, { ...e, minVersion: 'two' }).some((m) => m.includes('minVersion')));
  assert.equal(catalog.dimensions.find((d) => d.id === 'compliance').verified, false);
});
