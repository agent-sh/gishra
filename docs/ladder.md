# The model ladder

Every task has a tier, and the ladder in `project.json` says which harness, model and effort runs each tier and each other job. `gishra ladder show` prints it and where each rung comes from; `docs/state.md` has the full shape and the precedence (project, then the user file `~/.config/gishra/config.json`, then built-in).

| Rung | Does | Good fit |
|---|---|---|
| `orchestrator` | plans, writes briefs, dispatches, runs gates, merges | the strongest model you have, in the harness you talk to |
| `easy` | `S` tasks by default: mechanical, local changes | a fast, cheap coding model |
| `medium` | `M` tasks by default | a strong coding model |
| `hard` | `L` tasks by default: cross-cutting or risky changes | the strongest coding model |
| `research` | tasks of kind `research` by default: open questions, measurements | the strongest model at high effort |
| `review` | clean-context review of any task | a different model from the tiers it reviews, so the review is not the author's blind spot |
| `small` | mechanical checks, such as confirming lines the cleanup tool flagged | a small fast model |

`task add` and `plan import` pick a tier from kind and size (`research` for kind `research`, else `S` easy, `M` medium, `L` hard); `--tier` overrides it, and only `--tier` changes it later.

```bash
gishra ladder harness codex                                  # every rung without its own harness
gishra ladder set easy     --profile luna --effort medium
gishra ladder set hard     --harness claude --model opus --effort high
gishra ladder set review   --profile sol --effort high
gishra ladder save-user                                      # make this ladder the default for new projects
gishra task update T3 --tier hard
```

A rung is `{ "harness", "model", "profile", "provider", "effort", "args", "command" }`, every field optional; a rung without `harness` runs on the default harness. `ladder set` changes only the fields it names and `--clear FIELD` removes one. A write that would leave a rung unable to run (a codex profile on pi, a missing model) is refused. The Settings view of `gishra serve` edits the same ladder and each task's tier. [CLI: agents and worktrees](cli.md#agents-and-worktrees) lists the command and effort values each harness takes.

## How each harness dispatches

When a rung's harness is the orchestrator's and it has subagents, dispatch natively with that rung's model. Otherwise use `gishra spawn`. Never launch a nested CLI of the orchestrator's own harness; if it lacks native dispatch, queue a different-harness choice.

- **Native.** Choose a unique name per attempt, claim workers with that name and a lease sized to the task, and pass the name, task, absolute worktree and state paths, skill path and brief. Every gishra call passes `--agent <name>` and, without `GISHRA_STATE`, `--state <dir>`. Workers use absolute paths under their worktree. Claude Code uses `gishra:gishra-worker` and `gishra:gishra-reviewer`; its Agent tool takes aliases, so map the rung's model: `claude-opus-*` or `opus` to `opus`, `claude-sonnet-*` or `sonnet` to `sonnet`, `claude-fable-*` or `fable` to `fable`.
- **Spawned.** `gishra spawn --task <id>` runs the rung of the task's tier; `gishra spawn --role review --task <id>` runs the review rung (any rung name works with `--role`). Do not pre-claim. It starts the rung's CLI in the task's worktree with the brief as its prompt and `GISHRA_STATE`, `GISHRA_TASK` and `GISHRA_AGENT` set; the agent claims with that generated identity (`worker-T1-1`, `reviewer-T1-1`). Only pi additionally loads the matching skill (`--skill`). The brief carries one line with absolute plugin paths: `worker: read and follow <abs>/skills/gishra-work/SKILL.md; reviewer: read and follow <abs>/skills/gishra-review/SKILL.md`. Spawn's prompt names the job, so both use the same brief.
- **Custom command.** A rung with `"harness": "command"` and a `command` array runs any CLI; `{prompt}`, `{brief}`, `{task}` and `{cwd}` are substituted.

`gishra spawn --dry-run` prints the command without running it.

## Independence

`gishra accept` refuses review evidence recorded by the agent that submitted the task. A reviewer on another model is better still: the same model tends to miss the same things it wrote. `gishra validate` warns when the review rung runs the same harness and model as a tier that open tasks use.
