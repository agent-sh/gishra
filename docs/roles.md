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

## How each harness dispatches

The orchestrator uses what its harness has.

- **Claude Code.** Workers and reviewers run as subagents (`gishra:gishra-worker`, `gishra:gishra-reviewer`), each with a fresh context; pass the role's model when it is a Claude model. When the role names another harness, the orchestrator runs `gishra spawn`.
- **Codex, OpenCode, Gemini CLI.** The orchestrator runs `gishra spawn --role <role> --task <id>`, which starts the configured CLI in the task's worktree with the brief as its prompt and `GISHRA_STATE`, `GISHRA_TASK` and `GISHRA_AGENT` set.
- **Anything else.** A role with `"harness": "command"` and a `command` array runs any CLI; `{prompt}`, `{brief}`, `{task}` and `{cwd}` are substituted.

`gishra spawn --dry-run` prints the command without running it.

## Independence

`gishra accept` refuses review evidence recorded by the agent that submitted the task. A reviewer on another model or harness is better still: the same model tends to miss the same things it wrote.
