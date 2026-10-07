'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { ROOT } = require('./helpers');

// Harness file names are not model selections.
const harnessNames = new Set(['claude-plugin', 'claude-config', 'claude-error', 'claude-global',
  'claude-only', 'claude-result.json', 'claude-print-result.json', 'claude-scratch-2026-10-06']);
const selections = /\b(?:claude-[\w.-]+|gpt-[\w.-]+|opus|sonnet|haiku|sol|luna|astra)\b/gi;

test('model selections live only in BUILTIN or configuration documentation', () => {
  const files = cp.execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const violations = [];
  for (const file of new Set(files)) {
    if (file.startsWith('docs/') || file === 'README.md' || file === 'CHANGELOG.md'
      || file.startsWith('changelog.d/') || file === 'test/fixtures/usage/README.md') continue;
    let text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (file === 'lib/ladder.js') {
      text = text.replace(/const BUILTIN = \{[\s\S]*?\n\};/, block => block.replace(/[^\n]/g, ' '));
    }
    // The lint's vocabulary names the selections it rejects.
    if (file === 'test/model-config.test.js') text = text.replace(/^const selections = .*$/m, '');
    for (const match of text.matchAll(selections)) {
      if (harnessNames.has(match[0].toLowerCase())) continue;
      const line = text.slice(0, match.index).split('\n').length;
      violations.push(`${file}:${line}: ${match[0]}`);
    }
  }
  assert.deepEqual(violations, [], `model selections outside configuration:\n${violations.join('\n')}`);
});
