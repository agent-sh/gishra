'use strict';

const cp = require('node:child_process');
const path = require('node:path');
const { check } = require('./cli-docs');
const { fragments } = require('./changelog');
const { normalizeText } = require('./text');

// Claude's sandbox masks these names in every worktree, tracked or not, and
// git cannot write a masked path inside it: a merge that adds or changes a
// tracked one fails there (T155). Matched at any depth, in any letter case,
// as the sandbox matches them. The list is Claude Code 2.1.295's.
const MASKED_FILES = ['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json'];
const MASKED_DIRS = ['.vscode', '.idea', '.claude/commands', '.claude/agents'];

function maskedPaths(files) {
  return files.filter((file) => {
    const parts = file.toLowerCase().split('/');
    if (MASKED_FILES.includes(parts.at(-1))) return true;
    return MASKED_DIRS.some((dir) => {
      const names = dir.split('/');
      return parts.some((_, i) => i + names.length < parts.length && names.every((name, j) => parts[i + j] === name));
    });
  });
}

function checkMasked(root) {
  const files = cp.execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', timeout: 30000 }).split('\0').filter(Boolean);
  const masked = maskedPaths(files);
  if (masked.length) throw new Error(`tracked paths the Claude sandbox masks: ${masked.join(', ')}; git cannot write them in a worker worktree, so keep them untracked`);
}

function checkChanges(root, base) {
  const git = (args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000 });
  const sha = normalizeText(git(['rev-parse', '--verify', `${base}^{commit}`])).trim();
  const fields = git(['diff', '--name-status', '--no-renames', '-z', sha, '--']).split('\0');
  fields.pop();
  for (const file of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    fields.push('A', file);
  }
  let added = 0;
  let changed = 0;
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i];
    const file = fields[i + 1].replace(/\\/g, '/');
    changed++;
    if (file === 'CHANGELOG.md') throw new Error('do not edit CHANGELOG.md; add changelog.d/<task-or-pr>.md');
    if (file.startsWith('changelog.d/') && file !== 'changelog.d/README.md') {
      if (status !== 'A') throw new Error(`${file} belongs to its original change; add a new fragment`);
      added++;
    }
  }
  if (changed && !added) throw new Error('every change needs a new changelog.d/<task-or-pr>.md fragment');
}

function main(args) {
  let root = path.join(__dirname, '..');
  let base = process.env.TOWER_CRANE_CHANGE_BASE;
  for (let i = 0; i < args.length; i++) {
    if (!['--root', '--base'].includes(args[i]) || !args[i + 1]) {
      throw new Error('usage: node scripts/check-shared-files.js [--root DIR] [--base SHA]');
    }
    if (args[i] === '--root') root = path.resolve(args[++i]);
    else base = args[++i];
  }
  check(root);
  fragments(root);
  checkMasked(root);
  if (base && !/^0+$/.test(base)) checkChanges(root, base);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkChanges, maskedPaths };
