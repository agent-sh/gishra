'use strict';

const fs = require('node:fs');
const original = fs.openSync;

// Remove the brief just before append opens it, after any earlier existence check.
fs.openSync = function removeBrief(file, flags, ...args) {
  if (file === process.env.TEST_REMOVE_BRIEF
    && (flags === 'a' || (typeof flags === 'number' && (flags & fs.constants.O_APPEND)))) {
    try { fs.unlinkSync(file); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return original.call(this, file, flags, ...args);
};
