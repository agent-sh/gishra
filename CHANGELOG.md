# Changelog

- Merge accepts commit subject and body overrides with task defaults, plus project options to retain task branches and use admin merging in solely owned repositories.
- Sandboxed agents read the state directory but cannot write it, and cannot read another agent's home. Their tower-crane commands that change state go over a per-spawn socket to a broker in the spawn monitor, which checks the token in the agent's home and runs only the role's commands on the agent's own task, as the spawned agent; records it writes carry `via: broker`. `writeOutside: state` now needs `sandbox: false`.
- Isolated agents reach gh through a token handed to the agent process at start, write a state directory reached through a symlink, and run test fixtures that use git init, config, commit and local pushes.
- Renamed gishra to Tower Crane.
