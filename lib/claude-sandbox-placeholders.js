'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { refuse } = require('./util');

const FILES = Object.freeze([
  '.bash_profile', '.bashrc', '.gitconfig',
  '.claude/agents', '.claude/commands', '.claude/hooks',
  '.claude/launch.json', '.claude/loop.md', '.claude/output-styles',
]);
const IGNORE_PATTERNS = Object.freeze(FILES.map((file) => file.includes('/') ? file : `/${file}`));

function ignorePatterns(existedBefore) {
  const existing = new Set(existedBefore);
  return FILES.flatMap((file, index) => existing.has(file) ? [] : [IGNORE_PATTERNS[index]]);
}

function present(cwd) {
  return FILES.filter((relative) => {
    try {
      fs.lstatSync(path.join(cwd, relative));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      return true;
    }
  });
}

function gitEnvironment(excludeFile, env) {
  const countKey = Object.keys(env).find((key) => key.toUpperCase() === 'GIT_CONFIG_COUNT');
  const raw = countKey ? env[countKey] : '0';
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw))) {
    throw refuse('GIT_CONFIG_COUNT must be a nonnegative integer for Claude sandbox exclusions');
  }
  const index = Number(raw);
  return {
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: 'core.excludesFile',
    [`GIT_CONFIG_VALUE_${index}`]: excludeFile,
  };
}

function remove(cwd, existedBefore) {
  const preserve = new Set(existedBefore);
  const removed = [];
  const failures = [];
  for (const relative of FILES) {
    if (preserve.has(relative)) continue;
    const file = path.join(cwd, relative);
    try {
      const before = fs.lstatSync(file);
      if (!before.isFile() || before.size !== 0 || before.nlink !== 1 || (before.mode & 0o222) !== 0) continue;

      fs.chmodSync(file, (before.mode & 0o777) | 0o200);
      const after = fs.lstatSync(file);
      if (!after.isFile() || after.size !== 0 || before.dev !== after.dev || before.ino !== after.ino) continue;
      fs.unlinkSync(file);
      removed.push(relative);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') failures.push({ relative, error });
    }
  }
  return { removed, failures };
}

module.exports = { FILES, IGNORE_PATTERNS, ignorePatterns, present, gitEnvironment, remove };
