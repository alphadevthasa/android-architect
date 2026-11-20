// Run reports: .ai/runs/<run>/report.md and report.json, written through the guarded writer. Everything in them is
// either a fixed phrase, a step id (checked against the id grammar), a number, or text that went through plainText
// (control and bidi characters removed, redacted, capped) and, in Markdown, mdText (no markup survives). Sizes are
// capped, so a plan with thousands of steps or a flood of agent output cannot grow a report.
import { writeGenerated } from './aidir.js';
import { mdText } from './mdtext.js';
import { plainText } from './rungit.js';
import { isStepId } from './runplan.js';

export const MAX_REPORT_STEPS = 200;
export const MAX_REPORT_BYTES = 64 * 1024;
const MAX_LIST = 20;

const num = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
const id = (s) => (isStepId(s) ? s : '(invalid id)');
const text = (s, max = 200) => plainText(s ?? '', max);

/** The data of a report, reduced to safe values and capped lists. */
export function sanitizeReport(info) {
  const steps = (Array.isArray(info.steps) ? info.steps : []).slice(0, MAX_REPORT_STEPS).map((s) => ({
    id: id(s.id),
    title: text(s.title, 120),
    status: s.status === 'done' ? 'done' : 'doing',
    result: text(s.result, 80),
    iterations: num(s.iterations),
    commit: typeof s.commit === 'string' && /^[0-9a-f]{7,64}$/.test(s.commit) ? s.commit : null,
    summary: text(s.summary, 300),
    diffFiles: (Array.isArray(s.diffFiles) ? s.diffFiles : []).slice(0, 20).map((f) => text(f, 120)),
  }));
  const rem = info.remaining ?? {};
  return {
    schemaVersion: 1,
    outcome: text(info.outcome, 40),
    reason: text(info.reason, 600),
    branch: info.branch ? text(info.branch, 120) : null,
    startedAt: text(info.startedAt, 40),
    endedAt: text(info.endedAt, 40),
    iterations: num(info.iterations),
    usage: { totalTokens: num(info.usage?.totalTokens), estimated: info.usage?.estimated === true },
    steps,
    stepsOmitted: Math.max(0, (Array.isArray(info.steps) ? info.steps.length : 0) - steps.length),
    remaining: { todo: num(rem.todo), doing: num(rem.doing), done: num(rem.done) },
    gated: (Array.isArray(info.gated) ? info.gated : []).slice(0, MAX_LIST).map((g) => ({ id: id(g.id), tags: (Array.isArray(g.tags) ? g.tags : []).slice(0, 4).map((t) => text(t, 20)) })),
    warnings: (Array.isArray(info.warnings) ? info.warnings : []).slice(0, MAX_LIST).map((w) => text(w, 300)),
    nothingPushed: true,
  };
}

const cap = (s, max) => {
  const b = Buffer.from(s, 'utf8');
  return b.length <= max ? s : `${b.subarray(0, max - 80).toString('utf8').replace(/�$/, '')}\n\n(report cut at ${max} bytes)\n`;
};

/** { md, json } for a run. */
export function renderReport(info) {
  const r = sanitizeReport(info);
  const L = [];
  L.push('# Run report', '');
  L.push(`- Outcome: **${mdText(r.outcome)}**`);
  L.push(`- Reason: ${mdText(r.reason)}`);
  L.push(`- Branch: ${r.branch ? `\`${mdText(r.branch)}\`` : '(none: the run did not start)'}`);
  L.push(`- Started: ${mdText(r.startedAt)}`, `- Ended: ${mdText(r.endedAt)}`);
  L.push(`- Iterations: ${r.iterations}`);
  L.push(`- Tokens: ${r.usage.totalTokens}${r.usage.estimated ? ' (partly estimated: the agent did not report usage)' : ''}`);
  L.push(`- Steps left: ${r.remaining.todo} todo, ${r.remaining.doing} doing, ${r.remaining.done} done`, '');
  L.push('**Nothing was pushed, merged or published.** Every change is a local commit on the branch above (or an uncommitted change in the working tree); review it and decide what to do with it.', '');
  L.push('## Steps in this run', '');
  if (r.steps.length === 0) L.push('No step was executed.', '');
  else {
    L.push('| Step | Title | Status | Result | Iterations | Commit |', '| --- | --- | --- | --- | --- | --- |');
    for (const s of r.steps) L.push(`| \`${mdText(s.id)}\` | ${mdText(s.title)} | ${s.status} | ${mdText(s.result)} | ${s.iterations} | ${s.commit ? s.commit.slice(0, 12) : '-'} |`);
    if (r.stepsOmitted > 0) L.push('', `${r.stepsOmitted} more steps are not listed.`);
    L.push('');
    const said = r.steps.filter((s) => s.summary);
    if (said.length > 0) {
      L.push('## What the agent said (untrusted text, shortened)', '');
      for (const s of said.slice(0, MAX_LIST)) L.push(`- \`${mdText(s.id)}\`: ${mdText(s.summary)}`);
      L.push('');
    }
  }
  if (r.gated.length > 0) {
    L.push('## Waiting for a human', '');
    for (const g of r.gated) L.push(`- \`${mdText(g.id)}\` (${g.tags.map((t) => mdText(t)).join(', ') || 'blocked'})`);
    L.push('');
  }
  if (r.warnings.length > 0) {
    L.push('## Warnings', '');
    for (const w of r.warnings) L.push(`- ${mdText(w)}`);
    L.push('');
  }
  L.push('## How to resume', '');
  L.push('Run the same `run` command again. It continues from the roadmap: a step marked `doing` is resumed (a step whose commit already exists on the run branch is only marked done), `done` steps are never repeated.');
  if (r.outcome === 'stopped') L.push('Delete `.ai/STOP` first.');
  if (r.outcome === 'verification-failed' || r.outcome === 'tampered' || r.outcome === 'failed' || r.outcome === 'no-progress' || r.outcome === 'repeated-error' || r.outcome === 'interrupted') {
    L.push('The unfinished step and its uncommitted changes were left in the working tree on purpose. Review them, then commit or discard them yourself before running again (a run refuses to start on a dirty tree).');
  }
  L.push('');
  return { md: cap(L.join('\n'), MAX_REPORT_BYTES), json: cap(`${JSON.stringify(r, null, 2)}\n`, 2 * MAX_REPORT_BYTES), data: r };
}

/** Writes report.md and report.json under .ai/runs/<runId>/ (runId: letters, digits, "_" and "-"). Returns { path } or throws a plain Error. */
export function writeRunReport(root, runId, info) {
  if (typeof runId !== 'string' || runId === '' || [...runId].some((c) => !/[A-Za-z0-9_-]/.test(c))) throw new Error('invalid run id');
  const { md, json } = renderReport(info);
  // a cut JSON is not JSON: when the cap bites, keep the report but drop the step list
  let jsonOut = json;
  if (jsonOut.includes('(report cut at')) jsonOut = `${JSON.stringify({ ...sanitizeReport({ ...info, steps: [] }), stepsOmitted: info.steps?.length ?? 0 }, null, 2)}\n`;
  writeGenerated(root, { [`runs/${runId}/report.md`]: md, [`runs/${runId}/report.json`]: jsonOut });
  return { path: `.ai/runs/${runId}/report.md` };
}
