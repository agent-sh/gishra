# Changelog

- Dependent tasks can dispatch on submitted dependency heads, link GitHub PR stacks, merge accepted lower tasks atomically, and refresh worktrees through gh-stack. Trusted pull_request stack metadata appears in task show and the board.

- Isolated agents reach gh through a token handed to the agent process at start, write a state directory reached through a symlink, and run test fixtures that use git init, config, commit and local pushes.
- Renamed gishra to Tower Crane.
