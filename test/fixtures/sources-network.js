'use strict';

// CLI fixtures inject the transport through the gate context. Production has
// no setting or environment variable that permits private source addresses.
const gate = require('../../lib/gates/sources');
const run = gate.run;
const realFetch = global.fetch;
const pin = process.env.HOOK_SOURCES_PIN === '1';
let lookups = 0;
const fixtureFetch = (url, options) => {
  const at = new URL(url);
  at.protocol = 'http:';
  at.host = new URL(process.env.HOOK_SOURCES_ORIGIN).host;
  return realFetch(at, { ...options, redirect: 'manual' });
};
// Keep before-change proof runs offline even when the old gate ignores injection.
global.fetch = fixtureFetch;
if (pin) {
  const http = require('node:http');
  const original = http.request;
  http.request = (url, options, callback) => {
    const assert = require('node:assert/strict');
    assert.equal(url.hostname, 'source.example');
    assert.equal(options.agent, false);
    assert.equal(lookups, 1, 'connecting must not resolve the hostname again');
    let address;
    options.lookup(url.hostname, { all: false }, (error, value, family) => {
      assert.equal(error, null);
      assert.equal(family, 4);
      address = value;
    });
    assert.equal(address, '93.184.216.34');
    options.lookup(url.hostname, { all: true }, (error, values) => {
      assert.equal(error, null);
      assert.deepEqual(values, [{ address, family: 4 }]);
    });
    require('node:fs').writeFileSync(process.env.HOOK_SOURCES_TRACE, JSON.stringify({ lookups, address, host: url.host }));
    const at = new URL(url);
    at.host = new URL(process.env.HOOK_SOURCES_ORIGIN).host;
    return original(at, { ...options, lookup: undefined, headers: { ...options.headers, Host: url.host } }, callback);
  };
}
gate.run = ctx => run({
  ...ctx,
  resolveHost: async hostname => {
    lookups++;
    if (pin && lookups > 1) return [{ address: '127.0.0.1', family: 4 }];
    if (hostname === 'private.example') return [{ address: '10.0.0.1', family: 4 }];
    if (hostname === 'mixed.example') return [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
    if (hostname === 'source.example') return [{ address: '93.184.216.34', family: 4 }];
    throw new Error('unexpected fixture DNS lookup');
  },
  ...(!pin ? { fetchPage: async (url, options) => {
    require('node:assert/strict').equal(options.addresses[0].address, '93.184.216.34');
    return fixtureFetch(url, options);
  } } : {}),
});
