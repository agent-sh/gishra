# Changelog

- Worker spawns reserve a worker slot until the worker claims, its attempt ends or one lease passes; dispatch, claim and expired-lease renewal count leases and reservations from the event log alike, so a full limit refuses dispatch before launch.
- Merge accepts commit subject and body overrides with task defaults, plus project options to retain task branches and use admin merging in solely owned repositories.
- Isolated agents reach gh through a token handed to the agent process at start, write a state directory reached through a symlink, and run test fixtures that use git init, config, commit and local pushes.
- Renamed gishra to Tower Crane.
