'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { refuse, nowIso } = require('./util');
const S = require('./state');
const T = require('./tasks');
const W = require('./worktree');

const GATES = ['tests', 'clean', 'ci', 'merge'];

// Gates run outside the lock (tests can take minutes) and record their result
// afterwards against the revision they started on, so a plan change made
// meanwhile leaves the result uncounted.
async function runGate(ctx, name) {
  if (!GATES.includes(name)) throw refuse(`unknown gate ${name}`);
  const modPath = path.join(__dirname, 'gates', `${name}.js`);
  if (!fs.existsSync(modPath)) throw refuse(`gate not installed: ${name} (lib/gates/${name}.js is missing; update tower-crane)`);
  const st = S.loadState(ctx.stateDir);
  const task = T.getTask(st, ctx.pos[0]);
  const testsMode = name === 'tests'
    ? { tests_mode: require('./tests-policy').resolve(st.project, task.kind).mode ?? null } : {};
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  const commands = [];
  const gateCtx = {
    root: repo ? repo.root : null,
    // Capture execution here so a summary cannot stand in for a command receipt.
    exec: async (command, args, opts = {}) => {
      const run = opts.shell || opts.processTree ? require('./gates/common').treeExec : spawnSync;
      const r = await run(command, args, { windowsHide: true, ...opts });
      commands.push({ command, args: [...args], cwd: opts.cwd || null, status: r.status ?? null, signal: r.signal || null });
      return r;
    },
  };
  if (name === 'merge') {
    if (task.status !== 'accepted') throw refuse(`${task.id} is ${task.status}; merge needs an accepted task`);
    const ci = T.latestGateEvidence(task, 'ci', st.events);
    const merge = T.latestGateEvidence(task, 'merge', st.events);
    const merged = merge?.ok && !merge.waived;
    if (ci?.receipt && !merged && repo) {
      const { git, resolveCommit, how, errText, short } = require('./gates/common');
      const origin = await git(gateCtx, repo.root, ['remote', 'get-url', 'origin'], { timeout: 60000 });
      if (origin.ok) {
        const base = st.project.base.replace(/^origin\//, '');
        const ref = `refs/remotes/origin/${base}`;
        const fetched = await git(gateCtx, repo.root,
          ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', `+refs/heads/${base}:${ref}`],
          { timeout: 60000, killSignal: 'SIGKILL', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        if (!fetched.ok) throw refuse(`git fetch origin ${base} failed: ${how(fetched)}: ${errText(fetched)}`);
        const tip = await resolveCommit(gateCtx, repo.root, ref);
        if (tip !== ci.receipt.base_sha) {
          throw refuse(`local CI receipt base moved: origin/${base} is ${short(tip)}, checked base was ${short(ci.receipt.base_sha)}; run tower-crane check ci ${task.id} before merging`);
        }
      }
    }
    // Status alone is not enough: evidence recorded after the accept, or a
    // hand edit, can leave the gates failing for what would be merged.
    const report = T.gateReport(task, st.events, st);
    if (!report.ok) {
      const remedy = ci?.receipt && report.gates.some((g) => g.type === 'ci' && !g.ok)
        ? `run tower-crane check ci ${task.id} before merging`
        : `send it back with tower-crane rework ${task.id} --reason R`;
      throw refuse(`${task.id} is accepted, but its gates no longer pass: ${report.missing.join('; ')}; ${remedy}`);
    }
  }
  const worktree = repo ? W.findWorktree(repo, W.branchFor(task)) : null;
  const gate = require(modPath);
  if (!gate || typeof gate.run !== 'function') throw refuse(`gate not installed: lib/gates/${name}.js does not export run(ctx)`);
  const source = name === 'merge' ? 'merge' : `check ${name}`;
  const result = await gate.run({
    ...gateCtx,
    worktree,
    task: JSON.parse(JSON.stringify(task)),
    project: JSON.parse(JSON.stringify(st.project)),
    args: { ...ctx.flags },
    log: (msg) => process.stderr.write(`[${name}] ${msg}\n`),
  });
  if (!result || typeof result.ok !== 'boolean' || typeof result.summary !== 'string') {
    throw refuse(`gate ${name} returned an invalid result; expected { ok, summary }`);
  }
  const sha = result.sha || task.sha;
  if (!sha) throw refuse(`${task.id} has no submitted sha and the ${name} gate did not report one; submit the task first`);
  const entry = S.mutate(ctx, source, (st2, emit) => {
    const t = T.getTask(st2, task.id);
    const receipt = result.receipt ? { receipt: result.receipt } : {};
    const e = { type: name, ok: result.ok, sha: String(sha).toLowerCase(), agent: ctx.agent, at: nowIso(), summary: result.summary, ref: result.ref || null, revision: task.revision, source, commands, ...receipt, ...testsMode };
    t.evidence.push(e);
    emit(t.id, { type: name, ok: e.ok, sha: e.sha, ref: e.ref, revision: e.revision, source, commands, ...receipt, ...testsMode });
    return { task: t.id, ...e };
  });
  return {
    data: entry,
    text: `${entry.task}: ${name} ${entry.ok ? 'ok' : 'FAIL'} at ${entry.sha.slice(0, 7)}: ${entry.summary}`,
    code: entry.ok ? 0 : 1,
  };
}

module.exports = { runGate, GATES };
