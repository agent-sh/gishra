'use strict';

// Harness input is data. Identity, task and state come from the protected home.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { binding } = require('./harness-hooks');
const CLI = path.join(__dirname, '..', 'bin', 'tower-crane.js');

function call(file, action, payload = {}) {
  const b = binding(file);
  const r = cp.spawnSync(process.execPath, [
    CLI, 'hook', action, '--binding', file, '--agent', b.agent, '--state', b.state,
    '--payload', '-', '--json',
  ], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (r.status !== 0) throw new Error(r.stderr || r.error?.message || 'harness hook failed');
  return JSON.parse(r.stdout);
}

function main(file, mode) {
  const input = mode === 'codex' ? process.argv[4] || '{}' : fs.readFileSync(0, 'utf8') || '{}';
  const p = JSON.parse(input);
  if (mode === 'codex') {
    call(file, 'report', { report: p['last-assistant-message'] });
    return;
  }
  const event = p.hook_event_name;
  if (event === 'PostToolUse') call(file, 'tool', { tool: p.tool_name });
  const stop = event === 'Stop';
  const out = call(file, stop ? 'stop' : 'inbox', stop ? { report: p.last_assistant_message } : {});
  if (out.block) process.stdout.write(JSON.stringify({ decision: 'block', reason: out.context }) + '\n');
  else if (!stop && out.context) process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: out.context },
  }) + '\n');
}

if (require.main === module) {
  try { main(process.argv[2], process.argv[3]); } catch (e) {
    process.stderr.write(`tower-crane hook: ${e.message}\n`);
    process.exitCode = process.argv[3] === 'codex' ? 1 : 2;
  }
}

module.exports = { call };
