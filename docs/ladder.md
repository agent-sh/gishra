# The model ladder

Every task has a tier, and the ladder in `project.json` says which harness, model and effort runs each tier and each other job. `tower-crane ladder show` prints it and where each rung comes from; `docs/state.md` has the full shape and the precedence (project, then the user file `~/.config/tower-crane/config.json`, then built-in).

| Rung | Does | Good fit |
|---|---|---|
| `orchestrator` | plans, writes briefs, dispatches, runs gates, merges | the strongest model you have, in the harness you talk to |
| `easy` | `S` tasks by default: mechanical, local changes | a fast, cheap coding model |
| `medium` | `M` tasks by default | a strong coding model |
| `hard` | `L` tasks by default: cross-cutting or risky changes | the strongest coding model |
| `research` | tasks of kind `research` by default: open questions, measurements | the strongest model at high effort |
| `review` | fallback for clean-context review | used when no tier rung at the needed level can run |
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

A rung is `{ "harness", "model", "profile", "provider", "effort", "args", "command", "supervision" }`, every field optional; a rung without `harness` runs on the default harness. `ladder set` changes only the fields it names and `--clear FIELD` removes one. A write that would leave a rung unable to run (a codex profile on pi, a missing model) is refused. The Settings view of `tower-crane serve` edits the same ladder and each task's tier. [CLI: agents and worktrees](cli.md#agents-and-worktrees) lists the command and effort values each harness takes.

`tower-crane ladder set hard --supervision '{"retries":5,"backoff_ms":30000,"max_backoff_ms":600000,"stall_ms":300000,"progress_paths":["lib","test"]}'` sets retry and progress checks for that rung. `--clear supervision` restores the defaults. Reruns keep the resolved route. Codex and command adapters resume their session; Claude starts fresh with the brief and an interruption note. Provider fallback is a separate task. [State: supervision](state.md#projectjson) records the default values and their reasons.

## How each harness dispatches

A rung on claude or codex always runs through `tower-crane spawn`, including when the orchestrator runs on that harness: only a spawned agent gets its own environment ([Agent files and homes](#agent-files-and-homes)). A native subagent runs inside the orchestrator's session and shares its memory files, settings, hooks and MCP servers; no harness lets it have its own. A rung on opencode, agy or pi, which spawn does not isolate yet, may run as a native subagent when its harness is the orchestrator's.

- **Native** (opencode, agy and pi rungs only). Choose a unique name per attempt, claim workers with that name and a lease sized to the task, and pass the name, task, absolute worktree and state paths, skill path and brief. Every tower-crane call passes `--agent <name>` and, without `TOWER_CRANE_STATE`, `--state <dir>`. Workers use absolute paths under their worktree.
- **Spawned.** `tower-crane spawn --task <id>` runs the rung of the task's tier; `tower-crane spawn --role review --task <id>` selects a reviewer rung by task tier, diff risk and measured median review cost, with the review rung as fallback. Review dispatch requires passing software gates. Do not pre-claim. It starts the selected CLI in the task's worktree with `TOWER_CRANE_STATE`, `TOWER_CRANE_TASK` and `TOWER_CRANE_AGENT` set; a worker claims with that generated identity (`worker-T1-1`, `reviewer-T1-1`). pi loads the matching skill with `--skill`, codex finds it linked in its home, and claude gets its path in the home's instructions. Workers receive the brief. Reviewers receive the submitted diff, acceptance, gate results and only the brief's `## Reviewer` section, and use those results unless a focused probe is needed.
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
| `sandbox` | whether its commands run in the harness sandbox (claude's or codex's) |
| `writeOutside` | what its commands may write outside the worktree: `state` (the tower-crane state directory, through the CLI), `git` (the repository's git directory and the worktree's admin directory inside it, named on its own because codex keeps a workspace's git directory read-only unless a rule names it, so a worker can fetch, add, commit and push), `cache` (`~/.cache`, for scratch and test temp files), and for the orchestrator `homes` and `worktrees` |
| `codexDisable` | codex features it does not get |

| Role | Tools | Web | git push | gh writes | Worktree | Writes outside it |
|---|---|---|---|---|---|---|
| worker | Bash, Read, Edit, Write, Grep, Glob, Skill | no | its branch, no force | `pr create`, `pr edit` | write | state, git, cache |
| reviewer | Bash, Read, Grep, Glob, Skill | no | no | `pr comment` | read | state, cache |
| small | Bash, Read, Grep, Glob | no | no | none | read | state |
| orchestrator | all but NotebookEdit | yes | branches, no force | reads plus `pr`, `issue`, `release`, `repo` (not `repo delete`), `api`, `workflow`, `label`, `gist` | write | unsandboxed: it starts the other agents, whose sandboxes do not nest in its own |

**Native agents cannot have an environment of their own.** A native subagent runs inside the session that starts it, so that session's memory files, settings, hooks and MCP servers reach it, whatever its agent file says. Claude Code still reads these files as plugin agent frontmatter (`tools` is the allowlist, `disallowedTools` the denials, `skills` is preloaded), but tower-crane never dispatches a claude or codex rung natively: those rungs always go through `tower-crane spawn` ([How each harness dispatches](#how-each-harness-dispatches)).

**Spawned claude and codex agents** get the file rendered to flags and a home of their own at `homes/<agent>/` in the state directory, built fresh, private (mode 700, files 600) and under the lock for every spawn: the harness config directory (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`) and, inside it, `home/`, the agent's `HOME`. Nothing one agent writes there reaches the next, and a spawn removes the homes of agents whose process has exited. The user's memories, instructions, skills, plugins, hooks, MCP servers and approved-command rules never load, including what a harness finds under `HOME` (codex reads skills from `~/.agents/skills`). The agent's `HOME` links only `.gitconfig`, `.config/git`, `.config/gh`, `.aws` and `.ssh` from the user's.

- **claude**: the config directory holds `CLAUDE.md` (the agent file's body and its skill's path), `settings.json` and `mcp.json`. `settings.json` carries only the provider settings from the user's `settings.json` (`CLAUDE_CODE_USE_*`, `AWS_REGION`, `AWS_PROFILE`, model and base URL names) the sandbox and Tower Crane message hooks. A credential helper the user sets (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`) is not copied, since the command may hold the credential: the home names `lib/auth-helper.js`, which reads and runs the user's command each time claude asks. `.credentials.json` is a link to the user's. Flags: `--setting-sources user` (so a repository's `.claude/settings.json` and `settings.local.json`, with their hooks and plugins, do not load), `--permission-mode acceptEdits`, `--tools` and `--allowedTools` from `tools`, `--disallowedTools`, `--strict-mcp-config --mcp-config <home>/mcp.json` and `--disable-slash-commands`. A credential kept only in the user's settings env reaches the agent only when spawn runs with it in its environment, as it does from a Claude Code session.
- **claude's sandbox**: every sandboxed role runs Bash in claude's own sandbox with `failIfUnavailable`, so a sandbox that cannot start stops the agent instead of running it unconfined, and `allowUnsandboxedCommands: false`. Writes: the worktree for a worker (and the repository's git directory, as claude allows for a linked worktree), never for reviewer and small, whose worktree is in `denyWrite`; plus the `writeOutside` directories: the state directory for every role, because the tower-crane CLI runs inside Bash and writes it, and `~/.cache` for worker and reviewer test runs. The agent homes are in `denyWrite` and `denyRead`; `allowRead` reopens only the dispatch's own home. `network.allowAllUnixSockets` is on, because the socket filter's seccomp helper needs a nested user namespace that hosts like this one refuse ("nested userns is capability-restricted"); in its place `denyRead` hides `/var/run/docker.sock`, `/run/docker.sock`, `/run/user/<uid>` (SSH agent, D-Bus, GPG) and the user's `~/.ssh` and `~/.aws`. Hiding a directory hides the sockets in it, so a sandboxed `connect()` there fails with `ENOENT` (`test/live-sandbox.test.js`, run with `TOWER_CRANE_LIVE_CLAUDE=1`); a socket in a directory not on that list stays reachable. The sandbox keeps a `.claude/.cc-writes/` directory in the worktree, which spawn adds to the repository's `info/exclude`. Network: all domains.
- **codex**: `config.toml`, and each `<profile>.config.toml`, are parsed and rebuilt from the user's files with only the model, provider and auth-store keys by name (never `model_instructions_file` or other instruction sources), providers in any TOML layout without any token, key, header, auth or env value, and the MCP servers the rung opted in to. It installs Tower Crane native message hooks and notify, grants trust to the generated hook commands with `-c bypass_hook_trust=true`, and adds the permission profile `tower-crane`: read anywhere, write the worktree only when `worktree` is `write`, write the `writeOutside` directories, temp and the agent's own `HOME`, no access to other agent homes, network on. `AGENTS.md` holds the agent file's body; `rules/tower-crane.rules` forbids the denied command prefixes; `auth.json` and `.env` (where codex reads an AWS profile or Bedrock token) are links; the job's skill is linked under `skills/`; `sessions` links to `homes/.codex/<agent>/sessions`, which outlives the home so usage can be read after the agent exits. Flags: `-c default_permissions="tower-crane"` (`":danger-full-access"` for the orchestrator), `-c approval_policy="never"`, `-c web_search="disabled"` unless `web`, and `--disable` for each of `codexDisable`.
- **git and gh**: all spawned harnesses get `bin/` in the home first on `PATH`, holding `git` and `gh` shims (`lib/shim.js`) that allow a list and refuse the rest, aliases included, whatever the option order. git: git's own commands, wherever the sandbox lets them write (a reviewer's worktree is read-only, while the temp and cache dirs where test fixtures run `git init`, `git config` and `git commit` are not); a push to a repository on this machine, as test fixtures do, only in the plainest form `git push <dest> [refspec...]` with no option anywhere after `push` (git accepts abbreviated options, so any option voids the exception and the role and force rules apply), and only when every URL git would push to is a path or `file://` after git's own URL rewriting (`remote get-url --push --all` for a named remote, `ls-remote --get-url` for a URL or path) and no `pushInsteadOf` rule is set; and a push to another machine only on `gitPush: branch`, with no option but `-u`, `--set-upstream`, `-q`, `--quiet`, `-v`, `--verbose` and `--porcelain` spelled exactly (git accepts abbreviations, so any other could force, delete or mirror), no refspec that starts with `+` or `:`, and no `remote.*.mirror` key (whatever its value) or forcing `remote.*.push` in the configuration; a plain local push may force or delete, as fixtures do. Before the subcommand: `-C`, `-c` (only `user.name`, `user.email`, `init.defaultBranch`, `commit.gpgsign`, `tag.gpgsign`, `core.autocrlf`, `core.quotepath`, `advice.*` and `color.*`, since any other setting could rewrite a URL, add a push URL or define an alias), `--git-dir`, `--work-tree`, `--namespace`, `--no-pager`, `-P`, `--literal-pathspecs`, `--no-optional-locks`, `--bare`, `--no-replace-objects`. gh: read commands (`pr view`, `pr diff`, `pr checks`, `pr list`, `issue view` and the like) plus the role's `ghWrite`.
- opencode, agy, pi and `command` rungs get a private hook home, `TOWER_CRANE_HOOK` and the command shims while retaining their existing HOME and authentication setup. pi loads its generated extension through `--extension`; OpenCode loads its generated plugin through `OPENCODE_CONFIG_CONTENT`. These rungs do not yet have permission renderers. Native dispatch does not install these adapters; automatic message delivery requires `spawn`. [CLI: event wakeups](cli.md#event-wakeups) lists live injection, stop handling and resume gaps.

**gh auth**: a gh login kept in the system keyring is out of a sandboxed agent's reach, since the sandbox hides the user's D-Bus socket. When the spawning environment has no `GH_TOKEN` or `GITHUB_TOKEN`, spawn asks `gh auth token` as the agent starts and hands the token to the agent process as `GH_TOKEN`. It is not written to files, argv, dry-run output or events. Agent commands can read `GH_TOKEN`, so a command that talks to GitHub without gh is not held to the gh allowlist. Harness output is persisted unredacted (the spawn log, and transcripts in the agent's home), so a token an agent prints is kept there.

Codex roles with `gitPush: branch` also get an explicit `git push` allow rule. This authorizes publishing without asking the orchestrator; the forbidden force prefixes and git shim still guard the push. Reviewer and small roles receive no push allow rule.

**Sandbox paths** are real paths: a state directory, git directory or cache reached through a symlink is named by its target in `allowWrite` and the codex permission profile, since that is what the sandbox mounts.

The owner can extend those paths with project or rung `sandbox.write`, set literal variables with `env`, and load secrets at spawn through `env_file`. Project or rung `scope` properties launch the agent itself under a host systemd user scope; commands inherit its CPU and memory limits and receive `TOWER_CRANE_SCOPED=1`. Configured scopes require Linux, `systemd-run` and a working user manager. The command sandbox keeps the session bus inaccessible. Both harnesses enable TCP loopback sockets. See [state.md](state.md#ladder) for precedence, file quoting and the security limits, and [cli.md](cli.md#run) for commands.

Credentials are never copied: the home links to the user's file itself, resolved past any link, so a refreshed token is seen at once, nothing tower-crane writes holds one, and a spawn started inside another agent (with that agent's home as its `HOME` and config directory) links to the user's original files, never into the parent's home, so removing the parent breaks nothing. Each home records where the user's files are in `.tower-crane-origin.json` for that case. On Windows a file link falls back to a hard link when symlinks need developer mode.

A rung opts back in with `tools` and `mcp`: `tower-crane ladder set review --tools '["WebFetch"]' --mcp '["docs"]' --agent owner`. Only the owner changes a rung's harness, `args`, `command`, `tools` or `mcp`; an agent asks with `tower-crane ask`. An opted-in claude tool joins `--tools` and leaves `--disallowedTools`; an opted-in codex feature is enabled, and `web_search` turns search back on. An opted-in MCP server is taken by name from the user's harness config with its command, args and URL but without its `env` or headers, so a secret it needs comes from the environment; claude pre-approves its tools (`mcp__<name>`). `spawn --dry-run` names both. A claude or codex rung's `args` may hold only these flags, each as its own argument: claude `--verbose`, `--max-turns N`, `--fallback-model M`, `--append-system-prompt TEXT`; codex `--skip-git-repo-check`, `--ephemeral`, `--color WHEN`, `--disable FEATURE`, and `-c KEY=VALUE` for the model, provider and auth-store keys. Anything else is refused.

Limits. The orchestrator runs unsandboxed on both harnesses: it starts the other agents, which build sandboxes of their own that do not nest inside one. The shims see `git` and `gh` as found on `PATH`: a program called by its absolute path, or run from a script, is not checked. On macOS, claude keeps an OAuth login in the keychain under a name tied to the config directory, so a subscription login does not carry over to a home; API key, Bedrock and Vertex setups do.

### Startup context

First-turn input tokens (input plus cache read and write) for a one-line prompt, opus for claude and the `luna` profile for codex, measured 2026-10-06 and 2026-10-07. Before is the command line spawn ran before agent files; after is the spawned agent of that role. Median of three for claude before, two agreeing runs for the rest.

| Harness | Before | After | Change |
|---|---|---|---|
| `claude -p`, worker | 42.4k | 11.9k | -72% |
| `claude -p`, small | 42.4k | 11.0k | -74% |
| `codex exec`, worker | 24.1k (12.8k with `--disable memories,plugins,apps`) | 7.3k | -70% (-43%) |
| `codex exec`, small | 24.1k (12.8k) | 6.9k | -71% (-46%) |
| native Claude subagent, from a `claude -p` session | general-purpose 28.6k, `tower-crane-worker` 17.2k | not used for claude or codex rungs | |

About 3.5k of claude's after is the sandbox's own instructions (8.3k for the worker without it). The prompt after includes tower-crane's task block, about 250 tokens the before prompt did not have.

## Review selection

`tower-crane accept` refuses review evidence recorded by the agent that submitted the task. Review dispatch gives the reviewer a clean context, so its model may match the builder. Selection starts at the task tier, raises for a broad or risky diff, and promotes to a stronger tier when T31 review spend shows its median cost is no higher. Unknown usage leaves the complexity choice intact. The `review` rung is used when no tier rung at the needed level can run. `tower-crane validate` warns only when no reviewer rung can run.

Only an explicitly identified owner can set `project set --review-policy JSON`. Its prices use canonical model identities shared by rungs and spend entries: `sol` resolves to `openai.gpt-6.1-sol`, `luna` to `openai.gpt-6-luna`, and `opus` to `claude-opus-5-5`.
