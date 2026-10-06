# gishra

## Project

gishra is a CLI and an agent plugin. The CLI (`bin/`, `lib/`) keeps a project's plan and progress in plain files in the project's gishra state directory and runs the software gates; the plugin (`skills/`, `agents/`, `standards/`) is the methodology agents follow on top of it. Part of the [agentsys](https://github.com/agent-sh/agentsys) ecosystem.

## Rules

- Node 20 or newer, no npm dependencies, CommonJS.
- The CLI is the only writer of state. A feature that needs agents to change state adds a command, not an instruction to edit JSON.
- Software before models: if a check can be code, it is code.
- Tests are integration tests that run the real CLI on a temporary git repository; a feature or fix comes with one that fails without it. `npm test` runs them; set `GISHRA_TEST_TMP` to keep temp files off `/tmp`.
- Changes reach `main` through a PR with a clean-context review comment and green CI.
- No em dashes or assistant phrasing in code, comments, docs or commit messages. Comments say why, never record review history.
- `docs/state.md` and `docs/cli.md` are the contract. Change them in the same PR as the behavior.

## Layout

- `bin/gishra.js`: CLI entry.
- `lib/`: state, project, tasks, decisions, render, serve, worktree, spawn, check and util; `lib/gates/`: tests, clean, ci, merge and common.
- The three skills (`skills/gishra/`, `skills/gishra-work/`, `skills/gishra-review/`) and the two agents in `agents/`: the plugin.
- `standards/default.md`: the default standards profile.
- `docs/`: state, CLI and roles.
