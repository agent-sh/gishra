'use strict';

// Runs the real claude CLI, so it costs a model call and needs a logged-in
// claude: set TOWER_CRANE_LIVE_CLAUDE=1 to run it (TOWER_CRANE_LIVE_MODEL picks the
// model, opus by default). It proves what a stub cannot: a command in a
// spawned agent's sandbox cannot reach a unix socket in a directory the
// sandbox denies, even with the socket filter off.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { makeRepo } = require('./helpers');

const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const runDir = uid === null ? null : `/run/user/${uid}`;
const skip = process.env.TOWER_CRANE_LIVE_CLAUDE !== '1' ? 'set TOWER_CRANE_LIVE_CLAUDE=1 to run against the real claude CLI'
  : !runDir || !fs.existsSync(runDir) ? `${runDir || '/run/user/<uid>'} does not exist here` : false;

test('a sandboxed claude command cannot connect to a unix socket in a denied directory', { skip, timeout: 300000 }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Socket probe', '--acceptance', 'no connection']);
  const sock = path.join(runDir, `tower-crane-probe-${process.pid}.sock`);
  const probe = path.join(h.state, 'socket-probe');
  let connections = 0;
  const server = net.createServer((c) => {
    connections++;
    c.on('error', () => {});
    c.end('HELLO\n');
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  t.after(() => server.close());
  const script = `const n=require("net"),f=require("fs");n.connect(${JSON.stringify(sock)}).on("connect",()=>{f.writeFileSync(${JSON.stringify(probe)},"CONNECTED");process.exit(0)}).on("error",e=>{f.writeFileSync(${JSON.stringify(probe)},"ERR "+e.code);process.exit(1)})`;
  h.ok(['brief', 'set', 'T1', '-'], {
    input: `Sandbox probe set up by the owner. Run exactly this one command with the Bash tool, then reply with its exit code. Do not use tower-crane.\n\nnode -e '${script}'\n`,
  });
  h.ok(['ladder', 'set', 'small', '--harness', 'claude', '--model', process.env.TOWER_CRANE_LIVE_MODEL || 'opus', '--clear', 'profile', '--clear', 'effort']);
  const r = await h.runAsync(['spawn', '--role', 'small', '--task', 'T1', '--wait']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(probe), 'the command ran');
  assert.match(fs.readFileSync(probe, 'utf8'), /^ERR /);
  assert.equal(connections, 0, 'nothing reached the socket');
});
