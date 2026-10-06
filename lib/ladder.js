'use strict';

// The model ladder: which harness, model and effort runs each kind of work.
// Pure config logic with no state access, so state.js can validate with it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refuse } = require('./util');

const HARNESSES = ['claude', 'codex', 'opencode', 'agy', 'pi', 'command'];
const RUNGS = ['orchestrator', 'easy', 'medium', 'hard', 'research', 'review', 'small'];
const TIERS = ['easy', 'medium', 'hard', 'research'];
const FIELDS = ['harness', 'model', 'profile', 'provider', 'effort', 'args', 'command'];

// Reasoning effort in each CLI's own terms. opencode passes it as --variant,
// whose names each provider defines, so any single word goes through there.
const EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  opencode: null,
  agy: ['low', 'medium', 'high', 'max'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  command: [],
};

const USES = {
  orchestrator: 'plans, dispatches, gates, merges',
  easy: 'default tier for S tasks',
  medium: 'default tier for M tasks',
  hard: 'default tier for L tasks',
  research: 'default tier for research',
  review: 'clean-context reviews',
  small: 'mechanical checks',
};

const BUILTIN = {
  harness: 'codex',
  ladder: {
    orchestrator: { harness: 'claude', model: 'opus', effort: 'high' },
    easy: { profile: 'luna', effort: 'medium' },
    medium: { profile: 'sol', effort: 'high' },
    hard: { harness: 'claude', model: 'opus', effort: 'high' },
    research: { harness: 'claude', model: 'opus', effort: 'max' },
    review: { profile: 'sol', effort: 'high' },
    small: { profile: 'luna', effort: 'low' },
  },
};

const SOURCE = { project: 'project', user: 'user file', 'built-in': 'built-in' };

function defaultTier(kind, size) {
  if (kind === 'research') return 'research';
  return { S: 'easy', M: 'medium', L: 'hard' }[size] || 'medium';
}

function userFile(env = process.env) {
  return env.GISHRA_CONFIG ? path.resolve(env.GISHRA_CONFIG) : path.join(os.homedir(), '.config', 'gishra', 'config.json');
}

const isWord = (v) => typeof v === 'string' && v.trim() !== '';
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function rungShape(where, r, errs) {
  if (!isObject(r)) return errs.push(`${where} must be an object`);
  for (const k of Object.keys(r)) if (!FIELDS.includes(k)) errs.push(`${where}: unknown field ${k}; a rung takes ${FIELDS.join(', ')}`);
  if (r.harness !== undefined && !HARNESSES.includes(r.harness)) errs.push(`${where}: harness must be one of ${HARNESSES.join(', ')}`);
  for (const k of ['model', 'profile', 'provider', 'effort']) if (r[k] !== undefined && !isWord(r[k])) errs.push(`${where}: ${k} must be a non-empty string`);
  if (r.args !== undefined && (!Array.isArray(r.args) || !r.args.every((a) => typeof a === 'string'))) errs.push(`${where}: args must be an array of strings`);
  if (r.command !== undefined && (!Array.isArray(r.command) || !r.command.length || !r.command.every(isWord))) errs.push(`${where}: command must be a non-empty array of strings`);
  return errs;
}

// Shape of { harness, ladder } as project.json and the user file hold it.
// Either may leave out the harness or any rung; the next layer fills it.
function shapeErrors(doc) {
  const errs = [];
  if (doc.harness !== undefined && !HARNESSES.includes(doc.harness)) errs.push(`harness must be one of ${HARNESSES.join(', ')}`);
  if (doc.ladder !== undefined) {
    if (!isObject(doc.ladder)) errs.push('ladder must be an object of rungs');
    else {
      for (const [name, r] of Object.entries(doc.ladder)) {
        if (!RUNGS.includes(name)) errs.push(`ladder: unknown rung ${name}; the rungs are ${RUNGS.join(', ')}`);
        else rungShape(`ladder ${name}`, r, errs);
      }
    }
  }
  return errs;
}

function readUser(env = process.env) {
  const file = userFile(env);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw refuse(`cannot read ${file} (${e.code || e.message})`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw refuse(`${file} is not valid JSON (${e.message}); fix it or remove it`);
  }
  if (!isObject(doc)) throw refuse(`${file} must hold an object { "harness", "ladder" }; fix it or remove it`);
  const errs = shapeErrors(doc);
  if (errs.length) throw refuse(`${file} is invalid: ${errs.join('; ')}; fix it or remove it`);
  return doc;
}

const copy = (v) => JSON.parse(JSON.stringify(v));

// Fields in FIELDS order, so files and output read the same way every time.
function ordered(r) {
  const out = {};
  for (const k of FIELDS) if (r[k] !== undefined) out[k] = copy(r[k]);
  return out;
}

// Each rung, and the default harness, comes whole from the first layer that
// has it: the project, then the user file, then the built-in defaults. The
// user file is read only when the project leaves something out.
function resolve(project, env = process.env) {
  const p = project || {};
  const pl = isObject(p.ladder) ? p.ladder : {};
  const needsUser = p.harness === undefined || RUNGS.some((n) => pl[n] === undefined);
  const user = needsUser ? readUser(env) : null;
  const ul = user && isObject(user.ladder) ? user.ladder : {};
  let harness = BUILTIN.harness;
  let harnessFrom = 'built-in';
  if (p.harness !== undefined) [harness, harnessFrom] = [p.harness, 'project'];
  else if (user && user.harness !== undefined) [harness, harnessFrom] = [user.harness, 'user'];
  const ladder = {};
  for (const name of RUNGS) {
    let own = BUILTIN.ladder[name];
    let from = 'built-in';
    if (pl[name] !== undefined) [own, from] = [pl[name], 'project'];
    else if (ul[name] !== undefined) [own, from] = [ul[name], 'user'];
    own = ordered(own);
    ladder[name] = { own, from, harness: own.harness || harness, harness_from: own.harness ? 'rung' : 'default' };
  }
  return { harness, harness_from: harnessFrom, user_file: userFile(env), ladder };
}

// What a rung needs on the harness it resolves to. A field another harness
// would use is refused rather than ignored: dropping a codex profile on pi
// would quietly run a model nobody chose.
function rungErrors(name, entry, layers) {
  const r = entry.own;
  const h = entry.harness;
  const why = [];
  if (r.profile !== undefined && h !== 'codex') why.push('profile applies only to codex');
  if (r.provider !== undefined && h !== 'pi') why.push('provider applies only to pi');
  if (h === 'command') {
    if (r.command === undefined) why.push('needs a command array');
    for (const k of ['model', 'effort']) if (r[k] !== undefined) why.push(`${k} does not apply (put it in the command array)`);
  } else {
    if (r.command !== undefined) why.push('command applies only to the command harness');
    if (h === 'codex' ? r.model === undefined && r.profile === undefined : r.model === undefined) why.push(h === 'codex' ? 'needs a model or a profile' : 'needs a model');
    const allowed = EFFORTS[h];
    if (r.effort !== undefined && allowed && !allowed.includes(r.effort)) why.push(`effort must be one of ${allowed.join(', ')}, not "${r.effort}"`);
    if (r.effort !== undefined && !allowed && !/^[\w.-]+$/.test(r.effort)) why.push(`effort must be a single word, not "${r.effort}"`);
  }
  if (!why.length) return [];
  const from = entry.from === 'project' ? '' : `, from the ${entry.from === 'user' ? `user file ${layers.user_file}` : 'built-in defaults'}`;
  return [`ladder ${name} (${h}${entry.harness_from === 'default' ? ', the default harness' : ''}${from}): ${why.join(', ')}`];
}

// Everything wrong with a project's ladder once the layers are applied.
function check(project, env = process.env) {
  const errs = shapeErrors(project || {});
  if (errs.length) return errs;
  const layers = resolve(project, env);
  for (const name of RUNGS) errs.push(...rungErrors(name, layers.ladder[name], layers));
  return errs;
}

// The rung as spawn and the views use it: its own fields plus the harness it
// runs on.
function rungOf(layers, name) {
  const e = layers.ladder[name];
  return { ...e.own, harness: e.harness };
}

// Which model a rung runs, for telling two rungs apart: a codex profile names
// a model as much as a model id does.
function identity(rung) {
  if (rung.harness === 'command') return `command ${JSON.stringify(rung.command || [])}`;
  return [rung.harness, rung.model || '', rung.profile || '', rung.provider || ''].join('|');
}

function describe(rung) {
  const parts = [];
  if (rung.model) parts.push(`model ${rung.model}`);
  if (rung.profile) parts.push(`profile ${rung.profile}`);
  if (rung.provider) parts.push(`provider ${rung.provider}`);
  if (rung.effort) parts.push(`effort ${rung.effort}`);
  if (rung.command) parts.push(`command ${JSON.stringify(rung.command)}`);
  if (rung.args && rung.args.length) parts.push(`args ${JSON.stringify(rung.args)}`);
  return parts.join(', ');
}

module.exports = {
  HARNESSES, RUNGS, TIERS, FIELDS, EFFORTS, USES, BUILTIN, SOURCE,
  defaultTier, userFile, readUser, shapeErrors, resolve, check, rungOf, identity, describe, ordered,
};
