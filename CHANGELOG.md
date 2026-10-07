# Changelog

- Dependent tasks can dispatch on submitted dependency heads, link GitHub PR stacks, merge accepted lower tasks atomically, and refresh worktrees through gh-stack. Trusted pull_request stack metadata appears in task show and the board.
- Rungs configure ordered provider fallback routes after bounded outage retries or a structured harness policy refusal. Route switches start fresh sessions, wake the orchestrator, and keep usage attributed to the route that ran.
- Rework waits for a live fallback worker to exit before another dispatch. Fresh same-route retries retain separate usage receipts so every invocation contributes to spend.
- Merge accepts commit subject and body overrides with task defaults, plus project options to retain task branches and use admin merging in solely owned repositories.
- Isolated agents reach gh through a token handed to the agent process at start, write a state directory reached through a symlink, and run test fixtures that use git init, config, commit and local pushes.
- Renamed gishra to Tower Crane.
