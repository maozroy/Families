/* v2 theme — the one thing a dark page cannot get from a token override.
 *
 * Family colours are not tokens. A relative picks a #rrggbb and `colors.js`
 * derives the wash, the text on the wash and the ring from it in OKLCH, pinned
 * to fixed lightness targets so a chip stays legible whether somebody chose navy
 * or lemon. Those targets are chosen for a cream page: `fill` lands at L=0.90,
 * which on a near-black page is a bright slab, and `ink` at L=0.38, which is
 * then invisible on it.
 *
 * So the derivation has to know about the theme. What must NOT change is `line`
 * — the pin body and the legend dot are exactly the colour that was picked, in
 * both themes, because "the dot you chose is not the dot you got" reads as a bug
 * however good the reasoning. Only the three derived shades move, and they move
 * by mirroring their lightness, so the relationship between them is preserved.
 *
 * This wraps `colors.js` rather than editing it: v1 shares that file and must
 * keep its exact behaviour.
 */
(function (root) {
  'use strict';

  var mq = root.matchMedia ? root.matchMedia('(prefers-color-scheme: dark)') : null;
  var subs = [];

  function isDark() { return !!(mq && mq.matches); }

  var C = root.FamilyColors;
  if (C && !C.__v2Wrapped) {
    var light = C.shades;

    /* The unwrapped derivation, kept reachable. Two things this app makes are
       not "the page": the printed sheet and the share card. Paper is cream and
       WhatsApp shows the picture on whatever background it likes, so both want
       the light shades whatever the reader's phone is set to — and without this
       they would have to re-derive the palette themselves, which is the drift
       colors.js exists to prevent. */
    C.lightShades = light;

    C.shades = function (hex) {
      var s = light(hex);
      if (!isDark()) return s;
      var base = C.hexToOklch(hex) || { l: 0.6, c: 0.115, h: 0 };
      var c = Math.min(Math.max(base.c, 0.03), 0.16);
      return {
        base: s.base,
        /* Untouched, on purpose — see the note above. */
        line: s.line,
        /* 0.90 → 0.26: a wash dark enough to sit on the page without glowing,
           with the chroma pulled up slightly because a dark tint of the same
           chroma reads as flat grey. */
        fill: C.oklchToHex(0.26, c * 0.7, base.h),
        /* 0.38 → 0.87: text on that wash. */
        ink: C.oklchToHex(0.87, Math.min(c, 0.09), base.h),
        /* 0.72 → 0.60: the ring that separates two adjacent pins. Darker than
           the light theme's, because it now has to show up against a dark map
           rather than a pale one. */
        edge: C.oklchToHex(0.60, c, base.h),
      };
    };
    C.__v2Wrapped = true;
  }

  /* A page registers what it needs to redo when the system flips at sunset.
     Reloading instead would be simpler and would throw away a half-typed form,
     which is the one moment somebody would notice. */
  function onChange(fn) {
    if (typeof fn === 'function') subs.push(fn);
  }

  if (mq) {
    var fire = function () { subs.forEach(function (f) { try { f(isDark()); } catch (e) {} }); };
    if (mq.addEventListener) mq.addEventListener('change', fire);
    else if (mq.addListener) mq.addListener(fire);
  }

  root.V2Theme = { isDark: isDark, onChange: onChange };
}(typeof globalThis !== 'undefined' ? globalThis : window));
