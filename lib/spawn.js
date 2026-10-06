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
    `You are ${agent}, the ${role} for ${task.id}. Use the gishra CLI for every state change: claim, submit, evidence, notes and spend (gishra --help lists the commands); never edit the state files by hand. GISHRA_STATE, GISHRA_TASK and GISHRA_AGENT are set, so gishra finds the state and records you as ${agent}.`,
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

async function spawn(ctx) {
  const f = ctx.flags;
  const p = prepare(ctx);
  if (f['dry-run']) {
    const wt = W.plan(p.repo, p.task);
    const c = command(ctx, p, wt.path, countSpawns(ctx.stateDir, p.roleName, p.task.id) + 1);
    const envLine = Object.entries(c.env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ');
    return {
      data: { agent: c.agent, harness: p.role.harness, cwd: wt.path, worktree_exists: wt.exists, argv: c.argv, env: c.env, log: c.log },
      text: `cd ${shellQuote(wt.path)} && ${envLine} ${c.argv.map(shellQuote).join(' ')}`,
    };
  }
  const wt = W.ensure(ctx, p.task.id);
  fs.mkdirSync(path.join(ctx.stateDir, 'logs'), { recursive: true });
  const wait = !!f.wait;
  let child;
  const started = S.mutate(ctx, 'spawn', (st, emit) => {
    const c = command(ctx, p, wt.path, countSpawns(ctx.stateDir, p.roleName, p.task.id) + 1);
    const env = { ...process.env, ...c.env };
    if (wait) {
      // stdout stays clean for --json; the agent's own output goes to stderr.
      child = cp.spawn(c.argv[0], c.argv.slice(1), { cwd: wt.path, env, stdio: ['ignore', ctx.json ? 2 : 'inherit', 'inherit'], windowsHide: true });
    } else {
      const fd = fs.openSync(c.log, 'a');
      try {
        child = cp.spawn(c.argv[0], c.argv.slice(1), { cwd: wt.path, env, stdio: ['ignore', fd, fd], detached: true, windowsHide: true });
      } finally {
        fs.closeSync(fd);
      }
    }
    child.on('error', () => {});
    if (!child.pid) throw refuse(`could not start ${c.argv[0]}; check that it is installed and on PATH`);
    if (!wait) child.unref();
    emit(p.task.id, { role: p.roleName, agent: c.agent, harness: p.role.harness, pid: child.pid, cwd: wt.path, log: wait ? null : c.log });
    return { agent: c.agent, pid: child.pid, cwd: wt.path, log: wait ? null : c.log, argv0: c.argv[0] };
  });
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

module.exports = { spawn, buildPrompt, buildCommand };
