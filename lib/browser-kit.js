'use strict';

const fs = require('node:fs');
const path = require('node:path');
const S = require('./state');
const L = require('./ladder');
const { refuse, usage } = require('./util');

const needed = (task) => task?.kind === 'design' || (task?.needs || []).includes('browser');

function userEnv(env, home) {
  return { ...env, TOWER_CRANE_CONFIG: env.TOWER_CRANE_CONFIG || path.join(home, '.config', 'tower-crane', 'config.json') };
}

function servers(env, home) {
  return [...new Set(L.readUser(userEnv(env, home))?.browser_kit || ['playwright'])];
}

function show(ctx) {
  const home = require('./agents').origin(ctx.env).home;
  const names = servers(ctx.env, home);
  const file = L.userFile(userEnv(ctx.env, home));
  return { data: { servers: names, file }, text: `browser kit: ${names.join(', ') || '(empty)'}\nuser file: ${file}` };
}

function set(ctx) {
  if (ctx.agent !== 'owner' || !ctx.agentExplicit) throw refuse('only the owner can change the browser kit user setting');
  let names;
  try { names = JSON.parse(ctx.flags.servers); } catch { throw usage('--servers must be a JSON array of MCP server names'); }
  const errors = L.browserKitErrors(names);
  if (errors.length) throw usage(errors.join('; '));
  names = [...new Set(names)];
  const home = require('./agents').origin(ctx.env).home;
  const file = L.userFile(userEnv(ctx.env, home));
  S.mutate(ctx, 'browser-kit set', (st, emit) => {
    let doc = {};
    if (fs.existsSync(file)) {
      try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw refuse(`${file} must hold a valid JSON object`); }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw refuse(`${file} must hold an object`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    S.writeAtomic(file, S.json({ ...doc, browser_kit: names }));
    emit(null, { file, servers: names });
  });
  return { data: { servers: names, file }, text: `browser kit: ${names.join(', ') || '(empty)'}; wrote ${file}` };
}

module.exports = { needed, servers, show, set };
