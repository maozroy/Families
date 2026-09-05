/* Family colours — one implementation, both runtimes.
 *
 * A family carries a single #rrggbb that a relative picked. Everything the UI
 * draws for that family (the pin, the ring, the chip, the text on the chip) is
 * derived from it here, so changing the colour moves every shade at once and no
 * page can drift into its own palette — which is exactly what happened while
 * each page invented hues from a hard-coded list.
 *
 * The maths is OKLCH: hold lightness and chroma at fixed targets and keep the
 * hue the person chose. Doing it in sRGB instead gives a "light" tint of yellow
 * that is nothing like the "light" tint of blue, and the legend stops reading
 * as one set.
 *
 * This file is a CLASSIC script on purpose: the tree page's logic block is not a
 * module and cannot import, so it assigns to globalThis and both the browser and
 * Node (via lib/colors.mjs, which imports it for the side effect) pick it up the
 * same way.
 */
(function (root) {
  'use strict';

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  /* sRGB transfer function, both directions. */
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const toGamma = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

  function hexToRgb(hex) {
    let h = String(hex || '').trim().replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }

  const rgbToHex = (r, g, b) => '#' + [r, g, b]
    .map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');

  /** sRGB hex → OKLCH {l, c, h}. Returns null for anything that is not a colour. */
  function hexToOklch(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return null;
    const [r, g, b] = rgb.map(toLinear);
    const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
    const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
    const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
    let h = Math.atan2(bb, a) * 180 / Math.PI;
    if (h < 0) h += 360;
    return { l: L, c: Math.hypot(a, bb), h };
  }

  /** OKLCH → sRGB hex, clipped into gamut by pulling chroma in until it fits. */
  function oklchToHex(L, C, H) {
    const rad = H * Math.PI / 180;
    for (let c = C; c >= 0; c -= 0.005) {
      const a = Math.cos(rad) * c, b = Math.sin(rad) * c;
      const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
      const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
      const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
      const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
      const r = toGamma(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
      const g = toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
      const bl = toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
      const fits = [r, g, bl].every((v) => v >= -0.002 && v <= 1.002);
      if (fits || c <= 0) return rgbToHex(r, g, bl);
    }
    return rgbToHex(L, L, L);
  }

  /* The eight starting hues, from the map design. There are more families than
     that, so each further lap round the wheel is nudged off the previous one
     and lightened or darkened — the ninth family has to be told apart from the
     first at a glance, and a repeated hue at the same lightness cannot be.
     Because the choice is made once and stored, adding a family never
     re-colours the ones already on screen. */
  const HUES = [38, 145, 265, 95, 20, 195, 320, 65];

  /** The default colour for the nth family ever created. */
  function defaultColor(seq) {
    const n = HUES.length;
    const i = ((Math.trunc(seq) % (n * 4)) + n * 4) % (n * 4);
    const lap = Math.floor(i / n);
    const hue = (HUES[i % n] + lap * 22.5) % 360;
    const light = [0.60, 0.50, 0.70, 0.55][lap];
    return oklchToHex(light, 0.115, hue);
  }

  /**
   * The full set a family is drawn with, from its one colour.
   *   line — the pin body and the legend dot: EXACTLY the colour that was
   *          picked. Normalising its lightness "for consistency" means the dot
   *          you chose and the dot you get are different colours, which reads
   *          as a bug however defensible the maths is.
   *   fill — a wash to sit behind text
   *   ink  — text on `fill`, dark enough to read at 13px
   *   edge — a ring that separates two adjacent pins without shouting
   *
   * Only the derived three are pinned to fixed lightness, which is what keeps a
   * chip legible whether the family picked navy or lemon.
   */
  function shades(hex) {
    const base = hexToOklch(hex) || { l: 0.6, c: 0.115, h: HUES[0] };
    const c = Math.min(Math.max(base.c, 0.03), 0.16);
    return {
      base: hex,
      line: normHex(hex),
      fill: oklchToHex(0.90, c * 0.5, base.h),
      ink: oklchToHex(0.38, c, base.h),
      edge: oklchToHex(0.72, c, base.h),
    };
  }

  /** Is this a colour we can store? The API and the DB agree on #rrggbb only. */
  const isHex = (v) => /^#[0-9a-fA-F]{6}$/.test(String(v || '').trim());
  const normHex = (v) => String(v || '').trim().toLowerCase();

  root.FamilyColors = { HUES, hexToOklch, oklchToHex, defaultColor, shades, isHex, normHex };
}(typeof globalThis !== 'undefined' ? globalThis : window));
