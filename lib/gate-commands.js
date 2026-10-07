'use strict';

const { isDeepStrictEqual } = require('node:util');

const FIELDS = ['tests_cmd', 'clean_cmd', 'tests_proof_cmd'];

function errors(gates) {
  if (gates == null) return [];
  if (typeof gates !== 'object' || Array.isArray(gates)) return ['project.json gates must be an object'];
  return FIELDS.filter((key) => gates[key] != null
    && (typeof gates[key] !== 'string' || !gates[key].trim() || gates[key].includes('\0')))
    .map((key) => `project.json gates.${key} must be a non-blank command string without NUL bytes or null`);
}

function resolve(project, type) {
  const bad = errors(project.gates);
  if (bad.length) return { error: bad.join('; ') };
  const keys = type === 'tests' ? ['tests_cmd', 'tests_proof_cmd'] : ['clean_cmd'];
  return { policy: Object.fromEntries(keys.map((key) => [key, project.gates?.[key]?.trim() || null])) };
}

function select(project, type, args = {}, mode) {
  const current = resolve(project, type);
  if (current.error) return current;
  const key = `${type}_cmd`;
  const command = current.policy[key];
  if (args.cmd !== undefined && args.cmd.trim() !== command) {
    return { error: `--cmd differs from the pinned project.json gates.${key}; only the owner can change it with project set --${type}-cmd CMD` };
  }
  if (type === 'clean' && process.env.TOWER_CRANE_CLEAN_CMD?.trim()
    && process.env.TOWER_CRANE_CLEAN_CMD.trim() !== command) {
    return { error: 'TOWER_CRANE_CLEAN_CMD differs from the pinned project.json gates.clean_cmd; only the owner can change it with project set --clean-cmd CMD' };
  }
  if (type === 'tests' && args['proof-cmd'] !== undefined
    && args['proof-cmd'].trim() !== current.policy.tests_proof_cmd) {
    return { error: '--proof-cmd differs from the pinned project.json gates.tests_proof_cmd; only the owner can change it with project set --tests-proof-cmd CMD' };
  }
  if (!command && mode !== 'none') {
    return { error: `no ${type === 'tests' ? 'test' : 'cleanup'} command pinned in project.json gates.${key}; the owner must set it with tower-crane project set --${type}-cmd CMD` };
  }
  return { ...current, command };
}

function mismatch(entry, project, task) {
  const type = entry.type;
  const current = resolve(project, type);
  if (current.error) return current.error;
  const remedy = `run tower-crane check ${type} ${task.id} again`;
  if (!isDeepStrictEqual(entry.gate_policy, current.policy)) {
    return `${type} evidence command policy is missing or no longer matches the pinned commands; ${remedy}`;
  }
  if (!entry.commands.every((c) => c && typeof c.command === 'string' && Array.isArray(c.args))) {
    return `${type} command receipts are malformed; ${remedy}`;
  }
  if (type === 'tests' && entry.tests_mode === 'none') {
    return entry.commands.every((c) => c.command === 'git') ? null : `tests mode none has a shell command receipt; ${remedy}`;
  }
  const command = current.policy[`${type}_cmd`];
  const runs = entry.commands.filter((c) => c.command !== 'git');
  const { shellQuote } = require('./gates/common');
  const paths = entry.receipt?.proof_tests;
  const proof = Array.isArray(paths) && paths.length && paths.every((p) => typeof p === 'string' && p)
    && current.policy.tests_proof_cmd?.includes('{tests}')
    ? current.policy.tests_proof_cmd.replaceAll('{tests}', paths.map(shellQuote).join(' ')) : null;
  const matches = type === 'tests'
    ? runs.some((c) => c.command === command && c.status === 0 && !c.signal)
      && runs.every((c) => c.args.length === 0 && (c.command === command || (proof && c.command === proof)))
    : runs.length === 1 && runs.every((c) => {
      const base = /--base=([a-f0-9]{40,64})/.exec(c.command)?.[1];
      return base && c.command === `${command} ${shellQuote(c.cwd)} ${shellQuote(`--base=${base}`)} --json`
        && c.status === 0 && !c.signal && c.args.length === 0;
    });
  return command && matches ? null : `${type} command receipts do not match the pinned command; ${remedy}`;
}

module.exports = { FIELDS, errors, resolve, select, mismatch };
