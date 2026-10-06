# The board

The board is what `render` writes to `sketch.html` and what `serve` shows live. This document is its design: first the assessment of who uses it and for what, then the directions explored and the one chosen, then the design system built for that direction. Code follows this document; when they disagree, fix one of them in the same PR.

## 1. Assessment

### What Tower Crane is

Tower Crane is a delegation tool. An owner hands a plan to an orchestrator agent, the orchestrator dispatches workers, and software gates decide what counts as done. A run lasts hours or days. The owner is not supposed to steer every step; the README says it directly: "you watch instead of steering".

So the board is not a project-management surface where people move cards. It is the place where a person checks that delegated work is healthy, answers what only they can answer, and audits what was accepted in their name. Its success is measured in owner attention: a healthy run should cost seconds per look, and the board should take minutes only when something truly needs a human.

### Who looks, and when

| Who | Moment | What they need first | What they then do |
|---|---|---|---|
| Owner, handing over | The first minutes after `plan import` and the first dispatch | Did agents start, on the tasks and rungs I expected? | Change a tier or a rung that looks wrong; comment on a task |
| Owner, glancing | A tab left open for hours; a look every so often | Is work moving? Does anything need me? | Nothing, most of the time. That is the goal |
| Owner, returning | After a night, a meeting, a day away | What changed since I looked? What is stuck? | Read the digest, open what was accepted or sent back |
| Owner, deciding | A decision or an owner task is waiting | The question, the options, the recommendation and why, what it blocks | Answer, comment, mark an owner task done |
| Owner, auditing | Before a merge lands, or later when something broke | Why was this accepted: which commit, which gates, who reviewed, what ran | Read the evidence chain; follow the review link |
| Owner, paying | Any time, and at the end of a run | Tokens and agent time so far, by task and by rung, against the budget | Move a tier down a rung, or change a rung's model |
| Reviewer or teammate | Arrives from a PR link or a shared snapshot | This one task: acceptance, gates at this commit, who did what | Read; no writes. They are not the owner |
| The orchestrator agent | Always | Nothing from the board | It reads `status`, `ready` and `wait`; the board is for people |
| A stranger trying the tool | First `render` on a fresh project | What this is and what to do next | Add tasks; run `serve` |

The orchestrator does not read the board, and must never need to. That has two consequences. Every fact on the board comes from the state files through the same functions the CLI uses, so the board can never know something the CLI does not. And every write the board makes is a CLI command run through the CLI's own locked functions, so the board is a faster way to do a few owner things, never a second way to change state.

### The questions, in order

Every look starts with two questions, and the board must answer both before anything else is read:

1. **Is it moving?** Which agents hold work right now, what each is doing (its phase and its last message), and whether a lease is running out.
2. **Does anything need me?** Open decisions, tasks waiting on the owner, and runs that are stuck in a way only a person resolves.

Then, depending on the moment:

3. **What changed since I looked?** Accepted, sent back, submitted, new decisions, new messages.
4. **Can I trust what was accepted?** The evidence chain per task and commit.
5. **What is it costing?** Tokens and minutes by task, rung and model, against the budget.
6. **What is the shape of the plan?** Dependencies, what is ready, what unblocks the most.

The last question matters most at hand-off and least during a run. A dependency graph answers it well and answers questions 1 and 2 badly: two decisions hidden among fifty nodes are found by scanning, and a look that requires scanning is not a glance.

### The data, and what each part wants

- **The task graph.** Ten to a few hundred tasks, a DAG that is usually wide and shallow (depth under eight). Its shape changes when the plan changes, which is rare; statuses change all the time. Structure belongs in a secondary view; status belongs everywhere.
- **Leases.** A claim holds a task until a time. Remaining time is a quantity worth drawing; an expired lease and a `stall` event are trouble.
- **Phases.** A task moves claim, work, submit, gates, accept, merge. Where a task sits in that sequence is the most compact answer to "what is this agent doing".
- **Messages.** `msg`, task notes and owner comments are a conversation per task. The newest message from the agent holding a task is the best human-readable status line the system has.
- **Evidence.** Per task, per revision, per commit: tests, clean, review, CI and merge, each with its agent, summary, command receipts and sometimes a link. A resubmit moves the commit and older evidence stops counting. This is a ledger and should read like one, newest commit first.
- **The owner queue.** Open decisions (question, options, recommendation, why, what it blocks) and tasks with `needs_owner`. Usually zero to five items. This is the scarcest resource in the system: the owner's attention.
- **Waivers.** An owner waiver satisfies a gate without software proof. It is rare and it must stay visible forever in the audit.
- **Spend.** One entry per spawn or report: rung, harness, model, input, cached and output tokens, minutes. The state has no prices, so the board shows tokens and agent time and never invents money.
- **Events.** An append-only log, about a thousand lines a day on this repository's own run. It is the source for "since you looked" and for history.

### Time

- **Since you looked.** The browser remembers the newest event the person saw on this board (local storage, never the state directory) and the board opens with a digest of what happened after it: accepted, sent back, submitted, decisions opened and answered, messages. Changed items carry a marker until the next visit. Without a stored mark, the digest covers the last day.
- **Stuck.** An expired lease, a `stall` or `worker-exited` event, a claim whose spawned process exited without submitting, a submitted task whose latest gate failed, a task sent back three or more times. Each is shown with the CLI command that resolves it.
- **About to need me.** A decision that blocks a task whose dependencies are all accepted is blocking real work now and ranks above one that blocks distant work; the same holds for owner tasks. A lease ending within ten minutes is flagged on its card.

### Constraints

- **Static.** `render` writes one HTML file: no server, no network, no external fonts, scripts or styles. It must open from disk, from an attachment or from a shared folder, and still be useful with scripts disabled: every view and every task's detail is reachable by plain links (`sketch.html#T7`).
- **Live.** `serve` runs on 127.0.0.1, pushes changes over server-sent events and accepts writes only with the run's token; owner writes only when serve itself runs as the explicit owner.
- **Written after every write.** The CLI re-renders the snapshot on every state change, so rendering must be fast and deterministic.
- **Public.** Strangers run it on any OS with whatever fonts they have, on screens from a 390 px phone to a 3840x1080 ultrawide, in light or dark. Status is never carried by color alone. Keyboard and screen-reader use are normal, not an afterthought.
- **Scale.** From zero tasks to a few hundred, from zero events to tens of thousands. The snapshot caps the history it embeds.

### What the board does, and what it must not do

Must exist, in `serve`:

- Answer a decision, choosing one of its options when it lists them, with optional context.
- Comment on a task or a decision. The comment wakes the orchestrator through the `owner-comment` event, which is how an owner steers without taking the wheel.
- Mark an owner task done.
- Send a submitted or accepted task back for rework, with a reason. This is the owner's direct intervention on quality; it removes acceptance and never grants it.
- Change a task's tier and change the ladder (Settings).
- Everywhere, including the snapshot: move between views, open a task, follow a dependency, filter history by task, deep-link to a task, copy the CLI command for anything the board shows but does not do.

Must not exist:

- **Accept, merge, record evidence or waive a gate.** Gates are software; a button would invite skipping the proof. A waiver overrides software evidence, so it stays at the terminal under explicit owner identity with a written reason. When a gate is the only thing between a task and acceptance, the board shows the exact `accept --waive` command to copy, and nothing more.
- **Claim, release, submit, renew or spawn.** Those are agent acts with leases and identities; a person doing them from a browser would impersonate an agent.
- **Edit the plan** (titles, acceptance, dependencies, new tasks). Planning is a conversation between the owner and the orchestrator and goes through `plan import` and `task update`.
- **Pause a live claim.** The CLI has no such command yet; the board does not invent one. Commenting is the way to ask the orchestrator to stop.
- **Keep its own state.** "Seen" marks live in the browser. The state directory is written only by the CLI.
- **Show writes to someone who cannot make them.** A snapshot, or serve running as an agent, renders no owner forms; it shows the CLI commands instead.

## 2. Directions explored

Three directions were sketched as working pages from the same state: this repository's own run (52 tasks, about a thousand events) with two decisions, an owner task and token spend added. Screenshots of each, at 1920x1080 and 390 px, are in the PR that introduced this document.

### A. Graph first: the site plan

The dependency graph fills the window. Tasks needing the owner get a yellow outline; a side panel shows the selected task and lists the owner queue under it.

- Strong at hand-off: the shape of the plan, what feeds what, where the long chains are.
- Fails the glance. Two decisions and an owner task were three yellow outlines among fifty-two nodes, and the actual questions sat below the fold of the side panel. Answering "does anything need me" meant scanning.
- The graph looks the same from one look to the next, because statuses change and structure does not. Change becomes hard to see.
- Fan-in edges to a release task turned into a hairball at fifty tasks; it will be worse at two hundred.
- On a 390 px phone it is unusable: the graph needs two-axis scrolling and the panel takes the whole screen.

### B. Attention first: the desk

Columns in the order of the questions: what needs you, who is working now, what is up next, what changed. The owner queue is a block of yellow plates with the options as buttons. Each working task shows its agent, a phase track (claimed, working, submitted, gates, accepted, merged) and its last message.

- Answers both first questions in one look, before any reading: if the left column is yellow, you are needed; if the working column has cards with recent messages, work is moving.
- Actions sit next to their question: a decision is answered on the plate that asks it.
- Columns stack in priority order on narrow screens, so the phone shows the owner queue first.
- Weak at structure: dependencies are reduced to "unblocks N" and a reason per blocked task. The graph has to live in a second view.
- The raw event feed was noise: most lines were `spend`, `renew` and `brief set`. A digest has to group events by meaning.

### C. Timeline first: the logbook

Rows per task over the last 24 hours, claims as bars, accepts and reworks as ticks, gates as dots, with the owner queue pinned in a strip and the raw log beside it.

- The best answer to "what happened while I was away" and the only one that shows rhythm: rework loops are visible as rows of red ticks, idle hours as empty space.
- Most of the window was empty time (fourteen quiet hours on a working day), and the active part was compressed into the right edge.
- The pinned owner strip had to truncate every question, and there is no natural place to answer one.
- Time is the wrong primary axis for decisions and for live agents: what needs you now is not "where" on a time axis.
- On a phone the time axis collapses and only the log remains.

### Choice

B, attention first, because the assessment puts "is it moving" and "does anything need me" before every other question, and B is the only direction that answers both without scanning, on every screen size. It takes two things from the others:

- From A, the graph as the **Plan** view, one keystroke away, for hand-off and for "why is this blocked". On a phone it becomes a list by dependency depth.
- From C, the lesson that history must be read by meaning. The board's last column is a digest since you last looked, grouped and with noise removed, and **History** is a filterable log by day. Rework loops become a count on the task.

**Spend** and **Settings** are separate views because they answer the paying and tuning moments, which are occasional. A task's full record (acceptance, gates, evidence by commit, conversation, spend) is a **task sheet** that opens over any view and has its own link, `#T7`, so a PR can point at it.

## 3. Design system

Built for direction B and for nothing else. The ideas are below; the values live in `lib/board/style.js` and must stay equal to this section.

### Principles

1. **Color is a signal, not decoration.** Three hues carry meaning and nothing else gets a hue. Signal yellow means a person is needed. Live blue means an agent is on it now. Fault red means something failed or is stuck. Every other state is ink in different weights: done is solid ink, ready is an ink outline, blocked is a dashed outline, cancelled is struck through. A healthy run therefore reads as grey and ink with a few blue marks, and yellow appearing is an event.
2. **Signage, not stickers.** Yellow is a fill with black text on it, as on a construction sign; never yellow text on a light background. It stays black-on-yellow in the dark theme, as signs do at night.
3. **Every state has a shape.** Status glyphs differ in shape as well as color, and every glyph has a word next to it or in its accessible name, so nothing depends on seeing color.
4. **Words come from the CLI.** Task, ready, blocked, claim, lease, gates, tier, rung, rework: the board uses the terms the CLI prints, so what a person learns on the board works at the terminal. Every action the board cannot take is shown as the command that takes it.
5. **Density over chrome.** It is a tool watched for hours. Body text is 14 px, lists are dense, panels are flat plates with one-pixel rules and a 2 px radius; nothing floats except the task sheet, which is above the page.
6. **Motion reports change.** The only motion is a response: a card that changed since the last update fades from a blue wash, the task sheet slides in, the live dot breathes while connected. All of it stops under `prefers-reduced-motion`.

### Color

Neutrals are cool concrete and steel, so the yellow reads as the only warm thing on the page.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#eceef0` | `#13171b` | page background |
| `--plate` | `#ffffff` | `#1a1f24` | panels, cards, rows |
| `--plate-2` | `#f5f6f7` | `#20262c` | sunken areas, table heads, inputs |
| `--rule` | `#d3d8dd` | `#2d353d` | one-pixel borders and dividers |
| `--rule-2` | `#a7afb7` | `#4a5560` | stronger rules, edges in the graph, hover borders |
| `--ink` | `#14181c` | `#e7ebee` | text; fill for done |
| `--ink-2` | `#48515a` | `#b2bbc3` | secondary text |
| `--ink-3` | `#68717a` | `#8c96a0` | tertiary text, timestamps (4.6:1 or better on plate) |
| `--signal` | `#ffc800` | `#ffc800` | owner-needed fill |
| `--signal-edge` | `#c99a00` | `#ffd84a` | rule around signal plates |
| `--on-signal` | `#14181c` | `#14181c` | text and controls on signal |
| `--live` | `#1d5fd0` | `#78a6ff` | agent at work: glyph, phase, lease bar |
| `--live-wash` | `#e4ecfb` | `#192840` | changed-item flash, live card tint |
| `--fault` | `#c22b1d` | `#ff7d6e` | failed gate, stuck, rework |
| `--fault-wash` | `#fbe6e3` | `#3a1e1b` | stuck rows, invalid inputs |
| `--focus` | `#1d5fd0` | `#78a6ff` | focus ring |

All text pairs meet WCAG AA: ink, ink-2 and ink-3 on plate and paper, live and fault on plate, on-signal on signal (about 13:1). The theme follows `prefers-color-scheme`.

### Type

- **Text**: the system UI face (`system-ui`, then the platform faces). The board is a local tool for a CLI; it should look native on each OS, render crisply at any density and cost no bytes, since the snapshot is rewritten on every state change and must not load fonts.
- **Identifiers**: the system monospace face for task ids, commit SHAs, agent names and commands, because they are tokens the person copies to a terminal. Monospace is not used for labels or numbers.
- **Numbers**: tabular figures everywhere a number can change.
- Scale (px): 12 meta, 13 dense rows, 14 body, 16 card titles, 20 view titles, 26 the project name. Weights 400 and 600 only. Line height 1.45 for text, 1.25 for titles. Sentence case everywhere; no all-caps labels.

### Space, radius, elevation

- Spacing steps (px): 2, 4, 8, 12, 16, 24, 32, 48.
- Radius: 2 px for plates, cards, buttons and inputs; 0 for bars and rails; circles only for status glyphs.
- Elevation: none on the page. The task sheet and the copy confirmation sit above it with one shadow, `0 12px 32px` at 22% black in light and 50% in dark, plus a rule.

### Motion

| What | Duration | Easing |
|---|---|---|
| Hover and press feedback | 120 ms | `cubic-bezier(.2,.7,.2,1)` |
| Task sheet in and out | 200 ms | same |
| Changed item flash (blue wash to plate) | 1600 ms | ease-out |
| Live dot breathing while connected | 2400 ms, repeating | ease-in-out |

`prefers-reduced-motion: reduce` turns all of it off; changed items then keep a static marker until the next update.

### Layout

The board is one row of columns, in the order of the questions:

```
| Needs you | Working now        | Up next              | Since you looked |
| (signal)  | (live cards)       | ready  | blocked     | (digest)         |
```

- 2600 CSS px and wider (a 3840x1080 ultrawide): six units, Needs you 1, Working now 2 (cards in two columns), Up next 2 (ready and blocked side by side), Since you looked 1. The extra width shows more work above the fold of a short screen instead of making cards wider.
- 1700 to 2600: four columns, one unit each.
- 1100 to 1700 (a 1280x800 laptop): three columns; the digest becomes a strip above them.
- 720 to 1100: two columns, Needs you and Working now on the left, Up next on the right.
- Under 720 (a 390 px phone): one column in priority order; the view switcher scrolls horizontally.

Columns scroll on their own on screens tall enough to hold the board; on short or narrow screens the page scrolls. Text never runs wider than about 75 characters: card text is capped and long evidence wraps.

### Components

- **Top bar.** Product mark and project name, the goal on one line, the plan rail, spend against budget, connection state and the view switcher. The plan rail is one bar split by status in the plan's order of done to blocked; its legend is the count list under it.
- **Connection state.** `Live` with a breathing dot while serve's stream is connected, `Reconnecting` in fault red when it drops, `Snapshot` with its time in a rendered file.
- **Status glyph** (12 px SVG): ready, an ink ring; blocked, a dashed ink ring; in progress, a live ring half filled; submitted, an ink ring with a center dot; accepted, a solid ink disc; rework, a fault ring with a gap; cancelled, a ring with a slash. A signal square at the corner marks a task that needs the owner.
- **Signal plate.** A decision, owner task or message to the owner: kind and what it blocks, the question, the reasoning, the recommendation, and the options as buttons in serve or the command in a snapshot. "Blocking now" when a blocked task would otherwise be ready.
- **Stuck row.** A plate with a fault rule on its left edge: what is wrong, since when, and the command that resolves it.
- **Work card.** Id, title, agent and rung (harness and model), the phase track, the lease bar with time left, the last message with its age and author, and tokens so far. A submitted task's card shows gate pips instead of the lease.
- **Phase track.** Six steps: claimed, working, submitted, gates, accepted, merged. Past steps are ink, the current step is live, future steps are rules. It is a real sequence, so it is drawn as one.
- **Gate pips.** One per required gate: pass is a filled ink square with a check, fail a fault square with a cross, missing a hollow square, waived a signal square. Each has the gate's name as text.
- **Queue row.** Glyph, id, title, tier, and either "unblocks N" or the blocking reason.
- **Digest.** A summary line ("3 accepted, 1 sent back, 5 messages"), then events grouped by meaning, newest first, each with a link to its task. Spend, renew and other bookkeeping are left out here and kept in History.
- **Task sheet.** Opens over the current view from the right (full screen on a phone). Header with glyph, id, title, tier, kind, size and revision; acceptance; what blocks it; gates at the submitted commit; evidence grouped by commit, newest first, with summaries and command receipts; the conversation (notes, messages, owner comments); spend entries; dependencies both ways; and, in serve as owner, comment, mark done, send back and tier controls. The terminal override for gates (`accept --waive`) is shown as a command, never as a button.
- **Command.** A monospace command with a copy button. The copy confirmation is the only toast.
- **Buttons.** Primary is an ink fill with plate text; secondary is a rule outline; on a signal plate the primary is ink with signal text and the secondary an ink outline. Destructive (send back) is a fault outline that fills on hover. Disabled is 45% opacity with no hover.
- **Inputs.** Plate-2 fill, rule border, 2 px radius; hover darkens the rule; focus shows the focus ring; invalid shows a fault border with the message linked through `aria-describedby`; busy disables the whole form and the button says what it is doing.
- **Empty states.** Each column says what its emptiness means and what comes next: "Nothing needs you. Decisions and owner tasks appear here." A fresh project with no tasks tells the person the first command to run.

### Views

| View | Answers | Notes |
|---|---|---|
| Board | is it moving, does anything need me, what changed | the default; columns above |
| Plan | the shape of the plan | the graph by dependency depth, edges of the focused task highlighted, done tasks dimmed; a list by depth on narrow screens |
| History | what happened | events by day, filterable by kind and task; the snapshot embeds the newest 400 |
| Spend | what it costs | totals against budget, then by rung, by model and by task; tokens and agent time only |
| Settings | how work is dispatched | the ladder and task tiers; serve only |
| Task sheet | everything about one task | over any view; its own link |

### Live behavior

- serve pushes a `reload` event when the state changes. The page fetches itself, replaces the regions that changed and flashes the items whose content changed. It never reloads the page under the person.
- A region holding a form with focus or with text typed into it is not replaced. The page says that updates are waiting and applies them when the form is sent or cleared.
- The title carries the number of items that need the owner, and the icon gets a signal mark, so a background tab says "you are needed".
- A screen-reader announcement lists what changed: accepted, sent back, new decision.
