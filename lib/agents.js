'use strict';

// Agent files and agent homes. agents/tower-crane-<job>.md says what an agent of
// that job may and may not do. spawn renders it for claude and codex into
// flags and a home of the agent's own, built fresh for every spawn: the
// harness config directory (CLAUDE_CONFIG_DIR, CODEX_HOME) and, inside it,
// the HOME the agent runs with. Nothing the user's harness setup holds loads
// unless it is named here, and one agent cannot leave anything for the next.

const fs = require('node:fs');
const cp = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { refuse } = require('./util');
const S = require('./state');
const L = require('./ladder');
const P = require('./processes');
const TOML = require('./toml');

const ROOT = path.join(__dirname, '..');
const LISTS = ['tools', 'disallowedTools', 'mcpServers', 'skills', 'ghWrite', 'writeOutside', 'codexDisable'];
const OUTSIDE = ['state', 'homes', 'git', 'cache', 'worktrees'];
// File tools that change files; acceptEdits approves them inside the
// worktree only, so they are never pre-approved by name.
const EDITS = ['Edit', 'Write', 'NotebookEdit'];
// What the agent's HOME links to in the user's: git, gh and cloud
// credentials and settings, never a harness's own files.
const HOME_LINKS = ['.gitconfig', '.config/git', '.config/gh', '.aws', '.ssh'];
// Each home records where the user's own files are, so a spawn started from
// inside another agent links to those and never into a parent's home.
const ORIGIN = '.tower-crane-origin.json';

const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

// The frontmatter subset the agent files use: `key: value`, `key: []` and
// block lists of `  - item`.
function parse(text, file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw refuse(`${file} has no frontmatter`);
  const out = {};
  let list = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && list) {
      list.push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) throw refuse(`${file}: cannot read frontmatter line "${line}"`);
    const v = kv[2].trim();
    list = null;
    if (v === '') list = out[kv[1]] = [];
    else if (v === '[]') out[kv[1]] = [];
    else if (v === 'true' || v === 'false') out[kv[1]] = v === 'true';
    else out[kv[1]] = unquote(v);
  }
  const errs = LISTS.filter((k) => !Array.isArray(out[k])).map((k) => `${k} must be a list`);
  for (const k of ['web', 'sandbox']) if (typeof out[k] !== 'boolean') errs.push(`${k} must be true or false`);
  if (!['branch', 'none'].includes(out.gitPush)) errs.push('gitPush must be branch or none');
  if (!['write', 'read'].includes(out.worktree)) errs.push('worktree must be write or read');
  if (Array.isArray(out.mcpServers) && out.mcpServers.length) errs.push('mcpServers must be empty; a rung opts in with its mcp field');
  for (const w of out.writeOutside || []) if (!OUTSIDE.includes(w)) errs.push(`writeOutside: ${w} is not one of ${OUTSIDE.join(', ')}`);
  if (errs.length) throw refuse(`${file}: ${errs.join('; ')}`);
  return { ...out, body: m[2].trim() };
}

function file(job) {
  return path.join(ROOT, 'agents', `tower-crane-${job}.md`);
}

function load(job) {
  const f = file(job);
  let text;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    throw refuse(`no agent file for ${job} at ${f}; reinstall tower-crane`);
  }
  return { ...parse(text, f), file: f };
}

// Skills ship next to lib/, or TOWER_CRANE_PLUGIN_ROOT points at a plugin
// checkout that holds them.
function skillDir(name, env) {
  const dir = path.join(env.TOWER_CRANE_PLUGIN_ROOT || ROOT, 'skills', name);
  return fs.existsSync(dir) ? dir : null;
}

function readText(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
}

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

// The user's own home, claude config and codex home. When spawn runs inside
// another agent, its HOME and harness dirs are that agent's home, whose
// origin file names the user's.
function origin(env) {
  const marked = (dir) => (dir ? readJson(path.join(dir, ORIGIN)) : null);
  const homeMark = marked(os.homedir());
  const home = homeMark ? homeMark.home : os.homedir();
  const claudeMark = marked(env.CLAUDE_CONFIG_DIR);
  let claude;
  if (claudeMark) claude = { dir: claudeMark.claude.dir, json: claudeMark.claude.json };
  else if (env.CLAUDE_CONFIG_DIR) claude = { dir: path.resolve(env.CLAUDE_CONFIG_DIR), json: path.join(path.resolve(env.CLAUDE_CONFIG_DIR), '.claude.json') };
  else if (homeMark) claude = homeMark.claude;
  else claude = { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') };
  const codexMark = marked(env.CODEX_HOME);
  let codex;
  if (codexMark) codex = codexMark.codex;
  else if (env.CODEX_HOME) codex = path.resolve(env.CODEX_HOME);
  else if (homeMark) codex = homeMark.codex;
  else codex = path.join(home, '.codex');
  return { home, claude, codex };
}

function cacheDir(env, home) {
  if (process.platform === 'win32') return env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return env.XDG_CACHE_HOME || path.join(home, '.cache');
}

function instructions(agent, env) {
  const skills = agent.skills.map((s) => [s, skillDir(s, env)]).filter(([, d]) => d);
  return [
    agent.body,
    ...(skills.length ? ['', ...skills.map(([s, d]) => `Skill ${s}: read and follow ${path.join(d, 'SKILL.md')}.`)] : []),
    '',
  ].join('\n');
}

// The directories outside the worktree an agent may write, by writeOutside.
function outsideDirs(agent, ctx) {
  const dirs = [...(ctx.settings?.sandbox.write || [])];
  for (const w of agent.writeOutside) {
    if (w === 'state') dirs.push(ctx.stateDir);
    if (w === 'homes') dirs.push(path.join(ctx.stateDir, 'homes'));
    if (w === 'git') {
      // The repository's git directory and, named on its own, the worktree's
      // admin directory inside it (index, HEAD, FETCH_HEAD): codex keeps a
      // workspace's git directory read-only unless a rule names it.
      const common = S.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], ctx.repo.root);
      if (common) dirs.push(path.resolve(common));
      const own = fs.existsSync(ctx.cwd) ? S.git(['rev-parse', '--path-format=absolute', '--git-dir'], ctx.cwd) : null;
      if (own && (!common || path.resolve(own) !== path.resolve(common))) dirs.push(path.resolve(own));
    }
    if (w === 'cache' && fs.existsSync(cacheDir(ctx.env, ctx.origin.home))) dirs.push(cacheDir(ctx.env, ctx.origin.home));
    if (w === 'worktrees') dirs.push(path.join(path.dirname(ctx.repo.root), `${path.basename(ctx.repo.root).replace(/\.git$/, '')}-worktrees`));
  }
  return dirs.map(resolved);
}

// gh commands that only read, allowed to every role.
const GH_READ = ['pr view', 'pr diff', 'pr checks', 'pr list', 'pr status', 'issue view', 'issue list', 'repo view',
  'run view', 'run list', 'run watch', 'release view', 'release list', 'workflow view', 'workflow list', 'label list',
  'search', 'auth status', 'status'];

// What the git and gh shims allow, from the agent file: git's own commands,
// push to another machine without force on gitPush branch, and gh reads plus
// the writes ghWrite names. Anything else, aliases included, is refused.
function policy(agent) {
  return { gitPush: agent.gitPush, gh: [...GH_READ, ...agent.ghWrite] };
}

// gh keeps a login in the system keyring, which a sandboxed agent cannot
// reach (the sandbox hides the user's D-Bus socket). The token is asked of
// gh when the agent starts and handed to the agent process as GH_TOKEN; it is
// not written to files, argv, dry-run output or events. A token already
// in the spawning environment (GH_TOKEN or GITHUB_TOKEN) passes through as is.
function ghToken(env) {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return {};
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of String(env[pathKey(env)] || '').split(path.delimiter)) {
    // A parent agent's shims are not gh.
    if (!dir || fs.existsSync(path.join(dir, '..', ORIGIN))) continue;
    for (const ext of exts) {
      const gh = path.join(dir, `gh${ext}`);
      if (!fs.existsSync(gh)) continue;
      const r = cp.spawnSync(gh, ['auth', 'token'], { encoding: 'utf8', timeout: 10000, env: { ...env, GH_PROMPT_DISABLED: '1' }, windowsHide: true });
      const token = r.status === 0 ? String(r.stdout).trim() : '';
      return token ? { GH_TOKEN: token } : {};
    }
  }
  return {};
}

const pathKey = (env) => Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

// --- claude -----------------------------------------------------------------

// Settings env that only selects a provider, region or model. A credential in
// the user's settings env is not carried over: it reaches the agent through
// the environment spawn runs in, or a helper command read when claude asks.
const CLAUDE_ENV = /^(CLAUDE_CODE_USE_[A-Z]+|AWS_REGION|AWS_DEFAULT_REGION|AWS_PROFILE|CLOUD_ML_REGION|VERTEX_REGION_[A-Z0-9_]+|ANTHROPIC_VERTEX_PROJECT_ID|ANTHROPIC_(BEDROCK|VERTEX|FOUNDRY)_BASE_URL|ANTHROPIC_FOUNDRY_RESOURCE|ANTHROPIC_MODEL|ANTHROPIC_SMALL_FAST_MODEL(_AWS_REGION)?|ANTHROPIC_DEFAULT_[A-Z]+_MODEL)$/;
// Settings that name a command claude runs to fetch credentials. The home
// names auth-helper.js, which reads and runs the user's command each time, so
// the command (which may hold the credential) is never copied.
const CLAUDE_AUTH = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport'];
const MCP_KEEP = ['type', 'command', 'args', 'url'];

function commandLine(argv) {
  const q = process.platform === 'win32' ? (a) => `"${a}"` : (a) => `'${a.replace(/'/g, `'\\''`)}'`;
  return argv.map(q).join(' ');
}

// Bash runs in claude's own sandbox, and stops the agent when the sandbox
// cannot start. allowAllUnixSockets skips the socket filter, whose seccomp
// helper needs a nested user namespace that many hosts refuse; reads of the
// sockets and key directories an agent has no use for are denied instead.
function claudeSandbox(agent, ctx) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowAllUnixSockets: true, allowLocalBinding: true, allowedDomains: ['*'] },
    filesystem: {
      allowWrite: outsideDirs(agent, ctx),
      denyWrite: [resolved(path.join(ctx.stateDir, 'homes')), ...(agent.worktree === 'read' ? [resolved(ctx.cwd)] : [])],
      denyRead: [
        '/var/run/docker.sock', '/run/docker.sock', ...(uid === null ? [] : [`/run/user/${uid}`]),
        ...(ctx.env.XDG_RUNTIME_DIR && ctx.env.XDG_RUNTIME_DIR !== `/run/user/${uid}` ? [ctx.env.XDG_RUNTIME_DIR] : []),
        path.join(ctx.origin.home, '.ssh'), path.join(ctx.origin.home, '.aws'),
      ],
    },
  };
}

function claude(agent, rung, ctx) {
  const optIn = rung.tools || [];
  const user = ctx.origin.claude;
  const tools = [...new Set([...agent.tools.filter((t) => t !== 'Skill'), ...optIn])];
  const deny = agent.disallowedTools.filter((t) => !optIn.includes(t));
  // Bash is approved because it runs in claude's sandbox (settings.json).
  const allow = tools.filter((t) => !EDITS.includes(t));
  const servers = {};
  if (rung.mcp && rung.mcp.length) {
    const defined = (readJson(user.json) || {}).mcpServers || {};
    for (const name of rung.mcp) {
      const def = Object.prototype.hasOwnProperty.call(defined, name) ? defined[name] : null;
      if (!def) throw refuse(`ladder ${ctx.rungName} opts in MCP server ${name}, but ${user.json} defines none by that name`);
      servers[name] = Object.fromEntries(MCP_KEEP.filter((k) => def[k] !== undefined).map((k) => [k, def[k]]));
    }
  }
  // An opted-in server's tools are approved with it; print mode would deny
  // them otherwise.
  allow.push(...Object.keys(servers).map((n) => `mcp__${n}`));
  const home = ctx.home;
  const flags = [
    // Only the generated settings: a repository's .claude/settings.json can
    // carry hooks and plugins too.
    '--setting-sources', 'user',
    '--permission-mode', 'acceptEdits',
    '--tools', tools.join(','),
    ...(allow.length ? ['--allowedTools', allow.join(',')] : []),
    ...(deny.length ? ['--disallowedTools', ...deny] : []),
    '--strict-mcp-config', '--mcp-config', path.join(home, 'mcp.json'),
    '--disable-slash-commands',
  ];
  const write = () => {
    const settingsFile = real(path.join(user.dir, 'settings.json'));
    const settings = (settingsFile && readJson(settingsFile)) || {};
    const own = {};
    const env = Object.fromEntries(Object.entries(settings.env || {}).filter(([k, v]) => CLAUDE_ENV.test(k) && typeof v === 'string'));
    if (Object.keys(env).length) own.env = env;
    for (const k of CLAUDE_AUTH) {
      if (typeof settings[k] === 'string') own[k] = commandLine([process.execPath, path.join(__dirname, 'auth-helper.js'), settingsFile, k]);
    }
    if (agent.sandbox) {
      own.sandbox = claudeSandbox(agent, ctx);
      exclude(ctx.repo.root, '.claude/.cc-writes/');
    }
    put(home, 'settings.json', JSON.stringify(own, null, 2) + '\n');
    put(home, 'mcp.json', JSON.stringify({ mcpServers: servers }, null, 2) + '\n');
    put(home, 'CLAUDE.md', instructions(agent, ctx.env));
    put(home, '.claude.json', '{}\n');
    link(path.join(user.dir, '.credentials.json'), path.join(home, '.credentials.json'));
  };
  return { flags, env: { CLAUDE_CONFIG_DIR: home }, mcp: Object.keys(servers), tools: optIn, write };
}

// claude's sandbox keeps a .claude/.cc-writes/ directory in the worktree; it
// must never be committed.
function exclude(root, pattern) {
  const common = S.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  if (!common) return;
  const f = path.join(common, 'info', 'exclude');
  const text = readText(f) || '';
  if (text.split(/\r?\n/).includes(pattern)) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${text && !text.endsWith('\n') ? '\n' : ''}${pattern}\n`);
}

// --- codex ------------------------------------------------------------------

// Keys that can hold a credential, at any depth of a provider or MCP server.
// Keys that only name an environment variable stay.
const SECRET = /(token|secret|password|passwd|cookie|credential|access_key|api_key|private_key|^auth$|headers$|^query_params$|^env$)/i;
const NAMES_ENV = /(^env_key$|_env_var$|^env_vars$|^env_http_headers$)/;
const secretKey = (k) => SECRET.test(k) && !NAMES_ENV.test(k);

function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (!TOML.isTable(v)) return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !secretKey(k)).map(([k, x]) => [k, scrub(x)]));
}

const pick = (doc) => Object.fromEntries(Object.entries(doc).filter(([k, v]) => L.CODEX_KEYS.includes(k) && !TOML.isTable(v)));
const own = (doc, k) => (TOML.has(doc, k) && TOML.isTable(doc[k]) ? doc[k] : null);

// What of a user codex config file an agent home keeps: the model, provider
// and auth-store keys by name, providers without credential values, legacy
// profiles the same way, and the MCP servers the rung opted in to.
function codexConfig(doc, mcp) {
  const out = pick(doc);
  if (own(doc, 'model_providers')) out.model_providers = scrub(doc.model_providers);
  if (own(doc, 'profiles')) {
    out.profiles = Object.fromEntries(Object.entries(doc.profiles).filter(([, v]) => TOML.isTable(v)).map(([k, v]) => [k, pick(v)]));
  }
  const servers = own(doc, 'mcp_servers') || {};
  const found = mcp.filter((n) => own(servers, n));
  if (found.length) out.mcp_servers = Object.fromEntries(found.map((n) => [n, scrub(servers[n])]));
  return { doc: out, found };
}

function readToml(f) {
  const text = readText(f);
  return text === null ? {} : TOML.parse(text, f);
}

// Authorize branch publishing without an approval prompt. The git shim still
// checks options and refspecs, including force options after the remote.
function codexRules(deny, gitPush) {
  const rules = [];
  if (gitPush === 'branch') rules.push('prefix_rule(\n    pattern = ["git", "push"],\n    decision = "allow",\n)\n');
  for (const d of deny) {
    const m = /^Bash\(([^:*]+):\*\)$/.exec(d);
    if (!m) continue;
    const words = m[1].trim().split(/\s+/);
    rules.push(`prefix_rule(\n    pattern = [${words.map((w) => JSON.stringify(w)).join(', ')}],\n    decision = "forbidden",\n)\n`);
  }
  return rules.join('\n');
}

// The sandbox for the agent's commands: read anywhere, write the worktree
// (or not), the writeOutside directories and the agent's own HOME, never the
// agent homes and their policy files.
function permissions(agent, ctx) {
  const fsRules = { ':root': 'read', ':tmpdir': 'write', ':slash_tmp': 'write' };
  for (const d of outsideDirs(agent, ctx)) fsRules[d] = 'write';
  if (!agent.writeOutside.includes('homes')) fsRules[resolved(path.join(ctx.stateDir, 'homes'))] = 'read';
  fsRules[resolved(path.join(ctx.home, 'home'))] = 'write';
  fsRules[':workspace_roots'] = { '.': agent.worktree };
  return { 'tower-crane': { filesystem: fsRules, network: { enabled: true } } };
}

function codex(agent, rung, ctx) {
  const optIn = rung.tools || [];
  const mcp = rung.mcp || [];
  const user = ctx.origin.codex;
  const home = ctx.home;
  const base = codexConfig(readToml(path.join(user, 'config.toml')), mcp);
  const missing = mcp.filter((n) => !base.found.includes(n));
  if (missing.length) throw refuse(`ladder ${ctx.rungName} opts in MCP server ${missing.join(', ')}, but ${path.join(user, 'config.toml')} defines no [mcp_servers.${missing[0]}]`);
  const webOn = agent.web || optIn.includes('web_search');
  const flags = [
    '-c', `default_permissions="${agent.sandbox ? 'tower-crane' : ':danger-full-access'}"`,
    '-c', 'approval_policy="never"',
    ...(webOn ? [] : ['-c', 'web_search="disabled"']),
    ...agent.codexDisable.filter((f) => !optIn.includes(f)).flatMap((f) => ['--disable', f]),
    ...optIn.filter((t) => t !== 'web_search').flatMap((t) => ['--enable', t]),
  ];
  const write = () => {
    const doc = base.doc;
    if (agent.sandbox) doc.permissions = permissions(agent, ctx);
    put(home, 'config.toml', TOML.stringify(doc) + '\n');
    // Profiles (`-p NAME` layers NAME.config.toml) are filtered the same
    // way; all of them, since a wrapper on PATH may pick one the rung does
    // not name.
    let names = [];
    try {
      names = fs.readdirSync(user).filter((f) => /^[\w.-]+\.config\.toml$/.test(f));
    } catch {
      // No codex home yet.
    }
    for (const f of names) put(home, f, TOML.stringify(codexConfig(readToml(path.join(user, f)), mcp).doc) + '\n');
    put(home, 'AGENTS.md', instructions(agent, ctx.env));
    put(path.join(home, 'rules'), 'tower-crane.rules', codexRules(agent.disallowedTools, agent.gitPush));
    // auth.json holds a login, .env the variables codex loads at start (an
    // AWS profile or bearer token for Bedrock): both are linked.
    for (const f of ['auth.json', '.env']) link(path.join(user, f), path.join(home, f));
    for (const s of agent.skills) {
      const d = skillDir(s, ctx.env);
      if (d) link(d, path.join(home, 'skills', s));
    }
    // Sessions outlive the home, for usage collected after the agent exits.
    const sessions = path.join(ctx.stateDir, 'homes', '.codex', 'sessions');
    fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
    link(sessions, path.join(home, 'sessions'));
  };
  return { flags, env: { CODEX_HOME: home }, mcp, tools: optIn, write, usageRoot: path.join(ctx.stateDir, 'homes', '.codex') };
}

// --- homes ------------------------------------------------------------------

// Homes and everything in them are the user's alone: they link to the
// user's credentials.
function put(dir, name, content, mode = 0o600) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, name);
  fs.writeFileSync(f, content, { mode });
  fs.chmodSync(f, mode);
}

// Sandboxes match the paths they mount, which are real paths: a state
// directory reached through a symlink must be named by its target.
function resolved(p) {
  const r = real(p);
  if (r) return r;
  const parent = path.dirname(p);
  return parent === p ? p : path.join(resolved(parent), path.basename(p));
}

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// Points at the user's file instead of copying it, so a credential is never
// written into the state directory and a refreshed token is seen at once.
// The link goes to the file itself, past any link in a parent agent's home,
// so removing that home never breaks this one. Windows creates directory
// junctions without privileges; a file symlink there needs developer mode,
// so it falls back to a hard link.
function link(target, at) {
  const to = real(target);
  if (!to) return;
  fs.mkdirSync(path.dirname(at), { recursive: true, mode: 0o700 });
  const dir = fs.statSync(to).isDirectory();
  try {
    fs.symlinkSync(to, at, dir && process.platform === 'win32' ? 'junction' : dir ? 'dir' : 'file');
  } catch (e) {
    if (dir || !['EPERM', 'EACCES'].includes(e.code)) throw refuse(`cannot link ${at} to ${to} (${e.code || e.message})`);
    fs.linkSync(to, at);
  }
}

// git and gh on the agent's PATH check every call against the agent file.
function shims(agent, home) {
  const bin = path.join(home, 'bin');
  put(home, 'policy.json', JSON.stringify(policy(agent)) + '\n');
  for (const tool of ['git', 'gh']) {
    const argv = [process.execPath, path.join(__dirname, 'shim.js'), path.join(home, 'policy.json'), bin, tool];
    put(bin, tool, `#!/bin/sh\nexec ${commandLine(argv)} "$@"\n`, 0o700);
    put(bin, `${tool}.cmd`, `@${argv.map((a) => `"${a}"`).join(' ')} %*\r\n`, 0o700);
  }
}

// The HOME the agent runs with: its own, so a harness finds nothing of the
// user's by default (codex reads skills from $HOME/.agents, for one), with
// links to what git, gh and cloud CLIs need.
function agentHome(ctx) {
  const dir = path.join(ctx.home, 'home');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of HOME_LINKS) link(path.join(ctx.origin.home, f), path.join(dir, f));
  return dir;
}

// Removes the homes of agents whose process has exited, and of spawns that
// never started. Runs under the state lock, before a new home is built.
// Nothing links into a home, so removing one never breaks another.
function prune(stateDir) {
  const dir = path.join(stateDir, 'homes');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const last = new Map();
  for (const e of S.readEvents(stateDir)) if (e.cmd === 'spawn' && e.detail && e.detail.agent) last.set(e.detail.agent, e.detail);
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const spawned = last.get(n);
    if (!spawned || P.exited(spawned)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  }
}

const RENDER = { claude, codex };

// The isolation of one spawn on its harness: the flags and env spawn adds and
// a write() that builds the agent's home. Harnesses without a renderer yet
// return null and run as before.
function isolation(job, rung, rungName, ctx) {
  const render = RENDER[rung.harness];
  if (!render) return null;
  const agent = load(job);
  const home = path.join(ctx.stateDir, 'homes', ctx.agent);
  const from = origin(ctx.env);
  const r = render(agent, rung, { ...ctx, rungName, home, origin: from });
  const bin = path.join(home, 'bin');
  const key = pathKey(ctx.env);
  const homeDir = path.join(home, 'home');
  const env = {
    ...r.env, HOME: homeDir, ...(process.platform === 'win32' ? { USERPROFILE: homeDir } : {}),
    [key]: `${bin}${path.delimiter}${ctx.env[key] || ''}`,
  };
  const write = () => {
    const homes = path.join(ctx.stateDir, 'homes');
    fs.mkdirSync(homes, { recursive: true, mode: 0o700 });
    // Homes link to the user's credentials; keep them out of any repository
    // the state directory sits in.
    put(homes, '.gitignore', '*\n');
    prune(ctx.stateDir);
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);
    r.write();
    shims(agent, home);
    agentHome({ ...ctx, home, origin: from });
    const mark = JSON.stringify(from) + '\n';
    put(home, ORIGIN, mark);
    put(homeDir, ORIGIN, mark);
  };
  return { home, agent_file: agent.file, mcp: r.mcp, tools: r.tools, flags: r.flags, env, write, usageRoot: r.usageRoot || null, secretEnv: () => ghToken(ctx.env) };
}

module.exports = { parse, load, file, isolation, origin, codexConfig, codexRules, policy, GH_READ, LISTS };
