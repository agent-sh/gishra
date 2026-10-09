'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createRequire } = require('node:module');
const { ROOT, makeRepo, makeProjectRepo, makeTaskRepo, cachedFixture, fixtureLadder } = require('./helpers');

// Harness file names are not model selections.
const harnessNames = new Set(['claude-plugin', 'claude-config', 'claude-error', 'claude-global',
  'claude-only', 'claude-provider', 'claude-provider.js', 'claude-provider.test.js', 'claude-result.json', 'claude-print-result.json', 'claude-scratch-2026-10-06']);
const aliasWords = Object.keys(require('../lib/ladder').BUILTIN.claude_aliases || {})
  .map(alias => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const selections = new RegExp(String.raw`\b(?:claude-[\w.-]+|gpt-[\w.-]+|opus|sonnet|haiku|sol|luna|astra${aliasWords ? '|' + aliasWords : ''})\b`, 'gi');
// These records quote sources or historical probe output, rather than configure runtime models.
const researchDocuments = new Set(['research/T38.json', 'research/T101-probes/results/identity.json',
  'research/T101-probes/results/secrets.json']);
const importSpace = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*`;
const requestLiteral = "(['\"`])([^'\"`]+)\\1";
// Only literal requests are resolved; module bodies are never executed.
const importCall = new RegExp(String.raw`\b(?:require${importSpace}(?:\.${importSpace}resolve${importSpace})?|import${importSpace})\(${importSpace}` + requestLiteral, 'g');
const staticImport = new RegExp(String.raw`\b(?:from|import)${importSpace}` + requestLiteral, 'g');

function documentaryJSON(file, text) {
  if (!researchDocuments.has(file)) return false;
  let data;
  try { data = JSON.parse(text); }
  catch { return false; }
  const strings = (row, keys) => row && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).every(key => keys.includes(key))
    && keys.every(key => typeof row[key] === 'string');
  if (file === 'research/T38.json') {
    return data && Object.keys(data).every(key => ['sources', 'claims'].includes(key))
      && Array.isArray(data.sources) && data.sources.every(row => strings(row, ['id', 'url']))
      && Array.isArray(data.claims) && data.claims.every(row => strings(row, ['claim', 'quote', 'source']));
  }
  return Array.isArray(data) && data.every(row => strings(row, ['id', 'surface', 'command', 'expected', 'observed', 'verdict']));
}

test('cached fixtures pin their ladder and keep copies independent', (t) => {
  const tasks = [{ args: ['--title', 'Cached task', '--acceptance', 'pinned model'], brief: 'cached brief\n' }];
  for (const create of [makeProjectRepo, t => makeTaskRepo(t, tasks),
    t => cachedFixture(t, 'pinned-ladder', h => { h.init(); })]) {
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
  const lint = original.call(this, process.execPath,
    ['--test', '--test-name-pattern=every shipped|model selections live', path.join(options.cwd, 'test', 'model-config.test.js')],
    { cwd: options.cwd, env: options.env, encoding: 'utf8' });
  if (lint.status !== 0) throw new Error('probe model lint failed: ' + lint.stdout + lint.stderr);
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
    const resolve = createRequire(path.resolve(root, file)).resolve;
    for (const match of [...text.matchAll(importCall), ...text.matchAll(staticImport)]) {
      try {
        const imported = resolve(match[2]);
        if (path.extname(imported) === '.json') importedJSON.add(path.relative(root, imported).split(path.sep).join('/'));
      } catch {
        // An unresolved request cannot load a documentary record.
      }
    }
  }
  const violations = [];
  for (const file of new Set(files)) {
    if ((file.startsWith('docs/') && file !== 'docs/cli.md') || file === 'README.md' || file === 'CHANGELOG.md'
      || file.startsWith('changelog.d/') || file === 'test/fixtures/usage/README.md') continue;
    let text = fs.readFileSync(path.join(root, file), 'utf8');
    if (!importedJSON.has(file) && documentaryJSON(file, text)) continue;
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
  fs.writeFileSync(path.join(h.repo, 'test-map.json'), JSON.stringify({ tests: ['test/claude-provider.test.js'] }));
  assert.deepEqual(modelSelections(h.repo, h.env), []);
  const ids = [['claude', 'fixture-2099'].join('-'), ['gpt', 'fixture-2099'].join('-'), ['as', 'tra'].join('')];
  for (const id of ids) {
    fs.writeFileSync(file, `require('../lib/claude-provider.js');\nconst selection = '${id}';\n`);
    assert.deepEqual(modelSelections(h.repo, h.env), [`selection.js:2: ${id}`]);
  }
});

test('model lint rejects every shipped Claude alias in runtime selections', (t) => {
  const h = makeRepo(t);
  const file = path.join(h.repo, 'selection.js');
  for (const alias of Object.keys(require('../lib/ladder').BUILTIN.claude_aliases)) {
    fs.writeFileSync(file, 'module.exports = ' + JSON.stringify({ harness: 'claude', model: alias }) + ';\n');
    assert.deepEqual(modelSelections(h.repo, h.env), [`selection.js:1: ${alias}`]);
  }
});

test('documentary JSON exemptions cannot hide runtime configuration', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'research'));
  const id = ['gpt', 'fixture-2099'].join('-');
  const record = 'research/T38.json';
  fs.writeFileSync(path.join(h.repo, record), JSON.stringify({ model: id }));
  assert.deepEqual(modelSelections(h.repo, h.env), [`${record}:1: ${id}`]);
});

test('model lint scans template CommonJS and static ESM documentary JSON imports', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'research'));
  fs.mkdirSync(path.join(h.repo, 'lib'));
  const id = ['gpt', 'fixture-2099'].join('-');
  const record = 'research/T38.json';
  fs.writeFileSync(path.join(h.repo, record), JSON.stringify({
    sources: [{ id: 'stub', url: 'https://example.invalid' }],
    claims: [{ claim: 'A historical model measurement', quote: id, source: 'stub' }],
  }));
  const request = '../' + record;
  const cjs = path.join(h.repo, 'lib', 'selection.cjs');
  fs.writeFileSync(cjs, 'module.exports = require(`' + request + '`);\n');
  const loaded = cp.execFileSync(process.execPath,
    ['-e', 'process.stdout.write(require(process.argv[1]).claims[0].quote)', cjs], { env: h.env, encoding: 'utf8' });
  assert.equal(loaded, id);
  assert.deepEqual(modelSelections(h.repo, h.env), [`${record}:1: ${id}`]);
  fs.rmSync(cjs);
  const esm = path.join(h.repo, 'lib', 'selection.mjs');
  fs.writeFileSync(esm, 'import data from ' + JSON.stringify(request) +
    ' with { type: "json" };\nprocess.stdout.write(data.claims[0].quote);\n');
  assert.equal(cp.execFileSync(process.execPath, [esm], { env: h.env, encoding: 'utf8' }), id);
  assert.deepEqual(modelSelections(h.repo, h.env), [`${record}:1: ${id}`]);
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
  fs.writeFileSync(path.join(h.repo, 'research', 'package.json'), JSON.stringify({ main: 'T38.json' }));
  for (const request of ['../' + record, '../research/T38', '../research']) {
    const quoted = JSON.stringify(request);
    for (const call of [
      'require(' + quoted + ')',
      'require(' + quoted + ',)',
      'require(' + quoted + ' /* after */)',
      'require(/* before */ ' + quoted + ')',
      'require /* between */ (' + quoted + ')',
      'require(// before\n' + quoted + '\n)',
      'require(' + quoted + '// after\n)',
    ]) {
      fs.writeFileSync(module, 'module.exports = ' + call + ';\n');
      const loaded = cp.execFileSync(process.execPath,
        ['-e', 'process.stdout.write(require(process.argv[1]).claims[0].quote)', module], { env: h.env, encoding: 'utf8' });
      assert.equal(loaded, id, `${call} loads the documentary JSON`);
      assert.deepEqual(modelSelections(h.repo, h.env), [`${record}:1: ${id}`], call);
    }
  }
});

test('model lint follows JavaScript precedence over extensionless documentary JSON', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'research'));
  const id = ['gpt', 'fixture-2099'].join('-');
  fs.writeFileSync(path.join(h.repo, 'research', 'T38.json'), JSON.stringify({
    sources: [{ id: 'stub', url: 'https://example.invalid' }],
    claims: [{ claim: 'A historical model measurement', quote: id, source: 'stub' }],
  }));
  fs.writeFileSync(path.join(h.repo, 'research', 'T38.js'), 'module.exports = "javascript";\n');
  const module = path.join(h.repo, 'selection.js');
  fs.writeFileSync(module, 'module.exports = require(' + JSON.stringify('./research/T38') + ');\n');
  const loaded = cp.execFileSync(process.execPath,
    ['-e', 'process.stdout.write(require(process.argv[1]))', module], { env: h.env, encoding: 'utf8' });
  assert.equal(loaded, 'javascript');
  assert.deepEqual(modelSelections(h.repo, h.env), []);
});

test('model lint scans documentary JSON loaded through a directory index', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'research', 'entry'), { recursive: true });
  const id = ['gpt', 'fixture-2099'].join('-');
  fs.writeFileSync(path.join(h.repo, 'research', 'T38.json'), JSON.stringify({
    sources: [{ id: 'stub', url: 'https://example.invalid' }],
    claims: [{ claim: 'A historical model measurement', quote: id, source: 'stub' }],
  }));
  fs.writeFileSync(path.join(h.repo, 'research', 'entry', 'index.js'),
    'module.exports = require(' + JSON.stringify('../T38') + ');\n');
  const module = path.join(h.repo, 'selection.js');
  fs.writeFileSync(module, 'module.exports = require(' + JSON.stringify('./research/entry') + ');\n');
  const loaded = cp.execFileSync(process.execPath,
    ['-e', 'process.stdout.write(require(process.argv[1]).claims[0].quote)', module], { env: h.env, encoding: 'utf8' });
  assert.equal(loaded, id);
  assert.deepEqual(modelSelections(h.repo, h.env), [`research/T38.json:1: ${id}`]);
});

test('model selections live only in BUILTIN or configuration documentation', () => {
  const violations = modelSelections(ROOT);
  assert.deepEqual(violations, [], `model selections outside configuration:\n${violations.join('\n')}`);
});
