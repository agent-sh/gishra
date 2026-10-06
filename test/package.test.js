'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT } = require('./helpers');

test('the npm package ships the plugin and loads pi skills through its CLI', (t) => {
  const h = makeRepo(t);
  const args = ['pack', '--dry-run', '--json', '--cache', path.join(h.base, 'npm-cache')];
  const packed = cp.spawnSync(process.env.npm_execpath ? process.execPath : 'npm',
    process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args,
    { cwd: ROOT, env: h.env, encoding: 'utf8', timeout: 60000, shell: !process.env.npm_execpath && process.platform === 'win32' });
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map((file) => file.path);
  for (const file of [
    'commands/README.txt',
    'skills/gishra/SKILL.md',
    'skills/gishra-work/SKILL.md',
    'skills/gishra-review/SKILL.md',
    'agents/gishra-worker.md',
    'agents/gishra-reviewer.md',
    'standards/default.md',
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    'components.json',
  ]) assert.ok(files.includes(file), `npm package is missing ${file}`);
  assert.ok(!files.includes('commands/gishra.md'), 'the skill must be the only gishra entry point');
  const components = JSON.parse(fs.readFileSync(path.join(ROOT, 'components.json'), 'utf8'));
  for (const [type, names] of Object.entries(components)) {
    for (const name of names) {
      const file = type === 'skills' ? `skills/${name}/SKILL.md` : `${type}/${name}.md`;
      assert.ok(files.includes(file), `registered component is missing from the package: ${file}`);
    }
  }

  const installed = path.join(h.base, 'installed');
  for (const file of files) {
    const dest = path.join(installed, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), dest);
  }
  const cli = (args) => {
    const r = cp.spawnSync(process.execPath, [path.join(installed, 'bin/gishra.js'), ...args],
      { cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  cli(['init', '--name', 'packaged', '--goal', 'load shipped skills']);
  cli(['task', 'add', '--title', 'Packaged task', '--acceptance', 'skills load']);
  cli(['brief', 'set', 'T1', '--file', path.join(installed, 'skills/gishra-work/SKILL.md')]);
  for (const [role, skill] of [['worker', 'gishra-work'], ['reviewer', 'gishra-review']]) {
    cli(['role', 'set', role, '--harness', 'pi']);
    const out = JSON.parse(cli(['spawn', '--role', role, '--task', 'T1', '--dry-run', '--json']));
    assert.equal(out.argv[out.argv.indexOf('--skill') + 1], path.join(installed, 'skills', skill));
  }
});
