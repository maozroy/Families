// Origins as first-class rows — the sibling of families.mjs.
//
// A country of origin used to be a bare string: whatever the registry wrote into
// `people.birth_country`, whatever a relative typed into `origin_override`, and
// whatever those blended into as the keys of `origin_mix`. Thirteen of those
// strings were then hardcoded into web/public/app/origin.js with a colour each.
//
// Two things were wrong with that and both were visible on the page. The names
// existed only in Hebrew, so an English reader's legend read "תוניסיה 23%". And a
// country outside the hardcoded thirteen — צרפת and ברזיל are already in
// `birth_country` — had no colour, no region and no name in either language; it
// drew grey and unlabelled.
//
// So: a row per country, with both names, a region, and a colour. Like families,
// the table FOLLOWS the data — ensureOrigins() creates a row for every country
// string that actually occurs and never deletes one, so a country whose last
// carrier is re-parented keeps its colour if they come back.
//
// What it deliberately does NOT do is invent hues. The four region ramps in
// origin.js were measured against colour-blind and normal-vision separation
// floors; a country this file has never seen gets a real row with real names and
// the neutral "unclassified" fill, and an owner places it into a region when
// they know where it belongs. A made-up fourteenth hue would look like an answer
// and be a guess.

import { recordChange } from './store.mjs';
import { isHex, normHex } from './colors.mjs';

/** The neutral for a country with no region yet. Matches OTHER_COLOR in origin.js. */
export const UNPLACED_COLOR = '#b0aa9c';

/**
 * The measured ramps, in the region order the legend draws. Steps 0..n are the
 * frozen assignment origin.js shipped with and must not be reordered — a colour
 * follows its country, not the country's rank in whichever chart is on screen.
 *
 * Each ramp carries two steps beyond what is currently used. They continue the
 * same hue and lightness progression, so an owner placing a new country into a
 * region gets a colour that belongs to that region's family. They were not put
 * through the separation measurement the first four were, which is the honest
 * reason a new country does not get assigned one automatically.
 */
export const REGIONS = [
  { key: 'africa', nameHe: 'צפון אפריקה', nameEn: 'North Africa',
    steps: ['#02468d', '#015db8', '#2977d5', '#4693f3', '#6fb0ff', '#9ccbff'] },
  { key: 'asia', nameHe: 'אסיה והמזרח התיכון', nameEn: 'Asia & the Middle East',
    steps: ['#842c00', '#c24608', '#f5713e', '#ff9a72', '#ffbfa6', '#ffd7c6'] },
  { key: 'east', nameHe: 'מזרח אירופה', nameEn: 'Eastern Europe',
    steps: ['#045639', '#018057', '#14ac77', '#4fd3a2', '#8ee7c6', '#b9f0dc'] },
  { key: 'west', nameHe: 'מערב אירופה ואמריקה', nameEn: 'Western Europe & the Americas',
    steps: ['#4736a3', '#6b61d1', '#938eff', '#b6b3ff', '#d3d1ff', '#e6e5ff'] },
];

const REGION_BY_KEY = Object.fromEntries(REGIONS.map((r) => [r.key, r]));

/**
 * The countries the tree already contains, with the region and step origin.js
 * froze. Order inside a region is by headcount, darkest first, so a family's
 * dominant origin is also its strongest colour.
 *
 * A country listed here with `region: ''` is one we hold a name for but have not
 * placed — it draws neutral until someone who knows says where it goes.
 */
const SEED = [
  ['תוניסיה', 'Tunisia', 'africa', 0],
  ['מרוקו', 'Morocco', 'africa', 1],
  ['לוב', 'Libya', 'africa', 2],
  ['מצרים', 'Egypt', 'africa', 3],
  ['תימן', 'Yemen', 'asia', 0],
  ['עירק', 'Iraq', 'asia', 1],
  ['אירן', 'Iran', 'asia', 2],
  ['רומניה', 'Romania', 'east', 0],
  ['ברית המועצות', 'Soviet Union', 'east', 1],
  ['פולין', 'Poland', 'east', 2],
  ['הממלכה המאוחדת', 'United Kingdom', 'west', 0],
  ['איטליה', 'Italy', 'west', 1],
  ['קנדה', 'Canada', 'west', 2],
  // In `birth_country` today, in nobody's mix yet — one re-parenting away from
  // being drawn. They get names now and a region when someone decides.
  ['צרפת', 'France', '', 0],
  ['ברזיל', 'Brazil', '', 0],
];

/**
 * Spellings that mean a country already in the table. The origin field is free
 * text on purpose — a relative in Toronto has an origin no Israeli list knows —
 * so the answer to "Poland" and "פולניה" is not to reject them, it is to know
 * they are פולין. Without this they are three countries, three colours and three
 * slices of the same family.
 *
 * Both languages, plus the spellings that genuinely differ from the registry's:
 * the registry writes עירק and אירן where almost everyone else writes עיראק and
 * איראן.
 */
const SEED_ALIASES = {
  'תוניסיה': ['tunisia', 'tunis', 'טוניסיה'],
  'מרוקו': ['morocco', 'maroc'],
  'לוב': ['libya'],
  'מצרים': ['egypt', 'מצריים'],
  'תימן': ['yemen'],
  'עירק': ['iraq', 'עיראק'],
  'אירן': ['iran', 'persia', 'איראן', 'פרס'],
  'רומניה': ['romania', 'rumania'],
  'ברית המועצות': ['soviet union', 'ussr', 'russia', 'רוסיה', 'ברהמ', 'ברית המועצת'],
  'פולין': ['poland', 'polska', 'פולניה'],
  'הממלכה המאוחדת': ['united kingdom', 'uk', 'england', 'britain', 'great britain',
    'אנגליה', 'בריטניה'],
  'איטליה': ['italy', 'italia'],
  'קנדה': ['canada'],
  'צרפת': ['france'],
  'ברזיל': ['brazil', 'brasil'],
};

/** The colour a region+step implies, or the neutral when there is no region. */
export function rampColor(region, step) {
  const r = REGION_BY_KEY[region];
  if (!r) return UNPLACED_COLOR;
  return r.steps[step] || r.steps[r.steps.length - 1];
}

/** The one normalisation both sides of an alias lookup must agree on. */
export const normOrigin = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
const aliasKey = (v) => normOrigin(v).toLowerCase().replace(/["'׳״]/g, '');

/**
 * Every country string that occurs anywhere in the tree. Reads the three places
 * one can be written — what a relative asserted, where someone was born, and the
 * blend those produced — because a row is missing from the legend if any of them
 * carries a name the table has never seen.
 *
 * ישראל is excluded: it is where this family lives, and `foreign()` in
 * recomputeOrigins already refuses to treat it as somewhere they came from.
 */
function countriesInUse(db, unknown) {
  const out = new Set();
  const add = (c) => { const v = normOrigin(c); if (v && v !== unknown && v !== 'ישראל') out.add(v); };
  for (const r of db.prepare(`SELECT origin_override, birth_country, origin_mix
                              FROM people WHERE deleted_at IS NULL`).all()) {
    add(r.origin_override);
    add(r.birth_country);
    try { Object.keys(JSON.parse(r.origin_mix || '{}')).forEach(add); } catch { /* not JSON */ }
  }
  return out;
}

/**
 * Make sure every country the tree contains has a row, and return them all.
 *
 * The seed goes in first and in its listed order, so `seq` — and with it the
 * legend's fallback ordering — matches the frozen palette. Anything else found
 * in the data lands after it, unplaced.
 */
export function ensureOrigins(db, { unknown = 'לא ידוע' } = {}) {
  const have = new Set(db.prepare('SELECT key FROM origins').all().map((r) => r.key));
  const ins = db.prepare(`INSERT INTO origins (key, name_he, name_en, region, step, color, seq)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let seq = db.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM origins').get().m + 1;

  for (const [he, en, region, step] of SEED) {
    if (have.has(he)) continue;
    ins.run(he, he, en, region, step, rampColor(region, step), seq++);
    have.add(he);
  }
  // Anything the family has written that the seed does not know. It gets a row
  // and both name columns set to what was typed — we have no translation for a
  // country nobody anticipated, and showing the Hebrew twice is honest where
  // showing nothing in English is not.
  for (const c of countriesInUse(db, unknown)) {
    if (have.has(c)) continue;
    ins.run(c, c, c, '', 0, UNPLACED_COLOR, seq++);
    have.add(c);
  }

  const insA = db.prepare('INSERT OR IGNORE INTO origin_aliases (alias, key) VALUES (?, ?)');
  for (const [key, list] of Object.entries(SEED_ALIASES)) {
    if (!have.has(key)) continue;
    for (const a of list) insA.run(aliasKey(a), key);
  }
  return listOrigins(db);
}

/** Every origin, in the frozen draw order. */
export function listOrigins(db) {
  return db.prepare('SELECT * FROM origins ORDER BY seq').all().map((o) => ({
    key: o.key,
    nameHe: o.name_he || o.key,
    nameEn: o.name_en || o.key,
    region: o.region || '',
    step: o.step || 0,
    color: o.color || rampColor(o.region, o.step),
    seq: o.seq || 0,
    updatedBy: o.updated_by || '',
    updatedAt: (o.updated_at || 0) * 1000,
  }));
}

export const getOrigin = (db, key) => db.prepare('SELECT * FROM origins WHERE key=?').get(key) || null;

/**
 * What a person actually typed → the country the tree already knows, or null if
 * this is genuinely a new one. Tries the key, then either name, then the alias
 * table. Returning null is not a rejection: the caller creates a row.
 */
export function resolveOrigin(db, text) {
  const v = normOrigin(text);
  if (!v) return null;
  const direct = db.prepare(`SELECT key FROM origins
                             WHERE key=? OR lower(name_he)=lower(?) OR lower(name_en)=lower(?)`)
    .get(v, v, v);
  if (direct) return direct.key;
  const alias = db.prepare('SELECT key FROM origin_aliases WHERE alias=?').get(aliasKey(v));
  return alias ? alias.key : null;
}

/**
 * The canonical form of a typed origin, creating a row for a country the tree
 * has never seen. Always returns a key that has a row, so nothing downstream has
 * to cope with a country that is in `people` and not in `origins`.
 */
export function canonicalOrigin(db, text) {
  const v = normOrigin(text);
  if (!v) return '';
  // Where this family lives, not somewhere they came from. It is a legitimate
  // `birth_country` and recomputeOrigins refuses to anchor on it, so it must
  // pass through without opening a row in a table of origins.
  if (v === 'ישראל' || v.toLowerCase() === 'israel') return 'ישראל';
  const hit = resolveOrigin(db, v);
  if (hit) return hit;
  const seq = db.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM origins').get().m + 1;
  db.prepare(`INSERT INTO origins (key, name_he, name_en, region, step, color, seq)
              VALUES (?, ?, ?, '', 0, ?, ?)`).run(v, v, v, UNPLACED_COLOR, seq);
  return v;
}

/**
 * Rename an origin, or place it in a region. Owner-only at the route: the names
 * are shared vocabulary — the legend, the person card and both languages read
 * off them — and the region carries a claim about where a country belongs.
 *
 * Placing into a region recolours from that region's ramp unless an explicit
 * colour comes with it, which is the whole point of the composite encoding: the
 * caller says "this is North African", not "this is #2977d5".
 *
 * Logged like a family edit — an `edit` with no person_id, `before`/`after`
 * carrying the origin key — so undo() can find its way back without the change
 * log's `kind` CHECK having to be widened.
 */
export function setOrigin(db, key, patch, actor) {
  const o = getOrigin(db, key);
  if (!o) return null;

  const next = {
    name_he: patch.nameHe === undefined ? o.name_he : normOrigin(patch.nameHe),
    name_en: patch.nameEn === undefined ? o.name_en : normOrigin(patch.nameEn),
    region: patch.region === undefined ? o.region : String(patch.region || ''),
    step: patch.step === undefined ? o.step : Math.max(0, Number(patch.step) || 0),
    color: o.color,
  };
  if (next.region && !REGION_BY_KEY[next.region]) return null;
  if (patch.color !== undefined) {
    if (!isHex(normHex(patch.color))) return null;
    next.color = normHex(patch.color);
  } else if (next.region !== o.region || next.step !== o.step) {
    next.color = rampColor(next.region, next.step);
  }

  const same = ['name_he', 'name_en', 'region', 'step', 'color']
    .every((k) => String(next[k]) === String(o[k]));
  if (same) return listOrigins(db).find((x) => x.key === key);

  db.prepare(`UPDATE origins SET name_he=?, name_en=?, region=?, step=?, color=?,
                                 updated_at=strftime('%s','now'), updated_by=? WHERE key=?`)
    .run(next.name_he, next.name_en, next.region, next.step, next.color, actor?.email || '', key);

  recordChange(db, {
    actor: actor?.email || '', actor_no: actor?.person?.person_no ?? null,
    kind: 'edit', person_id: null, person_no: null,
    summary: `ארץ המקור ${o.name_he || key} עודכנה`,
    before: { origin: key, origin_name_he: o.name_he, origin_name_en: o.name_en,
      origin_region: o.region, origin_step: o.step, origin_color: o.color },
    after: { origin: key, origin_name_he: next.name_he, origin_name_en: next.name_en,
      origin_region: next.region, origin_step: next.step, origin_color: next.color },
  });
  return listOrigins(db).find((x) => x.key === key);
}

/** Undo support. Writes no log entry of its own — undo() records the reversal. */
export function restoreOrigin(db, key, before = {}) {
  const o = getOrigin(db, key);
  if (!o) return false;
  db.prepare(`UPDATE origins SET name_he=?, name_en=?, region=?, step=?, color=?,
                                 updated_at=strftime('%s','now') WHERE key=?`)
    .run(before.origin_name_he ?? o.name_he, before.origin_name_en ?? o.name_en,
      before.origin_region ?? o.region, before.origin_step ?? o.step,
      before.origin_color ?? o.color, key);
  return true;
}
