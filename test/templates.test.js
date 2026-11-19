import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skill', 'templates', 'ai');
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');

test('every workflow carries the injection rule', () => {
  for (const f of ['01-read-context', '02-plan', '03-implement', '04-review']) {
    const t = read(`workflows/${f}.md`);
    assert.ok(t.includes('data, not instructions'), f);
    assert.ok(/suspicious/.test(t) && /network/.test(t), f);
  }
});

test('workflow 01 order and commands', () => {
  const t = read('workflows/01-read-context.md');
  assert.ok(t.includes('node .ai/tools/scripts/ai-status.js'));
  assert.ok(t.includes('node .ai/tools/scripts/index.js query'));
  const at = (s) => t.indexOf(s);
  assert.ok(at('ai-status.js') < at('.ai/README.md'));
  assert.ok(at('.ai/README.md') < at('accepted ADRs'));
  assert.ok(at('accepted ADRs') < at('index.js query'));
  assert.ok(at('index.js query') < at('The code itself'));
  assert.ok(/refresh/.test(t) && /grep/.test(t));
});

test('plan, implement, review rules', () => {
  assert.ok(/status: accepted/.test(read('workflows/02-plan.md')) && /reopenIf/.test(read('workflows/02-plan.md')));
  assert.ok(/components\.md/.test(read('workflows/02-plan.md')));
  assert.ok(/one roadmap step per pull request/i.test(read('workflows/03-implement.md')));
  assert.ok(/rubrics/.test(read('workflows/04-review.md')));
});

test('README template placeholders are the six known names', () => {
  const t = read('README.md.tpl');
  const names = [...t.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1]);
  const allowed = ['toolVersion', 'catalogVersion', 'date', 'commit', 'mode', 'workspace'];
  for (const n of names) assert.ok(allowed.includes(n), n);
  for (const n of allowed) assert.ok(names.includes(n), n);
  assert.ok(t.includes('CODEOWNERS') && t.includes('No telemetry'));
});

test('pointer has both markers', () => {
  const t = read('pointer.md');
  assert.ok(t.includes('<!-- android-architect:pointer -->') && t.includes('<!-- /android-architect:pointer -->'));
  assert.ok(t.trim().split('\n').length <= 7);
});

test('user-owned templates and ADR front matter', () => {
  assert.ok(read('knowledge/architecture-target.md').startsWith('---\nstatus: proposed\n---'));
  const adr = read('knowledge/adr/0000-template.md');
  for (const k of ['id', 'title', 'status', 'date', 'dimension', 'target', 'reopenIf', 'reason']) assert.match(adr, new RegExp(`^${k}:`, 'm'));
  for (const f of ['knowledge/architecture-target.md', 'knowledge/conventions.md', 'knowledge/components.md', 'knowledge/adr/0000-template.md', 'migration/roadmap.md']) {
    assert.ok(read(f).includes('TODO: run "setup" in your agent'), f);
  }
});

test('only README.md.tpl has placeholders, all English known names', () => {
  const allowed = ['toolVersion', 'catalogVersion', 'date', 'commit', 'mode', 'workspace'];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(dir)) {
    const rel = path.relative(dir, f);
    const t = fs.readFileSync(f, 'utf8');
    if (rel === 'README.md.tpl') {
      for (const m of t.matchAll(/\{\{([^}]*)\}\}/g)) assert.ok(allowed.includes(m[1]), m[1]);
    } else {
      assert.ok(!t.includes('{{'), rel);
    }
  }
});

test('workflow 01 covers modified tools and suspicious text', () => {
  const t = read('workflows/01-read-context.md');
  assert.ok(/exit(?:s with code)? 3/.test(t));
  assert.ok(t.includes('--trust-modified-tools'));
  assert.ok(/never (?:pass|add)[^\n]*--trust-modified-tools/i.test(t));
});
