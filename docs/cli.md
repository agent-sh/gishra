# CLI

`gishra <command> [args]`. Every command accepts `--state DIR`, `--agent NAME`, `--json` (machine output on stdout: the task, decision, project or list the command touched) and `--help`. Exit status: 0 done, 1 refused (with the reason on stderr), 2 usage error, 3 lock not acquired within 10 s. `validate` and a failing gate print their report on stdout and exit 1; `spawn --wait` exits with the agent's code.

Agent identity comes from `--agent NAME`, then `GISHRA_AGENT`. With neither, `owner` is used only when stdin and stdout are both TTYs and `GISHRA_TASK` is unset. Otherwise the command exits 2 with `no agent: pass --agent NAME or set GISHRA_AGENT` and writes nothing. An empty or whitespace-only identity exits 2 with the same message. Help needs no agent.

`accept --waive`, `owner-done`, clearing or replacing an existing `needs_owner` through `task update`, and releasing another agent's claim require the resolved name to be exactly `owner`, supplied explicitly by `--agent owner` or `GISHRA_AGENT=owner`. The terminal fallback never grants these owner powers. An agent requests owner action with `gishra ask` or a task note.

Writes take the lock, re-read the files, validate, write atomically, append to `events.jsonl` and re-render the sketch. `render` takes the lock too. A refused command writes nothing.

## Plan

| Command | Does |
|---|---|
| `init --name N --goal G [--repo O/R] [--base B] [settings]` | create the state directory and `project.json` with the default roles; takes the `project set` settings too |
| `project set [--name N] [--goal G] [--repo O/R] [--base B] [--workers N] [--lease-minutes MIN] [--budget-hours H] [--budget-tokens N] [--standards S]` | change settings, limits and budget |
| `project show` | print settings and roles |
| `role set ROLE --harness H [--model M] [--profile P] [--provider P] [--effort E] [--args JSON] [--command JSON]` | set who plays a role, replacing it whole; `--profile` is for codex, `--provider` for pi, `--command` for `command` |
| `task add --title T --acceptance A [--acceptance A2] [--kind K] [--size S] [--dep ID] [--role R] [--needs-owner REASON]` | add a task; prints its id. Refused for an unknown dependency or role |
| `task update ID [--title] [--acceptance (replaces)] [--dep (replaces)] [--size] [--kind] [--role] [--needs-owner] [--status cancelled]` | change a task; acceptance or dependency changes bump `revision`. `--dep ''` clears dependencies, `--needs-owner ''` clears the owner ask. Clearing or replacing an existing owner ask requires explicit owner identity; any agent may set a new ask or keep the same reason. Refused if it would form a cycle. An accepted task cannot be cancelled, and its acceptance, dependencies and kind change only after `rework` |
| `task note ID TEXT` | append a note |
| `task show ID`, `task list [--status S]` | read; `S` is a status, `ready` or `blocked` |
| `plan import FILE` | add tasks from a JSON array of task objects (ids may be local names, resolved in order; `-` reads stdin). Fields: `id`, `title`, `acceptance`, `kind`, `size`, `depends_on`, `role`, `needs_owner`. A dependency names an earlier entry or an existing task. Any bad entry refuses the whole file |
| `brief set ID (--file F \| -)`, `brief get ID` | write or read the task's brief |
| `validate` | report cycles, unknown dependencies, tasks without acceptance, `L` tasks without a `split:` note, oversize budgets (planned hours at S=1, M=4, L=8 over `budget.hours`, or spend over either budget); exit 1 if anything is reported |

## Run

| Command | Does |
|---|---|
| `ready [--all]` | ready tasks in priority order (the ones that unblock the most work first); `--all` lists blocked ones with the reason |
| `claim ID [--lease MIN]` | take a ready task for `--agent`; refused if not ready, already claimed, or the workers limit is reached (tasks in progress with a live lease) |
| `renew ID [--lease MIN]` | extend the lease from now; only the claimant. An expired lease takes a worker slot again, so its renewal is refused when the workers limit is reached |
| `release ID --reason R` | give it back; status returns to its prior `todo` or `rework`. The claimant or an explicit owner |
| `submit ID --sha S [--branch B] [--pr N] [--summary T]` | mark submitted as the claimant or replace a submitted head as its submitter. `S` is 7 to 64 hex characters |
| `evidence ID --type T (--ok \| --fail) [--sha S] [--summary T] [--ref URL]` | record evidence; `--sha` is required except for `note`, which defaults to the task's submitted sha |
| `accept ID [--waive TYPE --reason R]` | accept if the gates pass (see state.md) |
| `rework ID --reason R` | send a submitted or accepted task back; the reason is appended under `## Rework notes` in its brief and as a task note |
| `spend ID [--minutes N] [--tokens N]` | add spend |
| `owner-done ID [--note T]` | the owner did what `needs_owner` asked; clears it. Requires explicit `--agent owner` or `GISHRA_AGENT=owner` |

While a task is `submitted`, its recorded `submitted_by` agent can submit another head without claiming again. The task stays `submitted`; omitted `--branch` and `--pr` keep their current values. Evidence stays in the audit trail, but evidence at the older head stops satisfying gates for the new head. Submitting the same sha keeps its evidence valid. The `submit` event records `previous_sha` and `sha`. Once accepted, the task needs `rework` and a new claim before another submission.

Pass the commit actually reviewed or checked to `evidence --sha S`. A submitted head can move while a review is running; `gishra evidence ID --type review --ok --sha S --agent REVIEWER` pins the result to that commit. Missing `--sha` on any non-`note` evidence is a usage error (exit 2) and writes nothing. A `note` without `--sha` needs an existing submitted sha. Software gates record their own sha.

## Decisions

| Command | Does |
|---|---|
| `ask --question Q --option A --option B [--recommend A] [--why W] [--blocks ID]...` | open a decision; prints its id |
| `answer DID --choice C [--note T]` | answer it (any agent may record the owner's answer; the event names who). `C` must be one of the options when there are any; an answered decision stays answered |
| `decisions [--open]` | list |

## Views

| Command | Does |
|---|---|
| `status` | one screen: counts by status, ready tasks, open decisions, owner tasks, spend against budget, expired leases |
| `render` | write `sketch.md` (Mermaid graph plus tables) and `sketch.html` (self-contained, no network) from the state as it stands under the lock |
| `serve [--port P]` | serve the sketch on 127.0.0.1 (default port 4747; 0 picks a free one) and reload open pages over server-sent events when the state changes. Pages are rendered from the state on each request. Exits 1 if the port is in use |

## Agents and worktrees

| Command | Does |
|---|---|
| `worktree ID` | create (or print) a git worktree and branch `gishra/<id>-<slug>` from `base` for the task, at `<repo-parent>/<repo>-worktrees/<id>-<slug>`; records the branch on the task. Once the task has a branch, its worktree is found by branch, so renaming the task does not move it |
| `spawn --role R --task ID [--dry-run] [--wait]` | start the role's harness in the task's worktree with the brief and task as the prompt; sets `GISHRA_STATE`, `GISHRA_TASK`, `GISHRA_AGENT`; logs to the state directory; prints the pid or, with `--dry-run`, the command |

`spawn` checks the role, the brief (`brief set`) and the harness program (on `PATH`, or at the path the role gives) before it creates anything. If the program still fails to start, or the lock cannot be taken, it records nothing and exits with the reason, naming the worktree it created; the worktree and branch stay, and the next spawn of the task reuses them. `spawn` never deletes a worktree or branch. The agent is named `<role>-<task>-<n>`, numbered from earlier spawns of that role on that task. The prompt is the brief, then the task's id, title, acceptance and kind as JSON, then a line telling the agent to use the `gishra` CLI for every state change. It says `you are not the owner; never pass --agent owner`. Its closing instruction says `run gishra with --agent <name> if GISHRA_AGENT is missing`, using the same name passed in the environment. It runs in the task's worktree, which is created if missing; `--dry-run` creates nothing. In the background the agent is detached, its output goes to `logs/<task>-<agent>.log` and the `spawn` event records its pid. With `--wait` it runs in the foreground (its stdout goes to stderr under `--json`) and gishra exits with its code.

| Harness | Command |
|---|---|
| `claude` | `claude -p <prompt> [--model M] [--effort E] --output-format json` |
| `codex` | `codex exec [-p PROFILE] [-m M] [-c model_reasoning_effort=E] <prompt>` |
| `opencode` | `opencode run [-m M] <prompt>` |
| `agy` | `agy -p <prompt> --mode accept-edits [--model M] [--effort E]` |
| `pi` | `pi -p <prompt> [--model M] [--provider P] [--thinking E] [--skill DIR]` |
| `command` | the role's `command` array with `{task}`, `{brief}`, `{prompt}` and `{cwd}` substituted |

The role's `args` follow every command. A pi `worker` gets `--skill <root>/skills/gishra-work` and a pi `reviewer` `--skill <root>/skills/gishra-review`, where `<root>` is `GISHRA_PLUGIN_ROOT` or the gishra package itself, when that directory exists. A prompt that would start with `-` gets a leading newline so no harness reads it as an option.

## Gates

Each gate runs software, then records evidence on the task. The gate itself lives in `lib/gates/<name>.js` and exports `async run(ctx)` returning `{ ok, summary, ref?, sha? }`, where `ctx` is `{ root, worktree, task, project, args, log }`. The CLI runs it without holding the lock, then records the result as evidence of the gate's type by `--agent`, at the returned `sha` or the submitted one, against the revision the gate started on. A gate that reports `ok: false` exits 1 after recording. A missing gate module exits 1 with "gate not installed".

| Command | Does |
|---|---|
| `check tests ID --cmd CMD` | run CMD in the worktree at the submitted sha (must pass), then with the task's changes to non-test files reverted (must fail when the task added or changed tests); test files follow the default layouts or project.json `tests.paths` (see state.md); records `tests` |
| `check clean ID` | run the cleanup tool on the task branch against `base`; records `clean`, ok when every check ran and none reported a HIGH finding |
| `check ci ID` | read GitHub check runs and check suites on the submitted sha; ok only when at least one run exists and every run and suite completed as success, neutral or skipped, skipping only apps in project.json `ci.ignore_apps`; records `ci` |
| `merge ID` | merge the task's PR with `--match-head-commit` when the task is accepted and its gates still pass for its current revision (refused otherwise); records `merge` |
