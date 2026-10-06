'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const { makeRepo, BIN } = require('./helpers');

async function startServe(h) {
  const server = cp.spawn(process.execPath, [BIN, 'serve', '--port', '0', '--json', '--agent', 'owner'], { cwd: h.repo, env: h.env });
  const exited = new Promise((resolve) => server.on('exit', resolve));
  const url = await new Promise((resolve, reject) => {
    let out = '';
    server.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0]).url);
    });
    server.on('exit', (code) => reject(new Error(`serve exited ${code}`)));
  });
  // Windows cannot delete a directory a live process runs in, so the server
  // must be gone before makeRepo's cleanup removes the repo.
  return { url, stop: async () => { server.kill(); await exited; } };
}

function request(url, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(url, { method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // Pages are HTML.
        }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const read = (h, f) => fs.readFileSync(path.join(h.state, f), 'utf8');
const events = (h) => read(h, 'events.jsonl').trim().split('\n').map((l) => JSON.parse(l));

test('the Settings view edits the ladder and task tiers only with the page token, through the CLI write path', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Webhook retries', '--acceptance', 'a']);
  const s = await startServe(h);
  try {
    const page = await request(`${s.url}settings`);
    assert.equal(page.status, 200);
    const token = /<meta name="gishra-token" content="([0-9a-f]{48})">/.exec(page.text)[1];
    assert.match(page.text, /<label for="harness">Default harness<\/label>/);
    assert.match(page.text, /<input name="model" value="opus" data-initial="opus" aria-labelledby="r-hard c-model"/);
    assert.match(page.text, /<select name="tier" aria-labelledby="t-T1 c-tier" data-initial="medium">/);
    assert.match((await request(s.url)).text, /<a href="settings">Settings<\/a>/, 'the sketch links to Settings');
    assert.notEqual((await startAgain(h)).token, token, 'each run has its own token');

    const ladder = `${s.url}api/ladder`;
    const project = read(h, 'project.json');
    const change = { rungs: { easy: { harness: '', model: 'gpt-x', profile: '', provider: '', effort: 'low', args: '["--skip-git-repo-check"]', command: '' } } };
    const refused = [
      [{}, 403, /missing or wrong token/],
      [{ 'x-gishra-token': 'f'.repeat(48) }, 403, /missing or wrong token/],
      [{ 'x-gishra-token': token, origin: 'http://evil.example' }, 403, /other origins/],
      [{ 'x-gishra-token': token, host: 'evil.example' }, 403, /forbidden host/],
    ];
    for (const [headers, status, message] of refused) {
      const r = await request(ladder, { method: 'POST', body: change, headers });
      assert.equal(r.status, status, JSON.stringify(headers));
      assert.match(r.text, message);
    }
    assert.equal(read(h, 'project.json'), project, 'a POST without the token writes nothing');

    const invalid = await request(ladder, { method: 'POST', headers: { 'x-gishra-token': token }, body: { rungs: { easy: { harness: 'pi', model: '', profile: 'luna', effort: 'medium' } } } });
    assert.equal(invalid.status, 400);
    assert.match(invalid.json.error, /^ladder easy \(pi\): profile applies only to codex, needs a model$/);
    const badArgs = await request(ladder, { method: 'POST', headers: { 'x-gishra-token': token }, body: { rungs: { small: { args: 'not json' } } } });
    assert.equal(badArgs.status, 400);
    assert.match(badArgs.json.error, /^ladder small: args must be a JSON array of strings/);
    assert.equal(read(h, 'project.json'), project, 'a refused value leaves project.json unchanged');

    const saved = await request(ladder, { method: 'POST', headers: { 'x-gishra-token': token }, body: change });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(h.readState('project.json').ladder.easy, { model: 'gpt-x', effort: 'low', args: ['--skip-git-repo-check'] });
    const ev = events(h).find((e) => e.cmd === 'ladder set');
    assert.deepEqual([ev.agent, ev.detail.rung, ev.detail.via], ['owner', 'easy', 'serve']);
    assert.match(read(h, 'sketch.html'), /<td class="id">easy<\/td><td>codex \(default\)<\/td><td>gpt-x<\/td>/, 'the write re-rendered the sketch');

    const harness = await request(ladder, { method: 'POST', headers: { 'x-gishra-token': token }, body: { harness: 'agy', rungs: { medium: { model: 'gemini-3-pro', profile: '' }, review: { model: 'gemini-3-pro', profile: '' }, small: { model: 'gemini-3-flash', profile: '' }, easy: { model: 'gemini-3-flash' } } } });
    assert.equal(harness.status, 200, harness.text);
    assert.equal(h.json(['ladder', 'show']).ladder.medium.harness, 'agy', 'the default harness and rungs change in one write');

    const tiers = `${s.url}api/tiers`;
    const tasks = read(h, 'tasks.json');
    assert.equal((await request(tiers, { method: 'POST', body: { tiers: { T1: 'hard' } } })).status, 403);
    const badTier = await request(tiers, { method: 'POST', headers: { 'x-gishra-token': token }, body: { tiers: { T1: 'expert' } } });
    assert.equal(badTier.status, 400);
    assert.match(badTier.json.error, /^T1: tier must be one of easy, medium, hard, research/);
    assert.equal(read(h, 'tasks.json'), tasks);
    const tier = await request(tiers, { method: 'POST', headers: { 'x-gishra-token': token }, body: { tiers: { T1: 'hard' } } });
    assert.equal(tier.status, 200, tier.text);
    assert.equal(h.readState('tasks.json').tasks[0].tier, 'hard');
    const tierEv = events(h).filter((e) => e.cmd === 'task update').pop();
    assert.deepEqual([tierEv.task, tierEv.detail], ['T1', { tier: 'hard', via: 'serve' }]);
    assert.match((await request(`${s.url}settings`)).text, /Last change: T1 tier hard by owner from serve/);
  } finally {
    await s.stop();
  }
});

// A second server on the same state, to show the token is per run.
async function startAgain(h) {
  const s = await startServe(h);
  try {
    const page = await request(`${s.url}settings`);
    return { token: /<meta name="gishra-token" content="([0-9a-f]{48})">/.exec(page.text)[1] };
  } finally {
    await s.stop();
  }
}
