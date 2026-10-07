'use strict';

// Real harness calls cost tokens and need host sandbox access and a login.
// Run this opt-in probe from an unsandboxed session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, ROOT } = require('./helpers');
const { CHROME } = require('./browser');
const { shellQuote } = require('../lib/gates/common');

for (const harness of ['claude', 'codex']) {
  test(`a real sandboxed ${harness} worker runs a board browser test`, {
    skip: process.env.TOWER_CRANE_LIVE_BROWSER !== '1' ? 'set TOWER_CRANE_LIVE_BROWSER=1 to run real sandboxed workers'
      : process.env.TOWER_CRANE_LIVE_BROWSER_HARNESS && process.env.TOWER_CRANE_LIVE_BROWSER_HARNESS !== harness ? 'another harness selected'
        : process.platform !== 'linux' && 'probe requires the Linux command sandbox',
    timeout: 300000,
  }, async (t) => {
    assert.ok(CHROME, 'install Chrome or set TOWER_CRANE_TEST_CHROME; the live probe must not skip the browser test');
    const h = makeRepo(t);
    for (const dir of ['bin', 'lib', 'agents', 'skills', 'standards', 'test']) fs.cpSync(path.join(ROOT, dir), path.join(h.repo, dir), { recursive: true });
    fs.writeFileSync(path.join(h.repo, 'browser-probe.js'), `
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
assert.equal(process.env.TOWER_CRANE_SANDBOX, '1', 'the worker must use the outer sandbox');
const result = cp.spawnSync(process.execPath, [
  '--test', '--test-reporter=tap',
  '--test-name-pattern=^shared restoration reveals nested disclosures',
  path.join(__dirname, 'test', 'board.test.js'),
], { encoding: 'utf8', timeout: 120000 });
fs.writeFileSync(path.join(__dirname, 'browser-probe.json'), JSON.stringify({
  code: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message,
}));
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
assert.equal(result.status, 0, result.error?.message);
assert.match(result.stdout, /# pass 1\\b/);
assert.match(result.stdout, /# fail 0\\b/);
`);
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'board browser probe']);
    h.init();
    h.ok(['task', 'add', '--title', 'Headless Chrome probe', '--acceptance', 'one board browser test passes']);
    const model = harness === 'claude' ? ['--model', process.env.TOWER_CRANE_LIVE_MODEL || 'opus', '--clear', 'profile']
      : ['--profile', process.env.TOWER_CRANE_LIVE_PROFILE || 'sol', '--clear', 'model'];
    h.ok(['ladder', 'set', 'medium', '--harness', harness, ...model, '--clear', 'effort', '--clear', 'args', '--supervision', '{"retries":0}']);
    const wt = h.json(['worktree', 'T1']).path;
    const command = [process.execPath, path.join(wt, 'browser-probe.js')].map(shellQuote).join(' ');
    h.ok(['brief', 'set', 'T1', '-'], {
      input: `This is a live sandbox verification fixture. Run exactly this command with your command tool, report its exit code and stop. Do not change files, use tower-crane, open a PR, or delegate work.\n\n${command}\n`,
    });
    const result = await h.runAsync(['spawn', '--task', 'T1', '--wait'], {
      env: { TOWER_CRANE_TEST_CHROME: CHROME },
    });
    assert.equal(result.code, 0, result.stderr);
    const output = path.join(wt, 'browser-probe.json');
    assert.ok(fs.existsSync(output), `the worker must run the command\n${result.stdout}\n${result.stderr}`);
    const seen = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(seen.code, 0, `${seen.error || ''}\n${seen.stdout}\n${seen.stderr}`);
    assert.match(seen.stdout, /# pass 1\b/);
    assert.match(seen.stdout, /# fail 0\b/);
  });
}
