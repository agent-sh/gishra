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

A role is `{ "harness", "model" | "profile", "provider", "effort", "args" }`. `harness` is `claude`, `codex`, `opencode`, `agy`, `pi` or `command`. `effort` maps to each CLI's reasoning setting (`--effort` for agy, `--thinking` for pi, `model_reasoning_effort` for Codex). `args` are extra CLI arguments appended as given.

| Harness | Command gishra runs |
|---|---|
| `claude` | `claude -p <prompt> --model <model>` |
| `codex` | `codex exec -p <profile> <prompt>` (or `-m <model>`) |
| `opencode` | `opencode run <prompt> -m <model>` |
| `agy` | `agy -p <prompt> --mode accept-edits --model <model> --effort <effort>` |
| `pi` | `pi -p <prompt> --model <provider/id> --thinking <effort> --skill <gishra skill>` |
| `command` | the `command` array, with `{prompt}`, `{brief}`, `{task}` and `{cwd}` substituted |

## How each harness dispatches

The orchestrator uses what its harness has.

- **Claude Code.** Workers and reviewers run as subagents (`gishra:gishra-worker`, `gishra:gishra-reviewer`), each with a fresh context; pass the role's model when it is a Claude model. Choose a unique name per attempt, claim native workers with that exact name, and pass each subagent its name, task, worktree and state directory. Every subagent gishra call passes `--agent <name>` and, without `GISHRA_STATE`, `--state <dir>`. When the role names another harness, the orchestrator runs `gishra spawn`.
- **Codex, OpenCode, Antigravity (`agy`), pi.** The orchestrator runs `gishra spawn --role <role> --task <id>` without pre-claiming. It starts the configured CLI in the task's worktree with the brief as its prompt and `GISHRA_STATE`, `GISHRA_TASK` and `GISHRA_AGENT` set; the worker claims with that generated identity (`worker-T1-1`, then `worker-T1-2`, for example). pi workers and reviewers also load the matching gishra skill (`--skill`).
- **Anything else.** A role with `"harness": "command"` and a `command` array runs any CLI; `{prompt}`, `{brief}`, `{task}` and `{cwd}` are substituted.

`gishra spawn --dry-run` prints the command without running it.

## Independence

`gishra accept` refuses review evidence recorded by the agent that submitted the task. A reviewer on another model or harness is better still: the same model tends to miss the same things it wrote.
