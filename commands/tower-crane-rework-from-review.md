---
description: Send a Tower Crane task back with its current failed review.
argument-hint: "ID"
---

Run `tower-crane rework --from-review $ARGUMENTS --json --agent <name>`, using `TOWER_CRANE_AGENT` or `orchestrator`. Pass `--state <dir>` if `TOWER_CRANE_STATE` is absent. The command copies the current failed review's findings and comment link into the brief. Report the result.
