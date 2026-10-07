'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { makeRepo, BIN } = require('./helpers');
const { CHROME, openBrowser } = require('./browser');
const { gateFixture, gateEvidence } = require('./gate-helpers');

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

// serve runs in the repository, and Windows cannot delete a directory a live
// process runs in, so every server stops before makeRepo's cleanup: each
// test closes its servers in a finally block.
async function startServe(servers, h, agent = 'owner') {
  const server = cp.spawn(process.execPath, [BIN, 'serve', '--port', '0', '--json', '--agent', agent], { cwd: h.repo, env: h.env });
  const exited = new Promise((resolve) => server.on('exit', resolve));
  servers.push(async () => { server.kill(); await exited; });
  return new Promise((resolve, reject) => {
    let out = '';
    server.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0]).url);
    });
    server.on('exit', (code) => reject(new Error(`serve exited ${code}`)));
  });
}

async function withServers(fn) {
  const servers = [];
  try {
    await fn(servers);
  } finally {
    for (const stop of servers) await stop();
  }
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

test('the board escapes every text the state holds', (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  const sha = h.git(['rev-parse', 'HEAD']).trim();
  h.ok(['ask', '--question', 'Pick <script>alert(1)</script>?', '--option', '<b>a</b>', '--option', 'b', '--why', 'why <i>', '--blocks', 'T2']);
  h.ok(['msg', '--to', 'owner', '--task', 'T1', 'look <img src=x onerror=alert(1)>', '--agent', 'w-1']);
  h.ok(['evidence', 'T5', '--type', 'note', '--ok', '--sha', sha, '--summary', 'note <svg onload=alert(1)>', '--ref', 'https://example.com/x"onmouseover="alert(1)', '--agent', 'rev-2']);
  const page = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  for (const raw of ['<script>alert(1)', '<b>a</b>', 'why <i>', '<img src=x', '<svg onload', '"onmouseover="']) assert.ok(!page.includes(raw), `${raw} is escaped`);
  assert.match(page, /Pick &lt;script&gt;alert\(1\)&lt;\/script&gt;\?/);
  assert.match(page, /look &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(page, /href="https:\/\/example\.com\/x&quot;onmouseover=&quot;alert\(1\)"/);
});

test('accepted task gate pips and ledger stop counting tests after the owner changes mode', (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = gateFixture(h);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  h.ok(['project', 'set', '--tests-mode', 'run-only']);
  gateEvidence(h, 'tests', 'checker');
  gateEvidence(h, 'clean', 'checker');
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'reviewer']);
  h.ok(['accept', 'T1']);
  const sheet = () => fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8').match(/<article id="T1"[\s\S]*?<\/article>/)[0];
  assert.match(sheet(), /class="pip pass">tests<\/span>/);
  assert.doesNotMatch(sheet(), /does not count:/);

  h.ok(['project', 'set', '--tests-mode', 'prove']);
  const shown = h.json(['task', 'show', 'T1']);
  assert.equal(shown.status, 'accepted');
  assert.equal(shown.gates.gates.find((g) => g.type === 'tests').ok, false);
  const stale = sheet();
  assert.match(stale, /class="pip missing">tests<\/span>/);
  assert.doesNotMatch(stale, /class="pip pass">tests<\/span>/);
  assert.match(stale, /class="nocount">\(does not count: tests evidence mode run-only no longer matches prove/);

  gateEvidence(h, 'tests', 'checker');
  const checked = sheet();
  assert.match(checked, /class="pip pass">tests<\/span>/);
  assert.equal((checked.match(/does not count: tests evidence mode run-only/g) || []).length, 1, 'older mode stays uncounted after a new matching pass');
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
  await withServers(async (servers) => {
    const viewer = await startServe(servers, h, 'viewer');
    const viewerPage = await (await fetch(viewer)).text();
    assert.doesNotMatch(viewerPage, /data-api="\/api\/tasks\/T5\/rework"/, 'no rework form without the owner');
    const before = log(h).length;
    assert.equal((await post(`${viewer}api/tasks/T5/rework`, tokenOf(viewerPage), { reason: 'forged' })).status, 403);

    const url = await startServe(servers, h);
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
});

test('in a browser, every board write goes through its form: answer, comments, owner-done, rework and tier', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  await withServers(async (servers) => {
    const url = await startServe(servers, h);
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
});

test('in a browser, a change elsewhere updates the board in place and waits while the owner is typing', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  await withServers(async (servers) => {
    const url = await startServe(servers, h);
    const b = await openBrowser(t);
    await b.goto(`${url}#board`);
    await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
    await b.inPage('window.firstLoad = true');

    h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'rebased, CI running', '--agent', 'w-1']);
    await b.until(`document.querySelector('.card[data-key="T1"] .last p').textContent === 'rebased, CI running'`, 'the card to show the new message');
    assert.equal(await b.inPage('window.firstLoad === true && document.querySelector(\'.card[data-key="T1"]\').classList.contains(\'changed\')'), true, 'updated in place, and the card marks the change');

    // History keeps its filters across an update.
    await b.inPage(`(() => { location.hash = 'history'; document.getElementById('hf-messages').click(); const q = document.getElementById('hf-task'); q.value = 'T1'; q.dispatchEvent(new Event('input', { bubbles: true })); q.blur(); })()`);
    h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'CI green', '--agent', 'w-1']);
    await b.until(`document.querySelector('#history').textContent.includes('CI green')`, 'History to show the new message');
    assert.deepEqual(await b.inPage(`[document.getElementById('hf-messages').checked, document.getElementById('hf-task').value, [...document.querySelectorAll('#history .ev')].filter((li) => getComputedStyle(li).display !== 'none' && !li.hidden).every((li) => li.dataset.kind === 'messages' && li.dataset.task === 'T1')]`), [true, 'T1', true]);
    await b.inPage(`location.hash = 'board'`);

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
});

test('live CLI writes keep Plan, its task sheet, scroll and the focused control on desktop and phone', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  for (let i = 0; i < 8; i++) h.ok(['task', 'add', '--title', `Plan task ${i}`, '--acceptance', 'verified']);
  let dep = 'T2';
  for (let i = 0; i < 4; i++) {
    dep = h.ok(['task', 'add', '--title', `Layer ${i}`, '--acceptance', 'verified', '--dep', dep]).match(/T\d+/)[0];
  }
  await withServers(async (servers) => {
    const url = await startServe(servers, h, 'viewer');
    const b = await openBrowser(t);
    const position = `({ main: [document.querySelector('main').scrollLeft, document.querySelector('main').scrollTop], page: [scrollX, scrollY], graph: [document.querySelector('.plan-wrap').scrollLeft, document.querySelector('.plan-wrap').scrollTop] })`;
    for (const [width, height] of [[1280, 800], [390, 844]]) {
      const link = JSON.stringify(width >= 720 ? '#plan .node[data-id="T1"]' : '#plan .layers [href="#T1"]');
      await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await b.goto(`${url}#plan`);
      await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
      await b.inPage(`(() => {
        window.firstLoad = true;
        document.querySelector(${link}).focus({ preventScroll: true });
        document.querySelector('.plan-wrap').scrollLeft = 120;
        document.querySelector('main').scrollTop = 180;
        window.scrollTo(0, 180);
      })()`);
      const plan = await b.inPage(position);
      assert.ok(plan.main[1] > 0 || plan.page[1] > 0, 'the view is scrolled');
      if (width >= 720) assert.ok(plan.graph[0] > 0, 'the graph is scrolled horizontally');
      const update = `place kept at ${width}`;
      h.ok(['task', 'note', 'T1', update, '--agent', 'orchestrator']);
      await b.until(`document.querySelector('#T1 .thread').textContent.includes(${JSON.stringify(update)})`, 'the live state change');
      assert.deepEqual(await b.inPage(`[location.hash, document.documentElement.dataset.view, getComputedStyle(document.querySelector('#plan')).display !== 'none', !!document.querySelector('.sheet.open'), window.firstLoad]`), ['#plan', 'plan', true, false, true]);
      assert.deepEqual(await b.inPage(position), plan, `Plan keeps both scroll axes at ${width}`);
      assert.equal(await b.inPage(`document.activeElement === document.querySelector(${link})`), true, 'the same Plan link keeps focus');

      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await b.until(`document.querySelector('#T1').classList.contains('open')`, 'the task sheet over Plan');
      const background = await b.inPage(position);
      const copy = await b.inPage(`(() => {
        const button = document.querySelector('#T1 .sec:last-child [data-copy]');
        button.focus({ preventScroll: true });
        document.querySelector('#T1 .sbody').scrollTop = 160;
        return button.getAttribute('data-copy');
      })()`);
      const sheetScroll = await b.inPage(`document.querySelector('#T1 .sbody').scrollTop`);
      assert.ok(sheetScroll > 0, 'the task sheet is scrolled');
      h.ok(['task', 'note', 'T1', `${update} with sheet`, '--agent', 'orchestrator']);
      await b.until(`document.querySelector('#T1 .thread').textContent.includes(${JSON.stringify(`${update} with sheet`)})`, 'the task sheet update');
      assert.deepEqual(await b.inPage(`[location.hash, document.documentElement.dataset.view, document.querySelector('.sheet.open').id, document.querySelector('main').inert, document.querySelector('.topbar').inert]`), ['#T1', 'plan', 'T1', true, true]);
      assert.equal(await b.inPage(`document.activeElement.getAttribute('data-copy')`), copy, 'the same sheet button keeps focus');
      assert.equal(await b.inPage(`document.querySelector('#T1 .sbody').scrollTop`), sheetScroll, 'the sheet keeps its scroll');
      assert.deepEqual(await b.inPage(position), background, 'the background keeps its scroll');
      await b.inPage(`document.querySelector('#T1 [data-close]').click()`);
      await b.until(`!document.querySelector('.sheet.open')`, 'the sheet to close');
      assert.deepEqual(await b.inPage(`[location.hash, document.documentElement.dataset.view, document.activeElement === document.querySelector(${link})]`), ['#plan', 'plan', true]);
      assert.deepEqual(await b.inPage(position), background, 'closing the sheet returns to the same place in Plan');
    }
  });
});

test('live updates match task sheet buttons by form and fall back when the focused action is removed', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const b = await openBrowser(t);
  for (const action of ['comments', 'owner-done']) {
    await t.test(action === 'comments' ? 'the focused button survives a removed sibling form' : 'the removed focused button falls back to the heading', async (t) => {
      const h = makeRepo(t);
      h.init();
      h.ok(['task', 'add', '--title', 'Dashboard access', '--acceptance', 'access granted', '--needs-owner', 'grant dashboard access']);
      await withServers(async (servers) => {
        const url = await startServe(servers, h);
        await b.goto(`${url}#T1`);
        await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
        const button = JSON.stringify(`#T1 form[data-api="/api/tasks/T1/${action}"] button[type="submit"]`);
        await b.inPage(`document.querySelector(${button}).focus({ preventScroll: true })`);
        assert.equal(await b.inPage(`document.activeElement === document.querySelector(${button})`), true, 'the action starts focused');

        h.ok(['owner-done', 'T1', '--note', 'access granted']);
        await b.until(`!document.querySelector('#T1 form[data-api="/api/tasks/T1/owner-done"]')`, 'the owner-done form to be removed by the live update');
        assert.deepEqual(await b.inPage(`[location.hash, document.querySelector('.sheet.open').id]`), ['#T1', 'T1'], 'the task sheet stays open');
        const expected = action === 'comments' ? button : JSON.stringify('#T1 h2');
        assert.equal(await b.inPage(`document.activeElement === document.querySelector(${expected})`), true, action === 'comments' ? 'Send comment keeps focus when Mark done disappears' : 'focus moves to the heading when Mark done disappears');
      });
    });
  }
});

test('a viewer cannot edit tiers or the ladder from a sheet, Settings or a forged POST', async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  await withServers(async (servers) => {
    const url = await startServe(servers, h, 'viewer');
    const page = await (await fetch(url)).text();
    const settings = await (await fetch(`${url}settings`)).text();
    assert.doesNotMatch(page, /<form data-api=/, 'viewer sheets and queue are read-only');
    assert.doesNotMatch(settings, /<form|<input|<select|Save ladder|Save tiers/, 'viewer Settings shows values without edit controls');
    assert.match(settings, /Read-only/);
    assert.match(settings, /<code>tower-crane serve --agent owner<\/code>/, 'Settings names the explicit owner command');
    const before = log(h);
    const tasks = h.readState('tasks.json');
    const project = h.readState('project.json');
    const token = tokenOf(page);
    for (const [api, body] of [
      ['tiers', { tiers: { T1: 'hard' }, base: { T1: 'medium' } }],
      ['ladder', { harness: 'claude', base: { harness: 'codex' } }],
    ]) {
      const r = await post(`${url}api/${api}`, token, body);
      assert.equal(r.status, 403, `${api} requires the owner even with this server's token`);
      assert.match((await r.json()).error, /owner/);
    }
    assert.deepEqual(h.readState('tasks.json'), tasks);
    assert.deepEqual(h.readState('project.json'), project);
    assert.deepEqual(log(h), before, 'refusals append no events');
  });
});

test('Working now uses only the current claimant and claim, then the submitter context', (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  const card = () => fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8').match(/<article class="card[^"]*" data-key="T1"[\s\S]*?<\/article>/)[0];
  h.ok(['task', 'note', 'T1', 'orchestrator planning note', '--agent', 'orchestrator']);
  assert.match(card(), /tests green, waiting on CI/);
  assert.doesNotMatch(card(), /orchestrator planning note/);
  h.ok(['release', 'T1', '--reason', 'handoff', '--agent', 'w-1']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  assert.doesNotMatch(card(), /tests green, waiting on CI|orchestrator planning note/, 'a renewed claim by the same worker does not reuse its older message');
  h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'new claim work', '--agent', 'w-1']);
  h.ok(['task', 'note', 'T1', 'reviewer context', '--agent', 'reviewer']);
  assert.match(card(), /new claim work/);
  assert.doesNotMatch(card(), /reviewer context/);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--summary', 'retry verified', '--agent', 'w-1']);
  h.ok(['task', 'note', 'T1', 'review in progress', '--agent', 'reviewer']);
  assert.match(card(), /retry verified/);
  assert.doesNotMatch(card(), /review in progress/);
});

test('budget plates show minutes and leave the Budget label to the group heading', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Usage', '--acceptance', 'usage is reported']);
  h.ok(['project', 'set', '--budget-tokens', '100', '--budget-hours', '1']);
  h.ok(['spend', 'T1', '--tokens', '95', '--minutes', '57', '--agent', 'w-1']);
  const page = () => fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  const plates = page().match(/<article class="plate signal" data-key="budget-[\s\S]*?<\/article>/g);
  assert.equal(plates.length, 2);
  assert.match(page(), /<h3 class="grouph">Budget<\/h3>/);
  assert.match(plates[0], /<p class="q">Tokens at 95%<\/p>/);
  assert.match(plates[0], /95 used of 100/);
  assert.match(plates[1], /<p class="q">Agent time at 95%<\/p>/);
  assert.match(plates[1], /57 min used of 1 h/);
  for (const plate of plates) assert.doesNotMatch(plate, /class="kind">Budget|of the budget/);
  h.ok(['project', 'set', '--budget-hours', '2']);
  h.ok(['spend', 'T1', '--minutes', '57', '--agent', 'w-1']);
  assert.match(page(), /1 h 54 min used of 2 h/);
});

test('budget-only attention agrees across the queue, navigation, title and icon, including live changes', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Usage', '--acceptance', 'usage is reported']);
  h.ok(['project', 'set', '--budget-tokens', '100', '--budget-hours', '1']);
  await withServers(async (servers) => {
    const url = await startServe(servers, h, 'viewer');
    const b = await openBrowser(t);
    await b.goto(`${url}#board`);
    await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
    const originalIcon = await b.inPage(`document.querySelector('link[rel="icon"]').href`);
    h.ok(['spend', 'T1', '--tokens', '95', '--minutes', '57', '--agent', 'w-1']);
    await b.until(`document.querySelector('.col-need').textContent.includes('Tokens at 95%')`, 'budget alerts');
    const counts = await b.inPage(`[document.querySelector('#h-need .n').textContent, document.querySelector('.views a[data-view="board"] .n').textContent, document.title.split(' ')[0], JSON.parse(document.getElementById('boot').textContent).attention]`);
    assert.deepEqual(counts.slice(0, 3), ['2', '2', '(2)']);
    assert.notEqual(await b.inPage(`document.querySelector('link[rel="icon"]').href`), originalIcon);
    const snapshot = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
    assert.match(snapshot, /<title>\(2\)/);
    assert.match(snapshot, /"attention":2/);
    assert.match(snapshot, /aria-label="2 need you">2/);
  });
});

test('desktop columns keep headings visible, reach the last items and keep their scroll on live updates', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init(['--workers', '12']);
  populate(h);
  for (let i = 0; i < 8; i++) {
    h.ok(['ask', '--question', `Owner decision ${i}`, '--option', 'yes', '--option', 'no']);
    const id = h.ok(['task', 'add', '--title', `Worker task ${i}`, '--acceptance', 'verified']).match(/T\d+/)[0];
    h.ok(['claim', id, '--agent', `worker-${i}`]);
    h.ok(['msg', '--task', id, '--to', 'orchestrator', 'checking the retry contract and integration paths', '--agent', `worker-${i}`]);
  }
  await withServers(async (servers) => {
    const url = await startServe(servers, h, 'viewer');
    const b = await openBrowser(t);
    for (const [width, height] of [[3840, 1080], [1920, 1080], [1280, 800]]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await b.goto(`${url}#board`);
      await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
      const metrics = await b.inPage(`['need','work'].map((name) => { const c = document.querySelector('[data-region="' + name + '"]'); c.scrollTop = c.scrollHeight; const last = c.querySelector(name === 'need' ? 'article:last-child' : '.card:last-child'); return [c.clientHeight, c.scrollHeight, c.scrollTop, c.getBoundingClientRect().bottom <= innerHeight, last.getBoundingClientRect().bottom <= c.getBoundingClientRect().bottom + 1]; })`);
      for (const [client, scroll, top, fits, reachable] of metrics) {
        assert.ok(fits && client < height, `column fits at ${width}`);
        assert.ok(scroll > client && top > 0 && reachable, `the last item is reachable at ${width}`);
      }
      for (const theme of ['light', 'dark']) {
        await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
        const headings = await b.inPage(`['need','work','next','since'].map((name) => {
          const c = document.querySelector('[data-region="' + name + '"]');
          c.scrollTop = c.scrollHeight;
          const head = c.querySelector(':scope > .colh, :scope > .since-head');
          const rect = head.getBoundingClientRect();
          const column = c.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + 10, rect.top + 5);
          return [name, getComputedStyle(head).position, Math.abs(rect.top - column.top) < 1, rect.bottom <= column.bottom, head.contains(hit)];
        })`);
        for (const [name, position, top, fits, visible] of headings) {
          assert.equal(position, 'sticky', `${name} heading sticks at ${width} in ${theme}`);
          assert.ok(top && fits && visible, `${name} heading stays visible at the queue end at ${width} in ${theme}`);
        }
      }
      const expected = await b.inPage(`['need','work'].map((name) => { const c = document.querySelector('[data-region="' + name + '"]'); c.scrollTop = 160; return c.scrollTop; })`);
      h.ok(['task', 'note', 'T2', `update at ${width}`, '--agent', 'orchestrator']);
      await b.until(`document.querySelector('.col-since').textContent.includes('update at ${width}')`, 'the live update');
      assert.deepEqual(await b.inPage(`['need','work'].map((name) => document.querySelector('[data-region="' + name + '"]').scrollTop)`), expected, `column roots retain their scroll at ${width}`);
    }
  });
});

test('task sheets contain keyboard focus, restore the invoking link and keep modal state through refresh', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  await withServers(async (servers) => {
    const url = await startServe(servers, h, 'viewer');
    const b = await openBrowser(t);
    await b.goto(`${url}#board`);
    await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
    // Use the link in Working now, not the first T1 link in another column.
    await b.inPage(`(() => { const a = document.querySelector('.col-work [href="#T1"]'); a.focus(); a.click(); })()`);
    await b.until(`document.querySelector('#T1').classList.contains('open')`, 'the sheet');
    assert.equal(await b.inPage(`document.querySelector('#T1 .panel').getAttribute('aria-modal')`), 'true');
    assert.equal(await b.inPage(`document.querySelector('main').inert && document.querySelector('.topbar').inert`), true);
    const tab = async (shift = false) => {
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 });
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 });
    };
    for (let i = 0; i < 12; i++) {
      await tab(i % 2 === 0);
      assert.equal(await b.inPage(`document.querySelector('#T1 .panel').contains(document.activeElement)`), true, 'Tab stays in the sheet');
    }
    h.ok(['msg', '--task', 'T1', '--to', 'orchestrator', 'modal refresh', '--agent', 'w-1']);
    await b.until(`document.querySelector('#T1 .thread').textContent.includes('modal refresh')`, 'the sheet refresh');
    assert.equal(await b.inPage(`document.querySelector('main').inert && document.querySelector('.topbar').inert && document.querySelector('#T1 .panel').contains(document.activeElement)`), true);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await b.until(`!document.querySelector('.sheet.open')`, 'sheet close');
    assert.equal(await b.inPage(`document.activeElement === document.querySelector('.col-work [href="#T1"]') && !document.querySelector('main').inert && !document.querySelector('.topbar').inert`), true, 'focus returns to the same invoking card, even when refreshed');

    h.ok(['ask', '--question', 'Another decision for Metrics?', '--option', 'yes', '--option', 'no', '--blocks', 'T4']);
    await b.until(`document.querySelector('.col-need [data-key="D2"]')`, 'the second decision');
    await b.inPage(`(() => { const a = document.querySelector('.col-need [data-key="D2"] [href="#T4"]'); a.focus(); a.click(); })()`);
    await b.until(`document.querySelector('#T4').classList.contains('open')`, 'the Metrics sheet');
    h.ok(['task', 'note', 'T4', 'receipt available', '--agent', 'reviewer']);
    await b.until(`document.querySelector('#T4 .thread').textContent.includes('receipt available')`, 'the sheet refresh');
    await b.inPage(`document.querySelector('#T4 [data-close]').click()`);
    await b.until(`!document.querySelector('.sheet.open')`, 'sheet close');
    assert.equal(await b.inPage(`document.activeElement === document.querySelector('.col-need [data-key="D2"] [href="#T4"]')`), true, 'duplicate task links in one column return to the invoking decision, not its first neighbor');
  });
});

test('phone gates keep whole names and states in both themes without horizontal overflow', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  populate(h);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'w-1']);
  const b = await openBrowser(t);
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: false });
  for (const theme of ['light', 'dark']) {
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    await b.goto(`${pathToFileURL(path.join(h.state, 'sketch.html')).href}#T1`);
    const gates = await b.inPage(`(() => { const table = document.querySelector('#T1 .gates-tbl'); return { fits: table.getBoundingClientRect().right <= innerWidth && table.scrollWidth <= table.clientWidth, cells: [...table.querySelectorAll('th, td:nth-child(2)')].map((c) => { const range = document.createRange(); range.selectNodeContents(c.querySelector('.pip') || c); return [c.textContent, range.getClientRects().length]; }) }; })()`);
    assert.equal(gates.fits, true, `gates fit in ${theme}`);
    for (const [label, lines] of gates.cells) assert.equal(lines, 1, `${label} stays whole in ${theme}`);
  }
});
