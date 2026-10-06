'use strict';

// git and gh as a spawned agent finds them on PATH. Each call is checked
// against an allowlist from the agent file: commands that only read, the
// local git writes of a role that writes its worktree, push without force on
// gitPush branch, and the gh writes ghWrite names. Everything else, aliases
// included, is refused, whatever order the options come in.
//
// usage: node shim.js <policy.json> <shim dir> <git|gh> [args...]

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

// git options allowed before the subcommand; -C takes a value.
const GIT_GLOBAL = ['-C', '--no-pager', '-P', '--literal-pathspecs', '--no-optional-locks'];
const GIT_READ = ['status', 'diff', 'log', 'show', 'rev-parse', 'merge-base', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file',
  'rev-list', 'for-each-ref', 'show-ref', 'symbolic-ref', 'blame', 'grep', 'describe', 'shortlog', 'fetch', 'format-patch',
  'range-diff', 'name-rev', 'check-ignore', 'version', 'help'];
const GIT_LOCAL = ['add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'stash', 'merge', 'rebase', 'cherry-pick',
  'revert', 'rm', 'mv', 'apply', 'am', 'pull', 'branch', 'tag', 'worktree', 'clean', 'notes', 'update-index', 'update-ref',
  'gc', 'submodule', 'config', 'remote'];
// Read forms of commands that otherwise write.
const GIT_READ_FORMS = {
  branch: (a) => a.every((x) => ['--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--show-current'].includes(x)),
  remote: (a) => !a.length || ['-v', 'get-url', 'show'].includes(a[0]),
  worktree: (a) => a[0] === 'list',
};
// gh options that take a value; they may come anywhere.
const GH_VALUE = ['-R', '--repo', '--hostname'];

function forced(args) {
  return args.some((a) => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || a === '--force-if-includes'
    || a === '--mirror' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || (a.startsWith('+') && a.length > 1));
}

function gitDenied(args, policy) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (!GIT_GLOBAL.includes(args[i])) return `git ${args[i]}`;
    i += args[i] === '-C' ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined || GIT_READ.includes(sub)) return null;
  if (GIT_READ_FORMS[sub] && GIT_READ_FORMS[sub](rest)) return null;
  if (sub === 'push') {
    if (policy.gitPush !== 'branch') return 'git push';
    return forced(rest) ? 'git push --force' : null;
  }
  if (policy.gitLocal && GIT_LOCAL.includes(sub)) return null;
  return `git ${sub}`;
}

function ghDenied(args, policy) {
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (GH_VALUE.includes(a)) i++;
      continue;
    }
    words.push(a);
  }
  if (!words.length) return null;
  const ok = policy.gh.some((c) => c.split(' ').every((w, n) => words[n] === w));
  return ok ? null : `gh ${words.slice(0, 2).join(' ')}`;
}

function findReal(tool, skip) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (!dir || path.resolve(dir) === path.resolve(skip)) continue;
    for (const ext of exts) {
      const f = path.join(dir, tool + ext);
      try {
        if (fs.statSync(f).isFile()) {
          if (process.platform !== 'win32') fs.accessSync(f, fs.constants.X_OK);
          return f;
        }
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

function main() {
  const [policyFile, shimDir, tool, ...args] = process.argv.slice(2);
  const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  const why = tool === 'git' ? gitDenied(args, policy) : ghDenied(args, policy);
  if (why) {
    process.stderr.write(`tower-crane: ${why} is not allowed by this agent's agent file\n`);
    return 126;
  }
  const real = findReal(tool, shimDir);
  if (!real) {
    process.stderr.write(`tower-crane: ${tool} is not installed\n`);
    return 127;
  }
  const r = cp.spawnSync(real, args, { stdio: 'inherit', shell: /\.(cmd|bat)$/i.test(real) });
  if (r.error) {
    process.stderr.write(`tower-crane: cannot run ${real} (${r.error.message})\n`);
    return 127;
  }
  return r.status === null ? 1 : r.status;
}

if (require.main === module) process.exit(main());

module.exports = { gitDenied, ghDenied };
