'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

test('project set stores, replaces and clears test paths and ignored CI apps', (t) => {
  const h = makeRepo(t);
  h.init();
  const original = h.json(['project', 'show']);
  const paths = ['checks/**/*.chk.js', '**/*Test.java'];
  const apps = ['claude', 'cursor'];
  const set = h.json(['project', 'set', '--tests-paths', JSON.stringify(paths), '--ci-ignore-apps', JSON.stringify(apps)]);
  assert.deepEqual(set, { ...original, tests: { paths }, ci: { ignore_apps: apps } });
  assert.deepEqual(h.json(['project', 'show']), set);
  assert.deepEqual(h.readState('project.json'), set);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).cmd, 'project set');
  assert.equal(events.at(-1).agent, 'owner');
  assert.deepEqual(events.at(-1).detail, { 'tests-paths': JSON.stringify(paths), 'ci-ignore-apps': JSON.stringify(apps) });

  const replaced = h.json(['project', 'set', '--tests-paths', '["qa/"]']);
  assert.deepEqual(replaced.tests, { paths: ['qa/'] });
  assert.deepEqual(replaced.ci, set.ci);
  const renamed = h.json(['project', 'set', '--name', 'renamed']);
  assert.deepEqual(renamed.tests, replaced.tests);
  assert.deepEqual(renamed.ci, replaced.ci);

  const noIgnores = h.json(['project', 'set', '--ci-ignore-apps', '[]']);
  assert.deepEqual(noIgnores.ci, { ignore_apps: [] });
  assert.deepEqual(noIgnores.tests, replaced.tests);
  const defaultTests = h.json(['project', 'set', '--tests-paths', 'null']);
  assert.ok(!Object.hasOwn(defaultTests, 'tests'));
  assert.deepEqual(defaultTests.ci, noIgnores.ci);
  const cleared = h.json(['project', 'set', '--ci-ignore-apps', 'null']);
  assert.deepEqual(cleared, { ...original, name: 'renamed' });
  assert.deepEqual(h.json(['project', 'set', '--tests-paths', 'null', '--ci-ignore-apps', 'null']), cleared);
});

for (const flag of ['--tests-paths', '--tests-keep', '--ci-ignore-apps']) {
  test(`project set validates ${flag} and writes nothing on invalid input`, (t) => {
    const h = makeRepo(t);
    h.init();
    const files = ['project.json', 'tasks.json', 'decisions.json', 'events.jsonl', 'sketch.md', 'sketch.html'];
    const snapshot = () => files.map((f) => fs.readFileSync(path.join(h.state, f), 'utf8'));
    const before = snapshot();
    const invalid = ['[', '{}', '"test/**"', '1', 'true', '[null]', '[1]', '[""]', '[" \\t"]', '["valid", false]'];
    if (flag === '--tests-paths') invalid.push('[]');
    for (const value of invalid) {
      const r = h.run(['project', 'set', '--name', 'must not persist', flag, value]);
      assert.equal(r.code, 2, `${value}: ${r.stderr}`);
      assert.ok(r.stderr.includes(flag), r.stderr);
      assert.match(r.stderr, /JSON array of non-blank strings or null/);
      assert.deepEqual(snapshot(), before, `${value}: no state, events or sketch changes`);
    }

    const r = h.run(['project', 'set', '--tests-paths', '["qa/"]', '--ci-ignore-apps', '[false]']);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /--ci-ignore-apps.*JSON array of non-blank strings or null/);
    assert.deepEqual(snapshot(), before, 'an invalid second field refuses both settings');
  });
}

test('init accepts and validates test paths and ignored CI apps as shared settings', (t) => {
  const h = makeRepo(t);
  const bad = h.run(['init', '--name', 'demo', '--goal', 'prove the engine', '--tests-paths', '[]']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--tests-paths.*non-empty JSON array/);
  for (const f of ['project.json', 'tasks.json', 'decisions.json', 'events.jsonl']) {
    assert.ok(!fs.existsSync(path.join(h.state, f)), `${f} not written`);
  }
  h.init(['--tests-paths', '["qa/"]', '--ci-ignore-apps', '["claude"]']);
  const project = h.json(['project', 'show']);
  assert.deepEqual(project.tests, { paths: ['qa/'] });
  assert.deepEqual(project.ci, { ignore_apps: ['claude'] });

  const defaults = makeRepo(t);
  defaults.init(['--tests-paths', 'null', '--ci-ignore-apps', 'null']);
  const cleared = defaults.json(['project', 'show']);
  assert.ok(!Object.hasOwn(cleared, 'tests'));
  assert.ok(!Object.hasOwn(cleared, 'ci'));
});

test('project set and init help document the JSON settings and clearing value', (t) => {
  const h = makeRepo(t);
  for (const command of [['project', 'set'], ['init']]) {
    const help = h.ok([...command, '--help']);
    assert.match(help, /--tests-paths JSON.*null/);
    assert.match(help, /--tests-keep JSON.*null/);
    assert.match(help, /--ci-ignore-apps JSON.*null/);
  }
});

test('tests.keep is configured through init and project set without replacing tests.paths', (t) => {
  const h = makeRepo(t);
  h.init(['--tests-paths', '["qa/"]', '--tests-keep', '[" Makefile ", " tools/**/*.gradle "]']);
  assert.deepEqual(h.json(['project', 'show']).tests, { paths: ['qa/'], keep: ['Makefile', 'tools/**/*.gradle'] });
  assert.match(h.ok(['project', 'show']), /tests\.keep: \["Makefile","tools\/\*\*\/\*\.gradle"\]/);
  const set = h.json(['project', 'set', '--tests-keep', '["setup.py"]']);
  assert.deepEqual(set.tests, { paths: ['qa/'], keep: ['setup.py'] });
  assert.deepEqual(h.readState('project.json').tests, set.tests);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.at(-1).detail, { 'tests-keep': '["setup.py"]' });
  assert.deepEqual(h.json(['project', 'set', '--tests-paths', 'null']).tests, { keep: ['setup.py'] });
  assert.deepEqual(h.json(['project', 'set', '--tests-keep', '[]']).tests, { keep: [] });
  assert.ok(!Object.hasOwn(h.json(['project', 'set', '--tests-keep', 'null']), 'tests'));
  assert.match(h.ok(['project', 'show']), /tests\.keep: \[\]/);
});

test('project set and init trim padded test paths and ignored CI apps', (t) => {
  const h = makeRepo(t);
  h.init(['--tests-paths', '[" qa/\\t"]', '--ci-ignore-apps', '[" claude "]']);
  const initial = h.json(['project', 'show']);
  assert.deepEqual(initial.tests, { paths: ['qa/'] });
  assert.deepEqual(initial.ci, { ignore_apps: ['claude'] });

  const set = h.json(['project', 'set', '--tests-paths', '[" checks/**/*.js ", "\\t**/*Test.java\\n"]', '--ci-ignore-apps', '[" claude ", "\\tcursor\\n"]']);
  assert.deepEqual(set.tests, { paths: ['checks/**/*.js', '**/*Test.java'] });
  assert.deepEqual(set.ci, { ignore_apps: ['claude', 'cursor'] });
  assert.deepEqual(h.readState('project.json'), set);
});

test('project set replaces and clears non-object list sections while preserving object siblings', (t) => {
  const h = makeRepo(t);
  h.init();
  const original = h.readState('project.json');
  for (const section of ['broken', ['broken'], true, 42, null]) {
    h.writeState('project.json', { ...original, tests: section, ci: section });
    const set = h.json(['project', 'set', '--tests-paths', '["qa/"]', '--ci-ignore-apps', '["claude"]']);
    assert.deepEqual(set, { ...original, tests: { paths: ['qa/'] }, ci: { ignore_apps: ['claude'] } });

    h.writeState('project.json', { ...original, tests: section, ci: section });
    const cleared = h.json(['project', 'set', '--tests-paths', 'null', '--ci-ignore-apps', 'null']);
    assert.deepEqual(cleared, original);
  }

  h.writeState('project.json', { ...original, tests: { extra: 'keep', paths: ['old/'] }, ci: { extra: 'keep', ignore_apps: ['old'] } });
  const set = h.json(['project', 'set', '--tests-paths', '["qa/"]', '--ci-ignore-apps', '["claude"]']);
  assert.deepEqual(set.tests, { extra: 'keep', paths: ['qa/'] });
  assert.deepEqual(set.ci, { extra: 'keep', ignore_apps: ['claude'] });
  const cleared = h.json(['project', 'set', '--tests-paths', 'null', '--ci-ignore-apps', 'null']);
  assert.deepEqual(cleared.tests, { extra: 'keep' });
  assert.deepEqual(cleared.ci, { extra: 'keep' });
});

test('project set and show text print configured lists and their defaults alongside the ladder', (t) => {
  const h = makeRepo(t);
  h.init();
  const defaults = h.ok(['project', 'show']);
  assert.match(defaults, /tests\.paths: default layouts/);
  assert.match(defaults, /ci\.ignore_apps: \[\]/);
  assert.match(defaults, /ladder \(default harness /);

  const set = h.ok(['project', 'set', '--tests-paths', '["qa/"]', '--ci-ignore-apps', '["claude","cursor"]']);
  assert.match(set, /tests\.paths: \["qa\/"\]/);
  assert.match(set, /ci\.ignore_apps: \["claude","cursor"\]/);
  assert.equal(h.ok(['project', 'show']), set);

  const empty = h.ok(['project', 'set', '--ci-ignore-apps', '[]']);
  assert.match(empty, /ci\.ignore_apps: \[\]/);
  const cleared = h.ok(['project', 'set', '--tests-paths', 'null', '--ci-ignore-apps', 'null']);
  assert.equal(cleared, defaults);
});
