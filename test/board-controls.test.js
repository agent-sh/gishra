'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, BIN, HOOKS } = require('./helpers');
const { CHROME, openBrowser } = require('./browser');
const Authority = require('../lib/authority');

function fixture(t) {
  const h = makeRepo();
  h.servers = [];
  t.after(async () => {
    for (const { child, exited } of h.servers) { child.kill(); await exited; }
    await h.cleanup();
  });
  return h;
}

async function serve(t, h, agent = 'owner') {
  const child = cp.spawn(process.execPath, ['--require', HOOKS, BIN, 'serve', '--port', '0', '--json', '--agent', agent],
    { cwd: h.repo, env: { ...h.env, HOOK_STATE: h.state, HOOK_PROCESSES_DIR: path.join(h.base, 'detached') } });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  h.servers.push({ child, exited });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (data) => {
      out += data;
      if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0]).url);
    });
    child.once('exit', (code) => reject(new Error(`serve exited ${code}`)));
  });
  const html = await (await fetch(url)).text();
  const token = /name="tower-crane-token" content="([^"]+)"/.exec(html)?.[1] || '';
  const post = async (body, route = 'api/controls', headers = {}) => {
    const res = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tower-crane-token': token, ...headers }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  return { url, post };
}

const request = (command, flags = {}, pos = []) => ({ command, flags, pos });
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const audits = (h) => events(h).filter((e) => e.cmd === 'setting');

test('board controls cover the authority table and use the CLI authority and audit for changes and approvals', async (t) => {
  const h = fixture(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Board control', '--acceptance', 'runs']);
  const { url, post } = await serve(t, h);
  const res = await fetch(url + 'api/controls');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.authority.map((r) => r.setting), Object.keys(Authority.TABLE));
  for (const row of data.authority) assert.ok(row.control, row.setting);
  const page = await (await fetch(url + 'controls')).text();
  for (const row of data.authority) assert.ok(page.includes(`id="${row.control}"`), row.setting);
  let result = await post(request('project set', { workers: '3' }));
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(h.readState('project.json').limits.workers, 3);
  assert.deepEqual(audits(h).at(-1).detail, { command: 'project set', actor: 'owner', mode: 'board', settings: { 'limits.workers': 'operational' } });
  const before = audits(h).length;
  result = await post(request('project set', { 'merge-admin': 'true' }));
  assert.equal(result.data.decision, 'D1');
  assert.equal(h.readState('project.json').merge?.admin, undefined);
  assert.equal(audits(h).length, before);
  result = await post({ decision: 'D1', choice: 'approve' }, 'api/controls/answer');
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(h.readState('project.json').merge.admin, true);
  assert.equal(audits(h).length, before + 1);
  assert.equal(audits(h).at(-1).detail.approved_by, 'D1');
  assert.equal(h.readState('decisions.json').decisions[0].applied.by, 'owner');
  assert.equal((await post({ decision: 'D1', choice: 'approve' }, 'api/controls/answer')).status, 400);
  result = await post(request('project set', { 'merge-admin': 'false' }));
  await post({ decision: result.data.decision, choice: 'decline' }, 'api/controls/answer');
  assert.equal(h.readState('project.json').merge.admin, true);
  assert.equal((await post(request('project set', { workers: '0' }))).status, 400);
  assert.equal((await post(request('project set', { agent: 'orchestrator' }))).status, 400);
  assert.equal((await post(request('merge', {}, ['T1']))).status, 400);
  assert.equal((await post(request('project set', { workers: '9' }), 'api/controls', { 'x-tower-crane-version': 'outdated' })).status, 409);
  assert.equal(h.readState('project.json').limits.workers, 3);
});

test('project, ladder, personal and task controls persist through shared handlers, including pause and budget direction', async (t) => {
  const h = fixture(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A ready task', '--acceptance', 'runs']);
  const { post, url } = await serve(t, h);
  async function change(command, flags, pos = []) {
    const before = audits(h).length;
    let r = await post(request(command, flags, pos));
    assert.equal(r.status, 200, JSON.stringify(r));
    if (r.data.decision) {
      assert.equal(audits(h).length, before, command);
      r = await post({ decision: r.data.decision, choice: 'approve' }, 'api/controls/answer');
      assert.equal(r.status, 200, JSON.stringify(r));
    }
    assert.equal(audits(h).length, before + 1, command + JSON.stringify(flags));
    assert.equal(audits(h).at(-1).detail.mode, 'board');
    return r;
  }
  const flags = {
    'tests-cmd': 'node --test', 'clean-cmd': 'node clean.js', 'tests-proof-cmd': 'node --test {tests}',
    'ci-required': '["test"]', 'ci-ignore-apps': '["example"]', 'ci-capped-review': '[{"app":"review","pattern":"limit"}]',
    'ci-local': '{"command":["node","ci.js"],"timeout":30}', 'tests-paths': '["test/*.test.js"]',
    'tests-keep': '["fixtures/**"]', 'tests-mode': 'run-only', 'tests-by-kind': '{"docs":"none"}',
    'tests-expensive': 'true', 'lease-minutes': '45', 'merge-keep-branch': 'true',
    'review-policy': '{"small_lines":40}', sandbox: '{"write":[]}', env: '{"BOARD_TEST":"yes"}',
    env_file: '/example/env', scope: '{}',
  };
  for (const [key, value] of Object.entries(flags)) await change('project set', { [key]: value });
  await change('project set', { 'budget-hours': '2', 'budget-tokens': '100' });
  assert.deepEqual(audits(h).at(-1).detail.settings, { 'budget.lower': 'operational' });
  await change('project set', { 'budget-hours': 'null', 'budget-tokens': '200' });
  assert.deepEqual(audits(h).at(-1).detail.settings, { 'budget.raise': 'owner-required' });
  assert.equal(h.readState('project.json').budget.hours, null);
  await change('project set', { paused: 'Owner is inspecting the run' });
  assert.match(h.ok(['project', 'show']), /paused: Owner is inspecting the run/);
  assert.match(h.run(['claim', 'T1', '--agent', 'worker']).stderr, /project paused/);
  assert.ok((await (await fetch(url + 'api/controls')).json()).tasks[0].blocked.includes('project paused: Owner is inspecting the run'));
  await change('project set', { paused: '' });
  await change('ladder set', { model: 'test-model', supervision: '{"retries":1}', tools: '["Read"]', mcp: '["playwright"]' }, ['hard']);
  await change('ladder set', { sandbox: '{"write":[]}', env: '{"BOARD_RUNG":"yes"}', scope: '{}' }, ['hard']);
  await change('ladder fallbacks', { routes: '[{"harness":"codex","profile":"sol","effort":"high"}]' }, ['hard']);
  assert.equal(JSON.parse(fs.readFileSync(h.userConfig)).ladder.hard.fallbacks[0].profile, 'sol');
  await change('ladder save-user', {});
  await change('browser-kit set', { servers: '["playwright","custom"]' });
  assert.deepEqual(JSON.parse(fs.readFileSync(h.userConfig)).browser_kit, ['playwright', 'custom']);
  await change('task update', { kind: 'docs', tier: 'easy', 'needs-owner': 'Review docs', 'ci-local': '{"args":["docs"]}' }, ['T1']);
  await change('owner-done', {}, ['T1']);
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, null);
  await change('ask', { setting: 'publish', change: '{"release":"v0.1.0"}' });
  assert.equal(audits(h).at(-1).detail.settings.publish, 'owner-required');
  const invalid = await post(request('ladder fallbacks', { routes: '[{"harness":"codex"}]' }, ['easy']));
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error, /needs a model or a profile/);
});

test('the board applies CLI escalations, preserves failed approvals for retry, and rejects viewer writes', async (t) => {
  const h = fixture(t);
  h.init();
  const refused = h.run(['project', 'set', '--merge-admin', 'true'], { env: { TOWER_CRANE_AGENT: 'orchestrator' } });
  assert.equal(refused.code, 1);
  const { post, url } = await serve(t, h);
  assert.equal((await post({ decision: 'D1', choice: 'approve' }, 'api/controls/answer')).status, 200);
  assert.equal(h.readState('project.json').merge.admin, true);
  h.ok(['task', 'add', '--title', 'Submitted later', '--acceptance', 'runs']);
  const r = await post(request('accept', { waive: ['tests', 'clean', 'review', 'ci'], reason: 'Fixture only' }, ['T1']));
  assert.equal(r.data.decision, 'D2');
  const failed = await post({ decision: 'D2', choice: 'approve' }, 'api/controls/answer');
  assert.equal(failed.status, 400);
  assert.match(failed.data.error, /only submitted/);
  assert.equal(h.readState('decisions.json').decisions[1].applied, undefined);
  assert.match(await (await fetch(url + 'controls')).text(), /Apply approved change/);
  const viewer = await serve(t, h, 'viewer');
  const page = await (await fetch(viewer.url + 'controls')).text();
  assert.doesNotMatch(page, /<form|<input|<select/);
  assert.equal((await viewer.post(request('project set', { workers: '9' }))).status, 403);
});

test('the board interrupts a real supervised fixture, releases its claim and delegates only after approval', { skip: process.platform !== 'linux' && 'interrupt verifies Linux start ticks' }, async (t) => {
  const h = fixture(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A supervised fixture', '--acceptance', 'stops on request', '--tier', 'easy']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Fixture process, no model.\n' });
  const script = `require('node:child_process').execFileSync(process.execPath,[${JSON.stringify(BIN)},'claim','T1']);setInterval(()=>{},1000)`;
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, '-e', script]), '--clear', 'profile', '--clear', 'effort']);
  h.ok(['project', 'set', '--paused', 'Inspect before dispatch']);
  assert.match(h.run(['spawn', '--task', 'T1']).stderr, /project paused/);
  h.ok(['project', 'set', '--paused', '']);
  const run = h.json(['spawn', '--task', 'T1']);
  async function until(fn) {
    const deadline = Date.now() + 15000;
    while (!fn()) {
      assert.ok(Date.now() < deadline, 'fixture process completed the transition');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await until(() => h.readState('tasks.json').tasks[0].claim);
  const { post, url } = await serve(t, h);
  const asked = await post(request('interrupt', { reason: 'Owner inspection' }, ['T1']));
  assert.equal(asked.status, 200, JSON.stringify(asked));
  assert.equal(asked.data.decision, 'D1');
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, null);
  const stopped = await post({ decision: 'D1', choice: 'approve' }, 'api/controls/answer');
  assert.equal(stopped.status, 200, JSON.stringify(stopped));
  const Processes = require('../lib/processes');
  await until(() => Processes.processState({ pid: run.pid, host: run.host, start_ticks: run.start_ticks }) === 'exited');
  await until(() => !require('../lib/processes').supervised(require('../lib/state').loadState(h.state), h.readState('tasks.json').tasks[0], events(h)));
  assert.equal(events(h).filter((e) => e.cmd === 'spawn retry').length, 0);
  assert.equal((await post(request('release', { reason: 'Supervisor stopped' }, ['T1']))).status, 200);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'todo');
  assert.match(await (await fetch(url + 'controls')).text(), /needs owner: Owner inspection/);
  assert.equal((await post(request('owner-done', {}, ['T1']))).status, 200);
  assert.equal((await post(request('interrupt', { reason: 'No active process' }, ['T1']))).status, 400);
  h.ok(['ladder', 'set', 'orchestrator', '--harness', 'command', '--command',
    JSON.stringify([path.join(h.base, 'missing-program')]), '--clear', 'model', '--clear', 'effort']);
  const delegation = await post(request('spawn', { task: 'T1', role: 'orchestrator' }));
  assert.equal(delegation.status, 200, JSON.stringify(delegation));
  assert.ok(delegation.data.decision);
  assert.equal(events(h).filter((e) => e.cmd === 'spawn' && e.detail.role === 'orchestrator').length, 0);
  const failed = await post({ decision: delegation.data.decision, choice: 'approve' }, 'api/controls/answer');
  assert.equal(failed.status, 400, JSON.stringify(failed));
  assert.equal(audits(h).filter((e) => e.detail.settings.delegation).length, 0);
  assert.equal(h.readState('decisions.json').decisions.at(-1).applied, undefined);
  h.ok(['ladder', 'set', 'orchestrator', '--command', JSON.stringify([process.execPath, '-e', 'setInterval(()=>{},1000)'])]);
  const started = await post({ decision: delegation.data.decision, choice: 'approve' }, 'api/controls/answer');
  assert.equal(started.status, 200, JSON.stringify(started));
  assert.equal(events(h).filter((e) => e.cmd === 'spawn' && e.detail.role === 'orchestrator').length, 1);
  assert.equal(audits(h).filter((e) => e.detail.mode === 'board' && e.detail.settings.delegation).length, 1);
});

test('approved board waivers accept once and retain one settings audit', async (t) => {
  const h = fixture(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Waiver fixture', '--acceptance', 'accepted']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
  const { post } = await serve(t, h);
  const asked = await post(request('accept', { waive: ['tests', 'clean', 'review', 'ci'], reason: 'Fixture has no software gates' }, ['T1']));
  assert.equal(asked.data.decision, 'D1');
  const applied = await post({ decision: 'D1', choice: 'approve' }, 'api/controls/answer');
  assert.equal(applied.status, 200, JSON.stringify(applied));
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
  assert.equal(h.readState('decisions.json').decisions[0].applied.by, 'owner');
  assert.equal(audits(h).filter((e) => e.detail.command === 'accept').length, 1);
  assert.equal((await post({ decision: 'D1', choice: 'approve' }, 'api/controls/answer')).status, 400);
});

test('browser controls save limits, approve and decline requests, edit fallbacks and preserve unsaved input in both themes', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = fixture(t);
  h.init();
  h.ok(['project', 'set', '--name', 'Tower Crane board controls', '--goal', 'Run the project from the board']);
  h.ok(['task', 'add', '--title', 'Ship the board controls', '--acceptance', 'Every authority setting is reachable', '--needs-owner', 'Approve the release plan']);
  h.ok(['ask', '--question', 'Publish the release today?', '--option', 'yes', '--option', 'no']);
  const { url } = await serve(t, h);
  const b = await openBrowser(t);
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await b.goto(url + 'controls');
  await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'controls connection');
  async function fill(id, name, value) {
    await b.inPage(`(() => {const e = document.querySelector('#${id} [name="${name}"]'); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  }
  async function submit(id, condition) {
    await b.inPage(`window.beforeControlSave = true; document.querySelector('#${id} button[type="submit"]').click()`);
    await b.restored(`!window.beforeControlSave && (${condition})`, id + ' saved');
  }
  await fill('project-workers', 'workers', '4');
  await submit('project-workers', `document.querySelector('#project-workers input').value === '4'`);
  assert.equal(h.readState('project.json').limits.workers, 4);
  await fill('project-merge-admin', 'merge-admin', 'true');
  await submit('project-merge-admin', `document.querySelector('[data-decision="D2"]')`);
  for (const theme of ['light', 'dark']) {
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    assert.equal(await b.inPage(`matchMedia('(prefers-color-scheme: ${theme})').matches`), true);
    assert.equal(await b.inPage(`document.documentElement.scrollWidth <= innerWidth`), true);
    if (process.env.TOWER_CRANE_BOARD_ARTIFACTS) {
      fs.mkdirSync(process.env.TOWER_CRANE_BOARD_ARTIFACTS, { recursive: true });
      await b.inPage('scrollTo(0,0)');
      const shot = await b.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.TOWER_CRANE_BOARD_ARTIFACTS, `controls-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
  }
  await b.inPage(`document.querySelector('[data-decision="D2"] [value="approve"]').click()`);
  await b.restored(`!document.querySelector('[data-decision="D2"]')`, 'approval applied');
  assert.equal(h.readState('project.json').merge.admin, true);
  await fill('project-merge-admin', 'merge-admin', 'false');
  await submit('project-merge-admin', `document.querySelector('[data-decision="D3"]')`);
  await b.inPage(`document.querySelector('[data-decision="D3"] [value="decline"]').click()`);
  await b.restored(`!document.querySelector('[data-decision="D3"]')`, 'decline saved');
  assert.equal(h.readState('project.json').merge.admin, true);
  await fill('personal', 'routes', '[{"profile":"sol"}]');
  await submit('personal', `document.querySelector('[data-decision="D4"]')`);
  await b.inPage(`document.querySelector('[data-decision="D4"] [value="approve"]').click()`);
  await b.restored(`!document.querySelector('[data-decision="D4"]')`, 'fallback saved');
  assert.equal(JSON.parse(fs.readFileSync(h.userConfig)).ladder.easy.fallbacks[0].profile, 'sol');
  await fill('project-paused', 'paused', 'Inspecting release');
  await submit('project-paused', `document.querySelector('#project-paused input').value === 'Inspecting release'`);
  assert.match(await b.inPage('document.body.textContent'), /project paused: Inspecting release/);
  await fill('project-workers', 'workers', '7');
  h.ok(['task', 'note', 'T1', 'Progress from a worker']);
  await b.until(`!document.getElementById('stale').hidden`, 'live change notice');
  assert.equal(await b.inPage(`document.querySelector('#project-workers input').value`), '7');
  await b.goto(url);
  await b.inPage(`document.querySelector('form[data-api="/api/decisions/D1/answer"] button[value="yes"]').click()`);
  await b.restored(`!document.querySelector('form[data-api="/api/decisions/D1/answer"]')`, 'ordinary decision answered');
  assert.equal(h.readState('decisions.json').decisions[0].answer, 'yes');
  await b.goto(url + 'controls');
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await b.inPage(`document.documentElement.scrollWidth <= innerWidth`), true);
});
