'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, BIN, runPty, PTY_AVAILABLE } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');

const prices = {
  'openai.gpt-6-luna': { input: 0.10, cache_write: 0.125, cache_read: 0.01, output: 0.50 },
  'openai.gpt-6.1-sol': { input: 2, cache_write: 2.50, cache_read: 0.10, output: 10 },
  'claude-opus-5-5': { input: 4, cache_write: 5, cache_read: 0.20, output: 20 },
};
const windowsConcurrency = process.platform === 'win32' ? 2 : false;

function rung(h, name, model) {
  h.ok(['ladder', 'set', name, '--harness', 'opencode', '--model', model, '--clear', 'profile', '--clear', 'effort']);
}

function setup(t, tier = 'easy', builder = 'other', profile) {
  const h = makeRepo(t);
  h.init();
  h.sha = gateFixture(h);
  h.ok(['project', 'set', '--repo', 'acme/demo']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'value becomes one', '--tier', tier]);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'BUILDER-HISTORY that the reviewer does not need\n\n## Reviewer\nREVIEWER-ONLY instruction\n\n## Worker\nWORKER-HISTORY that the reviewer does not need\n' });
  if (profile) {
    const bin = path.join(h.base, 'bin');
    const codexHome = path.join(h.base, 'codex');
    fs.mkdirSync(bin);
    fs.mkdirSync(codexHome);
    fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex'), '', { mode: 0o755 });
    // An isolated caller's default must not rename another rung's known profile.
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "caller-model"\n');
    h.reviewEnv = { CODEX_HOME: codexHome, PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''), USAGE_CLAIM: '1' };
    h.ok(['ladder', 'set', tier, '--harness', 'codex', '--profile', profile, '--clear', 'model', '--clear', 'effort']);
    h.builder = h.json(['spawn', '--task', 'T1', '--wait'], {
      env: h.reviewEnv,
      hooks: { HOOK_USAGE_HARNESS: 'codex', HOOK_USAGE_FILE: path.join(__dirname, 'fixtures', 'usage', 'codex-stream.jsonl') },
    }).agent;
  } else {
    h.builder = 'builder';
    h.ok(['claim', 'T1', '--agent', h.builder]);
  }
  h.ok(['spend', 'T1', '--agent', h.builder, '--tokens', '10', '--input', '10', '--output', '0', '--rung', tier, '--model', builder]);
  h.ok(['submit', 'T1', '--agent', h.builder, '--sha', h.sha, '--branch', 'fixture-change']);
  for (const [name, model] of [['easy', 'luna'], ['medium', 'sol'], ['hard', 'opus'], ['research', 'opus'], ['review', 'fallback']]) rung(h, name, model);
  if (profile) for (const [name, value] of [['easy', 'luna'], ['medium', 'sol']]) {
    h.ok(['ladder', 'set', name, '--harness', 'codex', '--profile', value, '--clear', 'model', '--clear', 'effort']);
  }
  h.ok(['project', 'set', '--review-policy', JSON.stringify({ prices, small_lines: 100, small_files: 5, risk_paths: ['auth/**'] })]);
  return h;
}

function ready(h) {
  gateEvidence(h, 'tests', 'gates');
  gateEvidence(h, 'clean', 'gates');
}

function choice(h, env) {
  return h.json(['spawn', '--task', 'T1', '--role', 'review', '--dry-run'], { env: { ...h.reviewEnv, ...env } });
}

function model(out) {
  const flag = out.argv.includes('-m') ? '-m' : out.argv.includes('-p') ? '-p' : '--model';
  return out.argv[out.argv.indexOf(flag) + 1];
}

function sample(h, name, input, cached, output, cacheWrite = 0) {
  h.ok(['spend', 'T1', '--agent', `review-${name}`, '--tokens', String(input + output), '--input', String(input),
    '--cached', String(cached), '--cache-write', String(cacheWrite), '--output', String(output), '--rung', 'review', '--model', name]);
}

describe('reviewer integration cases', { concurrency: windowsConcurrency }, () => {
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

test('top-tier Claude builders can receive review on the same model', (t) => {
  for (const tier of ['hard', 'research']) {
    const h = setup(t, tier, 'claude-opus-5-5');
    ready(h);
    assert.equal(model(choice(h)), 'opus', tier);
  }
});

test('Codex profile builders share canonical identity with provider spend and prices', (t) => {
  for (const [tier, profile, provider, promotedTier, promotedModel, promotedProvider] of [
    ['easy', 'luna', 'openai.gpt-6-luna', 'medium', 'sol', 'openai.gpt-6.1-sol'],
    ['medium', 'sol', 'openai.gpt-6.1-sol', 'hard', 'opus', 'claude-opus-5-5'],
  ]) {
    const h = setup(t, tier, provider, profile);
    // A later self-reported model and ladder edit cannot rename the builder route.
    h.ok(['spend', 'T1', '--agent', h.builder, '--tokens', '1', '--rung', tier, '--model', 'wrong-model']);
    ready(h);
    assert.deepEqual([choice(h).review_rung, model(choice(h))], [tier, profile]);
    sample(h, provider, 1000000, 0, 0);
    sample(h, promotedProvider, 0, 0, 1);
    const out = choice(h);
    assert.deepEqual([out.review_rung, model(out)], [promotedTier, promotedModel]);
    const prompt = out.argv.find((arg) => arg.includes('## Task'));
    assert.ok(prompt.includes(`builder model ${provider}`), prompt);
    h.ok(['ladder', 'set', tier, '--harness', 'opencode', '--model', 'changed-model', '--clear', 'profile']);
    assert.ok(choice(h).argv.some((arg) => arg.includes(`builder model ${provider}`)));
  }
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

test('review escalation climbs one tier after failed reviews', (t) => {
  const h = setup(t);
  ready(h);
  assert.equal(model(choice(h)), 'luna');
  h.ok(['evidence', 'T1', '--agent', 'r1', '--type', 'review', '--fail', '--sha', h.sha, '--summary', 'needs stronger reasoning']);
  assert.equal(model(choice(h)), 'sol');
  h.ok(['evidence', 'T1', '--agent', 'r2', '--type', 'review', '--fail', '--sha', h.sha]);
  assert.equal(model(choice(h)), 'opus');
});

test('escalation starts above the actual dispatched reviewer rung', (t) => {
  const h = setup(t);
  ready(h);
  const script = `const cp = require('node:child_process');
const r = cp.spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'evidence', 'T1', '--type', 'review', '--fail', '--sha', ${JSON.stringify(h.sha)}], {env: process.env});
process.exit(r.status ?? 1);`;
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--clear', 'model',
    '--command', JSON.stringify([process.execPath, '-e', script])]);
  const dispatched = h.json(['spawn', '--task', 'T1', '--role', 'review', '--wait']);
  assert.equal(dispatched.review_rung, 'easy');
  assert.equal(choice(h).review_rung, 'medium');
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
  assert.match(prompt, /## Reviewer\nREVIEWER-ONLY instruction/);
  assert.ok(!prompt.includes('BUILDER-HISTORY'));
  assert.ok(!prompt.includes('WORKER-HISTORY'));
  assert.equal(out.rung, 'review');
});

test('review packet uses role headings consistently and ignores fenced headings', (t) => {
  const h = setup(t);
  h.ok(['brief', 'set', 'T1', '-'], { input: [
    '## Worker', 'BUILDER-HISTORY', '```md', '## Reviewer', 'FAKE-REVIEWER', '```',
    '## rEvIeWeR', 'REVIEWER-ONLY instruction', '### Probe', 'keep this nested heading',
    '## Shared', 'SHARED-HISTORY',
  ].join('\n') });
  ready(h);
  const prompt = choice(h).argv.find((arg) => arg.includes('## Task'));
  assert.match(prompt, /## rEvIeWeR\nREVIEWER-ONLY instruction/);
  assert.match(prompt, /### Probe\nkeep this nested heading/);
  for (const secret of ['BUILDER-HISTORY', 'FAKE-REVIEWER', 'SHARED-HISTORY']) assert.ok(!prompt.includes(secret));
});

function commandReviewer(h, out) {
  const script = `const fs = require('node:fs'); const cp = require('node:child_process');
fs.writeFileSync(process.argv[1], process.argv[2]);
const r = cp.spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'evidence', 'T1', '--type', 'review', '--ok', '--sha', ${JSON.stringify(h.sha)}, '--summary', 'reviewed'], {env: process.env});
process.exit(r.status ?? 1);`;
  h.ok(['project', 'set', '--review-policy', 'null']);
  const command = [process.execPath, '-e', script, out, '{prompt}'];
  for (const name of ['easy', 'medium', 'hard', 'research']) {
    h.ok(['ladder', 'set', name, '--harness', 'command', '--clear', 'model', '--clear', 'profile',
      '--clear', 'provider', '--clear', 'effort', '--command', JSON.stringify(command)]);
  }
  h.ok(['ladder', 'set', 'review', '--harness', 'command', '--clear', 'model', '--command', JSON.stringify([process.execPath, '-e', script, out, '{prompt}'])]);
}

test('review dispatch computes its diff once outside the state lock', (t) => {
  const h = setup(t);
  ready(h);
  commandReviewer(h, path.join(h.base, 'context.txt'));
  const report = path.join(h.base, 'diff-calls.jsonl');
  h.json(['spawn', '--task', 'T1', '--role', 'review', '--wait'], {
    hooks: { HOOK_REVIEW_DIFF_REPORT: report },
  });
  const calls = fs.readFileSync(report, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ({ locked: false })));
});

test('review dispatch refuses a submitted head or configured base changed after diff preparation', async (t) => {
  for (const change of ['head', 'base']) {
    const h = setup(t);
    h.ok(['task', 'update', 'T1', '--kind', 'docs']);
    commandReviewer(h, path.join(h.base, 'context.txt'));
    h.git(['commit', '--allow-empty', '-qm', 'next head']);
    const next = h.git(['rev-parse', 'HEAD']);
    const paused = path.join(h.base, 'diff-ready');
    const running = h.runAsync(['spawn', '--task', 'T1', '--role', 'review', '--wait'], {
      hooks: { HOOK_STOP_REVIEW_DIFF: paused },
    });
    try {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(paused)) {
        assert.ok(Date.now() < deadline, 'diff preparation did not finish');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(!fs.existsSync(path.join(h.state, 'lock')), 'diff preparation leaves state writable');
      if (change === 'head') h.ok(['submit', 'T1', '--agent', 'builder', '--sha', next]);
      else h.ok(['project', 'set', '--base', 'fixture-change']);
    } finally {
      fs.writeFileSync(`${paused}.go`, '');
    }
    const result = await running;
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /changed.*diff.*retry/i);
    const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(!events.some((e) => e.cmd === 'spawn'));
    assert.ok(!fs.existsSync(path.join(h.state, 'reviews')), 'a stale packet is never written');
  }
});

test('accept runs tests, clean and CI before dispatch, and records review pending until a later accept', async (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'review-context.txt');
  commandReviewer(h, out);
  h.ok(['submit', 'T1', '--agent', 'builder', '--sha', h.sha, '--pr', '7']);
  const result = h.json(['accept', 'T1']);
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
  h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(1)"']);
  const failed = h.run(['accept', 'T1', '--cmd', 'node -e "process.exit(1)"']);
  assert.equal(failed.code, 1);
  assert.ok(!fs.existsSync(out));
  assert.ok(!fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').includes('"cmd":"spawn"'));
  assert.equal(h.readState('tasks.json').tasks[0].evidence[0].type, 'tests');
});

test('automatic tests honor owner none mode and forward expensive proof commands', (t) => {
  for (const expensive of [false, true]) {
    const h = setup(t);
    commandReviewer(h, path.join(h.base, 'review-context.txt'));
    h.ok(['project', 'set', '--tests-mode', expensive ? 'prove' : 'none', '--tests-expensive', String(expensive), '--tests-proof-cmd', 'node {tests}']);
    const args = expensive ? ['--cmd', 'node test/value.test.js', '--proof-cmd', 'node {tests}'] : [];
    assert.equal(h.json(['accept', 'T1', ...args]).review_pending, true);
    const evidence = h.readState('tasks.json').tasks[0].evidence.find((e) => e.type === 'tests');
    assert.equal(evidence.tests_mode, expensive ? 'prove' : 'none');
    assert.equal(evidence.ok, true);
  }
});
test('accept reuses an active review and direct dispatch refuses a duplicate', (t) => {
  const h = setup(t);
  ready(h);
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--clear', 'model',
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
  const fullPacket = fs.readFileSync(packet, 'utf8');
  assert.match(fullPacket, /diff --git a\/large.md b\/large.md/);
  assert.match(fullPacket, /## Reviewer\nREVIEWER-ONLY instruction/);
  assert.ok(!fullPacket.includes('WORKER-HISTORY'));
});

test('review policy validates price and diff settings through the CLI', (t) => {
  const h = makeRepo(t);
  h.init();
  for (const bad of [{ prices: { 'openai.gpt-6.1-sol': { input: -1 } } },
    { prices: { sol: prices['openai.gpt-6.1-sol'], 'openai.gpt-6.1-sol': prices['openai.gpt-6.1-sol'] } },
    { small_lines: -1 }, { risk_paths: [3] }, { surprise: true }]) {
    assert.equal(h.run(['project', 'set', '--review-policy', JSON.stringify(bad)]).code, 2);
  }
  h.ok(['project', 'set', '--review-policy', JSON.stringify({ prices: { sol: prices['openai.gpt-6.1-sol'] } })]);
  assert.deepEqual(h.json(['project', 'show']).review.prices, { 'openai.gpt-6.1-sol': prices['openai.gpt-6.1-sol'] });
  for (const [alias, provider] of [['sol', 'openai.gpt-6.1-sol'], ['luna', 'openai.gpt-6-luna'], ['opus', 'claude-opus-5-5']]) {
    const task = h.json(['task', 'add', '--title', alias, '--acceptance', 'usage']);
    const out = h.json(['spend', task.id, '--tokens', '1', '--model', alias]);
    assert.equal(out.spend.entries[0].model, provider);
  }
});

test('review policy and prices require an explicit owner identity', (t) => {
  const h = makeRepo(t);
  const policy = JSON.stringify({ prices });
  const init = h.run(['init', '--name', 'demo', '--goal', 'prove the engine', '--review-policy', policy, '--agent', 'worker']);
  assert.equal(init.code, 1);
  assert.match(init.stderr, /only the owner with an explicit identity/);
  assert.ok(!fs.existsSync(h.state), 'a refused init writes no state');

  h.init();
  const before = h.readState('project.json');
  const denied = h.run(['project', 'set', '--review-policy', policy, '--agent', 'worker']);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /only the owner with an explicit identity/);
  assert.deepEqual(h.readState('project.json'), before);
  assert.equal(h.run(['project', 'set', '--review-policy', 'null', '--agent', 'worker']).code, 1);
  h.ok(['project', 'set', '--review-policy', policy, '--agent', 'owner']);
  assert.deepEqual(h.json(['project', 'show']).review.prices, prices);
});

test('terminal owner fallback cannot change review policy', { skip: !PTY_AVAILABLE }, (t) => {
  const h = makeRepo(t);
  h.init();
  const env = { ...h.env };
  delete env.TOWER_CRANE_AGENT;
  const result = runPty(['project', 'set', '--review-policy', 'null'], { cwd: h.repo, env });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /only the owner with an explicit identity/);
});

test('review uses the nearest base when only origin has it or the local base is stale', (t) => {
  const h = setup(t);
  ready(h);
  const base = h.git(['rev-parse', 'main']);
  h.git(['update-ref', 'refs/remotes/origin/main', base]);
  h.git(['branch', '-D', 'main']);
  assert.match(choice(h).argv.find((arg) => arg.includes('## Task')), /diff --git/);
  h.git(['branch', 'main', `${base}~1`]);
  const prompt = choice(h).argv.find((arg) => arg.includes('## Task'));
  assert.ok(prompt.includes(`Base: ${base}.`));
});
});
