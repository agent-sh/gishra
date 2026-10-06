'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

const BUILTIN = {
  orchestrator: { harness: 'claude', model: 'opus', effort: 'high' },
  easy: { profile: 'luna', effort: 'medium' },
  medium: { profile: 'sol', effort: 'high' },
  hard: { harness: 'claude', model: 'opus', effort: 'high' },
  research: { harness: 'claude', model: 'opus', effort: 'max' },
  review: { profile: 'sol', effort: 'high' },
  small: { profile: 'luna', effort: 'low' },
};

function writeUser(h, doc) {
  fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
  fs.writeFileSync(h.userConfig, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
}

const projectText = (h) => fs.readFileSync(path.join(h.state, 'project.json'), 'utf8');
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('init copies the built-in ladder, and a rung the project leaves out falls back to it', (t) => {
  const h = makeRepo(t);
  h.init();
  const p = h.readState('project.json');
  assert.equal(p.harness, 'codex');
  assert.deepEqual(p.ladder, BUILTIN);
  const show = h.json(['ladder', 'show']);
  assert.equal(show.harness_from, 'project');
  assert.equal(show.user_file, h.userConfig);
  assert.equal(show.user_file_exists, false);
  assert.deepEqual(show.ladder.easy, { profile: 'luna', effort: 'medium', harness: 'codex', harness_from: 'default', from: 'project' });
  assert.deepEqual(show.ladder.hard, { harness: 'claude', model: 'opus', effort: 'high', harness_from: 'rung', from: 'project' });

  delete p.ladder.easy;
  delete p.harness;
  h.writeState('project.json', p);
  const back = h.json(['ladder', 'show']);
  assert.deepEqual([back.harness, back.harness_from], ['codex', 'built-in']);
  assert.deepEqual([back.ladder.easy.profile, back.ladder.easy.from], ['luna', 'built-in']);
  assert.match(h.ok(['ladder', 'show']), /^ {2}easy +codex \(default\) +profile luna, effort medium +from built-in$/m);
});

test('the user file supplies the defaults a new project copies, and the project file then wins', (t) => {
  const h = makeRepo(t);
  writeUser(h, {
    harness: 'opencode',
    ladder: { easy: { model: 'a/easy' }, medium: { model: 'a/medium', effort: 'high' }, review: { model: 'a/review' }, small: { model: 'a/small' } },
  });
  h.init();
  const p = h.readState('project.json');
  assert.equal(p.harness, 'opencode');
  assert.deepEqual(p.ladder.easy, { model: 'a/easy' });
  assert.deepEqual(p.ladder.medium, { model: 'a/medium', effort: 'high' });
  assert.deepEqual(p.ladder.hard, BUILTIN.hard, 'a rung the user file leaves out comes from the built-in ladder');

  writeUser(h, { harness: 'pi', ladder: { easy: { model: 'p/easy' } } });
  const show = h.json(['ladder', 'show']);
  assert.deepEqual([show.harness, show.ladder.easy.model, show.ladder.easy.from], ['opencode', 'a/easy', 'project'], 'the project keeps its own ladder');
  assert.equal(show.user_file_exists, true);

  delete p.ladder.easy;
  h.writeState('project.json', p);
  const easy = h.json(['ladder', 'show']).ladder.easy;
  assert.deepEqual([easy.model, easy.harness, easy.from], ['p/easy', 'opencode', 'user'], 'a rung the project leaves out comes from the user file');
});

test('ladder save-user makes the project ladder the default for new projects', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['ladder', 'set', 'hard', '--model', 'fable']);
  const out = h.json(['ladder', 'save-user']);
  assert.equal(out.file, h.userConfig);
  const saved = JSON.parse(fs.readFileSync(h.userConfig, 'utf8'));
  assert.equal(saved.harness, 'codex');
  assert.deepEqual(saved.ladder.hard, { harness: 'claude', model: 'fable', effort: 'high' });
  assert.deepEqual(saved.ladder.easy, BUILTIN.easy);
  assert.equal(events(h).filter((e) => e.cmd === 'ladder save-user').length, 1);

  const other = path.join(h.base, 'second-state');
  h.ok(['init', '--name', 'second', '--goal', 'g', '--state', other]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(other, 'project.json'), 'utf8')).ladder.hard.model, 'fable');

  // A ladder that cannot run is not saved over the user file.
  const saved1 = fs.readFileSync(h.userConfig, 'utf8');
  h.writeState('project.json', { ...h.readState('project.json'), harness: 'pi' });
  const refused = h.run(['ladder', 'save-user']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /ladder easy \(pi, the default harness\): profile applies only to codex, needs a model;.*before saving it as the default/);
  assert.equal(fs.readFileSync(h.userConfig, 'utf8'), saved1);
});

test('ladder harness moves every rung without its own harness, and spawn runs each tier there', (t) => {
  const h = makeRepo(t);
  h.init();
  for (const rung of ['easy', 'medium', 'review', 'small']) h.ok(['ladder', 'set', rung, '--model', `m-${rung}`, '--clear', 'profile']);
  h.ok(['task', 'add', '--title', 'Small', '--acceptance', 'a', '--size', 'S']);
  h.ok(['task', 'add', '--title', 'Medium', '--acceptance', 'a']);
  h.ok(['task', 'add', '--title', 'Large', '--acceptance', 'a', '--size', 'L']);
  h.ok(['task', 'add', '--title', 'Study', '--acceptance', 'a', '--kind', 'research', '--size', 'S']);
  for (const id of ['T1', 'T2', 'T3', 'T4']) h.ok(['brief', 'set', id, '-'], { input: `brief ${id}\n` });
  const empty = path.join(h.base, 'no-plugin');
  fs.mkdirSync(empty);
  const spawn = (id, role) => h.json(['spawn', '--task', id, ...(role ? ['--role', role] : []), '--dry-run'], { env: { GISHRA_PLUGIN_ROOT: empty } });
  const flags = (argv) => argv.filter((a) => !a.includes('brief T'));

  h.ok(['ladder', 'harness', 'pi']);
  const show = h.json(['ladder', 'show']);
  for (const rung of ['easy', 'medium', 'review', 'small']) assert.equal(show.ladder[rung].harness, 'pi', rung);
  for (const rung of ['orchestrator', 'hard', 'research']) assert.equal(show.ladder[rung].harness, 'claude', `${rung} keeps its own harness`);

  const easy = spawn('T1');
  assert.deepEqual([easy.rung, easy.agent], ['easy', 'worker-T1-1']);
  assert.deepEqual(flags(easy.argv), ['pi', '-p', '--mode', 'json', '--model', 'm-easy', '--thinking', 'medium']);
  assert.deepEqual(flags(spawn('T2').argv), ['pi', '-p', '--mode', 'json', '--model', 'm-medium', '--thinking', 'high']);
  assert.deepEqual(flags(spawn('T3').argv), ['claude', '-p', '--model', 'opus', '--effort', 'high', '--output-format', 'json']);
  assert.deepEqual(flags(spawn('T4').argv), ['claude', '-p', '--model', 'opus', '--effort', 'max', '--output-format', 'json']);
  const review = spawn('T2', 'review');
  assert.deepEqual([review.rung, review.agent], ['review', 'reviewer-T2-1']);
  assert.deepEqual(flags(review.argv), ['pi', '-p', '--mode', 'json', '--model', 'm-review', '--thinking', 'high']);

  h.ok(['ladder', 'harness', 'codex']);
  assert.deepEqual(flags(spawn('T1').argv), ['codex', 'exec', '--json', '-m', 'm-easy', '-c', 'model_reasoning_effort=medium']);
  assert.deepEqual(flags(spawn('T3').argv).slice(0, 1), ['claude']);
  const harnessEvents = events(h).filter((e) => e.cmd === 'ladder harness').map((e) => e.detail.harness);
  assert.deepEqual(harnessEvents, ['pi', 'codex']);
});

test('ladder writes are validated, and a refused one leaves project.json as it was', (t) => {
  const h = makeRepo(t);
  h.init();
  const before = projectText(h);
  const cases = [
    [['ladder', 'harness', 'pi'], 1, /ladder easy \(pi, the default harness\): profile applies only to codex, needs a model;.*fix those rungs first/],
    [['ladder', 'harness', 'gemini'], 2, /claude, codex, opencode, agy, pi, command/],
    [['ladder', 'set', 'easy', '--harness', 'gemini'], 2, /--harness must be one of claude, codex, opencode, agy, pi, command/],
    [['ladder', 'set', 'worker', '--model', 'x'], 2, /unknown rung "worker"; the rungs are orchestrator, easy, medium, hard, research, review, small/],
    [['ladder', 'set', 'research', '--effort', 'ultra'], 1, /ladder research \(claude\): effort must be one of low, medium, high, xhigh, max, not "ultra"/],
    [['ladder', 'set', 'easy', '--provider', 'openai'], 1, /ladder easy \(codex, the default harness\): provider applies only to pi/],
    [['ladder', 'set', 'hard', '--clear', 'model'], 1, /ladder hard \(claude\): needs a model/],
    [['ladder', 'set', 'small', '--harness', 'command', '--clear', 'profile', '--clear', 'effort'], 1, /ladder small \(command\): needs a command array/],
    [['ladder', 'set', 'small', '--args', '"--x"'], 2, /--args must be a JSON array of strings/],
    [['ladder', 'set', 'small', '--clear', 'colour'], 2, /--clear takes a rung field/],
    [['ladder', 'set', 'small', '--model', 'x', '--clear', 'model'], 2, /model is both set and cleared/],
    [['ladder', 'set', 'small'], 2, /needs a change/],
    [['role', 'set', 'worker', '--harness', 'codex'], 2, /unknown command "role"/],
  ];
  for (const [args, code, message] of cases) {
    const r = h.run(args);
    assert.equal(r.code, code, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, message, args.join(' '));
    assert.equal(projectText(h), before, `${args.join(' ')} wrote nothing`);
  }
  assert.equal(events(h).filter((e) => e.cmd.startsWith('ladder')).length, 0, 'refused writes log no event');

  const p = h.readState('project.json');
  h.writeState('project.json', { ...p, ladder: { ...p.ladder, medium: { harness: 'gemini', model: 'x' } } });
  const hand = h.run(['status']);
  assert.equal(hand.code, 1);
  assert.match(hand.stderr, /ladder medium: harness must be one of claude, codex, opencode, agy, pi, command/);
  h.writeState('project.json', { ...p, roles: { worker: { harness: 'codex', profile: 'sol' } } });
  assert.match(h.run(['status']).stderr, /roles was replaced by harness and ladder/, 'a pre-ladder roles block is refused, not ignored');

  writeUser(h, { ladder: { easy: { harness: 'pi', profile: 'luna' } } });
  const fresh = h.run(['init', '--name', 'n', '--goal', 'g', '--state', path.join(h.base, 'fresh')]);
  assert.equal(fresh.code, 1);
  assert.ok(fresh.stderr.includes(`the default ladder is invalid: ladder easy (pi, from the user file ${h.userConfig}): profile applies only to codex, needs a model`), fresh.stderr);
  assert.ok(!fs.existsSync(path.join(h.base, 'fresh')), 'a refused init creates nothing');
  writeUser(h, '{ not json');
  assert.match(h.run(['init', '--name', 'n', '--goal', 'g', '--state', path.join(h.base, 'fresh')]).stderr, /config\.json is not valid JSON/);
});

test('a ladder broken by a changed user file still loads, and ladder set repairs it one rung at a time', (t) => {
  const h = makeRepo(t);
  writeUser(h, { harness: 'pi', ladder: { easy: { model: 'p/easy' }, medium: { model: 'p/medium' }, review: { model: 'p/review' }, small: { model: 'p/small' } } });
  h.init();
  h.ok(['task', 'add', '--title', 'x', '--acceptance', 'a', '--size', 'S']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'brief\n' });
  // The project keeps its default harness and its orchestrator rung, and
  // follows the user file for the rest.
  const p = h.readState('project.json');
  h.writeState('project.json', { ...p, ladder: { orchestrator: p.ladder.orchestrator } });
  // Another project saves a codex ladder over the user file.
  writeUser(h, { harness: 'codex', ladder: { easy: { profile: 'luna' }, medium: { profile: 'sol' }, review: { profile: 'sol' }, small: { profile: 'luna' } } });

  assert.equal(h.run(['status']).code, 0, 'the project still loads');
  assert.equal(h.ok(['task', 'add', '--title', 'y', '--acceptance', 'a']), 'T2', 'other writes still work');
  const v = h.run(['validate']);
  assert.equal(v.code, 1);
  assert.ok(v.stdout.includes(`ladder easy (pi, the default harness, from the user file ${h.userConfig}): profile applies only to codex, needs a model`), v.stdout);
  const spawn = h.run(['spawn', '--task', 'T1', '--dry-run']);
  assert.equal(spawn.code, 1);
  assert.match(spawn.stderr, /ladder easy \(pi.*profile applies only to codex, needs a model; fix it with gishra ladder set easy/);
  assert.match(h.ok(['ladder', 'show']), /^cannot run: ladder medium \(pi/m);

  h.ok(['ladder', 'set', 'easy', '--model', 'p/easy', '--clear', 'profile']);
  assert.equal(h.json(['spawn', '--task', 'T1', '--dry-run']).argv[0], 'pi', 'the repaired rung runs while others are still broken');
  const worse = h.run(['ladder', 'set', 'orchestrator', '--effort', 'ultra']);
  assert.equal(worse.code, 1, 'a change that breaks a working rung is still refused');
  assert.match(worse.stderr, /^gishra: ladder orchestrator \(claude\): effort must be one of/);
});

test('a ladder write is evented and re-renders the sketch with the ladder and each task tier', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Small fix', '--acceptance', 'a', '--size', 'S']);
  h.ok(['ladder', 'set', 'easy', '--model', 'gpt-x', '--clear', 'profile', '--agent', 'w-1']);
  const ev = events(h).find((e) => e.cmd === 'ladder set');
  assert.deepEqual([ev.agent, ev.detail], ['w-1', { rung: 'easy', model: 'gpt-x', effort: 'medium' }]);
  assert.deepEqual(h.readState('project.json').ladder.easy, { model: 'gpt-x', effort: 'medium' });
  const html = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  assert.match(html, /<td class="id">easy<\/td><td>codex \(default\)<\/td><td>gpt-x<\/td><td>medium<\/td>/);
  assert.match(html, /<td class="id">research<\/td><td>claude<\/td><td>opus<\/td><td>max<\/td>/);
  assert.match(html, /T1<tspan class="ntier" dx="8">easy<\/tspan>/, 'the graph shows the task tier');
  const md = fs.readFileSync(path.join(h.state, 'sketch.md'), 'utf8');
  assert.match(md, /^\| easy \| codex \(default\) \| gpt-x \| medium \|$/m);
  assert.match(md, /^\| T1 \| Small fix \| code \| S \| easy \| 0 \|$/m, 'the ready table shows the tier');
});

test('tasks take a tier from kind and size unless one is given', (t) => {
  const h = makeRepo(t);
  h.init();
  const add = (...flags) => h.json(['task', 'add', '--title', 'x', '--acceptance', 'a', ...flags]).tier;
  assert.equal(add('--size', 'S'), 'easy');
  assert.equal(add(), 'medium');
  assert.equal(add('--size', 'L'), 'hard');
  assert.equal(add('--kind', 'research', '--size', 'S'), 'research');
  assert.equal(add('--size', 'S', '--tier', 'research'), 'research');
  assert.equal(h.json(['task', 'update', 'T2', '--tier', 'hard']).tier, 'hard');
  assert.equal(h.json(['task', 'update', 'T1', '--size', 'L']).tier, 'easy', 'a size change does not move the tier');
  assert.match(h.ok(['task', 'show', 'T2']), /size: M {2}tier: hard/);
  assert.equal(h.json(['ready']).ready.find((r) => r.id === 'T2').tier, 'hard');
  assert.equal(h.run(['task', 'update', 'T1', '--tier', 'expert']).code, 2);

  const plan = path.join(h.base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify([{ title: 'p', acceptance: ['a'], tier: 'research' }, { title: 'q', acceptance: ['a'], size: 'S' }]));
  assert.deepEqual(h.json(['plan', 'import', plan]).added.map((a) => h.json(['task', 'show', a.id]).tier), ['research', 'easy']);
  fs.writeFileSync(plan, JSON.stringify([{ title: 'r', acceptance: ['a'], tier: 'expert' }]));
  const bad = h.run(['plan', 'import', plan]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /tier must be one of easy, medium, hard, research/);

  // A task written before tiers existed gets one from its kind and size.
  const doc = h.readState('tasks.json');
  delete doc.tasks[2].tier;
  doc.tasks[2].role = 'worker';
  h.writeState('tasks.json', doc);
  const old = h.json(['task', 'show', 'T3']);
  assert.deepEqual([old.tier, old.role], ['hard', undefined]);
});

test('validate warns when the review rung runs the same model as a tier in use, and still passes', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'x', '--acceptance', 'a', '--size', 'S']);
  assert.deepEqual(h.json(['validate']).warnings, [], 'easy runs luna and review runs sol');
  h.ok(['task', 'add', '--title', 'y', '--acceptance', 'a']);
  const r = h.run(['validate']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^plan ok: 2 tasks\nwarning: the review rung runs the same harness and model as the medium tier/);
  const data = h.json(['validate']);
  assert.deepEqual([data.ok, data.warnings.map((w) => w.kind)], [true, ['review-same-model']]);
  h.ok(['ladder', 'set', 'review', '--harness', 'claude', '--model', 'opus', '--clear', 'profile']);
  assert.deepEqual(h.json(['validate']).warnings, []);
  h.ok(['task', 'update', 'T1', '--tier', 'hard']);
  assert.match(h.ok(['validate']), /warning: the review rung runs the same harness and model as the hard tier/, 'an effort difference does not make it another model');
});

test('on codex an explicit model, not the profile, decides whether review shares a tier model', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'x', '--acceptance', 'a', '--size', 'S']);
  // codex -m overrides the profile's model, so these two run the same model.
  h.ok(['ladder', 'set', 'easy', '--model', 'same-model', '--profile', 'author-profile']);
  h.ok(['ladder', 'set', 'review', '--model', 'same-model', '--profile', 'review-profile']);
  assert.deepEqual(h.json(['validate']).warnings.map((w) => w.kind), ['review-same-model']);
  h.ok(['ladder', 'set', 'review', '--model', 'other-model']);
  assert.deepEqual(h.json(['validate']).warnings, [], 'different explicit models differ whatever the profiles');
  h.ok(['ladder', 'set', 'easy', '--clear', 'model']);
  h.ok(['ladder', 'set', 'review', '--clear', 'model', '--profile', 'author-profile']);
  assert.deepEqual(h.json(['validate']).warnings.map((w) => w.kind), ['review-same-model'], 'without a model the profile names it');
});
