# Testing

The suite proves behavior through the real CLI on temporary git repositories. It stays small enough to run often without loading the machine. This page is how to run it, how to write for it, what it costs and how its accuracy is measured.

## Running

- `npm test` runs every file in `test/` and `test/gates/`. File workers are capped at 4 and at one below the machine's core count, since each file also starts CLI, git and stub processes.
- `npm test -- test/claim.test.js test/gates/tests.test.js` runs only those files. Pass node:test flags the same way: `npm test -- test/events.test.js --test-name-pattern="decision answer"`.
- Run only the files a change touches. The tests gate runs the full suite once at the submitted head, and CI runs it on Linux (Node 24 and 26) and on Windows in three shards.
- Set `TOWER_CRANE_TEST_TMP` to keep temporary repositories off `/tmp`.

For projects Tower Crane manages, expensive proof is the default: the orchestrator pins `--tests-cmd "npm test" --tests-expensive true --tests-proof-cmd "node --test {tests}"`. A submission then runs the full suite once and proves the change with its own test files.

## Writing tests

- One integration test per piece of functionality and one end-to-end test per full feature. A unit test is only for pure logic nothing else reaches.
- A table of variants over pure logic runs in process against the module, with one CLI test for the wiring: address ranges and markup in `test/sources.test.js`, build-file and policy tables in `test/gates/tests.test.js`, outage classification in `test/supervision.test.js`, broker authorization in `test/broker.test.js`.
- A fixture several tests share is built once per file with `cachedFixture(t, key, build)` from `test/helpers.js`. Each test gets a copy, with paths that name the template rewritten in its files, env and git config.
- Each test repository has its own `HOME`, so no test writes the developer's home: `spawn` keeps receipts under `~/.cache/tower-crane`.
- No fixed sleeps. Wait for a file, an event or a process with a deadline, and size the deadline for a loaded machine.
- Assert the reason a command refuses, not only its exit code. A refusal for the wrong reason passes an exit-code check while the guarded code is gone.

## Tools

- `node scripts/test-cost.js [--before DIR] [files...]` measures CPU and wall seconds per file, median of three runs, four files at a time. With `--before`, it measures another checkout interleaved with this one.
- `node scripts/mutants.js` plants each bug in its list in a scratch copy and runs the files named for it. A bug those files miss runs against the full suite before it counts as missed. Every bug must be caught.
- `node scripts/test-coverage.js` uses node:test coverage, which follows the CLI processes a test starts. For each file it lists the lib lines it runs and how many no other file runs. A file with no unique lines is a candidate to merge or delete.

## Accuracy: the mutation sample

`scripts/mutants.js` holds 31 planted bugs across the areas where a silent regression costs the most. Each is a one-line change: a check removed, a bound moved by one, a guard always true.

| area | bugs | examples |
| --- | ---: | --- |
| gates | 8 | tests pass without the change, a deleted test counts, a cancelled CI run is green, a HIGH finding passes clean, loopback is a public source, evidence counts without its audit event, the submitter's own review counts, evidence from an old revision counts |
| authority | 4 | any spawned agent is the orchestrator, a brokered command keeps its identity's authority, the orchestrator makes owner-required changes, the terminal fallback acts as owner |
| broker | 3 | any command, another task, a request without the token |
| spawn and supervisor | 4 | a permanent exit retries, one retry too many, CPU activity ignored for stalls, the workers limit off by one |
| state lock | 3 | a live holder's lock is broken, the pid namespace is ignored, a stale lock never ages out |
| merge and stacks | 4 | merge with a moved head, an unaccepted lower task, an untracked lower PR, admin on a stack |
| secrets | 2 | the codex config keeps credentials, an env_file error echoes its contents |
| board | 3 | unescaped `<`, Settings writes without the page token, any serve acts as owner |

Before: 31/31 caught, 5 of them only by the full suite. After: 31/31 caught, 1 only by the full suite.

| bug | area | before: caught by | after: caught by |
| --- | --- | --- | --- |
| `tests-pass-without-change` | gates | test/gates/tests.test.js | test/gates/tests.test.js |
| `tests-deleted-test-counts` | gates | test/gates/tests.test.js | test/gates/tests.test.js |
| `ci-cancelled-is-green` | gates | test/gates/ci.test.js | test/gates/ci.test.js |
| `clean-high-passes` | gates | test/gates/clean.test.js | test/gates/clean.test.js |
| `sources-loopback-public` | gates | test/sources.test.js | test/sources.test.js |
| `evidence-without-audit` | gates | test/evidence.test.js | test/evidence.test.js |
| `review-by-submitter` | gates | test/accept.test.js | test/accept.test.js |
| `evidence-old-revision` | gates | test/accept.test.js | test/accept.test.js |
| `spawned-agent-is-orchestrator` | authority | test/authority.test.js | test/authority.test.js |
| `brokered-command-has-authority` | authority | full suite | test/authority.test.js, test/broker.test.js |
| `orchestrator-makes-owner-changes` | authority | test/authority.test.js | test/authority.test.js |
| `terminal-fallback-is-owner` | authority | test/identity.test.js | test/identity.test.js |
| `broker-any-command` | broker | test/broker.test.js | test/broker.test.js |
| `broker-other-task` | broker | full suite | test/broker.test.js |
| `broker-no-token` | broker | full suite | test/broker.test.js |
| `supervisor-retries-permanent-exit` | spawn/supervisor | test/supervision.test.js | test/supervision.test.js |
| `supervisor-extra-retry` | spawn/supervisor | test/supervision.test.js | test/supervision.test.js |
| `supervisor-ignores-cpu` | spawn/supervisor | full suite | test/supervision.test.js |
| `workers-limit-off-by-one` | spawn/supervisor | test/claim.test.js, test/worker-slots.test.js | test/claim.test.js, test/worker-slots.test.js |
| `lock-breaks-live-holder` | state lock | test/lock.test.js | test/lock.test.js |
| `lock-ignores-pid-namespace` | state lock | test/lock.test.js | test/lock.test.js |
| `lock-never-ages-out` | state lock | test/lock.test.js | test/lock.test.js |
| `merge-moved-head` | merge/stacks | test/gates/merge.test.js | test/gates/merge.test.js |
| `stack-merge-unaccepted-lower` | merge/stacks | full suite | full suite |
| `stack-merge-untracked-lower` | merge/stacks | test/stack-merge.test.js | test/stack-merge.test.js |
| `stack-merge-admin` | merge/stacks | test/stack-merge.test.js | test/stack-merge.test.js |
| `codex-config-keeps-secrets` | secrets | test/isolation.test.js | test/isolation.test.js |
| `env-file-error-echoes` | secrets | test/sandbox-extensions.test.js | test/sandbox-extensions.test.js |
| `board-unescaped-lt` | board | test/board.test.js | test/board.test.js |
| `serve-no-page-token` | board | test/settings.test.js | test/settings.test.js |
| `serve-anyone-owner` | board | test/events.test.js | test/events.test.js |

The before run is `origin/main` at e2f5277 with two additions so it could run here: each test repository's own `HOME` (spawn writes receipts under the home cache) and this branch's `test/run.js`; the after run is this branch. Both ran inside a Tower Crane worker sandbox. There the parent's git shim refuses a nested push of another task's branch, so the before run passed `--skip "publish its task branch"` for the one isolation test that makes such a push.

Working through the sample found one test that passed for the wrong reason and two checks that only a slow or timing-bound test made:

- The brokered-authority check in `test/authority.test.js` exited 1 because the command found no repository, never reaching the authority check. It now passes `--state` and asserts the refusal.
- Broker refusals for another task's id and for a missing token were only proven through a full sandboxed spawn in `test/isolation.test.js`. `test/broker.test.js` now checks both directly, in milliseconds.
- The CPU stall test in `test/supervision.test.js` looked for a stall after 1.4 s, while the supervisor samples once a second. On a loaded machine its second sample came late, so a supervisor that ignored CPU passed. The window now covers two samples.

`stack-merge-unaccepted-lower` is caught only by the full suite: in `test/stack-merge.test.js` the gate report refuses an unaccepted lower task before the status check is reached.

## node:test options

Measured on this machine, which other sessions kept at a load of 30 to 80 for the whole work. CPU seconds are the stable figure; wall times under that load are noisy. Medians of three unless noted.

| option | measurement | taken | why |
| --- | --- | --- | --- |
| `--test-concurrency` | the owner's report: unbounded runs loaded the machine | yes | `npm test` passes 4, and `test/run.js` caps it at one below the core count. Each file also starts its own CLI and git processes, so the cap is on file workers, not cores. |
| `--test-isolation=none` | 12 light files, 3 runs: 61.1 CPU s with process isolation, 58.5 s with none; wall 51 s against 148 s | no | It saves 4% CPU and loses file parallelism, so a run takes three times longer. Every file then shares one `process.env` and module cache, and files set git identity and gate variables in the environment. |
| `--test-global-setup` | the seed is six small files: no measurable CPU | yes | `test/global-setup.js` builds the clean git seed once per run and hands it to every file through the environment. It replaces the wrapper's own seed handling and also covers scoped runs. |
| `--test-shard` | the Windows job in three shards, as T85 set up | yes | CI keeps three Windows shards. `test/run.js` no longer keeps a Windows file priority list: native sharding does not keep the runner's file order (found in review of T85), so the list had no effect. |
| `mock.timers`, `t.mock`, `--experimental-test-module-mocks` | the waits that remain are on real child processes | no | A mocked clock in the test process does not move the clock of the CLI, the supervisor or a git hook it waits for. Where a child's time matters, preloaded fixture clocks already run inside the child (`test/fixtures/supervision-backoff-clock.js`). Spawned stubs were replaced by in-process calls with the modules' own injection points: `fetchPublic` with a resolver and a fetcher, `errorReader`, `authorize`. |
| `describe` or `test` concurrency inside a file | evidence and accept, 3 runs: 54.0 CPU s sequential, 53.9 s with four tests at once; wall 92 s against 62 s | no | It saves no CPU, and it multiplies the processes a run starts past the file cap the owner asked for. |
| `--test-rerun-failures` | tried on a fixture: after one green rerun, the next run with the same state file ran no test and reported a pass | no, for `npm test` and the gate | A gate retry could then accept a head no test ran on. For a local loop, `npm test -- FILE --test-rerun-failures=$TOWER_CRANE_TEST_TMP/rerun.json`, and delete the file once it passes. |
| `--experimental-test-coverage` | coverage follows the CLI processes a test starts: `test/claim.test.js` alone runs 37% of `lib/tasks.js` | yes, as a tool | `scripts/test-coverage.js` maps the lib lines each file runs and how many no other file runs, to find files to merge before deleting any. |
| `--test-name-pattern` | passes through `npm test --` | yes | For one case of a file: `npm test -- test/events.test.js --test-name-pattern="decision answer"`. |
| `--experimental-test-tag-filter` | works with `{ tags: [...] }` on a test | no | It is experimental, and files are already named by area, which is what the gate's scoped proof selects. |
| `--test-timeout`, `--test-force-exit` | slowest test seen: 107 s, on a machine at load 68 | yes | 300 s per test, about three times that, so a hung test fails in minutes instead of holding CI to its job timeout. Force exit ends a run that a stray handle would keep open. |
| `NODE_COMPILE_CACHE` | evidence and accept, 3 runs: 50.1 CPU s without, 50.0 s with; 60 CLI calls: 8.4 s against 8.0 s | no | No measurable gain on the suite. A CLI call's cost is its git subprocess and the board render on every write, not compiling. |
| `--v8-pool-size=0`, `--jitless` | 60 CLI calls, 2 runs: 8.4 CPU s plain, 8.9 s and 9.9 s | no | Both are slower. |
