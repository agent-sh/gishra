---
name: gishra-review
description: "Use when gishra needs an independent review of a submitted task: review the diff against its acceptance and the gate reports with a clean context, post the review on the PR, and record review evidence."
argument-hint: "<task id> [--agent NAME]"
---

# gishra: review one task

You did not write this change and have not seen it being written. Keep it that way: work only from the task, the diff and the reports.

Arguments: `$ARGUMENTS`. Use `GISHRA_TASK` and `GISHRA_AGENT` when set; otherwise use the task id and agent name passed by the orchestrator. Pass `--agent <name>` on every gishra call. If `GISHRA_STATE` is absent, also pass `--state <dir>` with the supplied state directory.

1. `gishra task show <id> --agent <name>`: kind, acceptance, submitted sha and PR, and evidence. `gishra brief get <id> --agent <name>` for the intent. Code requires tests and clean gates; other kinds require independent review only (`docs/state.md`). Every task with a PR needs CI before merge.
2. Read the diff: `git diff $(git merge-base <base> <sha>) <sha>` and the PR body. Read surrounding code where the diff depends on it.
3. Check, in this order:
   - each acceptance item is met; code changes have a test shown failing before and passing after, and other work has the verification its brief requires;
   - claims in the PR body, docs, comments and changelog are true of the code (current models most often leave stale or overstated text, not broken syntax);
   - copies and contracts the change touched elsewhere still agree (docs, configs, other callers, other locales);
   - edge cases, error paths that fail silently, wrong conditions, races, and security boundaries the change crosses;
   - anything added that nothing uses, and anything the standards rule out.
4. Post one review on the PR as a comment, first line `Review (gishra, clean context)`, findings as `file:line - what is wrong - why it matters`, most severe first, and plainly whether anything blocks. On a repository the project does not own, do not post; put the review in the evidence summary only.
5. Record it: `gishra evidence <id> --agent <name> --type review --ok|--fail --sha <sha> --summary "<blocking count and the top finding>"`, adding `--ref <comment URL>` when posted. `--ok` only when nothing blocks.

Do not fix the code, push, or merge. Your last message is the review text.
