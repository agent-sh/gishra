'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { makeRepo, BIN } = require('./helpers');
const { CHROME, openBrowser } = require('./browser');

// A project with something in every column: a decision, an owner task, a
// claimed task with a message, a submitted task, and work ready and blocked.
function populate(h) {
  h.ok(['task', 'add', '--title', 'Webhook <keys>', '--acceptance', 'a retried webhook runs once']);
  h.ok(['task', 'add', '--title', 'Retry API', '--acceptance', 'b', '--dep', 'T1']);
  h.ok(['task', 'add', '--title', 'Pick a dashboard', '--acceptance', 'c', '--needs-owner', 'grant dashboard access']);
  h.ok(['task', 'add', '--title', 'Metrics', '--acceptance', 'd']);
  h.ok(['task', 'add', '--title', 'Docs', '--acceptance', 'e', '--kind', 'docs']);
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres', '--recommend', 'postgres', '--why', 'keys must survive a flush', '--blocks', 'T4']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'tests green, waiting on CI', '--agent', 'w-1']);
  h.ok(['claim', 'T5', '--agent', 'w-2']);
  const sha = h.git(['rev-parse', 'HEAD']).trim();
  h.ok(['submit', 'T5', '--sha', sha, '--agent', 'w-2']);
  h.ok(['evidence', 'T5', '--type', 'review', '--ok', '--sha', sha, '--ref', 'https://example.com/acme/demo/pull/1#review', '--summary', 'reads well', '--agent', 'rev-1']);
}

async function startServe(t, h, agent = 'owner') {
  const server = cp.spawn(process.execPath, [BIN, 'serve', '--port', '0', '--json', '--agent', agent], { cwd: h.repo, env: h.env });
  const exited = new Promise((resolve) => server.on('exit', resolve));
  // Windows cannot delete a directory a live process runs in, so the server
  // must be gone before makeRepo's cleanup removes the repo.
  t.after(async () => { server.kill(); await exited; });
  return new Promise((resolve, reject) => {
    let out = '';
    server.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0]).url);
    });
    server.on('exit', (code) => reject(new Error(`serve exited ${code}`)));
  });
}

const tokenOf = (page) => /<meta name="tower-crane-token" content="([0-9a-f]{48})">/.exec(page)[1];
const post = (url, token, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tower-crane-token': token }, body: JSON.stringify(body) });
const log = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('the snapshot names no network resource and carries no token or owner forms', (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  const page = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  // Allowed: the SVG namespace inside the data: icon, which is a name, not a
  // request, and evidence links, which open only when clicked.
  assert.match(page, /<a href="https:\/\/example\.com\/acme\/demo\/pull\/1#review" rel="noreferrer noopener" target="_blank">/);
  const rest = page.replace(/xmlns%3D%22http%3A%2F%2Fwww\.w3\.org%2F2000%2Fsvg%22/g, '').replace(/<a href="https:\/\/[^"]*" rel="noreferrer noopener" target="_blank">/g, '<a>');
  assert.doesNotMatch(rest, /\b(?:https?|wss?|ftp):/i, 'no absolute URLs');
  assert.doesNotMatch(rest, /\bsrc=|@import|<link(?![^>]*rel="icon" href="data:)/i, 'no external scripts, styles or images');
  assert.doesNotMatch(rest, /url\((?!#)/i, 'no CSS resources');
  assert.doesNotMatch(page, /<meta name="tower-crane-token"|<form data-api=/, 'the snapshot cannot write');
  assert.match(page, /"live":false/);
  assert.match(page, /Which store\?/);
  assert.match(page, /answer D1 --choice postgres/, 'a snapshot shows the command for what it cannot do');
});

test('the snapshot opens offline in a browser, with and without scripts, and requests nothing but itself', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  const file = pathToFileURL(path.join(h.state, 'sketch.html')).href;
  const b = await openBrowser(t);
  await b.send('Network.enable');
  const shown = (sel) => `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display !== 'none'`;
  for (const scripts of [false, true]) {
    await b.send('Emulation.setScriptExecutionDisabled', { value: !scripts });
    // A new document each round, so the script setting applies to a fresh load.
    await b.goto('about:blank');
    await b.goto(`${file}#board`);
    assert.deepEqual(await b.inPage(`[${shown('#board')}, ${shown('#plan')}, document.documentElement.classList.contains('js')]`), [true, false, scripts]);
    for (const view of ['plan', 'history', 'spend']) {
      await b.goto(`${file}#${view}`);
      assert.deepEqual(await b.inPage(`[${shown(`#${view}`)}, ${shown('#board')}]`), [true, false], `${view} opens by its link (scripts ${scripts})`);
    }
    await b.goto(`${file}#T1`);
    assert.equal(await b.inPage(shown('#T1')), true, `a task sheet opens by its link (scripts ${scripts})`);
    assert.match(await b.inPage(`document.querySelector('#T1 .sbody').textContent`), /a retried webhook runs once/);
  }
  const urls = b.seen.filter((m) => m.method === 'Network.requestWillBeSent').map((m) => m.params.request.url);
  assert.ok(urls.length, 'the browser loaded the file');
  assert.deepEqual(urls.filter((u) => !u.startsWith(file.split('#')[0]) && !u.startsWith('data:')), [], 'nothing but the file itself and data: icons');
});

test('serve sends a submitted or accepted task back for rework only as the owner, through the CLI rework', async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  const viewer = await startServe(t, h, 'viewer');
  const viewerPage = await (await fetch(viewer)).text();
  assert.doesNotMatch(viewerPage, /data-api="\/api\/tasks\/T5\/rework"/, 'no rework form without the owner');
  const before = log(h).length;
  assert.equal((await post(`${viewer}api/tasks/T5/rework`, tokenOf(viewerPage), { reason: 'forged' })).status, 403);

  const url = await startServe(t, h);
  const page = await (await fetch(url)).text();
  assert.match(page, /data-api="\/api\/tasks\/T5\/rework"/);
  assert.doesNotMatch(page, /data-api="\/api\/tasks\/T1\/rework"/, 'a claimed task cannot be sent back');
  const token = tokenOf(page);
  assert.equal((await post(`${url}api/tasks/T5/rework`, token, { reason: '' })).status, 400, 'a reason is required');
  assert.equal((await post(`${url}api/tasks/T1/rework`, token, { reason: 'not submitted' })).status, 400, 'the CLI refuses a claimed task');
  assert.equal((await post(`${url}api/decisions/D1/rework`, token, { reason: 'x' })).status, 404, 'decisions have no rework');
  assert.equal(log(h).length, before, 'refused writes record nothing');

  const r = await post(`${url}api/tasks/T5/rework`, token, { reason: 'cover the retry path' });
  assert.equal(r.status, 200, await r.clone().text());
  const t5 = h.readState('tasks.json').tasks.find((x) => x.id === 'T5');
  assert.equal(t5.status, 'rework');
  assert.match(t5.notes[t5.notes.length - 1].text, /^rework: cover the retry path$/);
  const ev = log(h).pop();
  assert.deepEqual([ev.cmd, ev.agent, ev.task, ev.detail.reason], ['rework', 'owner', 'T5', 'cover the retry path']);
});

test('in a browser, every board write goes through its form: answer, comments, owner-done, rework and tier', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  const url = await startServe(t, h);
  const b = await openBrowser(t);
  await b.goto(`${url}#board`);
  await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
  const events = () => log(h).length;

  // Answer with the option button, as a person would.
  let n = events();
  await b.inPage(`document.querySelector('form[data-api="/api/decisions/D1/answer"] button[value="redis"]').click()`);
  await b.until(`!document.querySelector('form[data-api="/api/decisions/D1/answer"]')`, 'the answered decision to leave the board');
  const d1 = h.readState('decisions.json').decisions[0];
  assert.deepEqual([d1.status, d1.answer, d1.answered_by], ['answered', 'redis', 'owner']);
  assert.equal(events(), n + 1);

  // A comment on a task, from its sheet.
  await b.goto(`${url}#T1`);
  await b.inPage(`(() => { const f = document.querySelector('#T1 form[data-api="/api/tasks/T1/comments"]'); f.querySelector('textarea').value = 'please split the API part'; f.querySelector('button[type="submit"]').click(); })()`);
  await b.until(`[...document.querySelectorAll('#T1 .thread .msg p')].some((p) => p.textContent === 'please split the API part')`, 'the comment in the thread');
  const t1 = h.readState('tasks.json').tasks[0];
  assert.deepEqual([t1.notes.at(-1).agent, t1.notes.at(-1).text], ['owner', 'please split the API part']);

  // Owner-done from the board plate.
  await b.goto(`${url}#board`);
  await b.inPage(`document.querySelector('form[data-api="/api/tasks/T3/owner-done"] button[type="submit"]').click()`);
  await b.until(`!document.querySelector('form[data-api="/api/tasks/T3/owner-done"]')`, 'the owner task to clear');
  assert.equal(h.readState('tasks.json').tasks[2].needs_owner, null);

  // Rework from the submitted task's sheet.
  await b.goto(`${url}#T5`);
  await b.inPage(`(() => { const f = document.querySelector('#T5 form[data-api="/api/tasks/T5/rework"]'); f.querySelector('textarea').value = 'docs miss the retry header'; f.querySelector('button').click(); })()`);
  await b.until(`!document.querySelector('#T5 form[data-api="/api/tasks/T5/rework"]')`, 'the rework form to go once the task is in rework');
  assert.equal(h.readState('tasks.json').tasks[4].status, 'rework');

  // Tier from a sheet, with the tier it was based on.
  await b.goto(`${url}#T2`);
  await b.inPage(`(() => { const f = document.querySelector('#T2 form[data-kind="tier"]'); f.querySelector('select').value = 'hard'; f.querySelector('button').click(); })()`);
  await b.until(`document.querySelector('#T2 form[data-kind="tier"]') && document.querySelector('#T2 form[data-kind="tier"]').dataset.base === 'hard'`, 'the sheet to show the saved tier');
  assert.equal(h.readState('tasks.json').tasks[1].tier, 'hard');
  const tierEvent = log(h).pop();
  assert.deepEqual([tierEvent.cmd, tierEvent.agent, tierEvent.detail.tier, tierEvent.detail.via], ['task update', 'owner', 'hard', 'serve']);

  // A refused write says why in the form and writes nothing.
  h.ok(['task', 'update', 'T2', '--tier', 'easy']);
  n = events();
  await b.inPage(`(() => { const f = document.querySelector('#T2 form[data-kind="tier"]'); f.dataset.base = 'medium'; f.querySelector('select').value = 'research'; f.querySelector('button').click(); })()`);
  await b.until(`document.querySelector('#T2 form[data-kind="tier"] output.err')`, 'the refusal to show');
  assert.match(await b.inPage(`document.querySelector('#T2 form[data-kind="tier"] output').textContent`), /T2/);
  assert.equal(events(), n);
});

test('in a browser, a change elsewhere updates the board in place and waits while the owner is typing', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  const url = await startServe(t, h);
  const b = await openBrowser(t);
  await b.goto(`${url}#board`);
  await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
  await b.inPage('window.firstLoad = true');

  h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'rebased, CI running', '--agent', 'w-1']);
  await b.until(`document.querySelector('.card[data-key="T1"] .last p').textContent === 'rebased, CI running'`, 'the card to show the new message');
  assert.equal(await b.inPage('window.firstLoad === true && document.querySelector(\'.card[data-key="T1"]\').classList.contains(\'changed\')'), true, 'updated in place, and the card marks the change');

  // Typed text holds its column: the owner's draft is never replaced.
  await b.inPage(`(() => { const d = document.querySelector('.col-need article[data-key="D1"] > details.more'); d.open = true; const ta = d.querySelector('textarea'); ta.focus(); })()`);
  await b.type('my draft');
  h.ok(['ask', '--question', 'Ship on Friday?', '--option', 'yes', '--option', 'no']);
  await b.until(`document.querySelector('[data-notice]').classList.contains('on')`, 'the waiting notice');
  assert.equal(await b.inPage(`document.querySelector('.col-need textarea').value`), 'my draft');
  await b.until(`document.querySelector('.col-since').textContent.includes('Ship on Friday?')`, 'the other columns to update');
  assert.equal(await b.inPage(`document.querySelector('.col-need').textContent.includes('Ship on Friday?')`), false, 'the held column has not changed yet');
  await b.inPage(`(() => { const ta = document.querySelector('.col-need textarea'); ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.blur(); })()`);
  await b.until(`document.querySelector('.col-need').textContent.includes('Ship on Friday?')`, 'the held update to apply');
  assert.equal(await b.inPage('window.firstLoad === true'), true, 'still the same page');
});
