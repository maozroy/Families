// Families as first-class rows.
//
// `people.branch` holds strings like `Levi`, `Levi (in-law)`, `Mizrahi
// (unconfirmed)`. The tree has always collapsed those to a key for its branch
// chips; that key is now the primary key of a real table, so a family can own a
// name in both languages and — the point of the exercise — a colour that a
// relative chose and that survives the next reload.
//
// The table follows the tree rather than leading it: ensureFamilies() creates a
// row for every branch key that occurs in `people` and never deletes one, so a
// family whose last member is removed keeps its colour if they come back.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultColor, isHex, normHex } from './colors.mjs';
import { recordChange } from './store.mjs';

/**
 * The family key for one person: their branch with any parenthesised suffix
 * dropped, except that "unconfirmed" is a family of its own — those people are
 * not claimed by a branch yet, and colouring them as one would assert a link
 * the records do not support.
 *
 * This is the same rule the tree's groupOf() applies client-side. It lives here
 * too because the server has to agree about which families exist.
 */
export function familyKey(person) {
  const br = String((person && (person.branch ?? person)) || '');
  if (/unconfirmed/i.test(br)) return 'unconfirmed';
  return br.replace(/\s*\(.*\)\s*$/, '').trim() || 'other';
}

/* The Hebrew and English display names for each family key, seeded into new
 * rows; editable afterwards, at which point the DB is authoritative and this
 * list is only a starting point.
 *
 * Loaded from `config/seed-names.json` rather than written here, because this
 * source is public and a family's own surnames are theirs, not the code's.
 * The file is a plain `{ key: [hebrew, english] }` map; see
 * `config/seed-names.example.json`. Absent or unreadable, seeding falls back to
 * the Latin key for BOTH names, which is how a Hebrew reader ends up with a
 * family called "Levi" in a tree where every member is a לוי — and it is
 * silent, because the English half looks perfectly correct.
 * `node scripts/fix-family-names.mjs --check` is the thing that says so out
 * loud; run it after any script adds a branch.
 *
 * EVERY KEY THAT OCCURS IN `people.branch` BELONGS IN THAT FILE, in both
 * languages. The Hebrew should be the spelling the family's own members carry
 * on their rows, not a transliteration invented here. */
const SEED_NAMES_PATH = process.env.FAMILY_SEED_NAMES
  || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'seed-names.json');

export const SEED_NAMES = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(SEED_NAMES_PATH, 'utf8'));
    // Shape-check rather than trust: a half-written file must not turn into
    // families named `undefined` across the whole tree.
    return Object.fromEntries(Object.entries(raw).filter(
      ([, v]) => Array.isArray(v) && v.length === 2 && v.every((s) => typeof s === 'string')));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.error(`[family] ${SEED_NAMES_PATH} is unreadable — families will be named after their keys:`,
        err?.message || err);
    }
    return {};
  }
})();

/** Does this string contain a Hebrew letter at all? */
export const hasHebrew = (s) => /[\u05d0-\u05ea]/.test(String(s || ''));

/**
 * Families whose name is not really in both languages.
 *
 * `reason` is 'he' when the Hebrew name has no Hebrew letter in it — which in
 * practice means it is still the bare Latin key — and 'en' for the mirror case.
 * A family with no members is reported too: it will be back on screen the
 * moment somebody is filed under it again.
 */
export function familiesMissingAName(db) {
  return listFamilies(db)
    .map((f) => {
      if (!hasHebrew(f.nameHe)) return { ...f, reason: 'he' };
      if (hasHebrew(f.nameEn)) return { ...f, reason: 'en' };
      return null;
    })
    .filter(Boolean);
}

/**
 * Make sure every family the tree currently contains has a row, and return them
 * all. Ordering the new keys by size before assigning `seq` is what puts the
 * biggest families on the most distinct hues on the very first run; after that
 * `seq` is frozen, so nobody's colour moves because a cousin was added.
 */
export function ensureFamilies(db) {
  const have = new Set(db.prepare('SELECT key FROM families').all().map((r) => r.key));
  const counts = tally(db);
  const missing = [...counts.keys()].filter((k) => !have.has(k))
    .sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));

  if (missing.length) {
    let seq = db.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM families').get().m + 1;
    const ins = db.prepare(`INSERT INTO families (key, name_he, name_en, color, seq)
                            VALUES (?, ?, ?, ?, ?)`);
    for (const key of missing) {
      const [he, en] = SEED_NAMES[key] || [key, key];
      ins.run(key, he, en, defaultColor(seq), seq);
      seq++;
    }
  }
  return listFamilies(db);
}

/** branch key → number of living-in-the-tree people carrying it. */
function tally(db) {
  const rows = db.prepare("SELECT branch, COUNT(*) AS n FROM people WHERE deleted_at IS NULL GROUP BY branch").all();
  const out = new Map();
  for (const r of rows) {
    const k = familyKey({ branch: r.branch });
    out.set(k, (out.get(k) || 0) + r.n);
  }
  return out;
}

/** Every family, with its live headcount, biggest first. */
export function listFamilies(db) {
  const counts = tally(db);
  return db.prepare('SELECT * FROM families').all()
    .map((f) => ({
      key: f.key,
      nameHe: f.name_he || f.key,
      nameEn: f.name_en || f.key,
      color: f.color || defaultColor(f.seq || 0),
      seq: f.seq || 0,
      count: counts.get(f.key) || 0,
      updatedBy: f.updated_by || '',
      updatedAt: (f.updated_at || 0) * 1000,
    }))
    .sort((a, b) => b.count - a.count || a.seq - b.seq);
}

export const getFamily = (db, key) => db.prepare('SELECT * FROM families WHERE key=?').get(key) || null;

/**
 * Change a family's colour, and say so in the log.
 *
 * Logged as an `edit` with no person_id, because the change log's `kind` column
 * is a CHECK constraint on an append-only table and widening it would mean
 * rebuilding that table — a bad trade for a colour. `before`/`after` carry the
 * family key alongside the colour, which is what lets undo find its way back
 * (see the family branch in undo()) and what lets the English log render a
 * sentence instead of the stored Hebrew one.
 *
 * Returns the updated family, or null if the key is unknown / the colour is not
 * a #rrggbb. A no-op change writes nothing: the log is for decisions, and
 * re-picking the colour that is already set is not one.
 */
export function setFamilyColor(db, key, color, actor) {
  const fam = getFamily(db, key);
  if (!fam) return null;
  const next = normHex(color);
  if (!isHex(next)) return null;
  const prev = normHex(fam.color || defaultColor(fam.seq || 0));
  if (prev === next) return listFamilies(db).find((f) => f.key === key);

  db.prepare("UPDATE families SET color=?, updated_at=strftime('%s','now'), updated_by=? WHERE key=?")
    .run(next, actor?.email || '', key);

  recordChange(db, {
    actor: actor?.email || '', actor_no: actor?.person?.person_no ?? null,
    kind: 'edit', person_id: null, person_no: null,
    summary: `הצבע של משפחת ${fam.name_he || key} שונה מ־${prev} ל־${next}`,
    before: { family: key, family_color: prev },
    after: { family: key, family_color: next },
  });

  return listFamilies(db).find((f) => f.key === key);
}

/**
 * Undo support: put a family back the way it was, writing no log entry of its
 * own — undo() records the reversal itself, and a second entry here would make
 * one action look like two.
 */
export function restoreFamily(db, key, { family_color: color, family_name_he: he, family_name_en: en } = {}) {
  if (!getFamily(db, key)) return false;
  if (color !== undefined) {
    if (!isHex(color)) return false;
    db.prepare("UPDATE families SET color=?, updated_at=strftime('%s','now') WHERE key=?").run(normHex(color), key);
  }
  if (he !== undefined || en !== undefined) {
    const cur = getFamily(db, key);
    db.prepare("UPDATE families SET name_he=?, name_en=?, updated_at=strftime('%s','now') WHERE key=?")
      .run(he === undefined ? cur.name_he : String(he || ''), en === undefined ? cur.name_en : String(en || ''), key);
  }
  return true;
}

/** Rename a family. Owner-only at the route; the names are shared vocabulary. */
export function setFamilyNames(db, key, { nameHe, nameEn }, actor) {
  const fam = getFamily(db, key);
  if (!fam) return null;
  const he = nameHe === undefined ? fam.name_he : String(nameHe || '').trim();
  const en = nameEn === undefined ? fam.name_en : String(nameEn || '').trim();
  if (he === fam.name_he && en === fam.name_en) return listFamilies(db).find((f) => f.key === key);

  db.prepare("UPDATE families SET name_he=?, name_en=?, updated_at=strftime('%s','now'), updated_by=? WHERE key=?")
    .run(he, en, actor?.email || '', key);
  recordChange(db, {
    actor: actor?.email || '', actor_no: actor?.person?.person_no ?? null,
    kind: 'edit', person_id: null, person_no: null,
    summary: `שם משפחת ${fam.name_he || key} שונה ל־${he}`,
    before: { family: key, family_name_he: fam.name_he, family_name_en: fam.name_en },
    after: { family: key, family_name_he: he, family_name_en: en },
  });
  return listFamilies(db).find((f) => f.key === key);
}
