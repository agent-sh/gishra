'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { refuse, usage } = require('./util');
const S = require('./state');
const R = require('./render');

const WATCHED = ['tasks.json', 'decisions.json', 'project.json'];
const RELOAD = '<script>new EventSource("events").addEventListener("reload", function () { location.reload(); });</script>\n';

function signature(dir) {
  return WATCHED.map((f) => {
    try {
      const s = fs.statSync(path.join(dir, f));
      return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      return '-';
    }
  }).join('|');
}

// Pages are rendered from the state on each request rather than read from
// sketch.html, so a reload never races the CLI's own re-render.
function page(dir) {
  try {
    return { code: 200, body: R.renderHtml(S.loadState(dir), Date.now(), RELOAD) };
  } catch (e) {
    return { code: 500, body: `<!doctype html><meta charset="utf-8"><title>gishra</title>${RELOAD}<pre>${String(e.message).replace(/</g, '&lt;')}</pre>` };
  }
}

function serve(ctx) {
  const dir = ctx.stateDir;
  S.loadState(dir);
  const port = ctx.flags.port !== undefined ? ctx.flags.port : 4747;
  if (port < 0 || port > 65535) throw usage('--port must be between 0 and 65535');
  const clients = new Set();
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/sketch.html') {
      const p = page(dir);
      res.writeHead(p.code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(p.body);
    } else if (url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
    }
  });

  let last = signature(dir);
  let timer = null;
  const check = () => {
    const sig = signature(dir);
    if (sig === last) return;
    last = sig;
    for (const res of clients) res.write('event: reload\ndata: {}\n\n');
  };
  // Renames replace the files, so watch the directory and debounce bursts.
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(check, 60);
  };
  let watcher = null;
  let poll = null;
  const startPolling = () => {
    if (!poll) poll = setInterval(check, 1000);
  };
  try {
    watcher = fs.watch(dir, (event, name) => {
      if (!name || WATCHED.includes(String(name))) schedule();
    });
    watcher.on('error', startPolling);
  } catch {
    startPolling();
  }
  const keepAlive = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 20000);

  return new Promise((resolve, reject) => {
    server.on('error', (e) => reject(e.code === 'EADDRINUSE' ? refuse(`port ${port} is in use; pass --port P (0 picks a free one)`) : e));
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      process.stdout.write(ctx.json ? JSON.stringify({ url, state: dir }) + '\n' : `serving ${url} (state ${dir}); Ctrl-C stops\n`);
      const stop = () => {
        clearInterval(keepAlive);
        clearInterval(poll);
        clearTimeout(timer);
        if (watcher) watcher.close();
        for (const res of clients) res.end();
        server.close(() => resolve({ printed: true }));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  });
}

module.exports = { serve };
