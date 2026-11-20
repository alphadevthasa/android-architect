import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectReuse, renderComponents } from '../skill/scripts/lib/reuse.js';
import { renderComponentsBlock, applyComponentsBlock, COMPONENTS_BEGIN, COMPONENTS_END } from '../skill/scripts/lib/knowledge.js';
import { writeAiDir } from '../skill/scripts/lib/aidir.js';
import { refreshAiDir } from '../skill/scripts/lib/refresh.js';
import { scanInstructions } from '../skill/scripts/lib/injection.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = (n) => path.join(root, 'test/fixtures', n);
const cli = path.join(root, 'skill/scripts/reuse.js');
const NOW = new Date('2026-11-20T00:00:00Z');
const tmps = [];
const tmp = (p = 'aa-reuse-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  tmps.push(d);
  return d;
};
after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const copyFixture = (name) => {
  const d = path.join(tmp(), 'proj');
  fs.cpSync(fx(name), d, { recursive: true });
  return d;
};
const layout = (id1, text, extra = '') => `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/${id1}"
    android:layout_width="match_parent">
    <TextView android:id="@+id/t_${id1}" android:text="${text}" />
    <Button android:id="@+id/b_${id1}" android:text="${text}" />
    <ImageView android:layout_width="wrap_content" />${extra}
</LinearLayout>
`;
const files = (g) => g.files.map((f) => f.file);

test('reuse-app: every kind of finding with file:line evidence', () => {
  const r = detectReuse(fx('reuse-app'));
  const kinds = (k) => r.duplicates.filter((d) => d.kind === k);
  assert.equal(r.duplicates.length, 3);
  assert.deepEqual(files(kinds('layout')[0]), ['app/src/main/res/layout/item_account.xml', 'app/src/main/res/layout/item_user.xml']);
  assert.deepEqual(kinds('layout')[0].files.map((f) => f.line), [1, 1]);
  const comp = kinds('composable');
  assert.equal(comp.length, 1);
  assert.deepEqual(comp[0].files.map((f) => `${path.posix.basename(f.file)}:${f.line}`), ['AccountCard.kt:13', 'UserCard.kt:13']);
  const util = kinds('util');
  assert.equal(util.length, 1);
  assert.match(util[0].signature, /^formatMoney/);
  assert.deepEqual(util[0].files.map((f) => `${path.posix.basename(f.file)}:${f.line}`), ['CurrencyUtil.kt:4', 'MoneyFormat.kt:4']);
  assert.equal(r.baseClasses.length, 1);
  assert.equal(r.baseClasses[0].role, 'activity');
  assert.deepEqual(r.baseClasses[0].classes.map((c) => c.name), ['BaseActivity', 'BaseScreenActivity']);
  assert.deepEqual(r.tokens, { colorsXml: 0, dimensXml: 0, hardcodedColors: 3, hardcodedDp: 4 });
  assert.deepEqual(r.sharedModules, [':core:designsystem']);
  assert.equal(r.duplicationScore, 'medium');
  assert.deepEqual(r.boilerplate, []);
  assert.equal(r.tooLarge, 0);
});

test('modern-compose: low score, empty groups', () => {
  const r = detectReuse(fx('modern-compose'));
  assert.equal(r.duplicationScore, 'low');
  assert.deepEqual([r.duplicates, r.baseClasses, r.boilerplate, r.sharedModules], [[], [], [], []]);
});

test('layouts: differing only in text and ids are duplicates; structure differences and tiny layouts are not', () => {
  const d = tmp();
  write(d, 'settings.gradle', "include ':app'\n");
  const res = 'app/src/main/res';
  write(d, `${res}/layout/a.xml`, layout('one', 'Hello'));
  write(d, `${res}/layout/b.xml`, layout('two', 'Bye'));
  write(d, `${res}/layout/c.xml`, layout('three', 'Hello', '\n    <View />'));
  write(d, `${res}/layout/tiny1.xml`, '<LinearLayout>\n<TextView />\n<TextView />\n</LinearLayout>\n');
  write(d, `${res}/layout/tiny2.xml`, '<LinearLayout>\n<TextView />\n<TextView />\n</LinearLayout>\n');
  // A qualifier variant of one layout is not a copy.
  write(d, `${res}/layout-land/c.xml`, layout('land', 'Hello', '\n    <View />'));
  const r = detectReuse(d);
  assert.equal(r.duplicates.length, 1);
  assert.deepEqual(files(r.duplicates[0]), [`${res}/layout/a.xml`, `${res}/layout/b.xml`]);
});

test('util, composable and boilerplate thresholds', () => {
  const d = tmp();
  write(d, 'settings.gradle', "include ':app'\n");
  const k = 'app/src/main/kotlin/p';
  const util3 = 'fun short(a: Int): Int {\n    val b = a + 1\n    return b\n}\n';
  write(d, `${k}/A.kt`, `package p\n${util3}`);
  write(d, `${k}/B.kt`, `package p\n${util3}`);
  const sameFile = 'fun twice(a: Int): Int {\n    val b = a + 1\n    val c = b + 1\n    return c\n}\nfun twice2(a: Int): Int {\n    val b = a + 1\n    val c = b + 1\n    return c\n}\n';
  write(d, `${k}/C.kt`, `package p\n${sameFile}`);
  write(d, `${k}/Two.kt`, 'package p\n@Composable fun One() {\n    Text()\n    Text()\n}\n@Composable fun Two() {\n    Text()\n    Text()\n}\n');
  const tc = 'try {\n    load()\n} catch (e: Exception) {\n    Result.failure(e)\n}\n';
  write(d, `${k}/E1.kt`, `package p\nfun a() {\n    println("a")\n${tc}}\n`);
  write(d, `${k}/E2.kt`, `package p\nfun b() {\n    println("b")\n${tc}}\n`);
  const r = detectReuse(d);
  assert.deepEqual(r.duplicates, [], 'under 4 lines, same file only, and under 3 calls are not duplicates');
  assert.deepEqual(r.boilerplate, [], 'two occurrences are below the minimum');
  write(d, `${k}/E3.kt`, `package p\nfun c() {\n    println("c")\n${tc}}\n`);
  const r3 = detectReuse(d);
  assert.equal(r3.boilerplate.length, 1);
  assert.equal(r3.boilerplate[0].kind, 'error-handling');
  assert.equal(r3.boilerplate[0].files.length, 3);
  write(d, `${k}/H1.kt`, 'package p\nval a = OkHttpClient.Builder()\n    .readTimeout(5, SECONDS)\n    .build()\n');
  write(d, `${k}/H2.kt`, 'package p\nval b = OkHttpClient.Builder()\n    .readTimeout(5, SECONDS)\n    .build()\n');
  write(d, `${k}/H3.kt`, 'package p\nval c = OkHttpClient.Builder()  \n    .readTimeout(5,   SECONDS)\n    .build()\n');
  assert.deepEqual(detectReuse(d).boilerplate.map((b) => b.kind), ['error-handling', 'okhttp-builder']);
});

test('base classes: score high with 3 members; Java supported; test sources ignored', () => {
  const d = tmp();
  write(d, 'settings.gradle', "include ':app'\n");
  const k = 'app/src/main/java/p';
  write(d, `${k}/BaseFragment.java`, 'package p;\npublic abstract class BaseFragment extends Fragment {}\n');
  write(d, `${k}/BaseListFragment.java`, 'package p;\npublic abstract class BaseListFragment extends Fragment {}\n');
  write(d, `${k}/BaseDialog.java`, 'package p;\nclass BaseDialog extends DialogFragment {}\n');
  write(d, 'app/src/test/java/p/BaseTestFragment.java', 'package p;\nclass BaseTestFragment extends Fragment {}\n');
  const r = detectReuse(d);
  assert.equal(r.baseClasses[0].role, 'fragment');
  assert.equal(r.baseClasses[0].classes.length, 3);
  assert.equal(r.duplicationScore, 'high');
});

test('renderComponents replaces only the block; appends when missing; idempotent', () => {
  const reuse = detectReuse(fx('reuse-app'));
  const before = '# Mine\n\nCurated: PrimaryButton in :core:designsystem\n\n';
  const after = '\n## Notes\n\nkeep me\n';
  const stale = `${before}${COMPONENTS_BEGIN}\nold stale content\n${COMPONENTS_END}${after}`;
  const out = renderComponents(reuse, stale);
  assert.ok(out.startsWith(before + COMPONENTS_BEGIN));
  assert.ok(out.endsWith(COMPONENTS_END + after));
  assert.ok(!out.includes('old stale content'));
  assert.ok(out.includes('app/src/main/res/layout/item_user.xml:1'));
  assert.equal(renderComponents(reuse, out), out, 'second run is a no-op');

  const plain = '# Components\n\nOld hand-written list\n';
  const appended = renderComponents(reuse, plain);
  assert.ok(appended.startsWith(plain));
  assert.equal(appended.split(COMPONENTS_BEGIN).length, 2);
  assert.equal(renderComponents(reuse, appended), appended);
  const noNewline = renderComponents(reuse, '# x');
  assert.ok(noNewline.startsWith('# x\n\n' + COMPONENTS_BEGIN));
  assert.equal(renderComponents(reuse, ''), renderComponentsBlock(reuse) + '\n');
});

test('malformed markers never delete user text, never grow on re-runs, and report a note', () => {
  const block = renderComponentsBlock(detectReuse(fx('reuse-app')));
  const cases = {
    'begin without end': `# Mine\n${COMPONENTS_BEGIN}\nuser text after a lone begin\n`,
    'end without begin': `# Mine\nuser text\n${COMPONENTS_END}\nmore\n`,
    duplicated: `${COMPONENTS_BEGIN}\na\n${COMPONENTS_END}\nuser middle\n${COMPONENTS_BEGIN}\nb\n${COMPONENTS_END}\ntail text\n`,
    'end before begin': `${COMPONENTS_END}\nuser\n${COMPONENTS_BEGIN}\n`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const first = applyComponentsBlock(text, block);
    assert.ok(first.note, `${name}: note`);
    assert.ok(first.text.startsWith(text), `${name}: user text kept byte for byte`);
    assert.ok(first.text.includes(block), `${name}: fresh block present`);
    const second = applyComponentsBlock(first.text, block);
    assert.equal(second.text, first.text, `${name}: re-run is stable`);
    // A changed block replaces the appended one instead of piling up.
    const changed = applyComponentsBlock(first.text, block.replace('Duplication:', 'Duplication (new):'));
    assert.equal(changed.text.split('Duplication').length, first.text.split('Duplication').length, `${name}: no growth`);
    assert.ok(changed.text.startsWith(text), `${name}: user text kept after a change`);
  }
  assert.equal(applyComponentsBlock('# ok\n', block).note, null);
});

test('hostile names cannot forge headings or markers in the block', () => {
  const d = tmp();
  write(d, 'settings.gradle', "include ':app'\n");
  const res = 'app/src/main/res/layout';
  const evil = `# forged\n<!-- android-architect:components:end -->| x |`;
  write(d, `${res}/${evil}.xml`, layout('one', 'x'));
  write(d, `${res}/b.xml`, layout('two', 'y'));
  const r = detectReuse(d);
  assert.equal(r.duplicates.length, 1);
  const out = renderComponents(r, '# mine\n');
  assert.equal(out.split('\n').filter((l) => l.trim() === COMPONENTS_END).length, 1);
  assert.equal(out.split('\n').filter((l) => l.trim() === COMPONENTS_BEGIN).length, 1);
  assert.ok(!/^#+ forged/m.test(out));
  assert.ok(out.includes('\\| x \\|') || out.includes('&lt;!-- android-architect'));
});

test('groups and files are capped with "and N more"', () => {
  const dups = Array.from({ length: 25 }, (_, i) => ({
    kind: 'util',
    signature: `u${i} (4 lines)`,
    files: Array.from({ length: i === 0 ? 14 : 2 }, (_, j) => ({ file: `f${i}_${j}.kt`, line: 1 })),
  }));
  const reuse = { duplicates: dups, baseClasses: [], boilerplate: [], tokens: { colorsXml: 0, dimensXml: 0, hardcodedColors: 0, hardcodedDp: 0 }, sharedModules: [], duplicationScore: 'high', tooLarge: 2 };
  const block = renderComponentsBlock(reuse);
  assert.match(block, /\.\.\. and 5 more groups/);
  assert.match(block, /\.\.\. and 4 more files/);
  assert.match(block, /2 files too large to scan/);
  assert.equal(block.split('\n').filter((l) => l.startsWith('- util')).length, 20);
});

test('oversized files are reported, not read, and a 1 MB single line does not stall', () => {
  const d = tmp();
  write(d, 'settings.gradle', "include ':app'\n");
  const k = 'app/src/main/kotlin/p';
  write(d, `${k}/Huge.kt`, 'a'.repeat(1024 * 1024 + 1));
  assert.equal(detectReuse(d).tooLarge, 1);
  const hostile = ['fun a(', '{{{{(((', 'try {', 'class Base', 'OkHttpClient.Builder()', 'fun ', '#a', '.dp', 'Color(0x', '<a '];
  for (const unit of hostile) {
    const dir = tmp();
    write(dir, 'settings.gradle', "include ':app'\n");
    write(dir, `${k}/Line.kt`, unit.repeat(Math.floor((1024 * 1024) / unit.length)));
    write(dir, `${k}/Line.java`, unit.repeat(Math.floor((1024 * 1024) / unit.length)));
    write(dir, 'app/src/main/res/layout/x.xml', unit.repeat(Math.floor((1024 * 1024) / unit.length)));
    const t = Date.now();
    const r = detectReuse(dir);
    assert.ok(Date.now() - t < 1000, `${JSON.stringify(unit)} took ${Date.now() - t} ms`);
    assert.equal(r.tooLarge, 0);
  }
});

test('writeAiDir: created from the template, user edit survives, block refreshes, redaction applies', () => {
  const proj = copyFixture('reuse-app');
  const run = () => writeAiDir(proj, { now: NOW, toolVersion: '9.9.9' });
  const file = path.join(proj, '.ai/knowledge/components.md');
  const first = run();
  assert.ok(first.written.includes('.ai/knowledge/components.md'));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('TODO: run "setup" in your agent'));
  assert.ok(text.includes('## Curated components'));
  assert.ok(text.includes('item_user.xml:1'));
  assert.deepEqual(first.notes, []);

  const edited = '# Mine\n\nPrimaryButton lives in :core:designsystem\n\n' + text.slice(text.indexOf('## Curated'));
  fs.writeFileSync(file, edited);
  const second = run();
  assert.ok(second.kept.includes('.ai/knowledge/components.md'), 'unchanged block: kept');
  assert.ok(!second.written.includes('.ai/knowledge/components.md'));
  assert.equal(fs.readFileSync(file, 'utf8'), edited);

  // A new duplicate changes the block, and only the block.
  write(proj, 'app/src/main/res/layout/item_extra.xml', fs.readFileSync(path.join(proj, 'app/src/main/res/layout/item_user.xml'), 'utf8'));
  const third = run();
  assert.ok(third.written.includes('.ai/knowledge/components.md'));
  const now = fs.readFileSync(file, 'utf8');
  const cut = (t) => [t.slice(0, t.indexOf(COMPONENTS_BEGIN)), t.slice(t.indexOf(COMPONENTS_END))];
  assert.deepEqual(cut(now), cut(edited));
  assert.ok(now.includes('item_extra.xml:1'));

  // Redaction: a secret-looking name never reaches the file.
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  write(proj, `app/src/main/res/layout/item_${secret}.xml`, fs.readFileSync(path.join(proj, 'app/src/main/res/layout/item_user.xml'), 'utf8'));
  run();
  const redacted = fs.readFileSync(file, 'utf8');
  assert.ok(!redacted.includes(secret));
  assert.ok(redacted.includes('[REDACTED:aws-access-key]'));
});

test('upgrade from a 0.3.0 folder: markerless components.md keeps every byte, block appended', () => {
  const proj = copyFixture('reuse-app');
  writeAiDir(proj, { now: NOW, toolVersion: '0.3.0' });
  const file = path.join(proj, '.ai/knowledge/components.md');
  const old = '# Components and utilities\n\n- PrimaryButton (:core:designsystem): main CTA\n- formatMoney: use this one, do not copy it\r\n\nlast line without newline';
  fs.writeFileSync(file, old);
  const r = writeAiDir(proj, { now: NOW, toolVersion: '0.4.0' });
  assert.ok(r.written.includes('.ai/knowledge/components.md'));
  const now = fs.readFileSync(file, 'utf8');
  assert.ok(now.startsWith(old), 'old bytes untouched');
  assert.equal(now.split(COMPONENTS_BEGIN).length, 2);
  const again = writeAiDir(proj, { now: NOW, toolVersion: '0.4.0' });
  assert.ok(again.kept.includes('.ai/knowledge/components.md'));
  assert.equal(fs.readFileSync(file, 'utf8'), now);
});

test('writeAiDir reports malformed markers as a note and keeps the file', () => {
  const proj = copyFixture('reuse-app');
  writeAiDir(proj, { now: NOW, toolVersion: '9.9.9' });
  const file = path.join(proj, '.ai/knowledge/components.md');
  const broken = `# Mine\n${COMPONENTS_BEGIN}\nhalf a block\n`;
  fs.writeFileSync(file, broken);
  const r = writeAiDir(proj, { now: NOW, toolVersion: '9.9.9' });
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /malformed/);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(broken));
});

test('refresh updates only the block and surfaces the malformed note', () => {
  const proj = copyFixture('reuse-app');
  writeAiDir(proj, { now: NOW, toolVersion: '9.9.9' });
  const file = path.join(proj, '.ai/knowledge/components.md');
  const text = fs.readFileSync(file, 'utf8');
  const edited = 'MY NOTES\n' + text;
  fs.writeFileSync(file, edited);
  write(proj, 'app/src/main/res/layout/item_extra.xml', fs.readFileSync(path.join(proj, 'app/src/main/res/layout/item_user.xml'), 'utf8'));
  const report = refreshAiDir(proj, { now: new Date('2026-11-21T00:00:00Z'), toolVersion: '9.9.9' });
  assert.ok(report.files.written.includes('.ai/knowledge/components.md'));
  const now = fs.readFileSync(file, 'utf8');
  assert.ok(now.startsWith('MY NOTES\n# Components'));
  assert.ok(now.includes('item_extra.xml:1'));
  fs.writeFileSync(file, `${COMPONENTS_END}\nx\n`);
  const bad = refreshAiDir(proj, { now: new Date('2026-11-22T00:00:00Z'), toolVersion: '9.9.9' });
  assert.ok(bad.notes.some((n) => /malformed/.test(n)));
  assert.match(fs.readFileSync(path.join(proj, '.ai/refresh-report.md'), 'utf8'), /malformed/);
});

test('members get no components.md', () => {
  const proj = copyFixture('reuse-app');
  const r = writeAiDir(proj, { now: NOW, toolVersion: '9.9.9', workspace: { role: 'member', hub: '..' } });
  assert.ok(!r.written.includes('.ai/knowledge/components.md'));
  assert.ok(!fs.existsSync(path.join(proj, '.ai/knowledge/components.md')));
});

test('CLI: json, md, usage and non-project exit codes', () => {
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const j = run(fx('reuse-app'));
  assert.equal(j.status, 0, j.stderr);
  assert.equal(JSON.parse(j.stdout).duplicationScore, 'medium');
  const md = run(fx('reuse-app'), '--format', 'md');
  assert.equal(md.status, 0);
  assert.ok(md.stdout.startsWith(COMPONENTS_BEGIN));
  assert.equal(run().status, 1);
  assert.equal(run(fx('reuse-app'), '--format', 'xml').status, 1);
  assert.equal(run(fx('reuse-app'), '--nope').status, 1);
  const empty = tmp();
  assert.equal(run(empty).status, 2);
  assert.equal(run(path.join(empty, 'missing')).status, 2);
});

test('references/reuse.md is English documentation, scans clean and covers the spec rules', () => {
  const text = fs.readFileSync(path.join(root, 'skill/references/reuse.md'), 'utf8');
  assert.deepEqual(scanInstructions(text), []);
  for (const needle of ['Rule of three', 'No catch-all `common` module', 'Design system first', 'XML interop', '@Preview', 'screenshot test', 'Size the shared-module set']) {
    assert.ok(text.includes(needle), needle);
  }
});

test('markers: only whole column-0 lines outside code fences count', () => {
  const block = renderComponentsBlock(detectReuse(fx('reuse-app')));
  const B = COMPONENTS_BEGIN;
  const E = COMPONENTS_END;
  const apply = (t) => applyComponentsBlock(t, block);

  // Fenced-only pair: user text inside the fence is kept, a fresh block is appended, no note.
  const fenced = `# Doc\n\n\`\`\`md\n${B}\nmy own text\n${E}\n\`\`\`\n`;
  let r = apply(fenced);
  assert.equal(r.note, null);
  assert.ok(r.text.startsWith(fenced) && r.text.includes('my own text'));
  assert.equal(apply(r.text).text, r.text, 'idempotent, no growth');
  assert.equal(apply(r.text).note, null, 'no repeated note');

  // Tilde fences and longer fences.
  const tilde = `~~~\n${B}\nkeep\n${E}\n~~~\n`;
  assert.ok(apply(tilde).text.startsWith(tilde));
  const longer = `\`\`\`\`\n\`\`\`\n${B}\nkeep\n${E}\n\`\`\`\`\n`;
  assert.ok(apply(longer).text.startsWith(longer));

  // Indented-only pair is not a marker.
  const indented = `Example:\n\n    ${B}\n    keep this\n    ${E}\n`;
  r = apply(indented);
  assert.ok(r.text.startsWith(indented) && r.note === null);

  // Fenced pair plus a real pair: only the real pair is replaced.
  const both = `\`\`\`\n${B}\nexample\n${E}\n\`\`\`\n\n${B}\nstale\n${E}\ntail\n`;
  r = apply(both);
  assert.equal(r.note, null);
  assert.ok(r.text.startsWith(`\`\`\`\n${B}\nexample\n${E}\n\`\`\`\n\n`));
  assert.ok(!r.text.includes('stale') && r.text.endsWith('\ntail\n'));

  // Markers quoted in prose (not a whole line) are ignored.
  const prose = `Use ${B} and ${E} to mark the block.\n`;
  r = apply(prose);
  assert.ok(r.text.startsWith(prose) && r.note === null);
  assert.equal(apply(r.text).text, r.text);

  // An unclosed fence is closed before the appended block, so a re-run finds the block.
  const open = '```\nunfinished example\n';
  r = apply(open);
  assert.ok(r.text.startsWith(open));
  assert.equal(apply(r.text).text, r.text);
  assert.equal(r.text.split(B).length, 2);
});

test('CRLF files get a CRLF block, a BOM is kept, invalid UTF-8 is left alone', () => {
  const reuse = detectReuse(fx('reuse-app'));
  const crlf = `﻿# Mine\r\n\r\nline\r\n`;
  const out = renderComponents(reuse, crlf);
  assert.ok(out.startsWith(crlf));
  assert.ok(!/(^|[^\r])\n/.test(out), 'every line ending is CRLF');
  assert.equal(renderComponents(reuse, out), out);
  const replaced = renderComponents(reuse, out.replace('Duplication: medium', 'Duplication: stale'));
  assert.equal(replaced, out);

  const proj = copyFixture('reuse-app');
  writeAiDir(proj, { now: NOW, toolVersion: '9.9.9' });
  const file = path.join(proj, '.ai/knowledge/components.md');
  const bytes = Buffer.concat([Buffer.from('# Mine\n'), Buffer.from([0xff, 0xfe, 0x41]), Buffer.from('\n')]);
  fs.writeFileSync(file, bytes);
  const r = writeAiDir(proj, { now: NOW, toolVersion: '9.9.9' });
  assert.ok(fs.readFileSync(file).equals(bytes), 'bytes untouched');
  assert.ok(r.kept.includes('.ai/knowledge/components.md'));
  assert.match(r.notes.join('\n'), /not valid UTF-8/);
});

test('layout signatures include nesting; include/merge do not count; short colors are counted', () => {
  const d = tmp();
  write(d, 'settings.gradle', "include ':app'\n");
  const res = 'app/src/main/res/layout';
  write(d, `${res}/flat.xml`, '<FrameLayout><LinearLayout/><TextView/><Button/></FrameLayout>');
  write(d, `${res}/nested.xml`, '<FrameLayout><LinearLayout><TextView android:text="b"><Button/></TextView></LinearLayout></FrameLayout>');
  assert.deepEqual(detectReuse(d).duplicates, []);
  write(d, `${res}/nested2.xml`, '<FrameLayout android:id="@+id/x"><LinearLayout><TextView android:text="a"><Button/></TextView></LinearLayout></FrameLayout>');
  assert.deepEqual(files(detectReuse(d).duplicates[0]), [`${res}/nested.xml`, `${res}/nested2.xml`]);
  const e = tmp();
  write(e, 'settings.gradle', "include ':app'\n");
  const three = '<FrameLayout><include layout="@layout/a"/><merge/><TextView android:textColor="#fff"/><Button android:background="#8f00"/></FrameLayout>';
  write(e, `${res}/i1.xml`, three);
  write(e, `${res}/i2.xml`, three);
  const r = detectReuse(e);
  assert.deepEqual(r.duplicates, [], 'only 3 real elements');
  assert.equal(r.tokens.hardcodedColors, 4);
  write(e, 'app/src/main/kotlin/C.kt', 'import androidx.compose.ui.graphics.Color\nval a = "#abc"\nval b = Color(0xFF000000)\n');
  assert.equal(detectReuse(e).tokens.hardcodedColors, 6);
});

test('a @Composable in a class declaration does not mark the next plain function', () => {
  const d = tmp();
  write(d, 'settings.gradle', "include ':app'\n");
  const util = 'fun fmt(a: Int): Int {\n    val b = a + 1\n    val c = b + 1\n    val d = c + 1\n    return d\n}\n';
  const head = 'package p\nclass H(val content: @Composable () -> Unit)\n\n';
  write(d, 'app/src/main/kotlin/p/A.kt', head + util);
  write(d, 'app/src/main/kotlin/p/B.kt', head + util);
  const r = detectReuse(d);
  assert.deepEqual(r.duplicates.map((x) => x.kind), ['util']);
});

test('secret-looking names in emitted text are redacted in components.md', () => {
  const proj = copyFixture('reuse-app');
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  const k = 'app/src/main/kotlin/com/example/reuse';
  const util = () => `package p\nfun ${secret}(a: Int): Int {\n    val b = a + 1\n    val c = b + 1\n    val d = c + 1\n    return d\n}\n`;
  write(proj, `${k}/S1.kt`, util());
  write(proj, `${k}/S2.kt`, util());
  const comp = (n) => `package p\n@Composable\nfun ${n}(x: ${secret}) {\n    Card {\n        Text()\n        Icon()\n    }\n}\n`;
  write(proj, `${k}/P1.kt`, comp('PA'));
  write(proj, `${k}/P2.kt`, comp('PB'));
  const reuse = detectReuse(proj);
  assert.ok(reuse.duplicates.some((x) => x.kind === 'util' && x.signature.includes(secret)), 'util name is emitted');
  assert.ok(reuse.duplicates.some((x) => x.kind === 'composable' && x.signature.includes(secret)), 'param type is emitted');
  writeAiDir(proj, { now: NOW, toolVersion: '9.9.9' });
  const text = fs.readFileSync(path.join(proj, '.ai/knowledge/components.md'), 'utf8');
  assert.ok(!text.includes(secret));
  assert.ok(text.includes('[REDACTED:aws-access-key]'));
});

test('detectReuse accepts a profile option', () => {
  assert.equal(detectReuse(fx('reuse-app'), { profile: {} }).duplicationScore, 'medium');
});

test('annotation arguments with ::class do not break composable or preview detection', () => {
  const d = tmp();
  write(d, 'settings.gradle', "include ':app'\n");
  const body = '    Card {\n        Text()\n        Icon()\n    }\n}\n';
  const k = 'app/src/main/kotlin/p';
  write(d, `${k}/A.kt`, `package p\n@Composable\n@OptIn(ExperimentalMaterial3Api::class)\nfun ScreenA() {\n${body}`);
  write(d, `${k}/B.kt`, `package p\n@OptIn(ExperimentalMaterial3Api::class) @Composable\nfun ScreenB() {\n${body}`);
  let r = detectReuse(d);
  assert.deepEqual(r.duplicates.map((x) => x.kind), ['composable'], 'both are composables, not utils');
  assert.equal(r.duplicates[0].files.length, 2);
  // Previews stay excluded even with an @OptIn(...::class) line between.
  write(d, `${k}/P1.kt`, `package p\n@Preview\n@OptIn(X::class)\n@Composable\nfun P1() {\n${body}`);
  write(d, `${k}/P2.kt`, `package p\n@Composable\n@Preview\n@OptIn(X::class)\nfun P2() {\n${body}`);
  r = detectReuse(d);
  assert.equal(r.duplicates[0].files.length, 2, 'previews not counted');
  assert.deepEqual(r.duplicates.map((x) => x.kind), ['composable']);
});

test('markers: BOM on line 1 is recognised and kept; inline triple backticks are not a fence', () => {
  const block = renderComponentsBlock(detectReuse(fx('reuse-app')));
  const bom = `﻿${COMPONENTS_BEGIN}\nold\n${COMPONENTS_END}\n`;
  const r = applyComponentsBlock(bom, block);
  assert.equal(r.note, null);
  assert.ok(r.text.startsWith('﻿' + COMPONENTS_BEGIN) && !r.text.includes('old'));
  assert.equal(applyComponentsBlock(r.text, block).text, r.text);
  const inline = '```val x``` is inline\n\n' + `${COMPONENTS_BEGIN}\nstale\n${COMPONENTS_END}\n`;
  const r2 = applyComponentsBlock(inline, block);
  assert.equal(r2.note, null);
  assert.ok(r2.text.startsWith('```val x``` is inline\n\n') && !r2.text.includes('stale'));
});
