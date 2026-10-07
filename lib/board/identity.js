'use strict';

const { createHash } = require('node:crypto');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const CONTROLS = new Set(['a', 'button', 'input', 'textarea', 'select', 'summary', 'details', 'main']);
const ANCHORS = ['data-key', 'id', 'data-event', 'data-mention', 'data-id', 'data-disclosure', 'data-scroll', 'data-region', 'data-api', 'data-rung', 'data-task'];
const ATTRS = ['name', 'type', 'href', 'data-copy', 'data-close', 'data-hide-done', 'data-discard', 'aria-labelledby', 'tabindex'];

// Own markup is escaped before this pass. Raw text blocks must stay intact:
// script and style contents can contain strings that look like HTML tags.
function preserve(html, { strict = false } = {}) {
  const stack = [];
  const keys = new Set();
  return html.replace(/<(script|style|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?[a-z][^>]*>/gi, (token) => {
    const start = /^<(\/?)([a-z][\w:-]*)\b([^>]*)>/i.exec(token);
    if (!start) return token;
    const [, closing, name, tail] = start;
    const tag = name.toLowerCase();
    if (closing) {
      if (stack.at(-1)?.tag !== tag) throw new Error(`unbalanced board markup: ${tag}`);
      stack.pop();
      return token;
    }
    if (tag === 'script' || tag === 'style') return token;
    const attrs = {};
    for (const a of tail.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g)) attrs[a[1]] = a[2] ?? a[3] ?? a[4] ?? '';
    const anchor = ANCHORS.find((attr) => Object.hasOwn(attrs, attr));
    const role = anchor ? [tag, anchor, attrs[anchor]]
      : [tag, ...ATTRS.filter((attr) => Object.hasOwn(attrs, attr)).flatMap((attr) => [attr, attrs[attr]])];
    if (!anchor && tag === 'button' && Object.hasOwn(attrs, 'value')) role.push('value', attrs.value);
    if (role.length === 1 && attrs.class) role.push('class', attrs.class);
    const path = attrs['data-identity'] ? [['identity', attrs['data-identity']]] : [...(stack.at(-1)?.path || []), role];
    const target = CONTROLS.has(tag) || Object.hasOwn(attrs, 'tabindex') || Object.hasOwn(attrs, 'data-scroll') || Object.hasOwn(attrs, 'data-region');
    let result = token;
    if (target) {
      const base = createHash('sha256').update(JSON.stringify(path)).digest('hex');
      let key = base;
      if (strict && keys.has(key)) throw new Error(`duplicate board preservation identity: ${JSON.stringify(path)}`);
      // A missing row key must not take down the board or block state writes.
      for (let suffix = 2; keys.has(key); suffix++) key = `${base}-${suffix}`;
      keys.add(key);
      result = token.replace(start[0], start[0].replace(/(\/?>)$/, ` data-preserve="${key}"$1`));
    }
    if (!VOID.has(tag) && !/\/>$/.test(start[0]) && tag !== 'textarea') stack.push({ tag, path });
    return result;
  });
}

module.exports = { preserve };
