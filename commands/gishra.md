---
description: "Hand over an issue, a goal or a whole project: gishra plans it into tasks, runs workers and clean-context reviewers, gates and merges, and queues what needs you. Use for 'take this issue', 'build this project', 'run this plan', 'gishra status'."
codex-description: 'Use when user asks to "take this issue", "run this project end to end", "delegate this", "gishra status". Plans, dispatches, reviews, gates and merges agent work with state in plain files.'
argument-hint: "<issue URL | #N | goal text | plan.json> [--workers N] | status | decisions"
allowed-tools: Task, Skill, Read, Grep, Glob, Bash(gishra:*), Bash(git:*), Bash(gh:*), Bash(node:*)
---

# /gishra

From `$ARGUMENTS`:

- `status`: run `gishra status` and `gishra decisions --open`, show them, and give the sketch path. Stop.
- `decisions`: list open decisions with their options and recommendations, and record any answer the user gives with `gishra answer`. Stop.
- anything else is work to run: load the `gishra` skill with the same arguments and follow it.

If `gishra` is not on PATH, say how to install it (`npm i -g @agentsys/gishra`) and stop.
