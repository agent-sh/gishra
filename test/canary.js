'use strict';

// Secret canaries: unique random values placed where an owner keeps secrets
// (rung and project env, an env_file, a harness credential), then searched
// for in every file, event, output and process listing a run leaves. A hit
// names the file and the canary's label, never its value.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');

function make(labels) {
  return Object.fromEntries(labels.map((label) => [label, `tccanary${label.replace(/\W/g, '')}${crypto.randomBytes(12).toString('hex')}`]));
}

function hitsIn(buffer, canaries) {
  return Object.entries(canaries).filter(([, value]) => buffer.includes(value)).map(([label]) => label);
}

// Walks without following links: a home links to the user's credential
// files, which are scanned where they live, as configured sources.
function scanTree(roots, canaries, allow = []) {
  const allowed = new Set(allow.map((f) => path.resolve(f)));
  const hits = [];
  const visit = (file) => {
    let stat;
    try { stat = fs.lstatSync(file); } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      let names;
      try { names = fs.readdirSync(file); } catch (e) {
        if (['ENOENT', 'EACCES', 'EPERM'].includes(e.code)) return;
        throw e;
      }
      for (const name of names) visit(path.join(file, name));
      return;
    }
    if (!stat.isFile() || allowed.has(path.resolve(file))) return;
    let data;
    try { data = fs.readFileSync(file); } catch (e) {
      if (['ENOENT', 'EACCES', 'EPERM'].includes(e.code)) return;
      throw e;
    }
    for (const label of hitsIn(data, canaries)) hits.push({ where: file, label });
  };
  for (const root of [].concat(roots)) visit(root);
  return hits;
}

function scanText(text, canaries, where) {
  return hitsIn(Buffer.from(String(text)), canaries).map((label) => ({ where, label }));
}

// What any process of the same user can list: every visible argv, through
// /proc and through ps -eww.
function processListing() {
  const parts = [];
  if (process.platform === 'linux') {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try { parts.push(fs.readFileSync(`/proc/${name}/cmdline`).toString().replace(/\0/g, ' ')); } catch {
        // Exited while listing.
      }
    }
  }
  if (process.platform !== 'win32') {
    const r = cp.spawnSync('ps', ['-eww', '-o', 'args='], { encoding: 'utf8', timeout: 10000 });
    if (r.status === 0) parts.push(r.stdout);
  }
  return parts.join('\n');
}

function assertNoHits(hits, what) {
  assert.deepEqual(hits.map((h) => `${h.label} in ${h.where}`), [], `secret canaries leaked into ${what}`);
}

module.exports = { make, scanTree, scanText, processListing, assertNoHits };
