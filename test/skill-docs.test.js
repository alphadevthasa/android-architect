import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.join(here, '..', 'skill');
const skillMdPath = path.join(skillDir, 'SKILL.md');
const readSkill = () => fs.readFileSync(skillMdPath, 'utf8');

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'SKILL.md must start with a --- frontmatter block');
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    assert.ok(kv, `unparseable frontmatter line: ${line}`);
    let value = kv[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    fields[kv[1]] = value;
  }
  return { fields, body: text.slice(m[0].length) };
}

function walkFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(p));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

test('frontmatter has only name and description, within limits', () => {
  const { fields } = parseFrontmatter(readSkill());
  assert.deepEqual(Object.keys(fields).sort(), ['description', 'name']);
  assert.equal(fields.name, 'android-architect');
  assert.ok(fields.description.length > 0);
  assert.ok(fields.description.length <= 1024, `description is ${fields.description.length} chars`);
  // A plain YAML scalar breaks on ": " or " #"; keep the description parseable by strict loaders.
  assert.doesNotMatch(fields.description, /: | #/);
  for (const term of [/architecture audit/i, /migration/i, /modulari[sz]ation/i, /Lead Android Engineer/]) {
    assert.match(fields.description, term);
  }
});

test('SKILL.md has the six required sections in order', () => {
  const { body } = parseFrontmatter(readSkill());
  const headings = body.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.trim());
  const required = [
    '## Role',
    '## Ground rules',
    '## Scripts',
    '## Command: audit',
    '## Command: recommend',
    '## Not yet available',
  ];
  const positions = required.map((h) => headings.indexOf(h));
  for (let i = 0; i < required.length; i++) assert.ok(positions[i] >= 0, `missing heading ${required[i]}`);
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1], `${required[i]} must come after ${required[i - 1]}`);
  }
});

test('Not yet available lists only run', () => {
  const body = readSkill();
  const section = body.slice(body.indexOf('## Not yet available'));
  const listed = section.slice(0, section.indexOf('When asked for'));
  assert.match(listed, /`run`/);
  const names = [...listed.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual(names, ['run']);
});

test('every script named in SKILL.md exists', () => {
  const text = readSkill();
  const scripts = [...text.matchAll(/scripts\/([\w.-]+\.js)/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 3, 'SKILL.md should name the scan, candidates and recommend-check scripts');
  for (const s of ['scan.js', 'candidates.js', 'recommend-check.js']) assert.ok(scripts.includes(s), `SKILL.md must name ${s}`);
  for (const s of scripts) assert.ok(fs.existsSync(path.join(skillDir, 'scripts', s)), `missing script ${s}`);
});

test('every relative markdown link in SKILL.md and references resolves', () => {
  const files = [skillMdPath, ...walkFiles(path.join(skillDir, 'references')).filter((f) => f.endsWith('.md'))];
  let skillLinks = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/i.test(target)) continue;
      if (file === skillMdPath) skillLinks++;
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), target)), `${path.relative(skillDir, file)} links to missing ${target}`);
    }
  }
  assert.ok(skillLinks > 0, 'SKILL.md should link its references');
});

test('SKILL.md links all core references', () => {
  const text = readSkill();
  for (const ref of ['persona.md', 'recommendation-method.md', 'rubric-architecture.md', 'rubric-code-quality.md', 'output-templates.md']) {
    assert.ok(text.includes(`](references/${ref})`), `SKILL.md must link references/${ref}`);
  }
});

test('no file under skill/ contains TODO or TBD', () => {
  for (const file of walkFiles(skillDir)) {
    // .ai templates intentionally ship this exact placeholder for user-owned files.
    const text = fs.readFileSync(file, 'utf8').replaceAll('TODO: run "setup" in your agent', '');
    assert.doesNotMatch(text, /\bTODO\b|\bTBD\b/, `${path.relative(skillDir, file)} contains TODO or TBD`);
  }
});

test('C1: from:null is documented as only for a dimension with no detected entry, with justification', () => {
  const schema = fs.readFileSync(path.join(skillDir, 'catalog', 'recommendations.schema.md'), 'utf8');
  for (const text of [readSkill(), schema]) {
    assert.match(text, /`from: null`[^\n]*no detected entry/);
    assert.match(text, /`from: null`[^\n]*justification/);
  }
});

test('I7: SKILL.md ground rules, recommend loop and profile notes', () => {
  const { fields, body } = parseFrontmatter(readSkill());
  assert.doesNotMatch(fields.description, /Retrofit to Ktor/);
  assert.match(fields.description, /Dagger to Hilt/);
  const rule4 = /4\. \*\*Read only[^\n]*/.exec(body)[0];
  for (const t of ['mktemp', 'grep', 'rg', 'cat']) assert.match(rule4, new RegExp('`' + t + '`'), t);
  const rule5 = /5\. \*\*Leave secrets alone[^\n]*/.exec(body)[0];
  assert.match(rule5, /\[REDACTED:<kind>\]/);
  assert.match(rule5, /signingConfigs/);
  assert.match(rule5, /git-ignored/);
  const rec = body.slice(body.indexOf('## Command: recommend'), body.indexOf('## Not yet available'));
  assert.match(rec, /If `<tmp>` does not exist yet, create it as in audit step 1/);
  assert.match(rec, /Exit 2 because your own recommendations JSON is malformed[^\n]*counts as an attempt/);
  assert.match(rec, /more than 5 times in total/);
  assert.match(body, /`profile\.compliance`[^\n]*`ok`, `gap`, `check` or `unknown`/);
  assert.match(body, /`gap` is a statically detected likely violation \(confirm in the merged manifest/);
  assert.match(body, /`check` means the policy applies but the project cannot be verified statically/);
  assert.match(body, /`profile\.buildPerformance\.items`[^\n]*`ok`, `gap` or `unknown`/);
  assert.doesNotMatch(body, /`compliance` checks\)/);
});

test('I7: README scopes --json to doctor; architecture rubric follows the Google baseline', () => {
  const readme = fs.readFileSync(path.join(here, '..', 'README.md'), 'utf8');
  assert.match(readme, /`--json`[^\n]*`doctor`/);
  const rubric = fs.readFileSync(path.join(skillDir, 'references', 'rubric-architecture.md'), 'utf8');
  const s1 = rubric.slice(rubric.indexOf('## 1.'), rubric.indexOf('## 2.'));
  assert.match(s1, /UI layer must not depend on data sources directly/);
  assert.match(s1, /domain layer[^\n]*optional/i);
  assert.match(s1, /Only when the project claims Clean Architecture or dependency inversion/);
});

test('Task 9: SKILL.md documents setup, refresh, retrieval, stale context and rejections', () => {
  const text = readSkill();
  for (const h of ['## Command: setup', '## Command: refresh', '## Retrieval order', '## Stale context', '## Rejections']) {
    assert.ok(text.includes(h), `missing ${h}`);
  }
  for (const t of ['--adr-dir', 'ai-status.js', '--append-pointers', 'status: rejected', 'status: proposed', 'tools-modified', 'needs-confirmation', 'reopenIf', 'R7-rejected', 'graphify-out/']) {
    assert.ok(text.includes(t), `SKILL.md must mention ${t}`);
  }
  const rule4 = /4\. \*\*Read only[^\n]*/.exec(text)[0];
  for (const t of ['init-ai.js', 'refresh.js', 'index.js', 'ai-status.js', '`git`', '.ai/']) assert.ok(rule4.includes(t), `rule 4 must mention ${t}`);
});

test('Task 9: the rejected ADR example parses, and workspace and --out rules are documented', async () => {
  const text = readSkill();
  const m = /```\n(---\n[\s\S]*?\n---)\n```/.exec(text.slice(text.indexOf('## Rejections')));
  assert.ok(m, 'rejected ADR example block');
  const { parseAdr } = await import('../skill/scripts/lib/adr.js');
  const adr = parseAdr(m[1] + '\n', 'SKILL.md');
  assert.equal(adr.status, 'rejected');
  assert.ok(adr.dimension && adr.target && adr.reason);
  assert.ok(adr.reopenIf.some((c) => /^(present|absent):/.test(c)));
  assert.match(text, /role: member/);
  assert.match(text, /<hub>\/\.ai\/knowledge\/adr/);
  assert.match(text, /never the default/);
  assert.match(text, /--out <tmp>\/index\.json/);
  assert.match(text, /never the vendored copies/);
});

test('Task 9: output templates and method cover refresh and rejections', () => {
  const tpl = fs.readFileSync(path.join(skillDir, 'references', 'output-templates.md'), 'utf8');
  assert.match(tpl, /### Refresh report/);
  assert.match(tpl, /### ADR \(rejected\)/);
  assert.match(tpl, /status: rejected/);
  const method = fs.readFileSync(path.join(skillDir, 'references', 'recommendation-method.md'), 'utf8');
  assert.match(method, /R7-rejected/);
});

test('Task 10: rubric and method doc fixes', () => {
  const quality = fs.readFileSync(path.join(skillDir, 'references', 'rubric-code-quality.md'), 'utf8');
  assert.doesNotMatch(quality, /StrictMode disabled/);
  assert.match(quality, /unhandled Rx error \(crash on error\)/);
  assert.doesNotMatch(quality, /Rx `subscribe\(\)` without an error consumer/);
  const arch = fs.readFileSync(path.join(skillDir, 'references', 'rubric-architecture.md'), 'utf8');
  assert.match(arch, /Clean Architecture is an option, not a requirement/);
  const method = fs.readFileSync(path.join(skillDir, 'references', 'recommendation-method.md'), 'utf8');
  assert.match(method, /`dont` row keeps `target` as the current entry or `null`/);
});

test('Final review: SKILL.md uses full .ai/knowledge paths, member pointers, re-init rules and ADR warnings', () => {
  const text = fs.readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf8');
  for (const f of ['architecture-target.md', 'conventions.md', 'components.md']) {
    for (const m of text.matchAll(new RegExp('`([^`\\s]*' + f.replace('.', '\\.') + ')`', 'g'))) {
      if (m[1].includes('/')) assert.match(m[1], new RegExp('\\.ai/knowledge/' + f.replace('.', '\\.') + '$'), m[1]);
    }
  }
  assert.ok(!/(^|[^/\w])\.ai\/architecture-target\.md/.test(text), 'no .ai/architecture-target.md');
  assert.ok(text.includes('`<root>/.ai/knowledge/architecture-target.md`'));
  const section = (h) => text.slice(text.indexOf(h), text.indexOf('\n## ', text.indexOf(h) + 1));
  const rec = section('## Command: recommend');
  const setup = section('## Command: setup');
  const rejections = section('## Rejections');
  for (const [name, s] of [['recommend', rec], ['setup', setup], ['rejections', rejections]]) {
    for (const line of s.split('\n').filter((l) => l.includes('<root>/.ai/knowledge/adr'))) {
      assert.match(line, /\(member: see Workspaces\)/, `${name}: ${line.slice(0, 60)}`);
    }
  }
  const step1 = setup.split('\n').find((l) => l.startsWith('1. '));
  assert.match(step1, /mode/);
  assert.match(step1, /workspace role/);
  assert.match(step1, /remove `\.ai\/`/);
  assert.match(text, /\{ ok, violations, warnings \}/);
  assert.match(rejections, /warnings/);
});

test('Final review: README roadmap, update example and the npx skill note', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const catalog = JSON.parse(fs.readFileSync(new URL('../skill/catalog/catalog.json', import.meta.url), 'utf8'));
  assert.match(readme, /Done:[^\n]*M3[^\n]*gitignore-aware indexing/);
  const update = readme.split('\n').find((l) => l.includes('`update` reinstalls'));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(update.includes(`-> ${pkg.version} (catalog ${catalog.catalogVersion})`), update);
  assert.match(readme, /`init` and `refresh` use the skill bundled in the npx package[^\n]*run `update` first/);
});

test('M3: SKILL documents security, tools verification, suspicious text and overrides', () => {
  const text = readSkill();
  for (const s of ['rubric-security.md', 'tools-modified', 'tools-unverifiable', 'suspicious', 'catalog-overrides', 'unresolvedChecks']) {
    assert.ok(text.includes(s), s);
  }
  assert.match(text, /[Nn]ever (?:pass|add) `--trust-modified-tools`/);
  assert.match(text, /recommend-check\.js[^\n]*--root/);
  assert.match(text, /--no-overrides/);
});

test('M3: README documents redaction, doctor --root and the roadmap', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('[REDACTED:'));
  assert.ok(readme.includes('doctor --root'));
  assert.match(readme, /Done:[^\n]*M3/);
  assert.match(readme, /Done:[^\n]*M4/);
  assert.match(readme, /- M5:[^\n]*`run` loop/);
});

test('M4: package.json version is 0.4.0 and the changelog covers it', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '0.4.0');
  const log = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.match(log, /## \[0\.4\.0\] - Unreleased\n\n### Tool\n\n- /);
  const section = log.slice(log.indexOf('## [0.4.0]'), log.indexOf('## [0.3.0]'));
  assert.match(section, /unverified/);
  assert.match(section, /### Catalog/);
  assert.match(log, /## \[0\.3\.0\] - Unreleased\n\n### Tool\n\n- /);
});

test('SKILL ground rule 5 lists every secret file pattern and SKILL names every redaction kind', async () => {
  const { SECRET_FILE_PATTERNS } = await import('../skill/scripts/lib/walk.js');
  const { SECRET_RULES } = await import('../skill/scripts/lib/redact.js');
  const text = readSkill();
  const rule5 = text.split('\n').find((l) => l.startsWith('5. **Leave secrets alone.**'));
  assert.ok(rule5);
  const mentions = [...rule5.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\*/g, ''));
  for (const re of SECRET_FILE_PATTERNS) {
    assert.ok(mentions.some((n) => re.test(n)), `ground rule 5 does not mention ${re}`);
  }
  for (const { kind } of SECRET_RULES) assert.ok(text.includes(`\`${kind}\``), `SKILL.md misses redaction kind ${kind}`);
});

test('M4: SKILL.md has a heading per new command and names its script', () => {
  const text = readSkill();
  const scriptOf = { prioritize: 'features.js', 'migration-plan': 'migration-plan.js', 'data-migration': 'playbook.js', 'lib-update': 'lib-update.js', fitness: 'fitness.js', review: 'fitness.js' };
  for (const [cmd, script] of Object.entries(scriptOf)) {
    assert.ok(text.includes(`## Command: ${cmd}\n`), `missing ## Command: ${cmd}`);
    const section = text.slice(text.indexOf(`## Command: ${cmd}\n`)).split('\n## ')[0];
    assert.ok(section.includes(script), `${cmd} must name ${script}`);
  }
  assert.ok(text.includes('reuse.js'));
  const scripts = fs.readdirSync(path.join(skillDir, 'scripts')).filter((f) => f.endsWith('.js'));
  const rule4 = /4\. \*\*Read only[^\n]*/.exec(text)[0];
  for (const s of scripts) assert.ok(rule4.includes(s), `rule 4 must mention ${s}`);
  assert.ok(scripts.includes('fitness.js'));
  assert.match(rule4, /fitness\.js[^\n]*\.ai\/fitness\//);
});

test('M4: every playbook id SKILL.md and README mention exists in the shipped playbooks', () => {
  const dir = path.join(skillDir, 'catalog', 'playbooks');
  const ids = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md').map((f) => f.replace(/\.md$/, ''));
  const shipped = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).filter((f) => !f.startsWith('_') && f !== 'README.md');
  assert.equal(ids.length, shipped.length);
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const [name, text] of [['SKILL.md', readSkill()], ['README.md', readme]]) {
    for (const m of text.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*--to--[a-z0-9]+(?:-[a-z0-9]+)*)`/g)) assert.ok(ids.includes(m[1]), `${name} mentions unknown playbook ${m[1]}`);
  }
  for (const id of ids) assert.ok(readme.includes(`\`${id}\``), `README must list playbook ${id}`);
});

test('M4: SKILL.md does not document test-only options and states the verified:false rules', () => {
  const text = readSkill();
  assert.doesNotMatch(text, /--today|--versions-dir/);
  const section = (c) => text.slice(text.indexOf(`## Command: ${c}\n`)).split('\n## ')[0];
  assert.match(section('data-migration'), /verified: false/);
  assert.match(section('data-migration'), /200/);
  assert.match(section('data-migration'), /buildFiles/);
  assert.match(section('data-migration'), /applicable: false/);
  assert.match(section('lib-update'), /cannotUpdate/);
  assert.match(section('lib-update'), /verify/);
  assert.match(section('lib-update'), /unverified/);
  assert.match(section('fitness'), /8\.11/);
  assert.match(section('fitness'), /accepted/);
  assert.match(section('migration-plan'), /\.ai\/migration\/roadmap\.md/);
  assert.match(section('review'), /git diff/);
  assert.match(section('review'), /--check/);
});

test('M4: README mentions each command and the roadmap, CHANGELOG notes unverified data', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /## Planning a migration/);
  for (const c of ['prioritize', 'migration-plan', 'data-migration', 'lib-update', 'fitness', 'review']) assert.ok(readme.includes(`\`${c}\``), c);
  assert.match(readme, /unverified/);
  assert.match(readme, /No telemetry/);
});

test('M4: fitness docs match what generateFitness writes with and without rules', async () => {
  const { generateFitness, parseFitnessRules } = await import('../skill/scripts/lib/fitness.js');
  const none = Object.keys(generateFitness([], [])).sort();
  assert.deepEqual(none, ['README.md', 'verify-commands.json']);
  const { rules } = parseFitnessRules([{ status: 'accepted', file: 'a.md', fitness: ['module-no-dep: :a -> :b'] }]);
  const some = Object.keys(generateFitness(rules, [{ path: ':a', dir: 'a' }, { path: ':b', dir: 'b' }]));
  assert.ok(some.includes('architecture-fitness.gradle.kts') && some.includes('ArchitectureFitnessTest.kt'));
  const text = readSkill();
  const sec = text.slice(text.indexOf('## Command: fitness\n')).split('\n## ')[0];
  assert.match(sec, /`verify-commands\.json` and `README\.md` always/);
  assert.match(sec, /`architecture-fitness\.gradle\.kts` only when at least one `module-no-dep` rule exists/);
  assert.match(sec, /`ArchitectureFitnessTest\.kt` only when at least one rule exists/);
});
