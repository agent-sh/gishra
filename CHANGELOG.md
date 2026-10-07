# Changelog

- Decision answers require an explicit owner identity or owner-set per-decision delegation; the orchestrator answers only owner-marked technical decisions under project policy, and answer events record their authorization rule.
- Worker spawns reserve a worker slot until the worker claims, its attempt ends or one lease passes; dispatch, claim and expired-lease renewal count leases and reservations from the event log alike, so a full limit refuses dispatch before launch.
- Rungs configure ordered provider fallback routes after bounded outage retries or a structured harness policy refusal. Route switches start fresh sessions, wake the orchestrator, and keep usage attributed to the route that ran.
- Rework waits for a live fallback worker to exit before another dispatch. Fresh same-route retries retain separate usage receipts so every invocation contributes to spend.
- Merge accepts commit subject and body overrides with task defaults, plus project options to retain task branches and use admin merging in solely owned repositories.
- Isolated agents reach gh through a token handed to the agent process at start, write a state directory reached through a symlink, and run test fixtures that use git init, config, commit and local pushes.
- Renamed gishra to Tower Crane.
