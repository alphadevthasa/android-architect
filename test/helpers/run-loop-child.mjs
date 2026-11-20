// Child process for the SIGINT test: runs the loop with a real (hanging) stub agent and prints one JSON line at the end.
// usage: node run-loop-child.mjs <projectRoot> <stubPath>
import { runLoop } from '../../skill/scripts/lib/runloop.js';
import { runAgent } from '../../skill/scripts/lib/agent.js';
import { DEFAULT_RUN_CONFIG } from '../../skill/scripts/lib/runconfig.js';

const [root, stub] = process.argv.slice(2);
const agentConfig = { ...JSON.parse(JSON.stringify(DEFAULT_RUN_CONFIG)), agent: { kind: 'custom', command: [process.execPath, stub, 'hang'], requireArgs: [], passEnv: [] } };
const agent = (r, _cfg, opts) => {
  console.log('READY');
  return runAgent(r, agentConfig, { ...opts, timeoutMs: 120000 });
};
const result = await runLoop(root, { agent, confirm: async () => true, say: () => {} });
console.log(`RESULT ${JSON.stringify({ outcome: result.outcome, reason: result.reason, reportPath: result.reportPath })}`);
