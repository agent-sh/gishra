'use strict';

// git and gh as a spawned agent finds them on PATH: the call is checked
// against the agent file's gitPush and ghWrite, whatever order the options
// come in, then handed to the real program. Harness permission rules match a
// command by its prefix, so `git push origin HEAD --force` or
// `gh --repo o/r pr merge 1` would slip past them.
//
// usage: node shim.js <policy.json> <shim dir> <git|gh> [args...]

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

// git options that take their value as the next argument.
const GIT_VALUE = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path'];
const GIT_BUILTIN = new Set(('add am apply bisect blame branch bundle cat-file checkout cherry-pick clean clone commit config describe diff '
  + 'fetch for-each-ref format-patch fsck gc grep help init log ls-files ls-remote ls-tree merge merge-base mv notes pull push rebase '
  + 'reflog remote reset restore rev-list rev-parse revert rm shortlog show show-ref stash status submodule switch symbolic-ref tag '
  + 'update-index update-ref version worktree').split(' '));
// gh options that take their value as the next argument.
const GH_VALUE = ['-R', '--repo', '--hostname'];

function forced(args) {
  return args.some((a) => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || a === '--force-if-includes'
    || a === '--mirror' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || (a.startsWith('+') && a.length > 1));
}

function gitDenied(args, policy, real) {
  let i = 0;
  const config = [];
  while (i < args.length && args[i].startsWith('-')) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (GIT_VALUE.includes(flag) && inline === undefined) {
      if (flag === '-c') config.push(args[i + 1] || '');
      i += 2;
    } else {
      if (flag === '-c') config.push(inline);
      i++;
    }
  }
  let sub = args[i];
  let rest = args.slice(i + 1);
  if (sub && !GIT_BUILTIN.has(sub)) {
    // An alias can stand for push; expand it the way git would.
    const given = config.map((c) => c.split(/=(.*)/s)).find(([k]) => k.toLowerCase() === `alias.${sub.toLowerCase()}`);
    let alias = given ? given[1] : null;
    if (alias === null) {
      const r = cp.spawnSync(real, [...args.slice(0, i), 'config', '--get', `alias.${sub}`], { encoding: 'utf8' });
      alias = r.status === 0 ? r.stdout.trim() : null;
    }
    if (alias !== null) {
      if (alias.startsWith('!')) {
        if (/\bpush\b/.test(alias) && (policy.gitPush === 'none' || forced(alias.split(/\s+/)))) return `git ${sub} (an alias that pushes)`;
        return null;
      }
      const words = alias.split(/\s+/).filter(Boolean);
      [sub, rest] = [words[0], [...words.slice(1), ...rest]];
    }
  }
  if (sub !== 'push') return null;
  if (policy.gitPush === 'none') return 'git push';
  if (forced(rest)) return 'git push --force';
  return null;
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
  const hit = policy.ghDeny.find((d) => d.split(' ').every((w, n) => words[n] === w));
  return hit ? `gh ${hit}` : null;
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
  const real = findReal(tool, shimDir);
  if (!real) {
    process.stderr.write(`tower-crane: ${tool} is not installed\n`);
    return 127;
  }
  const why = tool === 'git' ? gitDenied(args, policy, real) : ghDenied(args, policy);
  if (why) {
    process.stderr.write(`tower-crane: ${why} is denied by this agent's agent file\n`);
    return 126;
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
