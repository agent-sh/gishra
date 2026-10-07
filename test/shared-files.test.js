'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT } = require('./helpers');

function fixture(t) {
  const h = makeRepo(t);
  for (const name of ['bin', 'lib', 'scripts', 'docs', 'changelog.d']) {
    fs.cpSync(path.join(ROOT, name), path.join(h.repo, name), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, 'CHANGELOG.md'), path.join(h.repo, 'CHANGELOG.md'));
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'shared file fixture']);
  const base = h.git(['rev-parse', 'HEAD']);
  const script = (name, args = []) => cp.spawnSync(process.execPath,
    [path.join(h.repo, 'scripts', name), ...args],
    { cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 30000 });
  const check = () => script('check-shared-files.js', ['--base', base]);
  const write = (name, text) => fs.writeFileSync(path.join(h.repo, name), text);
  const read = (name) => fs.readFileSync(path.join(h.repo, name), 'utf8');
  const change = () => {
    write('changelog.d/T999.md', '- A separate task change.\n');
  };
  return { h, script, check, write, read, change };
}

test('generated command rows match real CLI help, preserve details and reject drift', (t) => {
  const f = fixture(t);
  assert.equal(f.check().status, 0);
  const bin = path.join(f.h.repo, 'bin', 'tower-crane.js');
  const { COMMANDS } = require(bin);
  const docs = f.read('docs/cli.md');
  for (const command of COMMANDS) {
    const help = cp.spawnSync(process.execPath, [bin, ...command.name.split(' '), '--help'],
      { cwd: f.h.repo, env: f.h.env, encoding: 'utf8', timeout: 30000 });
    assert.equal(help.status, 0, help.stderr);
    const usage = command.name + (command.usage ? ` ${command.usage}` : '');
    assert.ok(help.stdout.startsWith(`usage: tower-crane ${usage}\n`));
    assert.ok(docs.includes(`| \`${usage.replace(/\|/g, '\\|')}\` | ${command.summary.replace(/\|/g, '\\|')} |`));
  }
  f.write('docs/cli.md', docs.replace('| append a note |', '| stale summary |'));
  const drift = f.check();
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /command rows drifted/);
  assert.equal(f.script('cli-docs.js').status, 0);
  assert.equal(f.read('docs/cli.md'), docs);

  f.change();
  f.write('bin/tower-crane.js', f.read('bin/tower-crane.js').replace('append a note', 'append a task note'));
  assert.equal(f.check().status, 1, 'a metadata change requires regeneration');
  assert.equal(f.script('cli-docs.js').status, 0);
  assert.equal(f.check().status, 0);
  assert.ok(f.read('docs/cli.md').includes('| append a task note |'));
  assert.ok(f.read('docs/cli.md').includes('`init`: create the state directory and `project.json` with the default harness and ladder'), 'contract prose is preserved');

  for (const file of ['bin/tower-crane.js', 'docs/cli.md', 'changelog.d/T999.md']) {
    f.write(file, f.read(file).replace(/\r?\n/g, '\r\n'));
  }
  assert.equal(f.check().status, 0, 'Windows line endings do not cause drift');
});

test('the shared file check enforces sorted single-line command entries with space between them', (t) => {
  const f = fixture(t);
  const source = f.read('bin/tower-crane.js');
  const first = source.match(/const COMMANDS = \[\n(  \{[^\n]+\n)\n(  \{[^\n]+\n)/);
  assert.ok(first);
  f.write('bin/tower-crane.js', source.replace(first[0], 'const COMMANDS = [\n' + first[2] + '\n' + first[1]));
  const unsorted = f.check();
  assert.equal(unsorted.status, 1);
  assert.match(unsorted.stderr, /sorted by name/);
  f.write('bin/tower-crane.js', source.replace(first[1], first[1].replace('summary:', '\n    summary:')));
  const multiline = f.check();
  assert.equal(multiline.status, 1);
  assert.match(multiline.stderr, /one entry per line/);
  f.write('bin/tower-crane.js', source.replace(first[0], 'const COMMANDS = [\n' + first[1] + first[2]));
  const adjacent = f.check();
  assert.equal(adjacent.status, 1);
  assert.match(adjacent.stderr, /blank line/);
});

test('tasks add fragments instead of editing the archive or an existing change', (t) => {
  const f = fixture(t);
  f.write('README.md', '# changed\n');
  const missing = f.check();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /every change needs a new/);
  f.change();
  assert.equal(f.check().status, 0, 'unstaged fragments count during local checks');
  f.h.git(['add', 'changelog.d/T999.md']);
  assert.equal(f.check().status, 0, 'tracked fragments count in CI');
  const archive = f.read('CHANGELOG.md');
  f.write('CHANGELOG.md', archive + '- Direct edit.\n');
  const direct = f.check();
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /do not edit CHANGELOG.md/);
  f.write('CHANGELOG.md', archive);
  const original = f.read('changelog.d/T86.md');
  f.write('changelog.d/T86.md', '- Edited another change.\n');
  const edited = f.check();
  assert.equal(edited.status, 1);
  assert.match(edited.stderr, /belongs to its original change/);
  f.write('changelog.d/T86.md', original);
  fs.rmSync(path.join(f.h.repo, 'changelog.d/T86.md'));
  assert.equal(f.check().status, 1, 'existing fragments cannot be deleted');
  f.write('changelog.d/T86.md', original);
  f.write('changelog.d/T999.md', '\n');
  const empty = f.check();
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /nonempty Markdown bullet/);
});

test('release assembly is deterministic and leaves the archive and fragments unchanged', (t) => {
  const f = fixture(t);
  f.change();
  const archive = f.read('CHANGELOG.md');
  const release = f.script('changelog.js');
  assert.equal(release.status, 0, release.stderr);
  const entries = fs.readdirSync(path.join(f.h.repo, 'changelog.d')).filter((name) => name !== 'README.md').sort();
  const expected = '# Changelog\n\n' + [
    ...entries.map((name) => f.read(`changelog.d/${name}`).trim()),
    archive.slice('# Changelog\n'.length).trim(),
  ].join('\n\n') + '\n';
  assert.equal(release.stdout, expected);
  assert.equal(f.script('changelog.js').stdout, expected);
  assert.equal(f.read('CHANGELOG.md'), archive);
  assert.deepEqual(fs.readdirSync(path.join(f.h.repo, 'changelog.d')).filter((name) => name !== 'README.md').sort(), entries);
  assert.equal(f.check().status, 0);
});

test('this repository keeps generated rows and worker fragment instructions current', () => {
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-shared-files.js')],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TOWER_CRANE_CHANGE_BASE: '' }, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'tower-crane-work', 'SKILL.md'), 'utf8');
  assert.match(skill, /add `changelog\.d\/<task-or-pr>\.md`/);
  assert.match(skill, /leave `CHANGELOG\.md` and existing fragments unchanged/);
});
