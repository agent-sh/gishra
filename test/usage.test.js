'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

const fixture = (name) => path.join(__dirname, 'fixtures', 'usage', name);
const text = (name) => fs.readFileSync(fixture(name), 'utf8');
const parse = (...args) => require('../lib/usage').parseUsage(...args);

test('codex captured footer and repeated session totals are counted once', () => {
  assert.deepEqual(parse('codex', text('codex.log')), {
    tokens: 24675, input: null, cached: null, output: null, model: 'openai.gpt-6.1-sol',
  });
  const session = text('codex-session.jsonl');
  assert.deepEqual(parse('codex', text('codex.log'), session + session), {
    tokens: 24675, input: 24670, cached: 0, output: 5, model: 'openai.gpt-6.1-sol',
  });
  assert.deepEqual(parse('codex', text('codex.log'), text('codex-cache-session.jsonl')), {
    tokens: 1529656, input: 1516556, cached: 1398443, output: 13100, model: 'openai.gpt-6.1-sol',
  });
});

test('claude captured usage includes cache reads and writes in input', () => {
  assert.deepEqual(parse('claude', text('claude.jsonl')), {
    tokens: 31948, input: 31773, cached: 31771, output: 175, model: 'claude-opus-5-5',
  });
  assert.deepEqual(parse('claude', text('claude.jsonl') + text('claude.jsonl')), parse('claude', text('claude.jsonl')));
  assert.deepEqual(parse('claude', text('claude-result.json')), {
    tokens: 0, input: 0, cached: 0, output: 0, model: null,
  });
  assert.deepEqual(parse('claude', text('claude.jsonl') + text('claude-result.json')), parse('claude', text('claude-result.json')), 'a result is not added to assistant usage');
});

test('opencode captured step-finish totals include each step once', () => {
  assert.deepEqual(parse('opencode', text('opencode.jsonl')), {
    tokens: 289055, input: 288796, cached: 0, output: 259, model: null,
  });
  const cached = text('opencode-cache.jsonl');
  assert.deepEqual(parse('opencode', cached + cached), {
    tokens: 288768, input: 288252, cached: 282624, output: 516, model: null,
  });
});

test('agy captured json reports inclusive input and separate thinking', () => {
  assert.deepEqual(parse('agy', text('agy.json')), {
    tokens: 12257, input: 12256, cached: 0, output: 1, model: null,
  });
});

test('pi captured message usage includes cache writes in input', () => {
  assert.deepEqual(parse('pi', text('pi.jsonl')), {
    tokens: 12559, input: 12394, cached: 0, output: 165, model: 'global.anthropic.claude-fable-5',
  });
});

test('absent or malformed telemetry is unknown, explicit zero is measured', () => {
  for (const harness of ['codex', 'claude', 'opencode', 'agy', 'pi', 'command']) {
    assert.equal(parse(harness, 'hello\n{broken json'), null);
    assert.equal(parse(harness, 'null'), null);
  }
  assert.equal(parse('constructor', text('agy.json')), null);
  assert.deepEqual(parse('agy', '{"usage":{"input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"total_tokens":0}}'), {
    tokens: 0, input: 0, cached: 0, output: 0, model: null,
  });
  assert.equal(parse('codex', '{"type":"turn.completed","usage":{"input_tokens":-1,"output_tokens":3}}'), null);
});

function setup(t, harness = 'codex') {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Usage', '--acceptance', 'accounted', '--tier', 'easy']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Record usage.\n' });
  h.ok(['ladder', 'set', 'easy', '--harness', harness, '--model', 'dispatch-model', '--clear', 'profile', '--clear', 'effort']);
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, harness + (process.platform === 'win32' ? '.exe' : '')), '', { mode: 0o755 });
  h.usageEnv = { PATH: bin + path.delimiter + h.env.PATH };
  h.usageHooks = { HOOK_USAGE_HARNESS: harness, HOOK_USAGE_FILE: fixture(harness === 'codex' ? 'codex.log' : `${harness}.jsonl`) };
  return h;
}

const spends = (h) => h.json(['task', 'show', 'T1']).spend;
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

async function collected(h, length = 1) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const spend = spends(h);
    if (spend.entries?.length === length) return spend;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('usage was not collected within 15 s');
}

test('native usage uses one CLI call and preserves rung metadata across ladder changes', (t) => {
  const h = setup(t, 'claude');
  const s = h.json(['spend', 'T1', '--tokens', '100', '--input', '80', '--cached', '60', '--output', '20', '--rung', 'easy'], { env: { GISHRA_AGENT: 'native-worker' } }).spend;
  assert.equal(s.tokens, 100);
  assert.equal(s.input, 80);
  assert.equal(s.cached, 60);
  assert.equal(s.output, 20);
  assert.equal(s.entries[0].rung, 'easy');
  assert.equal(s.entries[0].harness, 'claude');
  assert.equal(s.entries[0].model, 'dispatch-model');
  assert.equal(s.entries[0].agent, 'native-worker');
  h.ok(['ladder', 'set', 'easy', '--model', 'replacement']);
  assert.equal(spends(h).entries[0].model, 'dispatch-model');
  assert.match(h.ok(['status']), /100 tokens/);
  for (const args of [
    ['--tokens', '-1'], ['--tokens', '10', '--input', '11'],
    ['--tokens', '10', '--input', '5', '--cached', '6'], ['--cached', '1'],
    ['--tokens', '10', '--rung', 'unknown'], ['--tokens', '9007199254740992'],
  ]) assert.equal(h.run(['spend', 'T1', ...args]).code, 2, args.join(' '));
  assert.equal(spends(h).tokens, 100, 'refused usage writes nothing');
});

test('foreground spawn captures usage after stderr and stdout close, including failed agents', (t) => {
  const h = setup(t);
  const r = h.run(['spawn', '--task', 'T1', '--wait', '--json'], {
    env: { ...h.usageEnv, USAGE_EXIT: '7' }, hooks: h.usageHooks,
  });
  assert.equal(r.code, 7, r.stderr);
  const started = JSON.parse(r.stdout);
  assert.match(r.stderr, /tokens used/);
  assert.ok(fs.existsSync(started.log));
  const s = spends(h);
  assert.equal(s.tokens, 24675);
  assert.equal(s.entries[0].rung, 'easy');
  assert.equal(s.entries[0].harness, 'codex');
  assert.equal(s.entries[0].model, 'openai.gpt-6.1-sol');
  assert.equal(events(h).find((e) => e.cmd === 'spawn exit').detail.code, 7);
});

test('detached exits record both spawns exactly once and keep dispatch metadata', async (t) => {
  const h = setup(t);
  const options = { env: { ...h.usageEnv, USAGE_DELAY: '900' }, hooks: h.usageHooks };
  const a = h.json(['spawn', '--task', 'T1'], options);
  const b = h.json(['spawn', '--task', 'T1'], options);
  h.ok(['ladder', 'set', 'easy', '--model', 'replacement']);
  const s = await collected(h, 2);
  assert.equal(s.tokens, 49350);
  assert.deepEqual(s.entries.map((e) => e.source).sort(), [`spawn:${a.agent}`, `spawn:${b.agent}`]);
  for (const e of s.entries) {
    assert.equal(e.rung, 'easy');
    assert.equal(e.harness, 'codex');
    assert.equal(e.model, 'openai.gpt-6.1-sol');
  }
  h.ok(['spend', 'T1', '--from-spawn', a.agent]);
  h.ok(['spend', 'T1', '--from-spawn', b.agent]);
  assert.equal(spends(h).tokens, 49350);
  assert.equal(events(h).filter((e) => e.cmd === 'spend').length, 2);
});

test('codex session fallback opens only the exact session and counts cached input once', (t) => {
  const h = setup(t);
  const codexHome = path.join(h.base, 'codex');
  const id = '01a11284-12da-7953-94fb-07a97b081e94';
  const file = path.join(codexHome, 'sessions', '2026', '10', '06', `rollout-2026-10-06T21-40-07-${id}.jsonl`);
  h.ok(['spawn', '--task', 'T1', '--wait'], {
    env: { ...h.usageEnv, CODEX_HOME: codexHome, USAGE_SESSION: file, USAGE_SESSION_FIXTURE: fixture('codex-session.jsonl') },
    hooks: h.usageHooks,
  });
  const s = spends(h);
  assert.equal(s.input, 24670);
  assert.equal(s.cached, 0);
  assert.equal(s.output, 5);
  assert.equal(s.tokens, 24675);
});

test('an exited spawn without telemetry is marked unknown and can be recollected', async (t) => {
  const h = setup(t);
  const empty = path.join(h.base, 'empty.log');
  fs.writeFileSync(empty, 'No telemetry\n');
  const a = h.json(['spawn', '--task', 'T1'], {
    env: h.usageEnv, hooks: { ...h.usageHooks, HOOK_USAGE_FILE: empty },
  });
  const s = await collected(h);
  assert.equal(s.entries[0].tokens, null);
  assert.equal(s.tokens, 0);
  assert.equal(h.json(['status']).spend.missing_usage, 1);
  assert.match(h.ok(['status']), /1 spawns without usage/);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /Spawns without usage/);
  fs.appendFileSync(a.log, text('codex.log'));
  h.ok(['spend', 'T1', '--from-spawn', a.agent]);
  assert.equal(spends(h).entries.length, 1);
  assert.equal(spends(h).tokens, 24675);
  assert.equal(h.json(['status']).spend.missing_usage, 0);
});
