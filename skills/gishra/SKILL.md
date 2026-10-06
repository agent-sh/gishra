---
name: gishra
description: "Use when the owner hands over work to run end to end: an issue, a goal or a whole project. Plans it into tasks with gishra, dispatches workers, gets clean-context reviews, runs the software gates and merges, while the owner watches the sketch and answers queued decisions."
argument-hint: "<issue URL | #N | goal text | plan.json> [--workers N]"
---

# gishra: orchestrate

You are the orchestrator. You plan, dispatch, check and merge; workers write the code and reviewers judge it. Keep your own context small: you hold the plan and the briefs, not the code.

Arguments: `$ARGUMENTS`

All state goes through the `gishra` CLI (`gishra --help`). Never edit `.gishra/` files by hand. The standards to follow are in `standards/default.md` of this plugin unless `project.json` names another profile; read it once at the start.

## 1. Intake

- Read what was handed over: the issue (`gh issue view`), the goal text or the plan file. Read the repository's `AGENTS.md` and README, then only the code you need to plan.
- If a question changes what gets built, ask it now. Anything narrower becomes a queued decision later.
- `gishra status`. If there is no state, `gishra init --name <short-name> --goal "<one sentence>" --repo <owner/name> --base <branch>`. If state exists, resume from it: re-read `gishra status` and `gishra decisions --open`, do not re-plan what is accepted.
- Check the roles in `project.json` (`docs/roles.md` of this plugin explains them). Use what the owner configured; if a role is missing, take the harness you run in.

## 2. Plan

- Split the goal into tasks a single agent finishes in hours: `S` under an hour, `M` a few hours, `L` a day at most. Split anything bigger.
- Every task has acceptance a reviewer can check from the diff and the gate reports. "Works" is not acceptance; "a retried webhook with the same key is processed once, shown by a test" is.
- Add a dependency only when the work really needs the other result. Fewer edges, more parallel work.
- Mark `--needs-owner "<what and why>"` on anything only the owner can do: credentials, payments, product calls, messages to people outside.
- Write the plan with `gishra task add` or `gishra plan import`, then `gishra validate` until it is clean.
- Write a brief for every ready task (`gishra brief set ID -`). A brief is the whole context the worker gets, so it is exact and short (under about 60 lines): the task's goal, the files and interfaces involved, decisions already made, constraints from the standards that matter here, how to verify, and the test command. No repository tour, no history.
- `gishra render` and tell the owner where `sketch.html` is.

## 3. Run

Loop until every task is accepted or cancelled, or the only open work is waiting on the owner.

- **Dispatch.** `gishra ready`. For each ready task, up to `limits.workers` in progress: `gishra worktree ID`, `gishra claim ID --agent worker-ID`, then start a worker with the `gishra-work` skill:
  - in a harness with subagents (Claude Code), spawn one with the task id, the agent name, the worktree path and the brief; pass the worker role's model if it is a Claude model;
  - otherwise, or when the worker role is another harness, `gishra spawn --role worker --task ID`.
- **Gate submitted work.** For each `submitted` task, in order: `gishra check tests ID --cmd "<scoped test command>"`, `gishra check clean ID`. A failing gate is a `gishra rework ID --reason ...` with the gate summary.
- **Review.** When the software gates pass, start a reviewer with the `gishra-review` skill in a clean context: a new subagent that has seen none of the work, or `gishra spawn --role reviewer --task ID`. Never the worker's own session. The reviewer records `review` evidence.
- **Merge.** With review ok: `gishra check ci ID`, then `gishra accept ID`, then `gishra merge ID`. Any refusal names what is missing; fix that, do not work around it.
- **Rework.** Review or CI findings go back with `gishra rework ID --reason "<findings>"` and the brief updated with what the next attempt must change.
- **Carry results forward.** After an accept, update the briefs of tasks that depend on it with what they now need to know (an interface, a decision, a path). Keep them short.
- **Decisions.** When something needs the owner, `gishra ask --question ... --option ... --recommend ... --why ... --blocks ID` and keep the rest moving. Check `gishra decisions --open` every loop; record an answer the owner gives in chat with `gishra answer`.
- **Watch spend.** `gishra status` every loop. A task that runs past twice its size gets split or re-planned, not more time. Record spend the harness reports with `gishra spend`.
- **Waits.** Never poll in a tight loop. Wait for subagent completion notifications or for a spawned process with a deadline.

## 4. Report

When the loop stops: what was merged (PR links), what is waiting on the owner (decisions and `needs_owner` tasks), spend against budget, and the sketch path. Short.

## Rules that keep this cheap and honest

- Software first: a gate or a CLI query answers before any model reads anything.
- You do not write the change yourself, apart from fixing the plan. If you are tempted to, make it a task.
- Evidence is recorded at the submitted commit; a new commit needs new evidence.
- A refused accept or merge is information. Read why.
