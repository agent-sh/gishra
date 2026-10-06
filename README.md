# gishra

Hand an agent anything from one issue to a whole project. gishra keeps the plan, the standard, the review and the merge gates in software, so the agents spend tokens on the work and you watch instead of steering.

- **State in plain files.** Tasks, dependencies, owner decisions, evidence and spend live in JSON under `.gishra/`. Only the `gishra` CLI writes them. `gishra render` turns them into a Markdown and HTML sketch you can open anywhere.
- **Any harness.** The orchestrator runs in Claude Code, Codex, OpenCode, Antigravity (`agy`) or pi and dispatches with what that harness has: its own subagents, or `gishra spawn` starting another CLI. Each role (orchestrator, worker, reviewer, small checks) has its own harness and model.
- **Review is never self-review.** Acceptance needs review evidence from an agent other than the one that submitted.
- **Gates are software.** Tests must fail before the change and pass after it, the cleanup tool must report nothing HIGH, CI is read on the exact commit, and merges match the head.
- **Owner decisions do not block.** A question blocks only the tasks it names.

Status: under construction. See [docs/state.md](docs/state.md) and [docs/cli.md](docs/cli.md).
