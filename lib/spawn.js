'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const os = require('node:os');
const { refuse, usage, shaMatch } = require('./util');
const S = require('./state');
const T = require('./tasks');
const W = require('./worktree');
const L = require('./ladder');
const P = require('./processes');
const Sessions = require('./spawn-session');
const A = require('./agents');

// What an agent on each rung is called, in its name and its prompt: every
// tier does a worker's job, whichever model it runs.
const JOBS = { orchestrator: 'orchestrator', easy: 'worker', medium: 'worker', hard: 'worker', research: 'worker', review: 'reviewer', small: 'small' };

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
    `You are ${agent}, the ${role} for ${task.id}; you are not the owner; never pass --agent owner. Use the tower-crane CLI for every state change: claim, submit, evidence, notes and spend (tower-crane --help lists the commands); never edit the state files by hand. TOWER_CRANE_STATE, TOWER_CRANE_TASK and TOWER_CRANE_AGENT are set, so tower-crane finds the state and records you as ${agent}; run tower-crane with --agent ${agent} if TOWER_CRANE_AGENT is missing.`,
  ].join('\n');
  // Harness CLIs read an argument that starts with "-" as an option; a brief
  // that opens with a list item would otherwise be mistaken for flags.
  return text.startsWith('-') ? `\n${text}` : text;
}

// pi can load Tower Crane's own skills; they ship next to lib/ in the package, or
// TOWER_CRANE_PLUGIN_ROOT points at a plugin checkout that holds them.
const PI_SKILLS = { worker: 'tower-crane-work', reviewer: 'tower-crane-review' };

function piSkill(job, env) {
  const skill = PI_SKILLS[job];
  if (!skill) return null;
  const root = env.TOWER_CRANE_PLUGIN_ROOT || path.join(__dirname, '..');
  const dir = path.join(root, 'skills', skill);
  return fs.existsSync(dir) ? dir : null;
}

function buildCommand(job, rung, prompt, subs, env = process.env, own = [], session = null) {
  const opt = (flag, value) => (value ? [flag, value] : []);
  const extra = rung.args || [];
  if (session && rung.harness === 'claude' && extra.includes('--fork-session')) throw refuse('session resume cannot use --fork-session; remove it with tower-crane ladder set');
  switch (rung.harness) {
    case 'claude':
      return ['claude', ...opt('--resume', session), '-p', prompt, ...opt('--model', rung.model), ...opt('--effort', rung.effort), '--output-format', 'json', ...own, ...extra];
    case 'codex':
      return [
        'codex', 'exec', ...(session ? [] : ['--json']), ...opt('-p', rung.profile),
        ...(session ? ['resume', '--json'] : []), ...opt('-m', rung.model),
        ...(rung.effort ? ['-c', `model_reasoning_effort=${rung.effort}`] : []), ...own, ...(session ? [session] : []), prompt, ...extra,
      ];
    case 'opencode':
      return ['opencode', 'run', '--format', 'json', ...opt('-m', rung.model), ...opt('--variant', rung.effort), prompt, ...extra];
    case 'agy':
      return ['agy', '-p', prompt, '--mode', 'accept-edits', '--output-format', 'json', ...opt('--model', rung.model), ...opt('--effort', rung.effort), ...extra];
    case 'pi':
      return [
        'pi', '-p', prompt, '--mode', 'json', ...opt('--model', rung.model), ...opt('--provider', rung.provider),
        ...opt('--thinking', rung.effort), ...opt('--skill', piSkill(job, env)), ...extra,
      ];
    case 'command':
      return [...rung.command.map((a) => a.replace(/\{(task|brief|prompt|cwd|session)\}/g, (_, k) => k === 'session' ? session || '' : subs[k])), ...extra];
    default:
      throw refuse(`unknown harness ${rung.harness}; fix the rung with tower-crane ladder set`);
  }
}

function countSpawns(dir, job, id) {
  return S.readEvents(dir).filter((e) => e.cmd === 'spawn' && e.task === id && e.detail && e.detail.role === job).length;
}

function shellQuote(a) {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

// With no --role the task's own tier picks the rung, so the orchestrator
// dispatches work at the tier it planned. spawn calls this twice: once to
// refuse early, before a worktree exists, and again on the state it reads
// under the lock, so a tier, ladder or brief change that lands in between is
// the one that runs.
function dispatch(ctx, st) {
  const f = ctx.flags;
  const task = T.getTask(st, f.task);
  const rungName = f.role || task.tier;
  const layers = L.resolve(st.project, ctx.env);
  const broken = L.rungErrors(rungName, layers.ladder[rungName], layers);
  if (broken.length) throw refuse(`${broken.join('; ')}; fix it with tower-crane ladder set ${rungName}`);
  const rung = L.rungOf(layers, rungName);
  const briefFile = T.briefPath(st.dir, task.id);
  let brief;
  try {
    brief = fs.readFileSync(briefFile, 'utf8');
  } catch {
    throw refuse(`${task.id} has no brief; write one with tower-crane brief set ${task.id} --file F before spawning`);
  }
  return { rung, rungName, job: JOBS[rungName], task, brief, briefFile };
}

function prepare(ctx) {
  const f = ctx.flags;
  if (!f.task) throw usage('spawn needs --task ID');
  if (f.role !== undefined && !L.RUNGS.includes(f.role)) throw usage(`--role must be a rung: ${L.RUNGS.join(', ')}; got "${f.role}"`);
  const st = S.loadState(ctx.stateDir);
  return { st, ...dispatch(ctx, st), repo: W.needRepo(ctx) };
}

function missing(argv0, rungName) {
  return refuse(`could not start ${argv0}: no executable file by that name${path.isAbsolute(argv0) || /[\\/]/.test(argv0) ? '' : ' on PATH'}; install it, or fix the rung with tower-crane ladder set ${rungName}`);
}

function reworkNote(p, events, resumed) {
  if (p.job !== 'worker' || !(p.task.status === 'rework' || p.task.claim?.from === 'rework')) return '';
  const rework = events.findLast((e) => e.cmd === 'rework' && e.task === p.task.id);
  const reviews = p.task.evidence.filter((e) => e.type === 'review' && !e.ok && e.revision === p.task.revision
    && shaMatch(e.sha, rework?.detail.sha || p.task.sha) && e.agent !== p.task.submitted_by);
  return [
    `## Rework ${p.task.id}`,
    rework?.detail.reason || 'Continue the requested rework.',
    ...reviews.map((e) => `Failed review by ${e.agent} at ${e.sha}: ${e.summary || 'No summary'}${e.ref ? `\nEvidence: ${e.ref}` : ''}`),
    resumed
      ? 'Continue in this worktree. Your worker identity and claim are kept. Follow skills/tower-crane-work/SKILL.md and submit the corrected head.'
      : 'Claim this task in this worktree. Follow skills/tower-crane-work/SKILL.md and submit the corrected head.',
  ].join('\n\n');
}

function command(ctx, p, cwd, n, events = S.readEvents(ctx.stateDir)) {
  let resume = Sessions.eligible(p, cwd, events);
  let agent = resume ? resume.agent : `${p.job}-${p.task.id}-${n}`;
  let iso = A.isolation(p.job, p.rung, p.rungName, { stateDir: ctx.stateDir, repo: p.repo, env: ctx.env, agent, cwd });
  const resumeFallbackReason = resume && Sessions.missingIsolatedSession(resume.id, p.rung.harness, iso);
  if (resumeFallbackReason) {
    resume = null;
    agent = `${p.job}-${p.task.id}-${n}`;
    iso = A.isolation(p.job, p.rung, p.rungName, { stateDir: ctx.stateDir, repo: p.repo, env: ctx.env, agent, cwd });
  }
  if (resume) {
    const submit = events.findLast((e) => e.cmd === 'submit' && e.task === p.task.id && e.agent === resume.agent && e.detail.claim);
    resume.claim = submit?.detail.claim || null;
  }
  const note = reworkNote(p, events, !!resume);
  const prompt = resume ? note : buildPrompt(p.task, [p.brief, note].filter(Boolean).join('\n\n'), p.job, agent);
  const argv = buildCommand(p.job, p.rung, prompt, { task: p.task.id, brief: p.briefFile, prompt, cwd }, ctx.env, iso ? iso.flags : [], resume?.id);
  const env = { TOWER_CRANE_STATE: ctx.stateDir, TOWER_CRANE_TASK: p.task.id, TOWER_CRANE_AGENT: agent, ...(iso ? iso.env : {}) };
  const log = path.join(ctx.stateDir, 'logs', `${p.task.id}-${agent}${resume ? `-attempt-${n}` : ''}.log`);
  return { agent, argv, env, log, resume, resumeFallbackReason, attempt: n, iso };
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
    const c = command(ctx, p, planned.path, countSpawns(ctx.stateDir, p.job, p.task.id) + 1);
    // The agent's PATH is the user's with its git and gh shims in front.
    const shown = (k, v) => (c.iso && k.toUpperCase() === 'PATH' ? `${shellQuote(path.join(c.iso.home, 'bin'))}${path.delimiter}"$PATH"` : shellQuote(v));
    const envLine = Object.entries(c.env).map(([k, v]) => `${k}=${shown(k, v)}`).join(' ');
    const home = c.iso && { path: c.iso.home, agent_file: c.iso.agent_file, mcp: c.iso.mcp, tools: c.iso.tools };
    const head = home ? `# agent file ${home.agent_file}; home ${home.path}; MCP servers: ${home.mcp.join(', ') || 'none'}; opted-in tools: ${home.tools.join(', ') || 'none'}\n` : '';
    return {
      data: {
        agent: c.agent, rung: p.rungName, harness: p.rung.harness, cwd: planned.path, worktree_exists: planned.exists,
        argv: c.argv, env: c.env, log: c.log, home, session_id: c.resume?.id || null, resumed: !!c.resume, attempt: c.attempt,
        ...(c.resumeFallbackReason ? { resume_fallback_reason: c.resumeFallbackReason } : {}),
      },
      text: `${head}cd ${shellQuote(planned.path)} && ${envLine} ${c.argv.map(shellQuote).join(' ')}`,
    };
  }
  const argv0 = command(ctx, p, planned.path, 1).argv[0];
  if (findExecutable(argv0, planned.path, planned.exists, ctx.env) === null) throw missing(argv0, p.rungName);
  const wt = W.create(p.repo, p.st, p.task);
  const logs = path.join(ctx.stateDir, 'logs');
  const wait = !!f.wait;
  let child;
  let started;
  let q;
  let logFd;
  let captureError;
  const closeLog = () => {
    if (logFd === undefined) return;
    const fd = logFd;
    logFd = undefined;
    fs.closeSync(fd);
  };
  try {
    // The branch is recorded in the same write as the spawn, so a spawn that
    // fails leaves the task as it was.
    started = S.mutate(ctx, 'spawn', (st, emit) => {
      q = dispatch(ctx, st);
      W.record(q.task, wt, emit);
      const c = command(ctx, { ...q, repo: p.repo }, wt.path, countSpawns(ctx.stateDir, q.job, q.task.id) + 1, st.events);
      let usageBefore = null;
      if (c.resume) {
        T.collectSpawn(st, emit, c.resume.previous);
        if (q.rung.harness === 'codex') usageBefore = require('./usage-files').readUsage(c.resume.previous.detail);
      }
      if (c.resume && (!q.task.claim || T.leaseExpired(q.task, Date.now()))) {
        const reasons = T.blockReasons(st, q.task);
        if (reasons.length) throw refuse(`${q.task.id} is blocked: ${reasons.join('; ')}; resolve its blockers, then retry tower-crane spawn --task ${q.task.id}`);
        T.checkWorkers(st, q.task, Date.now(), 'the workers limit is reached');
        const since = q.task.claim?.since || c.resume.claim?.since || new Date().toISOString();
        q.task.claim = { agent: c.agent, since, until: new Date(Date.now() + st.project.limits.lease_minutes * 60000).toISOString(), from: 'rework' };
        q.task.status = 'in_progress';
        emit(q.task.id, { holder: c.agent, until: q.task.claim.until, from: 'rework', resumed: true }, 'claim');
      }
      // The rung may have changed since the early check; its program is
      // checked again before anything starts.
      if (c.argv[0] !== argv0 && findExecutable(c.argv[0], wt.path, true, ctx.env) === null) throw missing(c.argv[0], q.rungName);
      const env = { ...process.env, ...ctx.env, ...c.env };
      // Credentials the agent process needs at run time only, kept out of c.env
      // so dry runs and events never show them.
      if (c.iso) Object.assign(env, c.iso.secretEnv());
      if (c.iso) c.iso.write();
      fs.mkdirSync(logs, { recursive: true });
      // Exclusive creation prevents replacing a log or following a planted link.
      try {
        logFd = fs.openSync(c.log, 'ax', 0o600);
      } catch (e) {
        if (e.code === 'EEXIST') throw refuse(`EEXIST: log already exists: ${c.log}; preserve or move it before retrying`);
        throw e;
      }
      if (wait) {
        child = cp.spawn(c.argv[0], c.argv.slice(1), { cwd: wt.path, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        // Tee both streams so foreground usage has the same durable source.
        const capture = (dest) => (data) => {
          if (!captureError && logFd !== undefined) {
            try { fs.writeFileSync(logFd, data); } catch (e) { captureError = e; }
          }
          dest.write(data);
        };
        child.stdout?.on('data', capture(ctx.json ? process.stderr : process.stdout));
        child.stderr?.on('data', capture(process.stderr));
        child.on('close', closeLog);
      } else {
        child = cp.spawn(c.argv[0], c.argv.slice(1), { cwd: wt.path, env, stdio: ['ignore', logFd, logFd], detached: true, windowsHide: true });
      }
      child.on('error', (error) => process.stderr.write(`tower-crane: harness process failed: ${error.message}\n`));
      if (!child.pid) {
        closeLog();
        fs.rmSync(c.log, { force: true });
        try { fs.rmdirSync(logs); } catch {
          // Other agents' logs are there.
        }
        throw refuse(`could not start ${c.argv[0]}; check that it is installed and on PATH`);
      }
      const detail = {
        role: q.job, rung: q.rungName, agent: c.agent, harness: q.rung.harness,
        route: q.rung, attempt: c.attempt, session_id: c.resume?.id || null, resumed: !!c.resume,
        ...(c.resumeFallbackReason ? { resume_fallback_reason: c.resumeFallbackReason } : {}),
        ...(c.resume && q.rung.harness === 'codex' ? { usage_before: usageBefore } : {}),
        model: q.rung.model || null, profile: q.rung.profile || null,
        pid: child.pid, ...P.identity(child.pid),
        cwd: wt.path, log: c.log,
        ...(q.rung.harness === 'codex' ? { codex_home: (c.iso && c.iso.usageRoot) || env.CODEX_HOME || path.join(os.homedir(), '.codex') } : {}),
      };
      emit(q.task.id, detail);
      return { ...detail, argv0: c.argv[0] };

    });
  } catch (e) {
    closeLog();
    // spawn never deletes a worktree or branch: another command may already
    // have been handed it, and the next spawn of the task reuses it.
    e.message += `; its worktree stays at ${wt.path} for the next spawn`;
    throw e;
  }
  if (!wait) {
    try {
      const monitor = cp.spawn(process.execPath, [
        path.join(__dirname, 'spawn-monitor.js'),
        JSON.stringify({ ...started, state: ctx.stateDir, task: q.task.id }),
      ], { stdio: ['ignore', 'ignore', logFd], detached: true, windowsHide: true });
      monitor.on('error', (e) => process.stderr.write(`tower-crane: usage monitor could not start: ${e.message}; retry spend ${q.task.id} --from-spawn ${started.agent}\n`));
      monitor.unref();
    } finally {
      closeLog();
    }
    child.unref();
    return { data: started, text: `${started.agent} started, pid ${started.pid}, log ${started.log}` };
  }
  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', (c) => resolve(c === null ? 1 : c));
  });
  S.mutate(ctx, 'spawn exit', (st, emit) => emit(q.task.id, { role: q.job, rung: q.rungName, agent: started.agent, pid: started.pid, attempt: started.attempt, code }));
  if (captureError) process.stderr.write(`tower-crane: usage log capture failed: ${captureError.message}; retry spend ${q.task.id} --from-spawn ${started.agent}\n`);
  try {
    T.spend({ ...ctx, agent: started.agent, pos: [q.task.id], flags: { 'from-spawn': started.agent } });
  } catch (e) {
    process.stderr.write(`tower-crane: usage not recorded: ${e.message}; retry spend ${q.task.id} --from-spawn ${started.agent}\n`);
  }
  return { data: { ...started, code }, text: `${started.agent} exited with ${code}`, code };
}

module.exports = { spawn, buildPrompt, buildCommand, findExecutable };
