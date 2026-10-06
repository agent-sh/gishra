'use strict';

// Drives a page in headless Chrome over the DevTools protocol, for the tests
// that check what the serve pages do in a browser. Node's own fetch and
// WebSocket are enough, so it adds no dependency; tests skip when no Chrome
// is installed (TOWER_CRANE_TEST_CHROME names one that is not on PATH).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];

function findChrome() {
  if (process.env.TOWER_CRANE_TEST_CHROME) return process.env.TOWER_CRANE_TEST_CHROME;
  if (typeof WebSocket === 'undefined') return null;
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of NAMES) {
      const file = path.join(dir, name);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

const CHROME = findChrome();

async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function openBrowser(t) {
  const profile = fs.mkdtempSync(path.join(process.env.TOWER_CRANE_TEST_TMP || os.tmpdir(), 'tower-crane-chrome-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions'];
  if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  const proc = cp.spawn(CHROME, [...args, 'about:blank'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => proc.on('exit', resolve));
  t.after(async () => {
    proc.kill();
    await exited;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const portFile = path.join(profile, 'DevToolsActivePort');
  const port = await until(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0], 'Chrome to start');
  const targets = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find((x) => x.type === 'page');
  }, 'a Chrome page');
  const ws = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  // Protocol events (Network.requestWillBeSent and the like), in order.
  const seen = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.method) seen.push(msg);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  t.after(() => ws.close());
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  // Runs an expression in the page and returns its value; a promise is awaited.
  const inPage = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
    return r.result.value;
  };
  return {
    send,
    seen,
    inPage,
    // Types into whatever has focus, as a keyboard would: a disabled field
    // cannot hold focus, so nothing lands there.
    type: (text) => send('Input.insertText', { text }),
    until: (expression, what, ms) => until(() => inPage(expression).catch(() => false), what, ms),
    goto: async (url) => {
      await send('Page.navigate', { url });
      await until(() => inPage(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`).catch(() => false), `${url} to load`);
    },
  };
}

module.exports = { CHROME, openBrowser };
