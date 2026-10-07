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
    // A surviving control can move under a disclosure that was previously closed.
    for (var ancestor = focus && focus.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.tagName !== 'DETAILS' || ancestor.open) continue;
      var summary = ancestor.querySelector(':scope > summary');
      if (summary && summary.contains(focus)) continue;
      ancestor.open = true;
      var id = key(ancestor);
      if (id) saved.disclosures[id] = true;
    }
    function refocus(el) {
      if (!el || !el.matches('a[href], button, input, textarea, select, summary, [tabindex], [contenteditable]')) return false;
      if (!el.getClientRects().length || getComputedStyle(el).visibility !== 'visible' || el.matches(':disabled') || el.closest('[inert]')) return false;
      el.focus({ preventScroll: true });
      if (el !== document.activeElement) return false;
      saved.focus = key(el);
      return true;
    }
    for (var control = focus; control; control = control.parentElement) {
      if (refocus(control)) break;
    }
    if (!control && fallback && fallback !== focus) refocus(fallback);
    nodes(scope).forEach(function (el) {
      var xy = saved.scroll[key(el)];
      if (xy) { el.scrollLeft = xy[0]; el.scrollTop = xy[1]; }
    });
    if (saved.page) window.scrollTo(saved.page[0], saved.page[1]);
    document.documentElement.setAttribute('data-position-restored', '');
  }
  var storageKey = 'tower-crane:position:' + location.href;
  var pendingReload = null;
  function reload() {
    // A second live write can arrive before the first reload restores its frame.
    try { sessionStorage.setItem(storageKey, JSON.stringify(pendingReload || capture(document))); } catch (e) { /* storage may be off */ }
    document.documentElement.removeAttribute('data-position-restored');
    location.reload();
  }
  function restoreReload() {
    var saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(storageKey));
      sessionStorage.removeItem(storageKey);
    } catch (e) { /* storage may be off */ }
    if (!saved) return;
    pendingReload = saved;
    window.addEventListener('load', function () {
      requestAnimationFrame(function () { restore(document, saved); pendingReload = null; });
    }, { once: true });
  }
  return { key: key, find: find, capture: capture, disclosures: disclosures, restore: restore, reload: reload, restoreReload: restoreReload };
})()
`;

module.exports = { POSITION };
