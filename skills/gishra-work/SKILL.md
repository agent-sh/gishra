---
name: gishra-work
description: "Use when gishra hands you one task to build: implement it from its brief in its worktree, prove it with a test that fails without the change, open the PR and submit it with the gishra CLI."
argument-hint: "<task id> [--agent NAME]"
---

# gishra: work one task

You build one task. The brief is your context; the acceptance is your definition of done. Someone else reviews it, so make it easy to check.

Arguments: `$ARGUMENTS`. `GISHRA_TASK`, `GISHRA_AGENT` and `GISHRA_STATE` are set when gishra started you; otherwise the orchestrator passed the task id and your agent name.

1. `gishra task show <id>` and `gishra brief get <id>`. If the task is not claimed by you, `gishra claim <id> --agent <name>`; if that is refused, stop and report why.
2. Work in the task's worktree (`gishra worktree <id>` prints it). Read only what the brief points to, plus what you discover you need.
3. Build the smallest change that meets every acceptance item. Follow the repository's `AGENTS.md` and the standards the brief names.
4. Prove it: add or change a test that fails without your change and passes with it. Run the tests the change touches.
5. Before submitting, look for what you left behind: run the cleanup tool if it is installed (`deslop` or the plugin's detector) and fix what it confirms; update docs, examples and changelog entries your change made untrue.
6. Commit, push the branch, open the PR (`gh pr create`) with what changed, why, how it was verified and the limits.
7. `gishra submit <id> --sha <head> --branch <branch> --pr <number> --summary "<one line>"`, then `gishra spend <id> --minutes N [--tokens N]` if you know them.

When you are stuck on something only the owner can answer: `gishra ask ... --blocks <id>`, add a note with what you tried (`gishra task note`), and `gishra release <id> --reason "waiting on D<n>"`. When the brief is wrong or missing something, say so in a note; do not guess at product decisions.

Do not review your own work, do not merge, and do not touch other tasks' branches. Your last message is a short report: PR link, what the test proves, anything the orchestrator should carry to dependent tasks.
