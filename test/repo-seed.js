'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

function createRepoSeed(tmpRoot = process.env.TOWER_CRANE_TEST_TMP || os.tmpdir()) {
  fs.mkdirSync(tmpRoot, { recursive: true });
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpRoot, 'tower-crane-seed-')));
  const gitconfig = path.join(base, 'gitconfig');
  fs.writeFileSync(
    gitconfig,
    '[user]\n\tname = tower-crane test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n',
  );
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('TOWER_CRANE_') || key.startsWith('GIT_')) delete env[key];
  }
  env.GIT_CONFIG_GLOBAL = gitconfig;
  env.GIT_CONFIG_NOSYSTEM = '1';

  const repo = path.join(base, 'repo');
  try {
    fs.mkdirSync(repo);
    const git = (args) => cp.execFileSync('git', args, { cwd: repo, env, stdio: 'ignore' });
    git(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);
    return { base, repo };
  } catch (error) {
    cleanupRepoSeed({ base });
    throw error;
  }
}

function cleanupRepoSeed(seed) {
  fs.rmSync(seed.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

module.exports = { createRepoSeed, cleanupRepoSeed };
