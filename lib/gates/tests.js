'use strict';
// Prove keeps changed tests while reverting code; run-only checks the submitted head.
const { fail, short, tailLines, createRedactor, how, errText, git, shell, shellQuote, resolveCommit, mergeBase, withWorktree, listSome } = require('./common');
const testsPolicy = require('../tests-policy');

const DEFAULT_TIMEOUT_MIN = 20;
const TAIL = 40;
const OUTPUT_TAIL_CHARS = 8192;
// Only the tail of the output is reported; this bounds what a verbose suite keeps in memory.
const KEEP_CHARS = 1 << 20;

function diagnosticRedactor(project, root) {
  const env = process.env;
  const secrets = Object.entries(env);
  const envFiles = new Set();
  const addEnvironment = (values) => {
    for (const [name, value] of Object.entries(values || {})) secrets.push([name, value]);
  };
  const addSettings = (settings) => {
    if (!settings || typeof settings !== 'object') return;
    addEnvironment(settings.env);
    if (typeof settings.env_file === 'string' && settings.env_file.trim()) envFiles.add(settings.env_file);
  };
  addSettings(project);

  try {
    const layers = require('../ladder').resolve(project, env);
    for (const entry of Object.values(layers.ladder || {})) {
      addSettings(entry.own);
      for (const fallback of entry.fallbacks || []) addSettings(fallback);
    }
  } catch {
    // Invalid user ladder settings must not stop a tests check from running.
  }

  const SpawnSettings = require('../spawn-settings');
  let home = require('node:os').homedir();
  try { home = require('../agents').origin(env).home; } catch {}
  for (const file of envFiles) {
    try {
      const settings = SpawnSettings.resolve({}, { env_file: file });
      const prepared = SpawnSettings.prepare(settings, home, root || process.cwd());
      addEnvironment(SpawnSettings.agentEnv({ ...prepared, env: {} }));
    } catch {
      // Unreadable environment files are not used by the gate process.
    }
  }
  return createRedactor(secrets);
}

// Test layouts across languages. Directory names and suffixes after a separator match in any
// case (test/, Tests/, MyApp.Tests/, foo_spec.rb); CamelCase forms need their capital
// (FooTest.java, AppTests/) so latest.js and contest.py stay code. A code file taken for a test
// is never reverted, which would let the gate pass without proof.
const DEFAULT_TESTS = [
  /(^|\/)(tests?|__tests?__|specs?)\//i, // test/, Tests/, __tests__/, spec/
  /(^|\/)[^/]+[._-](unit|integration|e2e|functional)?tests?\//i, // MyApp.Tests/, MyApp.UnitTests/, integration_test/
  /(^|\/)[^/]*[a-z0-9](Tests?|Specs?)\//, // AppTests/, androidTest/, integrationTest/
  /(^|\/|[._-])(tests?|specs?)\.[^/]+$/i, // foo.test.js, foo_test.go, foo_spec.rb, foo-spec.ts, test.js
  /(^|\/)test_[^/]+$/i, // test_foo.py, test_util.c
  /[a-z0-9](Tests?|Specs?|IT|TestCase)\.[^/.]+$/, // FooTest.java, FooTests.swift, FooTests.cs, FooSpec.scala, FooIT.java
  /(^|\/)Test[A-Z][^/]*\.[^/.]+$/, // TestFoo.java
];

function isTestFile(p) {
  return DEFAULT_TESTS.some((re) => re.test(p));
}

function escapeRe(s) {
  return s.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
}

// A glob over repository paths: `*` and `?` stay inside one directory, `**/` spans any number
// of directories (none included), `{a,b}` is either, and a trailing `/` takes all beneath.
function globSource(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{' && g.indexOf('}', i) > i) {
      const end = g.indexOf('}', i);
      re += `(?:${g.slice(i + 1, end).split(',').map(globSource).join('|')})`;
      i = end;
    } else {
      re += escapeRe(c);
    }
  }
  return re;
}

function globToRegExp(glob) {
  const g = glob.trim().replace(/^\.\//, '');
  return new RegExp(`^${globSource(g)}${g.endsWith('/') ? '.*' : ''}$`);
}

// project.json tests.paths, when set, replaces the default layouts with the owner's globs.
function testMatcher(project) {
  const t = project.tests;
  const defaults = { match: isTestFile, source: 'the default test layouts' };
  if (t == null) return defaults;
  const paths = typeof t === 'object' && !Array.isArray(t) ? t.paths : [];
  if (paths == null) return defaults;
  if (!Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === 'string' && p.trim())) {
    return { error: 'project.json tests.paths must be a non-empty array of globs; set it with tower-crane project set --tests-paths \'["src/test/**","**/*Test.java"]\', or use --tests-paths null to restore the default test layouts' };
  }
  const res = paths.map(globToRegExp);
  return { match: (p) => res.some((re) => re.test(p)), source: 'project.json tests.paths' };
}

// The default keep set is package metadata and lockfiles that describe the build.
// Executable build files such as Makefiles and Gradle scripts need an explicit tests.keep glob.
const DEFAULT_BUILD_FILES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', 'bun.lock', 'bun.lockb', 'cargo.toml', 'cargo.lock',
  'go.mod', 'go.sum', 'go.work', 'go.work.sum', 'pyproject.toml', 'setup.cfg',
  'pipfile', 'pipfile.lock', 'poetry.lock', 'pdm.lock', 'uv.lock', 'pylock.toml',
  'pom.xml', 'gradle.lockfile', 'composer.json', 'composer.lock', 'gemfile.lock',
  'podfile.lock', 'pubspec.yaml', 'pubspec.lock', 'mix.lock', 'package.resolved',
  'nuget.config', 'packages.config', 'packages.lock.json', 'deno.json', 'deno.jsonc',
  'deno.lock', 'environment.yml', 'environment.yaml', 'pixi.toml', 'pixi.lock',
  'cmakepresets.json', 'cmakeuserpresets.json', 'jsconfig.json',
]);

function isDefaultBuildFile(p) {
  const name = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  return DEFAULT_BUILD_FILES.has(name)
    || /^requirements.*\.txt$/.test(name)
    || /^tsconfig.*\.json$/.test(name);
}

function keepMatcher(project) {
  const t = project.tests;
  const keep = t && typeof t === 'object' && !Array.isArray(t) ? t.keep : null;
  if (keep == null) return { match: isDefaultBuildFile, source: 'default manifests and lockfiles' };
  if (!Array.isArray(keep) || !keep.every((p) => typeof p === 'string' && p.trim())) {
    return {
      error: 'project.json tests.keep must be an array of globs; set it with tower-crane project set --tests-keep \'["Makefile","**/*.gradle"]\', or use --tests-keep null to clear the override',
    };
  }
  const res = keep.map(globToRegExp);
  return {
    match: (p) => isDefaultBuildFile(p) || res.some((re) => re.test(p)),
    source: 'default manifests and lockfiles plus project.json tests.keep',
  };
}

// Files the commit changed against the merge base, as {status, path}. Renames show up as a
// delete plus an add, so each side is reverted on its own terms.
async function changedFiles(ctx, root, from, to) {
  const r = await git(ctx, root, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', from, to]);
  if (!r.ok) return null;
  const parts = r.stdout.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i][0], path: parts[i + 1] });
  return files;
}

function cmdLine(cmd) {
  return `\`${cmd}\``;
}

function boundedOutputTail(text) {
  let outputTail = tailLines(text, TAIL);
  if (outputTail.length > OUTPUT_TAIL_CHARS) {
    const marker = '[earlier output omitted]';
    const content = tailLines(outputTail.slice(-(OUTPUT_TAIL_CHARS - marker.length - 1)), TAIL - 1);
    outputTail = `${marker}\n${content}`;
  }
  return outputTail;
}

function testFailure(r, redact) {
  const out = r.output != null ? r.output : [r.stdout, r.stderr].filter(Boolean).join('\n');
  const names = [];
  const seen = new Set();
  for (const line of out.split(/\r?\n/)) {
    const spec = /^\s*✖\s+(.+?)\s*$/.exec(line);
    const tap = /^\s*not ok(?:\s+\d+)?(?:\s+-\s*|\s+)(.+?)\s*$/.exec(line);
    let name = spec?.[1];
    if (name && /^(?:failing tests\b|test at\b)/i.test(name)) name = null;
    name ||= tap?.[1];
    if (name) {
      const safeName = redact(name);
      if (!seen.has(safeName)) {
        names.push(safeName);
        seen.add(safeName);
      }
    }
  }
  return { names, output_tail: boundedOutputTail(redact(boundedOutputTail(out))) };
}

function failedRun(cmd, r, where, redact) {
  const failure = testFailure(r, redact);
  const names = failure.names.length
    ? `Failing tests:\n${failure.names.map((name) => `- ${name}`).join('\n')}`
    : 'Failing tests: none identified';
  const output = failure.output_tail || '(empty output)';
  return {
    test_failure: failure,
    summary: `${cmdLine(redact(cmd))} ${redact(where)}: ${redact(how(r))}.\n${names}\nOutput tail (last ${TAIL} lines, max ${OUTPUT_TAIL_CHARS} characters):\n${output}`,
  };
}

function safeResult(result, redact) {
  if (!result || typeof result !== 'object') return result;
  const safe = { ...result };
  if (typeof safe.summary === 'string') safe.summary = redact(safe.summary);
  if (safe.test_failure) {
    safe.test_failure = {
      ...safe.test_failure,
      names: (safe.test_failure.names || []).map(redact),
      output_tail: boundedOutputTail(redact(safe.test_failure.output_tail || '')),
    };
  }
  return safe;
}

async function run(ctx) {
  const { root, task, project } = ctx;
  const redact = diagnosticRedactor(project, root);
  const args = ctx.args || {};
  const log = ctx.log || (() => {});
  const gateContext = { ...ctx, log: (message) => log(redact(message)) };
  const kind = task.kind || 'code';
  const policy = testsPolicy.resolve(project, kind);
  if (policy.error) return safeResult(fail(policy.error), redact);
  const selected = require('../gate-commands').select(project, 'tests', args, policy.mode);
  if (selected.error) return safeResult(fail(selected.error), redact);
  const cmd = selected.command;
  if (!task.sha) return safeResult(fail(`task ${task.id} has no submitted sha; submit it first with tower-crane submit ${task.id} --sha SHA`), redact);
  const minutes = args.timeout === undefined || args.timeout === null ? DEFAULT_TIMEOUT_MIN : Number(args.timeout);
  if (!(minutes > 0)) return safeResult(fail(`--timeout must be a positive number of minutes, got ${args.timeout}`), redact);
  const timeout = Math.round(minutes * 60 * 1000);
  const sha = task.sha;
  const res = (ok, summary, extra = {}) => safeResult({ ok, summary, sha, ...extra }, redact);
  const full = await resolveCommit(ctx, root, sha);
  if (!full) return res(false, `commit ${sha} is not in ${root}; fetch it (git fetch origin ${task.branch || '<branch>'}) and run the gate again`);
  if (policy.mode === 'none') {
    return res(true, `Tests gate mode none (${policy.source}); verified submitted commit ${short(full)}. No test command ran.`);
  }
  if (policy.mode === 'run-only') {
    const out = await withWorktree(gateContext, root, full, async (dir) => {
      log(redact(`check tests: running ${cmd} at ${short(full)} (mode run-only)`));
      const head = await shell(ctx, cmd, { cwd: dir, timeout, keep: KEEP_CHARS });
      if (!head.ok) {
        const failure = failedRun(cmd, head, `at ${short(full)}`, redact);
        return res(false, `${failure.summary}\nMake the tests pass at the submitted commit, then submit the new sha.`, {
          test_failure: failure.test_failure,
        });
      }
      return res(true, `${cmdLine(cmd)} at ${short(full)}: exit 0\nTests gate mode run-only (${policy.source}); no revert run.`);
    });
    return safeResult({ ...out, sha }, redact);
  }
  if (!project.base) return safeResult(fail('project.json has no base branch; set "base" (for example "main")'), redact);
  const matcher = testMatcher(project);
  if (matcher.error) return safeResult(fail(matcher.error), redact);
  const isTest = matcher.match;
  const keeper = keepMatcher(project);
  if (keeper.error) return safeResult(fail(keeper.error), redact);
  const keepBuildFile = keeper.match;
  const mb = await mergeBase(ctx, root, project.base, full);
  if (!mb) return res(false, `no merge base between ${project.base} and ${short(full)}; fetch ${project.base} (git fetch origin ${project.base}) and run the gate again`);
  const changed = await changedFiles(ctx, root, mb.sha, full);
  if (!changed) return res(false, `could not list the files ${short(full)} changed against ${mb.ref}; check the repository at ${root}`);

  // A deleted test guards nothing, so only added or changed tests count as the task's tests.
  const tests = changed.filter((f) => isTest(f.path) && f.status !== 'D');
  const nonTest = changed.filter((f) => !isTest(f.path));
  const buildFiles = nonTest.filter((f) => keepBuildFile(f.path));
  const against = `${mb.ref} (merge base ${short(mb.sha)})`;

  if (kind === 'code' && changed.length === 0) {
    return res(false, `${short(full)} has no changes against ${against}; submit the commit that holds the change`);
  }
  if (kind === 'code' && tests.length === 0) {
    return res(false, `no test covers this change: ${short(full)} changes ${listSome(changed.map((f) => f.path))} against ${against} and adds or changes no test file (by ${matcher.source}). Add a test that fails without the change, commit it, and submit the new sha. If the project keeps its tests elsewhere, set their globs with tower-crane project set --tests-paths '["src/test/**","**/*Test.java"]'.`);
  }

  const revert = nonTest.filter((f) => !keepBuildFile(f.path));
  const scoped = policy.expensive && tests.length > 0 && revert.length > 0;
  const proofTemplate = selected.policy.tests_proof_cmd || '';
  if (scoped && !proofTemplate.includes('{tests}')) {
    return res(false, 'tests.expensive in prove mode requires pinned gates.tests_proof_cmd containing {tests}; the owner sets it with project set --tests-proof-cmd CMD');
  }
  const proofCmd = scoped ? proofTemplate.replaceAll('{tests}', tests.map((f) => shellQuote(f.path)).join(' ')) : cmd;
  const out = await withWorktree(gateContext, root, full, async (dir) => {
    const steps = [];
    log(redact(`check tests: running ${cmd} at ${short(full)}`));
    const head = await shell(ctx, cmd, { cwd: dir, timeout, keep: KEEP_CHARS });
    if (!head.ok) {
      const failure = failedRun(cmd, head, `at ${short(full)}`, redact);
      return res(false, `${failure.summary}\nMake the tests pass at the submitted commit, then submit the new sha.`, {
        test_failure: failure.test_failure,
      });
    }
    steps.push(`1. ${cmdLine(cmd)} at ${short(full)}: exit 0`);

    if (tests.length === 0) {
      return res(true, `${steps[0]}\nTask kind ${kind} changes no test file, so there is nothing to run without the change.`);
    }
    const testList = `Tests: ${listSome(tests.map((f) => f.path))}`;
    if (nonTest.length === 0) {
      return res(true, `${steps[0]}\n${testList}\nThe task changes only test files; there is no other change for them to guard.`);
    }

    const kept = buildFiles.length
      ? `Build files kept at submitted sha ${short(full)}: ${buildFiles.map((f) => f.path).join(', ')}`
      : '';
    if (revert.length === 0) {
      return res(true, `${steps[0]}\n${testList}\n${kept}\nThe task changes only tests and kept build files; there are no non-test files to revert.`);
    }
    if (scoped) {
      log(redact(`check tests: scoped proof ${proofCmd} at ${short(full)}`));
      const proofHead = await shell(ctx, proofCmd, { cwd: dir, timeout, keep: KEEP_CHARS });
      if (!proofHead.ok) {
        const failure = failedRun(proofCmd, proofHead, `scoped proof at ${short(full)}`, redact);
        return res(false, failure.summary, { test_failure: failure.test_failure });
      }
      steps.push(`Scoped proof at ${short(full)}: ${cmdLine(proofCmd)}: exit 0`);
    }
    const restore = revert.filter((f) => f.status !== 'A').map((f) => f.path);
    const remove = revert.filter((f) => f.status === 'A').map((f) => f.path);
    if (restore.length) {
      const r = await git(ctx, dir, ['--literal-pathspecs', 'checkout', mb.sha, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: restore.join('\0') });
      if (!r.ok) return res(false, `could not restore ${listSome(restore)} to ${short(mb.sha)}: ${errText(r)}`);
    }
    if (remove.length) {
      const r = await git(ctx, dir, ['--literal-pathspecs', 'rm', '-q', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: remove.join('\0') });
      if (!r.ok) return res(false, `could not remove ${listSome(remove)} added by the task: ${errText(r)}`);
    }
    const revertedPaths = ` (${listSome(revert.map((f) => f.path))})`;
    const reverted = `${revert.length} non-test file${revert.length === 1 ? '' : 's'} reverted to ${short(mb.sha)}${revertedPaths}`;
    const revertSummary = [reverted, kept].filter(Boolean).join('; ');
    log(redact(`check tests: running ${proofCmd} with ${revertSummary}`));
    const without = await shell(ctx, proofCmd, { cwd: dir, timeout, keep: KEEP_CHARS });
    if (without.ok) {
      steps.push(`2. ${cmdLine(proofCmd)} with ${revertSummary}: exit 0`);
      return res(false, `tests pass without the change; they do not prove it.\n${steps.join('\n')}\n${testList}\nWrite a test that fails when the change is reverted, commit it, and submit the new sha.`);
    }
    // A suite that hangs without the change does not pass without it; the timeout is reported.
    steps.push(`2. ${cmdLine(proofCmd)} with ${revertSummary}: ${how(without)}`);
    return res(true, `${steps.join('\n')}\n${testList}\nThe tests pass with the change and fail without it, against ${against}.${scoped ? ' tests.expensive ran the full suite once and kept a scoped proof.' : ''}`);
  });
  return safeResult({ ...out, sha, ...(scoped ? { receipt: { proof_tests: tests.map((f) => f.path) } } : {}) }, redact);
}

module.exports = { run, isTestFile, testMatcher, globToRegExp };
