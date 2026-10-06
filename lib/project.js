'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { refuse, usage } = require('./util');
const S = require('./state');

const DEFAULT_ROLES = {
  orchestrator: { harness: 'claude', model: 'claude-opus-5-5' },
  worker: { harness: 'codex', profile: 'sol' },
  reviewer: { harness: 'claude', model: 'claude-opus-5-5' },
  small: { harness: 'codex', profile: 'luna' },
};

function githubSlug(url) {
  const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url || '');
  return m ? m[1] : null;
}

function checkRepoSlug(v) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(v)) throw usage(`--repo must look like owner/repo, got "${v}"`);
}

function resolveStandards(value, cwd, repo) {
  if (value === 'default') return 'default';
  const abs = path.resolve(cwd, value);
  try {
    fs.readFileSync(abs, 'utf8');
  } catch {
    throw refuse(`standards file ${abs} cannot be read; pass "default" or a readable Markdown file`);
  }
  if (repo) {
    const rel = path.relative(repo.root, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return abs;
}

// Flags shared by init and project set.
function applySettings(project, f, cwd, repo) {
  if (f.name !== undefined) {
    if (!f.name.trim()) throw usage('--name cannot be empty');
    project.name = f.name;
  }
  if (f.goal !== undefined) {
    if (!f.goal.trim()) throw usage('--goal cannot be empty');
    project.goal = f.goal;
  }
  if (f.repo !== undefined) {
    checkRepoSlug(f.repo);
    project.repo = f.repo;
  }
  if (f.base !== undefined) {
    if (!f.base.trim()) throw usage('--base cannot be empty');
    project.base = f.base;
  }
  if (f.workers !== undefined) {
    if (f.workers < 1) throw usage('--workers must be at least 1');
    project.limits.workers = f.workers;
  }
  if (f['lease-minutes'] !== undefined) {
    if (f['lease-minutes'] < 1) throw usage('--lease-minutes must be at least 1');
    project.limits.lease_minutes = f['lease-minutes'];
  }
  if (f['budget-hours'] !== undefined) {
    if (f['budget-hours'] < 0) throw usage('--budget-hours cannot be negative');
    project.budget.hours = f['budget-hours'];
  }
  if (f['budget-tokens'] !== undefined) {
    if (f['budget-tokens'] < 0) throw usage('--budget-tokens cannot be negative');
    project.budget.tokens = f['budget-tokens'];
  }
  if (f.standards !== undefined) project.standards = resolveStandards(f.standards, cwd, repo);
}

function addExclude(repo, stateDir) {
  const rel = path.relative(repo.root, stateDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
  const line = rel === '.gishra' ? '.gishra/' : `/${rel.split(path.sep).join('/')}/`;
  const file = path.join(repo.commonDir, 'info', 'exclude');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  if (text.split(/\r?\n/).includes(line)) return;
  fs.appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + line + '\n');
}

function summary(p) {
  const roles = Object.entries(p.roles)
    .map(([n, r]) => {
      const parts = [r.harness];
      for (const k of ['model', 'profile', 'provider', 'effort']) if (r[k]) parts.push(`${k} ${r[k]}`);
      if (r.command) parts.push(JSON.stringify(r.command));
      if (r.args && r.args.length) parts.push(`args ${JSON.stringify(r.args)}`);
      return `  ${n}: ${parts.join(' ')}`;
    })
    .join('\n');
  const budget = [p.budget.hours != null ? `${p.budget.hours} h` : null, p.budget.tokens != null ? `${p.budget.tokens} tokens` : null].filter(Boolean).join(', ') || 'none';
  return [
    `${p.name}: ${p.goal}`,
    `repo: ${p.repo || '-'}  base: ${p.base}  standards: ${p.standards}`,
    `limits: ${p.limits.workers} workers, ${p.limits.lease_minutes} min lease  budget: ${budget}`,
    'roles:',
    roles,
  ].join('\n');
}

function init(ctx) {
  const f = ctx.flags;
  const dir = ctx.stateDir;
  const repo = S.findRepo(dir, ctx.cwd);
  fs.mkdirSync(path.join(dir, 'briefs'), { recursive: true });
  const lock = S.acquireLock(dir);
  let project;
  try {
    if (fs.existsSync(path.join(dir, 'project.json'))) {
      throw refuse(`gishra state already exists at ${dir}; change it with gishra project set`);
    }
    let base = 'main';
    let slug = null;
    if (repo) {
      const head = S.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repo.root);
      if (head) base = head;
      slug = githubSlug(S.git(['remote', 'get-url', 'origin'], repo.root));
    }
    project = {
      version: 1,
      name: '',
      goal: '',
      repo: slug,
      base,
      standards: 'default',
      roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
      limits: { workers: 6, lease_minutes: 60 },
      budget: { hours: null, tokens: null },
    };
    applySettings(project, f, ctx.cwd, repo);
    const errs = S.validateProject(project);
    if (errs.length) throw usage(errs.join('; '));
    const tasks = { version: 1, next: 1, tasks: [] };
    const decisions = { version: 1, next: 1, decisions: [] };
    S.writeAtomic(path.join(dir, 'tasks.json'), S.json(tasks));
    S.writeAtomic(path.join(dir, 'decisions.json'), S.json(decisions));
    // project.json last: its presence is what marks the state as initialized.
    S.writeAtomic(path.join(dir, 'project.json'), S.json(project));
    S.appendEvents(dir, [{ at: new Date().toISOString(), agent: ctx.agent, cmd: 'init', task: null, detail: { name: project.name } }]);
    if (repo) addExclude(repo, dir);
    S.renderSafely({ dir, project, tasks, decisions });
  } finally {
    S.releaseLock(lock);
  }
  return { data: { state: dir, project }, text: `initialized ${dir}\n${summary(project)}` };
}

function parseArgv(flag, text, allowEmpty) {
  let list;
  try {
    list = JSON.parse(text);
  } catch (e) {
    throw usage(`${flag} must be a JSON array of strings (${e.message})`);
  }
  if (!Array.isArray(list) || (!allowEmpty && !list.length) || !list.every((a) => typeof a === 'string' && (allowEmpty || a !== ''))) {
    throw usage(`${flag} must be a ${allowEmpty ? '' : 'non-empty '}JSON array of strings`);
  }
  return list;
}

function roleSet(ctx) {
  const [name] = ctx.pos;
  const f = ctx.flags;
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw usage(`role names are lowercase words like worker or reviewer, got "${name}"`);
  if (!S.HARNESSES.includes(f.harness)) throw usage(`--harness must be one of ${S.HARNESSES.join(', ')}`);
  const role = { harness: f.harness };
  if (f.model !== undefined) role.model = f.model;
  if (f.profile !== undefined) {
    if (f.harness !== 'codex') throw usage('only codex roles take --profile; use --model for other harnesses');
    role.profile = f.profile;
  }
  if (f.provider !== undefined) {
    if (f.harness !== 'pi') throw usage('only pi roles take --provider; other harnesses name the provider in --model');
    role.provider = f.provider;
  }
  if (f.effort !== undefined) role.effort = f.effort;
  if (f.args !== undefined) role.args = parseArgv('--args', f.args, true);
  if (f.harness === 'command') {
    if (f.command === undefined) throw usage('a command role needs --command \'["prog", "arg", "{prompt}"]\'');
    role.command = parseArgv('--command', f.command, false);
  } else if (f.command !== undefined) {
    throw usage('--command applies only to --harness command');
  }
  const project = S.mutate(ctx, 'role set', (st, emit) => {
    st.project.roles[name] = role;
    emit(null, { role: name, ...role });
    return st.project;
  });
  return { data: { role: name, ...role }, text: `role ${name}: ${JSON.stringify(project.roles[name])}` };
}

function projectSet(ctx) {
  const keys = Object.keys(ctx.flags);
  if (!keys.length) throw usage('project set needs at least one setting; see gishra project set --help');
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  const project = S.mutate(ctx, 'project set', (st, emit) => {
    applySettings(st.project, ctx.flags, ctx.cwd, repo);
    emit(null, ctx.flags);
    return st.project;
  });
  return { data: project, text: summary(project) };
}

function projectShow(ctx) {
  const st = S.loadState(ctx.stateDir);
  return { data: st.project, text: summary(st.project) };
}

module.exports = { init, roleSet, projectSet, projectShow, DEFAULT_ROLES };
