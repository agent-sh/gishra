'use strict';

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

function valid(local) {
  return local && typeof local === 'object' && !Array.isArray(local)
    && Array.isArray(local.command) && local.command.length > 0
    && local.command.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
    && local.command[0].trim()
    && typeof local.timeout === 'number' && Number.isFinite(local.timeout)
    && local.timeout > 0 && local.timeout * 1000 <= 2147483647;
}

// Match dispatch's base selection without fetching during acceptance. A caller fetches before
// checking when it needs fresh remote state; a local base ahead of origin remains authoritative.
function snapshot(root, project, head) {
  if (!root) return { error: 'local CI needs a git repository' };
  const query = (args, encoding = 'utf8') => spawnSync('git', ['-C', root, ...args], {
    encoding, maxBuffer: Infinity, timeout: 60000, windowsHide: true,
  });
  const commit = (ref) => {
    const r = query(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const headSha = commit(head);
  if (!headSha) return { error: `local CI submitted commit ${head} is not available; fetch it and retry` };
  const local = commit(project.base);
  const remote = commit(project.base.startsWith('origin/') ? project.base : `origin/${project.base}`);
  const baseSha = remote && (!local || query(['merge-base', '--is-ancestor', local, remote]).status === 0) ? remote : local;
  if (!baseSha) return { error: `local CI base ${project.base} is not available; fetch it and retry` };
  const merge = query(['merge-tree', '--write-tree', baseSha, headSha]);
  if (merge.error || merge.status !== 0) {
    return { error: `local CI cannot merge ${project.base} with ${headSha.slice(0, 10)}: ${merge.error?.message || merge.stderr.trim() || merge.stdout.trim()}` };
  }
  const tree = merge.stdout.trim().split('\n')[0];
  const entries = query(['ls-tree', '-r', '-z', tree], null);
  if (entries.error || entries.status !== 0) return { error: 'local CI cannot read the merged source tree' };
  return {
    head_sha: headSha, base_sha: baseSha, tree_hash: tree,
    source_digest: createHash('sha256').update(entries.stdout).digest('hex'),
  };
}

function mismatch(receipt, current, local, commands) {
  if (!valid(local)) return 'local CI configuration changed or is invalid; run check ci again';
  if (!receipt || receipt.head_sha !== current.head_sha) return 'local CI receipt does not match the submitted head; run check ci again';
  if (receipt.tree_hash !== current.tree_hash || receipt.source_digest !== current.source_digest) {
    return 'local CI receipt does not match the current merged tree; run check ci again';
  }
  if (!isDeepStrictEqual(receipt.command, local.command) || receipt.timeout !== local.timeout) {
    return 'local CI receipt does not match the configured command or timeout; run check ci again';
  }
  if (receipt.exit !== 0 || receipt.signal || !Number.isFinite(receipt.duration_ms) || receipt.duration_ms < 0) {
    return 'local CI receipt is not a successful command result';
  }
  if (!commands.some((c) => c.command === receipt.command[0] && isDeepStrictEqual(c.args, receipt.command.slice(1))
    && c.status === 0 && !c.signal)) return 'local CI receipt has no matching command execution';
  return null;
}

module.exports = { valid, snapshot, mismatch };
