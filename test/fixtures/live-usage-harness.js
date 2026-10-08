'use strict';

// A claude or codex stand-in that writes its own session usage over time, the
// way each harness does while it runs: claude appends assistant messages to
// <CLAUDE_CONFIG_DIR>/projects/<slug>/<session id>.jsonl, codex appends
// cumulative token_count events to its rollout under CODEX_HOME. Preloaded
// with NODE_OPTIONS, it replaces the harness binary in the supervisor.
// LIVE_STEPS steps of LIVE_STEP_TOKENS tokens, one every LIVE_EVERY ms, then
// it holds for LIVE_HOLD ms, writes LIVE_DONE and exits 0.

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (path.resolve(process.argv[1] || '') !== __filename) {
  const spawn = cp.spawn;
  cp.spawn = function liveHarness(file, args, options) {
    if (['codex', 'claude'].includes(file) && process.env.LIVE_STEPS) {
      return spawn.call(this, process.execPath, [__filename, file, ...args], options);
    }
    return spawn.call(this, file, args, options);
  };
} else {
  const harness = process.argv[2];
  const args = process.argv.slice(3);
  const env = process.env;
  cp.execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'tower-crane.js'), 'claim', env.TOWER_CRANE_TASK], { stdio: 'ignore' });
  const steps = Number(env.LIVE_STEPS);
  const per = Number(env.LIVE_STEP_TOKENS || 1000);
  let file;
  if (harness === 'claude') {
    const id = args[args.indexOf('--session-id') + 1];
    file = path.join(env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
  } else {
    const id = '01a11297-1067-7831-a3bc-2c04eac9aaef';
    console.log(JSON.stringify({ type: 'thread.started', thread_id: id }));
    file = path.join(env.CODEX_HOME, 'sessions', '2026', '10', '07', `rollout-2026-10-07T00-00-00-${id}.jsonl`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let step = 0;
  const write = () => {
    step += 1;
    const output = Math.floor(per / 10);
    const record = harness === 'claude'
      ? { type: 'assistant', message: { id: `msg-${step}`, model: 'live-model', usage: { input_tokens: per - output, output_tokens: output } } }
      : { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
        input_tokens: step * (per - output), cached_input_tokens: 0, output_tokens: step * output, total_tokens: step * per,
      } } } };
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
    if (step < steps) setTimeout(write, Number(env.LIVE_EVERY || 100));
    else {
      setTimeout(() => {
        fs.writeFileSync(env.LIVE_DONE, String(step));
        process.exit(0);
      }, Number(env.LIVE_HOLD || 0));
    }
  };
  write();
}
