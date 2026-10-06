'use strict';

const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const S = require('./state');

function sessionId(text, harness) {
  try {
    const value = JSON.parse(text);
    const id = (harness === 'codex' || harness === 'command') && value.type === 'thread.started'
      ? value.thread_id
      : (harness === 'claude' || harness === 'command') && value.type === 'result'
        ? value.session_id : null;
    return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function reader(harness) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let id = null;
  return {
    push(chunk, final = false) {
      if (id) return id;
      pending += chunk ? decoder.write(chunk) : '';
      if (final) pending += decoder.end();
      const lines = pending.split(/\r?\n/);
      pending = final ? '' : lines.pop();
      for (const line of lines) {
        id = sessionId(line, harness);
        if (id) break;
      }
      return id;
    },
  };
}

function logReader(log, harness, offset = 0) {
  if (!log) return () => null;
  const parse = reader(harness);
  return (final = false) => {
    let fd;
    try {
      fd = fs.openSync(log, 'r');
      const chunk = Buffer.alloc(64 * 1024);
      let n;
      while ((n = fs.readSync(fd, chunk, 0, chunk.length, offset)) > 0) {
        offset += n;
        const id = parse.push(chunk.subarray(0, n));
        if (id) return id;
      }
      return parse.push(null, final);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
}

function receipt(st, emit, task, detail, id) {
  const attempt = st.events.find((e) => e.cmd === 'spawn' && e.task === task
    && e.detail.agent === detail.agent && e.detail.pid === detail.pid && e.detail.attempt === detail.attempt);
  if (!attempt || st.events.some((e) => e.cmd === 'spawn session' && e.task === task
    && e.detail.pid === detail.pid && e.detail.attempt === detail.attempt)) return;
  emit(task, { ...attempt.detail, session_id: id }, 'spawn session');
}

function record(ctx, detail, id, waitMs) {
  S.mutate(ctx, 'spawn session', (st, emit) => receipt(st, emit, ctx.task, detail, id), waitMs);
}

module.exports = { sessionId, reader, logReader, receipt, record };
