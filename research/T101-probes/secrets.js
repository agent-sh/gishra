'use strict';
// Secrets handoff and the sandbox a spawned agent gets, through stub harnesses
// (test/fixtures/harness-stub.js) in a scratch home.
const fs = require('node:fs');
const path = require('node:path');
const { H, ROOT, rec, save, out } = require('./lib');

const STUB = path.join(ROOT, 'test', 'fixtures', 'harness-stub.js');
const SECRET = 'T101-PLANTED';

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}
const holding = (dir, needle) => walk(dir).filter((f) => fs.readFileSync(f, 'utf8').includes(needle)).map((f) => path.relative(dir, f));

const h = H.makeRepo();
try {
  h.init();
  h.ok(['task', 'add', '--title', 'Probe', '--acceptance', 'nothing leaks']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'probe\n' });
  const home = path.join(h.base, 'home');
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text);
  };
  put('.cache/some-tool/bin/tool.js', '// an installed tool under the cache\n');
  put('.config/gh/hosts.yml', 'github.com:\n  user: probe\n');
  put('.claude/settings.json', '{}');
  put('.codex/config.toml', [
    'model = "m"', 'model_provider = "p"', '',
    '[model_providers.p]', 'name = "P"',
    `apikey = "${SECRET}-APIKEY"`, `key = "${SECRET}-KEY"`, `bearer = "${SECRET}-BEARER"`, `api_key = "${SECRET}-API_KEY"`, '',
  ].join('\n'));
  put('private.env', `PROBE_FILE_SECRET=${SECRET}-ENVFILE\n`);
  const linkedCredential = path.join(h.base, 'linked-credential.json');
  fs.writeFileSync(linkedCredential, '{"token":"synthetic-linked-credential"}\n');
  fs.symlinkSync(linkedCredential, path.join(home, '.claude', '.credentials.json'));
  const ownerDocker = path.join(h.base, 'owner-docker'), childDocker = path.join(h.base, 'child-docker');
  for (const dir of [ownerDocker, childDocker]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), '{}\n');
  }
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nrequire(${JSON.stringify(STUB)})(${JSON.stringify(name)});\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const path = require('node:path');
if (process.argv[2] === 'auth') { console.log('${SECRET}-GH-TOKEN'); process.exit(0); }
if (process.env.GH_CONFIG_DIR !== path.join(process.env.HOME, '.config', 'gh')) {
  console.error('permission denied reading gh config'); process.exit(1);
}
if (process.env.GH_TOKEN !== '${SECRET}-GH-TOKEN') process.exit(1);
console.log('fake gh');
`, { mode: 0o755 });
  const stubOut = path.join(h.base, 'stub.json');
  const env = { ...h.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_OUT: stubOut,
    GH_TOKEN: '', GITHUB_TOKEN: '', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', XDG_CACHE_HOME: '' };
  for (const key of ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'PI_CODING_AGENT_DIR', 'CARGO_HOME', 'KUBECONFIG',
    'CLOUDSDK_CONFIG', 'AZURE_CONFIG_DIR', 'NPM_CONFIG_USERCONFIG', 'npm_config_userconfig', 'PIP_CONFIG_FILE',
    'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE']) env[key] = '';
  env.DOCKER_CONFIG = ownerDocker;
  env.STUB_RUN = JSON.stringify([['gh', 'pr', 'view', '1']]);
  h.ok(['project', 'set', '--env_file', path.join(home, 'private.env'), '--env',
    JSON.stringify({ DOCKER_CONFIG: childDocker, GH_CONFIG_DIR: path.join(home, '.config', 'gh') })], { env });

  // Claude worker.
  h.ok(['ladder', 'set', 'medium', '--harness', 'claude', '--model', 'opus', '--clear', 'profile', '--clear', 'effort', '--clear', 'args']);
  let r = h.run(['spawn', '--task', 'T1', '--wait', '--json'], { env });
  const report = JSON.parse(fs.readFileSync(stubOut, 'utf8'));
  const sfs = report.settings?.sandbox?.filesystem || {};
  const cache = path.join(home, '.cache');
  rec('S1', 'sandbox', 'tower-crane spawn --task T1 --wait on a claude worker rung (stub); read sandbox.filesystem.allowWrite from the settings the stub loaded',
    'the worker writes its worktree, the git dir and a cache of its own, not the whole user cache that holds installed tools',
    `${out(r).split('\n')[0]}; allowWrite: ${JSON.stringify(sfs.allowWrite)}`, (sfs.allowWrite || []).includes(cache) ? 'CONFIRMED' : 'held');
  const denied = sfs.denyRead || [];
  const credentialPaths = ['.config/gh', '.claude', '.codex', '.docker', '.npmrc', '.netrc', '.git-credentials',
    '.config/tower-crane/config.json', '.pi/agent/auth.json', '.pi/agent/models.json', '.gemini/antigravity/mcp_oauth_tokens.json']
    .map((p) => path.join(home, p)).concat(linkedCredential, ownerDocker, childDocker);
  const reads = ['Read', 'Grep', 'Glob'].map(tool => (report.settings?.permissions?.deny || [])
    .filter(rule => rule.startsWith(`${tool}(//`)).map(rule => rule.slice(tool.length + 2, -1).replace(/\/\*\*$/, '')));
  const covered = (p, dirs) => dirs.some((d) => p === d || p.startsWith(`${d}${path.sep}`));
  const open = credentialPaths.filter((p) => !covered(p, denied) || reads.some(paths => !covered(p, paths)));
  rec('S2', 'sandbox/secrets', 'same spawn: compare sandbox and Read/Grep/Glob denials with default stores, a linked credential target and original/overlaid Docker configs',
    'credential stores in the user home are unreadable inside the sandbox and to the Read tools (network allows every domain)',
    `denyRead: ${JSON.stringify(denied)}; tool deny: ${JSON.stringify(reads)}; network.allowedDomains: ${JSON.stringify(report.settings?.sandbox?.network?.allowedDomains)}; readable: ${open.map((p) => path.relative(home, p)).join(', ')}`,
    open.length ? 'CONFIRMED' : 'held');
  rec('S3', 'secrets', 'same spawn: gh auth token (stub) handed to the agent as GH_TOKEN; run gh pr view with a project GH_CONFIG_DIR override and search state files for the token',
    'the handed token works with the isolated gh config and never reaches a state file',
    `agent saw GH_TOKEN: ${report.ghToken ? 'yes' : 'no'}; gh exit: ${report.ran?.[0]?.code}; state files holding it: ${JSON.stringify(holding(h.state, `${SECRET}-GH-TOKEN`))}`,
    !report.ghToken || report.ran?.[0]?.code !== 0 || holding(h.state, `${SECRET}-GH-TOKEN`).length ? 'CONFIRMED' : 'held');
  rec('S4', 'secrets', 'same spawn with project env_file holding PROBE_FILE_SECRET; search the state directory and the home cache for the value',
    'the value is in no state file, event or receipt', `state files: ${JSON.stringify(holding(h.state, `${SECRET}-ENVFILE`))}; cache files: ${JSON.stringify(holding(cache, `${SECRET}-ENVFILE`))}`,
    holding(h.state, `${SECRET}-ENVFILE`).length || holding(cache, `${SECRET}-ENVFILE`).length ? 'CONFIRMED' : 'held');
  const dry = h.run(['spawn', '--task', 'T1', '--dry-run'], { env });
  rec('S5', 'secrets', 'tower-crane spawn --task T1 --dry-run with the env_file and the gh token available', 'neither value printed',
    `env_file value printed: ${dry.stdout.includes(`${SECRET}-ENVFILE`)}; gh token printed: ${dry.stdout.includes(`${SECRET}-GH-TOKEN`)}`,
    dry.stdout.includes(SECRET) ? 'CONFIRMED' : 'held');

  // Codex worker: provider keys the scrub may miss.
  h.ok(['task', 'add', '--title', 'Probe codex', '--acceptance', 'nothing leaks']);
  h.ok(['brief', 'set', 'T2', '-'], { input: 'probe\n' });
  h.ok(['ladder', 'set', 'medium', '--harness', 'codex', '--profile', 'sol', '--clear', 'model', '--clear', 'effort', '--clear', 'args']);
  put('.codex/sol.config.toml', 'model = "s"\n');
  r = h.run(['spawn', '--task', 'T2', '--wait', '--json'], { env });
  const leaked = holding(h.state, SECRET).filter((f) => !f.startsWith('logs'));
  const which = ['APIKEY', 'KEY"', 'BEARER', 'API_KEY'].filter((k) => walk(h.state).some((f) => fs.readFileSync(f, 'utf8').includes(`${SECRET}-${k}`)));
  rec('S6', 'secrets/redaction', 'codex worker spawn with [model_providers.p] keys apikey, key, bearer and api_key in the user config.toml; search the agent home in the state directory',
    'no credential value is copied into the codex home', `${out(r).split('\n')[0]}; files: ${JSON.stringify(leaked)}; values copied: ${JSON.stringify(which)}`,
    leaked.length ? 'CONFIRMED' : 'held');
} finally {
  save('secrets');
  fs.rmSync(h.base, { recursive: true, force: true });
}
