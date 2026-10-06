'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseUsage, records } = require('./usage');

function read(file) {
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8'); } catch (e) {
    if (['ENOENT', 'ENOTDIR'].includes(e.code)) return '';
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
  const log = read(spawn.log);
  const session = spawn.harness === 'codex' ? codexSession(spawn.codex_home, sessionId(log)) : '';
  return parseUsage(spawn.harness, log, session);
}

module.exports = { readUsage };
