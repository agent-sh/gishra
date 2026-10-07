'use strict';

// The state broker. A sandboxed agent reads the state directory but cannot
// write it; its tower-crane CLI sends each state change over a socket to the
// spawn monitor that started it, which runs outside the sandbox. The monitor
// knows whom it started: it checks the token it wrote into that agent's
// private home, allows only the agent's role's commands on the agent's own
// task, and runs them as that agent.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { refuse, usage } = require('./util');

const FILE = 'broker.json';
const CLI = path.join(__dirname, '..', 'bin', 'tower-crane.js');
const MAX_REQUEST = 1 << 20;
// sun_path holds 104 bytes on macOS and 108 on Linux, terminator included.
const MAX_SOCKET_PATH = 100;

// The state changes each sandboxed role may make, all on its own task.
const ROLES = {
  worker: ['claim', 'renew', 'release', 'submit', 'spend', 'task note', 'msg', 'ask', 'worktree', 'check tests', 'check clean'],
  reviewer: ['evidence', 'task note', 'msg'],
  small: ['task note'],
};
const EVIDENCE = { reviewer: ['review'] };

// Commands that only read the state run in the agent itself.
const READS = new Set(['project show', 'ladder show', 'task show', 'task list', 'brief get', 'validate', 'ready', 'decisions', 'status']);

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// In the agent's home when the path fits a socket address, else in a fresh
// private directory under the temp dir; broker.json names it either way.
function socketPath(home) {
  if (process.platform === 'win32') return { socket: `\\\\.\\pipe\\tower-crane-${crypto.randomBytes(16).toString('hex')}`, dir: null };
  const own = path.join(home, 'broker.sock');
  if (Buffer.byteLength(own) <= MAX_SOCKET_PATH) return { socket: own, dir: null };
  for (const root of [os.tmpdir(), '/tmp']) {
    if (Buffer.byteLength(path.join(root, 'tower-crane-XXXXXX', 's')) > MAX_SOCKET_PATH) continue;
    const dir = fs.mkdtempSync(path.join(root, 'tower-crane-'));
    return { socket: path.join(dir, 's'), dir };
  }
  throw refuse(`no socket path short enough for ${home}`);
}

// The command an agent asked for, checked against the spawn it came from.
// Returns the argv the broker runs, with the agent and state it names
// itself in place of any the request gave.
function authorize(job, argv) {
  const { resolveCommand, parseOptions, GLOBAL } = require('../bin/tower-crane');
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) throw usage('the broker needs an argv of strings');
  const resolved = resolveCommand(argv);
  if (!resolved.cmd) throw usage('the broker runs commands, not help');
  const { cmd } = resolved;
  const tokens = [...resolved.lead, ...resolved.rest];
  const parsed = parseOptions(tokens, { ...(cmd.flags || {}), ...GLOBAL }, cmd.name);
  const allowed = ROLES[job.role] || [];
  if (!allowed.includes(cmd.name)) {
    throw refuse(`${job.agent} is a sandboxed ${job.role}; it changes state only with ${allowed.join(', ') || 'no command'}, not ${cmd.name}`);
  }
  const f = parsed.flags;
  if (f.agent !== undefined && f.agent.trim() !== job.agent) throw refuse(`${job.agent} cannot act as ${f.agent}`);
  const spec = cmd.pos || [];
  const ids = [
    ...(spec[0] === 'ID...' ? parsed.pos : spec[0] === 'ID' ? parsed.pos.slice(0, 1) : []),
    ...(f.task !== undefined ? [f.task] : []),
    ...(f.blocks || []),
  ];
  for (const id of ids) if (id !== job.task) throw refuse(`${job.agent} works on ${job.task} only, not ${id}`);
  if (cmd.name === 'evidence' && !(EVIDENCE[job.role] || []).includes(f.type)) {
    throw refuse(`${job.agent} records ${(EVIDENCE[job.role] || []).join(', ') || 'no'} evidence, not ${f.type}`);
  }
  if (f['from-spawn'] !== undefined && f['from-spawn'] !== job.agent) throw refuse(`${job.agent} collects its own spawn only, not ${f['from-spawn']}`);
  const dropped = new Set(parsed.spans.filter((s) => s.name === 'agent' || s.name === 'state').flatMap((s) => [s.from, s.to]));
  return [...cmd.name.split(' '), ...tokens.filter((_, i) => !dropped.has(i)), '--agent', job.agent, '--state', job.state];
}

function run(job, argv) {
  const env = { ...process.env, TOWER_CRANE_STATE: job.state, TOWER_CRANE_TASK: job.task, TOWER_CRANE_AGENT: job.agent, TOWER_CRANE_VIA: 'broker' };
  delete env.TOWER_CRANE_BROKER;
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [CLI, ...argv], { cwd: job.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (e) => resolve({ code: 1, stdout, stderr: `${stderr}tower-crane: broker could not run the command: ${e.message}\n` }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function sameToken(given, token) {
  const a = Buffer.from(typeof given === 'string' ? given : '');
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function answer(job, token, line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return { code: 2, stdout: '', stderr: 'tower-crane: the broker got a request that is not JSON\n' };
  }
  if (!req || !sameToken(req.token, token)) return { code: 1, stdout: '', stderr: 'tower-crane: the broker refused a request without its token\n' };
  let argv;
  try {
    argv = authorize(job, req.argv);
  } catch (e) {
    return { code: e.code || 1, stdout: '', stderr: `tower-crane: ${e.message}\n` };
  }
  return run(job, argv);
}

// Listens for the agent a spawn monitor starts: job is the monitor's job
// (state, task, agent, role, cwd) and job.broker the broker.json path in the
// agent's home. Returns the env the agent runs with and close().
async function start(job) {
  const home = path.dirname(job.broker);
  const token = crypto.randomBytes(32).toString('hex');
  const { socket, dir } = socketPath(home);
  if (!dir && process.platform !== 'win32') fs.rmSync(socket, { force: true });
  const server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    conn.on('data', (d) => {
      if (buf === null) return;
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0 && buf.length <= MAX_REQUEST) return;
      const line = nl < 0 ? '' : buf.slice(0, nl);
      buf = null;
      answer(job, token, line).then((res) => conn.end(`${JSON.stringify(res)}\n`));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  if (process.platform !== 'win32') fs.chmodSync(socket, 0o600);
  const file = job.broker;
  fs.writeFileSync(file, `${JSON.stringify({ socket, token, state: real(job.state), task: job.task, agent: job.agent, role: job.role })}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return {
    env: { TOWER_CRANE_BROKER: file },
    close: () => {
      server.close();
      fs.rmSync(file, { force: true });
      if (process.platform !== 'win32') fs.rmSync(socket, { force: true });
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The agent side: sends the command to the broker when it changes the
// broker's state directory. Another state directory, such as a test
// fixture's, is not the broker's to change, so null leaves the command to
// run here.
async function forward(file, argv, stateDir) {
  let b;
  try {
    b = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw refuse(`cannot read the state broker at ${file} (${e.code || e.message}); it exists while the agent's spawn runs`);
  }
  if (real(stateDir) !== b.state) return null;
  return new Promise((resolve, reject) => {
    const sock = net.connect(b.socket);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ token: b.token, argv })}\n`));
    sock.on('data', (d) => (buf += d));
    sock.on('error', (e) => reject(refuse(`cannot reach the state broker at ${b.socket} (${e.code || e.message}); it runs while the agent's spawn does`)));
    sock.on('end', () => {
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(refuse('the state broker closed without an answer'));
      }
    });
  });
}

module.exports = { ROLES, READS, FILE, start, forward, authorize };
