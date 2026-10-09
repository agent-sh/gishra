'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const vm = require('node:vm');

const ALLOWLIST = 'tools/model-literals.json';
const aliases = Object.keys(require('../lib/ladder').BUILTIN.claude_aliases || {})
  .map(alias => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const selection = new RegExp(String.raw`\b(?:claude-[\w.-]+|gpt-[\w.-]+|opus|sonnet|haiku|sol|luna|astra${aliases ? '|' + aliases : ''})\b`, 'i');
function* literals(text) {
  function* scan(i = 0, stop = false) {
    let expression = true;
    while (i < text.length) {
      const char = text[i];
      if (stop && char === '}') return i + 1;
      if (/\s/.test(char)) { i++; continue; }
      if (text.startsWith('//', i)) {
        const end = text.indexOf('\n', i + 2);
        i = end < 0 ? text.length : end + 1;
        continue;
      }
      if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        i = end < 0 ? text.length : end + 2;
        continue;
      }
      if (char === '{') {
        i = yield* scan(i + 1, true);
        expression = true;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        const start = i++;
        let interpolated = false;
        while (i < text.length && text[i] !== char) {
          if (text[i] === '\\') { i += 2; continue; }
          if (char === '`' && text.startsWith('${', i)) {
            interpolated = true;
            i = yield* scan(i + 2, true);
          } else i++;
        }
        const raw = text.slice(start, ++i);
        if (!interpolated) yield { raw, index: start };
        expression = false;
        continue;
      }
      if (char === '/' && expression) {
        // Regular expressions contain characters that resemble quotes and comments.
        let bracket = false;
        i++;
        while (i < text.length) {
          const next = text[i++];
          if (next === '\\') { i++; continue; }
          if (next === '[') bracket = true;
          if (next === ']') bracket = false;
          if (next === '/' && !bracket) break;
        }
        while (/[a-z]/i.test(text[i] || '')) i++;
        expression = false;
        continue;
      }
      const word = /^[\w$]+/.exec(text.slice(i));
      if (word) {
        i += word[0].length;
        expression = /^(?:return|throw|case|typeof|void|delete|yield|await|in|of)$/.test(word[0]);
      } else {
        expression = /[=(:,[!&|?{};+\-*%<>]/.test(char);
        i++;
      }
    }
    return i;
  }
  yield* scan();
}

function modelSelections(root, env = process.env) {
  const files = cp.execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, env, encoding: 'utf8' }).split('\0').filter(Boolean);
  const allowfile = path.join(root, ALLOWLIST);
  const entries = fs.existsSync(allowfile) ? JSON.parse(fs.readFileSync(allowfile, 'utf8')) : [];
  if (!Array.isArray(entries) || entries.some(entry => !entry
    || typeof entry.path !== 'string' || !entry.path
    || typeof entry.literal !== 'string'
    || typeof entry.reason !== 'string' || !entry.reason.trim())) {
    throw new Error(`${ALLOWLIST}: each entry requires an exact path, literal and reason`);
  }
  const allowed = new Set(entries.map(entry => JSON.stringify([entry.path, entry.literal])));
  const violations = [];
  const context = vm.createContext(Object.create(null));
  for (const file of new Set(files)) {
    const code = /^(?:lib|bin)\/.*\.(?:js|cjs|mjs)$/.test(file);
    const json = file.endsWith('.json') && !/^(?:docs|changelog\.d)\//.test(file) && file !== ALLOWLIST;
    if (!code && !json) continue;
    let text = fs.readFileSync(path.join(root, file), 'utf8');
    if (file === 'lib/ladder.js') {
      text = text.replace(/const BUILTIN = \{[\s\S]*?\n\};/, block => block.replace(/[^\r\n]/g, ' '));
    }
    for (const token of literals(text)) {
      const raw = token.raw;
      // The token grammar admits only a quoted literal, never an expression.
      let literal;
      try { literal = vm.runInContext(raw, context); }
      catch (error) { throw new Error(`${file}:${text.slice(0, token.index).split('\n').length}: ${error.message}`); }
      const match = literal.match(selection);
      if (!match || allowed.has(JSON.stringify([file, literal]))) continue;
      const line = text.slice(0, token.index).split('\n').length;
      violations.push(`${file}:${line}: ${match[0]}`);
    }
  }
  return violations;
}

module.exports = { modelSelections, literals };

if (require.main === module) {
  const violations = modelSelections(path.resolve(__dirname, '..'));
  for (const violation of violations) console.error(violation);
  process.exitCode = violations.length ? 1 : 0;
}
