/* What the reader has not told the family about themselves yet.
 *
 * A classic script, like colors.js / origin.js / relations.js, so both pages
 * can ask the same question and get the same answer: globalThis.FamilyProfile.
 *
 * Why this exists at all: the tree is filled in by relatives about each OTHER.
 * A cousin adds you, and what they know is your name and roughly when you were
 * born — so the row that is emptiest about any given person is very often their
 * own. Nobody was ever asked. The contact row made that visible: a card with no
 * buttons on it is a person nobody can reach, and the person who can fix that
 * in ten seconds is the one reading the card.
 *
 * Two rules it keeps, and both are about not becoming a nag:
 *
 *  - **It asks once and then goes quiet for a month.** Dismissal is stored per
 *    person, in localStorage, so signing in on a second device does ask again
 *    once — which is the right side to err on for a family where several people
 *    share a laptop and a browser profile.
 *  - **It never asks for anything it does not need.** `linkedin` is one item
 *    with `instagram` and `facebook`, satisfied by any of the three: plenty of
 *    this family is on exactly one network and telling them twice a month that
 *    their LinkedIn is empty would teach them to dismiss it without reading.
 */
(function (root) {
  'use strict';

  /** Thirty days. Long enough that a dismissal means "not now", not "never". */
  var QUIET_MS = 30 * 24 * 60 * 60 * 1000;

  /* In the order the prompt lists them: the two that make a person findable on
     the tree first, then the ways to reach them. `has` is what counts as
     answered — never a truthiness test on the raw column, because `photo` is an
     id and the three profile links are one item between them. */
  var ITEMS = [
    { key: 'photo', has: function (p) { return !!p.photo; } },
    { key: 'born', has: function (p) { return !!p.born; } },
    { key: 'city', has: function (p) { return !!p.city; } },
    { key: 'phone', has: function (p) { return !!p.phone; } },
    { key: 'email', has: function (p) { return !!p.email; } },
    { key: 'job', has: function (p) { return !!p.job; } },
    { key: 'links', has: function (p) { return !!(p.instagram || p.facebook || p.linkedin); } },
  ];

  /** The keys this person has not answered, in prompt order. */
  function missing(p) {
    if (!p) return [];
    return ITEMS.filter(function (it) { return !it.has(p); }).map(function (it) { return it.key; });
  }

  /**
   * The same list, as `{key, label}` for drawing. `labels` is the page's own
   * translation table — one string per key — so the wording stays where every
   * other string on these pages lives.
   */
  function missingLabelled(p, labels) {
    var t = labels || {};
    return missing(p).map(function (k) { return { key: k, label: t[k] || k }; });
  }

  var keyFor = function (p) { return 'fam.profile.dismissed.' + ((p && p.no) || '?'); };

  /* localStorage throws in a private window and inside some in-app browsers,
     and this is a nicety — a storage failure must mean "ask again next time",
     never a page that does not load. */
  function readTs(p) {
    try { return +(root.localStorage.getItem(keyFor(p)) || 0) || 0; } catch (_) { return 0; }
  }

  /** Remember that they said not now. `now` is passed in so tests can lie. */
  function dismiss(p, now) {
    try { root.localStorage.setItem(keyFor(p), String(now || Date.now())); } catch (_) { /* fine */ }
  }

  /**
   * Should the reader be asked? Only a real person row, only with something
   * actually missing, and only if they have not waved it away this month.
   */
  function shouldPrompt(p, now) {
    if (!p || !p.no) return false;
    if (!missing(p).length) return false;
    return ((now || Date.now()) - readTs(p)) > QUIET_MS;
  }

  root.FamilyProfile = {
    QUIET_MS: QUIET_MS,
    keys: ITEMS.map(function (it) { return it.key; }),
    missing: missing, missingLabelled: missingLabelled,
    shouldPrompt: shouldPrompt, dismiss: dismiss,
  };
}(typeof globalThis !== 'undefined' ? globalThis : window));
