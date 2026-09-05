/* One way of matching what somebody typed against a list of names.
 *
 * Used by the settlement search on the map and by the address pickers in the
 * tree's person form. Shared because a search box that ranks one name first in one
 * place and fourth in the other feels broken, and because the Hebrew
 * normalisation below is the whole trick and is easy to get subtly different
 * twice.
 *
 * A classic script, like the other two in this directory: the tree's logic block
 * is not a module and cannot import.
 */
(function (root) {
  'use strict';

  /* Hebrew is typed with niqqud nobody reproduces, with gershayim that are
     sometimes a quote mark and sometimes the real ״, and with a maqaf that is
     sometimes a hyphen and sometimes a space. Flatten both sides before
     comparing or "תלמי בילו" never finds `תלמי ביל"ו`. */
  function norm(s) {
    return String(s || '')
      // Dashes FIRST, and that ordering is load-bearing: the Hebrew maqaf ־ is
      // U+05BE, which sits inside the niqqud block. Stripping that block first
      // turns תל־אביב into תלאביב — one word — and it then matches nothing,
      // which is how "תל אביב - יפו" failed to match OSM's "תל־אביב–יפו".
      .replace(/[-–—־]/g, ' ')
      .replace(/[֑-ׇ]/g, '')          // niqqud and cantillation
      .replace(/["'׳״`()\[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /* Hebrew prefixes that get typed or left off at random: "רחוב הרצל" vs
     "הרצל", "בית אל" vs "הבית אל". Only stripped when what remains is still a
     word, so "הר" stays "הר". */
  const LEAD = /^(רחוב|רח|שדרות|שד|סמטת|סמ|דרך|כביש)\s+/;
  const bare = (s) => {
    const t = norm(s).replace(LEAD, '');
    return t.length >= 2 ? t : norm(s);
  };

  /**
   * How well `q` matches `name`: bigger is better, -1 means no.
   *
   * The ladder is deliberate — exact, then starts-with, then a later word
   * starts with it, then contained, and only then "the letters appear in
   * order". Subsequence matching alone puts nonsense above obvious hits: for
   * "באר" it would rank בני ברק (ב…א…ר) beside באר שבע.
   */
  function score(q, name) {
    const n = bare(name), t = bare(q);
    if (!t) return 1;
    if (n === t) return 100;
    if (n.indexOf(t) === 0) return 80;
    const words = n.split(' ');
    for (let i = 1; i < words.length; i++) if (words[i].indexOf(t) === 0) return 72 - i;
    const idx = n.indexOf(t);
    if (idx > 0) return 50 - Math.min(idx, 20);
    let j = 0, gaps = 0;
    for (let k = 0; k < n.length && j < t.length; k++) {
      if (n[k] === t[j]) j++;
      else if (j > 0 && j < t.length) gaps++;
    }
    return j === t.length ? 24 - Math.min(gaps / 4, 12) : -1;
  }

  /**
   * The best score any one of an item's names gets, and which name it was.
   *
   * A settlement has one name; a person has several — Hebrew, English, the
   * surname she was born with, the number the family quotes at each other.
   * Scoring the lot glued together would rank them by accident: "דנה לוי"
   * as one string is not a name anybody typed, and the exact-match rung would
   * never be reached. Each name is scored on its own and the best one wins,
   * which is also the name worth showing back in the list.
   */
  function best(q, k) {
    if (!Array.isArray(k)) return { s: score(q, k), n: String(k == null ? '' : k) };
    let s = -1, n = '';
    for (let i = 0; i < k.length; i++) {
      if (!k[i]) continue;
      const v = score(q, k[i]);
      if (v > s) { s = v; n = String(k[i]); }
    }
    return { s: s, n: n };
  }

  /**
   * Rank a list against a query. `items` may be strings or objects; `key` pulls
   * the text out — one string, or an array of the names the same thing answers
   * to — and `weight` breaks ties (a settlement where the family already lives
   * should beat one where nobody does).
   */
  function rank(q, items, opts) {
    const o = opts || {};
    const key = o.key || ((x) => x);
    const weight = o.weight || (() => 0);
    const limit = o.limit || 60;
    return items
      .map((x) => { const m = best(q, key(x)); return { x: x, s: m.s, n: m.n }; })
      .filter((m) => m.s >= 0)
      .sort((a, b) => b.s - a.s || weight(b.x) - weight(a.x)
        || a.n.localeCompare(b.n, 'he'))
      .slice(0, limit)
      .map((m) => m.x);
  }

  /**
   * The names one person answers to, for both search boxes.
   *
   * Both spellings, because half the family reads one and half the other and
   * neither should have to guess which the page is in. The maiden name, because
   * an aunt is looked for under the surname she had when the searcher last saw
   * her. The person number, because "137" is how this family already refers to
   * each other — see the tree's own links.
   */
  function personNames(p) {
    if (!p) return [];
    return [
      ((p.first || '') + ' ' + (p.last || '')).trim(),
      ((p.firstEn || '') + ' ' + (p.lastEn || '')).trim(),
      (p.first || '').trim(),
      (p.firstEn || '').trim(),
      (p.maiden ? (p.first || '') + ' ' + p.maiden : '').trim(),
      p.no ? String(p.no) : '',
    ].filter(Boolean);
  }

  root.FamilyFuzzy = { norm, bare, score, best, rank, personNames };
}(typeof globalThis !== 'undefined' ? globalThis : window));
