'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { refuse, usage, conflict } = require('./util');
const S = require('./state');
const L = require('./ladder');
const testsPolicy = require('./tests-policy');
const SpawnSettings = require('./spawn-settings');

function guardSpawnSettings(ctx) {
  if (SpawnSettings.FIELDS.some((k) => ctx.flags[k] !== undefined) && (ctx.agent !== 'owner' || !ctx.agentExplicit)) {
    throw refuse('only the owner with an explicit identity can change sandbox, env, env_file or scope; an agent requests this with tower-crane ask');
  }
}

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

function applyListSetting(project, f, flag, section, key, allowEmpty) {
  if (f[flag] === undefined) return;
  const message = `--${flag} must be a ${allowEmpty ? '' : 'non-empty '}JSON array of non-blank strings or null`;
  let list;
  try {
    list = JSON.parse(f[flag]);
  } catch {
    throw usage(message);
  }
  const current = project[section];
  const settings = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  if (list === null) {
    delete settings[key];
    if (Object.keys(settings).length) project[section] = settings;
    else delete project[section];
    return;
  }
  if (!Array.isArray(list) || (!allowEmpty && !list.length) || !list.every((s) => typeof s === 'string' && s.trim())) {
    throw usage(message);
  }
  project[section] = { ...settings, [key]: list.map((s) => s.trim()) };
}

function applyTestsPolicy(project, f) {
  for (const [flag, key] of [['tests-mode', 'mode'], ['tests-by-kind', 'by_kind'], ['tests-expensive', 'expensive']]) {
    if (f[flag] === undefined) continue;
    let value = f[flag] === 'null' ? null : f[flag];
    if (key !== 'mode') {
      try {
        value = JSON.parse(f[flag]);
      } catch {
        throw usage(`--${flag} ${testsPolicy.settingError(key, 'invalid')}`);
      }
    }
    const error = testsPolicy.settingError(key, value);
    if (error) throw usage(`--${flag} ${error}`);
    const current = project.tests;
    const settings = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
    if (value === null) delete settings[key];
    else settings[key] = value;
    if (Object.keys(settings).length) project.tests = settings;
    else delete project.tests;
  }
}

function requireOwnerReviewPolicy(ctx, flags) {
  if (flags['review-policy'] !== undefined && (ctx.agent !== 'owner' || !ctx.agentExplicit)) {
    throw refuse('only the owner with an explicit identity can change review policy and prices; an agent requests this with tower-crane ask');
  }
}

function requireOwnerMergePolicy(ctx) {
  if (ctx.flags['merge-admin'] !== undefined && (ctx.agent !== 'owner' || !ctx.agentExplicit)) {
    throw refuse('only the owner with an explicit identity can change merge.admin; an agent requests this with tower-crane ask');
  }
}

// Flags shared by init and project set.
function applySettings(project, f, cwd, repo) {
  for (const k of SpawnSettings.FIELDS) {
    if (f[k] === undefined) continue;
    if (f[k] === 'null') delete project[k];
    else {
      let value = f[k];
      if (k !== 'env_file') {
        try { value = JSON.parse(value); } catch { throw usage(`--${k} must be a JSON object or null`); }
      }
      const errs = SpawnSettings.errors({ [k]: value });
      if (errs.length) throw usage(errs.join('; '));
      project[k] = value;
    }
  }
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
  if (f['review-policy'] !== undefined) {
    let config;
    try { config = JSON.parse(f['review-policy']); } catch { throw usage('--review-policy must be a JSON object or null'); }
    if (config === null) delete project.review;
    else {
      const errs = require('./reviewer').errors(config);
      if (errs.length) throw usage(errs.join('; '));
      project.review = require('./reviewer').canonicalPolicy(config);
    }
  }
  applyListSetting(project, f, 'tests-paths', 'tests', 'paths', false);
  applyListSetting(project, f, 'tests-keep', 'tests', 'keep', true);
  applyTestsPolicy(project, f);
  applyListSetting(project, f, 'ci-ignore-apps', 'ci', 'ignore_apps', true);
  for (const [flag, key] of [['merge-keep-branch', 'keep_branch'], ['merge-admin', 'admin']]) {
    if (f[flag] === undefined) continue;
    let value;
    try { value = JSON.parse(f[flag]); } catch { throw usage(`--${flag} must be true, false or null`); }
    if (value !== null && typeof value !== 'boolean') throw usage(`--${flag} must be true, false or null`);
    const settings = { ...project.merge };
    if (value === null) delete settings[key];
    else settings[key] = value;
    if (Object.keys(settings).length) project.merge = settings;
    else delete project.merge;
  }
  if (f['ci-local'] !== undefined) {
    let local;
    try {
      local = JSON.parse(f['ci-local']);
    } catch {
      throw usage('--ci-local must be JSON {command: argv, timeout: seconds} or null');
    }
    if (local !== null && !require('./ci-local').valid(local)) {
      throw usage('--ci-local must have a nonempty command argv and a positive timeout in seconds (within Node timer range), or null');
    }
    const settings = project.ci && typeof project.ci === 'object' && !Array.isArray(project.ci) ? { ...project.ci } : {};
    if (local === null) delete settings.local;
    else settings.local = local;
    if (Object.keys(settings).length) project.ci = settings;
    else delete project.ci;
  }
}

function addExclude(repo, stateDir) {
  const rel = path.relative(repo.root, stateDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
  const line = rel === '.tower-crane' ? '.tower-crane/' : `/${rel.split(path.sep).join('/')}/`;
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

function ladderLines(layers) {
  const rows = L.RUNGS.map((n) => {
    const e = layers.ladder[n];
    return [n, e.harness_from === 'default' ? `${e.harness} (default)` : e.harness, L.describe(L.rungOf(layers, n)), L.SOURCE[e.from]];
  });
  const w = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => `  ${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2].padEnd(w[2])}  from ${r[3]}`.replace(/\s+$/, ''));
}

function summary(p, env) {
  const budget = [p.budget.hours != null ? `${p.budget.hours} h` : null, p.budget.tokens != null ? `${p.budget.tokens} tokens` : null].filter(Boolean).join(', ') || 'none';
  const head = [
    `${p.name}: ${p.goal}`,
    `repo: ${p.repo || '-'}  base: ${p.base}  standards: ${p.standards}`,
    `limits: ${p.limits.workers} workers, ${p.limits.lease_minutes} min lease  budget: ${budget}`,
    `tests.paths: ${p.tests?.paths == null ? 'default layouts' : JSON.stringify(p.tests.paths)}`,
    `tests.keep: ${JSON.stringify(p.tests?.keep ?? [])}`,
    `tests.mode: ${p.tests?.mode ?? 'prove'}`,
    `tests.by_kind: ${JSON.stringify(p.tests?.by_kind ?? {})}`,
    `tests.expensive: ${p.tests?.expensive ?? false}`,
    `ci.ignore_apps: ${JSON.stringify(p.ci?.ignore_apps ?? [])}`,
    `ci.local: ${p.ci?.local == null ? 'hosted' : JSON.stringify(p.ci.local)}`,
    `merge.keep_branch: ${p.merge?.keep_branch ?? false}`,
    `merge.admin: ${p.merge?.admin ?? false}`,
    `review: ${p.review == null ? 'tier and diff defaults' : JSON.stringify(p.review)}`,
    ...SpawnSettings.FIELDS.filter((k) => p[k] !== undefined).map((k) => `${k}: ${JSON.stringify(p[k])}`),
  ];
  // A broken user file must not hide a project set that already succeeded.
  let layers;
  try {
    layers = L.resolve(p, env);
  } catch (e) {
    return [...head, `ladder: ${e.message}`].join('\n');
  }
  return [...head, `ladder (default harness ${layers.harness}):`, ...ladderLines(layers)].join('\n');
}

function guardTestsSettings(ctx) {
  const flags = ['tests-mode', 'tests-by-kind', 'tests-expensive', 'tests-paths', 'tests-keep'];
  if (flags.some((flag) => ctx.flags[flag] !== undefined) && (ctx.agent !== 'owner' || !ctx.agentExplicit)) {
    throw refuse('only the owner can change tests policy, paths or kept files; an agent requests this with tower-crane ask or a task note');
  }
}

function init(ctx) {
  guardSpawnSettings(ctx);
  guardTestsSettings(ctx);
  requireOwnerMergePolicy(ctx);
  const f = ctx.flags;
  const dir = ctx.stateDir;
  requireOwnerReviewPolicy(ctx, f);
  const repo = S.findRepo(dir, ctx.cwd);
  // The defaults are checked where they come from, so a bad user file is
  // named as such instead of as this project's ladder.
  const defaults = L.resolve({}, ctx.env);
  const bad = L.check({}, ctx.env);
  if (bad.length) throw refuse(`the default ladder is invalid: ${bad.join('; ')}`);
  fs.mkdirSync(path.join(dir, 'briefs'), { recursive: true });
  const lock = S.acquireLock(dir);
  let project;
  try {
    if (fs.existsSync(path.join(dir, 'project.json'))) {
      throw refuse(`Tower Crane state already exists at ${dir}; change it with tower-crane project set`);
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
      harness: defaults.harness,
      ladder: Object.fromEntries(L.RUNGS.map((n) => [n, defaults.ladder[n].own])),
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
  return { data: { state: dir, project }, text: `initialized ${dir}\n${summary(project, ctx.env)}` };
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

function checkRung(name) {
  if (!L.RUNGS.includes(name)) throw usage(`unknown rung "${name}"; the rungs are ${L.RUNGS.join(', ')}`);
}

// Turns field values into a rung change. ladder set and the serve Settings
// view both build their changes here, so they refuse the same values with the
// same words. Flags name fields as --model, the form as model.
function rungPatch(values, clear, flags) {
  const label = (k) => (flags ? `--${k}` : k);
  const set = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    if (!L.FIELDS.includes(k)) throw usage(`unknown rung field ${k}; a rung takes ${L.FIELDS.join(', ')}`);
    if (typeof v !== 'string') throw usage(`${label(k)} must be a string`);
    if (k === 'args') set.args = parseArgv(label(k), v, true);
    else if (k === 'command' || k === 'tools' || k === 'mcp') set[k] = parseArgv(label(k), v, false);
    else if (k === 'supervision') {
      try { set[k] = JSON.parse(v); } catch { throw usage(`${label(k)} must be a JSON object`); }
      const errs = L.supervisionErrors(set[k]);
      if (errs.length) throw usage(errs.join('; '));
    }
    else if (SpawnSettings.FIELDS.includes(k)) {
      if (k === 'env_file') set[k] = v;
      else {
        try { set[k] = JSON.parse(v); } catch { throw usage(`${label(k)} must be a JSON object`); }
      }
      const errs = SpawnSettings.errors({ [k]: set[k] });
      if (errs.length) throw usage(errs.join('; '));
    }
    else if (k === 'harness' && !L.HARNESSES.includes(v)) throw usage(`${label(k)} must be one of ${L.HARNESSES.join(', ')}, got "${v}"`);
    else if (!v.trim()) throw usage(`${label(k)} cannot be empty; clear the field instead`);
    else set[k] = v.trim();
  }
  for (const k of clear) {
    if (!L.FIELDS.includes(k)) throw usage(`--clear takes a rung field (${L.FIELDS.join(', ')}), got "${k}"`);
    if (k in set) throw usage(`${k} is both set and cleared`);
  }
  return { set, clear: [...new Set(clear)] };
}

// Refuses an edit made against a ladder that has since changed. The Settings
// page sends the default harness and the fields of each rung it edits as it
// loaded them; a CLI change in between would otherwise be overwritten by
// fields the person never touched.
function checkExpected(layers, expect) {
  const stale = [];
  if (expect.harness !== layers.harness) stale.push(`the default harness is now ${layers.harness}, not ${expect.harness}`);
  for (const [name, own] of Object.entries(expect.rungs || {})) {
    const now = layers.ladder[name].own;
    if (JSON.stringify(L.ordered(own)) !== JSON.stringify(now)) stale.push(`ladder ${name} is now ${L.describe(now) || 'empty'}${now.harness ? ` on ${now.harness}` : ''}`);
  }
  if (stale.length) throw conflict(`the ladder changed since this page loaded: ${stale.join('; ')}; reload the page and make the edit again`);
}

// The one write path for the ladder: ladder set, ladder harness and the
// serve Settings view. A change that leaves a rung unable to run, where it
// could run before, is refused whole, so project.json never holds half of an
// edit. Rungs already broken (by a user file that changed) do not block a
// change, so the ladder can always be repaired one rung at a time.
// changes.expect, when given, is what the edit was based on (checkExpected).
// Which program runs, with which extra arguments, tools and MCP servers,
// decides what an agent can do; only the owner changes that.
const GUARDED = ['args', 'command', 'tools', 'mcp', ...SpawnSettings.FIELDS];

function guardOf(p, env) {
  const layers = L.resolve(p, env);
  return JSON.stringify(L.RUNGS.map((n) => [layers.ladder[n].harness, ...GUARDED.map((k) => layers.ladder[n].own[k])]));
}

function updateLadder(ctx, changes, via) {
  if (changes.harness !== undefined && !L.HARNESSES.includes(changes.harness)) {
    throw usage(`the default harness must be one of ${L.HARNESSES.join(', ')}, got "${changes.harness}"`);
  }
  const rungs = Object.entries(changes.rungs || {});
  if (rungs.some(([, patch]) => [...Object.keys(patch.set), ...patch.clear].some((k) => SpawnSettings.FIELDS.includes(k)))
    && (ctx.agent !== 'owner' || !ctx.agentExplicit)) {
    throw refuse('only the owner with an explicit identity can change sandbox, env, env_file or scope; an agent requests this with tower-crane ask');
  }
  for (const [name] of rungs) checkRung(name);
  return S.mutate(ctx, 'ladder set', (st, emit) => {
    const p = st.project;
    if (changes.expect) checkExpected(L.resolve(p, ctx.env), changes.expect);
    const before = new Set(L.check(p, ctx.env));
    const guarded = guardOf(p, ctx.env);
    const extra = via ? { via } : {};
    if (changes.harness !== undefined) {
      p.harness = changes.harness;
      emit(null, { harness: p.harness, ...extra }, 'ladder harness');
    }
    for (const [name, patch] of rungs) {
      // A rung the project leaves out starts from the default it falls back to.
      const next = { ...L.resolve(p, ctx.env).ladder[name].own };
      for (const k of patch.clear) delete next[k];
      Object.assign(next, patch.set);
      const ladder = { ...(p.ladder || {}), [name]: L.ordered(next) };
      p.ladder = Object.fromEntries(L.RUNGS.filter((n) => ladder[n]).map((n) => [n, ladder[n]]));
      emit(null, { rung: name, ...p.ladder[name], ...extra });
    }
    if (guardOf(p, ctx.env) !== guarded && (ctx.agent !== 'owner' || !ctx.agentExplicit)) {
      throw refuse(`only the owner can change a rung's harness, ${GUARDED.join(', ')}; an agent requests this with tower-crane ask`);
    }
    const errs = L.check(p, ctx.env).filter((e) => !before.has(e));
    if (errs.length && changes.harness !== undefined && !rungs.length) {
      errs.push('fix those rungs first with tower-crane ladder set, or give them their own --harness');
    }
    if (errs.length) throw refuse(errs.join('; '));
    return L.resolve(p, ctx.env);
  });
}

function showData(layers) {
  const ladder = {};
  for (const n of L.RUNGS) {
    const e = layers.ladder[n];
    ladder[n] = { ...e.own, harness: e.harness, harness_from: e.harness_from, from: e.from };
  }
  return { harness: layers.harness, harness_from: layers.harness_from, user_file: layers.user_file, user_file_exists: fs.existsSync(layers.user_file), ladder };
}

function ladderShow(ctx) {
  const st = S.loadState(ctx.stateDir);
  const layers = L.resolve(st.project, ctx.env);
  const data = { ...showData(layers), problems: L.check(st.project, ctx.env) };
  const lines = [
    `default harness: ${data.harness}, from ${L.SOURCE[data.harness_from]}`,
    `user file: ${data.user_file}${data.user_file_exists ? '' : ' (none)'}`,
    ...ladderLines(layers),
    ...data.problems.map((e) => `cannot run: ${e}`),
  ];
  return { data, text: lines.join('\n') };
}

function ladderSet(ctx) {
  const [name] = ctx.pos;
  checkRung(name);
  const { clear = [], ...values } = ctx.flags;
  const patch = rungPatch(values, clear, true);
  if (!Object.keys(patch.set).length && !patch.clear.length) throw usage('ladder set needs a change: a field to set or --clear FIELD');
  const data = showData(updateLadder(ctx, { rungs: { [name]: patch } })).ladder[name];
  return { data: { rung: name, ...data }, text: `${name}: ${data.harness}${data.harness_from === 'default' ? ' (default harness)' : ''}, ${L.describe(data)}` };
}

function ladderHarness(ctx) {
  const layers = updateLadder(ctx, { harness: ctx.pos[0] });
  const follow = L.RUNGS.filter((n) => layers.ladder[n].harness_from === 'default');
  return {
    data: showData(layers),
    text: `default harness: ${layers.harness}; ${follow.length ? `${follow.join(', ')} run on it` : 'every rung names its own harness'}`,
  };
}

// The user file keeps any keys it has beyond harness and ladder. A ladder
// that cannot run is not saved: every later init would copy it and refuse.
function ladderSaveUser(ctx) {
  const out = S.mutate(ctx, 'ladder save-user', (st, emit) => {
    const broken = L.check(st.project, ctx.env);
    if (broken.length) throw refuse(`${broken.join('; ')}; fix the ladder with tower-crane ladder set before saving it as the default`);
    const layers = L.resolve(st.project, ctx.env);
    const file = layers.user_file;
    let doc = {};
    if (fs.existsSync(file)) {
      try {
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        throw refuse(`${file} is not valid JSON (${e.message}); fix it or remove it first`);
      }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw refuse(`${file} must hold an object; fix it or remove it first`);
    }
    const saved = { harness: layers.harness, ladder: Object.fromEntries(L.RUNGS.map((n) => [n, layers.ladder[n].own])) };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    S.writeAtomic(file, S.json({ ...doc, ...saved }));
    emit(null, { file });
    return { file, ...saved };
  });
  return { data: out, text: `wrote the ladder to ${out.file}; new projects start from it` };
}

function projectSet(ctx) {
  guardSpawnSettings(ctx);
  guardTestsSettings(ctx);
  requireOwnerMergePolicy(ctx);
  const keys = Object.keys(ctx.flags);
  if (!keys.length) throw usage('project set needs at least one setting; see tower-crane project set --help');
  requireOwnerReviewPolicy(ctx, ctx.flags);
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  const project = S.mutate(ctx, 'project set', (st, emit) => {
    applySettings(st.project, ctx.flags, ctx.cwd, repo);
    emit(null, ctx.flags);
    return st.project;
  });
  return { data: project, text: summary(project, ctx.env) };
}

function projectShow(ctx) {
  const st = S.loadState(ctx.stateDir);
  return { data: st.project, text: summary(st.project, ctx.env) };
}

module.exports = { init, projectSet, projectShow, ladderShow, ladderSet, ladderHarness, ladderSaveUser, updateLadder, rungPatch, showData };
