'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo } = require('./helpers');
const { gateFixture } = require('./gate-helpers');
const { shellQuote } = require('../lib/gates/common');

// A sandboxed worker may write the repository's git directory, so every
// command its config or hooks name is planted here and none may run in git
// the CLI starts.
function plant(h) {
  const marker = path.join(h.base, 'planted');
  const script = path.join(h.base, 'planted.js');
  fs.writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n');\nprocess.stdin.pipe(process.stdout);\n`);
  const cmd = (name) => `${shellQuote(process.execPath)} ${shellQuote(script)} ${name}`;
  const hooks = path.join(h.base, 'hooks');
  fs.mkdirSync(hooks);
  for (const hook of ['post-checkout', 'reference-transaction', 'post-index-change']) {
    fs.writeFileSync(path.join(hooks, hook), `#!/bin/sh\n${cmd(`hook-${hook}`)}\n`, { mode: 0o755 });
  }
  const gitDir = path.join(h.repo, '.git');
  fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), '* filter=tc diff=tc merge=tc\nvalue.js filter=tp\n');
  const settings = {
    'core.fsmonitor': cmd('fsmonitor'),
    'core.hooksPath': hooks,
    'diff.external': cmd('diff-external'),
    'diff.tc.textconv': cmd('textconv'),
    'diff.tc.command': cmd('diff-command'),
    'filter.tc.clean': cmd('filter-clean'),
    'filter.tc.smudge': cmd('filter-smudge'),
    'filter.tc.required': 'true',
    'filter.tp.process': cmd('filter-process'),
    'merge.tc.driver': cmd('merge-driver'),
    'core.sshCommand': cmd('ssh-command'),
    'credential.helper': cmd('credential-helper'),
  };
  for (const [key, value] of Object.entries(settings)) h.git(['config', key, value]);
  return { cmd, ran: () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : []) };
}

// An HTTP origin that asks for credentials, in its own process so the
// synchronous CLI runs below do not block it.
function unauthorizedServer(t) {
  const child = cp.spawn(process.execPath, ['-e', `
    const s = require('node:http').createServer((q, r) => { r.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }); r.end(); });
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));`], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  return new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
}

test('git the CLI and gates run takes no command from repository config or hooks', async (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = gateFixture(h);
  h.ok(['project', 'set', '--tests-cmd', 'node test/value.test.js', '--clean-cmd', h.env.TOWER_CRANE_CLEAN_CMD]);
  for (const title of ['Change', 'Other', 'Ssh', 'Https']) h.ok(['task', 'add', '--title', title, '--acceptance', 'works']);
  h.ok(['brief', 'set', 'T2', '-'], { input: '- change it\n' });
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  h.git(['switch', '-q', 'main']);
  const { cmd, ran } = plant(h);
  const env = { GIT_TERMINAL_PROMPT: '0' };

  h.ok(['worktree', 'T2', '--agent', 'orchestrator'], { env });
  h.ok(['spawn', '--task', 'T2', '--dry-run'], { env });
  for (const type of ['tests', 'clean']) {
    const receipt = h.json(['check', type, 'T1', '--agent', 'checker'], { env: { ...env, TOWER_CRANE_CLEAN_CMD: '' } });
    assert.ok(receipt.commands.some((c) => c.command === 'git' && c.args.includes('worktree')), `${type} checked out the submitted commit`);
  }
  h.ok(['spawn', '--role', 'review', '--task', 'T1', '--dry-run'], { env });
  h.ok(['claim', 'T2', '--agent', 'worker-2']);
  h.ok(['submit', 'T2', '--sha', sha, '--agent', 'worker-2'], { env });
  assert.deepEqual(ran(), []);

  h.git(['remote', 'add', 'origin', 'ssh://git@127.0.0.1:9/acme/demo.git']);
  assert.match(h.run(['worktree', 'T3', '--agent', 'orchestrator'], { env }).stderr, /git fetch origin main failed/);
  assert.deepEqual(ran(), []);

  const port = await unauthorizedServer(t);
  h.git(['remote', 'set-url', 'origin', `http://127.0.0.1:${port}/acme/demo.git`]);
  h.git(['config', `credential.http://127.0.0.1:${port}.helper`, cmd('credential-url-helper')]);
  assert.match(h.run(['worktree', 'T4', '--agent', 'orchestrator'], { env }).stderr, /git fetch origin main failed/);
  assert.deepEqual(ran(), []);
});
