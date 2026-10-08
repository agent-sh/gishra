'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeRepo } = require('./helpers');
const { gateFixture } = require('./gate-helpers');

function setup(t) {
  const h = makeRepo(t);
  h.sha = gateFixture(h);
  h.init(['--repo', 'acme/demo', '--base', 'main', '--workers', '8']);
  // gateFixture's Windows adapter also routes this replacement script.
  fs.writeFileSync(path.join(h.base, 'tools', 'gh'),
    `#!${process.execPath}\nrequire(${JSON.stringify(path.join(__dirname, 'fixtures', 'inbox-gh.js'))});\n`);
  h.env.INBOX_GITHUB = path.join(h.base, 'github.json');
  h.github = () => JSON.parse(fs.readFileSync(h.env.INBOX_GITHUB, 'utf8'));
  h.save = (data) => fs.writeFileSync(h.env.INBOX_GITHUB, JSON.stringify(data));
  h.save({ calls: [], prs: Object.fromEntries([7, 8, 9].map((n) => [n, {
    state: 'OPEN', headRefOid: h.sha, headRefName: 'fixture-change', baseRefName: 'main',
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', url: `https://github.com/acme/demo/pull/${n}`,
  }])) });
  h.add = (title) => {
    const task = h.json(['task', 'add', '--title', title, '--kind', 'docs', '--acceptance', 'works']);
    h.ok(['brief', 'set', task.id, '-'], { input: `${title}\n` });
    return task.id;
  };
  h.submit = (id, pr) => {
    h.ok(['claim', id, '--agent', `worker-${id}`]);
    h.ok(['submit', id, '--sha', h.sha, ...(pr ? ['--pr', String(pr)] : []), '--agent', `worker-${id}`]);
  };
  h.inbox = () => h.json(['inbox', '--agent', 'orchestrator']);
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return h;
}

// Lifecycle fixtures represent processes that exited before the observer
// starts. All task transitions and the resolving actions use the real CLI.
function event(h, task, cmd, detail, agent = 'orchestrator') {
  const e = { id: `fixture-${h.logs().length}`, at: new Date().toISOString(), cmd, agent, task, detail };
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify(e)}\n`);
}

test('one fixture exposes every inbox kind and resolving commands clear their conditions', async (t) => {
  const h = setup(t);
  const review = h.add('Failed review');
  h.submit(review);
  h.ok(['evidence', review, '--type', 'review', '--fail', '--sha', h.sha,
    '--summary', 'Check null before dereferencing.', '--ref', 'https://github.com/acme/demo/pull/1#issuecomment-1', '--agent', 'reviewer']);
  const rework = h.add('Rework without a worker');
  h.submit(rework);
  h.ok(['rework', rework, '--reason', 'base conflict in parser.js']);
  const dead = h.add('Dead claim');
  h.ok(['claim', dead, '--agent', 'gone']);
  event(h, dead, 'spawn', { agent: 'gone', role: 'worker', pid: 2147483647, host: os.hostname() });
  const accepted = h.add('Accepted but not merged');
  h.submit(accepted, 7);
  h.ok(['evidence', accepted, '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
  h.ok(['check', 'ci', accepted]);
  h.ok(['accept', accepted]);
  const revuto = h.add('Revuto finding');
  h.submit(revuto, 8);
  const codeql = h.add('CodeQL finding');
  h.submit(codeql, 9);
  const stall = h.add('Stalled worker');
  h.ok(['claim', stall, '--agent', 'stalled']);
  const claim = h.json(['task', 'show', stall]).claim;
  event(h, stall, 'stall', { agent: 'stalled', until: claim.until, progress_at: claim.since });
  h.ok(['ask', '--question', 'Which API?', '--option', 'A', '--option', 'B', '--blocks', stall]);
  h.ok(['msg', '--to', 'orchestrator', '--task', stall, 'Need API guidance', '--agent', 'messenger']);
  event(h, accepted, 'automation', { phase: 'running', pid: process.pid, ...require('../lib/processes').identity(process.pid) });
  const github = h.github();
  github.revuto = { name: 'revuto', app: { slug: 'revuto-review' }, status: 'completed', conclusion: 'failure', output: { summary: 'Fix bounds' } };
  github.comments = [
    { commit_id: h.sha, user: { login: 'revuto-review[bot]' }, body: 'Check index bounds', path: 'parse.js', line: 8, html_url: 'https://github.com/acme/demo/pull/8#discussion_r8' },
    { commit_id: 'f'.repeat(40), user: { login: 'revuto-review[bot]' }, body: 'stale finding' },
  ];
  github.alerts = { 9: [{ tool: { name: 'CodeQL' }, rule: { id: 'js/injection' }, html_url: 'https://github.com/acme/demo/security/code-scanning/1',
    most_recent_instance: { commit_sha: h.sha, message: { text: 'Untrusted input' }, location: { path: 'query.js', start_line: 3 } } }] };
  h.save(github);
  const inbox = h.inbox();
  const kinds = new Set(inbox.items.map((i) => i.kind));
  for (const kind of ['review_failed', 'rework_ready', 'dead_claim', 'decision', 'accepted_unmerged', 'revuto_failed', 'codeql_alert', 'message', 'stall']) {
    assert.ok(kinds.has(kind), `missing ${kind}: ${JSON.stringify(inbox)}`);
  }
  assert.equal(inbox.executors.length, 1);
  assert.ok(inbox.items.every((i) => i.action.command.startsWith('tower-crane ') && i.action.argv.length));
  assert.match(inbox.items.find((i) => i.kind === 'review_failed').findings, /null/);
  assert.match(inbox.items.find((i) => i.kind === 'rework_ready').reason, /parser.js/);
  assert.equal(inbox.items.find((i) => i.kind === 'revuto_failed').comments.length, 1);
  assert.match(h.ok(['inbox', '--agent', 'orchestrator']), /discussion_r8/);
  h.ok(['rework', '--from-review', review, '--agent', 'orchestrator']);
  assert.match(fs.readFileSync(path.join(h.state, 'briefs', `${review}.md`), 'utf8'), /Check null.*\nhttps:\/\/github.com/s);
  h.ok(['release', '--dead', '--agent', 'orchestrator']);
  h.ok(['answer', 'D1', '--choice', 'A']);
  for (const i of inbox.items.filter((i) => ['message', 'stall'].includes(i.kind))) h.ok([...i.action.argv, '--agent', 'orchestrator']);
  for (const id of [revuto, codeql]) {
    const i = inbox.items.find((i) => i.task === id && i.kind === (id === revuto ? 'revuto_failed' : 'codeql_alert'));
    h.ok([...i.action.argv, '--agent', 'orchestrator']);
  }
  event(h, accepted, 'automation', { phase: 'done' });
  const clean = h.github();
  delete clean.revuto;
  h.save(clean);
  h.ok(['merge', '--accepted', '--agent', 'orchestrator']);
  const merges = h.github().calls.filter((a) => a[1] === 'merge');
  assert.equal(merges.length, 1);
  assert.equal(merges[0][merges[0].indexOf('--match-head-commit') + 1], h.sha);
  const worker = path.join(h.base, 'worker.js');
  fs.writeFileSync(worker, 'setTimeout(() => {}, 60000);\n');
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify([process.execPath, worker, '{prompt}']), '--clear', 'profile', '--clear', 'effort']);
  const dispatch = h.run(['spawn', '--ready', '--agent', 'orchestrator', '--json']);
  assert.equal(dispatch.code, 0, dispatch.stdout + dispatch.stderr);
  const spawned = JSON.parse(dispatch.stdout);
  assert.equal(spawned.results.length, 5);
  assert.ok(spawned.results.every((r) => r.ok));
  assert.equal(h.inbox().items.length, 0);
  assert.deepEqual(h.json(['spawn', '--ready', '--agent', 'orchestrator']).results, []);
});

test('review replacement, capped revuto, old CodeQL heads and unavailable GitHub remain explicit', (t) => {
  const h = setup(t);
  const id = h.add('Current findings');
  h.submit(id, 8);
  h.ok(['evidence', id, '--type', 'review', '--fail', '--sha', h.sha, '--summary', 'old fail', '--agent', 'reviewer']);
  h.ok(['evidence', id, '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
  assert.equal(h.run(['rework', '--from-review', id]).code, 1);
  h.ok(['project', 'set', '--ci-capped-review', '[{"app":"revuto-review","pattern":"Daily review limit reached"}]']);
  const github = h.github();
  github.revuto = { app: { slug: 'revuto-review' }, status: 'completed', conclusion: 'failure', output: { summary: 'Daily review limit reached' } };
  github.alerts = { 8: [{ tool: { name: 'CodeQL' }, most_recent_instance: { commit_sha: 'f'.repeat(40) } }] };
  h.save(github);
  assert.deepEqual(h.inbox().items, []);
  github.fail = true;
  h.save(github);
  assert.equal(h.inbox().items[0].kind, 'github_error');
  assert.equal(h.run(['inbox', '--agent', 'worker']).code, 1);
  assert.equal(h.run(['release', '--dead', '--agent', 'worker']).code, 1);
  assert.equal(h.run(['spawn', '--ready', '--agent', 'worker']).code, 1);
});

test('ready dispatch respects worker slots and unobservable processes cannot be released or replaced', (t) => {
  const h = setup(t);
  const remote = h.add('Remote claim');
  h.ok(['claim', remote, '--agent', 'remote']);
  event(h, remote, 'spawn', { role: 'worker', agent: 'remote', pid: 2147483647, host: 'another-host.invalid' });
  const unclaimed = h.add('Unclaimed live worker');
  event(h, unclaimed, 'spawn', { role: 'worker', agent: 'live', reserved: true, attempt: 1, pid: process.pid, ...require('../lib/processes').identity(process.pid) });
  h.add('Ready A');
  h.add('Ready B');
  h.ok(['project', 'set', '--workers', '3']);
  const before = h.readState('tasks.json');
  assert.deepEqual(h.json(['release', '--dead', '--agent', 'orchestrator']).results, []);
  assert.deepEqual(h.readState('tasks.json'), before);
  const worker = path.join(h.base, 'worker.js');
  fs.writeFileSync(worker, 'setTimeout(() => {}, 60000);\n');
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify([process.execPath, worker, '{prompt}']), '--clear', 'profile', '--clear', 'effort']);
  const dispatch = h.run(['spawn', '--ready', '--agent', 'orchestrator', '--json']);
  assert.equal(dispatch.code, 0, dispatch.stdout + dispatch.stderr);
  const spawned = JSON.parse(dispatch.stdout);
  assert.deepEqual(spawned.results.map((r) => r.task), ['T3']);
  assert.deepEqual(h.json(['spawn', '--ready', '--agent', 'orchestrator']).results, []);
});

test('MCP tools retain identity, expose actions and reject argument overrides', (t) => {
  const h = setup(t);
  const id = h.add('Review');
  h.submit(id);
  h.ok(['evidence', id, '--type', 'review', '--fail', '--sha', h.sha, '--summary', 'fix bounds', '--agent', 'reviewer']);
  const requests = [
    { method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { method: 'tools/list' },
    { method: 'tools/call', params: { name: 'inbox' } },
    { method: 'tools/call', params: { name: 'rework_from_review', arguments: { id } } },
    { method: 'tools/call', params: { name: 'release_dead' } },
    { method: 'tools/call', params: { name: 'inbox', arguments: { agent: 'owner' } } },
  ];
  const input = requests.map((r, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...r })).join('\n') + '\n';
  const result = h.run(['mcp', '--agent', 'orchestrator'], { input });
  assert.equal(result.code, 0, result.stderr);
  const replies = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies[1].result.tools.length, 5);
  assert.equal(JSON.parse(replies[2].result.content[0].text).items[0].kind, 'review_failed');
  assert.equal(replies[3].result.isError, false);
  assert.equal(replies[4].result.isError, false);
  assert.equal(replies[5].result.isError, true);
  assert.equal(h.json(['task', 'show', id]).status, 'rework');
  assert.equal(h.run(['mcp', '--agent', 'worker'], { input }).code, 1);
});

test('new inbox items wake through wait and unchanged snapshots do not wake twice', (t) => {
  const h = setup(t);
  h.add('Ready');
  const before = fs.statSync(path.join(h.state, 'events.jsonl')).size;
  const args = ['wait', '--inbox', '--observe', '--after', String(before), '--types', 'inbox item', '--timeout', '0.2', '--agent', 'orchestrator'];
  const wake = h.run(args);
  assert.equal(wake.code, 0, wake.stderr);
  assert.equal(JSON.parse(wake.stdout).detail.item, 'ready:T1');
  const after = fs.statSync(path.join(h.state, 'events.jsonl')).size;
  args[args.indexOf('--after') + 1] = String(after);
  assert.equal(h.run(args).code, 2);
});

test('accepted batch skips unknown PRs and merges independent ready PRs with the queue checks', (t) => {
  const h = setup(t);
  for (const pr of [7, 8]) {
    const id = h.add(`PR ${pr}`);
    h.submit(id, pr);
    h.ok(['evidence', id, '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
    h.ok(['check', 'ci', id]);
    h.ok(['accept', id]);
  }
  const submitted = h.add('Unrelated submitted PR');
  h.submit(submitted, 9);
  const github = h.github();
  github.prs[7].mergeable = 'UNKNOWN';
  github.failEndpoint = '/code-scanning/';
  h.save(github);
  const result = h.run(['merge', '--accepted', '--agent', 'orchestrator', '--json']);
  assert.equal(result.code, 1, result.stderr);
  assert.match(JSON.parse(result.stdout).remaining[0].reason, /UNKNOWN/);
  assert.equal(h.github().prs[7].state, 'OPEN');
  assert.equal(h.github().prs[8].state, 'MERGED');
  const ready = h.github();
  ready.prs[7].mergeable = 'MERGEABLE';
  h.save(ready);
  h.ok(['merge', '--accepted', '--agent', 'orchestrator']);
  assert.equal(h.github().prs[7].state, 'MERGED');
});

test('accepted batch routes linked members through pinned stack merges', (t) => {
  const f = require('./stack-fixture').stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { for (const pr of Object.values(d.prs)) Object.assign(pr, { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }); });
  const result = f.h.run(['merge', '--accepted', '--agent', 'orchestrator']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const merges = f.read().calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
  assert.deepEqual(merges.map((c) => c.args[2]), ['11', '12']);
  assert.ok(merges.every((c) => c.args.includes('--merge') && c.args.includes('--match-head-commit')));
  for (const id of ['T1', 'T2']) assert.equal(f.h.json(['task', 'show', id]).evidence.findLast((e) => e.type === 'merge').ok, true);
});

test('GitHub-only findings wake the watcher and endpoint failures retain other findings', (t) => {
  const h = setup(t);
  const id = h.add('Remote review');
  h.submit(id, 8);
  const after = () => String(fs.statSync(path.join(h.state, 'events.jsonl')).size);
  const wait = () => h.run(['wait', '--inbox', '--observe', '--after', after(), '--types', 'inbox item', '--timeout', '0.1', '--agent', 'orchestrator']);
  assert.equal(wait().code, 2);
  const github = h.github();
  github.revuto = { name: 'review', app: { slug: 'revuto-review' }, status: 'completed', conclusion: 'failure', output: { summary: 'Bounds check missing' } };
  github.failEndpoint = '/code-scanning/';
  h.save(github);
  const wake = wait();
  assert.equal(wake.code, 0, wake.stderr);
  assert.equal(JSON.parse(wake.stdout).detail.item, `revuto_failed:${id}`);
  const kinds = h.inbox().items.map((i) => i.kind);
  assert.ok(kinds.includes('revuto_failed'));
  assert.ok(kinds.includes('github_error'));
  assert.equal(wait().code, 2);
});

test('inbox derives an expired native worker stall without a prior watcher', (t) => {
  const h = setup(t);
  const id = h.add('Native worker');
  h.ok(['claim', id, '--agent', 'native', '--lease', '1']);
  const clock = path.join(h.base, 'clock');
  fs.writeFileSync(clock, String(Date.now() + 120000));
  h.env.HOOK_CLOCK_FILE = clock;
  const inbox = h.inbox();
  const stall = inbox.items.find((i) => i.kind === 'stall');
  assert.equal(stall.task, id);
  assert.ok(!inbox.items.some((i) => i.kind === 'dead_claim'));
  h.ok([...stall.action.argv, '--agent', 'orchestrator']);
  assert.ok(!h.inbox().items.some((i) => i.kind === 'stall'));
});
