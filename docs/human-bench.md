# The human bench

Tower Crane benches what agents do. This page benches what the owner does on the board: the jobs of [human-experience.md](human-experience.md) section 3, as the timed scenarios and checks of its section 6, run on the board before and after T79's redesign. The code is `test/bench/`; the results below are generated from its output by `test/bench/report.js`.

## Method

**Builds.** *Before* is the board T79 started from: `76d484d`, T93's live-spend head with main merged (T70's research included), extracted with `git archive`. *After* is this branch. Both serve the same fixtures; each build builds its own fixtures with its own CLI.

**Fixtures** (`test/bench/fixtures.js`). Scratch states built through the CLI only, never by writing JSON, so they stay valid as the state format changes. Commands run on a moved clock (`test/fixtures/hooks.js`), which gives events, leases and decisions the ages a real run has. No fixture touches a live state directory.

- *busy*: `webhooks v2`, 26 tasks. Twelve accepted tasks with recorded usage, shaped like T70's window W (the 90th percentile of tokens per task is about 5 times the median); two decisions, one blocking ready work; an owner-required `merge.admin` request the orchestrator made, which the engine turned into an approval; an owner task; five agents at work and one claim whose lease ran out; a submitted task whose review failed after one rework; an accepted task whose gates the owner waived; a message to the owner.
- *calm*: accepted history, two agents at work, nothing for the owner.
- *runaway*: the same history, then one easy task dispatched through `spawn` to T93's stub harness (`test/fixtures/live-usage-harness.js`), which writes 1M tokens a second to its own session file. Only the live collector puts spend into state. Variants: *stale* (the stub writes twice and the bench then stops the supervisor, so no new reading arrives while the agent runs) and *unavailable* (a command harness, which has no live usage).
- *budget*: the runaway history with a token budget sized so the project is at 92% once the stub has written its 2.4M tokens.

**Driver** (`test/bench/driver.js`). Headless Chrome from `test/browser.js`, with input through Chrome's own pipeline: `Input.dispatchMouseEvent` at the target's center and `Input.dispatchKeyEvent`, never page functions. A target outside the viewport is reached with the wheel over its scroll container, and the distance is recorded. Every input, the pointer travel, the target sizes and the wall time are recorded, and each scenario ends with a check of the state through the CLI files (`decisions.json`, `tasks.json`, `events.jsonl`). Screenshots are WebP. serve runs as the owner on the scratch states, with the same clean environment the board tests use.

**Timing.** Three numbers per scenario:

- the interaction count: clicks, keys and scrolls on the shortest path;
- the Keystroke-Level Model prediction, a floor for expert, error-free work, from Card, Moran and Newell's operators (s25 in [research/T70.json](../research/T70.json)): K 0.28 s ("average non-secretary typist"), P 1.1 s, B 0.1 s per press or release, H 0.4 s, M 1.35 s before each decision. A wheel notch counts as a K, with an M to find the place again after each scroll. Where a pass bar says "plus typing", it is held against the prediction without the typed characters;
- the owner's measured time, median of three cold runs. This bench is run by an agent, so that number is not in this report; it is the owner's run (see Limits).

**Checks** (`test/bench/checks.js`), from computed styles and Chrome's accessibility tree:

- *Contrast*: every visible text node against its effective background (ancestors' backgrounds blended), with the WCAG formula; 4.5:1, or 3:1 for 24 px or 18.66 px bold.
- *Color alone*: every status glyph has an accessible name or sits beside its status word.
- *Targets*: WCAG 2.5.8, 24 by 24 px or spaced so 24 px circles do not meet, inline links in a sentence exempt; buttons 32 px tall.
- *Names*: one `h1`, `main`, `nav` and a header, a polite live region, and no unnamed control in the accessibility tree.
- *Readability*: smallest text 12 px, at most six sizes, body text 15 px, a full line at most 80 characters (the text's own width against its line box), no clipped text, no sideways page scroll.
- *Motion*: running animations after load, with `prefers-reduced-motion: reduce`.
- *One room at a time*: for every room, by nav, direct link, a sheet opened inside it, a cleared fragment and a live update, exactly the routed room is displayed and its top is in the first viewport.
- *Density*: at 3840x1080, the share of a grid of points in the first viewport that lands on text, a control or a drawn item (not a band's own background).

## Results

<!-- results -->
<!-- /results -->

## What the numbers say

- **Find what needs me.** Before, the old board's needs column showed half of the six items in the first viewport at 1920 and 3840 and one at 1280x800, and its tab count left out the stuck claim. After, every item is in the first viewport at all three desktop sizes, the title carries the full count, and the prediction drops to one M. At mid widths a queue longer than three items takes the full width in two columns, ahead of the floor.
- **Decide.** The note field is beside the option buttons instead of behind a disclosure: two pointer actions instead of three, and focus lands on the next queue item. The prediction without typing is 6.1 s against the 6 s bar. That is the floor of the method itself (M P B B H, type, M H P B B): no layout makes it shorter, so the bar is out of reach for any mouse path with a note.
- **Judge a review.** The finding, the gate receipts and the send-back field are on one Review row: no scrolling, against 711 px and three scrolls before.
- **Stop a runaway.** Before, the live spend rose on the card but nothing flagged it and the board had no way to stop it. After, the spend rule (`lib/runaway.js`, the same flags `status` prints) puts it in the queue as a Now item a fraction of a second after the live total crosses the rule, and Stop on its row ends it in two clicks, through the task budget the supervisor already enforces. No retry runs, and after exit the recorded spend equals the stub's own count.
- **Lost telemetry and spend.** A stale reading and an unavailable one are drawn in words, never as zero, and the status sentence counts the agents it cannot count. Budget used, burn rate, projection and the top spender are on every page's spend line, with how fresh the live number is; before, only the used total was on the primary screen.
- **Steer.** The agent row's Message reaches the claimant through `msg`; before there was no board path to an agent.
- **Readability and calm.** Before, a third of the text was under 12 px, with eight sizes. After, the board uses five or six sizes from 12 px up, body text is 15 px, and the calm run shows no alarm or attention hue and no motion (the old breathing dot is gone).

## Limits

- **Approvals and pause need T89 and T91.** On this base an escalation is answered after the owner makes the change at the terminal; T89's approval that applies the recorded request, and T91's `project set --paused` and `interrupt`, are not merged here. H2a's apply path and H4p are recorded as no path on both builds. Stop uses the task budget the supervisor enforces (`task update --budget-tokens`, operational), which stops the agent at its next reading and opens the owner's `budget.raise` decision; it becomes T91's `interrupt` when that lands.
- **T93 is stacked, not merged.** H4, H4s and H5 run against T93's real live collector on this branch, with its stub harness as the agent.
- **No measured human time.** The owner runs each scenario on the after build, cold, three times; the bench does not stand in for that.
- **No large-plan fixture.** The 200-task, 20,000-event fixture of the plan was not run: every CLI write re-renders the board under the lock, so building it through the CLI takes most of an hour. Plan rendering at that size is not measured here.
- **Machine load.** Both runs shared the machine with other sessions (load around 30). Wall times are not compared between builds; counts and predictions are.
- **One fixture per scenario.** Each scenario ran once per build at the sizes shown. The deterministic bars are also assertions in `test/board.test.js` (contrast, targets, names and readability at the four sizes in both themes; one room at a time; the queue order; routing).

## Screenshots

The front room at every size and theme, each room at 1920x1080 in both themes and 390x844 light, a task sheet, Settings, and the end state of each scenario on the after build: [before/](human-bench/before/), [after/](human-bench/after/).

| Before, 1920x1080 light | After, 1920x1080 light |
|---|---|
| ![Before](human-bench/before/front-1920x1080-light.webp) | ![After](human-bench/after/front-1920x1080-light.webp) |

| Before, 390x844 dark | After, 390x844 dark |
|---|---|
| ![Before on a phone](human-bench/before/front-390x844-dark.webp) | ![After on a phone](human-bench/after/front-390x844-dark.webp) |

## Running it

```sh
git archive <before-commit> | tar -x -C ~/.cache/before
node test/bench/run.js --build before --tree ~/.cache/before --out ~/.cache/bench
node test/bench/run.js --build after --tree . --out ~/.cache/bench
node test/bench/report.js --results ~/.cache/bench --doc docs/human-bench.md --shots docs/human-bench
```

`--only H1,H4` reruns some steps and keeps the rest of an earlier results file. Run it outside an agent task process; it needs Chrome.
