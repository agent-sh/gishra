'use strict';

const cp = require('node:child_process');
const path = require('node:path');
const { refuse } = require('./util');

let mutations = 0;

function assertUnlocked(command) {
  if (mutations && /^(git|gh)(?:\.exe|\.cmd|\.bat)?$/i.test(path.basename(command))) {
    const e = refuse(`${command} cannot run inside a state mutation; prepare commands outside the lock and compare before applying`);
    e.lockedCommand = true;
    throw e;
  }
}

function mutation(fn) {
  mutations++;
  try { return fn(); }
  finally { mutations--; }
}

// A sandboxed worker may write the repository's git directory (writeOutside:
// git), and git runs commands its config and hooks name. Git started here runs
// outside every sandbox, so it takes those settings only from the system,
// global and command scopes, which no worker writes. Git that gh starts here
// gets the same. Command-scope entries (GIT_CONFIG_COUNT) come last, so they
// win over the repository's.
// Single-valued keys get the trusted value or a default that runs nothing of
// the repository's.
const FIXED = {
  'core.fsmonitor': 'false',
  'core.sshcommand': 'ssh',
  'core.askpass': '',
  'core.gitproxy': '',
  'core.alternaterefscommand': '',
  'diff.external': '',
  'remote.origin.uploadpack': 'git-upload-pack',
  'remote.origin.receivepack': 'git-receive-pack',
  'protocol.ext.allow': 'never',
  'fetch.recursesubmodules': 'false',
  'submodule.recurse': 'false',
};
// Keys named per driver, URL or remote: each one the repository sets gets
// the trusted value back, or is emptied, which makes git refuse to run it.
const NAMED = /^(filter\..+\.(clean|smudge|process)|diff\..+\.(command|textconv)|merge\..+\.driver|remote\..+\.(uploadpack|receivepack)|gpg(\..+)?\.program)$/;
const CREDENTIAL = /^credential\.(.+\.)?helper$/;
const TRUSTED = new Set(['system', 'global', 'command']);

// The directory git will run in: opts.cwd, then each leading -C.
function gitDir(args, opts) {
  let dir = opts?.cwd || process.cwd();
  for (let i = 0; i < args.length && String(args[i]).startsWith('-'); i++) {
    if (args[i] === '-C') dir = path.resolve(dir, String(args[++i]));
    else if (args[i] === '-c') i++;
  }
  return dir;
}

function configEntries(dir, env) {
  const r = cp.spawnSync('git', ['config', '--list', '--show-scope', '-z'], {
    cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 60000 });
  const fields = String(r.stdout || '').split('\0');
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const nl = fields[i + 1].indexOf('\n');
    const key = nl < 0 ? fields[i + 1] : fields[i + 1].slice(0, nl);
    out.push({ scope: fields[i], key, value: nl < 0 ? '' : fields[i + 1].slice(nl + 1) });
  }
  return out;
}

// The environment for git run by Tower Crane in `dir`. Hooks come only from
// a trusted absolute core.hooksPath, otherwise the null device, so the
// repository's hooks directory is never read. The credential helper list is
// cleared, then refilled with the trusted helpers in their order.
function gitEnv(dir, base = process.env) {
  const env = { ...base };
  const entries = configEntries(dir, env);
  // A relative hooks path resolves inside the checkout, which the worker writes.
  const hooks = entries.filter((e) => e.key === 'core.hookspath' && TRUSTED.has(e.scope)).pop()?.value;
  const pairs = [['core.hookspath', hooks && (path.isAbsolute(hooks) || hooks.startsWith('~/')) ? hooks : require('node:os').devNull]];
  for (const [key, fallback] of Object.entries(FIXED)) {
    const trusted = entries.filter((e) => e.key === key && TRUSTED.has(e.scope)).pop();
    pairs.push([key, trusted ? trusted.value : fallback]);
  }
  const untrusted = new Set(entries.filter((e) => !TRUSTED.has(e.scope) && NAMED.test(e.key) && !(e.key in FIXED)).map((e) => e.key));
  for (const key of untrusted) {
    const trusted = entries.filter((e) => e.key === key && TRUSTED.has(e.scope)).pop();
    pairs.push([key, trusted ? trusted.value : '']);
    if (!trusted && key.startsWith('filter.')) pairs.push([key.replace(/\.[^.]+$/, '.required'), 'false']);
  }
  pairs.push(['credential.helper', '']);
  for (const e of entries) if (TRUSTED.has(e.scope) && CREDENTIAL.test(e.key)) pairs.push([e.key, e.value]);
  let n = Number.parseInt(env.GIT_CONFIG_COUNT, 10) || 0;
  for (const [key, value] of pairs) {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

// Only the bare names: the shims run the worker's own git and gh by path.
// gh runs git itself (gh stack sync rebases and pushes), and that git
// inherits the same environment.
function withGitEnv(command, rest) {
  if (command !== 'git' && command !== 'gh') return rest;
  const next = Array.isArray(rest[0]) ? [...rest] : [[], ...rest];
  const opts = next[1] && typeof next[1] === 'object' ? next[1] : null;
  const dir = command === 'git' ? gitDir(next[0], opts) : opts?.cwd || process.cwd();
  const merged = { ...opts, env: gitEnv(dir, opts?.env || process.env) };
  next.splice(1, opts ? 1 : 0, merged);
  return next;
}

function runner(method) {
  return (command, ...args) => {
    assertUnlocked(command);
    return cp[method](command, ...withGitEnv(command, args));
  };
}

module.exports = { assertUnlocked, mutation,
  execFileSync: runner('execFileSync'), execFile: runner('execFile'),
  spawnSync: runner('spawnSync'), spawn: runner('spawn') };
