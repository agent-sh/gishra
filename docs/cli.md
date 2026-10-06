# CLI

`gishra <command> [args]`. Every command accepts `--state DIR`, `--agent NAME`, `--json` (machine output on stdout: the task, decision, project or list the command touched) and `--help`. Exit status: 0 done, 1 refused (with the reason on stderr), 2 usage error, 3 lock not acquired within 10 s. `validate` and a failing gate print their report on stdout and exit 1; `spawn --wait` exits with the agent's code.

Agent identity comes from `--agent NAME`, then `GISHRA_AGENT`. With neither, `owner` is used only when stdin and stdout are both TTYs and `GISHRA_TASK` is unset. Otherwise the command exits 2 with `no agent: pass --agent NAME or set GISHRA_AGENT` and writes nothing. An empty or whitespace-only identity exits 2 with the same message. Help needs no agent.

`accept --waive`, `owner-done`, clearing or replacing an existing `needs_owner` through `task update`, and releasing another agent's claim require the resolved name to be exactly `owner`, supplied explicitly by `--agent owner` or `GISHRA_AGENT=owner`. The terminal fallback never grants these owner powers. An agent requests owner action with `gishra ask` or a task note.

Writes take the lock, re-read the files, validate, write atomically, append to `events.jsonl` and re-render the sketch. `render` takes the lock too. A refused command writes nothing.

## Plan

| Command | Does |
|---|---|
| `init --name N --goal G [--repo O/R] [--base B] [settings]` | create the state directory and `project.json` with the default harness and ladder (from the user file, else built in); takes the `project set` settings too. Refused if the user file is invalid |
| `project set [--name N] [--goal G] [--repo O/R] [--base B] [--workers N] [--lease-minutes MIN] [--budget-hours H] [--budget-tokens N] [--standards S]` | change settings, limits and budget |
| `project show` | print settings and the resolved ladder |
| `ladder show` | print each rung as it resolves: harness (and whether it is the default), model, profile, provider, effort, args, and where the rung comes from (project, user file or built-in); also the default harness, its source, the user file path, and every rung that cannot run (`problems` under `--json`) |
| `ladder set RUNG [--harness H] [--model M] [--profile P] [--provider P] [--effort E] [--args JSON] [--command JSON] [--clear FIELD]...` | change the named fields of one rung and keep the rest; `--clear` removes a field (a cleared harness follows the default). A rung the project left out starts from the one it fell back to. Refused if it leaves a rung unable to run that could run before (state.md lists the checks); rungs already broken do not block it |
| `ladder harness H` | set the default harness; every rung without its own moves to it. Refused, naming the rungs, if one of them cannot run there (a codex profile on pi, a missing model) |
| `ladder save-user` | write the project's resolved ladder and default harness to the user file (`GISHRA_CONFIG`, else `~/.config/gishra/config.json`), the defaults for new projects. Refused while a rung cannot run. A user file that is not valid JSON or has the wrong shape refuses every command that has to read it (`ladder` commands and `spawn` on a project that leaves rungs out, and `init`); the error names the file to fix or remove |
| `task add --title T --acceptance A [--acceptance A2] [--kind K] [--size S] [--tier T] [--dep ID] [--needs-owner REASON]` | add a task; prints its id. `T` is `easy`, `medium`, `hard` or `research`; without it the tier comes from kind and size (state.md). Refused for an unknown dependency |
| `task update ID [--title] [--acceptance (replaces)] [--dep (replaces)] [--size] [--kind] [--tier] [--needs-owner] [--status cancelled]` | change a task; acceptance or dependency changes bump `revision`. `--dep ''` clears dependencies, `--needs-owner ''` clears the owner ask. Clearing or replacing an existing owner ask requires explicit owner identity; any agent may set a new ask or keep the same reason. Refused if it would form a cycle. An accepted task cannot be cancelled, and its acceptance, dependencies and kind change only after `rework` |
| `task note ID TEXT` | append a note |
| `task show ID`, `task list [--status S]` | read; `S` is a status, `ready` or `blocked` |
| `plan import FILE` | add tasks from a JSON array of task objects (ids may be local names, resolved in order; `-` reads stdin). Fields: `id`, `title`, `acceptance`, `kind`, `size`, `tier`, `depends_on`, `needs_owner`. A dependency names an earlier entry or an existing task. Any bad entry refuses the whole file |
| `brief set ID (--file F \| -)`, `brief get ID` | write or read the task's brief |
| `validate` | report cycles, unknown dependencies, tasks without acceptance, `L` tasks without a `split:` note, oversize budgets (planned hours at S=1, M=4, L=8 over `budget.hours`, or spend over either budget); exit 1 if anything is reported. It also reports every ladder rung that cannot run, and warns, without failing, when the `review` rung runs the same harness and model as a tier (on codex the `--model` when given, else the profile) that open tasks use, since such a review shares the author's blind spots |

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
| `serve [--port P]` | serve the sketch and a Settings view on 127.0.0.1 (default port 4747; 0 picks a free one) and reload open pages over server-sent events when the state changes. Pages are rendered from the state on each request. Exits 1 if the port is in use |

The Settings view (`/settings`) edits the default harness, every rung and each task's tier. While a form has unsaved edits, a change on disk shows a notice instead of reloading the page. A form is read-only while its save is in flight, with its Save button showing `Saving...`. Saving a form reloads the page only when the other form has nothing unsaved; otherwise the saved form shows the server's state in place and the other keeps its edits. A save sends the values its edit was based on, so one made against a rung, default harness or tier that changed since the page loaded is refused, and the page says to reload.

### serve endpoints

| Method and path | Does |
|---|---|
| `GET /`, `GET /sketch.html` | the sketch, rendered from the state on each request, with links to the views |
| `GET /settings` | the Settings view; carries the run's token in `<meta name="gishra-token">` |
| `GET /events` | server-sent events; `reload` whenever `project.json`, `tasks.json` or `decisions.json` changes, with data `{ "version": "<v>" }`, an opaque token for that state |
| `POST /api/ladder` | change the default harness and rungs, as `ladder harness` and `ladder set` do |
| `POST /api/tiers` | change task tiers, as `task update --tier` does |

Every POST needs:

- `x-gishra-token: <token>`, the random token of this serve run, which only the Settings page carries;
- `content-type: application/json` and a body of at most 64 KiB;
- an `Origin`, if the browser sends one, of `http://127.0.0.1:<port>` or `http://localhost:<port>`.

serve answers any request only when its `Host` is `127.0.0.1:<port>` or `localhost:<port>`, so a page on another site cannot reach it through a name rebound to 127.0.0.1 and read the token.

`POST /api/ladder` body, with `harness` and `rungs` optional but at least one change, and `base` required:

```json
{
  "harness": "pi",
  "rungs": {
    "easy": { "harness": "", "model": "openai/gpt-5.5", "profile": "", "effort": "low", "args": "[\"--no-session\"]" }
  },
  "base": { "harness": "codex", "rungs": { "easy": { "profile": "luna", "effort": "medium" } } }
}
```

`base` is what the edit was made against: the default harness, and the own fields of each rung in `rungs` (as `ladder show` prints them, without `harness_from` and `from`, and with `harness` only when the rung names its own). If any of them differs from the state under the lock, the request is refused with 409 and writes nothing, so a form cannot undo a change made elsewhere with fields nobody touched.

Each rung lists the fields to change, as strings. An empty string clears the field; a field left out keeps its value. `args` and `command` are JSON array text, as on the command line. The whole request is one write: if it leaves a rung unable to run that could run before, nothing is written. The reply is `{ "ok": true, ... }` plus what `ladder show --json` prints (`harness`, `harness_from`, `user_file`, `user_file_exists`, `ladder`).

`POST /api/tiers` body: `{ "tiers": { "T1": "hard", "T4": "research" }, "base": { "T1": "medium", "T4": "medium" } }`, where `base` holds each task's tier as the edit saw it; a task whose tier differs now is refused with 409. All tiers are written in one write, or none. The reply is `{ "ok": true, "tiers": [{ "id": "T1", "tier": "hard" }, ...] }`.

Every successful reply also carries `version`, the state's version after the write, the same token the `reload` event for that write carries; the page uses it to tell its own write from one made elsewhere.

Both write under the lock, validate, log events (`ladder harness`, `ladder set` per rung, `task update` per task) with `"via": "serve"` and the agent serve runs as, and re-render the sketch. Refusals reply `{ "error": "<reason>" }`: 400 for a refused or malformed change (the reason is the one the CLI gives, prefixed with the rung or task it is about), 409 when `base` no longer matches the state, 403 for a missing or wrong token, a foreign origin or a foreign host, 404 for an unknown POST path, 405 for a method other than GET or POST, 413 for an oversize body, 415 for a body that is not JSON, 503 when the state lock is busy, 500 for anything else.

## Agents and worktrees

| Command | Does |
|---|---|
| `worktree ID` | create (or print) a git worktree and branch `gishra/<id>-<slug>` from the freshest base for the task, at `<repo-parent>/<repo>-worktrees/<id>-<slug>`; records the branch on the task. Once the task has a branch, its worktree is found by branch, so renaming the task does not move it |
| `spawn --task ID [--role RUNG] [--dry-run] [--wait]` | start a rung's harness in the task's worktree with the brief and task as the prompt: the rung of the task's tier, or the rung `--role` names (`--role review` for a review); sets `GISHRA_STATE`, `GISHRA_TASK`, `GISHRA_AGENT`; logs to the state directory; prints the pid or, with `--dry-run`, the command. The rung is resolved again from the state read under the lock, so a tier or ladder change made while spawn created the worktree is the one that runs |

Before creating a new task branch, `worktree` fetches `base` from `origin` into `origin/<base>`, even when the remote's fetch configuration excludes that branch. It starts from the fetched commit when the local base is missing or is an ancestor of it. A local base that is ahead of or diverges from origin remains the starting point, with both commit SHAs reported on stderr; the local base branch is never moved. If origin has no such branch, it uses the local base and reports that fallback on stderr, or refuses if the local base is missing too. Without an origin remote, it uses the available local base or `origin/<base>`.

Concurrent fetches that race to update `origin/<base>` continue only after a fresh read of origin confirms that the tracking ref matches its tip. Fetch and verification each time out after 60 s to bound dispatch stalls when origin is unreachable; the error names the operation and timeout. Other fetch failures refuse before a task branch is created or recorded. An existing task branch or worktree is reused without fetching, so it remains usable offline. `spawn` uses the same worktree creation behavior.

`spawn` checks the rung, the brief (`brief set`) and the harness program (on `PATH`, or at the path the rung gives) before it creates anything. If the program still fails to start, or the lock cannot be taken, it records nothing and exits with the reason, naming the worktree it created; the worktree and branch stay, and the next spawn of the task reuses them. `spawn` never deletes a worktree or branch. The agent is named `<job>-<task>-<n>`, where the job is `worker` for the four tiers, `reviewer` for `review`, and the rung's name otherwise, numbered from earlier spawns of that job on that task. The prompt is the brief, then the task's id, title, acceptance and kind as JSON, then a line telling the agent to use the `gishra` CLI for every state change. It says `you are not the owner; never pass --agent owner`. Its closing instruction says `run gishra with --agent <name> if GISHRA_AGENT is missing`, using the same name passed in the environment. It runs in the task's worktree, which is created if missing; `--dry-run` creates nothing. In the background the agent is detached, its output goes to `logs/<task>-<agent>.log` and the `spawn` event records its pid. With `--wait` it runs in the foreground (its stdout goes to stderr under `--json`) and gishra exits with its code.

| Harness | Command |
|---|---|
| `claude` | `claude -p <prompt> [--model M] [--effort E] --output-format json` |
| `codex` | `codex exec [-p PROFILE] [-m M] [-c model_reasoning_effort=E] <prompt>` |
| `opencode` | `opencode run [-m M] [--variant E] <prompt>` |
| `agy` | `agy -p <prompt> --mode accept-edits [--model M] [--effort E]` |
| `pi` | `pi -p <prompt> [--model M] [--provider P] [--thinking E] [--skill DIR]` |
| `command` | the rung's `command` array with `{task}`, `{brief}`, `{prompt}` and `{cwd}` substituted |

The rung's `args` follow every command. A pi worker (any tier) gets `--skill <root>/skills/gishra-work` and a pi reviewer `--skill <root>/skills/gishra-review`, where `<root>` is `GISHRA_PLUGIN_ROOT` or the gishra package itself, when that directory exists. A prompt that would start with `-` gets a leading newline so no harness reads it as an option.

## Gates

Each gate runs software, then records evidence on the task. The gate itself lives in `lib/gates/<name>.js` and exports `async run(ctx)` returning `{ ok, summary, ref?, sha? }`, where `ctx` is `{ root, worktree, task, project, args, log }`. The CLI runs it without holding the lock, then records the result as evidence of the gate's type by `--agent`, at the returned `sha` or the submitted one, against the revision the gate started on. A gate that reports `ok: false` exits 1 after recording. A missing gate module exits 1 with "gate not installed".

| Command | Does |
|---|---|
| `check tests ID --cmd CMD` | run CMD in the worktree at the submitted sha (must pass), then with the task's changes to non-test files reverted (must fail when the task added or changed tests); test files follow the default layouts or project.json `tests.paths` (see state.md); records `tests` |
| `check clean ID` | run the cleanup tool on the task branch against `base`; records `clean`, ok when every check ran and none reported a HIGH finding |
| `check ci ID` | read GitHub check runs and check suites on the submitted sha; ok only when at least one run exists and every run and suite completed as success, neutral or skipped, skipping only apps in project.json `ci.ignore_apps`; records `ci` |
| `merge ID` | merge the task's PR with `--match-head-commit` when the task is accepted and its gates still pass for its current revision (refused otherwise); records `merge` |
