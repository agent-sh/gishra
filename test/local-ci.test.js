'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeRepo } = require('./helpers');

function fixture(t, script) {
  const h = makeRepo(t);
  h.env.GISHRA_TMP = path.join(h.base, 'gate-tmp');
  h.log = path.join(h.base, 'check.json');
  h.command = [process.execPath, 'ci.js', h.log, 'literal argument; $(exit 1)'];
  h.init(['--ci-local', JSON.stringify({ command: h.command, timeout: 5 })]);
  fs.writeFileSync(path.join(h.repo, 'head.txt'), 'old\n');
  fs.writeFileSync(path.join(h.repo, 'ci.js'), script || `
const fs = require('node:fs');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
assert.equal(fs.readFileSync('head.txt', 'utf8'), 'new\\n');
assert.equal(fs.readFileSync('base.txt', 'utf8'), 'base\\n');
fs.writeFileSync(process.argv[2], JSON.stringify({
  cwd: process.cwd(), argument: process.argv[3],
  head: cp.execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim()
}));
`);
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base checker']);
  h.git(['switch', '-qc', 'local-change']);
  fs.writeFileSync(path.join(h.repo, 'head.txt'), 'new\n');
  h.git(['commit', '-qam', 'head change']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  fs.writeFileSync(path.join(h.repo, 'base.txt'), 'base\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base advances']);
  h.baseSha = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'local check', '--kind', 'docs', '--acceptance', 'checked']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.sha, '--branch', 'local-change', '--pr', '1']);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
  return h;
}

test('local CI runs argv on the merged tree and records audited evidence without hosted CI', (t) => {
  const h = fixture(t);
  const e = h.json(['check', 'ci', 'T1', '--agent', 'checker']);
  assert.equal(e.ok, true);
  assert.equal(e.source, 'check ci');
  const tree = h.git(['merge-tree', '--write-tree', h.baseSha, h.sha]).split('\n')[0];
  assert.equal(e.receipt.tree_hash, tree);
  assert.equal(e.receipt.head_sha, h.sha);
  assert.equal(e.receipt.base_sha, h.baseSha);
  assert.equal(e.receipt.exit, 0);
  assert.deepEqual(e.receipt.command, h.command);
  assert.equal(e.receipt.timeout, 5);
  assert.ok(e.receipt.duration_ms >= 0);
  const entries = require('node:child_process').execFileSync('git', ['ls-tree', '-r', '-z', tree], { cwd: h.repo });
  assert.equal(e.receipt.source_digest, crypto.createHash('sha256').update(entries).digest('hex'));
  const trace = JSON.parse(fs.readFileSync(h.log, 'utf8'));
  assert.equal(trace.head, h.sha);
  assert.equal(trace.argument, h.command[3]);
  assert.ok(trace.cwd.startsWith(h.env.GISHRA_TMP));
  assert.ok(!fs.existsSync(trace.cwd), 'temporary merged worktree removed');
  assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
  assert.equal(fs.readFileSync(path.join(h.repo, 'head.txt'), 'utf8'), 'old\n');
  assert.ok(e.commands.some((c) => c.command === h.command[0] && c.status === 0));
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.findLast((v) => v.cmd === 'check ci').detail.receipt, e.receipt);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  h.ok(['accept', 'T1']);
});

test('local CI receipt for another submitted head cannot satisfy acceptance', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  h.git(['switch', '-q', 'local-change']);
  h.git(['commit', '--allow-empty', '-qm', 'another head with the same tree']);
  const next = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', next]);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', next, '--agent', 'reviewer']);
  assert.equal(h.run(['accept', 'T1']).code, 1);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'ci').ok, false);
  h.ok(['check', 'ci', 'T1']);
  h.ok(['accept', 'T1']);
});

test('local CI receipt for an older merged tree cannot satisfy acceptance or merge', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  fs.writeFileSync(path.join(h.repo, 'later.txt'), 'later\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base advances again']);
  const refused = h.run(['accept', 'T1']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /local CI receipt.*merged tree/);
  h.ok(['check', 'ci', 'T1']);
  h.ok(['accept', 'T1']);
  fs.writeFileSync(path.join(h.repo, 'last.txt'), 'last\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base moves after acceptance']);
  const merge = h.run(['merge', 'T1']);
  assert.equal(merge.code, 1);
  assert.match(merge.stderr, /local CI receipt.*merged tree/);
});

test('local CI receipt edits lose their gate proof and manual verdicts remain refused', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  const doc = h.readState('tasks.json');
  const original = structuredClone(doc);
  for (const patch of [{ head_sha: 'f'.repeat(40) }, { tree_hash: 'e'.repeat(40) }, { source_digest: 'd'.repeat(64) }]) {
    const forged = structuredClone(original);
    Object.assign(forged.tasks[0].evidence.at(-1).receipt, patch);
    h.writeState('tasks.json', forged);
    assert.equal(h.run(['accept', 'T1']).code, 1, JSON.stringify(patch));
  }
  const manual = h.run(['evidence', 'T1', '--type', 'ci', '--ok', '--sha', h.sha]);
  assert.equal(manual.code, 1);
  assert.match(manual.stderr, /only gishra check ci/);
});

test('matching audit copies cannot bind a receipt to another head or tree', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  h.git(['switch', '-q', 'local-change']);
  h.git(['commit', '--allow-empty', '-qm', 'new head for receipt validation']);
  const next = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', next]);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', next, '--agent', 'reviewer']);
  const doc = h.readState('tasks.json');
  const evidence = doc.tasks[0].evidence.findLast((e) => e.type === 'ci');
  const log = path.join(h.state, 'events.jsonl');
  const events = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const event = events.findLast((e) => e.cmd === 'check ci');
  evidence.sha = next;
  event.detail.sha = next;
  const write = () => {
    event.detail.receipt = structuredClone(evidence.receipt);
    h.writeState('tasks.json', doc);
    fs.writeFileSync(log, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  };
  write();
  assert.match(h.run(['accept', 'T1']).stderr, /receipt.*submitted head/);
  evidence.receipt.head_sha = next;
  evidence.receipt.tree_hash = 'f'.repeat(40);
  write();
  assert.match(h.run(['accept', 'T1']).stderr, /receipt.*current merged tree/);
});

test('failed, missing and timed out local commands record failure and clean their worktrees', (t) => {
  for (const [script, command, timeout, pattern] of [
    ['process.exit(7);', null, 5, /exit 7/],
    ['', ['missing-local-check-command'], 5, /not found/],
    ['setInterval(() => {}, 1000);', null, 0.05, /timed out/],
  ]) {
    const h = fixture(t, script || '// no-op\n');
    h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: command || h.command, timeout })]);
    const r = h.run(['check', 'ci', 'T1']);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stdout, pattern);
    assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).ok, false);
    assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
    assert.deepEqual(fs.readdirSync(h.env.GISHRA_TMP), []);
  }
});

test('conflicting merged trees fail before running the local command', (t) => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.repo, 'head.txt'), 'conflict\n');
  h.git(['commit', '-qam', 'base conflicts']);
  const r = h.run(['check', 'ci', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /merge|conflict/);
  assert.ok(!fs.existsSync(h.log));
});

test('changed local CI policy invalidates its earlier receipt', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: h.command, timeout: 10 })]);
  assert.match(h.run(['accept', 'T1']).stderr, /configured command or timeout/);
  h.ok(['check', 'ci', 'T1']);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [...h.command, 'extra'], timeout: 10 })]);
  assert.match(h.run(['accept', 'T1']).stderr, /configured command or timeout/);
  h.ok(['project', 'set', '--ci-local', 'null']);
  assert.equal(h.run(['accept', 'T1']).code, 1);
});

test('tracked changes made by a successful local check cannot pass', (t) => {
  const h = fixture(t, "require('node:fs').writeFileSync('head.txt', 'changed\\n');\n");
  const r = h.run(['check', 'ci', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /changed tracked sources/);
  const e = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(e.receipt.exit, 0);
  assert.equal(e.ok, false);
});

test('a newer fetched base invalidates a local receipt while preserving the local branch', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  fs.writeFileSync(path.join(h.repo, 'remote.txt'), 'remote\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'remote base advances']);
  const remote = h.git(['rev-parse', 'HEAD']);
  h.git(['update-ref', 'refs/remotes/origin/main', remote]);
  h.git(['reset', '--hard', h.baseSha]);
  assert.match(h.run(['accept', 'T1']).stderr, /current merged tree/);
  const e = h.json(['check', 'ci', 'T1']);
  assert.equal(e.receipt.base_sha, remote);
  assert.equal(h.git(['rev-parse', 'main']), h.baseSha);
  h.ok(['accept', 'T1']);
});

test('project settings validate local argv and timeout, preserve CI siblings and allow clearing', (t) => {
  const h = makeRepo(t);
  h.init(['--ci-ignore-apps', '["claude"]']);
  const original = h.readState('project.json');
  for (const local of ['{', '[]', '{}', '{"command":[],"timeout":1}', '{"command":[""],"timeout":1}',
    '{"command":["node",2],"timeout":1}', '{"command":["node"]}', '{"command":["node"],"timeout":0}',
    '{"command":["node"],"timeout":"1"}']) {
    const r = h.run(['project', 'set', '--ci-local', local]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--ci-local/);
    assert.deepEqual(h.readState('project.json'), original);
  }
  const local = { command: ['python3', 'tools/check.py', ''], timeout: 120 };
  const set = h.json(['project', 'set', '--ci-local', JSON.stringify(local)]);
  assert.deepEqual(set.ci, { ignore_apps: ['claude'], local });
  assert.match(h.ok(['project', 'show']), /ci\.local:/);
  const cleared = h.json(['project', 'set', '--ci-local', 'null']);
  assert.deepEqual(cleared, original);
  assert.match(h.ok(['project', 'set', '--help']), /--ci-local JSON/);
});
