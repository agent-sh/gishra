'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const bin = process.argv[2];
const mode = process.argv[3];
const task = process.env.TOWER_CRANE_TASK;
const state = JSON.parse(fs.readFileSync(process.env.AUTOMATION_GITHUB, 'utf8'));
const pr = state.prs['7'];
const run = (args) => cp.execFileSync(process.execPath, [bin, ...args], { stdio: 'pipe' });
if (process.env.AUTOMATION_POLICY_PROBE) {
  const denials = [['api', 'repos/acme/demo'], ['pr', 'merge', '7']].map((args) => {
    const r = cp.spawnSync('gh', args, { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr };
  });
  fs.appendFileSync(process.env.AUTOMATION_POLICY_PROBE, JSON.stringify({ path: process.env.PATH || process.env.Path, denials }) + '\n');
}
const taskState = JSON.parse(fs.readFileSync(require('node:path').join(process.env.TOWER_CRANE_STATE, 'tasks.json'), 'utf8'))
  .tasks.find((t) => t.id === task);
if (mode === 'worker' || mode === 'auto' && taskState.status !== 'submitted') {
  run(['claim', task]);
  run(['submit', task, '--sha', pr.headRefOid, '--pr', '7']);
  if (process.env.AUTOMATION_WORKER_HOLD) {
    const hold = process.env.AUTOMATION_WORKER_HOLD;
    fs.writeFileSync(hold, '');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(`${hold}.go`) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
} else {
  run(['evidence', task, '--type', 'review', '--sha', pr.headRefOid, '--ok']);
}
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
