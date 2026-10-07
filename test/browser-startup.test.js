'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo } = require('./helpers');

function attempt(h, chrome, sandbox) {
  const runner = path.join(h.base, 'browser-runner.js');
  fs.writeFileSync(runner, `
const { openBrowser } = require(${JSON.stringify(path.join(__dirname, 'browser.js'))});
const hooks = [];
(async () => {
  let error;
  try { await openBrowser({ after: (fn) => hooks.push(fn) }); }
  catch (e) { error = e.message; }
  finally { for (const hook of hooks.reverse()) await hook(); }
  console.log(JSON.stringify({ error }));
})().catch((e) => { console.error(e); process.exitCode = 1; });
`);
  const r = cp.spawnSync(process.execPath, [runner], {
    env: { ...h.env, TOWER_CRANE_TEST_CHROME: chrome, TOWER_CRANE_TEST_TMP: h.base, TOWER_CRANE_SANDBOX: sandbox, CHROME_REPORT: path.join(h.base, 'chrome.json') },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(r.status, 0, `${r.error || ''}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('a missing browser reports its spawn error and cleans up its profile', (t) => {
  const h = makeRepo(t);
  const result = attempt(h, path.join(h.base, 'missing-chrome'), '1');
  assert.match(result.error, /Chrome.*ENOENT/s);
  assert.deepEqual(fs.readdirSync(h.base).filter((f) => f.startsWith('tower-crane-chrome-')), []);
});

for (const sandbox of ['0', '1']) {
  test(`Chrome startup in sandbox=${sandbox} keeps its files in the temp profile and reports an early exit`, {
    skip: process.platform === 'win32' && 'browser fixture uses a shebang',
  }, (t) => {
    const h = makeRepo(t);
    const chrome = path.join(h.base, 'chrome');
    fs.writeFileSync(chrome, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.CHROME_REPORT, JSON.stringify({
  args: process.argv.slice(2), home: process.env.HOME,
  config: process.env.XDG_CONFIG_HOME, cache: process.env.XDG_CACHE_HOME,
  tmp: process.env.TMPDIR,
}));
console.error('fixture Chrome sandbox failure');
process.exit(23);
`, { mode: 0o755 });
    const result = attempt(h, chrome, sandbox);
    assert.match(result.error, /Chrome.*23.*fixture Chrome sandbox failure/s);
    const seen = JSON.parse(fs.readFileSync(path.join(h.base, 'chrome.json'), 'utf8'));
    assert.equal(seen.args.includes('--no-sandbox'), sandbox === '1');
    assert.equal(seen.args.includes('--disable-dev-shm-usage'), sandbox === '1');
    const profile = seen.args.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    assert.equal(path.dirname(profile), h.base);
    assert.equal(seen.home, profile);
    for (const dir of [seen.config, seen.cache, seen.tmp]) assert.equal(path.dirname(dir), profile);
    assert.equal(fs.existsSync(profile), false, 'even a failed launch removes the profile');
  });
}
