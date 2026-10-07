'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, BIN } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');

const prices = {
  luna: { input: 0.10, cache_write: 0.125, cache_read: 0.01, output: 0.50 },
  sol: { input: 2, cache_write: 2.50, cache_read: 0.10, output: 10 },
  opus: { input: 4, cache_write: 5, cache_read: 0.20, output: 20 },
};

function rung(h, name, model) {
  h.ok(['ladder', 'set', name, '--harness', 'opencode', '--model', model, '--clear', 'profile', '--clear', 'effort']);
}

function setup(t, tier = 'easy', builder = 'other') {
  const h = makeRepo(t);
  h.init();
  h.sha = gateFixture(h);
  h.ok(['project', 'set', '--repo', 'acme/demo']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'value becomes one', '--tier', tier]);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'BUILDER-HISTORY that the reviewer does not need\n' });
  h.ok(['claim', 'T1', '--agent', 'builder']);
  h.ok(['spend', 'T1', '--agent', 'builder', '--tokens', '10', '--input', '10', '--output', '0', '--rung', tier, '--model', builder]);
  h.ok(['submit', 'T1', '--agent', 'builder', '--sha', h.sha, '--branch', 'fixture-change']);
  for (const [name, model] of [['easy', 'luna'], ['medium', 'sol'], ['hard', 'opus'], ['research', 'opus'], ['review', 'fallback']]) rung(h, name, model);
  h.ok(['project', 'set', '--review-policy', JSON.stringify({ prices, small_lines: 100, small_files: 5, risk_paths: ['auth/**'] })]);
  return h;
}

function ready(h) {
  gateEvidence(h, 'tests', 'gates');
  gateEvidence(h, 'clean', 'gates');
}

function choice(h) {
  return h.json(['spawn', '--task', 'T1', '--role', 'review', '--dry-run']);
}

function model(out) {
  return out.argv[out.argv.indexOf('-m') + 1];
}

function sample(h, name, input, cached, output, cacheWrite = 0) {
  h.ok(['spend', 'T1', '--agent', `review-${name}`, '--tokens', String(input + output), '--input', String(input),
    '--cached', String(cached), '--cache-write', String(cacheWrite), '--output', String(output), '--rung', 'review', '--model', name]);
}

test('review selection also uses tier and diff defaults without a price table', (t) => {
  const h = setup(t);
  h.ok(['project', 'set', '--review-policy', 'null']);
  ready(h);
  assert.equal(model(choice(h)), 'luna');
});

test('review choice follows tier, diff limits and configured risk paths', (t) => {
  for (const [tier, expected] of [['easy', 'luna'], ['medium', 'sol'], ['hard', 'opus'], ['research', 'opus']]) {
    const h = setup(t, tier);
    ready(h);
    assert.equal(model(choice(h)), expected, tier);
  }
  for (const policy of [{ small_lines: 1 }, { small_files: 1 }, { risk_paths: ['value.js'] }]) {
    const h = setup(t);
    h.ok(['project', 'set', '--review-policy', JSON.stringify({ prices, ...policy })]);
    ready(h);
    assert.equal(model(choice(h)), policy.risk_paths ? 'opus' : 'sol', JSON.stringify(policy));
  }
});

test('review model always differs from the actual builder, including across harnesses', (t) => {
  const h = setup(t, 'easy', 'luna');
  ready(h);
  assert.equal(model(choice(h)), 'sol');
  h.ok(['ladder', 'set', 'medium', '--model', 'luna']);
  assert.equal(model(choice(h)), 'opus');
  h.ok(['ladder', 'set', 'hard', '--model', 'luna']);
  h.ok(['ladder', 'set', 'research', '--model', 'luna']);
  assert.equal(model(choice(h)), 'fallback');
  h.ok(['ladder', 'set', 'review', '--model', 'luna']);
  const refused = h.run(['spawn', '--task', 'T1', '--role', 'review', '--dry-run']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /different model/);
});

test('a Claude alias cannot select the builder through a full model name', (t) => {
  const h = setup(t, 'hard', 'anthropic/claude-opus-5-5');
  ready(h);
  assert.equal(model(choice(h)), 'fallback');
});

test('a stronger model wins only when its median priced review cost is no higher', (t) => {
  const h = setup(t, 'medium');
  ready(h);
  // Inclusive input includes cache writes and cache reads.
  sample(h, 'sol', 100000, 50000, 60000); // $0.705
  sample(h, 'opus', 100000, 50000, 20000, 20000); // $0.63
  assert.equal(model(choice(h)), 'opus');
  sample(h, 'opus', 100000, 50000, 100000, 20000); // median $1.43
  assert.equal(model(choice(h)), 'sol');
  // Worker spend must not masquerade as a cheap review sample.
  h.ok(['spend', 'T1', '--agent', 'cheap-worker', '--tokens', '1', '--input', '1', '--cached', '0', '--output', '0', '--rung', 'hard', '--model', 'opus']);
  assert.equal(model(choice(h)), 'sol');
});

test('equal cost promotes, missing components do not provide a cost sample', (t) => {
  const h = setup(t, 'medium');
  ready(h);
  h.ok(['spend', 'T1', '--agent', 'unknown-review', '--tokens', '1', '--rung', 'review', '--model', 'opus']);
  sample(h, 'sol', 0, 0, 1000);
  assert.equal(model(choice(h)), 'sol');
  sample(h, 'opus', 0, 0, 500);
  assert.equal(model(choice(h)), 'opus');
});

test('review history from other tasks and cached tokens determines cost', (t) => {
  const h = setup(t, 'medium');
  ready(h);
  h.ok(['task', 'add', '--title', 'Recorded review history', '--acceptance', 'usage captured']);
  sample(h, 'sol', 1000000, 990000, 0);
  h.ok(['spend', 'T2', '--agent', 'historical-reviewer', '--rung', 'review', '--model', 'opus',
    '--tokens', '100000', '--input', '100000', '--cached', '99000', '--cache-write', '0', '--output', '0']);
  assert.equal(model(choice(h)), 'opus', 'cached token prices, rather than input-only prices, decide');
});

test('review escalation climbs one rung and stays independent of the builder', (t) => {
  const h = setup(t);
  ready(h);
  assert.equal(model(choice(h)), 'luna');
  h.ok(['evidence', 'T1', '--agent', 'r1', '--type', 'review', '--fail', '--sha', h.sha, '--summary', 'needs stronger reasoning']);
  assert.equal(model(choice(h)), 'sol');
  h.ok(['evidence', 'T1', '--agent', 'r2', '--type', 'review', '--fail', '--sha', h.sha]);
  assert.equal(model(choice(h)), 'opus');
});

test('escalation starts above the actual dispatched reviewer when builder exclusion skipped a tier', (t) => {
  const h = setup(t);
  ready(h);
  const easy = [process.execPath, '-e', 'console.log("builder model")'];
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--clear', 'model', '--command', JSON.stringify(easy)]);
  h.ok(['spend', 'T1', '--agent', 'builder', '--tokens', '0', '--rung', 'easy',
    '--model', `command ${JSON.stringify(easy)}`]);
  const script = `const cp = require('node:child_process');
const r = cp.spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'evidence', 'T1', '--type', 'review', '--fail', '--sha', ${JSON.stringify(h.sha)}], {env: process.env});
process.exit(r.status ?? 1);`;
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'model',
    '--command', JSON.stringify([process.execPath, '-e', script])]);
  const dispatched = h.json(['spawn', '--task', 'T1', '--role', 'review', '--wait']);
  assert.equal(dispatched.review_rung, 'medium');
  assert.equal(choice(h).review_rung, 'hard');
});

test('direct review dispatch refuses missing and failed gates and supplies lean context after they pass', (t) => {
  const h = setup(t);
  const before = h.run(['spawn', '--task', 'T1', '--role', 'review', '--dry-run']);
  assert.equal(before.code, 1);
  assert.match(before.stderr, /software gates/);
  gateEvidence(h, 'tests', 'gates', false);
  assert.equal(h.run(['spawn', '--task', 'T1', '--role', 'review']).code, 1);
  ready(h);
  const out = choice(h);
  assert.equal(out.agent, 'reviewer-T1-1');
  const prompt = out.argv.find((arg) => arg.includes('## Task'));
  assert.match(prompt, /value becomes one/);
  assert.match(prompt, /diff --git a\/value.js b\/value.js/);
  assert.match(prompt, /Gate results/);
  assert.match(prompt, /fail without/);
  assert.match(prompt, /probe/);
  assert.ok(!prompt.includes('BUILDER-HISTORY'));
  assert.equal(out.rung, 'review');
});

function commandReviewer(h, out) {
  const script = `const fs = require('node:fs'); const cp = require('node:child_process');
fs.writeFileSync(process.argv[1], process.argv[2]);
const r = cp.spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'evidence', 'T1', '--type', 'review', '--ok', '--sha', ${JSON.stringify(h.sha)}, '--summary', 'reviewed'], {env: process.env});
process.exit(r.status ?? 1);`;
  h.ok(['project', 'set', '--review-policy', 'null']);
  for (const name of ['easy', 'medium', 'hard', 'research']) h.ok(['ladder', 'set', name, '--model', 'other']);
  h.ok(['ladder', 'set', 'review', '--harness', 'command', '--clear', 'model', '--command', JSON.stringify([process.execPath, '-e', script, out, '{prompt}'])]);
}

test('accept runs tests, clean and CI before dispatch, and records review pending until a later accept', async (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'review-context.txt');
  commandReviewer(h, out);
  h.ok(['submit', 'T1', '--agent', 'builder', '--sha', h.sha, '--pr', '7']);
  const result = h.json(['accept', 'T1', '--cmd', 'node test/value.test.js']);
  assert.equal(result.status, 'submitted');
  assert.equal(result.review_pending, true);
  const deadline = Date.now() + 10000;
  while (!h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review')) {
    assert.ok(Date.now() < deadline, 'reviewer did not finish');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const dispatch = events.findIndex((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  for (const type of ['tests', 'clean', 'ci']) assert.ok(events.findIndex((e) => e.cmd === `check ${type}` && e.detail.ok) < dispatch);
  assert.match(fs.readFileSync(out, 'utf8'), /Gate results/);
  h.ok(['accept', 'T1']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
});

test('a failed automatic gate never starts a reviewer', (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'review-context.txt');
  commandReviewer(h, out);
  const failed = h.run(['accept', 'T1', '--cmd', 'node -e "process.exit(1)"']);
  assert.equal(failed.code, 1);
  assert.ok(!fs.existsSync(out));
  assert.ok(!fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').includes('"cmd":"spawn"'));
  assert.equal(h.readState('tasks.json').tasks[0].evidence[0].type, 'tests');
});

test('accept reuses an active review and direct dispatch refuses a duplicate', (t) => {
  const h = setup(t);
  ready(h);
  for (const name of ['easy', 'medium', 'hard', 'research']) h.ok(['ladder', 'set', name, '--model', 'other']);
  h.ok(['ladder', 'set', 'review', '--harness', 'command', '--clear', 'model',
    '--command', JSON.stringify([process.execPath, '-e', 'setInterval(() => {}, 1000)'])]);
  const first = h.json(['accept', 'T1']);
  const second = h.json(['accept', 'T1']);
  assert.equal(second.reviewer, first.reviewer);
  const refused = h.run(['spawn', '--task', 'T1', '--role', 'review']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /reviewer is still running/);
});

test('large review diffs use a context file and a short argv', (t) => {
  const h = setup(t);
  fs.writeFileSync(path.join(h.repo, 'large.md'), 'A focused review reads this diff.\n'.repeat(1000));
  h.git(['add', 'large.md']);
  h.git(['commit', '-qm', 'large diff']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'update', 'T1', '--kind', 'docs']);
  h.ok(['submit', 'T1', '--agent', 'builder', '--sha', h.sha]);
  const out = path.join(h.base, 'large-prompt.txt');
  commandReviewer(h, out);
  const preview = choice(h);
  const packet = path.join(h.state, 'reviews', `T1-${h.sha}.md`);
  assert.ok(!fs.existsSync(packet), 'a dry run writes no packet');
  assert.ok(preview.argv.join(' ').length < 16000);
  h.json(['spawn', '--role', 'review', '--task', 'T1', '--wait']);
  assert.match(fs.readFileSync(out, 'utf8'), /reviews/);
  assert.match(fs.readFileSync(packet, 'utf8'), /diff --git a\/large.md b\/large.md/);
});

test('review policy validates price and diff settings through the CLI', (t) => {
  const h = makeRepo(t);
  h.init();
  for (const bad of [{ prices: { sol: { input: -1 } } }, { small_lines: -1 }, { risk_paths: [3] }, { surprise: true }]) {
    assert.equal(h.run(['project', 'set', '--review-policy', JSON.stringify(bad)]).code, 2);
  }
  h.ok(['project', 'set', '--review-policy', JSON.stringify({ prices })]);
  assert.deepEqual(h.json(['project', 'show']).review.prices, prices);
});
