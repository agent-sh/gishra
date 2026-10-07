'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const original = cp.spawnSync;
const BIN = path.join(__dirname, '..', '..', 'bin', 'tower-crane.js');

// Holds a gh call open until the test releases it, so another command can run meanwhile.
function pause(ready, release) {
  fs.writeFileSync(ready, 'ready');
  const deadline = performance.now() + 20000;
  while (!fs.existsSync(release)) {
    if (performance.now() > deadline) throw new Error('paused gh fixture was not released');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

// Only GitHub is stubbed. Worktrees, commits, fetches and the bare remote are real.
cp.spawnSync = function stackGh(command, args, opts) {
  if (command !== 'gh' || !process.env.TEST_STACK_DATA) return original(command, args, opts);
  const file = process.env.TEST_STACK_DATA;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.calls.push({ args, cwd: opts.cwd });
  const finish = (value = '', status = 0, stderr = '') => {
    fs.writeFileSync(file, JSON.stringify(data));
    return { status, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr };
  };
  // data.during runs tower-crane commands once while this gh call is in flight.
  const key = args.slice(0, 2).join(' ');
  for (const cli of data.during?.[key] || []) {
    const r = original(process.execPath, [BIN, ...cli], { cwd: data.repo, env: process.env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tower-crane ${cli.join(' ')} failed: ${r.stderr}`);
  }
  if (data.during) delete data.during[key];
  if (key === 'pr view' && args[2] === process.env.TEST_STACK_PAUSE_VIEW) {
    pause(process.env.TEST_STACK_PAUSE_READY, process.env.TEST_STACK_PAUSE_RELEASE);
  }
  const git = (gitArgs) => {
    const r = original('git', gitArgs, { ...opts, cwd: data.repo });
    if (r.status !== 0) throw new Error(String(r.stderr));
    return String(r.stdout).trim();
  };
  if (args[0] === 'api') {
    if (data.unavailable) return finish('', 9, 'Stacked pull requests are not enabled');
    if (args[1].includes('/stacks')) return finish(data.linked ? [{ id: 5, pull_requests: data.order.map((number) => ({ number })) }] : []);
    return finish({ name: 'build', app: 'ci', status: 'completed', conclusion: 'success', runs: 1 });
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    const pr = data.prs[args[2]];
    if (!pr) return finish('', 1, 'missing PR');
    return finish(pr);
  }
  if (args[0] === 'pr' && args[1] === 'edit') {
    data.prs[args[2]].baseRefName = args[args.indexOf('--base') + 1];
    return finish();
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    const pr = data.prs[args[2]];
    pr.state = 'MERGED';
    pr.mergeCommit = { oid: pr.headRefOid };
    git(['push', 'origin', `${pr.headRefName}:main`]);
    if (args.includes('--delete-branch')) git(['push', 'origin', `:${pr.headRefName}`]);
    return finish();
  }
  if (args[0] !== 'stack') throw new Error(`unexpected gh: ${args}`);
  if (args[1] === '--version') return finish(`gh-stack v${data.version || '0.2.0'}`);
  if (data.unavailable) return finish('', 9, 'Stacked pull requests are not enabled');
  if (args[1] === 'link') {
    if (process.env.TEST_STACK_LINK_READY) {
      fs.writeFileSync(process.env.TEST_STACK_LINK_READY, 'ready');
      const deadline = performance.now() + 20000;
      while (!fs.existsSync(process.env.TEST_STACK_LINK_RELEASE)) {
        if (performance.now() > deadline) throw new Error('slow link fixture was not released');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    data.linked = true;
    data.order = args.slice(2, args.indexOf('--base')).map(Number);
    return finish();
  }
  if (args[1] === 'checkout') return finish(opts.cwd);
  if (args[1] === 'unstack') { data.linked = false; return finish(); }
  if (args[1] === 'merge') {
    if (data.queued) return finish('queued');
    if (data.mergeUnavailable) return finish('', 9, 'Stacked pull requests are not enabled');
    const end = data.order.indexOf(Number(args[2]));
    for (const n of data.order.slice(0, end + 1)) {
      data.prs[n].state = 'MERGED';
      data.prs[n].mergeCommit = { oid: data.prs[n].headRefOid };
    }
    git(['push', 'origin', `${data.prs[args[2]].headRefName}:main`]);
    return finish();
  }
  if (args[1] === 'sync') {
    if (process.env.TEST_STACK_SYNC_READY) {
      fs.writeFileSync(process.env.TEST_STACK_SYNC_READY, 'ready');
      const deadline = performance.now() + 20000;
      while (!fs.existsSync(process.env.TEST_STACK_SYNC_RELEASE)) {
        if (performance.now() > deadline) throw new Error('slow gh fixture was not released');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    if (data.conflict) return finish('', 1, 'Conflict detected; all branches restored');
    if (data.syncCommit) {
      const r = original('git', ['-C', opts.cwd, 'commit', '--allow-empty', '-qm', 'sync refresh'], opts);
      if (r.status !== 0) throw new Error(String(r.stderr));
      const head = original('git', ['-C', opts.cwd, 'rev-parse', 'HEAD'], opts).stdout.trim();
      const pr = Object.values(data.prs).find((p) => p.headRefName === git(['-C', opts.cwd, 'branch', '--show-current']));
      pr.headRefOid = head;
      git(['push', 'origin', pr.headRefName]);
    }
    return finish();
  }
  throw new Error(`unexpected gh stack: ${args}`);
};
