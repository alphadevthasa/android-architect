// Minimal line-based workflow checker (no YAML dependency). Test-only helper, never shipped.
// It understands the plain block style used by this repository's workflows; anything it cannot
// find is reported as a violation, so an unusual layout fails closed.
export const ALLOWED_ACTIONS = ['actions/checkout', 'actions/setup-node'];

const indentOf = (l) => l.length - l.trimStart().length;
const skippable = (l) => /^\s*(#.*)?$/.test(l);
const stripComment = (s) => s.replace(/\s+#.*$/, '').trim();
const unq = (s) => s.replace(/^['"]|['"]$/g, '');

function topBlocks(lines) {
  const blocks = new Map();
  const dupes = [];
  let cur = null;
  for (const l of lines) {
    if (skippable(l)) { if (cur) cur.lines.push(l); continue; }
    const m = indentOf(l) === 0 && /^(['"]?)([A-Za-z_][\w-]*)\1\s*:(.*)$/.exec(l);
    if (m) {
      if (blocks.has(m[2])) dupes.push(m[2]);
      cur = { inline: stripComment(m[3]), lines: [] };
      blocks.set(m[2], cur);
    } else if (cur) cur.lines.push(l);
  }
  return { blocks, dupes };
}

function childKeys(lines) {
  const real = lines.filter((l) => !skippable(l));
  if (!real.length) return [];
  const ind = Math.min(...real.map(indentOf));
  return real.filter((l) => indentOf(l) === ind).map((l) => stripComment(l));
}

function splitJobs(jobsBlock) {
  const real = jobsBlock.lines.filter((l) => !skippable(l));
  if (!real.length) return [];
  const ind = Math.min(...real.map(indentOf));
  const jobs = [];
  let cur = null;
  for (const l of jobsBlock.lines) {
    if (!skippable(l) && indentOf(l) === ind && /^[\w-]+:\s*$/.test(l.trim())) {
      cur = { name: l.trim().slice(0, -1), lines: [] };
      jobs.push(cur);
    } else if (cur) cur.lines.push(l);
  }
  for (const j of jobs) analyzeJob(j);
  return jobs;
}

function analyzeJob(job) {
  const real = job.lines.filter((l) => !skippable(l));
  const keyInd = real.length ? Math.min(...real.map(indentOf)) : 0;
  job.keyInd = keyInd;
  const own = [];
  const stepsLines = [];
  let inSteps = false;
  for (const l of job.lines) {
    if (!skippable(l) && indentOf(l) <= keyInd) {
      inSteps = /^steps:\s*$/.test(l.trim()) && indentOf(l) === keyInd;
      own.push(l);
    } else if (inSteps) stepsLines.push(l);
    else own.push(l);
  }
  job.own = own;
  job.raw = job.lines.join('\n');
  const top = (key) => job.lines.find((l) => !skippable(l) && indentOf(l) === keyInd && new RegExp(`^${key}:`).test(l.trim()));
  job.top = top;
  const permIdx = job.lines.findIndex((l) => !skippable(l) && indentOf(l) === keyInd && /^permissions:/.test(l.trim()));
  if (permIdx >= 0) {
    const inline = stripComment(job.lines[permIdx].trim().slice('permissions:'.length));
    const kids = [];
    for (let i = permIdx + 1; i < job.lines.length; i++) {
      const l = job.lines[i];
      if (skippable(l)) continue;
      if (indentOf(l) <= keyInd) break;
      kids.push(stripComment(l));
    }
    job.permissions = { inline, entries: kids.sort() };
  }
  const real2 = stepsLines.filter((l) => !skippable(l));
  const steps = [];
  if (real2.length) {
    const sInd = Math.min(...real2.map(indentOf));
    let cur = null;
    for (const l of stepsLines) {
      if (!skippable(l) && indentOf(l) === sInd && l.trimStart().startsWith('- ')) { cur = { lines: [] }; steps.push(cur); }
      if (cur) cur.lines.push(l);
    }
    for (const s of steps) {
      const norm = s.lines.map((l, i) => (i === 0 ? l.replace('- ', '  ') : l));
      s.raw = s.lines.join('\n');
      s.keyInd = sInd + 2;
      s.norm = norm;
      const at = (k) => norm.findIndex((l) => !skippable(l) && indentOf(l) === s.keyInd && new RegExp(`^${k}:`).test(l.trim()));
      s.has = (k) => at(k) >= 0;
      const u = at('uses');
      s.uses = u >= 0 ? unq(stripComment(norm[u].trim().slice(5))) : null;
      s.usesLine = u >= 0 ? norm[u] : null;
      const r = at('run');
      s.run = null;
      if (r >= 0) {
        const body = [norm[r].trim().slice(4)];
        for (let i = r + 1; i < norm.length; i++) {
          if (!skippable(norm[i]) && indentOf(norm[i]) <= s.keyInd) break;
          body.push(norm[i]);
        }
        s.run = body.join('\n');
      }
    }
  }
  job.steps = steps;
}

function triggersOf(on) {
  if (!on) return null;
  if (on.inline) return on.inline.replace(/[[\]{}]/g, ' ').split(/[\s,]+/).filter(Boolean).map(unq);
  return childKeys(on.lines).map((l) => unq(l.split(':')[0].trim()));
}

export function checkWorkflow(text, kind) {
  const v = [];
  const unpinned = [];
  const lines = text.split('\n');
  const { blocks, dupes } = topBlocks(lines);
  if (dupes.length) v.push('duplicate-top-level-key');
  if (/pull_request_target/.test(text)) v.push('pull_request_target');
  if (/self-hosted/.test(text)) v.push('self-hosted-runner');
  if (/continue-on-error/.test(text)) v.push('continue-on-error');
  if (/\bsecrets\.(?!NPM_TOKEN\b)/.test(text)) v.push('unexpected-secret');
  const on = blocks.get('on') ?? blocks.get('true');
  const triggers = triggersOf(on);
  if (!triggers) v.push('no-triggers');
  const jobsBlock = blocks.get('jobs');
  const jobs = jobsBlock ? splitJobs(jobsBlock) : [];
  if (!jobs.length) v.push('no-jobs');
  const topPerm = blocks.get('permissions');
  const topEntries = topPerm ? childKeys(topPerm.lines).sort() : [];

  const allSteps = [];
  for (const j of jobs) {
    if (!j.top('timeout-minutes')) v.push(`job-timeout:${j.name}`);
    if (!j.steps.length) v.push(`job-no-steps:${j.name}`);
    if (!j.permissions) v.push(`job-permissions-missing:${j.name}`);
    for (const s of j.steps) {
      allSteps.push({ job: j, s });
      if (s.uses) {
        const [name, ref = ''] = s.uses.split('@');
        if (!ALLOWED_ACTIONS.includes(name)) v.push(`disallowed-action:${s.uses}`);
        else if (!/^[0-9a-f]{40}$/.test(ref)) unpinned.push(s.uses);
        if (name === 'actions/checkout' && !/persist-credentials:\s*false\b/.test(s.raw)) v.push('checkout-persist-credentials');
      }
      if (s.run !== null) {
        if (/\$\{\{/.test(s.run)) v.push(`run-interpolation:${j.name}`);
        if (/\b(curl|wget)\b/.test(s.run)) v.push('run-network-download');
        if (/\bnpx\b/.test(s.run) || /\bnpm\s+(install|i|ci|add|exec)\b/.test(s.run)) v.push('run-installs-code');
        if (/\|\s*(ba|z)?sh\b/.test(s.run)) v.push('run-pipe-to-shell');
      }
    }
  }
  if (/\buses:\s*(\.|docker:)/.test(text)) v.push('disallowed-action:local-or-docker');

  if (kind === 'ci') {
    const t = new Set(triggers ?? []);
    if (t.size !== 2 || !t.has('push') || !t.has('pull_request')) v.push('ci-triggers');
    if (!on || !/branches:[\s\S]*\bmain\b/.test(on.lines.join('\n'))) v.push('ci-push-branch-main');
    if (JSON.stringify(topEntries) !== JSON.stringify(['contents: read'])) v.push('ci-top-permissions');
    if (/:\s*write\b/.test(text) || /id-token/.test(text)) v.push('ci-write-permission');
    if (/\bsecrets\./.test(text)) v.push('ci-secrets');
    if (!blocks.has('concurrency') || !/cancel-in-progress:/.test(blocks.get('concurrency').lines.join('\n'))) v.push('ci-concurrency');
    for (const { job } of allSteps.map((x) => ({ job: x.job }))) if (job.top('environment')) v.push('ci-environment');
    const runs = allSteps.map((x) => x.s.run ?? '').join('\n');
    if (!/\bnpm test\b/.test(runs)) v.push('ci-npm-test');
    if (!/\bnpm run eval\b/.test(runs)) v.push('ci-npm-eval');
    if (!/npm pack --dry-run --json/.test(runs)) v.push('ci-pack-step');
    for (const j of jobs) for (const s of j.steps) if (s.has('env') && /secrets/.test(s.raw)) v.push('ci-secrets');
  }

  if (kind === 'release') {
    const t = new Set(triggers ?? []);
    if (t.size !== 2 || !t.has('push') || !t.has('workflow_dispatch')) v.push('release-triggers');
    const pushText = on ? on.lines.join('\n') : '';
    if (!/\btags:\s*\n\s*-\s*['"]?v\*['"]?\s*(#.*)?(\n|$)/.test(pushText) || /\bbranches\b/.test(pushText)) v.push('release-push-tags-only');
    if (!topPerm || topPerm.inline !== '{}' || topEntries.length) v.push('release-top-permissions');
    if (/id-token/.test(topPerm ? topPerm.lines.join('\n') : '')) v.push('release-top-permissions');
    const publishers = allSteps.filter((x) => x.s.run !== null && /\bnpm\s+publish\b/.test(x.s.run));
    if (publishers.length !== 1) v.push('release-publish-count');
    const pubJob = publishers[0]?.job;
    const idTokens = (text.match(/id-token:\s*write/g) ?? []).length;
    if (idTokens !== 1 || (pubJob && !/id-token:\s*write/.test(pubJob.raw))) v.push('release-id-token-scope');
    for (const j of jobs) if (j !== pubJob && /id-token/.test(j.raw)) v.push('release-id-token-scope');
    if (pubJob) {
      const p = pubJob.permissions;
      if (!p || p.inline !== '' || JSON.stringify(p.entries) !== JSON.stringify(['contents: read', 'id-token: write'])) v.push('release-job-permissions');
      const envLine = pubJob.top('environment');
      if (!envLine || stripComment(envLine.trim().slice(12)) !== 'release') v.push('release-environment');
      const runsOn = pubJob.top('runs-on');
      if (!runsOn || !/^runs-on:\s*ubuntu-latest\s*(#.*)?$/.test(runsOn.trim())) v.push('release-runner');
      const last = pubJob.steps[pubJob.steps.length - 1];
      if (last !== publishers[0].s) v.push('release-publish-not-last');
      const pubStep = publishers[0].s;
      if (!/--provenance\b/.test(pubStep.run) || !/--access\s+public\b/.test(pubStep.run)) v.push('release-provenance');
      if (!/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/.test(pubStep.raw)) v.push('release-token-on-publish-step');
      const names = pubJob.steps.map((s) => s.raw);
      const idx = (re) => pubJob.steps.findIndex((s) => s.run !== null && re.test(s.run));
      const pi = pubJob.steps.indexOf(pubStep);
      const before = (re, code) => { const i = idx(re); if (i < 0 || i > pi) v.push(code); };
      before(/GITHUB_REF_TYPE/, 'release-verify-tag-ref');
      before(/package\.json/, 'release-verify-version');
      before(/merge-base --is-ancestor/, 'release-verify-main');
      before(/\bnpm test\b/, 'release-npm-test');
      before(/\bnpm run eval\b/, 'release-npm-eval');
      before(/release-policy\.test\.js/, 'release-policy-step');
      const tagStep = pubJob.steps[idx(/GITHUB_REF_TYPE/)];
      if (tagStep && !/GITHUB_REF_TYPE"?\s*!=\s*"?tag/.test(tagStep.run)) v.push('release-verify-tag-ref');
      const policyStep = pubJob.steps[idx(/release-policy\.test\.js/)];
      if (policyStep && !/RELEASE_REQUIRE_PINNED:\s*['"]?1['"]?/.test(policyStep.raw)) v.push('release-policy-requires-pins');
      const checkout = pubJob.steps.find((s) => s.uses && s.uses.startsWith('actions/checkout@'));
      if (!checkout || !/fetch-depth:\s*0\b/.test(checkout.raw)) v.push('release-checkout-fetch-depth');
      const node = pubJob.steps.find((s) => s.uses && s.uses.startsWith('actions/setup-node@'));
      if (!node || !/registry-url:\s*https:\/\/registry\.npmjs\.org\/?\s*$/m.test(node.raw) || !/node-version:\s*['"]?\d+\.\d+\.\d+/.test(node.raw)) v.push('release-setup-node');
      if (pubJob.steps.some((s) => s.has('if'))) v.push('release-conditional-step');
      void names;
    }
    if ((text.match(/NODE_AUTH_TOKEN/g) ?? []).length !== 1) v.push('release-token-count');
    if ((text.match(/secrets\./g) ?? []).length !== 1) v.push('release-secret-count');
    if (/^\s*if:/m.test(text.split('\njobs:')[1] ?? '') ) v.push('release-conditional-step');
  }
  return { violations: [...new Set(v)], unpinned };
}
