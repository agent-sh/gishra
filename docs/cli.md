# CLI

`gishra <command> [args]`. Every command accepts `--state DIR`, `--agent NAME` (default `GISHRA_AGENT`, else `owner`) and `--json` (machine output on stdout). Exit status: 0 done, 1 refused (with the reason on stderr), 2 usage error, 3 lock not acquired within 10 s.

Writes take the lock, re-read the files, validate, write atomically, append to `events.jsonl` and re-render the sketch.

## Plan

| Command | Does |
|---|---|
| `init --name N --goal G [--repo O/R] [--base B]` | create the state directory and `project.json` with the default roles |
| `role set ROLE --harness H [--model M] [--profile P] [--command JSON]` | set who plays a role |
| `task add --title T --acceptance A [--acceptance A2] [--kind K] [--size S] [--dep ID] [--role R] [--needs-owner REASON]` | add a task; prints its id |
| `task update ID [--title] [--acceptance (replaces)] [--dep (replaces)] [--size] [--kind] [--role] [--needs-owner] [--status cancelled]` | change a task; acceptance or dependency changes bump `revision` |
| `task note ID TEXT` | append a note |
| `task show ID`, `task list [--status S]` | read |
| `plan import FILE` | add tasks from a JSON array of task objects (ids may be local names, resolved in order) |
| `brief set ID (--file F \| -)`, `brief get ID` | write or read the task's brief |
| `validate` | report cycles, unknown dependencies, tasks without acceptance, `L` tasks without a split note, oversize budgets |

## Run

| Command | Does |
|---|---|
| `ready [--all]` | ready tasks in priority order (dependents unblocked first); `--all` lists blocked ones with the reason |
| `claim ID [--lease MIN]` | take a ready task for `--agent`; refused if not ready, already claimed, or the workers limit is reached |
| `renew ID` | extend the lease |
| `release ID --reason R` | give it back; status returns to its prior `todo` or `rework` |
| `submit ID --sha S [--branch B] [--pr N] [--summary T]` | mark submitted; only the claimant |
| `evidence ID --type T (--ok \| --fail) [--sha S] [--summary T] [--ref URL]` | record evidence; `sha` defaults to the task's submitted sha |
| `accept ID [--waive TYPE --reason R]` | accept if the gates pass (see state.md) |
| `rework ID --reason R` | send back; the next claim sees the reason in the brief's notes |
| `spend ID [--minutes N] [--tokens N]` | add spend |
| `owner-done ID [--note T]` | the owner did what `needs_owner` asked; clears it |

## Decisions

| Command | Does |
|---|---|
| `ask --question Q --option A --option B [--recommend A] [--why W] [--blocks ID]...` | open a decision; prints its id |
| `answer DID --choice C [--note T]` | answer it (any agent may record the owner's answer; the event names who) |
| `decisions [--open]` | list |

## Views

| Command | Does |
|---|---|
| `status` | one screen: counts by status, ready tasks, open decisions, owner tasks, spend against budget, expired leases |
| `render` | write `sketch.md` (Mermaid graph plus tables) and `sketch.html` (self-contained, no network) |
| `serve [--port P]` | serve `sketch.html` and refresh it when the state changes |

## Agents and worktrees

| Command | Does |
|---|---|
| `worktree ID` | create (or print) a git worktree and branch `gishra/<id>-<slug>` from `base` for the task |
| `spawn --role R --task ID [--dry-run] [--wait]` | start the role's harness in the task's worktree with the brief and task as the prompt; sets `GISHRA_STATE`, `GISHRA_TASK`, `GISHRA_AGENT`; logs to the state directory; prints the pid or, with `--dry-run`, the command |

## Gates

Each gate runs software, then records evidence on the task.

| Command | Does |
|---|---|
| `check tests ID --cmd CMD` | run CMD in the worktree at the submitted sha (must pass), then with the task's changes to non-test files reverted (must fail when the task added or changed tests); records `tests` |
| `check clean ID` | run the cleanup tool on the task branch against `base`; records `clean`, ok when it reports no HIGH finding |
| `check ci ID` | read GitHub check runs on the submitted sha; ok only when all completed and none failed, cancelled, timed out or skipped-required; records `ci` |
| `merge ID` | merge the task's PR with `--match-head-commit` when the task is accepted; records `merge` |
