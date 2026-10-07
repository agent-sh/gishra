#!/usr/bin/env node
'use strict';

const OUTPUT_PIPE_CLOSED = 'tower-crane:output-pipe-closed';
let outputPipeClosed = false;

for (const stream of [process.stdout, process.stderr]) {
  let broken = false;
  stream.on('error', (error) => {
    if (error.code === 'EPIPE') {
      broken = true;
      stream.destroy();
      if (!outputPipeClosed) {
        outputPipeClosed = true;
        process.emit(OUTPUT_PIPE_CLOSED);
      }
      return;
    }
    if (!broken) throw error;
  });
}

const { TowerCraneError, usage } = require('../lib/util');
const S = require('../lib/state');
const P = require('../lib/project');
const T = require('../lib/tasks');
const D = require('../lib/decisions');
const R = require('../lib/render');

const str = (arg, help) => ({ type: 'string', arg, help });
const int = (arg, help) => ({ type: 'int', arg, help });
const num = (arg, help) => ({ type: 'number', arg, help });
const many = (arg, help) => ({ type: 'multi', arg, help });
const bool = (help) => ({ type: 'bool', help });
const SPAWN_SETTINGS = {
  sandbox: str('JSON', 'owner only: {write: extra writable paths}; project set accepts null to clear'),
  env: str('JSON', 'owner only: extra environment variables; use env_file for secrets; project set accepts null to clear'),
  env_file: str('FILE', 'owner only: systemd-quoted env file read only at spawn; project set accepts null to clear'),
  scope: str('JSON', 'owner only: systemd user scope properties, e.g. {CPUQuota: "200%", MemoryMax: "8G"}; {} disables, project set accepts null to clear'),
};

const GLOBAL = {
  state: str('DIR', 'state directory (default: TOWER_CRANE_STATE, then .tower-crane/ in the main checkout)'),
  agent: str('NAME', 'who is acting (default: TOWER_CRANE_AGENT; owner only on an interactive terminal outside a task)'),
  json: bool('machine output on stdout'),
  help: bool('show help'),
};

const SETTINGS = {
  ...SPAWN_SETTINGS,
  name: str('N', 'project name'),
  goal: str('G', 'one-line goal'),
  repo: str('O/R', 'GitHub repository (default: from the origin remote)'),
  base: str('B', 'base branch for task branches (default: the current branch)'),
  workers: int('N', 'tasks in progress at once, counting live leases (default 6)'),
  'lease-minutes': int('MIN', 'default claim lease (default 60)'),
  'budget-hours': num('H', 'hours budget'),
  'budget-tokens': int('N', 'token budget'),
  standards: str('S', '"default" or a path to a standards Markdown file'),
  'tests-paths': str('JSON', 'owner only: non-empty array of test path globs; null restores default layouts'),
  'tests-keep': str('JSON', 'owner only: extra build file globs to keep at submitted sha; [] or null restores defaults'),
  'tests-mode': str('MODE', 'owner only: prove, run-only or none; null restores prove'),
  'tests-by-kind': str('JSON', 'owner only: task kind to tests mode overrides; null clears overrides'),
  'tests-expensive': str('JSON', 'owner only: true runs the full suite once with scoped proof; false or null restores normal proof'),
  'ci-ignore-apps': str('JSON', 'array of GitHub app slugs to skip; [] or null clears the list'),
  'ci-required': str('JSON', 'array of required check-run names or prefixes; [] or null clears the list'),
  'ci-local': str('JSON', 'local CI {command: argv, timeout: seconds, by_kind?: overrides}; null restores hosted CI'),
  'merge-keep-branch': str('JSON', 'true keeps merged task branches for retained worktrees; false or null restores deletion'),
  'merge-admin': str('JSON', 'owner only: true uses gh --admin for solely owned repos; false or null disables it'),
  'review-policy': str('JSON', 'owner-only review diff limits and canonical model prices; null clears the policy'),
};

const TASK_FIELDS = {
  title: str('T', 'what the task is'),
  acceptance: many('A', 'how to tell it is done; repeat for more lines'),
  kind: str('K', 'code, docs, research, design or ops (default code)'),
  size: str('S', 'S (under an hour), M (a few hours) or L (a day); default M'),
  dep: many('ID', 'a task this one depends on; repeat for more'),
  tier: str('T', 'easy, medium, hard or research: the ladder rung that does it (default: research for kind research, else S easy, M medium, L hard)'),
  'needs-owner': str('REASON', 'what the owner has to do first'),
};

const RUNG_FLAGS = {
  ...SPAWN_SETTINGS,
  harness: str('H', 'claude, codex, opencode, agy, pi or command (default: the ladder\'s default harness)'),
  model: str('M', 'model id'),
  profile: str('P', 'codex profile'),
  provider: str('P', 'pi provider'),
  effort: str('E', 'reasoning effort, in the harness\'s own terms'),
  args: str('JSON', 'extra arguments appended to the harness command, as a JSON array'),
  command: str('JSON', 'for the command harness: argv array; {task} {brief} {prompt} {cwd} are substituted'),
  supervision: str('JSON', 'retry, backoff, stall and progress path settings as a JSON object'),
  tools: str('JSON', 'claude or codex: tools the agent file denies that this rung opts back in to (claude tool names, codex features), as a JSON array'),
  mcp: str('JSON', 'claude or codex: MCP servers from your harness config this rung opts in to, by name, as a JSON array'),
  clear: many('FIELD', 'remove a field from the rung (a cleared harness follows the default)'),
};

const run = (mod, fn) => (ctx) => require(mod)[fn](ctx);
const gate = (name) => (ctx) => require('../lib/check').runGate(ctx, name);

const COMMANDS = [
  { section: 'Plan', name: 'init', usage: '--name N --goal G [--repo O/R] [--base B] [settings]', summary: 'create the state directory and project.json with the default ladder', flags: SETTINGS, required: ['name', 'goal'], run: P.init },
  { section: 'Plan', name: 'project set', usage: '[--name N] [--goal G] [--repo O/R] [--base B] [--workers N] [--lease-minutes MIN] [--budget-hours H] [--budget-tokens N] [--standards S] [--tests-paths JSON] [--tests-keep JSON] [--tests-mode MODE] [--tests-by-kind JSON] [--tests-expensive JSON] [--ci-ignore-apps JSON] [--ci-required JSON] [--ci-local JSON] [--merge-keep-branch JSON] [--merge-admin JSON] [--review-policy JSON] [--sandbox JSON] [--env JSON] [--env_file FILE] [--scope JSON]', summary: 'change project settings, limits and budget', flags: SETTINGS, run: P.projectSet },
  { section: 'Plan', name: 'project show', summary: 'print project settings and the ladder', run: P.projectShow },
  { section: 'Plan', name: 'ladder show', summary: 'print each rung as it resolves, and where it comes from (project, user file or built-in)', run: P.ladderShow },
  { section: 'Plan', name: 'ladder set', pos: ['RUNG'], usage: 'RUNG [--harness H] [--model M] [--profile P] [--provider P] [--effort E] [--args JSON] [--command JSON] [--supervision JSON] [--tools JSON] [--mcp JSON] [--sandbox JSON] [--env JSON] [--env_file FILE] [--scope JSON] [--clear FIELD]...', summary: 'change fields of one rung: orchestrator, easy, medium, hard, research, review or small', flags: RUNG_FLAGS, run: P.ladderSet },
  { section: 'Plan', name: 'ladder harness', pos: ['HARNESS'], usage: 'HARNESS', summary: 'set the default harness every rung without its own runs on', run: P.ladderHarness },
  { section: 'Plan', name: 'ladder save-user', summary: "write this project's ladder to the user file, the default for new projects", run: P.ladderSaveUser },
  { section: 'Plan', name: 'task add', usage: '--title T --acceptance A [--acceptance A2] [--kind K] [--size S] [--tier T] [--dep ID] [--needs-owner REASON]', summary: 'add a task; prints its id', flags: TASK_FIELDS, required: ['title', 'acceptance'], run: T.taskAdd },
  { section: 'Plan', name: 'task update', pos: ['ID'], usage: 'ID [--title T] [--acceptance A]... [--dep ID]... [--size S] [--kind K] [--tier T] [--needs-owner REASON] [--ci-local JSON] [--status cancelled]', summary: "change a task; acceptance or dependency changes bump its revision (--dep '' clears dependencies); an accepted task's acceptance, dependencies, kind and local CI override wait for rework", flags: { ...TASK_FIELDS, acceptance: many('A', 'replaces all acceptance lines'), dep: many('ID', "replaces all dependencies; '' clears them"), 'needs-owner': str('REASON', "what the owner has to do; '' clears it; clearing or replacing an existing request requires explicit owner identity"), 'ci-local': str('JSON', 'owner only: local CI override with command or args and optional timeout; null restores kind or default policy'), status: str('cancelled', 'cancel the task') }, run: T.taskUpdate },
  { section: 'Plan', name: 'task note', pos: ['ID', 'TEXT...'], usage: 'ID TEXT', summary: 'append a note', run: T.taskNote },
  { section: 'Plan', name: 'task show', pos: ['ID'], usage: 'ID', summary: 'show one task with its gates, evidence and notes', run: T.taskShow },
  { section: 'Plan', name: 'task list', usage: '[--status S]', summary: 'list tasks (S: a status, ready or blocked)', flags: { status: str('S', 'todo, in_progress, submitted, accepted, rework, cancelled, ready or blocked') }, run: T.taskList },
  { section: 'Plan', name: 'plan import', pos: ['FILE'], usage: 'FILE', summary: 'add tasks from a JSON array (ids may be local names, resolved in order; - reads stdin)', run: T.planImport },
  { section: 'Plan', name: 'brief set', pos: ['ID', '[-]'], usage: 'ID (--file F | -)', summary: "write the task's brief; warn when reviewer text has no worker section", flags: { file: str('F', 'read the brief from F') }, run: T.briefSet },
  { section: 'Plan', name: 'brief get', pos: ['ID'], usage: 'ID [--role worker|reviewer]', summary: "print the full or role-filtered task brief", flags: { role: str('ROLE', 'select worker or reviewer text; otherwise infer from the agent name') }, run: T.briefGet },
  { section: 'Plan', name: 'validate', summary: 'report plan and ladder errors (exit 1 if any); warn when an open task has no runnable reviewer', run: T.validate },

  { section: 'Run', name: 'ready', usage: '[--all]', summary: 'ready tasks, those that unblock the most first; --all adds blocked ones with the reason', flags: { all: bool('also list blocked tasks and why') }, run: T.ready },
  { section: 'Run', name: 'claim', pos: ['ID'], usage: 'ID [--lease MIN]', summary: 'take a ready task for --agent', flags: { lease: int('MIN', 'lease length (default limits.lease_minutes)') }, run: T.claim },
  { section: 'Run', name: 'renew', pos: ['ID'], usage: 'ID [--lease MIN]', summary: 'extend your lease; an expired one only while the workers limit has room', flags: { lease: int('MIN', 'new lease length from now') }, run: T.renew },
  { section: 'Run', name: 'release', pos: ['ID'], usage: 'ID --reason R', summary: 'give a claimed task back; it returns to todo or rework', flags: { reason: str('R', 'why') }, required: ['reason'], run: T.release },
  { section: 'Run', name: 'submit', pos: ['ID'], usage: 'ID --sha S [--branch B] [--pr N] [--summary T]', summary: 'mark submitted as the claimant or replace a submitted head as its submitter', flags: { sha: str('S', 'commit to review'), branch: str('B', 'branch holding it'), pr: int('N', 'pull request number'), summary: str('T', 'what changed') }, required: ['sha'], run: T.submit },
  { section: 'Run', name: 'evidence', pos: ['ID'], usage: 'ID --type T (--ok | --fail) [--sha S] [--summary T] [--ref URL]', summary: 'record review or note evidence; review needs --sha, note defaults to the submitted sha', flags: { type: str('T', 'review or note; tests, clean, ci and merge require gate commands'), ok: bool('it passed'), fail: bool('it failed'), sha: str('S', 'commit the evidence is about; required for review'), summary: str('T', 'one line'), ref: str('URL', 'link to the run, review or log') }, required: ['type'], run: T.evidence },
  { section: 'Run', name: 'accept', pos: ['ID'], usage: 'ID [--cmd CMD] [--proof-cmd CMD] [--waive TYPE --reason R]', summary: 'run missing software gates, dispatch review when green, accept when all gates pass', flags: { cmd: str('CMD', 'test command for a missing tests gate'), 'proof-cmd': str('CMD', 'expensive prove: scoped test command with {tests}'), waive: many('TYPE', 'owner only: waive tests, clean, review or ci'), reason: str('R', 'why the waived gate does not apply') }, run: T.accept },
  { section: 'Run', name: 'rework', pos: ['ID'], usage: 'ID --reason R', summary: "send back; the reason goes into the brief's rework notes", flags: { reason: str('R', 'what to fix') }, required: ['reason'], run: T.rework },
  { section: 'Run', name: 'spend', pos: ['ID'], usage: 'ID [--minutes N] [--tokens N] [--input N] [--cached N] [--cache-write N] [--output N] [--rung R] [--harness H] [--model M] [--from-spawn AGENT]', summary: 'record usage or collect an exited spawn once', flags: {
    minutes: int('N', 'minutes spent'), tokens: int('N', 'total tokens, including cached input'),
    input: int('N', 'input tokens, including cached input'), cached: int('N', 'cache read tokens (subset of input)'),
    output: int('N', 'output tokens, including reasoning'), rung: str('R', 'ladder rung for native usage'),
    harness: str('H', 'actual harness (default: rung harness)'), model: str('M', 'actual model (default: rung model)'),
    'cache-write': int('N', 'cache write input tokens, included in --input and separate from --cached'),
    'from-spawn': str('AGENT', 'collect an exited spawn from its captured log and session, once'),
  }, run: T.spend },
  { section: 'Run', name: 'owner-done', pos: ['ID'], usage: 'ID [--note T]', summary: 'the owner did what needs_owner asked; clears it', flags: { note: str('T', 'what was done') }, run: T.ownerDone },
  { section: 'Run', name: 'wait', usage: '[--after CURSOR] [--for NAME] [--task ID] [--types TYPES] [--timeout SEC]', summary: 'block until one matching event; print one JSON line (timeout exits 2)', flags: { after: str('CURSOR', 'event id or byte offset (default now)'), for: str('NAME', 'recipient (default orchestrator)'), task: str('ID', 'only this task or decisions blocking it'), types: str('TYPES', 'comma-separated event types'), timeout: num('SEC', 'maximum wait in seconds') }, run: run('../lib/events', 'wait') },
  { section: 'Run', name: 'msg', pos: ['TEXT...'], usage: '--to NAME [--task ID] TEXT', summary: 'send a worker message through the event log', flags: { to: str('NAME', 'recipient, usually orchestrator'), task: str('ID', 'task (default TOWER_CRANE_TASK)') }, required: ['to'], run: run('../lib/events', 'message') },
  { section: 'Run', name: 'hook', pos: ['ACTION'], usage: 'ACTION --binding FILE [--payload JSON|-]', summary: 'deliver harness messages and record activity under the home identity', flags: { binding: str('FILE', 'protected hook binding in the agent home'), payload: str('JSON|-', 'harness event data (- reads stdin)') }, required: ['binding'], run: run('../lib/harness-hooks', 'hook') },

  { section: 'Decisions', name: 'ask', usage: '--question Q --option A --option B [--recommend A] [--why W] [--blocks ID]...', summary: 'open a decision; prints its id', flags: { question: str('Q', 'the question'), option: many('A', 'an allowed answer; repeat'), recommend: str('A', 'the recommended option'), why: str('W', 'the reasoning'), blocks: many('ID', 'a task that waits for the answer; repeat') }, required: ['question'], run: D.ask },
  { section: 'Decisions', name: 'decision note', pos: ['DID', 'TEXT...'], usage: 'DID TEXT', summary: 'append a comment on a decision', run: D.comment },
  { section: 'Decisions', name: 'answer', pos: ['DID'], usage: 'DID --choice C [--note T]', summary: "record the owner's answer", flags: { choice: str('C', 'the chosen option'), note: str('T', 'context') }, required: ['choice'], run: D.answer },
  { section: 'Decisions', name: 'decisions', usage: '[--open]', summary: 'list decisions', flags: { open: bool('only open ones') }, run: D.list },

  { section: 'Views', name: 'status', summary: 'one screen: counts, ready tasks, open decisions, owner tasks, spend, expired leases, exited spawned claims', run: R.status },
  { section: 'Views', name: 'render', summary: 'write sketch.md and sketch.html (self-contained, no network)', run: R.render },
  { section: 'Views', name: 'serve', usage: '[--port P]', summary: 'serve the sketch and a Settings view for the ladder and task tiers on 127.0.0.1; pages reload when the state changes', flags: { port: int('P', 'port (default 4747; 0 picks a free one)') }, run: run('../lib/serve', 'serve') },

  { section: 'Agents and worktrees', name: 'worktree', pos: ['ID...'], usage: 'ID [ID ...]', summary: 'prepare task worktrees serially from one fetched base before dispatch', run: run('../lib/worktree', 'worktree') },
  { section: 'Agents and worktrees', name: 'spawn', usage: '--task ID [--role RUNG] [--dry-run] [--wait]', summary: "start a rung's harness in the task's worktree (the task's tier unless --role names a rung); prints the pid, or the command with --dry-run", flags: { task: str('ID', 'task id'), role: str('RUNG', "ladder rung, such as review (default: the task's tier)"), 'dry-run': bool('print the command instead of running it'), wait: bool('run in the foreground and exit with its code') }, required: ['task'], run: run('../lib/spawn', 'spawn') },

  { section: 'Gates', name: 'check tests', pos: ['ID'], usage: 'ID [--cmd CMD] [--proof-cmd CMD]', summary: 'check tests under the project and task kind mode; records tests', flags: { cmd: str('CMD', 'test command; required for prove and run-only, skipped for none'), 'proof-cmd': str('CMD', 'expensive prove: scoped test command with {tests} for changed test paths') }, run: gate('tests') },
  { section: 'Gates', name: 'check clean', pos: ['ID'], usage: 'ID', summary: 'cleanup tool on the task branch against base reports no HIGH finding; records clean', run: gate('clean') },
  { section: 'Gates', name: 'check ci', pos: ['ID'], usage: 'ID', summary: 'configured local CI on the merged tree, or GitHub checks on the submitted sha; records ci', run: gate('ci') },
  { section: 'Gates', name: 'merge', pos: ['ID'], usage: 'ID [--subject S] [--body B] [--method M]', summary: "merge an accepted task's PR with --match-head-commit if its gates still pass; records merge", flags: { subject: str('S', 'commit subject (default: task title)'), body: str('B', 'commit body (default: task acceptance lines; empty allowed)'), method: str('M', 'squash (default), merge or rebase; rebase has no commit text options') }, run: gate('merge') },
];

const GROUPS = new Set(COMMANDS.filter((c) => c.name.includes(' ')).map((c) => c.name.split(' ')[0]));
const SECTIONS = ['Plan', 'Run', 'Decisions', 'Views', 'Agents and worktrees', 'Gates'];

function flagLine(name, spec) {
  const left = `  --${name}${spec.arg ? ` ${spec.arg}` : ''}`;
  return `${left.padEnd(26)} ${spec.help}${spec.type === 'multi' ? ' (repeatable)' : ''}`;
}

function generalHelp() {
  const lines = ['tower-crane: plan, dispatch, review and merge agent work, with state in plain files', '', 'usage: tower-crane <command> [args] [--state DIR] [--agent NAME] [--json]'];
  for (const section of SECTIONS) {
    lines.push('', `${section}:`);
    for (const c of COMMANDS.filter((x) => x.section === section)) lines.push(`  ${c.name.padEnd(16)} ${c.summary}`);
  }
  lines.push('', 'global options:', ...Object.entries(GLOBAL).map(([n, s]) => flagLine(n, s)));
  lines.push('', 'exit status: 0 done, 1 refused (reason on stderr), 2 usage error, 3 lock not acquired within 10 s');
  lines.push('run tower-crane <command> --help for its options; docs/cli.md and docs/state.md hold the contract');
  return lines.join('\n');
}

function commandHelp(c) {
  const lines = [`usage: tower-crane ${c.name}${c.usage ? ` ${c.usage}` : ''}`, '', c.summary];
  const flags = Object.entries(c.flags || {});
  if (flags.length) lines.push('', 'options:', ...flags.map(([n, s]) => flagLine(n, s)));
  lines.push('', 'global options:', ...Object.entries(GLOBAL).map(([n, s]) => flagLine(n, s)));
  return lines.join('\n');
}

function groupHelp(group) {
  const lines = [`usage: tower-crane ${group} <subcommand> ...`, ''];
  for (const c of COMMANDS.filter((x) => x.name.startsWith(`${group} `))) lines.push(`  ${c.name.padEnd(16)} ${c.summary}`);
  return lines.join('\n');
}

function convert(name, spec, raw) {
  if (spec.type === 'int') {
    if (!/^-?\d+$/.test(raw)) throw usage(`--${name} needs a whole number, got "${raw}"`);
    return parseInt(raw, 10);
  }
  if (spec.type === 'number') {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) throw usage(`--${name} needs a number, got "${raw}"`);
    return n;
  }
  return raw;
}

// Options take their value from the next token even if it starts with "-",
// so "--minutes -5" reaches validation instead of becoming an unknown flag.
function parseOptions(tokens, specs, where) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--') {
      pos.push(...tokens.slice(i + 1));
      break;
    }
    if (tok === '-h') {
      flags.help = true;
      continue;
    }
    if (!tok.startsWith('--')) {
      pos.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    const spec = specs[name];
    if (!spec) throw usage(`unknown option --${name}${where ? ` for ${where}` : ''}; see tower-crane ${where ? `${where} ` : ''}--help`);
    if (spec.type === 'bool') {
      if (eq !== -1) throw usage(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    let raw;
    if (eq !== -1) raw = tok.slice(eq + 1);
    else {
      if (i + 1 >= tokens.length) throw usage(`--${name} needs a value (${spec.arg})`);
      raw = tokens[++i];
    }
    const value = convert(name, spec, raw);
    if (spec.type === 'multi') (flags[name] = flags[name] || []).push(value);
    else if (flags[name] !== undefined) throw usage(`--${name} was given twice`);
    else flags[name] = value;
  }
  return { flags, pos };
}

function splitGlobals(flags) {
  const globals = {};
  const own = {};
  for (const [k, v] of Object.entries(flags)) (k in GLOBAL ? globals : own)[k] = v;
  return { globals, own };
}

function resolveCommand(argv) {
  // Global options may come before the command word.
  let i = 0;
  const lead = [];
  while (i < argv.length && argv[i].startsWith('-')) {
    const tok = argv[i];
    const name = tok.replace(/^--?/, '').split('=')[0];
    if (tok === '-h' || name === 'help' || name === 'json') {
      lead.push(tok);
      i += 1;
    } else if ((name === 'state' || name === 'agent') && tok.startsWith('--')) {
      lead.push(tok);
      if (!tok.includes('=')) lead.push(argv[i + 1]);
      i += tok.includes('=') ? 1 : 2;
    } else {
      throw usage(`unknown option ${tok}; put command options after the command`);
    }
  }
  const word = argv[i];
  if (word === undefined || word === 'help') {
    const topic = word === 'help' ? argv.slice(i + 1).join(' ') : '';
    return { help: topic || true, lead };
  }
  if (GROUPS.has(word)) {
    const sub = argv[i + 1];
    const cmd = sub && !sub.startsWith('-') ? COMMANDS.find((c) => c.name === `${word} ${sub}`) : null;
    if (!cmd) {
      const rest = argv.slice(i + 1);
      if (rest.includes('--help') || rest.includes('-h') || sub === undefined) return { groupHelp: word, lead, bare: sub === undefined };
      throw usage(`unknown command "${word} ${sub}"; run tower-crane ${word} --help`);
    }
    return { cmd, rest: argv.slice(i + 2), lead };
  }
  const cmd = COMMANDS.find((c) => c.name === word);
  if (!cmd) throw usage(`unknown command "${word}"; run tower-crane --help`);
  return { cmd, rest: argv.slice(i + 1), lead };
}

function checkPositionals(cmd, pos) {
  const spec = cmd.pos || [];
  const required = spec.filter((p) => !p.startsWith('[')).length;
  const variadic = spec.some((p) => p.endsWith('...'));
  if (pos.length < required) throw usage(`${cmd.name} needs ${spec.filter((p) => !p.startsWith('[')).join(' ')}; usage: tower-crane ${cmd.name} ${cmd.usage || ''}`.trim());
  if (!variadic && pos.length > spec.length) throw usage(`unexpected argument "${pos[spec.length]}" for ${cmd.name}`);
}

async function main(argv) {
  const out = (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  let resolved;
  let jsonOut = argv.includes('--json');
  try {
    resolved = resolveCommand(argv);
    if (resolved.help) {
      if (resolved.help === true) {
        if (argv.length) {
          out(generalHelp());
          return 0;
        }
        process.stderr.write(`${generalHelp()}\n`);
        return 2;
      }
      const c = COMMANDS.find((x) => x.name === resolved.help);
      if (c) out(commandHelp(c));
      else if (GROUPS.has(resolved.help)) out(groupHelp(resolved.help));
      else throw usage(`no help for "${resolved.help}"; run tower-crane --help`);
      return 0;
    }
    if (resolved.groupHelp) {
      if (!resolved.bare) {
        out(groupHelp(resolved.groupHelp));
        return 0;
      }
      process.stderr.write(`${groupHelp(resolved.groupHelp)}\n`);
      return 2;
    }
    const { cmd } = resolved;
    const parsed = parseOptions([...resolved.lead, ...resolved.rest], { ...(cmd.flags || {}), ...GLOBAL }, cmd.name);
    const { globals, own } = splitGlobals(parsed.flags);
    jsonOut = !!globals.json;
    if (globals.help) {
      out(commandHelp(cmd));
      return 0;
    }
    checkPositionals(cmd, parsed.pos);
    for (const r of cmd.required || []) {
      if (own[r] === undefined) throw usage(`${cmd.name} needs --${r}; usage: tower-crane ${cmd.name} ${cmd.usage}`);
    }
    let agent = globals.agent ?? process.env.TOWER_CRANE_AGENT;
    // Terminal fallback identifies ordinary actions; owner powers need a named identity.
    const agentExplicit = agent !== undefined;
    if (agent === undefined) {
      if (process.stdin.isTTY && process.stdout.isTTY && process.env.TOWER_CRANE_TASK === undefined) agent = 'owner';
      else throw usage('no agent: pass --agent NAME or set TOWER_CRANE_AGENT');
    }
    if (!agent.trim()) throw usage('no agent: pass --agent NAME or set TOWER_CRANE_AGENT');
    const ctx = {
      cwd: process.cwd(),
      env: process.env,
      agent: agent.trim(),
      agentExplicit,
      json: !!globals.json,
      flags: own,
      pos: parsed.pos,
      stateDir: S.locateStateDir(globals.state, process.env, process.cwd()),
    };
    const res = await cmd.run(ctx);
    if (res && !res.printed) {
      if (ctx.json) out(JSON.stringify(res.data, null, 2));
      else if (res.text !== undefined) out(res.text);
    }
    return (res && res.code) || 0;
  } catch (e) {
    if (e instanceof TowerCraneError) {
      process.stderr.write(`tower-crane: ${e.message}\n`);
      return e.code;
    }
    process.stderr.write(`tower-crane: ${jsonOut ? e.message : e.stack || e.message}\n`);
    return 1;
  }
}

// A queued no-op write completes after prior bytes, so natural exit waits for healthy output.
function flushStream(stream) {
  if (stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      stream.removeListener('close', done);
      resolve();
    };
    stream.once('close', done);
    stream.write('', done);
  });
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    return Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
  });
}

module.exports = { main, COMMANDS };
