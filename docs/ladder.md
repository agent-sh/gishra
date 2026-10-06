# The model ladder

Every task has a tier, and the ladder in `project.json` says which harness, model and effort runs each tier and each other job. `tower-crane ladder show` prints it and where each rung comes from; `docs/state.md` has the full shape and the precedence (project, then the user file `~/.config/tower-crane/config.json`, then built-in).

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
tower-crane ladder harness codex                                  # every rung without its own harness
tower-crane ladder set easy     --profile luna --effort medium
tower-crane ladder set hard     --harness claude --model opus --effort high
tower-crane ladder set review   --profile sol --effort high
tower-crane ladder save-user                                      # make this ladder the default for new projects
tower-crane task update T3 --tier hard
```

A rung is `{ "harness", "model", "profile", "provider", "effort", "args", "command" }`, every field optional; a rung without `harness` runs on the default harness. `ladder set` changes only the fields it names and `--clear FIELD` removes one. A write that would leave a rung unable to run (a codex profile on pi, a missing model) is refused. The Settings view of `tower-crane serve` edits the same ladder and each task's tier. [CLI: agents and worktrees](cli.md#agents-and-worktrees) lists the command and effort values each harness takes.

## How each harness dispatches

A rung on claude or codex always runs through `tower-crane spawn`, including when the orchestrator runs on that harness: only a spawned agent gets its own environment ([Agent files and homes](#agent-files-and-homes)). A native subagent runs inside the orchestrator's session and shares its memory files, settings, hooks and MCP servers; no harness lets it have its own. A rung on opencode, agy or pi, which spawn does not isolate yet, may run as a native subagent when its harness is the orchestrator's.

- **Native** (opencode, agy and pi rungs only). Choose a unique name per attempt, claim workers with that name and a lease sized to the task, and pass the name, task, absolute worktree and state paths, skill path and brief. Every tower-crane call passes `--agent <name>` and, without `TOWER_CRANE_STATE`, `--state <dir>`. Workers use absolute paths under their worktree.
- **Spawned.** `tower-crane spawn --task <id>` runs the rung of the task's tier; `tower-crane spawn --role review --task <id>` runs the review rung (any rung name works with `--role`). Do not pre-claim. It starts the rung's CLI in the task's worktree with the brief as its prompt and `TOWER_CRANE_STATE`, `TOWER_CRANE_TASK` and `TOWER_CRANE_AGENT` set; the agent claims with that generated identity (`worker-T1-1`, `reviewer-T1-1`). pi loads the matching skill with `--skill`, codex finds it linked in its home, and claude gets its path in the home's instructions. The brief carries one line with absolute plugin paths: `worker: read and follow <abs>/skills/tower-crane-work/SKILL.md; reviewer: read and follow <abs>/skills/tower-crane-review/SKILL.md`. Spawn's prompt names the job, so both use the same brief.
- **Custom command.** A rung with `"harness": "command"` and a `command` array runs any CLI; `{prompt}`, `{brief}`, `{task}` and `{cwd}` are substituted.

`tower-crane spawn --dry-run` prints the command without running it.

## Agent files and homes

Every agent runs under the agent file of its job in `agents/`: `tower-crane-worker.md` (the four tiers), `tower-crane-reviewer.md` (`review`), `tower-crane-small.md` (`small`) and `tower-crane-orchestrator.md` (`orchestrator`). Each one lists, in its frontmatter:

| Key | Says |
|---|---|
| `tools`, `disallowedTools` | claude tools allowed and denied; denied commands as `Bash(<prefix>:*)` |
| `mcpServers` | always empty: no MCP server unless a rung opts in |
| `skills` | the tower-crane skill the job follows |
| `web` | whether it may browse or search |
| `gitPush` | `branch` (no force push) or `none` |
| `ghWrite` | the `gh` writes it may run; every other `gh` write is denied |
| `worktree` | `write` or `read`: whether its commands may change the worktree |
| `sandbox` | whether its commands run in the harness sandbox |
| `writeOutside` | what its commands may write outside the worktree: `state` (the tower-crane state directory, through the CLI), `git` (the repository's git directory), `cache` (`~/.cache`, for scratch and test temp files), and for the orchestrator `homes` and `worktrees` |
| `codexDisable` | codex features it does not get |

| Role | Tools | Web | git push | gh writes | Worktree | Writes outside it |
|---|---|---|---|---|---|---|
| worker | Bash, Read, Edit, Write, Grep, Glob, Skill | no | its branch, no force | `pr create`, `pr edit` | write | state, git, cache |
| reviewer | Bash, Read, Grep, Glob, Skill | no | no | `pr comment` | read | state, cache |
| small | Bash, Read, Grep, Glob | no | no | none | read | state |
| orchestrator | all but NotebookEdit | yes | branches, no force | all but `secret`, `variable`, `alias`, `repo delete` | write | unsandboxed: it starts the other agents, whose sandboxes do not nest in its own |

**Native agents cannot have an environment of their own.** A native subagent runs inside the session that starts it, so that session's memory files, settings, hooks and MCP servers reach it, whatever its agent file says. Claude Code still reads these files as plugin agent frontmatter (`tools` is the allowlist, `disallowedTools` the denials, `skills` is preloaded), but tower-crane never dispatches a claude or codex rung natively: those rungs always go through `tower-crane spawn` ([How each harness dispatches](#how-each-harness-dispatches)).

**Spawned agents** get the file rendered to flags and a config home of their own at `homes/<agent>/` in the state directory, built fresh, private (mode 700, files 600) and under the lock for every spawn. Nothing one agent writes there reaches the next, and a spawn removes the homes of agents whose process has exited. The user's memories, instructions, plugins, hooks, MCP servers and approved-command rules never load.

- **claude**: `CLAUDE_CONFIG_DIR` is the home. It holds `CLAUDE.md` (the agent file's body and its skill's path), `settings.json` and `mcp.json`. `settings.json` carries only the provider settings from the user's `settings.json` (`CLAUDE_CODE_USE_*`, `AWS_REGION`, `AWS_PROFILE`, model and base URL names). A credential helper the user sets (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`) is not copied, since the command may hold the credential: the home names `lib/auth-helper.js`, which reads and runs the user's command each time claude asks. `.credentials.json` is a link to the user's. Flags: `--setting-sources user` (so a repository's `.claude/settings.json` and `settings.local.json`, with their hooks and plugins, do not load), `--permission-mode acceptEdits` (file edits only inside the worktree), `--tools` and `--allowedTools` from `tools`, `--disallowedTools`, `--strict-mcp-config --mcp-config <home>/mcp.json` and `--disable-slash-commands`. A credential kept only in the user's settings env reaches the agent only when spawn runs with it in its environment, as it does from a Claude Code session.
- **codex**: `CODEX_HOME` is the home. Its `config.toml`, and each `<profile>.config.toml`, are parsed and rebuilt from the user's files with only the model, provider and auth-store keys by name (never `model_instructions_file` or other instruction sources), providers in any TOML layout without any token, key, header, auth or env value, and the MCP servers the rung opted in to. It adds the permission profile `tower-crane`: read anywhere, write the worktree only when `worktree` is `write`, write the `writeOutside` directories and temp, read-only on the agent homes, network on. `AGENTS.md` holds the agent file's body; `rules/tower-crane.rules` forbids the denied command prefixes; `auth.json` and `.env` (where codex reads an AWS profile or Bedrock token) are links; the job's skill is linked under `skills/`. Flags: `-c default_permissions="tower-crane"` (`":danger-full-access"` for the orchestrator), `-c approval_policy="never"`, `-c web_search="disabled"` unless `web`, and `--disable` for each of `codexDisable`.
- **git and gh**: both harnesses get `bin/` in the home first on `PATH`, holding `git` and `gh` shims (`lib/shim.js`). Each call is checked against `gitPush` and `ghWrite` whatever the option order (`git push origin HEAD --force`, `git -C dir push --force-with-lease`, `+refspec`, a `-c alias.p=push` alias, `gh --repo o/r pr merge 1`) and then handed to the real program.
- opencode, agy, pi and `command` rungs run as before; their homes follow.

Credentials are never copied: the home links to the user's file, so a refreshed token is seen at once, and nothing tower-crane writes holds one. On Windows a file link falls back to a hard link when symlinks need developer mode.

A rung opts back in with `tools` and `mcp`: `tower-crane ladder set review --tools '["WebFetch"]' --mcp '["docs"]' --agent owner`. Only the owner changes a rung's harness, `args`, `command`, `tools` or `mcp`; an agent asks with `tower-crane ask`. An opted-in claude tool joins `--tools` and leaves `--disallowedTools`; an opted-in codex feature is enabled, and `web_search` turns search back on. An opted-in MCP server is taken by name from the user's harness config with its command, args and URL but without its `env` or headers, so a secret it needs comes from the environment; claude pre-approves its tools (`mcp__<name>`). `spawn --dry-run` names both. A rung's `args` cannot set a flag the agent file decides (claude `--settings`, `--setting-sources`, `--tools`, `--dangerously-skip-permissions` and the like; codex `--sandbox`, `--add-dir`, `--enable`, `--ignore-rules`, `--ignore-user-config`, and `-c` for anything but the model, provider and auth-store keys).

Limits. claude does not get its Bash sandbox: on a host that restricts nested user namespaces, as the machine these were measured on does, it fails every command. Its file tools stay inside the worktree, the deny rules and shims hold, and the fresh home means a write to it reaches no later agent, but its Bash can write elsewhere; codex's sandbox confines both. The shims see `git` and `gh` as found on `PATH`: a program called by its absolute path, or run from a script, is not checked. On macOS, claude keeps an OAuth login in the keychain under a name tied to the config directory, so a subscription login does not carry over to a home; API key, Bedrock and Vertex setups do.

### Startup context

First-turn input tokens (input plus cache read and write) for a one-line prompt, opus for claude and the `luna` profile for codex, on 2026-10-06 and 2026-10-07. Before is the command line spawn ran before agent files; after is the spawned agent of that role. Median of three for claude before, two agreeing runs for the rest.

| Harness | Before | After | Change |
|---|---|---|---|
| `claude -p`, worker | 42.4k | 8.3k | -80% |
| `claude -p`, small | 42.4k | 7.5k | -82% |
| `codex exec`, worker | 24.1k (12.8k with `--disable memories,plugins,apps`) | 7.3k | -70% (-43%) |
| `codex exec`, small | 24.1k (12.8k) | 7.0k | -71% (-46%) |
| native Claude subagent, from a `claude -p` session | general-purpose 28.6k, `tower-crane-worker` 17.2k | not used for claude or codex rungs | |

The prompt after includes tower-crane's task block, about 250 tokens the before prompt did not have.

## Independence

`tower-crane accept` refuses review evidence recorded by the agent that submitted the task. A reviewer on another model is better still: the same model tends to miss the same things it wrote. `tower-crane validate` warns when the review rung runs the same harness and model as a tier that open tasks use.
