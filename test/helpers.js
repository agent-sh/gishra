'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'gishra.js');
const TMP_ROOT = process.env.GISHRA_TEST_TMP || os.tmpdir();

// Tests must not see the developer's git config (hooks, signing) or an
// agent's GISHRA_* variables, so every child gets a clean, explicit env.
function baseEnv(home) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GISHRA_') || k.startsWith('GIT_')) delete env[k];
  env.GIT_CONFIG_GLOBAL = path.join(home, 'gitconfig');
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

function git(args, cwd, env) {
  return cp.execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo(t) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'gishra-')));
  fs.writeFileSync(
    path.join(base, 'gitconfig'),
    '[user]\n\tname = gishra test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n',
  );
  const env = baseEnv(base);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo, env);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  git(['add', '.'], repo, env);
  git(['commit', '-q', '-m', 'init'], repo, env);
  const ctx = {
    base,
    repo,
    env,
    state: path.join(repo, '.gishra'),
    run: (args, opts = {}) => run(args, { cwd: repo, env, ...opts, env: { ...env, ...(opts.env || {}) } }),
    runAsync: (args, opts = {}) => runAsync(args, { cwd: repo, env, ...opts, env: { ...env, ...(opts.env || {}) } }),
    json: (args, opts) => {
      const r = ctx.run([...args, '--json'], opts);
      if (r.code !== 0) throw new Error(`gishra ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
      return JSON.parse(r.stdout);
    },
    ok: (args, opts) => {
      const r = ctx.run(args, opts);
      if (r.code !== 0) throw new Error(`gishra ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
      return r.stdout.trim();
    },
    readState: (file) => JSON.parse(fs.readFileSync(path.join(ctx.state, file), 'utf8')),
    writeState: (file, data) => fs.writeFileSync(path.join(ctx.state, file), JSON.stringify(data, null, 2) + '\n'),
    git: (args, cwd = repo) => git(args, cwd, env),
    init: (extra = []) => ctx.ok(['init', '--name', 'demo', '--goal', 'prove the engine', ...extra]),
  };
  if (t) t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return ctx;
}

function run(args, { cwd, env, input } = {}) {
  const r = cp.spawnSync(process.execPath, [BIN, ...args], { cwd, env, input, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runAsync(args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [BIN, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const real = (p) => fs.realpathSync.native(p);

module.exports = { makeRepo, run, runAsync, BIN, ROOT, real, TMP_ROOT };
