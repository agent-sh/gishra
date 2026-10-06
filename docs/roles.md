# Roles and harnesses

Four roles do the work. Each names a harness and a model or harness profile in `project.json`; set them with `gishra role set`.

| Role | Does | Good fit |
|---|---|---|
| `orchestrator` | plans, writes briefs, dispatches, runs gates, merges | the strongest model you have, in the harness you talk to |
| `worker` | builds one task | a strong coding model; can be a different harness than the orchestrator |
| `reviewer` | reviews one task with a clean context | a different model from the worker, so the review is not the author's blind spot |
| `small` | confirms flagged lines for the cleanup tool and other mechanical checks | a small fast model |

```bash
gishra role set orchestrator --harness claude --model claude-opus-5-5
gishra role set worker       --harness codex  --profile sol
gishra role set reviewer     --harness claude --model claude-opus-5-5
gishra role set small        --harness codex  --profile luna
```

A role is `{ "harness", "model" | "profile", "provider", "effort", "args" }`. `harness` is `claude`, `codex`, `opencode`, `agy`, `pi` or `command`. `args` are extra CLI arguments appended as given. [CLI: agents and worktrees](cli.md#agents-and-worktrees) lists the commands and reasoning settings for each harness.

## How each harness dispatches

When a role's harness matches the orchestrator's and supports subagents, dispatch natively with that role's model or profile. Otherwise use `gishra spawn`. Never launch a nested CLI of the orchestrator's own harness; if it lacks native dispatch, queue a different-harness choice.

- **Native.** Choose a unique name per attempt, claim workers with that name and a lease sized to the task, and pass the name, task, absolute worktree and state paths, skill path and brief. Every gishra call passes `--agent <name>` and, without `GISHRA_STATE`, `--state <dir>`. Workers use absolute paths under their worktree. Claude Code uses `gishra:gishra-worker` and `gishra:gishra-reviewer`; its Agent tool takes model aliases such as `opus`, `sonnet`, `fable`. Pass the reviewer role's model or profile, selecting a different model from the submitter when available.
- **Spawned.** Run `gishra spawn --role <role> --task <id>` without pre-claiming. It starts the configured CLI in the task's worktree with the brief as its prompt and `GISHRA_STATE`, `GISHRA_TASK` and `GISHRA_AGENT` set; workers claim with that generated identity (`worker-T1-1`, then `worker-T1-2`, for example). Only pi additionally loads the matching skill (`--skill`). The brief carries one line with absolute plugin paths: `worker: read and follow <abs>/skills/gishra-work/SKILL.md; reviewer: read and follow <abs>/skills/gishra-review/SKILL.md`. Spawn's prompt names the role, so both use the same brief.
- **Custom command.** A role with `"harness": "command"` and a `command` array runs any CLI; `{prompt}`, `{brief}`, `{task}` and `{cwd}` are substituted.

`gishra spawn --dry-run` prints the command without running it.

## Independence

`gishra accept` refuses review evidence recorded by the agent that submitted the task. A reviewer on another model or harness is better still: the same model tends to miss the same things it wrote.
