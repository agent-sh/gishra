'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseUsage, records } = require('./usage');

function read(file, encoding = 'utf8') {
  const empty = () => encoding ? '' : Buffer.alloc(0);
  if (!file) return empty();
  try { return fs.readFileSync(file, encoding); } catch (e) {
    if (['ENOENT', 'ENOTDIR'].includes(e.code)) return empty();
    throw e;
  }
}

function sessionId(log) {
  const text = /^session id:\s*([a-f0-9-]{36})\s*$/m.exec(log)?.[1];
  return text || records(log).find((r) => r.type === 'thread.started')?.thread_id;
}

function codexSession(root, id) {
  if (!root || !/^[a-f0-9-]{36}$/.test(id || '')) return '';
  // Only rollout files for the exact id printed by this spawn are opened.
  // No config, auth, unrelated transcripts or "most recent" guessing.
  function find(dir) {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
      if (['ENOENT', 'ENOTDIR'].includes(e.code)) return '';
      throw e;
    }
    for (const entry of names) {
      if (entry.isDirectory()) {
        const found = find(path.join(dir, entry.name));
        if (found) return found;
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${id}.jsonl`)) {
        return read(path.join(dir, entry.name));
      }
    }
    return '';
  }
  return find(path.join(root, 'sessions'));
}

function readUsage(spawn) {
  const raw = read(spawn.log, null);
  const log = raw.subarray(spawn.log_start || 0, spawn.log_end ?? raw.length).toString('utf8');
  const root = spawn.codex_home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const session = spawn.harness === 'codex' ? codexSession(root, sessionId(log)) : '';
  return parseUsage(spawn.harness, log, session);
}

module.exports = { readUsage };
