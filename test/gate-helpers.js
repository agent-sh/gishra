'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { shellQuote } = require('../lib/gates/common');

// Run the real gates against a small change so acceptance tests need no network or installed scanner.
function gateFixture(h) {
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 0;\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base value']);
  h.git(['switch', '-qc', 'fixture-change']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(h.repo, 'test'));
  fs.writeFileSync(path.join(h.repo, 'test', 'value.test.js'), "require('node:assert/strict').equal(require('../value'), 1);\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'change with regression']);
  const sha = h.git(['rev-parse', 'HEAD']);
  const tools = path.join(h.base, 'tools');
  fs.mkdirSync(tools);
  const scanner = path.join(tools, 'scanner.js');
  fs.writeFileSync(scanner, `console.log(JSON.stringify({ items: process.env.FIXTURE_GATE_OK === '0' ? [{severity: 'HIGH', message: 'fixture finding'}] : [] }));\n`);
  const gh = path.join(tools, 'gh');
  fs.writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FIXTURE_GH_LOG) fs.appendFileSync(process.env.FIXTURE_GH_LOG, JSON.stringify(args) + '\\n');
const merged = process.env.FIXTURE_MERGED;
if (args[0] === 'pr' && args[1] === 'merge') {
  fs.writeFileSync(merged, 'merged');
} else if (args[0] === 'pr') {
  console.log(JSON.stringify({
    headRefOid: process.env.FIXTURE_SHA,
    headRefName: process.env.FIXTURE_PR_HEAD || 'fixture-change',
    state: process.env.FIXTURE_PR_STATE || (fs.existsSync(merged) ? 'MERGED' : 'OPEN'),
    mergeCommit: {oid: process.env.FIXTURE_SHA},
  }));
} else {
  const ok = process.env.FIXTURE_GATE_OK !== '0';
  console.log(JSON.stringify({name: 'fixture', app: 'fixture', status: 'completed', conclusion: ok ? 'success' : 'failure', runs: 1}));
}
`);
  fs.chmodSync(gh, 0o755);
  if (process.platform === 'win32') {
    // Windows cannot execute a shebang stub, so route only gh to the same fixture.
    const preload = path.join(tools, 'gh-preload.js');
    fs.writeFileSync(preload, `const cp = require('node:child_process');
const original = cp.spawnSync;
cp.spawnSync = (command, args, opts) => command === 'gh'
  ? original(process.execPath, [${JSON.stringify(gh)}, ...args], opts)
  : original(command, args, opts);
`);
    h.env.NODE_OPTIONS = `${h.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`;
  }
  // Windows preserves the inherited Path casing in this plain environment object.
  const pathKey = Object.keys(h.env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  Object.assign(h.env, {
    [pathKey]: tools + path.delimiter + (h.env[pathKey] || ''),
    TOWER_CRANE_TMP: path.join(h.base, 'gate-tmp'),
    TOWER_CRANE_CLEAN_CMD: `${shellQuote(process.execPath)} ${shellQuote(scanner)}`,
    FIXTURE_SHA: sha,
    FIXTURE_MERGED: path.join(h.base, 'merged'),
  });
  return sha;
}

function gateEvidence(h, type, agent, ok = true) {
  const args = ['check', type, 'T1', '--agent', agent];
  if (type === 'tests') args.push('--cmd', ok ? 'node test/value.test.js' : 'node -e "process.exit(1)"');
  const r = h.run(args, { env: { FIXTURE_GATE_OK: ok ? '1' : '0' } });
  if (r.code !== (ok ? 0 : 1)) throw new Error(`gate ${type}: ${r.stderr}\n${r.stdout}`);
  return r;
}

module.exports = { gateFixture, gateEvidence };
