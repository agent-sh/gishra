'use strict';

const ROLES = ['worker', 'reviewer'];

function normalizeRole(role) {
  const name = String(role || '').trim().toLowerCase();
  return ROLES.includes(name) ? name : null;
}

function fenceStart(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { char: match[1][0], length: match[1].length };
}

function fenceEnd(line, fence) {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return !!match && match[1][0] === fence.char && match[1].length >= fence.length;
}

function sections(text) {
  const found = { worker: false, reviewer: false };
  const content = { shared: [], worker: [], reviewer: [] };
  let current = 'shared';
  let scoped = false;
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    if (fence) {
      content[current].push(line);
      if (fenceEnd(line, fence)) fence = null;
      continue;
    }
    const start = fenceStart(line);
    if (start) {
      content[current].push(line);
      fence = start;
      continue;
    }
    const heading = /^##[ \t]+(Shared|Worker|Reviewer|Rework notes)[ \t]*$/i.exec(line);
    if (heading) {
      const name = heading[1].toLowerCase();
      current = name === 'worker' || name === 'reviewer' ? name : 'shared';
      if (current !== 'shared') found[current] = true;
      scoped = true;
    }
    content[current].push(line);
  }
  return { content, found, scoped };
}

function forRole(text, role) {
  const name = normalizeRole(role);
  if (!name) return text;
  const parsed = sections(text);
  if (!parsed.scoped) return text;
  return [parsed.content.shared.join('\n').trim(), parsed.content[name].join('\n').trim()]
    .filter(Boolean)
    .join('\n\n');
}

function hasSection(text, role) {
  const name = normalizeRole(role);
  return name ? sections(text).found[name] : false;
}

function roleForAgent(agent) {
  const match = /^(worker|reviewer)(?=$|-)/i.exec(String(agent || '').trim());
  return match ? match[1].toLowerCase() : null;
}

module.exports = { sections, forRole, hasSection, roleForAgent };
