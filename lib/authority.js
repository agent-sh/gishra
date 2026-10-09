'use strict';

// Who may change what. The owner hands the run to an orchestrator, so the
// settings that run a project day to day are operational: the orchestrator
// changes them under its own identity. Settings that widen what an agent can
// reach, spend more, hand out orchestrator authority or publish outside the
// repository are owner-required: the orchestrator's attempt opens a decision
// for the owner instead. Workers and reviewers change neither; they ask the
// orchestrator. Some changes no identity may make, such as a kind change on a
// submitted task, are refused outright. docs/state.md#authority carries the same table.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { refuse, nowIso } = require('./util');

const OPERATIONAL = 'operational';
const OWNER = 'owner-required';
// For a refused setting the description is the refusal itself.
const REFUSED = 'refused';

const TABLE = {
  'gates.tests_cmd': [OPERATIONAL, 'project set --tests-cmd'],
  'gates.clean_cmd': [OPERATIONAL, 'project set --clean-cmd'],
  'gates.tests_proof_cmd': [OPERATIONAL, 'project set --tests-proof-cmd'],
  'gates.executors': [OPERATIONAL, 'project set --executors'],
  'gates.tests_timeout_min': [OPERATIONAL, 'project set --tests-timeout-min'],
  'gates.clean_timeout_min': [OPERATIONAL, 'project set --clean-timeout-min'],
  'ci.required': [OPERATIONAL, 'project set --ci-required'],
  'ci.ignore_apps': [OPERATIONAL, 'project set --ci-ignore-apps'],
  'ci.capped_review': [OPERATIONAL, 'project set --ci-capped-review'],
  'ci.local': [OPERATIONAL, 'project set --ci-local, task update --ci-local'],
  'tests.paths': [OPERATIONAL, 'project set --tests-paths'],
  'tests.keep': [OPERATIONAL, 'project set --tests-keep'],
  'tests.mode': [OPERATIONAL, 'project set --tests-mode'],
  'tests.by_kind': [OPERATIONAL, 'project set --tests-by-kind'],
  'tests.expensive': [OPERATIONAL, 'project set --tests-expensive'],
  'tests.map': [OPERATIONAL, 'project set --tests-map'],
  'limits.workers': [OPERATIONAL, 'project set --workers'],
  'limits.lease_minutes': [OPERATIONAL, 'project set --lease-minutes'],
  'budget.lower': [OPERATIONAL, 'project set --budget-hours, --budget-tokens to a lower limit'],
  'merge.keep_branch': [OPERATIONAL, 'project set --merge-keep-branch'],
  review: [OPERATIONAL, 'project set --review-policy'],
  // A harness or args that drop a rung's sandbox, on a primary or a personal
  // fallback route that follows it, is ladder.reach (lib/project.js unconfinedRoutes).
  'ladder.harness': [OPERATIONAL, 'ladder harness, ladder set --harness, among claude and codex for a sandboxed role'],
  'ladder.model': [OPERATIONAL, 'ladder set --model'],
  'ladder.profile': [OPERATIONAL, 'ladder set --profile'],
  'ladder.provider': [OPERATIONAL, 'ladder set --provider'],
  'ladder.effort': [OPERATIONAL, 'ladder set --effort'],
  'ladder.args': [OPERATIONAL, 'ladder set --args'],
  'ladder.supervision': [OPERATIONAL, 'ladder set --supervision'],
  // Tools and MCP servers are operational under two conditions lib/project.js
  // enforces; the owner can overrule them. An opted-in MCP server must
  // already be defined in the owner's own harness config, never a new
  // command. A tool must be a harness built-in that leaves the rung's sandbox
  // confinement (write paths, env, scope, network) unchanged; other tools are
  // ladder.reach.
  'ladder.tools': [OPERATIONAL, 'ladder set --tools, harness built-ins that keep the rung sandbox'],
  'ladder.mcp': [OPERATIONAL, "ladder set --mcp, servers the owner's harness config already defines"],
  // Saves only the default harness and rungs the project defines (lib/project.js ladderSaveUser).
  'ladder.save_user': [OPERATIONAL, 'ladder save-user, the default for new projects'],
  'task.kind': [OPERATIONAL, 'task update --kind, other than leaving code (task.downgrade)'],
  // Leaving code drops the tests and clean gates, so only the owner does it.
  'task.downgrade': [OWNER, 'task update --kind from code to docs, research, design or ops'],
  // What a submitted or accepted task was reviewed as stays that kind until rework.
  'task.kind.submitted': [REFUSED, 'task update --kind on a submitted or accepted task is refused; rework the task first with tower-crane rework <id> --reason R'],
  'task.tier': [OPERATIONAL, 'task update --tier'],
  // Stops a live run; the claim and its worktree stay for the next dispatch.
  'task.interrupt': [OPERATIONAL, 'interrupt, task update --interrupt with a live claim whose requirements change'],
  'task.needs_owner': [OPERATIONAL, 'owner-done, task update --needs-owner clearing or replacing a reason'],
  // A task that waits on the owner is cancelled by the owner, or not at all.
  'task.cancel_needs_owner': [OWNER, 'task update --status cancelled on a task with an owner ask'],
  // lib/tasks.js checks the reviewer state at the submitted head: a capped
  // review run in its CI evidence, or a review spawn that exited without a verdict.
  'waive.review': [OPERATIONAL, 'accept --waive review, for a capped or down reviewer'],
  'waive.review_live': [OWNER, 'accept --waive review when no reviewer is capped or down at the submitted head'],
  'merge.admin': [OWNER, 'project set --merge-admin'],
  decision_delegation: [OWNER, 'project set --decision-delegation'],
  'claim.release': [OWNER, "release of another agent's claim while its process may still run"],
  sandbox: [OWNER, 'project set or ladder set --sandbox'],
  env: [OWNER, 'project set or ladder set --env'],
  env_file: [OWNER, 'project set or ladder set --env_file'],
  scope: [OWNER, 'project set or ladder set --scope'],
  'ladder.command': [OWNER, 'ladder set --command, the program a rung runs'],
  'ladder.web_mcp': [OWNER, 'ladder set --web-mcp or --clear web_mcp, the explicit research web server command and tools'],
  'research.min_sources': [OWNER, 'project set --research-min-sources'],
  'ladder.reach': [OWNER, 'ladder set --tools opting in to a tool that is not a harness built-in or that changes the rung sandbox (claude Edit, Write, NotebookEdit; codex memories, plugins, apps, browser_use, computer_use; agy file edits and subagents; pi edit, write); ladder set or ladder harness moving a worker, reviewer or small rung, or a user-file fallback route that follows its harness, off claude and codex, which enforce a sandbox; args on a harness other than claude and codex'],
  'budget.raise': [OWNER, 'project set --budget-hours, --budget-tokens to a higher or no limit'],
  delegation: [OWNER, 'spawn --role orchestrator, which hands orchestrator authority to a new agent'],
  'waive.tests': [OWNER, 'accept --waive tests'],
  'waive.clean': [OWNER, 'accept --waive clean'],
  'waive.sources': [OWNER, 'accept --waive sources'],
  'waive.ci': [OWNER, 'accept --waive ci'],
  browser_kit: [OWNER, 'browser-kit set, MCP servers given to browser tasks in every project'],
  publish: [OWNER, 'anything that publishes outside the repository, such as a release or a package'],
};

const SPAWNS = ['spawn', 'spawn retry', 'spawn fallback'];

function classOf(setting) {
  const row = TABLE[setting];
  if (!row) throw new Error(`no authority class for ${setting}`);
  return row[0];
}

// A native permission renderer can keep a role confined without OS isolation.
// Its capability comes from the harness adapter, not from the home opt-in list.
function unconfinedRoute(job, route) {
  const A = require('./agents');
  if (A.CAPABILITIES[route.harness]?.sandbox === true) return false;
  return A.load(job).sandbox || (route.args || []).length > 0;
}

// An agent name some spawn started is that spawn's role and no other: a name
// ever started as a worker or reviewer never becomes the orchestrator.
// Unspawned, only the name orchestrator is; the owner's own session acts as
// owner.
function isOrchestrator(agent, events = []) {
  const jobs = events.filter((e) => SPAWNS.includes(e.cmd) && e.detail?.agent === agent).map((e) => e.detail.role);
  if (jobs.length) return jobs.every((role) => role === 'orchestrator');
  return agent === 'orchestrator';
}

// The verified identity name or null. The CLI checks the owner credential,
// terminal and process identity before calling this. A task or broker process
// never gets owner here. Other identities must agree with TOWER_CRANE_AGENT.
// Task and broker commands must match their bound name, so --agent cannot
// replace the process identity. An owner session may select an orchestrator identity. A broker
// command is never the orchestrator.
function actor(ctx, events) {
  if (!ctx.agentExplicit || typeof ctx.agent !== 'string' || !ctx.agent.trim()) return null;
  const identity = ctx.agent.trim();
  const started = ctx.env?.TOWER_CRANE_AGENT?.trim();
  const broker = ctx.env?.TOWER_CRANE_VIA === 'broker';
  const taskBound = ctx.env?.TOWER_CRANE_TASK !== undefined || broker;
  if (identity === 'owner') return taskBound ? null : identity;
  if (taskBound && started !== identity) return null;
  if (started && started !== identity && !(started === 'owner' && isOrchestrator(identity, events))) return null;
  if (broker && isOrchestrator(identity, events)) return null;
  return identity;
}

// The side of the table the verified identity acts on: owner, orchestrator or
// null for workers, reviewers, broker commands and anything unverified.
function role(ctx, events = []) {
  const identity = actor(ctx, events);
  if (identity === 'owner') return 'owner';
  return identity && isOrchestrator(identity, events) ? 'orchestrator' : null;
}

const RULE = 'owner identity needs a process the owner runs (docs/state.md#agent-identity)';

// Resolve the user's config directory only when establishing a project's
// binding. Later callers cannot select the credential that authenticates them.
function resolveOwnerConfigDir(env) {
  const dir = path.dirname(require('./ladder').userFile(env));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return fs.realpathSync.native(dir);
}

function ownerProject(stateDir) {
  let raw;
  try { raw = fs.readFileSync(path.join(stateDir, 'project.json'), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(raw);
}

function ownerKeyFile(project) {
  const dir = project?.owner_config_dir;
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0')) {
    throw refuse(`${RULE}: project.json has no valid owner_config_dir; the owner must run tower-crane owner-key at a terminal`);
  }
  return path.join(dir, 'owner', 'key');
}

// Refuses resolving the identity owner unless the owner runs this process:
// never one started for a task or under another name, and only from an
// interactive terminal or with the owner key in TOWER_CRANE_OWNER_KEY.
function checkOwner(env, given, terminal, getProject, initializing = false) {
  if (env.TOWER_CRANE_TASK !== undefined) throw refuse(`${RULE}: TOWER_CRANE_TASK is set, and a task process never acts as owner`);
  const started = env.TOWER_CRANE_AGENT?.trim();
  if (started && started !== 'owner') throw refuse(`${RULE}: TOWER_CRANE_AGENT names ${started}, and a process started as another identity never acts as owner`);
  if (terminal) return;
  let project = getProject();
  let initialConfigDir;
  // First init establishes trust for new state only. init checks again under
  // the state lock and never replaces an existing project's binding.
  if (project === null && initializing) {
    initialConfigDir = resolveOwnerConfigDir(env);
    project = { owner_config_dir: initialConfigDir };
  }
  const file = ownerKeyFile(project);
  if (!given) throw refuse(`${RULE}: stdin and stdout are not a terminal and TOWER_CRANE_OWNER_KEY is unset; run it at a terminal, or present the key in ${file}`);
  let key;
  try { key = fs.readFileSync(file, 'utf8').trim(); } catch (e) {
    if (e.code === 'ENOENT') throw refuse(`${RULE}: TOWER_CRANE_OWNER_KEY is set but ${file} does not exist; create it with tower-crane owner-key at a terminal`);
    throw e;
  }
  const a = crypto.createHash('sha256').update(given.trim()).digest();
  const b = crypto.createHash('sha256').update(key).digest();
  if (!key || !crypto.timingSafeEqual(a, b)) throw refuse(`${RULE}: TOWER_CRANE_OWNER_KEY does not match the key in ${file}`);
  return initialConfigDir;
}

// Creates the owner key when none exists; prints where it is, never the key.
function ownerKey(ctx) {
  if (actor(ctx, []) !== 'owner') throw refuse('only the owner with an explicit identity creates the owner key; run tower-crane owner-key --agent owner at a terminal');
  const S = require('./state');
  let project = S.readJson(path.join(ctx.stateDir, 'project.json'));
  if (project.owner_config_dir === undefined) {
    if (!ctx.ownerTerminal) throw refuse(`${RULE}: only a terminal owner can establish owner_config_dir`);
    project = S.mutate(ctx, 'owner-key', (st, emit) => {
      if (st.project.owner_config_dir === undefined) {
        st.project.owner_config_dir = resolveOwnerConfigDir(ctx.env);
        emit(null, { owner_config_dir: st.project.owner_config_dir });
      }
      return st.project;
    });
  }
  const file = ownerKeyFile(project);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let created = false;
  try {
    fs.writeFileSync(file, `${crypto.randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    created = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  return { data: { file, created }, text: `${created ? 'created' : 'exists'} ${file}` };
}

const list = (keys) => `${keys.join(', ')} ${keys.length > 1 ? 'are' : 'is'}`;

// The settings a task update that sets kind needs. Changing kind of a task
// already submitted or accepted is refused, whoever asks. Leaving code is
// owner-required at any other status.
function kindSettings(task, kind) {
  if (kind === task.kind) return [];
  if (task.status === 'submitted' || task.status === 'accepted') return ['task.kind.submitted'];
  return [task.kind === 'code' ? 'task.downgrade' : 'task.kind'];
}

// Refuses who may not act; returns who did. Inside S.mutate, pass emit and
// commit: an orchestrator asking for an owner-required change then opens a
// decision (once per identical request) and is refused, so the owner sees the
// request and nothing changes until the owner makes it. change describes the
// request for the owner.
function enforce(ctx, st, settings, { change = null, emit = null, commit = null } = {}) {
  const keys = [...new Set(settings)];
  const who = role(ctx, st ? st.events : []);
  if (!keys.length) return who;
  const refused = keys.find((k) => classOf(k) === REFUSED);
  if (refused) throw refuse(TABLE[refused][1]);
  if (who === 'owner') return who;
  const owner = keys.filter((k) => classOf(k) === OWNER);
  if (who === 'orchestrator' && !owner.length) return who;
  if (who === 'orchestrator') {
    // Only init passes no state: nothing exists to hold a decision yet.
    if (!st) throw refuse(`${list(owner)} owner-required; init without ${owner.length > 1 ? 'them' : 'it'}, then the owner sets ${owner.length > 1 ? 'them' : 'it'} (tower-crane ask opens the decision once the project exists)`);
    if (!emit || !commit) throw refuse(`${list(owner)} owner-required; open a decision for the owner with tower-crane ask and wait for the answer`);
    const escalation = { settings: owner, change };
    const same = (d) => d.status === 'open' && d.escalation && JSON.stringify(d.escalation) === JSON.stringify(escalation);
    let d = st.decisions.decisions.find(same);
    if (!d) {
      const question = `${ctx.agent} asks the owner to change ${owner.join(', ')}${change ? `: ${JSON.stringify(change)}` : ''}`;
      d = {
        id: `D${st.decisions.next}`, question, options: [], recommendation: null,
        why: 'owner-required (docs/state.md#authority): the orchestrator cannot make this change; make it yourself or decline',
        blocks: [], status: 'open', answer: null, note: null, asked_by: ctx.agent, asked_at: nowIso(),
        answerers: [], technical: false, answered_by: null, answered_at: null, answer_rule: null, escalation,
      };
      st.decisions.next += 1;
      st.decisions.decisions.push(d);
      emit(null, { decision: d.id, question, blocks: [], escalation }, 'ask');
      commit();
    }
    throw refuse(`${list(owner)} owner-required; opened ${d.id} for the owner (escalation: ${owner.join(', ')}); wait for the answer with tower-crane wait --types decision-answer`);
  }
  if (owner.length) {
    throw refuse(`only the owner with an explicit identity can change ${owner.join(', ')}; an agent requests this with tower-crane ask or a task note`);
  }
  throw refuse(`${list(keys)} operational: only the orchestrator or the owner changes ${keys.length > 1 ? 'them' : 'it'}; a worker or reviewer asks the orchestrator with tower-crane msg --to orchestrator or a task note`);
}

module.exports = { TABLE, OPERATIONAL, OWNER, REFUSED, classOf, isOrchestrator, actor, role, kindSettings, enforce, unconfinedRoute, resolveOwnerConfigDir, ownerProject, ownerKeyFile, checkOwner, ownerKey };
