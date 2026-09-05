/* Origin colours — one implementation, every surface that draws an origin.
 *
 * Sibling of colors.js, and deliberately NOT built on it. A family owns a hue
 * that a relative picked; an origin must never be mistaken for one, so the two
 * live in different places in colour space:
 *
 *   families — 14 hues, all round the wheel, L 0.50–0.60, chroma 0.085–0.116
 *   origins  —  4 hues, each an ordered ramp, L 0.36–0.70, higher chroma
 *
 * WHY FOUR HUES AND NOT ONE PER COUNTRY. There are 13 countries in the tree and
 * a relative may type a 14th. One hue each is not available: a reader compares a
 * segment in one family's bar against a segment in another's, which is an
 * all-pairs comparison, and no ordering of 10+ hues clears the colour-blind and
 * normal-vision separation floors — measured, not guessed (worst all-pairs pair
 * came out at ΔE 3.2 for protanopia, against a floor of 8). Four hues clear it
 * with room to spare (CVD 9.2, normal-vision 16.3, on THIS page's cream
 * surface). So hue carries the REGION and an ordered step inside the region's
 * ramp carries the country — composite encoding. Every country still gets its
 * own fill and its own label; nothing is folded into an "other" bucket, because
 * a family genuinely has several origins and bundling them is the one thing the
 * bar exists to avoid.
 *
 * The country → step assignment is by headcount within the region and is FROZEN
 * here. It must never be recomputed per chart: colour follows the country, not
 * its rank in whichever bar is on screen, or the same country would change
 * colour between two families and the bars would stop being comparable.
 *
 * Classic script, like colors.js, so the tree page's non-module logic block and
 * Node (via lib/origin.mjs) both pick it up the same way.
 */
(function (root) {
  'use strict';

  /* Kept in step with ORIGIN_UNKNOWN in lib/store.mjs and UNKNOWN_ORIGIN in
     index.html by hand — it travels in the data, so all four must agree. */
  const UNKNOWN = 'לא ידוע';

  /* Neutral, not a hue: unknown is an absence, not a fourteenth country. Muted
     ink from the chart-chrome palette, which reads as "no answer" beside any of
     the four region hues without competing with them. */
  const UNKNOWN_COLOR = '#898781';

  /* A country nobody has classified yet — a relative may type anything into the
     origin field. Still gets a fill and a label; just not a region's hue. */
  const OTHER_COLOR = '#b0aa9c';

  /* Region order is fixed and the hues are the first four categorical slots, in
     slot order. Country order inside a region is by headcount, darkest first,
     so a family's dominant origin is also its strongest colour. */
  const REGIONS = [
    { key: 'africa', nameHe: 'צפון אפריקה', nameEn: 'North Africa',
      countries: ['תוניסיה', 'מרוקו', 'לוב', 'מצרים'],
      steps: ['#02468d', '#015db8', '#2977d5', '#4693f3'] },
    { key: 'asia', nameHe: 'אסיה והמזרח התיכון', nameEn: 'Asia & the Middle East',
      countries: ['תימן', 'עירק', 'אירן'],
      steps: ['#842c00', '#c24608', '#f5713e'] },
    { key: 'east', nameHe: 'מזרח אירופה', nameEn: 'Eastern Europe',
      countries: ['רומניה', 'ברית המועצות', 'פולין'],
      steps: ['#045639', '#018057', '#14ac77'] },
    { key: 'west', nameHe: 'מערב אירופה ואמריקה', nameEn: 'Western Europe & the Americas',
      countries: ['הממלכה המאוחדת', 'איטליה', 'קנדה'],
      steps: ['#4736a3', '#6b61d1', '#938eff'] },
  ];

  /* country -> { color, region, regionIndex, step, nameHe, nameEn }, and the
     fixed draw order.

     Seeded from the frozen tables above so this file still works on its own —
     lib/origin.mjs in Node, and the browser between parse and data.js — then
     REPLACED by load() with the `origins` table, which is authoritative. The
     hardcoded list is a fallback, not the source: it holds thirteen countries
     and knows their names in one language, which is exactly the pair of
     problems the table exists to fix. */
  const BY_COUNTRY = {};
  const ORDER = [];
  const REGION_LABEL = {};
  REGIONS.forEach((r, ri) => {
    REGION_LABEL[r.key] = { nameHe: r.nameHe, nameEn: r.nameEn };
    r.countries.forEach((c, ci) => {
      BY_COUNTRY[c] = { color: r.steps[ci], region: r.key, regionIndex: ri, step: ci,
        nameHe: c, nameEn: c };
      ORDER.push(c);
    });
  });

  /**
   * Install the `origins` table. Everything downstream — fills, draw order,
   * labels — reads what this leaves behind, so one call before first paint is
   * what turns "תוניסיה 23%" in an English legend into "Tunisia 23%".
   *
   * Idempotent, and safe to call with nothing: a page that never loads data.js
   * keeps the frozen fallback rather than losing its colours.
   */
  function load(origins, regions) {
    if (!origins || !origins.length) return;
    const order = (regions || REGIONS).map(function (r) { return r.key; });
    (regions || REGIONS).forEach(function (r) {
      REGION_LABEL[r.key] = { nameHe: r.nameHe, nameEn: r.nameEn };
    });
    Object.keys(BY_COUNTRY).forEach(function (k) { delete BY_COUNTRY[k]; });
    ORDER.length = 0;
    /* Rows arrive in `seq` — the frozen creation order — and a country with no
       region sorts after every country that has one, so an unplaced newcomer
       joins the end of the legend instead of splitting a region in half. */
    origins.slice()
      .sort(function (a, b) {
        var ra = order.indexOf(a.region), rb = order.indexOf(b.region);
        if (ra < 0) ra = order.length;
        if (rb < 0) rb = order.length;
        return ra - rb || (a.step || 0) - (b.step || 0) || (a.seq || 0) - (b.seq || 0);
      })
      .forEach(function (o) {
        var ri = order.indexOf(o.region);
        BY_COUNTRY[o.key] = {
          color: o.color || OTHER_COLOR,
          region: o.region || 'other',
          regionIndex: ri < 0 ? order.length : ri,
          step: o.step || 0,
          nameHe: o.nameHe || o.key,
          nameEn: o.nameEn || o.key,
        };
        ORDER.push(o.key);
      });
  }

  /** The fill for one origin. Anything unrecognised still draws, in neutral. */
  function colorOf(country) {
    if (country === UNKNOWN) return UNKNOWN_COLOR;
    const hit = BY_COUNTRY[country];
    return hit ? hit.color : OTHER_COLOR;
  }

  /**
   * What to CALL an origin, in the language being read.
   *
   * The country strings that travel in the data are Hebrew, because that is what
   * the registry wrote and what `origin_mix` is keyed by. Rendering them raw was
   * why an English reader's legend and person card came back in Hebrew — the
   * only place in a bilingual app that did not translate. A country the table
   * has no English name for answers with the Hebrew, which is at least a name.
   */
  function labelOf(country, lang) {
    if (country === UNKNOWN) return lang === 'en' ? 'unknown' : UNKNOWN;
    const hit = BY_COUNTRY[country];
    if (!hit) return country;
    return (lang === 'en' ? hit.nameEn : hit.nameHe) || country;
  }

  /** The region's own name, for a legend that groups by it. */
  function regionLabel(region, lang) {
    const hit = REGION_LABEL[region];
    if (!hit) return lang === 'en' ? 'elsewhere' : 'אחר';
    return (lang === 'en' ? hit.nameEn : hit.nameHe) || region;
  }

  /* Draw order: region order, then step inside the region, then anything we do
     not recognise, then unknown LAST however big it is — the part of a family
     we cannot answer for does not get to be the headline. Same rule the person
     card's text line has always used. */
  function sortKey(country) {
    if (country === UNKNOWN) return [3, 0, 0];
    const hit = BY_COUNTRY[country];
    if (!hit) return [2, 0, 0];
    return [1, hit.regionIndex, hit.step];
  }

  /**
   * A mix ({country: fraction}) → drawable segments, largest-first WITHIN the
   * fixed order above, never re-ordered by size across regions.
   *
   * `min` drops slivers too thin to LABEL, and defaults to 0. Note that barCss
   * normalises to the segments it is handed, so a caller that filters and then
   * draws is silently inflating what is left: filter for a legend, draw from
   * the unfiltered set. Both callers here draw everything and label selectively.
   */
  function segmentsOf(mix, opts) {
    const o = opts || {};
    const min = typeof o.min === 'number' ? o.min : 0;
    const out = [];
    Object.keys(mix || {}).forEach((c) => {
      const f = Number(mix[c]) || 0;
      if (f > min) out.push({ country: c, frac: f, color: colorOf(c), unknown: c === UNKNOWN });
    });
    out.sort((a, b) => {
      const ka = sortKey(a.country), kb = sortKey(b.country);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || b.frac - a.frac
        || a.country.localeCompare(b.country);
    });
    return out;
  }

  /**
   * Segments → one `background` value. A single gradient rather than a row of
   * child elements on purpose: the tree page's template runtime does not nest
   * its list directive, and a chip that is one element cannot get its segments
   * out of step with its label.
   *
   * `rtl` flips the fill direction so a Hebrew reader's bar starts where their
   * eye does. The seam between fills is transparent, so whatever the bar sits
   * on shows through — the surface gap the mark spec asks for, without needing
   * to know the background colour. `seam` is that gap in px: 2 on a bar with
   * room, 1 on a chip strip, where five seams at 2px would eat a tenth of the
   * width and visibly distort the proportions they are there to clarify.
   */
  function barCss(segments, rtl, seam) {
    const segs = (segments || []).filter((s) => s.frac > 0);
    if (!segs.length) return 'transparent';
    const half = (typeof seam === 'number' ? seam : 2) / 2;
    const total = segs.reduce((s, x) => s + x.frac, 0) || 1;
    const stops = [];
    let at = 0;
    segs.forEach((s, i) => {
      const from = at, to = at + (s.frac / total) * 100;
      at = to;
      /* Half a seam is taken off each side of every interior boundary, so the
         gap stays the same width however wide the bar is. calc() in a gradient
         stop is what makes a px gap possible inside a % ramp. */
      const a = i === 0 ? '0%' : 'calc(' + from + '% + ' + half + 'px)';
      const b = i === segs.length - 1 ? '100%' : 'calc(' + to + '% - ' + half + 'px)';
      stops.push(s.color + ' ' + a + ' ' + b);
      if (i < segs.length - 1) {
        stops.push('transparent calc(' + to + '% - ' + half + 'px) calc(' + to + '% + ' + half + 'px)');
      }
    });
    return 'linear-gradient(to ' + (rtl ? 'left' : 'right') + ', ' + stops.join(', ') + ')';
  }

  /**
   * The same segments as a wheel, for a mark too small to be a bar — the 34px
   * avatar on a tree node. Seams are given in DEGREES, not px: a conic gradient
   * has no length to take a px gap out of, and at this size a 2px gap would be
   * a different angle at the rim than at the centre.
   *
   * A single segment gets no seam at all, or the one boundary where the wheel
   * closes on itself would cut a notch out of a person who is wholly one thing.
   *
   * Unlike the bar, this does NOT flip for Hebrew. A bar has a start and a
   * Hebrew reader's starts on the right; a 34px wheel has neither, and mirroring
   * it would only put the same slices in a different place for no one's benefit.
   */
  function pieCss(segments) {
    const segs = (segments || []).filter((s) => s.frac > 0);
    if (!segs.length) return 'transparent';
    if (segs.length === 1) return segs[0].color;
    const total = segs.reduce((s, x) => s + x.frac, 0) || 1;
    const gap = 3;
    const stops = [];
    let at = 0;
    segs.forEach((s) => {
      const from = at, to = at + (s.frac / total) * 360;
      at = to;
      stops.push(s.color + ' ' + (from + gap / 2) + 'deg ' + (to - gap / 2) + 'deg');
      stops.push('transparent ' + (to - gap / 2) + 'deg ' + (to + gap / 2) + 'deg');
    });
    return 'conic-gradient(from 0deg, ' + stops.join(', ') + ')';
  }

  /**
   * The one origin that best labels a person — the largest share that is an
   * actual place. Someone who is more unknown than anything else still answers
   * with the place, if there is one: "half Yemen, half unanswered" is a Yemeni
   * line with a gap in it, not an unknown person.
   */
  function dominantOf(mix) {
    let best = null;
    Object.keys(mix || {}).forEach((c) => {
      if (c === UNKNOWN) return;
      const f = Number(mix[c]) || 0;
      if (!best || f > best.frac) best = { country: c, frac: f };
    });
    return best ? best.country : (Object.keys(mix || {}).length ? UNKNOWN : '');
  }

  /**
   * The mix of a GROUP of people: the mean of each member's own mix, so a
   * half-Romanian counts as half. Not a headcount of dominant origins — that
   * would erase exactly the mixes this is here to show.
   *
   * `getMix` pulls the mix off whatever shape the caller holds (the API's
   * `originMix`, or a parsed `origin_mix` row).
   */
  function groupMix(people, getMix) {
    const pick = getMix || ((p) => p && p.originMix);
    const sum = {};
    let n = 0;
    (people || []).forEach((p) => {
      const mix = pick(p);
      if (!mix) return;
      const keys = Object.keys(mix);
      if (!keys.length) return;
      n++;
      keys.forEach((c) => { sum[c] = (sum[c] || 0) + (Number(mix[c]) || 0); });
    });
    if (!n) return {};
    Object.keys(sum).forEach((c) => { sum[c] = sum[c] / n; });
    return sum;
  }

  /** The region a country belongs to, for legends that group by region. */
  function regionOf(country) {
    const hit = BY_COUNTRY[country];
    return hit ? hit.region : (country === UNKNOWN ? 'unknown' : 'other');
  }

  root.FamilyOrigin = {
    UNKNOWN, UNKNOWN_COLOR, OTHER_COLOR, REGIONS, ORDER,
    load, colorOf, labelOf, regionLabel, regionOf,
    segmentsOf, barCss, pieCss, dominantOf, groupMix,
  };
}(typeof globalThis !== 'undefined' ? globalThis : window));
