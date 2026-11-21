// The plan of the test/fixtures/run-app fixture: four steps (plain, dependent, [decision], [irreversible]). The fixture's
// .ai/migration/plan.json and roadmap.md are generated from it with the real renderRoadmap; the e2e test checks they still match.
import { renderRoadmap, checkPlan } from '../../skill/scripts/lib/migplan.js';

const S = (id, title, extra = {}) => ({ id, title, track: 'enabling', dimension: 'ui', from: 'legacy', to: 'target', dependsOn: [], tags: [], verification: [], rollback: 'revert the commit', evidence: [], ...extra });

export const FIXTURE_STEPS = [
  S('s1-extract-api', 'Extract the greeting API'),
  S('s2-wire-ui', 'Wire the UI to the API', { dependsOn: ['s1-extract-api'] }),
  S('s3-pick-store', 'Pick the storage library', { tags: ['decision'] }),
  S('s4-drop-legacy', 'Drop the legacy module', { tags: ['irreversible'] }),
];

export function makePlan(steps = FIXTURE_STEPS) {
  const plan = { schemaVersion: 1, steps, tracks: { enabling: steps.map((s) => s.id), data: [], features: [] }, notes: [] };
  const problems = checkPlan(plan);
  if (problems.length > 0) throw new Error(`fixture plan invalid: ${problems.join('; ')}`);
  return plan;
}

/** { 'plan.json': text, 'roadmap.md': text } exactly as the fixture files hold them. */
export function planFiles(steps = FIXTURE_STEPS) {
  const plan = makePlan(steps);
  return { 'plan.json': `${JSON.stringify(plan, null, 2)}\n`, 'roadmap.md': renderRoadmap(plan) };
}
