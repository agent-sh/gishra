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

const { TowerCraneError, usage, refuse } = require('../lib/util');
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
  sandbox: str('JSON', 'owner-required: {write: extra writable paths}; project set accepts null to clear'),
  env: str('JSON', 'owner-required: extra environment variables; use env_file for secrets; project set accepts null to clear'),
  env_file: str('FILE', 'owner-required: systemd-quoted env file read only at spawn; project set accepts null to clear'),
  scope: str('JSON', 'owner-required: systemd user scope properties, e.g. {CPUQuota: "200%", MemoryMax: "8G"}; {} disables, project set accepts null to clear'),
};

const GLOBAL = {
  state: str('DIR', 'state directory (default: TOWER_CRANE_STATE, then .tower-crane/ in the main checkout)'),
  agent: str('NAME', 'who is acting (default: TOWER_CRANE_AGENT; task processes cannot use owner; fallback needs an interactive terminal outside a task)'),
  json: bool('machine output on stdout'),
  help: bool('show help'),
};

const SETTINGS = {
  ...SPAWN_SETTINGS,
  name: str('N', 'project name'),
  goal: str('G', 'one-line goal'),
  repo: str('O/R', 'GitHub repository (default: from the origin remote)'),
  base: str('B', 'base branch for task branches (default: the current branch)'),
  workers: int('N', 'worker slots held by live leases, unclaimed spawns or interrupted supervisors still stopping (default 6)'),
  'lease-minutes': int('MIN', 'default claim lease (default 60)'),
  'budget-hours': num('H', 'hours budget'),
  'budget-tokens': int('N', 'token budget'),
  standards: str('S', '"default" or a path to a standards Markdown file'),
  'tests-cmd': str('CMD', 'operational (orchestrator or owner): pin the test command; null clears it'),
  'clean-cmd': str('CMD', 'operational (orchestrator or owner): pin the cleanup command prefix; null clears it'),
  'tests-proof-cmd': str('CMD', 'operational (orchestrator or owner): pin the scoped proof template with {tests}; null clears it'),
  'tests-paths': str('JSON', 'operational (orchestrator or owner): non-empty array of test path globs; null restores default layouts'),
  'tests-keep': str('JSON', 'operational (orchestrator or owner): extra build file globs to keep at submitted sha; [] or null restores defaults'),
  'tests-mode': str('MODE', 'operational (orchestrator or owner): prove, run-only or none; null restores prove'),
  'tests-by-kind': str('JSON', 'operational (orchestrator or owner): task kind to tests mode overrides; null clears overrides'),
  'tests-expensive': str('JSON', 'operational (orchestrator or owner): true runs the full suite once with scoped proof; false or null restores normal proof'),
  'ci-ignore-apps': str('JSON', 'array of GitHub app slugs to skip; [] or null clears the list'),
  'ci-required': str('JSON', 'array of required check-run names or prefixes; [] or null clears the list'),
  'ci-capped-review': str('JSON', 'array of {app, pattern}: a matching check run of that app is a nonblocking capped review; [] or null clears the list'),
  'ci-local': str('JSON', 'local CI {command: argv, timeout: seconds, by_kind?: overrides}; null restores hosted CI'),
  'merge-keep-branch': str('JSON', 'true keeps merged task branches for retained worktrees; false or null restores deletion'),
  'merge-admin': str('JSON', 'owner-required: true uses gh --admin for solely owned repos; false or null disables it'),
  'review-policy': str('JSON', 'operational (orchestrator or owner): review diff limits and canonical model prices; null clears the policy'),
  'research-min-sources': int('N', 'owner-required: minimum distinct cited pages for research (default 10)'),
};

const TASK_FIELDS = {
  title: str('T', 'what the task is'),
  acceptance: many('A', 'how to tell it is done; repeat for more lines'),
  kind: str('K', 'code, docs, research, design or ops (default code)'),
  needs: str('JSON', 'task capabilities as a JSON array: ["browser"]; [] clears'),
  size: str('S', 'S (under an hour), M (a few hours) or L (a day); default M'),
  dep: many('ID', 'a task this one depends on; repeat for more'),
  lock: many('NAME', 'exclusive resource name; repeat for several'),
  environment: str('LABEL', "environment label; '' clears it"),
  tier: str('T', 'easy, medium, hard or research: the ladder rung that does it (default: research for kind research, else S easy, M medium, L hard)'),
  'needs-owner': str('REASON', 'what the owner has to do first'),
};

const RUNG_FLAGS = {
  ...SPAWN_SETTINGS,
  harness: str('H', 'claude, codex, opencode, agy, pi or command (default: the ladder\'s default harness); moving a worker, reviewer or small rung off claude and codex is owner-required'),
  model: str('M', 'model id'),
  profile: str('P', 'codex profile'),
  provider: str('P', 'pi provider'),
  effort: str('E', 'reasoning effort, in the harness\'s own terms'),
  args: str('JSON', 'extra arguments appended to the harness command, as a JSON array; owner-required on a harness other than claude and codex'),
  command: str('JSON', 'owner-required: for the command harness: argv array; {task} {brief} {prompt} {cwd} are substituted'),
  supervision: str('JSON', 'retry, backoff, stall and progress path settings as a JSON object'),
  tools: str('JSON', 'claude or codex: tools the agent file denies that this rung opts back in to (claude tool names, codex features), as a JSON array; operational for harness built-ins that keep the rung sandbox, other tools owner-required'),
  mcp: str('JSON', 'claude or codex: MCP servers from your harness config this rung opts in to, by name, as a JSON array; the orchestrator names only servers the owner already defines'),
  'web-mcp': str('JSON', 'owner-required: research Claude web MCP {name, command, args}, without secrets'),
  clear: many('FIELD', 'remove a field from the rung (a cleared harness follows the default)'),
};

const run = (mod, fn) => (ctx) => require(mod)[fn](ctx);
const gate = (name) => (ctx) => require('../lib/check').runGate(ctx, name);

const COMMANDS = [
  { section: 'Run', name: 'accept', pos: ['ID'], usage: 'ID [--cmd CMD] [--proof-cmd CMD] [--waive TYPE --reason R]', summary: 'run missing software gates, dispatch review when green, accept when all gates pass', flags: { cmd: str('CMD', 'must match the pinned gates.tests_cmd'), 'proof-cmd': str('CMD', 'must match pinned gates.tests_proof_cmd'), waive: many('TYPE', 'waive tests, clean, sources, review or ci: review is operational (orchestrator or owner), the rest owner-required'), reason: str('R', 'why the waived gate does not apply') }, description: "run unattempted software gates first; tests and clean use pinned project commands. Optional `--cmd` and `--proof-cmd` must match their pins; none mode needs no test command. When they pass and review is missing, dispatch it and return `review_pending: true` while keeping the task submitted. Call again after review evidence arrives to accept. Existing successful receipts are reused; attempted failures or invalid receipts require an explicit gate rerun. `--waive review` is operational when the reviewer is capped or down at the submitted head (a capped review run in its `check ci` evidence, or a review spawn that exited without a verdict) and owner-required otherwise; waiving tests, clean, sources or ci is owner-required", run: T.accept },

  { section: 'Decisions', name: 'answer', pos: ['DID'], usage: 'DID --choice C [--note T]', summary: "record the owner's answer", flags: { choice: str('C', 'the chosen option'), note: str('T', 'context') }, required: ['choice'], description: "answer it (any agent may record the owner's answer; the event names who). `C` must be one of the options when there are any; an answered decision stays answered", run: D.answer },

  { section: 'Decisions', name: 'ask', usage: '--question Q --option A --option B [--recommend A] [--why W] [--blocks ID]...', summary: 'open a decision; prints its id', flags: { question: str('Q', 'the question'), option: many('A', 'an allowed answer; repeat'), recommend: str('A', 'the recommended option'), why: str('W', 'the reasoning'), blocks: many('ID', 'a task that waits for the answer; repeat') }, required: ['question'], run: D.ask },

  { section: 'Plan', name: 'brief get', pos: ['ID'], usage: 'ID [--role worker|reviewer]', summary: "print the full or role-filtered task brief", flags: { role: str('ROLE', 'select worker or reviewer text; otherwise infer from the agent name') }, description: "write or read the task's brief; `brief get` filters for the caller's worker or reviewer role, and `brief set` warns about a reviewer section without a worker section", run: T.briefGet },

  { section: 'Plan', name: 'brief set', pos: ['ID', '[-]'], usage: 'ID (--file F | -)', summary: "write the task's brief; warn when reviewer text has no worker section", flags: { file: str('F', 'read the brief from F') }, description: "write or read the task's brief; `brief get` filters for the caller's worker or reviewer role, and `brief set` warns about a reviewer section without a worker section", run: T.briefSet },

  { section: 'Plan', name: 'browser-kit set', usage: '--servers JSON', summary: 'owner-required: save the browser kit server list in the user configuration', flags: { servers: str('JSON', 'MCP server names; [] disables the kit') }, required: ['servers'], description: "owner-required: save the kit server list in the user file (`TOWER_CRANE_CONFIG`, else the original user's `~/.config/tower-crane/config.json`). Names are deduplicated; `[]` disables automatic server attachment. Other user settings are preserved", run: run('../lib/browser-kit', 'set') },

  { section: 'Plan', name: 'browser-kit show', summary: 'show the user browser kit MCP server list (default playwright)', description: "show the user's browser kit MCP server list, default `[\"playwright\"]`, and its config file", run: run('../lib/browser-kit', 'show') },

  { section: 'Gates', name: 'check ci', pos: ['ID'], usage: 'ID', summary: 'configured local CI on the merged tree, or GitHub checks on the submitted sha; records ci', description: "with `ci.local`, resolve task override, kind mapping or default, run its argv against the merged base and submitted head and record a local receipt; otherwise verify the PR head and mergeability, require `ci.required` runs to be present and successful on the submitted sha, require at least one run outside `ci.ignore_apps` and `ci.capped_review` exceptions and all remaining checks green; records `ci`", run: gate('ci') },

  { section: 'Gates', name: 'check clean', pos: ['ID'], usage: 'ID [--cmd CMD]', flags: { cmd: str('CMD', 'must match pinned gates.clean_cmd; omit to use it') }, summary: 'cleanup tool on the task branch against base reports no HIGH finding; records clean', description: "run pinned `gates.clean_cmd` on the task branch against `base`; records `clean`, ok when every check ran and none reported a HIGH finding", run: gate('clean') },

  { section: 'Gates', name: 'check sources', pos: ['ID'], usage: 'ID', summary: 'fetch distinct cited pages and verify every quoted claim in research/ID.json at submitted sha; records sources', description: "fetch the distinct cited pages from committed `research/ID.json` and verify every quote; records sources evidence; required for research kind on every tier", run: gate('sources') },

  { section: 'Gates', name: 'check tests', pos: ['ID'], usage: 'ID [--cmd CMD] [--proof-cmd CMD]', summary: 'check tests under the project and task kind mode; records tests', flags: { cmd: str('CMD', 'must match pinned gates.tests_cmd; omit to use it'), 'proof-cmd': str('CMD', 'must match pinned gates.tests_proof_cmd for changed test paths') }, description: "use `tests.by_kind` over `tests.mode` (default `prove`); `prove` requires pinned `gates.tests_cmd` to pass at head and fail after reverting other changes, with T8 build-file keeps; expensive proof runs CMD once and uses a scoped `{tests}` command at head and after reversion; `run-only` requires the pinned command to pass once at head; `none` verifies the submitted commit without running CMD; records `tests` and resolved `tests_mode`", run: gate('tests') },

  { section: 'Run', name: 'ci completed', pos: ['ID'], usage: 'ID --sha SHA', summary: 'handle a CI completion notification; query CI again and advance green tasks', flags: { sha: str('SHA', 'completed submitted commit; stale heads are refused') }, required: ['sha'], description: "orchestrator or owner: deliver a CI completion hint for an active submitted head, rerun the CI gate and advance passing tasks", run: run('../lib/automation', 'ciCompleted') },

  { section: 'Run', name: 'ci webhook', pos: ['FILE'], usage: 'FILE', summary: 'handle completed GitHub check_run, check_suite or workflow_run JSON; - reads stdin', description: "orchestrator or owner: deliver completed GitHub `check_run`, `check_suite` or `workflow_run` JSON; `-` reads stdin. Repository must match. Stale heads and incomplete checks are ignored", run: run('../lib/automation', 'ciWebhook') },

  { section: 'Run', name: 'claim', pos: ['ID'], usage: 'ID [--lease MIN]', summary: 'take a ready task for --agent', flags: { lease: int('MIN', 'lease length (default limits.lease_minutes)') }, description: "take a ready task for `--agent`; repeating it as the live claimant renews the lease. Refused if another agent holds it, the task is not ready, a resource lock is held, or the workers limit is reached (live leases and unclaimed worker spawns); consumes that agent's reservation for this task", run: T.claim },

  { section: 'Decisions', name: 'decision note', pos: ['DID', 'TEXT...'], usage: 'DID TEXT', summary: 'append a comment on a decision', description: "append a comment; an explicit owner comment wakes the orchestrator and tasks blocked by the decision", run: D.comment },

  { section: 'Decisions', name: 'decisions', usage: '[--open]', summary: 'list decisions', flags: { open: bool('only open ones') }, description: "list", run: D.list },

  { section: 'Run', name: 'event', pos: ['ID'], usage: 'ID', summary: 'print one event with its detail, as a wake line names it', run: run('../lib/events', 'show') },

  { section: 'Run', name: 'evidence', pos: ['ID'], usage: 'ID --type T (--ok | --fail) [--sha S] [--summary T] [--ref URL]', summary: 'record review or note evidence; review needs --sha, note defaults to the submitted sha', flags: { type: str('T', 'review or note; tests, clean, sources, ci and merge require gate commands'), ok: bool('it passed'), fail: bool('it failed'), sha: str('S', 'commit the evidence is about; required for review'), summary: str('T', 'one line'), ref: str('URL', 'link to the run, review or log') }, required: ['type'], description: "record `review` or `note` evidence; `review` requires `--sha`, while `note` defaults to the task's submitted sha. Refuses `tests`, `clean`, `sources`, `ci` and `merge` for every agent and either verdict; use the gate commands", run: T.evidence },

  { section: 'Run', name: 'hook', pos: ['ACTION'], usage: 'ACTION --binding FILE [--payload JSON|-]', summary: 'deliver harness messages and record activity under the home identity', flags: { binding: str('FILE', 'protected hook binding in the agent home'), payload: str('JSON|-', 'harness event data (- reads stdin)') }, required: ['binding'], run: run('../lib/harness-hooks', 'hook') },

  { section: 'Plan', name: 'init', usage: '--name N --goal G [--repo O/R] [--base B] [settings]', summary: 'create the state directory and project.json with the default ladder', flags: SETTINGS, required: ['name', 'goal'], description: "create the state directory and `project.json` with the default harness and ladder (from the user file, else built in); takes the `project set` settings too. Refused if the user file is invalid", run: P.init },

  { section: 'Run', name: 'interrupt', pos: ['ID'], usage: 'ID', summary: 'owner or orchestrator: stop the supervisor and release the claim, keeping the revision and dirty worktree for resume', description: "owner or orchestrator only: stop the live agent through its supervisor and release the claim to its prior `todo` or `rework`. The revision, branch, evidence and dirty worktree stay, so the next dispatch resumes the work (Codex warm resume, or a fresh Claude worker in the same worktree). Distinct from `rework`, which sends a submitted task back with a reason, and from a requirements edit, which bumps the revision", run: T.interrupt },

  { section: 'Plan', name: 'ladder harness', pos: ['HARNESS'], usage: 'HARNESS', summary: 'set the default harness every rung without its own runs on', description: "set the default harness; every rung without its own moves to it. Operational: the orchestrator or the owner; moving a worker, reviewer or small rung off claude and codex is owner-required (`ladder.reach`). Refused, naming the rungs, if one of them cannot run there (a codex profile on pi, a missing model)", run: P.ladderHarness },

  { section: 'Plan', name: 'ladder save-user', summary: "write this project's ladder to the user file, the default for new projects", description: "write the project's default harness and primary rungs to the user file (`TOWER_CRANE_CONFIG`, else `~/.config/tower-crane/config.json`), preserving personal fallbacks and other keys; only what the project defines is written. Operational: the orchestrator or the owner, and the event records the orchestrator as `authority`. Refused while a primary rung cannot run. A user file that is not valid JSON or has the wrong shape refuses every command that has to resolve the ladder, including `ladder`, `spawn` and `init`, even when the project supplies every rung; the error names the file to fix or remove", run: P.ladderSaveUser },

  { section: 'Plan', name: 'ladder set', pos: ['RUNG'], usage: 'RUNG [--harness H] [--model M] [--profile P] [--provider P] [--effort E] [--args JSON] [--command JSON] [--supervision JSON] [--tools JSON] [--mcp JSON] [--web-mcp JSON] [--sandbox JSON] [--env JSON] [--env_file FILE] [--scope JSON] [--clear FIELD]...', summary: 'change fields of one rung: orchestrator, easy, medium, hard, research, review or small', flags: RUNG_FLAGS, description: "change the named primary fields of one rung and keep the rest; personal fallbacks belong only in the user file, and `--fallbacks` and `--clear fallbacks` are refused. `--tools` and `--mcp` (claude and codex only) opt the rung back in to tools and MCP servers its agent file leaves out. Changes are operational, except `--command`, `--web-mcp`, `--sandbox`, `--env`, `--env_file` and `--scope`, which are owner-required ([Authority](state.md#authority)); so is moving a worker, reviewer or small rung off claude and codex, or `--args` on another harness (`ladder.reach`). The orchestrator's `--tools` and `--mcp` take only harness built-ins that keep the sandbox and MCP servers the owner's harness config defines; `--args` on a claude or codex rung may hold only a short list of safe flags; `--web-mcp` sets the research Claude server as `{name, command, args}` without secrets; it cannot combine with `--mcp`. `--clear web_mcp` removes it. `--clear` removes a field (a cleared harness follows the default). A rung the project left out starts from the primary it fell back to. Refused if it leaves a primary unable to run that could run before (state.md lists the checks); rungs already broken do not block it", run: P.ladderSet },

  { section: 'Plan', name: 'ladder show', summary: 'print each rung as it resolves, and where it comes from (project, user file or built-in)', description: "print each rung as it resolves: harness (and whether it is the default), model, profile, provider, effort, args, and where the primary comes from (project, user file or built-in); print personal fallbacks and their user-file source (`fallbacks_from: \"user\"` under `--json`); also the default harness, its source, the user file path, and every rung or fallback that cannot run (`problems` under `--json`); unavailable fallbacks are marked skipped", run: P.ladderShow },

  { section: 'Gates', name: 'merge', pos: ['ID'], usage: 'ID [--subject S] [--body B] [--method M]', summary: "merge accepted PRs with passing gates; linked stacks use pinned merge commits and can complete partially", flags: { subject: str('S', 'commit subject (default: task title)'), body: str('B', 'commit body (default: task acceptance lines; empty allowed)'), method: str('M', 'squash (ordinary default), merge or rebase; linked stacks use merge commits and rebase has no commit text options') }, description: "merge the task's PR with `--match-head-commit` when the task is accepted and its gates still pass for its current revision (refused otherwise). Linked stacks merge bottom up with `--merge`, pinning each accepted head and confirming it before the next member. If an upper member fails, the target reports `merge FAIL` while confirmed lower members retain successful merge evidence. Inspect each member with `task show ID` and check its PR state; fix the refusal or wait for queued merges to complete. Sync the idle remaining chain when needed with `stack sync ID`; changed heads need rework, a new submission, passing gates, review and acceptance. Refresh stale gates and retry `merge ID` on the target; confirmed lower members are skipped. Records `merge`", run: gate('merge') },

  { section: 'Run', name: 'msg', pos: ['TEXT...'], usage: '--to NAME [--task ID] [--steer] TEXT', summary: 'send a worker message through the event log', flags: { to: str('NAME', 'recipient, usually orchestrator'), task: str('ID', 'task (default TOWER_CRANE_TASK)'), steer: bool('deliver into the running turn where the harness can, not after it') }, required: ['to'], run: run('../lib/events', 'message') },

  { section: 'Run', name: 'owner-done', pos: ['ID'], usage: 'ID [--note T]', summary: 'the owner did what needs_owner asked; clears it', flags: { note: str('T', 'what was done') }, description: "the owner did what `needs_owner` asked; clears it. Operational: the orchestrator or the owner", run: T.ownerDone },

  { section: 'Plan', name: 'plan import', pos: ['FILE'], usage: 'FILE', summary: 'add tasks from a JSON array (ids may be local names, resolved in order; - reads stdin)', description: "add tasks from a JSON array of task objects (ids may be local names, resolved in order; `-` reads stdin). Fields: `id`, `title`, `acceptance`, `kind`, `needs`, `size`, `tier`, `depends_on`, `needs_owner`, `locks`, `environment`; `needs_owner` is trimmed and blank values store null. A dependency names an earlier entry or an existing task. Any bad entry refuses the whole file", run: T.planImport },

  { section: 'Plan', name: 'project set', usage: '[--name N] [--goal G] [--repo O/R] [--base B] [--workers N] [--lease-minutes MIN] [--budget-hours H] [--budget-tokens N] [--standards S] [--tests-cmd CMD] [--clean-cmd CMD] [--tests-proof-cmd CMD] [--tests-paths JSON] [--tests-keep JSON] [--tests-mode MODE] [--tests-by-kind JSON] [--tests-expensive JSON] [--ci-ignore-apps JSON] [--ci-required JSON] [--ci-capped-review JSON] [--ci-local JSON] [--merge-keep-branch JSON] [--merge-admin JSON] [--review-policy JSON] [--research-min-sources N] [--sandbox JSON] [--env JSON] [--env_file FILE] [--scope JSON]', summary: 'change project settings, limits and budget', flags: SETTINGS, description: "change settings, limits and budget", run: P.projectSet },

  { section: 'Plan', name: 'project show', summary: 'print project settings and the ladder', description: "print settings, including `gates.tests_cmd`, `gates.clean_cmd`, `gates.tests_proof_cmd`, `tests.paths`, `tests.keep`, `tests.mode`, `tests.by_kind`, `tests.expensive`, `ci.ignore_apps`, `ci.required`, `ci.local`, `merge.keep_branch` and `merge.admin`, and the resolved ladder", run: P.projectShow },

  { section: 'Run', name: 'ready', usage: '[--all]', summary: 'ready tasks, those that unblock the most first; --all adds blocked ones with the reason', flags: { all: bool('also list blocked tasks and why') }, description: "ready tasks in priority order (the ones that unblock the most work first), excluding tasks whose locks another task holds, plus claims whose spawned process exited without submit and their log tails; `--all` lists blocked ones with the reason. Ready JSON includes `locks` and `environment`", run: T.ready },

  { section: 'Run', name: 'release', pos: ['ID'], usage: 'ID --reason R', summary: 'give a claimed task back; it returns to todo or rework', flags: { reason: str('R', 'why') }, required: ['reason'], description: "give it back; status returns to its prior `todo` or `rework`. The claimant or the owner (owner-required: the orchestrator's attempt opens a decision); any agent may recover a spawned claim verified exited by the shared detector under the lock. Preserves only pid, log path, exit code and log size in a note and the release event", run: T.release },

  { section: 'Views', name: 'render', summary: 'write sketch.md and sketch.html (self-contained, no network)', description: "write `sketch.md` (Mermaid graph plus tables) and `sketch.html`, the board as a read-only snapshot, from the state as it stands under the lock", run: R.render },

  { section: 'Run', name: 'renew', pos: ['ID'], usage: 'ID [--lease MIN]', summary: 'extend your lease; an expired one only while the workers limit has room', flags: { lease: int('MIN', 'new lease length from now') }, description: "extend the lease from now; only the claimant. An expired lease takes its resource locks and worker slot again, so its renewal is refused when a lock is held or the workers limit is reached", run: T.renew },

  { section: 'Run', name: 'rework', pos: ['ID'], usage: 'ID --reason R', summary: "send back; the reason goes into the brief's rework notes", flags: { reason: str('R', 'what to fix') }, required: ['reason'], description: "send a submitted or accepted task back; the reason is appended under `## Rework notes` in its brief and as a task note", run: T.rework },

  { section: 'Views', name: 'serve', usage: '[--port P]', summary: 'serve the sketch and a Settings view for the ladder and task tiers on 127.0.0.1; pages reload when the state changes', flags: { port: int('P', 'port (default 4747; 0 picks a free one)') }, description: "serve the live board and a Settings view on 127.0.0.1 (default port 4747; 0 picks a free one) and update open pages over server-sent events when the state changes. Pages are rendered from the state on each request. As the owner it also prints a one-time link to open in the browser that will write (`--json` prints `{ url, state, open }`; `open` is `url` for other identities). Exits 1 if the port is in use", run: run('../lib/serve', 'serve') },

  { section: 'Agents and worktrees', name: 'spawn', usage: '--task ID [--role RUNG] [--dry-run] [--wait]', summary: "start a rung's harness in the task's worktree (the task's tier unless --role names a rung); prints the pid, or the command with --dry-run", flags: { task: str('ID', 'task id'), role: str('RUNG', "ladder rung, such as review (default: the task's tier)"), 'dry-run': bool('print the command instead of running it'), wait: bool('run in the foreground and exit with its code') }, required: ['task'], description: "start a rung's harness in the task's worktree with the brief and task as the prompt: the rung of the task's tier, or the rung `--role` names (`--role review` for a review); sets `TOWER_CRANE_STATE`, `TOWER_CRANE_TASK`, `TOWER_CRANE_AGENT`; logs to the state directory; prints the pid or, with `--dry-run`, the command. A claude or codex rung runs under its role's agent file in a config home of its own (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`); `--dry-run` prints a `#` line naming the agent file, the home, the MCP servers and the opted-in tools, and `--json` adds them as `home`. Every `--dry-run` also prints a `# rules:` line with the house rules files, how each reaches the agent and their size, and the prompt size; `--json` adds them as `startup`, the same record the `startup` event keeps. The rung is resolved again from the state read under the lock, so a tier or ladder change made while spawn created the worktree is the one that runs", run: run('../lib/spawn', 'spawn') },

  { section: 'Run', name: 'spend', pos: ['ID'], usage: 'ID [--minutes N] [--tokens N] [--input N] [--cached N] [--cache-write N] [--output N] [--rung R] [--harness H] [--model M] [--from-spawn AGENT]', summary: 'record usage or collect an exited spawn once', flags: { minutes: int('N', 'minutes spent'), tokens: int('N', 'total tokens, including cached input'), input: int('N', 'input tokens, including cached input'), cached: int('N', 'cache read tokens (subset of input)'), output: int('N', 'output tokens, including reasoning'), rung: str('R', 'ladder rung for native usage'), harness: str('H', 'actual harness (default: rung harness)'), model: str('M', 'actual model (default: rung model)'), 'cache-write': int('N', 'cache write input tokens, included in --input and separate from --cached'), 'from-spawn': str('AGENT', 'collect an exited spawn from its captured log and session, once'), }, description: "add spend, with optional native-agent usage breakdown and metadata; rung defaults the harness, model and profile from the current ladder collect an exited spawn's captured usage once per route and fresh retry invocation; resumed retries share their session's cumulative usage. Retry a failed monitor or enrich an unknown/partial entry when telemetry arrives. Refuses a live process or an unknown spawn; cannot be mixed with manual spend", run: T.spend },

  { section: 'Agents and worktrees', name: 'stack link', pos: ['ID'], usage: 'ID', summary: 'link submitted dependency PRs bottom to top (automatic after spawned submissions)', description: "link a submitted task's dependency chain on GitHub, bottom to top", run: run('../lib/stack', 'link') },

  { section: 'Agents and worktrees', name: 'stack sync', pos: ['ID'], usage: 'ID', summary: 'refresh an idle stack with gh stack sync; changed heads or conflicts require rework', description: "import remote tracking with `gh stack checkout <pr> --print-path`, then run `gh stack sync` from the task worktree, without prompts", run: run('../lib/stack', 'sync') },

  { section: 'Agents and worktrees', name: 'stack unstack', pos: ['ID'], usage: 'ID', summary: 'disable a stack for ordinary merges; lower tasks must land first', description: "remove the GitHub stack and local tracking, confirm no member remains stacked, then use ordinary merges in dependency order", run: run('../lib/stack', 'unstack') },

  { section: 'Agents and worktrees', name: 'stack webhook', pos: ['FILE'], usage: 'FILE', summary: 'record a pull_request webhook stack object; - reads stdin', description: "ingest a trusted `pull_request` webhook payload for this project's repository; `-` reads stdin. Record `pull_request.stack` or the payload's top-level `stack` without changing acceptance or merge evidence", run: run('../lib/stack', 'webhook') },

  { section: 'Views', name: 'status', summary: 'one screen: counts, ready tasks, open decisions, owner tasks, spend, expired leases, exited spawned claims', description: "one screen: counts by status, ready tasks, open decisions, owner tasks, spend against budget, expired leases, claims whose spawned process exited without submit and their log tails", run: R.status },

  { section: 'Run', name: 'submit', pos: ['ID'], usage: 'ID --sha S [--branch B] [--pr N] [--summary T]', summary: 'mark submitted as the claimant or replace a submitted head as its submitter', flags: { sha: str('S', 'commit to review'), branch: str('B', 'branch holding it'), pr: int('N', 'pull request number'), summary: str('T', 'what changed') }, required: ['sha'], description: "mark submitted as the claimant or replace a submitted head as its submitter. `S` is 7 to 64 hex characters. For a task with a recorded PR, an open PR blocks changing its PR number or head branch. After it is closed or merged, a new PR supplies its head branch unless `--branch` is given and matches it", run: T.submit },

  { section: 'Plan', name: 'task add', usage: '--title T --acceptance A [--acceptance A2] [--kind K] [--needs JSON] [--size S] [--tier T] [--dep ID] [--lock NAME]... [--environment LABEL] [--needs-owner REASON]', summary: 'add a task; prints its id', flags: TASK_FIELDS, required: ['title', 'acceptance'], description: "add a task; prints its id. A `needs_owner` reason is trimmed; a blank value stores null. `T` is `easy`, `medium`, `hard` or `research`; without it the tier comes from kind and size (state.md). `--needs '[\"browser\"]'` declares browser capability. Refused for an unknown dependency or capability. Repeat `--lock` for exclusive resources", run: T.taskAdd },

  { section: 'Plan', name: 'task list', usage: '[--status S]', summary: 'list tasks (S: a status, ready or blocked)', flags: { status: str('S', 'todo, in_progress, submitted, accepted, rework, cancelled, ready or blocked') }, description: "read; `S` is a status, `ready` or `blocked`", run: T.taskList },

  { section: 'Plan', name: 'task note', pos: ['ID', 'TEXT...'], usage: 'ID TEXT', summary: 'append a note', run: T.taskNote },

  { section: 'Plan', name: 'task show', pos: ['ID'], usage: 'ID', summary: 'show one task with its gates, evidence and notes', description: "read; `S` is a status, `ready` or `blocked`", run: T.taskShow },

  { section: 'Plan', name: 'task update', pos: ['ID'], usage: 'ID [--title T] [--acceptance A]... [--dep ID]... [--lock NAME]... [--environment LABEL] [--size S] [--kind K] [--needs JSON] [--tier T] [--needs-owner REASON] [--ci-local JSON] [--interrupt] [--status cancelled]', summary: "change a task; acceptance, dependency or capability changes bump its revision (--dep '' clears dependencies); live requirements changes need --interrupt; an accepted task's material settings wait for rework", flags: { ...TASK_FIELDS, acceptance: many('A', 'replaces all acceptance lines'), dep: many('ID', "replaces all dependencies; '' clears them"), lock: many('NAME', "replaces all locks; '' clears them; changes require no live lease or reservation"), 'needs-owner': str('REASON', "what the owner has to do; '' clears it; clearing or replacing an existing request is operational (orchestrator or owner)"), 'ci-local': str('JSON', 'operational (orchestrator or owner): local CI override with command or args and optional timeout; null restores kind or default policy'), interrupt: bool('operational (orchestrator or owner): stop and release a live claim before changing requirements'), status: str('cancelled', 'cancel the task') }, description: "change a task; acceptance, dependency or capability changes bump `revision`. A live claim refuses changes to acceptance, dependencies, `--needs`, kind or the local CI override unless `--interrupt` stops it first (see `interrupt`); notes, title, size, tier and priority never stop a run. `--needs '[]'` clears capabilities, `--dep ''` clears dependencies, `--needs-owner ''` clears the owner ask. `--lock` replaces all resource locks; `--lock ''` clears them. Lock changes require no live lease or dispatch reservation. `--environment ''` clears the label. Changing `--tier`, and clearing or replacing an existing owner ask, are operational (the orchestrator or the owner); any agent may set a new ask or keep the same reason. Changing `--kind` is operational, except that leaving `code` is owner-required and a submitted or accepted task refuses any kind change until `rework` ([Authority](state.md#authority)). Cancelling a task that has an owner ask is owner-required. `--ci-local` sets or clears an operational local CI override. Refused if it would form a cycle. An accepted task cannot be cancelled, and its acceptance, dependencies, capabilities, kind and local CI override change only after `rework`", run: T.taskUpdate },

  { section: 'Plan', name: 'validate', summary: 'report plan and ladder errors (exit 1 if any); warn when an open task has no runnable reviewer', description: "report cycles, unknown dependencies, tasks without acceptance, `L` tasks without a `split:` note, oversize budgets (planned hours at S=1, M=4, L=8 over `budget.hours`, or spend over either budget); exit 1 if anything is reported. It reconciles tasks.json with `events.jsonl` and reports drift: tasks or task notes the log records that tasks.json lacks, and a `next` the log has already used. It also reports every ladder rung that cannot run, and warns per open task when no reviewer rung can run", run: T.validate },

  { section: 'Run', name: 'wait', usage: '[--after CURSOR] [--for NAME] [--task ID] [--types TYPES] [--timeout SEC | --follow]', summary: 'block until one matching event; print one JSON line (timeout exits 2); --follow prints an id-only line per event until interrupted', flags: { after: str('CURSOR', 'event id or byte offset (default now)'), for: str('NAME', 'recipient (default orchestrator)'), task: str('ID', 'only this task or decisions blocking it'), types: str('TYPES', "comma-separated event types; 'all' adds hook progress, renew and other bookkeeping"), timeout: num('SEC', 'maximum wait in seconds'), follow: bool('keep running; one line of ids per event, no detail') }, run: run('../lib/events', 'wait') },

  { section: 'Agents and worktrees', name: 'worktree', pos: ['ID...'], usage: 'ID [ID ...]', summary: 'prepare task worktrees serially from one fetched base before dispatch', description: "create (or print) a git worktree and branch `tower-crane/<id>-<slug>` from the freshest base for each task, at `<repo-parent>/<repo>-worktrees/<id>-<slug>`; records the branch on the task. Once the task has a branch, its worktree is found by branch, so renaming the task does not move it", run: run('../lib/worktree', 'worktree') },
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
// spans name the token indexes each option took, for the state broker.
// Option names come from the command line, which the state broker takes from
// a sandboxed agent, so only a command's own option names are looked up and
// values collect in a Map; no name can reach Object.prototype.
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

function parseOptions(tokens, specs, where) {
  const flags = new Map();
  const pos = [];
  const spans = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--') {
      pos.push(...tokens.slice(i + 1));
      break;
    }
    if (tok === '-h') {
      flags.set('help', true);
      continue;
    }
    if (!tok.startsWith('--')) {
      pos.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    const spec = !RESERVED.has(name) && Object.hasOwn(specs, name) ? specs[name] : null;
    if (!spec) throw usage(`unknown option --${name}${where ? ` for ${where}` : ''}; see tower-crane ${where ? `${where} ` : ''}--help`);
    if (spec.type === 'bool') {
      if (eq !== -1) throw usage(`--${name} takes no value`);
      flags.set(name, true);
      spans.push({ name, from: i, to: i });
      continue;
    }
    const from = i;
    let raw;
    if (eq !== -1) raw = tok.slice(eq + 1);
    else {
      if (i + 1 >= tokens.length) throw usage(`--${name} needs a value (${spec.arg})`);
      raw = tokens[++i];
    }
    spans.push({ name, from, to: i });
    const value = convert(name, spec, raw);
    if (spec.type === 'multi') flags.set(name, [...(flags.get(name) || []), value]);
    else if (flags.has(name)) throw usage(`--${name} was given twice`);
    else flags.set(name, value);
  }
  return { flags: Object.fromEntries(flags), pos, spans };
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
    const identity = agent.trim();
    if (identity === 'owner' && process.env.TOWER_CRANE_TASK !== undefined) {
      throw refuse('owner acts from an interactive terminal; task processes cannot use owner identity');
    }
    const locate = () => S.locateStateDir(globals.state, process.env, process.cwd());
    // Check the resolved identity before forwarding; the broker separately
    // verifies requests against the identity it spawned.
    if (process.env.TOWER_CRANE_BROKER && !require('../lib/broker').READS.has(cmd.name)) {
      const input = argv.includes('-') ? require('node:fs').readFileSync(0, 'utf8') : undefined;
      const res = await require('../lib/broker').forward(process.env.TOWER_CRANE_BROKER, argv, locate(), input);
      if (res) {
        process.stdout.write(res.stdout || '');
        process.stderr.write(res.stderr || '');
        return res.code;
      }
    }
    const ctx = {
      cwd: process.cwd(),
      env: process.env,
      agent: identity,
      agentExplicit,
      json: !!globals.json,
      flags: own,
      pos: parsed.pos,
      stateDir: locate(),
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

module.exports = { main, COMMANDS, GLOBAL, resolveCommand, parseOptions };
