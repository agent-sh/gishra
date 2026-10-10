'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HUNG_TEST_MS = 300000;
function allowed(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      // Generated fixture scripts can begin a line inside a template literal.
      else if (quote === '`' && /^\/\/\s*wait-allow:\s*\S.*$/.test(line.slice(i))
        && !line.slice(i).includes('`')) return true;
    } else if (['"', "'", '`'].includes(char)) quote = char;
    else if (line.slice(i, i + 2) === '//') {
      return /^\/\/\s*wait-allow:\s*\S.*$/.test(line.slice(i));
    }
  }
  return false;
}

// Read call arguments without splitting on commas in callbacks, strings or
// nested calls. This keeps multiline waits subject to the same rule.
function callArguments(text, start) {
  const args = [];
  const stack = [')'];
  let from = start + 1;
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (['"', "'", '`'].includes(char)) { quote = char; continue; }
    if ('([{'.includes(char)) stack.push({ '(': ')', '[': ']', '{': '}' }[char]);
    else if (char === stack.at(-1)) {
      stack.pop();
      if (!stack.length) { args.push(text.slice(from, i).trim()); return args; }
    } else if (char === ',' && stack.length === 1) {
      args.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  return [];
}

function hungBudget(value) {
  return value === 'HUNG_TEST_MS' || Number(value.replaceAll('_', '')) >= HUNG_TEST_MS;
}

function waitFindings(text) {
  const findings = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const report = (index, reason) => {
    if (!allowed(lines[index])) findings.push({ line: index + 1, reason });
  };
  for (const [index, line] of lines.entries()) {
    if (/^\s*\/\//.test(line)) continue;
    // Deadline arithmetic also appears inside generated child scripts.
    const clock = /\b(?:Date|performance)\.now\(\)\s*\+\s*([^;\n]+)/.exec(line);
    if (clock && /\b(?:const|let)\s+\w+\s*=/.test(line)) {
      const budget = clock[1].trim();
      if (!hungBudget(budget)) {
        report(index, 'readiness deadline below the hung-test timeout');
      }
    }
    if (/\b(?:Date|performance)\.now\(\)\s*-\s*\w+\s*[<>]=?\s*\d+/.test(line)) {
      report(index, 'elapsed wall time is a pass condition');
    }
  }
  for (const match of text.matchAll(/\b(setTimeout|until|waitFor\w*|waitUntil)\s*\(/g)) {
    const index = text.slice(0, match.index).split('\n').length - 1;
    if (/^\s*\/\//.test(lines[index])) continue;
    const args = callArguments(text, match.index + match[0].lastIndexOf('('));
    if (match[1] === 'setTimeout') {
      if (!hungBudget(args[1] || '')) report(index, 'timer wait needs a signal or a wait-allow reason');
    } else {
      for (const arg of args.slice(1)) {
        const budget = /^(?:(?:ms|timeout)\s*=\s*)?(\d[\d_]*|ms|timeout)$/.exec(arg)?.[1];
        if (budget && !hungBudget(budget)) report(index, 'wait supplies a fixed readiness budget');
      }
    }
  }
  return findings;
}

function checkTestWaits(root) {
  const dir = path.join(root, 'test');
  if (!fs.existsSync(dir)) return;
  const findings = [];
  for (const name of fs.readdirSync(dir, { recursive: true })) {
    if (!name.endsWith('.js')) continue;
    const file = `test/${name.replaceAll('\\', '/')}`;
    for (const finding of waitFindings(fs.readFileSync(path.join(root, file), 'utf8'))) {
      findings.push(`${file}:${finding.line} ${finding.reason}; use test/signals.js or // wait-allow: reason`);
    }
  }
  if (findings.length) throw new Error(findings.join('\n'));
}

module.exports = { waitFindings, checkTestWaits };
