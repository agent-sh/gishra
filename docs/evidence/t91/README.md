# T91 board controls

The Playwright browser kit ran the live fixture UI at 1920x1080 in both color schemes. It opened Controls from the board navigation, saved the worker limit as 5, approved an orchestrator's admin-merge request and declined the opposite request. The JSON API then reported 48 authority rows, the saved limit, admin merging still enabled, D1 applied by the owner and D2 declined.

The screenshots show the pending approval before it was answered:

- [Light theme](controls-light.png)
- [Dark theme](controls-dark.png)

`test/board-controls.test.js` drives the real CLI and serve process. Its Chrome test also exercises personal fallbacks, pause, ordinary decision answers, unsaved edits during live updates, and a 390px viewport. API tests cover each control family, shared audit events, approval retry, stale-page refusal, viewer refusal, gate waivers, and a supervised fixture's interrupt, release and delegation. No model runs in the fixture.

Run the touched tests with:

```sh
node --test test/board-controls.test.js test/control-modes.test.js
```

`TOWER_CRANE_BOARD_ARTIFACTS` optionally saves the automated Chrome test's two 1920x1080 screenshots to a directory. The committed images above were captured with the Playwright MCP.
