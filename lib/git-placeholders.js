'use strict';

// A sandbox that masks a path the host does not have leaves an empty read-only
// file there, such as .git/config.lock, and git then cannot take that lock.
// Git creates its locks writable, so an empty file without write bits, named
// like a lock in the git directory and held by no process, is a placeholder.
const fs = require('node:fs');
const path = require('node:path');

// Removes the placeholders in a git directory and logs each one. Nothing is
// removed where /proc cannot show who holds a file.
function clearPlaceholders(commonDir) {
  let names;
  try {
    names = fs.readdirSync(commonDir);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    if (!name.endsWith('.lock')) continue;
    const file = path.join(commonDir, name);
    let st;
    try {
      st = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size !== 0 || st.mode & 0o222 || held(file) !== false) continue;
    try {
      fs.unlinkSync(file);
    } catch {
      continue;
    }
    process.stderr.write(`tower-crane: removed empty read-only placeholder ${file}\n`);
    removed.push(file);
  }
  return removed;
}

// Whether a process has the file open. Null means no process table, so the
// answer is unknown and the caller keeps the file.
function held(file) {
  let pids;
  try {
    pids = fs.readdirSync('/proc');
  } catch {
    return null;
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let fds;
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === file) return true;
      } catch {
        // The descriptor closed while the table was read.
      }
    }
  }
  return false;
}

module.exports = { clearPlaceholders };
