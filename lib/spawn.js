'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { refuse, usage } = require('./util');
const S = require('./state');
const T = require('./tasks');
const W = require('./worktree');

function buildPrompt(task, brief, role, agent) {
  const taskJson = JSON.stringify({ id: task.id, title: task.title, acceptance: task.acceptance, kind: task.kind }, null, 2);
  const text = [
    brief.replace(/\s+$/, ''),
    '',
    '## Task',
    '',
    '```json',
    taskJson,
    '```',
    '',
    `You are ${agent}, the ${role} for ${task.id}. Use the gishra CLI for every state change: claim, submit, evidence, notes and spend (gishra --help lists the commands); never edit the state files by hand. GISHRA_STATE, GISHRA_TASK and GISHRA_AGENT are set, so gishra finds the state and records you as ${agent}; run gishra with --agent ${agent} if GISHRA_AGENT is missing.`,
  ].join('\n');
  // Harness CLIs read an argument that starts with "-" as an option; a brief
  // that opens with a list item would otherwise be mistaken for flags.
  return text.startsWith('-') ? `\n${text}` : text;
}

// pi can load gishra's own skills; they ship next to lib/ in the package, or
// GISHRA_PLUGIN_ROOT points at a plugin checkout that holds them.
const PI_SKILLS = { worker: 'gishra-work', reviewer: 'gishra-review' };

function piSkill(roleName, env) {
  const skill = PI_SKILLS[roleName];
  if (!skill) return null;
  const root = env.GISHRA_PLUGIN_ROOT || path.join(__dirname, '..');
  const dir = path.join(root, 'skills', skill);
  return fs.existsSync(dir) ? dir : null;
}

function buildCommand(roleName, role, prompt, subs, env = process.env) {
  const opt = (flag, value) => (value ? [flag, value] : []);
  const extra = role.args || [];
  switch (role.harness) {
    case 'claude':
      return ['claude', '-p', prompt, ...opt('--model', role.model), ...opt('--effort', role.effort), '--output-format', 'json', ...extra];
    case 'codex':
      return [
        'codex', 'exec', ...opt('-p', role.profile), ...opt('-m', role.model),
        ...(role.effort ? ['-c', `model_reasoning_effort=${role.effort}`] : []), prompt, ...extra,
      ];
    case 'opencode':
      return ['opencode', 'run', ...opt('-m', role.model), prompt, ...extra];
    case 'agy':
      return ['agy', '-p', prompt, '--mode', 'accept-edits', ...opt('--model', role.model), ...opt('--effort', role.effort), ...extra];
    case 'pi':
      return [
        'pi', '-p', prompt, ...opt('--model', role.model), ...opt('--provider', role.provider),
        ...opt('--thinking', role.effort), ...opt('--skill', piSkill(roleName, env)), ...extra,
      ];
    case 'command':
      return [...role.command.map((a) => a.replace(/\{(task|brief|prompt|cwd)\}/g, (_, k) => subs[k])), ...extra];
    default:
      throw refuse(`unknown harness ${role.harness}; set the role again with gishra role set`);
  }
}

function countSpawns(dir, role, id) {
  return S.readEvents(dir).filter((e) => e.cmd === 'spawn' && e.task === id && e.detail && e.detail.role === role).length;
}

function shellQuote(a) {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

function prepare(ctx) {
  const f = ctx.flags;
  if (!f.role) throw usage('spawn needs --role R');
  if (!f.task) throw usage('spawn needs --task ID');
  const st = S.loadState(ctx.stateDir);
  const role = st.project.roles[f.role];
  if (!role) throw refuse(`role ${f.role} is not in project.json; add it with gishra role set ${f.role} --harness H`);
  const task = T.getTask(st, f.task);
  const briefFile = T.briefPath(st.dir, task.id);
  let brief;
  try {
    brief = fs.readFileSync(briefFile, 'utf8');
  } catch {
    throw refuse(`${task.id} has no brief; write one with gishra brief set ${task.id} --file F before spawning`);
  }
  return { st, role, roleName: f.role, task, brief, briefFile, repo: W.needRepo(ctx) };
}

function command(ctx, p, cwd, n) {
  const agent = `${p.roleName}-${p.task.id}-${n}`;
  const prompt = buildPrompt(p.task, p.brief, p.roleName, agent);
  const argv = buildCommand(p.roleName, p.role, prompt, { task: p.task.id, brief: p.briefFile, prompt, cwd }, ctx.env);
  const env = { GISHRA_STATE: ctx.stateDir, GISHRA_TASK: p.task.id, GISHRA_AGENT: agent };
  const log = path.join(ctx.stateDir, 'logs', `${p.task.id}-${agent}.log`);
  return { agent, argv, env, log };
}

// Finds the program the way a shell-less spawn would, so a harness that
// cannot start is refused before a worktree is created or state is written.
// Windows follows libuv: a bare name is looked up in the cwd, then PATH; a
// name with an extension is tried as given, then with .com and .exe appended.
// Returns null when it is missing, undefined when it cannot be known yet
// because it lives in a worktree that does not exist.
function findExecutable(cmd, cwd, cwdExists, env) {
  const win = process.platform === 'win32';
  const abs = path.isAbsolute(cmd);
  const hasDir = /[\\/]/.test(cmd);
  const inWorktree = abs ? path.resolve(cmd).startsWith(path.resolve(cwd) + path.sep) : hasDir;
  if (inWorktree && !cwdExists) return undefined;
  let dirs;
  if (abs) dirs = [''];
  else if (hasDir) dirs = [cwd];
  else {
    // libuv falls back to the default search path when PATH is unset.
    const list = env.PATH === undefined ? (win ? '' : '/usr/bin:/bin') : env.PATH;
    dirs = [...(win && cwdExists ? [cwd] : []), ...String(list).split(path.delimiter).map((d) => d.replace(/^"(.*)"$/, '$1')).filter(Boolean)];
  }
  const exts = win ? [...(path.extname(cmd) ? [''] : []), '.com', '.exe'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = dir ? path.resolve(dir, cmd + ext) : cmd + ext;
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!win) fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {
        // Not here, or not executable.
      }
    }
  }
  return null;
}

async function spawn(ctx) {
  const f = ctx.flags;
  const p = prepare(ctx);
  const planned = W.plan(p.repo, p.task);
  if (f['dry-run']) {
    const c = command(ctx, p, planned.path, countSpawns(ctx.stateDir, p.roleName, p.task.id) + 1);
    const envLine = Object.entries(c.env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ');
    return {
      data: { agent: c.agent, harness: p.role.harness, cwd: planned.path, worktree_exists: planned.exists, argv: c.argv, env: c.env, log: c.log },
      text: `cd ${shellQuote(planned.path)} && ${envLine} ${c.argv.map(shellQuote).join(' ')}`,
    };
  }
  const argv0 = command(ctx, p, planned.path, 1).argv[0];
  if (findExecutable(argv0, planned.path, planned.exists, ctx.env) === null) {
    throw refuse(`could not start ${argv0}: no executable file by that name${path.isAbsolute(argv0) || /[\\/]/.test(argv0) ? '' : ' on PATH'}; install it, or fix the role with gishra role set ${p.roleName}`);
  }
  const wt = W.create(p.repo, p.st, p.task);
  const logs = path.join(ctx.stateDir, 'logs');
  const wait = !!f.wait;
  let child;
  let started;
  try {
    // The branch is recorded in the same write as the spawn, so a spawn that
    // fails leaves the task as it was.
    started = S.mutate(ctx, 'spawn', (st, emit) => {
      W.record(T.getTask(st, p.task.id), wt, emit);
      const c = command(ctx, p, wt.path, countSpawns(ctx.stateDir, p.roleName, p.task.id) + 1);
      const env = { ...process.env, ...c.env };
      if (wait) {
        // stdout stays clean for --json; the agent's own output goes to stderr.
        child = cp.spawn(c.argv[0], c.argv.slice(1), { cwd: wt.path, env, stdio: ['ignore', ctx.json ? 2 : 'inherit', 'inherit'], windowsHide: true });
      } else {
        fs.mkdirSync(logs, { recursive: true });
        const fresh = !fs.existsSync(c.log);
        const fd = fs.openSync(c.log, 'a');
        try {
          child = cp.spawn(c.argv[0], c.argv.slice(1), { cwd: wt.path, env, stdio: ['ignore', fd, fd], detached: true, windowsHide: true });
        } finally {
          fs.closeSync(fd);
        }
        if (!child.pid && fresh) {
          fs.rmSync(c.log, { force: true });
          try {
            fs.rmdirSync(logs);
          } catch {
            // Other agents' logs are there.
          }
        }
      }
      child.on('error', () => {});
      if (!child.pid) throw refuse(`could not start ${c.argv[0]}; check that it is installed and on PATH`);
      if (!wait) child.unref();
      emit(p.task.id, { role: p.roleName, agent: c.agent, harness: p.role.harness, pid: child.pid, cwd: wt.path, log: wait ? null : c.log });
      return { agent: c.agent, pid: child.pid, cwd: wt.path, log: wait ? null : c.log, argv0: c.argv[0] };
    });
  } catch (e) {
    // spawn never deletes a worktree or branch: another command may already
    // have been handed it, and the next spawn of the task reuses it.
    e.message += `; its worktree stays at ${wt.path} for the next spawn`;
    throw e;
  }
  if (!wait) {
    return { data: started, text: `${started.agent} started, pid ${started.pid}, log ${started.log}` };
  }
  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(1));
    child.on('exit', (c) => resolve(c === null ? 1 : c));
  });
  S.mutate(ctx, 'spawn exit', (st, emit) => emit(p.task.id, { role: p.roleName, agent: started.agent, pid: started.pid, code }));
  return { data: { ...started, code }, text: `${started.agent} exited with ${code}`, code };
}

module.exports = { spawn, buildPrompt, buildCommand, findExecutable };
