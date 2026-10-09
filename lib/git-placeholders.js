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
    if (!placeholder(st) || held(st) !== false || !reap(file, st)) continue;
    process.stderr.write(`tower-crane: removed empty read-only placeholder ${file}\n`);
    removed.push(file);
  }
  return removed;
}

function placeholder(st) {
  return st.isFile() && st.size === 0 && !(st.mode & 0o222);
}

// Git can take a lock at the same name after the checks above, so the file is
// moved aside and checked there. The removal then takes the inode that was
// checked, and a file that is no longer the placeholder goes back.
function reap(file, st) {
  const aside = `${file}.reap-${process.pid}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return false;
  }
  let now;
  try {
    now = fs.lstatSync(aside);
  } catch {
    return false;
  }
  if (now.ino === st.ino && now.dev === st.dev && placeholder(now) && held(st) === false) {
    try {
      fs.unlinkSync(aside);
      return true;
    } catch {
      // Put it back below.
    }
  }
  // A link fails rather than replace a lock that git has taken at the name since.
  try {
    fs.linkSync(aside, file);
    fs.unlinkSync(aside);
  } catch {
    process.stderr.write(`tower-crane: kept ${aside}, ${file} was taken while it was moved aside\n`);
  }
  return false;
}

// Whether a process has the inode open. Matching by device and inode keeps the
// answer independent of how the git directory's path is spelled. Null means no
// process table, so the answer is unknown and the caller keeps the file.
function held(st) {
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
        const open = fs.statSync(`/proc/${pid}/fd/${fd}`);
        if (open.ino === st.ino && open.dev === st.dev) return true;
      } catch {
        // The descriptor closed while the table was read.
      }
    }
  }
  return false;
}

module.exports = { clearPlaceholders };
