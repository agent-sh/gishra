'use strict';
// Gate `check tests ID --cmd CMD`: the task's tests pass at its submitted commit and fail once
// its change to non-test files is taken back out. A test that passes either way proves nothing.
const { fail, short, tailLines, how, errText, git, shell, resolveCommit, mergeBase, withWorktree, listSome } = require('./common');

const DEFAULT_TIMEOUT_MIN = 20;
const TAIL = 40;
// Only the tail of the output is reported; this bounds what a verbose suite keeps in memory.
const KEEP_CHARS = 1 << 20;

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

const BUILD_CONFIG_NAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', 'bun.lock', 'bun.lockb', '.npmrc', '.yarnrc', '.yarnrc.yml',
  'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'go.work', 'go.work.sum',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini', 'pipfile',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'gradle.properties', 'gradle.lockfile', 'gradle-wrapper.properties', 'gradlew',
  'gradlew.bat', 'mvnw', 'mvnw.cmd', 'composer.json', 'gemfile',
  'package.swift', 'package.resolved', 'pubspec.yaml', 'mix.exs', 'rebar.config',
  'global.json', 'nuget.config', 'packages.config', 'packages.lock.json',
  'directory.build.props', 'directory.build.targets', 'deno.json', 'deno.jsonc',
  'deno.lock', 'import_map.json', 'makefile', 'gnumakefile', 'cmakelists.txt',
  'cmakepresets.json', 'cmakeuserpresets.json', 'meson.build', 'meson_options.txt',
  'build.ninja', 'build.bazel', 'build.zig', 'build.zig.zon', 'workspace',
  'workspace.bazel', 'module.bazel', '.bazelrc', 'bazeliskrc', 'dockerfile',
  'containerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml',
  'compose.yaml', 'flake.nix', 'shell.nix', 'justfile', 'taskfile.yml',
  'taskfile.yaml', 'environment.yml', 'environment.yaml', 'pixi.toml',
  'project.pbxproj', 'podfile', 'podfile.lock', 'build.sbt', 'plugins.sbt',
  'rakefile', 'jsconfig.json', 'angular.json',
]);

const BUILD_CONFIG_SUFFIXES = [
  '.csproj', '.fsproj', '.vbproj', '.sln', '.slnx', '.gemspec', '.cmake', '.mk',
  '.mak', '.gradle', '.gradle.kts', '.bzl', '.props', '.targets', '.sbt',
];

function isBuildFile(p) {
  const name = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  return BUILD_CONFIG_NAMES.has(name)
    || /^requirements.*\.txt$/.test(name)
    || name.endsWith('.lock')
    || name.endsWith('.lockb')
    || /^dockerfile(?:\..*)?$/.test(name)
    || /^containerfile(?:\..*)?$/.test(name)
    || BUILD_CONFIG_SUFFIXES.some((suffix) => name.endsWith(suffix))
    || /^tsconfig.*\.json$/.test(name)
    || /^(?:vite|webpack|rollup|babel|esbuild)\.config\./.test(name);
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

function failedRun(cmd, r, where) {
  const out = r.output != null ? r.output : [r.stdout, r.stderr].filter(Boolean).join('\n');
  return `${cmdLine(cmd)} ${where}: ${how(r)}. Last ${TAIL} lines:\n${tailLines(out, TAIL)}`;
}

async function run(ctx) {
  const { root, task, project } = ctx;
  const args = ctx.args || {};
  const log = ctx.log || (() => {});
  const cmd = typeof args.cmd === 'string' ? args.cmd.trim() : '';
  if (!cmd) return fail('no test command given; pass --cmd CMD, for example --cmd "npm ci && npm test"');
  if (!task.sha) return fail(`task ${task.id} has no submitted sha; submit it first with tower-crane submit ${task.id} --sha SHA`);
  if (!project.base) return fail('project.json has no base branch; set "base" (for example "main")');
  const minutes = args.timeout === undefined || args.timeout === null ? DEFAULT_TIMEOUT_MIN : Number(args.timeout);
  if (!(minutes > 0)) return fail(`--timeout must be a positive number of minutes, got ${args.timeout}`);
  const timeout = Math.round(minutes * 60 * 1000);
  const kind = task.kind || 'code';
  const sha = task.sha;
  const matcher = testMatcher(project);
  if (matcher.error) return fail(matcher.error);
  const isTest = matcher.match;
  const res = (ok, summary) => ({ ok, summary, sha });

  const full = await resolveCommit(ctx, root, sha);
  if (!full) return res(false, `commit ${sha} is not in ${root}; fetch it (git fetch origin ${task.branch || '<branch>'}) and run the gate again`);
  const mb = await mergeBase(ctx, root, project.base, full);
  if (!mb) return res(false, `no merge base between ${project.base} and ${short(full)}; fetch ${project.base} (git fetch origin ${project.base}) and run the gate again`);
  const changed = await changedFiles(ctx, root, mb.sha, full);
  if (!changed) return res(false, `could not list the files ${short(full)} changed against ${mb.ref}; check the repository at ${root}`);

  // A deleted test guards nothing, so only added or changed tests count as the task's tests.
  const tests = changed.filter((f) => isTest(f.path) && f.status !== 'D');
  const nonTest = changed.filter((f) => !isTest(f.path));
  const buildFiles = changed.filter((f) => isBuildFile(f.path));
  const against = `${mb.ref} (merge base ${short(mb.sha)})`;

  if (kind === 'code' && changed.length === 0) {
    return res(false, `${short(full)} has no changes against ${against}; submit the commit that holds the change`);
  }
  if (kind === 'code' && tests.length === 0) {
    return res(false, `no test covers this change: ${short(full)} changes ${listSome(changed.map((f) => f.path))} against ${against} and adds or changes no test file (by ${matcher.source}). Add a test that fails without the change, commit it, and submit the new sha. If the project keeps its tests elsewhere, set their globs with tower-crane project set --tests-paths '["src/test/**","**/*Test.java"]'.`);
  }

  const out = await withWorktree(ctx, root, full, async (dir) => {
    const steps = [];
    log(`check tests: running ${cmd} at ${short(full)}`);
    const head = await shell(ctx, cmd, { cwd: dir, timeout, keep: KEEP_CHARS });
    if (!head.ok) {
      return res(false, `${failedRun(cmd, head, `at ${short(full)}`)}\nMake the tests pass at the submitted commit, then submit the new sha.`);
    }
    steps.push(`1. ${cmdLine(cmd)} at ${short(full)}: exit 0`);

    if (tests.length === 0) {
      return res(true, `${steps[0]}\nTask kind ${kind} changes no test file, so there is nothing to run without the change.`);
    }
    const testList = `Tests: ${listSome(tests.map((f) => f.path))}`;
    if (nonTest.length === 0) {
      return res(true, `${steps[0]}\n${testList}\nThe task changes only test files; there is no other change for them to guard.`);
    }

    const revert = nonTest.filter((f) => !isBuildFile(f.path));
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
    const revertedCount = restore.length + remove.length;
    const revertedPaths = revertedCount ? ` (${listSome(revert.map((f) => f.path))})` : '';
    const reverted = `${revertedCount} non-test file${revertedCount === 1 ? '' : 's'} reverted to ${short(mb.sha)}${revertedPaths}`;
    const kept = buildFiles.length
      ? `Build files kept at submitted sha ${short(full)}: ${buildFiles.map((f) => f.path).join(', ')}`
      : '';
    const revertSummary = [reverted, kept].filter(Boolean).join('; ');
    log(`check tests: running ${cmd} with ${revertSummary}`);
    const without = await shell(ctx, cmd, { cwd: dir, timeout, keep: KEEP_CHARS });
    if (without.ok) {
      steps.push(`2. ${cmdLine(cmd)} with ${revertSummary}: exit 0`);
      return res(false, `tests pass without the change; they do not prove it.\n${steps.join('\n')}\n${testList}\nWrite a test that fails when the change is reverted, commit it, and submit the new sha.`);
    }
    // A suite that hangs without the change does not pass without it; the timeout is reported.
    steps.push(`2. ${cmdLine(cmd)} with ${revertSummary}: ${how(without)}`);
    return res(true, `${steps.join('\n')}\n${testList}\nThe tests pass with the change and fail without it, against ${against}.`);
  });
  return { ...out, sha };
}

module.exports = { run, isTestFile, testMatcher };
