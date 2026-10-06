---
name: gishra
description: "Use when the owner asks for gishra status or decisions, or hands over an issue, goal or project to run end to end. Plans tasks, dispatches workers, gets clean-context reviews, runs software gates and merges, and queues owner decisions."
argument-hint: "<issue URL | #N | goal text | plan.json> | status | decisions"
---

# gishra: orchestrate

Arguments: `$ARGUMENTS`. If `gishra` is not on PATH, say how to install it (`npm i -g @agentsys/gishra`) and stop.

Use `GISHRA_AGENT` or `orchestrator` as your identity; pass `--agent <name>` on every gishra call unless a step names another actor.

- `status`: run `gishra status` and `gishra decisions --open`, show them and name `sketch.html` in the state directory, then stop.
- `decisions`: run `gishra decisions --open`, show options and recommendations, record any owner answer with `gishra answer <id> --choice "<option>"`, then stop.
- Otherwise, follow the orchestrator procedure below.

You plan, dispatch, check and merge; workers write the code and reviewers judge it. Keep your context to the plan and briefs.

All state goes through the `gishra` CLI (`gishra --help`). Never edit `.gishra/` files by hand. The standards to follow are in `standards/default.md` of this plugin unless `project.json` names another profile; read it once at the start.

## 1. Intake

- Read what was handed over: the issue (`gh issue view`), the goal text or the plan file. Read the repository's `AGENTS.md` and README, then only the code you need to plan.
- If a question changes what gets built, ask it now. Anything narrower becomes a queued decision later.
- `gishra status`. If there is no state, `gishra init --name <short-name> --goal "<one sentence>" --repo <owner/name> --base <branch>`. If state exists, resume from it: re-read `gishra status` and `gishra decisions --open`, do not re-plan what is accepted.
- Check the ladder with `gishra ladder show` (`docs/ladder.md` of this plugin explains it). Use what the owner configured; the `orchestrator` rung is you.

## 2. Plan

- Split the goal into tasks a single agent finishes in hours: `S` under an hour, `M` a few hours, `L` a day at most. Split anything bigger.
- Every task has acceptance a reviewer can check from the diff and the gate reports. "Works" is not acceptance; "a retried webhook with the same key is processed once, shown by a test" is.
- Add a dependency only when the work really needs the other result. Fewer edges, more parallel work.
- Give each task a tier: `easy`, `medium`, `hard` or `research`. Kind and size pick a default (`research` kind is research, else `S` easy, `M` medium, `L` hard); pass `--tier` when the risk differs from the size, such as a small change to a security boundary (`hard`) or a large mechanical rename (`easy`).
- Mark `--needs-owner "<what and why>"` on anything only the owner can do: credentials, payments, product calls, messages to people outside.
- Write the plan with `gishra task add` or `gishra plan import`, then `gishra validate` until it is clean.
- Write a brief for every ready task (`gishra brief set ID -`). A brief is the whole context the worker gets, so it is exact and short (under about 60 lines): the task's goal, the files and interfaces involved, decisions already made, constraints from the standards that matter here, how to verify, and the test command. No repository tour, no history.
- Include one line with the plugin's absolute paths: `worker: read and follow <abs>/skills/gishra-work/SKILL.md; reviewer: read and follow <abs>/skills/gishra-review/SKILL.md`. Spawn names the job in its prompt and passes the brief; only pi additionally loads the matching skill. Keep one brief for worker and reviewer.
- `gishra render` and tell the owner where `sketch.html` is.

## 3. Run

Loop until every task is accepted or cancelled, or the only open work is waiting on the owner.

- **Dispatch rule.** A worker runs on the rung of its task's tier, a reviewer on the `review` rung. When that rung's harness is yours and it has subagents, dispatch natively with the rung's model. Map a Claude rung's model to the Agent-tool alias: `claude-opus-*` or `opus` to `opus`, `claude-sonnet-*` or `sonnet` to `sonnet`, `claude-fable-*` or `fable` to `fable`. Otherwise use `gishra spawn`. Never launch a nested CLI of your own harness; if it lacks native dispatch, queue a different-harness choice with `gishra ask`.
- **Workers.** `gishra ready`. Up to `limits.workers` in progress, run `gishra worktree ID`. For a native worker, choose a unique name, `gishra claim ID --agent <name> --lease MIN`, and pass that name, task id, absolute worktree and state paths, skill path and brief. For another harness, `gishra spawn --task ID` without pre-claiming; it runs the tier's rung and the worker claims as the generated `GISHRA_AGENT`. A worker that reports its task is harder than its tier gets re-tiered (`gishra task update ID --tier T`) before the next dispatch.
- **Leases.** Read `limits.lease_minutes` with `gishra project show`; size `MIN` to cover expected work and waits. If a spawned worker you are waiting on needs longer, renew before its claim expires: `gishra renew ID --agent <claimant> --lease MIN`, then at least every `MIN/2` while it continues. Never re-dispatch a task while its worker is alive.
- **Gate submitted work.** Read the task's kind with `gishra task show ID`. For `code`, run `gishra check tests ID --cmd "<scoped test command>"`, then `gishra check clean ID`. Other kinds need independent review only, per `docs/state.md`; verify what their briefs require without forcing code gates. A failing gate is a `gishra rework ID --reason "<gate summary>"`.
- **Review.** Apply the dispatch rule to a clean-context reviewer following `gishra-review`. Use the `review` rung's model; when it is the same model as the task's tier (`gishra validate` warns), pick another one. For a native reviewer, pass a unique name different from the submitter, task id, absolute worktree and state paths, skill path, submitted sha, PR and acceptance. A spawned reviewer runs `gishra spawn --role review --task ID` with the same brief; to change its model, `gishra ladder set review --model M` (or `--profile P`) first, which keeps its other fields. Native agents pass `--agent <name>` on every gishra call and `--state <dir>` when the state environment is absent.
- **Merge.** With review ok, `gishra check ci ID` must pass for every task with a PR, regardless of kind. Still running means a capped wait and re-check; failed means rework. Then `gishra accept ID` and, with a PR, `gishra merge ID`. Fix any refusal's cause.
- **Rework.** Review or CI findings go back with `gishra rework ID --reason "<findings>"` and the brief updated with what the next attempt must change. When the same area fails review twice, stop patching it: send it back with a simpler design, removing the mechanism if the task can live without it. Each patch on a fragile design opens the next finding.
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
