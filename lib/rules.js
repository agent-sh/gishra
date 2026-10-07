'use strict';

// The house rules a spawned agent works under, named by path so an edit to
// them applies to the next agent: the user's global rules for its harness and
// the AGENTS.md and CLAUDE.md files from the filesystem root down to its
// working directory, plus what those files import with claude's @path syntax.
// A claude or codex agent runs in a home of its own, so its harness finds
// none of the user's global files; claude loads no repository CLAUDE.md under
// --setting-sources user and never reads AGENTS.md, and codex reads AGENTS.md
// only from the git root down. Each file records how the agent gets it:
// `harness` when the harness loads it at start (codex's own AGENTS.md walk,
// claude through the @imports in the home's CLAUDE.md), `read` when the
// prompt asks the agent to read it.

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_FILES = ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')];
// claude follows imports five hops deep.
const IMPORT_DEPTH = 5;

function real(p) {
  try {
    return fs.statSync(p).isFile() ? fs.realpathSync(p) : null;
  } catch {
    return null;
  }
}

function ancestors(dir) {
  const out = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    out.unshift(d);
    if (path.dirname(d) === d) return out;
  }
}

// claude's @path imports: outside code blocks and spans, `~/` from the user's
// home, a relative path from the importing file.
function importsOf(file, home) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const found = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^ {0,3}(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(/(?:^|\s)@(\S+)/g)) {
      const raw = m[1].replace(/[),.;:]+$/, '');
      const fromHome = raw.startsWith('~/');
      const abs = fromHome ? path.join(home, raw.slice(2)) : path.resolve(path.dirname(file), raw);
      if (real(abs)) found.push({ file: abs, fromHome });
    }
  }
  return found;
}

function globalFiles(harness, origin) {
  if (harness === 'claude') {
    let rules = [];
    try {
      rules = fs.readdirSync(path.join(origin.claude.dir, 'rules')).filter((f) => f.endsWith('.md')).sort()
        .map((f) => path.join(origin.claude.dir, 'rules', f));
    } catch {
      // No user rules directory.
    }
    return [path.join(origin.claude.dir, 'CLAUDE.md'), ...rules];
  }
  if (harness === 'codex') {
    const override = path.join(origin.codex, 'AGENTS.override.md');
    return [real(override) ? override : path.join(origin.codex, 'AGENTS.md')];
  }
  // Other harnesses keep the user's HOME and load its global rules themselves.
  return [];
}

// gitRoot is where codex starts its own AGENTS.md walk.
function chain({ harness, cwd, gitRoot, origin }) {
  const seen = new Set();
  const out = [];
  const add = (file, scope, depth = 0, fromHome = false) => {
    const r = real(file);
    if (!r || seen.has(r)) return;
    seen.add(r);
    const nativeCodex = harness === 'codex' && scope === 'project' && /^AGENTS(\.override)?\.md$/.test(path.basename(file))
      && gitRoot && (path.dirname(file) + path.sep).startsWith(path.resolve(gitRoot) + path.sep);
    const loaded = harness === 'claude' && ['global', 'project', 'import'].includes(scope) ? 'harness' : nativeCodex ? 'harness' : 'read';
    out.push({ path: file, scope, bytes: fs.statSync(r).size, loaded, ...(fromHome ? { from_home: true } : {}) });
    if (depth < IMPORT_DEPTH) for (const f of importsOf(r, origin.home)) add(f.file, 'import', depth + 1, f.fromHome);
  };
  for (const f of globalFiles(harness, origin)) add(f, 'global');
  // A harness's own global file found on the walk (~/.claude/CLAUDE.md from
  // the home directory) is another harness's rules, not the project's.
  for (const f of [...globalFiles('claude', origin), ...globalFiles('codex', origin)]) {
    const r = real(f);
    if (r) seen.add(r);
  }
  // Above the repository, a .claude/CLAUDE.md is a harness config directory
  // (the home's is claude's user memory), not project rules.
  const top = gitRoot ? path.resolve(gitRoot) : null;
  for (const dir of ancestors(cwd)) {
    const inRepo = !top || (dir + path.sep).startsWith(top + path.sep);
    for (const name of PROJECT_FILES) if (inRepo || !name.includes(path.sep)) add(path.join(dir, name), 'project');
  }
  return out;
}

const tokens = (bytes) => Math.ceil(bytes / 4);

function summary(files) {
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  return { bytes, tokens: tokens(bytes) };
}

// The lines claude's home CLAUDE.md imports: the top of each chain, since
// claude follows nested imports itself, and each `@~/` import, which claude
// would resolve from the agent's own HOME and miss.
function claudeImports(files) {
  return files.filter((f) => f.scope !== 'import' || f.from_home).map((f) => `@${f.path}`);
}

function section(files) {
  if (!files.length) return '';
  const read = files.some((f) => f.loaded === 'read');
  return [
    '## House rules',
    '',
    'These files hold the rules you work under, general first and nearest last; the owner\'s words in this prompt come first. They are named by path so their current text applies.',
    '',
    ...files.map((f) => `- ${f.path} (${f.scope}, ${f.loaded === 'harness' ? 'loaded in your context' : 'read it'})`),
    ...(read ? ['', 'Read every file marked "read it" before you change anything.'] : []),
  ].join('\n');
}

module.exports = { chain, importsOf, summary, tokens, claudeImports, section, PROJECT_FILES };
