/* The address bar as state.
 *
 * Both pages of this app used to be one URL: whatever you were looking at —
 * a person, a branch, a settlement — the link you copied said `/` and dropped
 * the next reader at the default view. Every screen worth pointing at now has
 * an address, and this is the one place that knows how to read and write one.
 *
 * A classic script, not a module, because the tree page's logic block cannot
 * import. Both pages include it and use globalThis.FamilyUrl.
 */
(function (root) {
  'use strict';

  /** Everything in the query string, as a plain object; empty values dropped. */
  function read() {
    const out = {};
    new URLSearchParams(location.search).forEach((v, k) => { if (v !== '') out[k] = v; });
    return out;
  }

  /**
   * Merge `patch` into the query string. A key set to '', null or undefined is
   * removed, which is what makes "clear the filter" and "set the filter" the
   * same call.
   *
   * Default is replaceState: state here changes on pan, zoom and every toggle,
   * and a back button that walks through forty map positions is a worse
   * experience than one that leaves the page. Pass {push: true} for the changes
   * a reader would expect Back to undo — opening a person, mostly.
   */
  function write(patch, opts) {
    const params = new URLSearchParams(location.search);
    Object.keys(patch || {}).forEach((k) => {
      const v = patch[k];
      if (v === '' || v === null || v === undefined || v === false) params.delete(k);
      else params.set(k, String(v));
    });
    const qs = params.toString();
    const url = location.pathname + (qs ? '?' + qs : '') + location.hash;
    if (url === location.pathname + location.search + location.hash) return;
    if (opts && opts.push) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
  }

  /** Called with the new params whenever the reader uses Back or Forward. */
  function onPop(cb) {
    window.addEventListener('popstate', () => cb(read()));
  }

  /** The absolute link to what is on screen right now. */
  const current = () => location.href;

  /**
   * Copy the current link. Returns a promise for whether it worked, because
   * the clipboard API is unavailable on an insecure origin and inside some
   * in-app browsers — the caller has to be able to fall back to showing the
   * URL rather than claiming a copy that never happened.
   */
  function copy() {
    const text = current();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => fallback(text));
    }
    return Promise.resolve(fallback(text));
  }

  function fallback(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) { return false; }
  }

  /** A comma list in a URL ⇄ an array, with the empties gone. */
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const join = (arr) => (arr && arr.length ? arr.join(',') : '');

  root.FamilyUrl = { read, write, onPop, current, copy, list, join };
}(typeof globalThis !== 'undefined' ? globalThis : window));
