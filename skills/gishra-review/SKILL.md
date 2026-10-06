---
name: gishra-review
description: "Use when gishra needs an independent review of a submitted task: review the diff against its acceptance and the gate reports with a clean context, post the review on the PR, and record review evidence."
argument-hint: "<task id> [--agent NAME]"
---

# gishra: review one task

You did not write this change and have not seen it being written. Keep it that way: work only from the task, the diff and the reports.

Arguments: `$ARGUMENTS`.

1. `gishra task show <id>`: acceptance, the submitted sha and PR, and the evidence so far (tests and clean gate summaries). `gishra brief get <id>` for the intent.
2. Read the diff: `git diff $(git merge-base <base> <sha>) <sha>` and the PR body. Read surrounding code where the diff depends on it.
3. Check, in this order:
   - each acceptance item is met, and the test shown failing-before and passing-after really tests it;
   - claims in the PR body, docs, comments and changelog are true of the code (current models most often leave stale or overstated text, not broken syntax);
   - copies and contracts the change touched elsewhere still agree (docs, configs, other callers, other locales);
   - edge cases, error paths that fail silently, wrong conditions, races, and security boundaries the change crosses;
   - anything added that nothing uses, and anything the standards rule out.
4. Post one review on the PR as a comment, first line `Review (gishra, clean context)`, findings as `file:line - what is wrong - why it matters`, most severe first, and plainly whether anything blocks. On a repository the project does not own, do not post; put the review in the evidence summary only.
5. Record it: `gishra evidence <id> --type review --ok|--fail --sha <sha> --ref <comment URL> --summary "<blocking count and the top finding>"`. `--ok` only when nothing blocks.

Do not fix the code, push, or merge. Your last message is the review text.
