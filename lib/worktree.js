'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { refuse, slugify } = require('./util');
const S = require('./state');
const T = require('./tasks');

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

function gitOrRefuse(args, cwd, what) {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = String(e.stderr || e.message).trim().split('\n').pop();
    throw refuse(`${what} failed: ${msg}`);
  }
}

function resolveBase(repo, base) {
  for (const ref of [base, `origin/${base}`]) {
    if (S.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo.root)) return ref;
  }
  throw refuse(`base branch ${base} is not in this repository; fetch it or change it with gishra project set --base B`);
}

// Creates the task's worktree (and branch) if missing, touching only git.
function create(repo, st, task) {
  const p = plan(repo, task);
  if (p.exists) return { ...p, created: false, branchCreated: false };
  if (fs.existsSync(p.path) && fs.readdirSync(p.path).length) {
    throw refuse(`${p.path} exists and is not a worktree for ${p.branch}; move it aside and retry`);
  }
  fs.mkdirSync(path.dirname(p.path), { recursive: true });
  const branchExists = !!S.git(['rev-parse', '--verify', '--quiet', `refs/heads/${p.branch}`], repo.root);
  if (branchExists) {
    gitOrRefuse(['worktree', 'add', p.path, p.branch], repo.root, `git worktree add for ${p.branch}`);
  } else {
    const base = resolveBase(repo, st.project.base);
    gitOrRefuse(['worktree', 'add', '-b', p.branch, p.path, base], repo.root, `git worktree add for ${p.branch}`);
  }
  const startSha = S.git(['rev-parse', `refs/heads/${p.branch}`], repo.root);
  return { ...p, created: true, branchCreated: !branchExists, startSha };
}

// Where events.jsonl ends now. A command that may undo a worktree takes this
// before creating it, so every later spawn or worktree event is someone else's.
function eventsMark(dir) {
  try {
    return fs.statSync(path.join(dir, 'events.jsonl')).size;
  } catch {
    return 0;
  }
}

// Whether a command since `mark` was given the task's worktree: a spawn that
// started an agent in it, or a worktree command that recorded it.
function adoptedSince(dir, mark, id) {
  let buf;
  try {
    buf = fs.readFileSync(path.join(dir, 'events.jsonl'));
  } catch {
    return mark > 0;
  }
  // A log shorter than the mark was edited by hand; keep the worktree.
  if (buf.length < mark) return true;
  return buf.subarray(mark).toString('utf8').split('\n').some((line) => {
    try {
      const e = JSON.parse(line);
      return e.task === id && (e.cmd === 'spawn' || e.cmd === 'worktree');
    } catch {
      return false;
    }
  });
}

// Undoes create() for a command refused after it ran. The caller holds the
// lock, so no other command can be handed the worktree between the check and
// the removal. Returns why the worktree was kept, or null.
function rollback(repo, wt, dir, mark, id) {
  if (!wt.created) return null;
  if (adoptedSince(dir, mark, id)) return 'another command has started using it';
  // Without --force, git refuses a worktree with changes or untracked files.
  if (S.git(['worktree', 'remove', wt.path], repo.root) === null) return 'it has changes';
  // Deleted only while it still points where create() made it.
  if (wt.branchCreated && wt.startSha) S.git(['update-ref', '-d', `refs/heads/${wt.branch}`, wt.startSha], repo.root);
  try {
    fs.rmdirSync(path.dirname(wt.path));
  } catch {
    // Other worktrees live there.
  }
  return null;
}

// Records the branch on the task inside the caller's write. A failed spawn
// may have removed the worktree since the caller found it; then the caller is
// refused rather than recording a branch with no worktree.
function record(t, wt, emit) {
  if (!fs.existsSync(wt.path)) throw refuse(`the worktree ${wt.path} was removed while this command ran; run it again`);
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

module.exports = { worktree, ensure, create, rollback, record, eventsMark, plan, findWorktree, needRepo, branchFor, pathFor };
