'use strict';

// Who may change what. The owner hands the run to an orchestrator, so the
// settings that run a project day to day are operational: the orchestrator
// changes them under its own identity. Settings that widen what an agent can
// reach, spend more, hand out orchestrator authority or publish outside the
// repository are owner-required: the orchestrator's attempt opens a decision
// for the owner instead. Workers and reviewers change neither; they ask the
// orchestrator. docs/state.md#authority carries the same table.

const { refuse, nowIso } = require('./util');

const OPERATIONAL = 'operational';
const OWNER = 'owner-required';

const TABLE = {
  'gates.tests_cmd': [OPERATIONAL, 'project set --tests-cmd'],
  'gates.clean_cmd': [OPERATIONAL, 'project set --clean-cmd'],
  'gates.tests_proof_cmd': [OPERATIONAL, 'project set --tests-proof-cmd'],
  'ci.required': [OPERATIONAL, 'project set --ci-required'],
  'ci.ignore_apps': [OPERATIONAL, 'project set --ci-ignore-apps'],
  'ci.capped_review': [OPERATIONAL, 'project set --ci-capped-review'],
  'ci.local': [OPERATIONAL, 'project set --ci-local, task update --ci-local'],
  'tests.paths': [OPERATIONAL, 'project set --tests-paths'],
  'tests.keep': [OPERATIONAL, 'project set --tests-keep'],
  'tests.mode': [OPERATIONAL, 'project set --tests-mode'],
  'tests.by_kind': [OPERATIONAL, 'project set --tests-by-kind'],
  'tests.expensive': [OPERATIONAL, 'project set --tests-expensive'],
  'limits.workers': [OPERATIONAL, 'project set --workers'],
  'limits.lease_minutes': [OPERATIONAL, 'project set --lease-minutes'],
  'limits.paused': [OPERATIONAL, 'project set --paused'],
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
  'task.kind': [OPERATIONAL, 'task update --kind'],
  'task.tier': [OPERATIONAL, 'task update --tier'],
  'task.needs_owner': [OPERATIONAL, 'owner-done, task update --needs-owner clearing or replacing a reason'],
  // lib/tasks.js checks the reviewer state at the submitted head: a capped
  // review run in its CI evidence, or a review spawn that exited without a verdict.
  'waive.review': [OPERATIONAL, 'accept --waive review, for a capped or down reviewer'],
  'waive.review_live': [OWNER, 'accept --waive review when no reviewer is capped or down at the submitted head'],
  'merge.admin': [OWNER, 'project set --merge-admin'],
  'claim.release': [OWNER, "release of another agent's claim while its process may still run; interrupt stops its verified local supervisor"],
  sandbox: [OWNER, 'project set or ladder set --sandbox'],
  env: [OWNER, 'project set or ladder set --env'],
  env_file: [OWNER, 'project set or ladder set --env_file'],
  scope: [OWNER, 'project set or ladder set --scope'],
  'ladder.command': [OWNER, 'ladder set --command, the program a rung runs'],
  'ladder.web_mcp': [OWNER, 'ladder set --web-mcp or --clear web_mcp, the explicit research web server command and tools'],
  'research.min_sources': [OWNER, 'project set --research-min-sources'],
  'ladder.reach': [OWNER, 'ladder set --tools opting in to a tool that is not a harness built-in or that changes the rung sandbox (claude Edit, Write, NotebookEdit; codex memories, plugins, apps, browser_use, computer_use); ladder set or ladder harness moving a worker, reviewer or small rung, or a user-file fallback route that follows its harness, off claude and codex, which alone enforce a sandbox; args on a harness other than claude and codex'],
  'budget.raise': [OWNER, 'project set --budget-hours, --budget-tokens to a higher or no limit'],
  delegation: [OWNER, 'spawn --role orchestrator, which hands orchestrator authority to a new agent'],
  'waive.tests': [OWNER, 'accept --waive tests'],
  'waive.clean': [OWNER, 'accept --waive clean'],
  'waive.sources': [OWNER, 'accept --waive sources'],
  'waive.ci': [OWNER, 'accept --waive ci'],
  'ladder.save_user': [OWNER, 'ladder save-user, ladder fallbacks, the defaults and personal routes for every project'],
  browser_kit: [OWNER, 'browser-kit set, MCP servers given to browser tasks in every project'],
  publish: [OWNER, 'ask --setting publish: anything that publishes outside the repository, such as a release or a package; the orchestrator publishes once the owner approves'],
};

const SPAWNS = ['spawn', 'spawn retry', 'spawn fallback'];

function classOf(setting) {
  const row = TABLE[setting];
  if (!row) throw new Error(`no authority class for ${setting}`);
  return row[0];
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

// 'owner', 'orchestrator' or null. The terminal fallback grants neither, and
// a brokered command is a sandboxed agent's. TOWER_CRANE_AGENT names the
// process's own identity, so a worker passing --agent orchestrator stays the
// worker it was started as.
function actor(ctx, events) {
  if (!ctx.agentExplicit || ctx.env?.TOWER_CRANE_VIA === 'broker') return null;
  if (ctx.agent === 'owner') return 'owner';
  const started = ctx.env?.TOWER_CRANE_AGENT?.trim();
  if (started && started !== ctx.agent && started !== 'owner' && !isOrchestrator(started, events)) return null;
  return isOrchestrator(ctx.agent, events) ? 'orchestrator' : null;
}

const list = (keys) => `${keys.join(', ')} ${keys.length > 1 ? 'are' : 'is'}`;

const APPROVE = 'approve';
const DECLINE = 'decline';

// The board and the CLI reach the same check; mode says which one the owner
// or orchestrator used.
const modeOf = (ctx) => (ctx.mode === 'board' ? 'board' : 'cli');

// One audit event per allowed change of guarded settings, whatever command or
// surface made it.
function audit(ctx, who, keys, emit, approved) {
  if (!emit || !keys.length) return;
  emit(null, {
    command: emit.cmd || null, actor: who, mode: modeOf(ctx),
    settings: Object.fromEntries(keys.map((k) => [k, classOf(k)])),
    ...(approved ? { approved_by: approved.id } : {}),
  }, 'setting');
}

const sameRequest = (escalation, settings, change) => JSON.stringify(escalation.settings) === JSON.stringify(settings)
  && JSON.stringify(escalation.change ?? null) === JSON.stringify(change ?? null);

// An escalation the owner approved and nobody has applied yet, for exactly
// this request: the owner's answer stands in for the owner making the change.
function approval(st, settings, change) {
  return st.decisions.decisions.find((d) => d.escalation && d.status === 'answered' && d.answer === APPROVE
    && d.answered_by === 'owner' && !d.applied && sameRequest(d.escalation, settings, change)) || null;
}

// Whether an approved escalation of setting backs a recorded change, read from
// the event log as gate evidence is.
function approvedIn(events, id, setting) {
  const asked = events.find((e) => e.cmd === 'ask' && e.detail?.decision === id && e.detail.escalation);
  return !!asked && asked.detail.escalation.settings.includes(setting)
    && events.some((e) => e.cmd === 'answer' && e.agent === 'owner' && e.detail?.decision === id && e.detail.choice === APPROVE);
}

// Opens the owner's decision for an owner-required request, or returns the
// open one already asking for it.
function escalate(ctx, st, settings, change, emit) {
  const escalation = { settings, change };
  let d = st.decisions.decisions.find((x) => x.status === 'open' && x.escalation && sameRequest(x.escalation, settings, change));
  if (d) return { decision: d, opened: false };
  const question = `${ctx.agent} asks the owner to change ${settings.join(', ')}${change ? `: ${JSON.stringify(change)}` : ''}`;
  d = {
    id: `D${st.decisions.next}`, question, options: [APPROVE, DECLINE], recommendation: null,
    why: `owner-required (docs/state.md#authority): ${APPROVE} lets the orchestrator make exactly this change once; ${DECLINE} or making it yourself also answers it`,
    blocks: [], status: 'open', answer: null, note: null, asked_by: ctx.agent, asked_at: nowIso(),
    answered_by: null, answered_at: null, escalation,
    ...(ctx.request ? { request: ctx.request } : {}),
  };
  st.decisions.next += 1;
  st.decisions.decisions.push(d);
  emit(null, { decision: d.id, question, blocks: [], escalation }, 'ask');
  return { decision: d, opened: true };
}

// Refuses who may not act; returns who did. Inside S.mutate, pass emit and
// commit: an allowed change is audited, and an orchestrator asking for an
// owner-required change either applies the owner's approval of that exact
// request, once, or opens a decision (once per identical request) and is
// refused, so nothing changes until the owner approves or makes it. change
// describes the request for the owner. keep checks without auditing or consuming
// an approval; the command checks again when its change lands.
function enforce(ctx, st, settings, { change = null, emit = null, commit = null, keep = false } = {}) {
  const keys = [...new Set(settings)];
  if (!keys.length) return actor(ctx, st ? st.events : []);
  const who = actor(ctx, st ? st.events : []);
  const owner = keys.filter((k) => classOf(k) === OWNER);
  if (who === 'owner' && owner.length && ctx.requestApproval) {
    const approved = approval(st, owner, change);
    if (approved) {
      if (!keep) apply(ctx, approved);
      if (!keep) audit(ctx, who, keys, emit, approved);
      return who;
    }
    const { decision, opened } = escalate(ctx, st, owner, change, emit);
    if (opened) commit();
    const error = refuse(`Review ${decision.id} to approve or decline this change`);
    error.decision = decision.id;
    throw error;
  }
  if (who === 'owner' || (who === 'orchestrator' && !owner.length)) {
    if (!keep) audit(ctx, who, keys, emit);
    return who;
  }
  if (who === 'orchestrator') {
    // Only init passes no state: nothing exists to hold a decision yet.
    if (!st) throw refuse(`${list(owner)} owner-required; init without ${owner.length > 1 ? 'them' : 'it'}, then the owner sets ${owner.length > 1 ? 'them' : 'it'} (tower-crane ask opens the decision once the project exists)`);
    if (!emit || !commit) throw refuse(`${list(owner)} owner-required; open a decision for the owner with tower-crane ask and wait for the answer`);
    const approved = approval(st, owner, change);
    if (approved) {
      if (!keep) apply(ctx, approved);
      if (!keep) audit(ctx, who, keys, emit, approved);
      return who;
    }
    const { decision: d, opened } = escalate(ctx, st, owner, change, emit);
    if (opened) commit();
    throw refuse(`${list(owner)} owner-required; opened ${d.id} for the owner (escalation: ${owner.join(', ')}); wait for the answer with tower-crane wait --types decision-answer, then run the same command again once it is ${APPROVE}d`);
  }
  if (owner.length) {
    throw refuse(`only the owner with an explicit identity can change ${owner.join(', ')}; an agent requests this with tower-crane ask or a task note`);
  }
  throw refuse(`${list(keys)} operational: only the orchestrator or the owner changes ${keys.length > 1 ? 'them' : 'it'}; a worker or reviewer asks the orchestrator with tower-crane msg --to orchestrator or a task note`);
}

// An approval is used up by the change it allowed.
function apply(ctx, d) {
  d.applied = { at: nowIso(), by: ctx.agent };
}

// The table as data, for tower-crane authority and the board.
function rows() {
  return Object.entries(TABLE).map(([setting, [cls, how]]) => ({ setting, class: cls, how }));
}

function show() {
  const data = rows();
  const width = Math.max(...data.map((r) => r.setting.length));
  return { data, text: data.map((r) => `${r.setting.padEnd(width)}  ${r.class.padEnd(14)}  ${r.how}`).join('\n') };
}

module.exports = { TABLE, OPERATIONAL, OWNER, APPROVE, DECLINE, classOf, isOrchestrator, actor, enforce, escalate, approval, approvedIn, apply, audit, modeOf, rows, show };
