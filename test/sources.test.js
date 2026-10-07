'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { makeRepo } = require('./helpers');

async function fixture(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/dead') { res.writeHead(404); res.end('missing'); return; }
    if (req.url === '/alias') { res.writeHead(302, { location: '/0' }); res.end(); return; }
    if (req.url === '/copy') { res.end('<p>Page 0 says <b>water</b> &amp; light.</p>'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<p>Page ${req.url.slice(1)} says <b>water</b> &amp; light.</p><script>hidden claim</script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = makeRepo(t);
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
