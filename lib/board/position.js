'use strict';

// Shared by region updates and Settings reloads, where the document changes.
const POSITION = `
(function () {
  function nodes(scope) {
    return (scope.nodeType === 1 ? [scope] : []).concat(Array.prototype.slice.call(scope.querySelectorAll('*')));
  }
  function identity(el, scope) {
    var path = [];
    while (el && el.nodeType === 1) {
      var part = [el.tagName];
      ['id', 'data-scroll', 'data-region', 'data-key', 'data-id', 'data-rung', 'data-task', 'data-api'].forEach(function (attr) {
        if (el.hasAttribute(attr)) part.push(attr, el.getAttribute(attr));
      });
      path.unshift(part);
      if (el === scope) break;
      el = el.parentElement;
    }
    return JSON.stringify(path);
  }
  function capture(scope) {
    var scroll = Object.create(null);
    nodes(scope).forEach(function (el) {
      var overflow = el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
      if (!el.scrollLeft && !el.scrollTop && (!overflow || !/auto|scroll/.test(getComputedStyle(el).overflow))) return;
      scroll[identity(el, scope)] = [el.scrollLeft, el.scrollTop];
    });
    return scroll;
  }
  function restore(scope, scroll) {
    nodes(scope).forEach(function (el) {
      var xy = scroll[identity(el, scope)];
      if (xy) { el.scrollLeft = xy[0]; el.scrollTop = xy[1]; }
    });
  }
  function control(el) {
    var attrs = ['name', 'type', 'href', 'aria-labelledby', 'data-copy', 'data-close', 'data-discard'];
    if (el.tagName === 'BUTTON') attrs.push('value');
    return JSON.stringify([identity(el, document), attrs.map(function (attr) { return el.getAttribute(attr); })]);
  }
  var storageKey = 'tower-crane:position:' + location.href;
  function reload() {
    var saved = { scroll: capture(document), focus: control(document.activeElement), page: [window.scrollX, window.scrollY] };
    try { sessionStorage.setItem(storageKey, JSON.stringify(saved)); } catch (e) { /* storage may be off */ }
    location.reload();
  }
  function restoreReload() {
    var saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(storageKey));
      sessionStorage.removeItem(storageKey);
    } catch (e) { /* storage may be off */ }
    if (!saved) return;
    window.addEventListener('load', function () {
      requestAnimationFrame(function () {
        var focus = nodes(document).find(function (el) { return control(el) === saved.focus; });
        if (focus) focus.focus({ preventScroll: true });
        restore(document, saved.scroll);
        window.scrollTo(saved.page[0], saved.page[1]);
      });
    }, { once: true });
  }
  return { capture: capture, restore: restore, reload: reload, restoreReload: restoreReload };
})()
`;

module.exports = { POSITION };
