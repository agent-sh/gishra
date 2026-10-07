'use strict';

// Rung and project env values are for the agent process only. Events,
// receipts, the spawn job file and spawn output keep each variable's name
// with MASK as its value; the supervisor receives the values in ENV.

const MASK = '[redacted]';
const ENV = 'TOWER_CRANE_SPAWN_SECRETS';

const table = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Visits every `env` field in document order, which a JSON round trip keeps.
function walk(value, onEnv) {
  if (Array.isArray(value)) return value.map((v) => walk(v, onEnv));
  if (!table(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'env' ? onEnv(v) : walk(v, onEnv)]));
}

const masked = (env) => Object.fromEntries(Object.keys(env).map((k) => [k, MASK]));

// project set records its flags, where --env is still JSON text.
function redact(value) {
  return walk(value, (env) => {
    if (table(env)) return masked(env);
    if (typeof env !== 'string') return env;
    let parsed;
    try { parsed = JSON.parse(env); } catch { return env; }
    return table(parsed) ? JSON.stringify(masked(parsed)) : env;
  });
}

function split(value) {
  const secrets = [];
  const out = walk(value, (env) => {
    if (!table(env)) return env;
    secrets.push(env);
    return masked(env);
  });
  return { value: out, secrets };
}

function join(value, secrets) {
  const left = [...secrets];
  const mismatch = () => new Error('spawn secrets do not match the job');
  const out = walk(value, (env) => {
    if (!table(env)) return env;
    if (!left.length) throw mismatch();
    return left.shift();
  });
  if (left.length) throw mismatch();
  return out;
}

module.exports = { MASK, ENV, redact, split, join };
