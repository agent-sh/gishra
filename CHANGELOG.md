# Changelog

- Merge accepts commit subject and body overrides with task defaults, plus project options to retain task branches and use admin merging in solely owned repositories.
- Sandboxed agents read the state directory but cannot write it. Their tower-crane commands that change state go to a per-spawn broker in the spawn monitor (a Unix socket for claude, token-authenticated TCP on 127.0.0.1 for codex, whose sandbox refuses Unix sockets), which checks the token in the agent's private `brokers/<agent>/` directory (hidden from every other agent) and runs only the role's commands on the agent's own task, as the spawned agent; records it writes carry `via: broker`. `writeOutside: state` now needs `sandbox: false`.
- Isolated agents reach gh through a token handed to the agent process at start, write a state directory reached through a symlink, and run test fixtures that use git init, config, commit and local pushes.
- Renamed gishra to Tower Crane.
