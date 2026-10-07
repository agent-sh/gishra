'use strict';

const { StringDecoder } = require('node:string_decoder');

// Only harness envelopes count. Text quoted in a tool result is never parsed.
function reader(harness, send) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let oversized = false;
  function line(text) {
    let e;
    try { e = JSON.parse(text); } catch { return; }
    if (!e || typeof e !== 'object') return;
    const item = e.item || {};
    if (['codex', 'command'].includes(harness) && e.type === 'item.completed') {
      if (['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(item.type)) send('tool', { tool: item.type });
      if (item.type === 'agent_message') send('report', { report: item.text });
    } else if (['claude', 'agy', 'command'].includes(harness) && e.type === 'result') {
      send('report', { report: e.result });
    } else if (harness === 'pi' && e.type === 'message_end' && e.message?.role === 'assistant') {
      send('report', { report: (e.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') });
    } else if (['pi', 'agy', 'command'].includes(harness) && e.type === 'tool_execution_end') {
      send('tool', { tool: e.toolName });
    } else if (harness === 'opencode') {
      if (e.type === 'tool_use') send('tool', { tool: e.part?.tool });
      if (e.type === 'text') send('report', { report: e.part?.text });
    }
  }
  return (chunk, final = false) => {
    const text = chunk ? decoder.write(chunk) : final ? decoder.end() : '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      pending += lines[i];
      if (pending.length > 1024 * 1024) { oversized = true; pending = ''; }
      if (i < lines.length - 1 || final) {
        if (!oversized) line(pending);
        pending = '';
        oversized = false;
      }
    }
  };
}

module.exports = { reader };
