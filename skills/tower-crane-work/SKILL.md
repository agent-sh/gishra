---
name: tower-crane-work
description: "Use when Tower Crane hands you one task: implement its brief in its worktree, verify its acceptance, open the PR and submit it with the tower-crane CLI."
argument-hint: "<task id> [--agent NAME]"
---

# Tower Crane: work one task

You build one task. The brief is your context; the acceptance is your definition of done. Someone else reviews it, so make it easy to check.

Arguments: `$ARGUMENTS`. Use `TOWER_CRANE_TASK` and `TOWER_CRANE_AGENT` when set; otherwise use the task id and agent name passed by the orchestrator. Pass `--agent <name>` on every tower-crane call. If `TOWER_CRANE_STATE` is absent, also pass `--state <dir>` with the supplied state directory.

1. `tower-crane task show <id> --agent <name>`, `tower-crane brief get <id> --agent <name>` and `tower-crane project show --agent <name>`. If not claimed by you, `tower-crane claim <id> --agent <name> --lease MIN`, sized for expected work and waits using `limits.lease_minutes` as the default; if refused, stop and report why. If work needs longer, renew before expiry with `tower-crane renew <id> --agent <name> --lease MIN` when reporting progress.
2. Work in the task's worktree (`tower-crane worktree <id> --agent <name>` prints it). Native workers use absolute paths under that worktree for every edit and command. Read only what the brief points to, plus what you discover you need.
3. Build the smallest change that meets every acceptance item. Follow the repository's `AGENTS.md` and the standards the brief names.
   Report progress through `tower-crane task note` or `tower-crane msg --to orchestrator --task <id> "<update>"`. Renew your lease with `tower-crane renew <id>` when the work needs longer.
4. For code changes, add or change a test that fails without the change and passes with it; run the tests touched. For research, use the network to search for evidence and fetch at least `research.min_sources` distinct pages (default 10). Commit `research/<id>.json` with `sources: [{id, url}]` and `claims: [{claim, quote, source}]`. Every claim cites a source and quotes text found on its page; every source must be cited. The sources gate fetches them again at check time. For other work, verify the acceptance as the brief specifies.
5. Before submitting, run the configured cleanup tool if enabled and fix what it confirms; update docs, examples and changelog entries your change made untrue.
6. Commit, push the branch, create or update the PR (`gh pr create` or `gh pr edit`) with what changed, why, how it was verified and the limits.
7. `tower-crane submit <id> --agent <name> --sha <head> --branch <branch> --pr <number> --summary "<one line>"`, then `tower-crane spend <id> --agent <name> --minutes N` if you know them. Spawned CLI usage is recorded automatically on exit. For a native dispatch, the orchestrator records tokens once with `tower-crane spend <id> --tokens N [--input I] [--cached C] [--output O] --rung R --harness H --model M --agent <name>`.

When only the owner can unblock you: `tower-crane ask --agent <name> --question "<question>" --option "<A>" --option "<B>" --blocks <id>`, then `tower-crane task note <id> "<what you tried>" --agent <name>` and `tower-crane release <id> --agent <name> --reason "waiting on D<n>"`. Note a wrong or incomplete brief, or a task harder than its tier (`tower-crane task show` prints it) so the orchestrator can re-tier it; do not guess at product decisions.

Do not review your own work, do not merge, and do not touch other tasks' branches. Your last message is a short report: PR link, what the test proves, anything the orchestrator should carry to dependent tasks.
