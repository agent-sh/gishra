'use strict';

// Disclosures must open before focus and scroll can reach their contents.
const POSITION = `
(function () {
  function nodes(scope) {
    return (scope.nodeType === 1 && scope.hasAttribute('data-preserve') ? [scope] : []).concat(Array.prototype.slice.call(scope.querySelectorAll('[data-preserve]')));
  }
  function key(el) { return el && el.getAttribute('data-preserve'); }
  function find(scope, id) { return id && nodes(scope).find(function (el) { return key(el) === id; }); }
  function capture(scope) {
    var saved = { scroll: Object.create(null), disclosures: Object.create(null), focus: null };
    nodes(scope).forEach(function (el) {
      var id = key(el);
      saved.scroll[id] = [el.scrollLeft, el.scrollTop];
      if (el.tagName === 'DETAILS') saved.disclosures[id] = el.open;
      if (el === document.activeElement) saved.focus = id;
    });
    if (scope === document) saved.page = [window.scrollX, window.scrollY];
    return saved;
  }
  function disclosures(scope, saved) {
    nodes(scope).forEach(function (el) {
      var id = key(el);
      if (el.tagName === 'DETAILS' && Object.prototype.hasOwnProperty.call(saved.disclosures, id)) el.open = saved.disclosures[id];
    });
  }
  function restore(scope, saved, fallback) {
    disclosures(scope, saved);
    var focus = find(scope, saved.focus) || (saved.focus && fallback);
    if (focus && focus !== document.activeElement) focus.focus({ preventScroll: true });
    nodes(scope).forEach(function (el) {
      var xy = saved.scroll[key(el)];
      if (xy) { el.scrollLeft = xy[0]; el.scrollTop = xy[1]; }
    });
    if (saved.page) window.scrollTo(saved.page[0], saved.page[1]);
  }
  var storageKey = 'tower-crane:position:' + location.href;
  function reload() {
    try { sessionStorage.setItem(storageKey, JSON.stringify(capture(document))); } catch (e) { /* storage may be off */ }
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
      requestAnimationFrame(function () { restore(document, saved); });
    }, { once: true });
  }
  return { key: key, find: find, capture: capture, disclosures: disclosures, restore: restore, reload: reload, restoreReload: restoreReload };
})()
`;

module.exports = { POSITION };
