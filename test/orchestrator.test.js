'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cp = require('node:child_process');
const { makeProjectRepo, BIN } = require('./helpers');

test('one orchestrator session holds writes while reads, release, expiry and owner takeover work', (t) => {
  const h = makeProjectRepo(t);
  const first = { env: { TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'first' } };
  const second = { env: { TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'second' } };
  h.ok(['task', 'add', '--title', 'held task', '--acceptance', 'holds the lease'], first);
  const lease = () => h.readState('tasks.json').orchestrator_lease;
  const held = lease();
  assert.ok(held?.session_id, 'first write must record the session lease');
  assert.ok(held.pid > 0);
  assert.ok(held.host);
  assert.ok(Date.parse(held.heartbeat));
  const before = h.readState('tasks.json');
  const denied = h.run(['task', 'add', '--title', 'duplicate', '--acceptance', 'must refuse'], second);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /orchestrator lease.*first.*pid.*owner.*orchestrator takeover/);
  assert.deepEqual(h.readState('tasks.json'), before);
  h.ok(['task', 'show', 'T1'], second);
  assert.deepEqual(lease(), held, 'another reader cannot renew the holder');
  h.ok(['status'], first);
  assert.ok(Date.parse(lease().heartbeat) > Date.parse(held.heartbeat));
  const releaseDenied = h.run(['orchestrator', 'release'], second);
  assert.equal(releaseDenied.code, 1);
  assert.match(releaseDenied.stderr, /orchestrator lease/);
  const workerDenied = h.run(['orchestrator', 'takeover'], { env: { TOWER_CRANE_AGENT: 'worker' } });
  assert.equal(workerDenied.code, 1);
  assert.match(workerDenied.stderr, /only the owner/);
  const takeoverDenied = h.run(['orchestrator', 'takeover'], second);
  assert.equal(takeoverDenied.code, 1);
  assert.match(takeoverDenied.stderr, /only the owner/);
  h.ok(['orchestrator', 'release'], first);
  assert.equal(lease(), null);
  h.ok(['task', 'note', 'T1', 'second now holds it'], second);
  assert.notEqual(lease().session_id, held.session_id);
  h.ok(['orchestrator', 'takeover']);
  assert.equal(lease(), null);
  h.ok(['task', 'note', 'T1', 'first takes it back'], first);

  const idle = h.readState('project.json').limits.lease_minutes * 60000;
  h.ok(['task', 'note', 'T1', 'stale holder replaced'], { env: {
    ...second.env, TOWER_CRANE_TEST_NOW: String(Date.parse(lease().heartbeat) + idle + 1),
    NODE_OPTIONS: `--require=${JSON.stringify(path.join(__dirname, 'fixtures', 'clock.js'))}`,
  } });
  assert.notEqual(lease().session_id, held.session_id);
  h.ok(['validate'], second);
});

test('two live copies of the same harness session cannot both drive the queue', async (t) => {
  const h = makeProjectRepo(t);
  const env = { ...h.env, TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'resumed-session' };
  const clients = [0, 1].map(() => cp.fork(path.join(__dirname, 'fixtures', 'orchestrator-session.js'),
    [BIN, h.repo], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(() => clients.forEach((client) => client.kill()));
  const run = (client, args) => new Promise((resolve, reject) => {
    client.once('error', reject);
    client.once('message', resolve);
    client.send(args);
  });
  const first = await run(clients[0], ['task', 'add', '--title', 'first copy', '--acceptance', 'one writer']);
  assert.equal(first.code, 0, first.stderr);
  const lease = h.readState('tasks.json').orchestrator_lease;
  const second = await run(clients[1], ['task', 'add', '--title', 'second copy', '--acceptance', 'refused']);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /orchestrator lease.*resumed-session/);
  assert.equal(h.readState('tasks.json').tasks.length, 1);
  assert.equal((await run(clients[1], ['status'])).code, 0, 'competing process can read');
  assert.equal((await run(clients[0], ['task', 'note', 'T1', 'same live process'])).code, 0);
  assert.equal(h.readState('tasks.json').orchestrator_lease.session_id, lease.session_id);
  assert.equal((await run(clients[0], ['orchestrator', 'release'])).code, 0);
  assert.equal((await run(clients[1], ['task', 'note', 'T1', 'released process replaced'])).code, 0);
});
