---
name: gishra-work
description: "Use when gishra hands you one task: implement its brief in its worktree, verify its acceptance, open the PR and submit it with the gishra CLI."
argument-hint: "<task id> [--agent NAME]"
---

# gishra: work one task

You build one task. The brief is your context; the acceptance is your definition of done. Someone else reviews it, so make it easy to check.

Arguments: `$ARGUMENTS`. Use `GISHRA_TASK` and `GISHRA_AGENT` when set; otherwise use the task id and agent name passed by the orchestrator. Pass `--agent <name>` on every gishra call. If `GISHRA_STATE` is absent, also pass `--state <dir>` with the supplied state directory.

1. `gishra task show <id> --agent <name>`, `gishra brief get <id> --agent <name>` and `gishra project show --agent <name>`. If not claimed by you, `gishra claim <id> --agent <name> --lease MIN`, sized for expected work and waits using `limits.lease_minutes` as the default; if refused, stop and report why. If work needs longer, renew before expiry with `gishra renew <id> --agent <name> --lease MIN` when reporting progress.
2. Work in the task's worktree (`gishra worktree <id> --agent <name>` prints it). Native workers use absolute paths under that worktree for every edit and command. Read only what the brief points to, plus what you discover you need.
3. Build the smallest change that meets every acceptance item. Follow the repository's `AGENTS.md` and the standards the brief names.
   Report progress through `gishra task note` or `gishra msg --to orchestrator --task <id> "<update>"`. Renew your lease with `gishra renew <id>` when the work needs longer.
4. For code changes, add or change a test that fails without the change and passes with it; run the tests touched. For other work, verify the acceptance as the brief specifies.
5. Before submitting, run the configured cleanup tool if enabled and fix what it confirms; update docs, examples and changelog entries your change made untrue.
6. Commit, push the branch, create or update the PR (`gh pr create` or `gh pr edit`) with what changed, why, how it was verified and the limits.
7. `gishra submit <id> --agent <name> --sha <head> --branch <branch> --pr <number> --summary "<one line>"`, then `gishra spend <id> --agent <name> --minutes N` if you know them. Spawned CLI usage is recorded automatically on exit. For a native dispatch, the orchestrator records tokens once with `gishra spend <id> --tokens N [--input I] [--cached C] [--output O] --rung R --harness H --model M --agent <name>`.

When only the owner can unblock you: `gishra ask --agent <name> --question "<question>" --option "<A>" --option "<B>" --blocks <id>`, then `gishra task note <id> "<what you tried>" --agent <name>` and `gishra release <id> --agent <name> --reason "waiting on D<n>"`. Note a wrong or incomplete brief, or a task harder than its tier (`gishra task show` prints it) so the orchestrator can re-tier it; do not guess at product decisions.

Do not review your own work, do not merge, and do not touch other tasks' branches. Your last message is a short report: PR link, what the test proves, anything the orchestrator should carry to dependent tasks.
