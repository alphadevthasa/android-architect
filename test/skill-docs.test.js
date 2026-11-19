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

test('Not yet available lists every later command', () => {
  const body = readSkill();
  const section = body.slice(body.indexOf('## Not yet available'));
  for (const cmd of ['setup', 'prioritize', 'migration-plan', 'data-migration', 'lib-update', 'review', 'refresh', 'fitness', 'run']) {
    assert.match(section, new RegExp('`' + cmd + '`'), `missing ${cmd}`);
  }
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
    // .ai templates intentionally ship `TODO: run "setup"` placeholders for user-owned files.
    if (path.relative(skillDir, file).startsWith(path.join('templates', 'ai') + path.sep)) continue;
    const text = fs.readFileSync(file, 'utf8');
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
  assert.match(body, /`profile\.compliance`[^\n]*`ok`, `gap` or `unknown`/);
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
