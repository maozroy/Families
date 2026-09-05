/* The countries somebody in this tree can live in.
 *
 * The address the family types has always been an Israeli one: a settlement
 * out of the government list, one of its streets, a house number. That is the
 * right shape for almost everybody and the wrong shape for the relatives in
 * Rome, in Las Vegas and — going back — in Tripoli and Djerba, whose towns are
 * in no Israeli dataset and whose streets are in no `streets` table. Before
 * this file they were typed into the same box and then quietly failed to
 * geocode, because every lookup is bounded to a box drawn around Israel.
 *
 * So a person now carries a COUNTRY beside their town, and it is what decides
 * which vocabulary the form offers and how the geocoder asks. Empty means
 * Israel — the tree's home country and what 700-odd rows already meant by
 * saying nothing — so nothing that never leaves the country has to be edited,
 * and no reader has to answer a question they have no reason to be asked.
 *
 * The country itself is stored as its ISO 3166-1 alpha-2 code, not as a name.
 * A name is exactly the mistake `origins` had to grow an alias table for:
 * "Poland", "פולניה" and "פולין" are one country and three strings. A code is
 * one string in every language, it is what Nominatim's `countrycodes=` wants,
 * and the two display names come out of the browser's own data rather than a
 * table this file would have to keep current.
 *
 * Free text is still accepted, like everywhere else here — a country that does
 * not resolve is kept verbatim and shown as typed. It just cannot narrow a
 * geocode, and label() says so by having nothing better to show than what was
 * written.
 *
 * A classic script, like fuzzy.js beside it: the tree's logic block is not a
 * module and cannot import. lib/countries.mjs is Node's view of this file.
 */
(function (root) {
  'use strict';

  /* Every current ISO 3166-1 alpha-2 code, minus the ones nobody has an
     address in: the uninhabited territories (Antarctica, Bouvet, Heard) and
     CLDR's exceptional reservations (EU, UK-as-alias, the historic BU/CS/YU).
     A fixed list rather than something derived at runtime, because there is no
     Intl call that enumerates regions — only one that names a code you already
     have. */
  var CODES = (
    "AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI "
  + "BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CD CF CG CH CI CK CL CM CN CO "
  + "CQ CR CU CV CW CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK "
  + "FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN "
  + "HR HT HU ID IE IL IM IN IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP "
  + "KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK "
  + "ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NG NI NL NO NP "
  + "NR NU NZ OM PA PE PF PG PH PK PL PM PR PS PT PW PY QA RE RO RS RU RW "
  + "SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG "
  + "TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN "
  + "VU WF WS XK YE YT ZA ZM ZW"
  ).split(' ');

  /* Where this family lives unless it says otherwise. Blank and 'IL' are the
     same answer everywhere in this file, and blank is the one on disk for
     anyone who never left. */
  var HOME = 'IL';

  var CODE_SET = {};
  CODES.forEach(function (c) { CODE_SET[c] = 1; });

  /* Names come from the browser's own CLDR data. Where Intl.DisplayNames is
     missing — nothing current, but a five-year-old iPad is a real reader here —
     every name falls back to the code itself: a picker showing "IT" is poor,
     a picker that throws is a form nobody can save. */
  var DN = {};
  function display(lang) {
    if (DN[lang] !== undefined) return DN[lang];
    try { DN[lang] = new Intl.DisplayNames([lang], { type: 'region' }); }
    catch (e) { DN[lang] = null; }
    return DN[lang];
  }

  /** The country's name in one language, or '' if this is not a country code. */
  function name(code, lang) {
    var c = String(code || '').trim().toUpperCase();
    if (!CODE_SET[c]) return '';
    var d = display(lang === 'en' ? 'en' : 'he');
    if (!d) return c;
    try { return d.of(c) || c; } catch (e) { return c; }
  }

  /* The spellings this family writes that CLDR does not answer to. Two kinds:
     what the population registry calls a country (עירק, תורכיה, הממלכה
     המאוחדת), and what people say rather than write (אמריקה, אנגליה, הולנד).
     Historic countries are deliberately absent — ברית המועצות is an ORIGIN, a
     place a family came from, and nobody's current address is in it. */
  var ALIASES = {
    'עירק': 'IQ', 'עיראק': 'IQ',
    'תורכיה': 'TR', 'טורקיה': 'TR',
    'הממלכה המאוחדת': 'GB', 'אנגליה': 'GB', 'בריטניה הגדולה': 'GB',
    'ארהב': 'US', 'ארצות הברית של אמריקה': 'US', 'אמריקה': 'US',
    'שוויץ': 'CH', 'שווייץ': 'CH',
    'הולנד': 'NL', 'ארצות השפלה': 'NL',
    'צכיה': 'CZ', 'צכוסלובקיה': 'CZ',
    'גרוזיה': 'GE', 'גיאורגיה': 'GE',
    'בילורוסיה': 'BY', 'רוסיה הלבנה': 'BY',
    'דרום קוריאה': 'KR', 'צפון קוריאה': 'KP',
    'איחוד האמירויות': 'AE', 'אמירויות': 'AE',
    'usa': 'US', 'uk': 'GB', 'england': 'GB', 'holland': 'NL',
  };

  function flat(s) {
    var F = root.FamilyFuzzy;
    if (F && F.bare) return F.bare(s);
    // Same rules fuzzy.js applies, in the same order — dashes before niqqud,
    // because the maqaf ־ sits inside the niqqud block. Only reached on a
    // browser that loaded this file without that one.
    return String(s || '').replace(/[-–—־]/g, ' ').replace(/[֑-ׇ]/g, '')
      .replace(/["'׳״`()\[\]]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /* code → itself, and every name and alias → its code. Built once, lazily,
     because most page loads never open the form. */
  var INDEX = null;
  function index() {
    if (INDEX) return INDEX;
    INDEX = {};
    var put = function (text, code) {
      var k = flat(text);
      if (k && !INDEX[k]) INDEX[k] = code;
    };
    CODES.forEach(function (c) {
      put(c, c);
      put(name(c, 'he'), c);
      put(name(c, 'en'), c);
    });
    // Aliases last: a real CLDR name for one country must never be taken by
    // another country's nickname.
    Object.keys(ALIASES).forEach(function (k) { put(k, ALIASES[k]); });
    return INDEX;
  }

  /**
   * What somebody typed, as a country code — '' when it is not a country we
   * know. Accepts the code, either language's name, and the spellings above.
   */
  function resolve(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return '';
    var up = s.toUpperCase();
    if (CODE_SET[up]) return up;
    return index()[flat(s)] || '';
  }

  /**
   * The stored form of what somebody typed: a code where we recognise one, and
   * otherwise the text itself, tidied. Never throws a value away — a country
   * this list has never heard of is still where somebody lives.
   */
  function normalize(text) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return resolve(s) || s.slice(0, 60);
  }

  /** Is this address outside Israel? Blank is home, and so is 'IL'. */
  function isForeign(country) {
    var c = String(country || '').trim();
    return !!c && c.toUpperCase() !== HOME;
  }

  /** What to show for a stored value: the localised name, or the raw text. */
  function label(country, lang) {
    var c = String(country || '').trim();
    if (!c) return '';
    return name(c, lang) || c;
  }

  /**
   * The picker's list. `counts` is code → how many people in the tree are
   * already there, which is what floats Israel, Italy and the United States
   * above the other 236 — the same trick the settlement list plays with עומר.
   */
  function list(lang, counts) {
    var n = counts || {};
    return CODES.map(function (c) {
      return {
        code: c,
        name: name(c, lang) || c,
        nameHe: name(c, 'he') || c,
        nameEn: name(c, 'en') || c,
        count: n[c] || 0,
      };
    }).sort(function (a, b) {
      return (b.count - a.count) || a.name.localeCompare(b.name, lang === 'en' ? 'en' : 'he');
    });
  }

  root.FamilyCountries = {
    CODES: CODES, HOME: HOME, ALIASES: ALIASES,
    name: name, label: label, resolve: resolve, normalize: normalize,
    isForeign: isForeign, list: list,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
