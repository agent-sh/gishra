'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { makeRepo } = require('./helpers');

async function fixture(t) {
  const requests = [];
  const bodies = new Map(Array.from({ length: 10 }, (_, i) => [
    `/${i}`, `<p>Page ${i} says <b>water</b> &amp; light.</p><script>hidden claim</script>`,
  ]));
  bodies.set('/copy', '<p>Page 0 says <b>water</b> &amp; light.</p>');
  bodies.set('/inline', '<p>The result is <strong>42</strong>.</p><p>A<em>B</em>C is adjacent.</p>');
  bodies.set('/blocks', '<p>First paragraph.</p><p>Second paragraph.</p>');
  const redirects = new Map([
    ['/alias', '/0'], ['/private-redirect', 'http://private.example/secret'],
    ['/loopback-redirect', 'http://127.0.0.1/secret'],
    ['/public-redirect', 'http://source.example/inline'],
    ['/second-hop', 'http://source.example/private-redirect'],
  ]);
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (redirects.has(req.url)) { res.writeHead(302, { location: redirects.get(req.url) }); res.end(); return; }
    if (!bodies.has(req.url)) { res.writeHead(404); res.end('missing'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(bodies.get(req.url));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://source.example';
  const h = makeRepo(t);
  const preload = path.join(__dirname, 'fixtures', 'sources-network.js');
  h.env.NODE_OPTIONS = `${h.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`;
  h.env.HOOK_SOURCES_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  h.init();
  h.ok(['task', 'add', '--title', 'Research', '--kind', 'research', '--acceptance', 'claims have sources']);
  h.ok(['claim', 'T1', '--agent', 'researcher']);
  const wt = h.json(['worktree', 'T1']).path;
  const doc = {
    sources: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, url: `${base}/${i}` })),
    claims: Array.from({ length: 10 }, (_, i) => ({
      claim: `Page ${i} discusses water and light.`,
      quote: `Page ${i} says water & light.`,
      source: `s${i}`,
    })),
  };
  function submit(value = doc) {
    fs.mkdirSync(path.join(wt, 'research'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'research', 'T1.json'), JSON.stringify(value));
    h.git(['add', 'research'], wt);
    h.git(['commit', '-q', '--allow-empty', '-m', 'research sources'], wt);
    const sha = h.git(['rev-parse', 'HEAD'], wt);
    h.ok(['submit', 'T1', '--agent', 'researcher', '--sha', sha]);
    return sha;
  }
  return { h, wt, doc, requests, submit };
}

test('sources gate fetches ten cited pages at the submitted commit and records an audited receipt', async (t) => {
  const { h, wt, doc, requests, submit } = await fixture(t);
  const sha = submit();
  fs.writeFileSync(path.join(wt, 'research', 'T1.json'), '{}');
  const result = await h.runAsync(['check', 'sources', 'T1', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.sha, sha);
  assert.equal(receipt.receipt.min_sources, 10);
  assert.equal(receipt.receipt.sources.length, 10);
  assert.equal(requests.length, 10);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find(g => g.type === 'sources').ok, true);
  assert.equal(h.run(['evidence', 'T1', '--type', 'sources', '--ok']).code, 1);
  // Every check must reach the pages again, even when evidence already passed.
  assert.equal((await h.runAsync(['check', 'sources', 'T1'])).code, 0);
  assert.equal(requests.length, 20);
  h.ok(['project', 'set', '--research-min-sources', '11']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find(g => g.type === 'sources').ok, false);
  const state = require('../lib/state').loadState(h.state);
  const board = require('../lib/board/model').build(state);
  assert.equal(board.sheets[0].ledger[0].entries.find(e => e.type === 'sources').counts, false);
  assert.match(board.history.find(e => e.cmd === 'check sources').text, /sources/);
  assert.equal((await h.runAsync(['check', 'sources', 'T1'])).code, 1);
  h.ok(['project', 'set', '--research-min-sources', '2']);
  assert.equal((await h.runAsync(['check', 'sources', 'T1'])).code, 0);
  const review = h.json(['spawn', '--role', 'review', '--task', 'T1', '--dry-run']);
  assert.match(review.argv.join('\n'), /each claim maps to a cited source/);
  assert.equal(doc.claims.length, 10);
});

test('sources gate keeps punctuation and adjacent text around inline markup and separates blocks', async (t) => {
  const { h, doc, requests, submit } = await fixture(t);
  doc.sources[0].url = 'http://source.example/inline';
  doc.claims[0].quote = 'The result is 42. ABC is adjacent.';
  doc.sources[1].url = 'http://source.example/blocks';
  doc.claims[1].quote = 'First paragraph. Second paragraph.';
  submit();
  const result = await h.runAsync(['check', 'sources', 'T1']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(requests.includes('/inline'));
});

test('sources gate validates a public redirect hop and preserves its final URL', async (t) => {
  const { h, doc, submit } = await fixture(t);
  doc.sources[0].url = 'http://source.example/public-redirect';
  doc.claims[0].quote = 'The result is 42.';
  submit();
  const result = await h.runAsync(['check', 'sources', 'T1', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).receipt.sources[0].final_url, 'http://source.example/inline');
});

test('sources gate pins its DNS answer for the real HTTP transport despite rebinding', async (t) => {
  const { h, doc, requests, submit } = await fixture(t);
  h.env.HOOK_SOURCES_PIN = '1';
  h.env.HOOK_SOURCES_TRACE = path.join(h.base, 'socket.json');
  h.ok(['project', 'set', '--research-min-sources', '1']);
  doc.sources = doc.sources.slice(0, 1);
  doc.claims = doc.claims.slice(0, 1);
  submit();
  const result = await h.runAsync(['check', 'sources', 'T1']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.env.HOOK_SOURCES_TRACE, 'utf8')), {
    lookups: 1, address: '93.184.216.34', host: 'source.example',
  });
  assert.deepEqual(requests, ['/0']);
});

for (const [url, expectedRequests] of [
  ['http://127.0.0.1/secret', []], ['http://10.0.0.1/secret', []],
  ['http://172.16.0.1/secret', []], ['http://192.168.0.1/secret', []],
  ['http://169.254.169.254/latest/meta-data', []], ['http://100.64.0.1/secret', []],
  ['http://[::1]/secret', []], ['http://[fc00::1]/secret', []],
  ['http://[fe80::1]/secret', []], ['http://[::ffff:127.0.0.1]/secret', []],
  ['http://2130706433/secret', []], ['http://private.example/secret', []],
  ['http://mixed.example/secret', []],
  ['http://source.example/private-redirect', ['/private-redirect']],
  ['http://source.example/loopback-redirect', ['/loopback-redirect']],
  ['http://source.example/second-hop', ['/second-hop', '/private-redirect']],
]) {
  test(`sources gate refuses non-public address or redirect ${url} before connecting`, async (t) => {
    const { h, doc, requests, submit } = await fixture(t);
    doc.sources[0].url = url;
    submit();
    const result = await h.runAsync(['check', 'sources', 'T1']);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /non-public address/);
    assert.deepEqual(requests, expectedRequests);
  });
}

test('sources gate follows the research role when kind changes without moving the task tier', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--kind', 'docs', '--title', 'Worker task', '--acceptance', 'reviewed']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', sha]);
  h.ok(['evidence', 'T1', '--agent', 'reviewer', '--type', 'review', '--ok', '--sha', sha]);
  h.ok(['task', 'update', 'T1', '--kind', 'research']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  h.ok(['task', 'update', 'T1', '--tier', 'research']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find(g => g.type === 'sources').ok, false);
});

for (const [name, mutate, pattern] of [
  ['dead link', d => { d.sources[9].url = d.sources[9].url.replace('/9', '/dead'); }, /HTTP 404/],
  ['duplicate URL', d => { d.sources[9].url = `${d.sources[0].url}#section`; }, /duplicate URL/],
  ['duplicate redirect page', d => { d.sources[9].url = d.sources[9].url.replace('/9', '/alias'); }, /duplicate page/],
  ['duplicate page content', d => { d.sources[9].url = d.sources[9].url.replace('/9', '/copy'); }, /duplicate page/],
  ['quote absent from page', d => { d.claims[9].quote = 'not on the page'; }, /quote.*not found/],
  ['hidden script quote', d => { d.claims[9].quote = 'hidden claim'; }, /quote.*not found/],
  ['uncited URL', d => { d.claims.pop(); }, /uncited source/],
  ['unmapped claim', d => { d.claims[9].source = 'missing'; }, /unknown source/],
  ['too few sources', d => { d.sources.pop(); d.claims.pop(); }, /at least 10/],
]) {
  test(`sources gate rejects ${name} and prevents review dispatch`, async (t) => {
    const { h, doc, submit } = await fixture(t);
    mutate(doc);
    submit();
    const result = await h.runAsync(['check', 'sources', 'T1']);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, pattern);
    const review = h.run(['spawn', '--role', 'review', '--task', 'T1', '--dry-run']);
    assert.equal(review.code, 1, review.stderr);
    assert.match(review.stderr, /sources/);
  });
}

test('research source minimum refuses invalid values and worker changes', (t) => {
  const h = makeRepo(t);
  h.init();
  for (const value of ['0', '-1', '1.5']) assert.equal(h.run(['project', 'set', '--research-min-sources', value]).code, 2);
  assert.equal(h.run(['project', 'set', '--research-min-sources', '1', '--agent', 'worker-T1-1']).code, 1);
  h.ok(['project', 'set', '--research-min-sources', '3']);
  assert.equal(h.json(['project', 'show']).research.min_sources, 3);
});
