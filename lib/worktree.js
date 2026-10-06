'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { refuse, slugify } = require('./util');
const S = require('./state');
const T = require('./tasks');

// Bound dispatch stalls when origin is unreachable; fetching one base gets a minute.
const FETCH_TIMEOUT_MS = 60 * 1000;

function needRepo(ctx) {
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  if (!repo) throw refuse('this needs a git repository; run gishra from inside the repo');
  return repo;
}

function branchFor(task) {
  return task.branch || `gishra/${task.id}-${slugify(task.title)}`;
}

// The directory comes from the branch, not the title, so renaming a task
// after its worktree exists still finds the same worktree.
function pathFor(repo, branch) {
  const name = path.basename(repo.root).replace(/\.git$/, '');
  const leaf = branch.replace(/^gishra\//, '').replace(/[\\/]+/g, '-');
  return path.join(path.dirname(repo.root), `${name}-worktrees`, leaf);
}

function listWorktrees(repo) {
  const out = S.git(['worktree', 'list', '--porcelain'], repo.root) || '';
  const list = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: path.resolve(line.slice(9)), branch: null };
      list.push(cur);
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    }
  }
  return list;
}

function findWorktree(repo, branch) {
  const hit = listWorktrees(repo).find((w) => w.branch === branch);
  return hit ? hit.path : null;
}

// Where the task's worktree is or would be, without touching anything.
function plan(repo, task) {
  const branch = branchFor(task);
  const existing = findWorktree(repo, branch);
  return { branch, path: existing || pathFor(repo, branch), exists: !!existing };
}

function gitFailure(e, what, timeout) {
  if (e.code === 'ETIMEDOUT') return refuse(`${what} timed out after ${timeout / 1000} s`);
  const msg = String(e.stderr || e.message).trim().split('\n').pop();
  return refuse(`${what} failed: ${msg}`);
}

function gitOrRefuse(args, cwd, what, timeout) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim();
  } catch (e) {
    throw gitFailure(e, what, timeout);
  }
}

function fetchBase(repo, base, remote, localSha) {
  const what = `git fetch origin ${base}`;
  try {
    // FETCH_HEAD is shared too; callers resolve the explicit destination instead.
    execFileSync('git', ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', `+refs/heads/${base}:${remote}`],
      { cwd: repo.root, env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'], timeout: FETCH_TIMEOUT_MS });
  } catch (e) {
    const error = gitFailure(e, what, FETCH_TIMEOUT_MS);
    const stderr = String(e.stderr || '');
    const refRace = stderr.includes(`cannot lock ref '${remote}'`)
      || stderr.includes(`fetching ref ${remote} failed: incorrect old value provided`);
    const missing = stderr.includes(`couldn't find remote ref refs/heads/${base}`);
    if (e.code === 'ETIMEDOUT' || (!refRace && !missing)) throw error;
    // A failed fetch is safe only if a fresh origin read proves the fallback.
    const refs = gitOrRefuse(['ls-remote', '--heads', 'origin', `refs/heads/${base}`],
      repo.root, `git ls-remote origin ${base}`, FETCH_TIMEOUT_MS);
    const tip = refs.split(/\r?\n/).map((line) => line.split(/\s+/))
      .find(([, ref]) => ref === `refs/heads/${base}`);
    if (!tip) {
      if (!localSha) throw refuse(`base branch ${base} is not in this repository; fetch it or change it with gishra project set --base B`);
      process.stderr.write(`origin has no base branch ${base}; using local base at ${localSha}\n`);
      return localSha;
    }
    if (!refRace || S.git(['rev-parse', '--verify', '--quiet', `${remote}^{commit}`], repo.root) !== tip[0]) throw error;
  }
  return null;
}

function resolveBase(repo, base) {
  const local = `refs/heads/${base}`;
  const remote = `refs/remotes/origin/${base}`;
  const localSha = S.git(['rev-parse', '--verify', '--quiet', `${local}^{commit}`], repo.root);
  if (S.git(['remote', 'get-url', 'origin'], repo.root)) {
    // An explicit destination refreshes the base even with a narrow origin fetch config.
    const fallback = fetchBase(repo, base, remote, localSha);
    if (fallback) return fallback;
  }
  const remoteSha = S.git(['rev-parse', '--verify', '--quiet', `${remote}^{commit}`], repo.root);
  if (remoteSha && (!localSha || S.git(['merge-base', '--is-ancestor', localSha, remoteSha], repo.root) !== null)) {
    return remoteSha;
  }
  // Keep local commits when the fetched branch is behind or has diverged.
  if (localSha) {
    if (remoteSha) process.stderr.write(`using local base ${base} at ${localSha}; origin/${base} is at ${remoteSha}\n`);
    return localSha;
  }
  throw refuse(`base branch ${base} is not in this repository; fetch it or change it with gishra project set --base B`);
}

// Creates the task's worktree (and branch) if missing, touching only git.
function create(repo, st, task) {
  const p = plan(repo, task);
  if (p.exists) return { ...p, created: false };
  if (fs.existsSync(p.path) && fs.readdirSync(p.path).length) {
    throw refuse(`${p.path} exists and is not a worktree for ${p.branch}; move it aside and retry`);
  }
  fs.mkdirSync(path.dirname(p.path), { recursive: true });
  if (S.git(['rev-parse', '--verify', '--quiet', `refs/heads/${p.branch}`], repo.root)) {
    gitOrRefuse(['worktree', 'add', p.path, p.branch], repo.root, `git worktree add for ${p.branch}`);
  } else {
    const base = resolveBase(repo, st.project.base);
    gitOrRefuse(['worktree', 'add', '-b', p.branch, p.path, base], repo.root, `git worktree add for ${p.branch}`);
  }
  return { ...p, created: true };
}

// Records the branch on the task inside the caller's write.
function record(t, wt, emit) {
  if (t.branch) return;
  t.branch = wt.branch;
  emit(t.id, { branch: wt.branch, path: wt.path }, 'worktree');
}

function ensure(ctx, taskId) {
  const repo = needRepo(ctx);
  const st = S.loadState(ctx.stateDir);
  const task = T.getTask(st, taskId);
  const wt = create(repo, st, task);
  if (!task.branch) S.mutate(ctx, 'worktree', (st2, emit) => record(T.getTask(st2, task.id), wt, emit));
  return { id: task.id, branch: wt.branch, path: wt.path, created: wt.created, repo };
}

function worktree(ctx) {
  const r = ensure(ctx, ctx.pos[0]);
  return { data: { id: r.id, branch: r.branch, path: r.path, created: r.created }, text: r.path };
}

module.exports = { worktree, ensure, create, record, plan, findWorktree, needRepo, branchFor, pathFor };
