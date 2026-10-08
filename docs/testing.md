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
- No fixed sleeps. Wait for a file, an event or a process with a deadline, and size the deadline for a loaded machine.
- Assert the reason a command refuses, not only its exit code. A refusal for the wrong reason passes an exit-code check while the guarded code is gone.

## Tools

- `node scripts/test-cost.js [--before DIR] [files...]` measures CPU and wall seconds per file, median of three runs, four files at a time. With `--before`, it measures another checkout interleaved with this one.
- `node scripts/mutants.js` plants each bug in its list in a scratch copy and runs the files named for it. A bug those files miss runs against the full suite before it counts as missed. Every bug must be caught.
- `node scripts/test-coverage.js` uses node:test coverage, which follows the CLI processes a test starts. For each file it lists the lib lines it runs and how many no other file runs. A file with no unique lines is a candidate to merge or delete.
