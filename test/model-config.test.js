'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { ROOT, makeRepo, makeProjectRepo, makeTaskRepo, fixtureLadder } = require('./helpers');

// Harness file names are not model selections.
const harnessNames = new Set(['claude-plugin', 'claude-config', 'claude-error', 'claude-global',
  'claude-only', 'claude-provider', 'claude-provider.js', 'claude-result.json', 'claude-print-result.json', 'claude-scratch-2026-10-06']);
const selections = /\b(?:claude-[\w.-]+|gpt-[\w.-]+|opus|sonnet|haiku|sol|luna|astra)\b/gi;
// These records quote sources or historical probe output, rather than configure runtime models.
const researchDocuments = new Set(['research/T38.json', 'research/T101-probes/results/identity.json',
  'research/T101-probes/results/secrets.json']);

test('cached project and task fixtures pin their ladder and keep copies independent', (t) => {
  const tasks = [{ args: ['--title', 'Cached task', '--acceptance', 'pinned model'], brief: 'cached brief\n' }];
  for (const create of [makeProjectRepo, t => makeTaskRepo(t, tasks)]) {
    const first = create(t);
    const second = create(t);
    const pinned = fixtureLadder();
    for (const h of [first, second]) {
      const project = h.readState('project.json');
      assert.deepEqual({ harness: project.harness, ladder: project.ladder }, pinned);
      assert.equal(fs.existsSync(h.userConfig), false);
    }
    first.ok(['ladder', 'set', 'easy', '--model', 'copy-only-model', '--clear', 'profile']);
    assert.deepEqual(second.readState('project.json').ladder, pinned.ladder);
  }
});

test('model swap probe has Git history and validates the same open log when its path is replaced', (t) => {
  const h = makeRepo(t);
  const cache = path.join(h.base, 'probe-cache');
  const hook = path.join(h.base, 'probe-hook.cjs');
  fs.writeFileSync(hook, `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const original = cp.spawnSync;
cp.spawnSync = function (command, args, options) {
  if (command !== process.execPath || args[0] !== '--test') return original.call(this, command, args, options);
  const check = original.call(this, process.execPath, [path.join(options.cwd, 'scripts', 'check-shared-files.js')],
    { cwd: options.cwd, env: options.env, encoding: 'utf8' });
  if (check.status !== 0) throw new Error('probe shared-files check failed: ' + check.stderr);
  fs.writeSync(options.stdio[1], 'not ok 1 - BUILTIN matches the documented defaults and init fallback\\n# tests 1\\n# fail 1\\n');
  const log = path.join(options.env.TOWER_CRANE_TEST_TMP, 'model-swap-probe.tap');
  fs.renameSync(log, log + '.replaced');
  fs.writeFileSync(log, 'not ok 1 - replaced log\\n');
  return { status: 1 };
};
`);
  const result = cp.spawnSync(process.execPath, ['--require', hook, path.join(ROOT, 'scripts', 'probe-model-swap.js')],
    { cwd: ROOT, env: { ...h.env, TOWER_CRANE_TEST_TMP: cache }, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Model swap probe passed/);
  assert.equal(fs.readFileSync(path.join(cache, 'model-swap-probe.tap'), 'utf8'), 'not ok 1 - replaced log\n');
});

function modelSelections(root, env = process.env) {
  const files = cp.execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, env, encoding: 'utf8' }).split('\0').filter(Boolean);
  const importedJSON = new Set();
  for (const file of new Set(files)) {
    if (!/\.(?:cjs|mjs|js)$/.test(file)) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of text.matchAll(/\brequire(?:\.resolve)?\(\s*(['"])([^'"]+\.json)\1\s*\)/g)) {
      if (!match[2].startsWith('.') && !path.isAbsolute(match[2])) continue;
      const imported = path.resolve(root, path.dirname(file), match[2]);
      importedJSON.add(path.relative(root, imported).split(path.sep).join('/'));
    }
  }
  const violations = [];
  for (const file of new Set(files)) {
    if (researchDocuments.has(file) && !importedJSON.has(file)) continue;
    if ((file.startsWith('docs/') && file !== 'docs/cli.md') || file === 'README.md' || file === 'CHANGELOG.md'
      || file.startsWith('changelog.d/') || file === 'test/fixtures/usage/README.md') continue;
    let text = fs.readFileSync(path.join(root, file), 'utf8');
    if (file === 'docs/cli.md') {
      // API JSON examples use fixture selections; configuration prose keeps real IDs.
      let json = false;
      text = text.split('\n').map(line => {
        if (line.startsWith('```')) { json = line.trimEnd() === '```json'; return ''; }
        return json ? line : '';
      }).join('\n');
    }
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
  return violations;
}

test('model lint allows harness module paths and rejects model selections', (t) => {
  const h = makeRepo(t);
  const file = path.join(h.repo, 'selection.js');
  fs.writeFileSync(file, "require('../lib/claude-provider.js');\n");
  assert.deepEqual(modelSelections(h.repo, h.env), []);
  const ids = [['claude', 'fixture-2099'].join('-'), ['gpt', 'fixture-2099'].join('-'), ['as', 'tra'].join('')];
  for (const id of ids) {
    fs.writeFileSync(file, `require('../lib/claude-provider.js');\nconst selection = '${id}';\n`);
    assert.deepEqual(modelSelections(h.repo, h.env), [`selection.js:2: ${id}`]);
  }
});

test('model lint scans research JSON and imported documentary records', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'research'));
  fs.mkdirSync(path.join(h.repo, 'lib'));
  const id = ['gpt', 'fixture-2099'].join('-');
  const profile = ['so', 'l'].join('');
  const runtime = 'research/runtime.json';
  const module = path.join(h.repo, 'lib', 'selection.js');
  fs.writeFileSync(path.join(h.repo, runtime), JSON.stringify({ model: id, profile }));
  assert.deepEqual(modelSelections(h.repo, h.env), [`${runtime}:1: ${id}`, `${runtime}:1: ${profile}`]);
  fs.writeFileSync(module, 'module.exports = require(' + JSON.stringify('../' + runtime) + ');\n');
  assert.deepEqual(modelSelections(h.repo, h.env), [`${runtime}:1: ${id}`, `${runtime}:1: ${profile}`]);
  fs.rmSync(path.join(h.repo, runtime));
  fs.rmSync(module);
  const record = 'research/T38.json';
  fs.writeFileSync(path.join(h.repo, record), JSON.stringify({
    sources: [{ id: 'stub', url: 'https://example.invalid' }],
    claims: [{ claim: 'A historical model measurement', quote: id, source: 'stub' }],
  }));
  assert.deepEqual(modelSelections(h.repo, h.env), []);
  fs.writeFileSync(module, 'module.exports = require(' + JSON.stringify('../' + record) + ');\n');
  assert.deepEqual(modelSelections(h.repo, h.env), [`${record}:1: ${id}`]);
});

test('model selections live only in BUILTIN or configuration documentation', () => {
  const violations = modelSelections(ROOT);
  assert.deepEqual(violations, [], `model selections outside configuration:\n${violations.join('\n')}`);
});
