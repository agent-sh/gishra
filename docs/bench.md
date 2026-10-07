# Bench

Two read-only commands measure Tower Crane on its own history. `bench gates` labels every software gate result as right or wrong from what happened later. `bench tokens` reports what an accepted task costs, by rung and by escalation path. Both read the state directory and change nothing.

```sh
tower-crane bench gates [--deslop-hits FILE] [--deslop-findings FILE] [--deslop-runs FILE] [--deslop-report FILE] [--json]
tower-crane bench tokens [--prices FILE] [--json]
```

## Gate bench

### Labels

A gate result is a run of `check tests`, `check clean`, `check ci` or `merge`, read from `events.jsonl`. Evidence an agent records by hand is not a gate run and is not labeled. A failing gate is a positive: it says the sha is not ready.

| Label | Rule |
|---|---|
| false positive | the gate failed, and the same gate later passed the same sha, so no code changed between the two |
| true positive | the gate failed, was never reversed at that sha, and the task later moved to a different sha |
| false negative | the gate passed, and later a review blocker or a failed CI check run hit the same sha and was not reversed at that sha |
| true negative | the gate passed, nothing contradicted it, and a later passing review or merge confirmed that sha |
| open | none of the above yet: a fail with no later submit, a pass with no later review or merge |
| noncode | a CI fail that names no failed check run: pending, mergeability, a moved head, a failed GitHub query, or no summary |

Precision is `tp / (tp + fp)`. Recall is `tp / (tp + fn)`. Open and noncode results count in neither. `recall(ci)` counts only CI contradictions, because review blockers include design and scope findings that no software gate is meant to catch. It is `-` for the ci and merge gates: both read CI themselves, so CI cannot contradict them and the figure would be 100% by construction.

Rules that keep the labels honest:

- A CI failure is a verdict on the code only when it names failed check runs (`failure`, `timed_out`, `startup_failure`). A pending run, an uncomputed or conflicting PR, a moved head or a failed GitHub query says nothing about the code. One rule holds on both sides: such a failure contradicts no pass, and as a ci gate result it is labeled `noncode`, never a true or false positive. The reason comes from the evidence summary stored with the task; failures whose summary is missing count as `unknown` and are noncode.
- A failure that the same kind of check later reversed at that sha (a CI rerun, a second review) contradicts nothing.
- Gates often rerun on one sha. The score counts one result per gate, sha and outcome, labeled by its earliest run, which has the most later evidence. `runs` shows the raw count, and `--json` lists every labeled run with the event that decided it.
- Per CI check run, a failure is a false positive when CI later passes the same sha.

### Deslop checks

The cleanup gate runs the deslop detector. Its own eval files label its checks three ways, each behind one flag:

- `--deslop-hits`: JSONL of detector hits with a hand verdict each (`true-slop`, `harmless`, `false-positive`). Precision is true slop over all hits; lenient precision also counts harmless hits.
- `--deslop-findings` with `--deslop-runs`: JSONL of reviewer-found defects (`source` is `repo#pr url`, plus `reviewed_commit` and `example` as `path:line`), and the detector's JSON output keyed `repo#pr@commit`. A detector item in the same file within 5 lines of a defect at the reviewed commit is a true positive, the eval's own matching rule. Other items are unconfirmed, so precision is a lower bound: reviewers do not report every real problem. Recall is defects caught over defects with a detector run. `--deslop-findings` alone reports the earlier detector's `deslop_caught` field.
- `--deslop-report`: a detector report after agent confirmation, with `findings` kept and `dismissed` rejected.

## Token bench

Tokens come from `spend.entries`. Every harness parser records input inclusive of cache reads, so fresh input is `input - cached`, and the bench reports fresh input, cache reads and output separately before any comparison. A task is complete when it has known tokens and no spawned entry with unknown tokens; minute-only manual entries are not missing telemetry. Medians use complete accepted tasks only.

- The escalation path is the task's worker rungs from its `spawn` events in order, repeats collapsed: `easy>medium` started on easy and moved once. Native work without spawn receipts uses the rungs its spend entries name. A path that goes down (`medium>easy`) is a re-tier, not a quality climb.
- By rung, each task contributes the tokens it spent on that rung, so `review` is the review cost per accepted task.
- `all recorded task tokens / accepted tasks` divides every task's spend, cancelled and unfinished ones included, by the accepted count: the full cost of getting work accepted.
- USD uses the entry's recorded `cost_usd`, else `--prices`, else the project `review.prices`, with the review pricing rules (inclusive input, conservative cache-write pricing). Rates match on the model id: a 1M-context id such as `global.anthropic.claude-opus-5-5[1m]` is its own row and does not fall back to base Opus. An entry whose model has no rate is unpriced, the output lists unpriced entries by model, and a task with any unpriced entry is left out of the USD median; the `priced` column counts the tasks that median covers.

## Results

Snapshot: this project's state copied at 2026-10-08 02:46 (Jerusalem), 16,029 events, 114 tasks. The state is live, so later runs on it give other counts; token figures move most, because running tasks keep adding spend. Deslop inputs: the 2026-10-06 slop research set (3,367 hand-labeled hits from deslop 1.3.0, 106 reviewer-found defects across agent-sh and darklanes PRs), the eval run of the rewritten detector on the same PRs, and its one agent-confirmed report.

Prices, per million tokens (input / cache write / cache read / output), Bedrock global rates:

| Model id | Input | Cache write | Cache read | Output |
|---|---|---|---|---|
| `claude-opus-5-5` | 4 | 5 | 0.20 | 20 |
| `global.anthropic.claude-opus-5-5[1m]` | 4 | 5 | 0.20 | 20 |
| `openai.gpt-6.1-sol` | 2 | 2.50 | 0.10 | 10 |
| `openai.gpt-6-luna` | 0.10 | 0.125 | 0.01 | 0.50 |

The 1M-context Opus id has its own row at the base Opus rates, since no long-context premium for it is recorded. Without that row its 4 entries are unpriced and the overall USD median covers 40 tasks instead of 42. Haiku 5.5 has no rate: its 3 entries leave two tasks unpriced.

Both benches read recorded data and are deterministic: three runs of each on the snapshot gave byte-identical output (text and `--json`), so each figure is the value of every run. The deslop eval run is a detector run over git history and is deterministic as well.

### Gates

| Gate | Runs | Results | TP | FP | FN | TN | Open | Noncode | Precision | Recall | Recall (CI) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| tests | 310 | 263 | 15 | 11 | 113 | 67 | 57 | 0 | 57.7% | 11.7% | 24.6% |
| clean | 275 | 249 | 8 | 2 | 117 | 67 | 55 | 0 | 80.0% | 6.4% | 14.3% |
| ci | 248 | 220 | 43 | 3 | 33 | 56 | 10 | 75 | 93.5% | 56.6% | - |
| merge | 70 | 69 | 5 | 2 | 1 | 1 | 60 | 0 | 71.4% | 83.3% | - |

False negatives by source: tests 67 review and 46 CI, clean 69 and 48, ci 33 review, merge 1 review. Recall (CI) is `-` for ci and merge because they read CI themselves.

What the false positives were:

- tests (11): five were the gate refusing before it ran anything (no pinned command, or a command that differed from the pin); four were suite exits that passed on rerun; two were test-file classification bugs: T8's gate treated `lib/gates/tests.js` as a test and reported that the tests passed without the change, and T51's proof ran a fixture under `test/fixtures/` as a test file.
- clean (2): the cleanup tool not installed, and a cleanup command that differed from the pin.
- merge (2): GitHub refusing a direct merge of a stacked PR.
- ci (3): the Windows Node 24 run passing on rerun.

So most gate false positives are configuration and refusals, not wrong verdicts about code. Recall is low for tests and clean because reviewers block on what neither gate checks. Against CI alone, tests recall is 25%. The CI failures it misses name revuto-review 26 times, test runs on other platforms and Node versions 26 times and CodeQL 5 times (one failure can name several checks): review blockers and environments the local gate never runs.

CI failures by reason (distinct results): failed check runs 52, mergeability 38, pending 22, unknown 9, GitHub query 5, moved head 1. All but the first are the 75 noncode results.

| CI check run | Fails | TP | FP | Open | Precision |
|---|---|---|---|---|---|
| revuto-review | 27 | 21 | 0 | 6 | 100% |
| test (windows-latest, node 24) | 12 | 9 | 3 | 0 | 75.0% |
| test (ubuntu-latest, node 24) | 9 | 9 | 0 | 0 | 100% |
| test (windows-latest, node 26) | 7 | 7 | 0 | 0 | 100% |
| test (ubuntu-latest, node 20) | 6 | 6 | 0 | 0 | 100% |
| CodeQL | 5 | 5 | 0 | 0 | 100% |
| test (ubuntu-latest, node 26) | 5 | 5 | 0 | 0 | 100% |

The Windows Node 24 run is the one flaky check.

### Deslop checks

deslop 1.3.0, hand verdicts on 3,367 hits: 18 true slop (0.5%), 163 harmless. Only two checks found anything: `disabled_linter` 11 of 62 (17.7%) and `issue_pr_references` 7 of 105 (6.7%). The two largest, `rust_bare_unwrap` (1,377 hits) and `high_entropy_string` (1,238), found none. The same version caught 0 of the 106 reviewer-found defects.

The rewritten detector, against the reviewer-found defects at their reviewed commits (100 of 106 had a run):

| Check | Items | TP | Unconfirmed | Precision (lower bound) | Defects caught | Recall |
|---|---|---|---|---|---|---|
| stale-mention | 33 | 0 | 33 | 0% | 0 | 0% |
| missing-path | 20 | 1 | 19 | 5.0% | 1 | 1.0% |
| dropped-rule | 11 | 0 | 11 | 0% | 0 | 0% |
| complexity | 5 | 2 | 3 | 40.0% | 2 | 2.0% |
| lint | 5 | 1 | 4 | 20.0% | 2 | 2.0% |
| changelog-missing | 3 | 0 | 3 | 0% | 0 | 0% |
| review-provenance | 3 | 1 | 2 | 33.3% | 1 | 1.0% |
| em-dash | 2 | 0 | 2 | 0% | 0 | 0% |
| broken-anchor | 1 | 1 | 0 | 100% | 1 | 1.0% |

7 of 100 defects caught (7%). The match is by location, so a catch can be a nearby item about something else: the one `missing-path` catch sits next to a stale model name. The earlier eval run of the same rewrite caught 6. On the one agent-confirmed report, the agent kept 1 of 11 findings and dismissed all 8 `missing-path` items.

### Tokens per accepted task

62 accepted tasks, 44 with complete token records. All recorded task tokens over accepted tasks: 39.07M. `Priced` is the number of tasks in the USD median.

| Group | Tasks | Median tokens | Mean tokens | Median USD | Priced |
|---|---|---|---|---|---|
| all | 44 | 18.61M | 40.12M | $2.89 | 42 |

By escalation path:

| Path | Tasks | Median tokens | Mean tokens | Median USD | Priced |
|---|---|---|---|---|---|
| easy | 12 | 16.23M | 64.28M | $0.58 | 10 |
| easy>medium | 2 | 63.77M | 63.77M | $2.21 | 2 |
| medium | 16 | 17.47M | 25.09M | $3.28 | 16 |
| medium>easy | 3 | 8.55M | 8.95M | $1.16 | 3 |
| medium>easy>medium | 3 | 43.52M | 42.87M | $7.45 | 3 |
| medium>hard | 1 | 103.92M | 103.92M | $23.63 | 1 |
| hard | 5 | 16.12M | 21.00M | $7.98 | 5 |
| research | 1 | 24.93M | 24.93M | $12.48 | 1 |
| research>medium | 1 | 75.51M | 75.51M | $21.37 | 1 |

By rung (tokens each task spent on that rung):

| Rung | Tasks | Median tokens | Mean tokens | Median USD | Priced |
|---|---|---|---|---|---|
| easy | 20 | 12.35M | 46.13M | $0.19 | 18 |
| medium | 25 | 16.33M | 23.18M | $2.83 | 25 |
| hard | 6 | 17.64M | 19.49M | $8.07 | 6 |
| research | 2 | 38.04M | 38.04M | $13.79 | 2 |
| review | 42 | 835k | 1.67M | $0.41 | 42 |

Cache reads are 98.0% of the complete tasks' tokens, fresh input 1.6% and output 0.4%. Token counts therefore track turns and context size, not work, and comparisons between rungs need USD. An easy task costs less than a fifth of a medium one at the median ($0.58 against $3.28) for about the same tokens. Climbing costs more than starting on the right rung: `easy>medium` at $2.21 is close to `medium`, while `medium>easy>medium` at $7.45 is more than twice it. The easy mean is pulled up by T85, which spent 530M tokens, 99.5% of them cache reads, for $6.60.

## Limits

- Labels need later evidence. Results still in flight are open and do not count, and merge passes stay open because nothing is recorded after a merge.
- A review blocker counts against every gate that passed that sha, whether or not the blocker is the kind of fault the gate checks. `recall(ci)` is the narrower view.
- Only failures recorded with a summary can be split by reason; older gishra-era events without a matching evidence entry count as `unknown`, so a real check failure among them is noncode rather than a true positive.
- Spend entries come from harness telemetry. Claude thinking tokens that the API usage does not report are missing, and long-context surcharges per request cannot be rebuilt from totals.
- The deslop precision against reviewer findings is a lower bound, and its location match can credit an unrelated item.
- The bench reads the live state. Results are reproducible only on a copied snapshot; the figures above come from the 16,029-event snapshot named under Results.
