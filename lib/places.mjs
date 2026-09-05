// Settlements, and where they are.
//
// people.city is free text a relative typed, so the map cannot assume it can be
// resolved: it is keyed verbatim here and either has coordinates or does not.
// Nothing in a request path talks to a geocoder — scripts/geocode-places.mjs
// fills the table out of band and the map reads it.
//
// A town is (city, country), never a city on its own. `טריפולי` is in Libya and
// `Tripoli` is also in Lebanon; one row keyed by the name alone would give
// whichever was geocoded first to both. The country is an ISO 3166-1 alpha-2
// code and '' means Israel — see web/public/app/countries.js — so every row
// written before there were countries still names the town it always did.

import { isForeign, resolve as countryCode } from './countries.mjs';

/**
 * The one string a town is known by outside this module: its name where it is
 * in Israel, and `name|CC` where it is not.
 *
 * The pages key their place maps by it and the map puts it in the URL, so the
 * shape matters beyond this file: appending only for a foreign town is what
 * keeps every `?city=עומר` link anyone has ever sent still working.
 */
export const placeKey = (city, country) => (isForeign(country)
  ? `${String(city ?? '').trim()}|${String(country).trim().toUpperCase()}`
  : String(city ?? '').trim());

/** Every distinct town in the tree, with its headcount, biggest first. */
export function cityTally(db) {
  return db.prepare(`SELECT trim(city) AS city, trim(country) AS country, COUNT(*) AS n
                       FROM people
                      WHERE deleted_at IS NULL AND trim(city) <> ''
                   GROUP BY trim(city), trim(country)
                   ORDER BY n DESC, city`).all();
}

/** How many people live in each country, by code. '' (Israel) included. */
export function countryTally(db) {
  return db.prepare(`SELECT trim(country) AS country, COUNT(*) AS n
                       FROM people
                      WHERE deleted_at IS NULL AND trim(city) <> ''
                   GROUP BY trim(country)
                   ORDER BY n DESC`).all();
}

/**
 * The settlement list the map draws and the search box offers: one entry per
 * town, with coordinates where we have them. Entries without coordinates are
 * kept rather than filtered — the page has to be able to say "11 people we
 * cannot place" instead of quietly showing a smaller family than there is.
 */
export function listPlaces(db) {
  const coords = new Map(db.prepare('SELECT * FROM places').all()
    .map((p) => [placeKey(p.name, p.country), p]));
  return cityTally(db).map(({ city, country, n }) => {
    const p = coords.get(placeKey(city, country));
    return {
      key: placeKey(city, country),
      name: city,
      country: country || '',
      count: n,
      lat: p && p.lat != null ? p.lat : null,
      lng: p && p.lng != null ? p.lng : null,
      source: (p && p.source) || '',
    };
  });
}

/** Towns that still have no coordinates — the geocoder's work list. */
export function missingPlaces(db) {
  return listPlaces(db).filter((p) => p.lat == null);
}

export function upsertPlace(db, { name, country = '', lat, lng, display = '', source = 'manual' }) {
  db.prepare(`INSERT INTO places (name, country, lat, lng, display, source, queried_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))
              ON CONFLICT(name, country) DO UPDATE SET
                lat=excluded.lat, lng=excluded.lng, display=excluded.display,
                source=excluded.source, queried_at=excluded.queried_at,
                updated_at=excluded.updated_at`)
    .run(name, country || '', lat, lng, display, source);
}

/**
 * The `places` row for a town, created if this is the first time anyone named it.
 *
 * This is the "FK in storage, free text in the hand" half of the life-place
 * model: the editor still takes a typed town — see the note on the markup in
 * tree-v2.html for why a list of Israeli settlements is the wrong vocabulary for
 * somewhere a person was born in 1912 — and the server resolves it to a row.
 *
 * Country goes through lifeCountry() rather than being used raw, so this shares
 * one row per town with the geocoder, the map and the residence tally instead of
 * opening a second vocabulary beside them. That also means 'בסרביה' finds the
 * same Carpineni as 'Moldova', and the USSR does not collapse into Israel.
 *
 * Returns null for a blank town: a country on its own is an origin, not a place,
 * and `places` is a gazetteer of settlements.
 */
export function resolvePlaceId(db, city, country = '') {
  const name = String(city ?? '').trim();
  if (!name) return null;
  const code = lifeCountry(country);
  db.prepare(`INSERT INTO places (name, country) VALUES (?, ?)
              ON CONFLICT(name, country) DO NOTHING`).run(name, code);
  return db.prepare('SELECT id FROM places WHERE name = ? AND country = ?').get(name, code)?.id ?? null;
}

// ── the places a life happened ───────────────────────────────────────────────
// Birth, death and burial, as opposed to the address somebody is reachable at.
// They share the `places` table with the residence towns because they are the
// same question — where is this town — and a family that lives in באר שבע and
// buries in באר שבע should cost one Nominatim lookup and hold one coordinate.
//
// What they do NOT share is the residence tally: `listPlaces()` is the map's
// list of where people LIVE, sized by headcount, and quietly adding the town
// somebody was born in in 1912 would put a pin of zero residents on it.

/** The three life events, and the columns each one is spelled with. */
export const LIFE_EVENTS = [
  { kind: 'birth', city: 'birth_city', country: 'birth_country' },
  { kind: 'death', city: 'death_city', country: 'death_country' },
  { kind: 'burial', city: 'burial_city', country: 'burial_country' },
];

/* Countries that no longer exist, and the modern state whose maps contain the
 * towns. Only what this family actually wrote — a general table of historic
 * polities is a research project, and every entry here is a claim that a
 * geocoder asked about country X will find a town that was in country Y.
 *
 * '' means "there is no such successor to point a lookup at": the USSR covers
 * eleven time zones and narrowing a search to it narrows nothing. Those are
 * asked unbounded, by the town name alone, and are usually a miss — which is
 * the honest answer and not a pin in the wrong hemisphere.
 */
const HISTORIC = {
  'ברית המועצות': '', 'בריה"מ': '', 'רוסיה הצארית': '', 'soviet union': '', 'ussr': '',
  'בסרביה': 'MD', 'מולדביה': 'MD', 'bessarabia': 'MD',
  'פלשתינה': 'IL', 'ארץ ישראל': 'IL', 'פלסטין המנדטורית': 'IL', 'mandatory palestine': 'IL',
  'צכוסלובקיה': 'CZ', "צ'כוסלובקיה": 'CZ', 'czechoslovakia': 'CZ',
  'יוגוסלביה': 'RS', 'yugoslavia': 'RS',
  'פרס': 'IR', 'persia': 'IR',
  "האימפריה העות'מאנית": 'TR', 'ottoman empire': 'TR',
};

/**
 * The country a life-event place should be looked up in.
 *
 * A life-event country is a NAME, not a code — see the note beside the columns
 * in lib/store.mjs. This is the one place that turns one into the other:
 *   'ישראל' / '' / 'IL'  → ''   (home, and bounded to the Israeli viewbox)
 *   'רומניה' / 'Romania' → 'RO'
 *   'בסרביה' / 'Bessarabia' → 'MD' (the modern map those towns are on)
 *   'ברית המועצות'       → 'ברית המועצות', verbatim.
 *
 * That last case is the one worth being careful about. A country with no usable
 * successor — the USSR spans eleven time zones, narrowing to it narrows nothing
 * — must NOT collapse to '', because '' is Israel here: it would file a Soviet
 * town among the Israeli ones, hand it an Israeli town's coordinates if the
 * names ever collided, and bound its lookup to a viewbox drawn around a country
 * it was never in. Kept as the string it was written as, which is a key of its
 * own and a lookup the geocoder knows to run unbounded.
 */
export function lifeCountry(country) {
  const raw = String(country ?? '').trim();
  if (!raw) return '';
  const code = countryCode(raw);
  if (code) return code === 'IL' ? '' : code;
  const hist = HISTORIC[raw] ?? HISTORIC[raw.toLowerCase()];
  if (hist) return hist === 'IL' ? '' : hist;
  return raw;
}

/** Is this a country ISO has never heard of — a state that no longer exists? */
export const isHistoric = (country) => {
  const c = String(country ?? '').trim();
  return !!c && !countryCode(c) && !HISTORIC[c] && !HISTORIC[c.toLowerCase()];
};

/** The `places` key for a life-event town. Shares the space with residences. */
export const lifePlaceKey = (city, country) => placeKey(city, lifeCountry(country));

/**
 * Every town this family was born in, died in or is buried in, with how many
 * of each. Keyed the same way residences are, so a town that is both appears
 * once here and once there and has one row in `places` behind them both.
 */
export function lifePlaceTally(db) {
  const out = new Map();
  for (const ev of LIFE_EVENTS) {
    const rows = db.prepare(`SELECT trim(${ev.city}) AS city, trim(${ev.country}) AS country,
                                    COUNT(*) AS n
                               FROM people
                              WHERE deleted_at IS NULL AND trim(${ev.city}) <> ''
                           GROUP BY trim(${ev.city}), trim(${ev.country})`).all();
    for (const r of rows) {
      const country = lifeCountry(r.country);
      const key = placeKey(r.city, country);
      const hit = out.get(key)
        || { key, name: r.city, country, countryText: r.country || '', birth: 0, death: 0, burial: 0, count: 0 };
      hit[ev.kind] += r.n;
      hit.count += r.n;
      // The first spelling of the country wins the label; the KEY is what
      // matters and every spelling that reaches here already agreed on it.
      if (!hit.countryText) hit.countryText = r.country || '';
      out.set(key, hit);
    }
  }
  return [...out.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'he'));
}

/** The same list with whatever coordinates `places` holds. */
export function listLifePlaces(db) {
  const coords = new Map(db.prepare('SELECT * FROM places').all()
    .map((p) => [placeKey(p.name, p.country), p]));
  return lifePlaceTally(db).map((t) => {
    const p = coords.get(t.key);
    return {
      ...t,
      lat: p && p.lat != null ? p.lat : null,
      lng: p && p.lng != null ? p.lng : null,
      source: (p && p.source) || '',
    };
  });
}

// ── exact addresses ──────────────────────────────────────────────────────────

/**
 * The key an address is cached under. Whitespace and the two quote marks are
 * flattened because the same house gets typed `הרצל 14`, `הרצל  14` and
 * `הרצל 14 ` on three different evenings, and each spelling would otherwise be
 * a separate geocoder lookup and a separate pin a metre apart.
 *
 * The country is APPENDED, and only when it is not Israel. Putting it in the
 * key unconditionally would have renamed all 116 addresses already geocoded and
 * sent every one of them back to Nominatim for the same answer.
 */
export const addressKey = (city, street, house, country = '') => {
  const flat = (v) => String(v ?? '').replace(/["'׳״]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const base = [city, street, house].map(flat).join('|');
  return isForeign(country) ? `${base}|${String(country).trim().toLowerCase()}` : base;
};

/** Everyone's address, one row per distinct house, with a headcount. */
export function listAddresses(db) {
  const rows = db.prepare(`SELECT trim(city) AS city, trim(street) AS street, trim(house) AS house,
                                  trim(country) AS country, COUNT(*) AS n
                             FROM people
                            WHERE deleted_at IS NULL AND trim(city) <> '' AND trim(street) <> ''
                         GROUP BY trim(city), trim(street), trim(house), trim(country)`).all();
  const cached = new Map(db.prepare('SELECT * FROM addresses').all().map((a) => [a.key, a]));
  return rows.map((r) => {
    const key = addressKey(r.city, r.street, r.house, r.country);
    const hit = cached.get(key);
    return {
      key, city: r.city, street: r.street, house: r.house, country: r.country || '', count: r.n,
      lat: hit && hit.lat != null ? hit.lat : null,
      lng: hit && hit.lng != null ? hit.lng : null,
      queried: !!(hit && hit.queried_at),
    };
  });
}

export function upsertAddress(db, { key, city, street, house, country = '', lat, lng, display = '', source = 'manual' }) {
  db.prepare(`INSERT INTO addresses (key, city, street, house, country, lat, lng, display, source, queried_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))
              ON CONFLICT(key) DO UPDATE SET
                lat=excluded.lat, lng=excluded.lng, display=excluded.display, source=excluded.source,
                country=excluded.country,
                queried_at=excluded.queried_at, updated_at=excluded.updated_at`)
    .run(key, city, street, house, country || '', lat, lng, display, source);
}

export function markAddressMiss(db, { key, city, street, house, country = '' }) {
  db.prepare(`INSERT INTO addresses (key, city, street, house, country, source, queried_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'miss', strftime('%s','now'), strftime('%s','now'))
              ON CONFLICT(key) DO UPDATE SET
                queried_at=strftime('%s','now'), updated_at=strftime('%s','now')`)
    .run(key, city, street, house, country || '');
}

// ── the address vocabulary ───────────────────────────────────────────────────

/**
 * The towns to offer for one country, best first.
 *
 * At home that is every settlement in Israel, with how many people in the tree
 * live there — the count is what lets the picker put עומר and באר שבע above the
 * other 1,308. Abroad there is no such list, so what is offered instead is the
 * towns the family is already in THAT country: three entries for Italy is a
 * short list and it is the one that stops Rome being typed four ways.
 */
export function listSettlements(db, country = '') {
  const tally = cityTally(db);
  if (isForeign(country)) {
    const want = String(country).trim().toUpperCase();
    return tally
      .filter((c) => String(c.country || '').toUpperCase() === want)
      .map((c) => ({ name: c.city, code: null, count: c.n }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'he'));
  }
  const counts = new Map(tally.filter((c) => !isForeign(c.country)).map((c) => [c.city, c.n]));
  const rows = db.prepare('SELECT code, name FROM settlements ORDER BY name').all()
    .map((s) => ({ name: s.name, code: s.code, count: counts.get(s.name) || 0 }));
  // A city somebody typed that is not in the government list — one of the
  // registry's mangled spellings, or a town in Area C the list omits — still
  // belongs in the picker, or the next person to open that form would silently
  // "correct" it to something else.
  const known = new Set(rows.map((r) => r.name));
  for (const [name, n] of counts) if (!known.has(name)) rows.push({ name, code: null, count: n });
  return rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'he'));
}

/**
 * The streets of one settlement, by name. Empty for a place with none — and
 * empty for every town outside Israel, where the only street list we have is
 * the one data.gov.il publishes and it stops at the border. The form says as
 * much rather than offering a list that is silently a different question.
 */
export function listStreets(db, city, country = '') {
  if (isForeign(country)) return [];
  const s = db.prepare('SELECT code FROM settlements WHERE name = ?').get(String(city || '').trim());
  if (!s) return [];
  return db.prepare('SELECT name FROM streets WHERE settlement_code = ? ORDER BY name').all(s.code)
    .map((r) => r.name);
}

/** Remember that we looked and found nothing, so the next run can skip ahead. */
export function markPlaceMiss(db, name, country = '') {
  db.prepare(`INSERT INTO places (name, country, lat, lng, display, source, queried_at, updated_at)
              VALUES (?, ?, NULL, NULL, '', 'miss', strftime('%s','now'), strftime('%s','now'))
              ON CONFLICT(name, country) DO UPDATE SET
                queried_at=strftime('%s','now'), updated_at=strftime('%s','now')`)
    .run(name, country || '');
}
