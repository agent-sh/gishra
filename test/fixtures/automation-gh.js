'use strict';

const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
const file = process.env.AUTOMATION_GITHUB;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.calls ||= [];
state.calls.push(args);
// Write through a rename so a test reading the file never sees it truncated.
const save = () => {
  fs.writeFileSync(`${file}.${process.pid}`, JSON.stringify(state));
  fs.renameSync(`${file}.${process.pid}`, file);
};
let out = '';
if (args[0] === 'pr') {
  const pr = state.prs[args[2]];
  if (!pr) throw new Error(`unknown fixture PR ${args[2]}`);
  if (args[1] === 'view' && state.failView) {
    save();
    console.error('GitHub transport unavailable');
    process.exit(1);
  }
  if (args[1] === 'merge') {
    if (state.refuseMerge) {
      save();
      console.error('merge refused by fixture policy');
      process.exit(1);
    }
    pr.state = 'MERGED';
    pr.mergeCommit = { oid: pr.headRefOid };
    if (state.advanceBase) cp.execFileSync('git', ['-C', state.root, 'update-ref', 'refs/heads/main', pr.headRefOid]);
    if (process.env.AUTOMATION_CRASH_AFTER_MERGE) {
      save();
      const events = fs.readFileSync(path.join(state.root, '.tower-crane', 'events.jsonl'), 'utf8')
        .trim().split('\n').map(JSON.parse);
      const executor = events.findLast((e) => e.cmd === 'automation' && e.detail.phase === 'running');
      process.kill(executor.detail.pid, 'SIGKILL');
      // The killed executor is the test's CLI call, so the test resumes now.
      process.exit(0);
    }
  } else {
    out = JSON.stringify(pr);
    if (state.becomeMergeableAfterView) {
      pr.mergeable = 'MERGEABLE';
      pr.mergeStateStatus = 'CLEAN';
      state.becomeMergeableAfterView = false;
    }
  }
} else if (args[0] === 'api') {
  const sha = /commits\/([a-f\d]+)/.exec(args[1])?.[1];
  const status = state.ci?.[sha] || 'success';
  const suite = args[1].includes('check-suites');
  out = JSON.stringify({
    ...(suite ? { id: 1, runs: 1 } : { name: 'test', suite: 1 }),
    app: 'fixture', status: status === 'pending' ? 'in_progress' : 'completed',
    conclusion: status === 'pending' ? null : status,
  });
}
save();
console.log(out);
