'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');

const IPV4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
];
const v4 = address => address.split('.').reduce((out, part) => out * 256 + Number(part), 0);
const inV4Block = (address, base, bits) => Math.floor(address / 2 ** (32 - bits)) === Math.floor(v4(base) / 2 ** (32 - bits));

function v6(address) {
  const text = address.replace(/\d+\.\d+\.\d+\.\d+$/, tail => {
    const n = v4(tail);
    return `${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  });
  const [left, right] = text.split('::').map(part => part ? part.split(':') : []);
  const words = right ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return words.reduce((out, word) => (out << 16n) + BigInt(`0x${word}`), 0n);
}

function publicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = net.isIP(address);
  if (family === 4) return !IPV4_BLOCKS.some(([base, bits]) => inV4Block(v4(address), base, bits));
  if (family !== 6) return false;
  const n = v6(address);
  const prefix = (base, bits) => (n >> BigInt(128 - bits)) === (v6(base) >> BigInt(128 - bits));
  // Only global unicast, excluding documentation, transition and special-use
  // ranges. This also excludes IPv4-mapped, NAT64, local and scoped addresses.
  return prefix('2000::', 3) && !prefix('2001::', 23) && !prefix('2001:db8::', 32)
    && !prefix('2002::', 16) && !prefix('3fff::', 20);
}

async function abortable(promise, signal) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

async function addressesFor(url, resolveHost, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = net.isIP(hostname);
  const addresses = family ? [{ address: hostname, family }]
    : await abortable(resolveHost(hostname), signal);
  if (!Array.isArray(addresses) || !addresses.length) throw new Error('source host resolved to no addresses');
  if (addresses.some(item => !item || !publicAddress(item.address) || net.isIP(item.address) !== item.family)) {
    throw new Error('source host resolves to a non-public address');
  }
  return addresses;
}

// Pin the validated DNS answer for the socket while retaining the original
// hostname for the Host header, TLS SNI and certificate verification.
function requestPage(url, { addresses, signal, headers }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const selected = addresses[0];
    const request = client.request(url, {
      method: 'GET', agent: false, signal, headers,
      lookup: (hostname, options, callback) => {
        if (options.all) callback(null, addresses);
        else callback(null, selected.address, selected.family);
      },
    }, response => {
      let body = response;
      const encoding = response.headers['content-encoding'];
      const decoder = new Map([
        ['gzip', zlib.createGunzip], ['deflate', zlib.createInflate], ['br', zlib.createBrotliDecompress],
      ]).get(encoding);
      if (decoder) {
        body = decoder();
        response.on('error', error => body.destroy(error));
        body.on('close', () => response.destroy());
        body.on('error', reject);
        response.pipe(body);
      }
      resolve({
        status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: new Headers(response.headers), body,
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function closeBody(body) {
  if (body && typeof body.destroy === 'function') body.destroy();
  else if (body && !body.locked) await body.cancel().catch(() => undefined);
}

function sourceUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('source must be an HTTP(S) URL without credentials');
  }
  url.hash = '';
  return url;
}

async function fetchPublic(value, { signal, headers }, ctx) {
  const resolveHost = ctx.resolveHost || (hostname => dns.lookup(hostname, { all: true, verbatim: true }));
  const fetchPage = ctx.fetchPage || requestPage;
  let url = sourceUrl(value);
  for (let hop = 0; hop <= 5; hop++) {
    signal.throwIfAborted();
    const addresses = await addressesFor(url, resolveHost, signal);
    signal.throwIfAborted();
    const response = await fetchPage(url, { addresses, signal, headers, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: url.href };
    await closeBody(response.body);
    const location = response.headers.get('location');
    if (!location) throw new Error(`HTTP ${response.status} redirect has no Location`);
    if (hop === 5) throw new Error('source exceeds five redirects');
    url = sourceUrl(new URL(location, url));
  }
}

module.exports = { fetchPublic, closeBody };
