// The family DB, as the web service sees it.
//
// Everything that reads or writes family.db for the service goes through here,
// so there is exactly one place that knows how a person is shaped, what a
// relative is allowed to see, and how a change gets recorded.
//
// The DB is the source of truth. roster.mjs seeded it once and is now frozen —
// see ../README.md. Nothing in this file consults it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { changeAffectsAllowlist, requestCfSync } from './cf-sync-trigger.mjs';
import { changeAffectsGeocode, requestGeocode } from './geocode-trigger.mjs';
import { LIFE_EVENTS, lifePlaceKey, resolvePlaceId } from './places.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');
export const DB_PATH = path.join(ROOT, 'family.db');
export const LOG_PATH = path.join(ROOT, 'changes.log');
export const PHOTO_DIR = path.join(ROOT, 'photos');
export const DOC_DIR = path.join(ROOT, 'documents');

// The two facts the population registry states that do not change over a life.
// A human edit to either is a real disagreement with the state and gets flagged
// on the wiki; city and everything else just moves, so an edit there is silent.
export const IMMUTABLE_REGISTRY_FIELDS = ['sex', 'birth_date'];

// Columns a logged-in relative may write. Anything outside this list is ignored
// on the way in, which is what keeps tz, registry_name and person_no safe from
// a hand-rolled PATCH.
export const EDITABLE = [
  'first_he', 'last_he', 'first_en', 'last_en', 'maiden_name', 'sex',
  'birth_date', 'death_date', 'country', 'city', 'street', 'house', 'occupation', 'email', 'phone',
  'instagram', 'facebook', 'linkedin',
  'father_id', 'mother_id', 'notes', 'born_after_sunset',
  // A relative may correct where someone was born, and may assert an origin for
  // someone the records cannot reach. origin_country / origin_mix / origin_basis
  // are outputs and are not theirs to set — they are recomputed from these.
  'birth_country', 'origin_override', 'origin_override_note',
  // The three life places. `birth_country` above is one of them — it was here
  // first, as an origin input, and it is the same fact.
  'birth_city', 'death_city', 'death_country',
  'burial_city', 'burial_country', 'burial_place', 'burial_plot',
  // Behind the editor's "advanced" fold. wiki_title_* are deliberately absent:
  // which page a person renders to is not the family's to retarget.
  'alma_mater', 'interests', 'marital_status', 'children_complete',
];

/**
 * The structural columns, writable only from the advanced editor (/edit).
 *
 * These are NOT in EDITABLE on purpose, and adding them there would have been
 * the wrong fix: EDITABLE is what the ordinary form offers to a relative adding
 * a cousin, and every one of these is bookkeeping about the RESEARCH rather
 * than a fact about a person. `branch` decides what colour a node is drawn in,
 * `generation` decides what row it sits on, `no_sync` decides whether the
 * population registry is allowed to overwrite the row at all — a mistyped one
 * is a tree that looks broken with nothing on any person's card to explain it.
 *
 * They are still writable by anyone signed in, which is the same rule the rest
 * of the app follows: what protects the data is not permissions but the change
 * log. What the separate page buys is that nobody reaches them by accident.
 *
 * Deliberately absent, and listed here so the next person does not have to
 * work out whether it was an oversight — see LOCKED below for each one's
 * reason: id, person_no, tz, google_sub, name_he, name_en, spouse_id,
 * registry_*, origin_country / origin_mix / origin_basis, *_place_id,
 * last_seen_at, curated, created_by, updated_by, updated_at, deleted_at.
 */
export const ADVANCED_EDITABLE = [
  'branch', 'generation', 'source', 'no_sync', 'deceased',
  'dna_23andme', 'lang', 'birth_precision', 'wiki_title_he', 'wiki_title_en',
];

/**
 * Every column a request may write, ordinary form and advanced page together.
 *
 * This is what the write path, the undo path and recomputeCurated() must all
 * read. EDITABLE alone is what they read before the advanced page existed, and
 * leaving them on it would have produced three quiet half-failures rather than
 * an error: an advanced field would save and then be dropped by addPerson()'s
 * INSERT, undo() would mark a change undone without reverting it, and
 * recomputeCurated() would forget that a human had ever set it.
 */
export const ALL_EDITABLE = [...EDITABLE, ...ADVANCED_EDITABLE];

/**
 * The columns the advanced page SHOWS but refuses to write, and why.
 *
 * A field that is derived and offered anyway is worse than one that is hidden:
 * the edit appears to save, and the next sweep silently puts the old value
 * back. So each of these is rendered read-only with its reason and, where
 * there is one, a pointer at the surface that does control it.
 *
 * `[he, en, hint_he, hint_en]`. The hint is what to do instead, or ''.
 */
export const LOCKED = {
  id: ['מזהה', 'id',
    'המפתח שכל הקישורים בעץ מצביעים אליו. שינוי שלו מנתק הורים, ילדים ובני זוג בבת אחת.',
    'The key every link in the tree points at. Changing it detaches parents, children and spouses at once.'],
  person_no: ['מספר אדם', 'person number',
    'מספרי האנשים קבועים — הם מודפסים, נשלחים בקישורים ומצוטטים בוויקי.',
    'Person numbers are permanent — they are printed, sent in links and quoted on the wiki.'],
  tz: ['ת.ז.', 'national ID',
    'לא נערך מהאתר בשום מצב. הוא המפתח שמולו רשות האוכלוסין מסונכרנת.',
    'Never edited from the web app. It is the key the population registry is synced against.'],
  google_sub: ['מזהה חשבון Google', 'Google account id',
    'אסמכתת ההתחברות של האדם הזה. עריכה שלה היא התחזות, לא תיקון.',
    "This person's sign-in credential. Editing it is impersonation, not a correction."],
  name_he: ['שם מלא', 'full name (Hebrew)',
    'מורכב אוטומטית משם פרטי + שם משפחה.', 'Composed automatically from the given name and surname.'],
  name_en: ['שם מלא באנגלית', 'full name (English)',
    'מורכב אוטומטית משם פרטי + שם משפחה באנגלית.', 'Composed automatically from the English given name and surname.'],
  spouse_id: ['בן/בת זוג', 'spouse',
    'נגזר מטבלת הקשרים. ערכו את הקשר עצמו למטה — כתיבה ישירה כאן תידרס בסנכרון הבא.',
    'Derived from the unions table. Edit the union below — a direct write here is overwritten by the next sync.'],
  registry_name: ['שם ברשות האוכלוסין', 'registry name',
    'מה שהמרשם אמר בפעם האחרונה. `family sync` כותב אותו מחדש בכל ריצה.',
    'What the registry last said. `family sync` rewrites it on every run.'],
  registry_sex: ['מין לפי המרשם', 'registry sex',
    'מה שהמרשם אמר בפעם האחרונה. `family sync` כותב אותו מחדש בכל ריצה.',
    'What the registry last said. `family sync` rewrites it on every run.'],
  registry_birth_date: ['תאריך לידה לפי המרשם', 'registry date of birth',
    'מה שהמרשם אמר בפעם האחרונה. `family sync` כותב אותו מחדש בכל ריצה.',
    'What the registry last said. `family sync` rewrites it on every run.'],
  origin_country: ['ארץ מקור (מחושב)', 'country of origin (derived)',
    'נגזר מההורים ומארץ הלידה. כדי לשנות — מלאו "ארץ מקור" על האב הקדמון שהשושלת נעצרת בו.',
    'Derived from the parents and the country of birth. To change it, set the origin on the ancestor the line stops at.'],
  origin_mix: ['תמהיל מקור', 'origin mix',
    'נגזר. סכום החלקים תמיד 1.', 'Derived. The shares always sum to 1.'],
  origin_basis: ['בסיס החישוב', 'origin basis',
    'נגזר — רושם דרך מי הגיעה ארץ המקור.', 'Derived — records which ancestors the origin came through.'],
  birth_place_id: ['שורת מקום הלידה', 'birth place row',
    'נגזר מעיר הלידה + ארץ הלידה שמעל.', 'Derived from the town and country of birth above.'],
  death_place_id: ['שורת מקום הפטירה', 'death place row',
    'נגזר ממקום הפטירה + ארץ הפטירה שמעל.', 'Derived from the town and country of death above.'],
  burial_place_id: ['שורת מקום הקבורה', 'burial place row',
    'נגזר מעיר הקבורה + ארץ הקבורה שמעל.', 'Derived from the town and country of burial above.'],
  last_seen_at: ['ביקור אחרון', 'last seen',
    'נרשם אוטומטית כשהאדם נכנס לאתר.', 'Recorded automatically when this person uses the app.'],
  curated: ['שדות שנערכו ביד', 'hand-edited fields',
    'נבנה מיומן השינויים. אלה השדות ש-`family sync` לא ידרוס.',
    'Built from the change log. These are the fields `family sync` will not overwrite.'],
  created_by: ['נוצר בידי', 'created by', '', ''],
  updated_by: ['עודכן בידי', 'updated by', '', ''],
  updated_at: ['עודכן בתאריך', 'updated at', '', ''],
  deleted_at: ['הוסר בתאריך', 'removed at',
    'השתמשו בכפתור ההסרה/השחזור — שניהם נרשמים ביומן.',
    'Use the remove / restore buttons — both are written to the change log.'],
};

/** Editing any of these changes the derived origin of the person AND their line. */
export const ORIGIN_INPUTS = ['origin_override', 'birth_country', 'father_id', 'mother_id'];

/** What we say when a line genuinely cannot be traced. Never an anchor, never inherited. */
export const ORIGIN_UNKNOWN = 'לא ידוע';

/**
 * The `origin_basis` values that mean "this came down from a parent".
 *
 * These are exactly the cases where recomputeOrigins() takes the `parts.length`
 * branch, and its `else if (anchor[id])` — which is where an override is read —
 * is therefore never reached. An override on such a person is not overridden by
 * something better; it is never looked at. It was still offered in the form,
 * with helper text promising it would flow down to their descendants.
 *
 * So: a person whose origin comes from their parents cannot assert one. The
 * place to correct their line is the ancestor the line actually stops at, which
 * `originSources()` names.
 */
export const ORIGIN_FROM_PARENTS = ['parents', 'father-only', 'mother-only'];

/** Would an origin typed on this person be used? False when it comes from above. */
export const originIsDerived = (p) => ORIGIN_FROM_PARENTS.includes(p?.origin_basis || '');

/**
 * The parents this person's origin actually came through — one id for
 * `father-only` / `mother-only`, both for `parents`, none otherwise.
 *
 * Not simply "their parents": a parent whose own origin was borrowed downward
 * from this line is refused by the derivation, and a parent whose line runs out
 * contributes an unknown share rather than a country. The basis records which
 * sides were really used, so this reports where the answer came from rather than
 * who happens to be in the row.
 */
export function originSources(p) {
  const b = p?.origin_basis || '';
  if (b === 'parents') return [p.father_id, p.mother_id].filter(Boolean);
  if (b === 'father-only') return [p.father_id].filter(Boolean);
  if (b === 'mother-only') return [p.mother_id].filter(Boolean);
  return [];
}

/** UI languages. `he` is the default; relatives abroad get `en`. */
export const LANGS = ['he', 'en'];

// ── open + migrate ───────────────────────────────────────────────────────────

const ADDED_COLUMNS = [
  ['person_no', 'INTEGER'],
  ['first_he', "TEXT NOT NULL DEFAULT ''"],
  ['last_he', "TEXT NOT NULL DEFAULT ''"],
  ['first_en', "TEXT NOT NULL DEFAULT ''"],
  ['last_en', "TEXT NOT NULL DEFAULT ''"],
  // Preferred UI language, so a relative abroad lands in English on every
  // device rather than re-picking it each time.
  ['lang', "TEXT NOT NULL DEFAULT ''"],
  ['maiden_name', "TEXT NOT NULL DEFAULT ''"],
  // The rest of the address, beside `city`. Kept in two columns rather than one
  // free-text line because the point of collecting it is to put a pin on a
  // house: "רחוב הרצל 14" and "הרצל 14, רחוב" are the same address and two
  // different strings, and only one of them geocodes. Both are optional — the
  // tree has always worked with nothing finer than a city.
  ['street', "TEXT NOT NULL DEFAULT ''"],
  ['house', "TEXT NOT NULL DEFAULT ''"],
  // Which country that address is in, as an ISO 3166-1 alpha-2 code — '' means
  // Israel, which is what every row already said by saying nothing and what the
  // form leaves alone unless somebody moves abroad. It is the field that
  // decides which vocabulary the pickers offer and how the geocoder asks, and
  // without it a relative in Rome typed a town no bounded-to-Israel lookup
  // could ever return. See web/public/app/countries.js.
  ['country', "TEXT NOT NULL DEFAULT ''"],
  ['occupation', "TEXT NOT NULL DEFAULT ''"],
  ['email', "TEXT NOT NULL DEFAULT ''"],
  ['phone', "TEXT NOT NULL DEFAULT ''"],
  // JSON array of column names a human edited; `family sync` leaves these alone.
  ['curated', "TEXT NOT NULL DEFAULT ''"],
  // What the registry last said, kept verbatim so a human/registry disagreement
  // stays visible after the human's value has overwritten the live column.
  ['registry_sex', "TEXT NOT NULL DEFAULT ''"],
  ['registry_birth_date', "TEXT NOT NULL DEFAULT ''"],
  ['deleted_at', 'INTEGER'],
  ['created_by', "TEXT NOT NULL DEFAULT ''"],
  ['updated_by', "TEXT NOT NULL DEFAULT ''"],
  // The Google account this person has signed in with, pinned on first login.
  // `email` is the enrolment key — an address is typed onto a row by hand — but
  // an address is reassignable (a lapsed custom domain re-registered with
  // Workspace verifies just as well), and `sub` is the only identifier Google
  // promises is stable. Once pinned, both must match. Never in EDITABLE, never
  // in publicPerson: the family does not see it and cannot set it.
  ['google_sub', "TEXT NOT NULL DEFAULT ''"],
  // Where the person was actually born, as the registry records it. A fact, not
  // a conclusion: blank means unknown, and 'ישראל' is a real answer.
  ['birth_country', "TEXT NOT NULL DEFAULT ''"],
  // The country the family came FROM, which is a different question — for anyone
  // born in Israel it is whatever their forebears left. Kept separate from
  // birth_country so a derived answer can never be mistaken for a registry one,
  // and recomputable from scratch by scripts/derive-origin.mjs.
  // Almost nobody is from one place, so this holds the DOMINANT origin only, for
  // labels and filters; origin_mix below is the real answer.
  ['origin_country', "TEXT NOT NULL DEFAULT ''"],
  // Fractional ancestry as JSON, e.g. {"תימן":0.5,"מרוקו":0.25,"רומניה":0.25}.
  // A foreign-born person is 100% their own birth country; everyone else is half
  // their father's mix and half their mother's. Shares always sum to 1.
  ['origin_mix', "TEXT NOT NULL DEFAULT ''"],
  // A country a human has asserted for this person, when the records cannot get
  // there. This is the ONE origin field the family may write, and it is an input
  // to the derivation rather than an output: setting it re-derives this person and
  // everyone descended from them, so correcting a great-grandparent fixes the
  // whole line underneath in one edit.
  ['origin_override', "TEXT NOT NULL DEFAULT ''"],
  ['origin_override_note', "TEXT NOT NULL DEFAULT ''"],
  // How origin_country was reached: 'self' | 'ancestor:<id>' | 'child:<id>' |
  // 'sibling:<id>' | 'spouse:<id>', plus a '!conflict(...)' suffix when the
  // evidence disagreed. Every derived value stays auditable and reversible.
  ['origin_basis', "TEXT NOT NULL DEFAULT ''"],
  // Where a relative can be reached besides the phone: the canonical profile
  // URL, one column per network, written only through FamilyContacts.normalize
  // so what is stored is always something that can be opened. WhatsApp has no
  // column of its own — it is derived from `phone`, and a second copy of a
  // number is a second copy that can go stale.
  ['instagram', "TEXT NOT NULL DEFAULT ''"],
  ['facebook', "TEXT NOT NULL DEFAULT ''"],
  ['linkedin', "TEXT NOT NULL DEFAULT ''"],
  // A Hebrew day starts at sunset, so a birth in the evening belongs to the
  // next Hebrew date — and a civil date with no time cannot say which. This is
  // the family answering that, one row at a time: 0 means daytime OR nobody has
  // said, which are the same date. It does NOT move `birth_date`; the civil day
  // somebody was born on is not in question. See web/public/app/hebrew.js.
  ['born_after_sunset', 'INTEGER NOT NULL DEFAULT 0'],
  // ── where a life happened, as opposed to where it is lived ───────────────
  //
  // `city`/`street`/`house` are an ADDRESS: current, postal, and empty for
  // everyone who has died. These three pairs are EVENTS, and an event has a
  // place that never changes. Somebody born in Iaşi in 1912 who died in Be'er
  // Sheva in 1973 has three towns on their row and only one of them is where
  // any letter would have reached them.
  //
  // The country is a NAME here and a code in `country`, which looks like an
  // inconsistency and is the one thing on this row that has to be. A residence
  // is in a country that exists — ISO has a code for it, the form offers it,
  // Nominatim narrows by it. A birth is in whatever the country was called at
  // the time: ברית המועצות, בסרביה, Ottoman Palestine. Those have no codes, and
  // forcing one would make the family answer a question about 1912 with a fact
  // about 2026. `birth_country` was already a name — it is what feeds the
  // origin derivation, whose whole vocabulary is historic country names — so
  // the other two match it rather than the address. lib/places.mjs resolves a
  // name to a code where one exists, for the geocoder, and shrugs where it
  // does not.
  ['birth_city', "TEXT NOT NULL DEFAULT ''"],
  ['death_city', "TEXT NOT NULL DEFAULT ''"],
  ['death_country', "TEXT NOT NULL DEFAULT ''"],
  // Where they are buried, in four parts, because "the grave" is two different
  // questions asked by two different people. A relative planning a visit needs
  // the TOWN and the CEMETERY, which is what the map can put a pin on. Somebody
  // standing at the gate needs the PLOT — גוש י', חלקה 28, שורה 19, מספר 32 —
  // which no map has ever been able to place and which is copied verbatim off a
  // burial-society record. Kept apart so the first three can be geocoded and
  // the fourth can stay the unparsed string the registry gave us.
  ['burial_city', "TEXT NOT NULL DEFAULT ''"],
  ['burial_country', "TEXT NOT NULL DEFAULT ''"],
  ['burial_place', "TEXT NOT NULL DEFAULT ''"],
  ['burial_plot', "TEXT NOT NULL DEFAULT ''"],
  // When this person last USED the app, in epoch seconds; 0 means never.
  // See touchSeen() below for why this is a column and not a query.
  ['last_seen_at', 'INTEGER NOT NULL DEFAULT 0'],
  // Where they studied and what they are into — two of the three things the
  // wiki's person pages say that no column could hold. The third, "career",
  // deliberately did NOT become a column: a working life is several jobs with
  // their own dates and places, so it is `events`.
  ['alma_mater', "TEXT NOT NULL DEFAULT ''"],
  ['interests', "TEXT NOT NULL DEFAULT ''"],
  ['marital_status', "TEXT NOT NULL DEFAULT ''"],
  // "An only child" is not a stored fact — the renderer counts siblings. But an
  // empty child list means "nobody has researched them" for most of the tree,
  // and a page that reports that absence as fact would assert "an only child"
  // across hundreds of people. This flag, set on the PARENT, is the difference
  // between "we found none" and "we know there were none".
  ['children_complete', 'INTEGER NOT NULL DEFAULT 0'],
  // The wiki page this person is rendered to, one per language. Written once by
  // a reviewed mapping pass and authoritative thereafter — never re-derived from
  // names at runtime, which is how [[Dana Levi]] came to describe the wrong man.
  ['wiki_title_en', "TEXT NOT NULL DEFAULT ''"],
  ['wiki_title_he', "TEXT NOT NULL DEFAULT ''"],
  /* This `spouse_id` link is a marriage that ENDED. Set on both rows of the
     pair, because either side may be the one a reader is walking from.
     Without it "ex" was recorded nowhere but inside the English relation text —
     21 labels said "aunt's ex-husband's nephew" and the row itself claimed an
     intact marriage, so no calculator could reproduce them and every recompute
     quietly promoted three divorces back into marriages. */
  ['spouse_ex', 'INTEGER NOT NULL DEFAULT 0'],
  // The `places` row each life event happened in. DERIVED from the *_city /
  // *_country text beside them, never typed — see syncPlaceIds(). The text
  // stays the writable surface because a birth country is also an origin
  // (lib/origins.mjs keys its whole table on the name, including 'Bessarabia',
  // which is not a country and has no code), and because the editor must keep
  // accepting a town nobody has heard of.
  ['birth_place_id', 'INTEGER REFERENCES places(id)'],
  ['death_place_id', 'INTEGER REFERENCES places(id)'],
  ['burial_place_id', 'INTEGER REFERENCES places(id)'],
];

export function openDb({ readonly = false } = {}) {
  const db = new DatabaseSync(DB_PATH, { readOnly: readonly });
  // Several processes hold this file open at once — the tree web service, the
  // home page, the DNA invite batch, the ten-minute wiki sync. The file is
  // journal_mode=delete, and opening takes a write lock immediately (the schema
  // exec below), so without a busy timeout a concurrent write of a few
  // milliseconds turns an open into a hard SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 15000');
  if (readonly) return db;
  db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf-8'));
  db.exec(fs.readFileSync(path.join(ROOT, 'schema-service.sql'), 'utf-8'));
  const have = new Set(db.prepare('PRAGMA table_info(people)').all().map((c) => c.name));
  for (const [col, def] of ADDED_COLUMNS)
    if (!have.has(col)) db.exec(`ALTER TABLE people ADD COLUMN ${col} ${def}`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS people_no ON people(person_no) WHERE person_no IS NOT NULL');

  // An address is a login credential, so two rows may not claim the same one:
  // a duplicate would resolve to whichever row SQLite reached first and file
  // that person's edits under the other one's name. Indexed on the normalised
  // form because that is what the login lookup compares against.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS people_email_ci
             ON people(lower(trim(email))) WHERE trim(email) <> ''`);
  // Likewise one Google account may be pinned to at most one person.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS people_google_sub
             ON people(google_sub) WHERE google_sub <> ''`);
  migrateCountries(db);
  migratePlaceIds(db);
  migrateChangeKinds(db);
  migrateFacts(db);
  return db;
}

/**
 * Grow `person_facts` into the table `events` was supposed to be, and retire
 * `events`.
 *
 * `CREATE TABLE IF NOT EXISTS` in schema-service.sql only shapes a DB that does
 * not have `person_facts` yet, and this one has had it since the evidence layer
 * shipped — so the columns have to be added here. A REBUILD rather than seven
 * ALTER TABLE ADD COLUMNs, because `kind` carries a CHECK and the whole value
 * of a vocabulary is that the DB refuses what is not in it.
 *
 * `id` is copied explicitly and never regenerated: 277 rows in
 * `claim_citations` address these facts by id, and an AUTOINCREMENT that
 * renumbered them would silently re-point every piece of evidence in the tree
 * at the wrong fact. That is the one irreversible mistake available here, which
 * is why the check below counts them again afterwards.
 *
 * `events` and `event_people` are dropped rather than left: both are empty,
 * nothing outside this file ever read them, and a second table with the same
 * shape is what made the structured one the one you were always about to start
 * using.
 */
function migrateFacts(db) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='person_facts'").get()?.sql || '';
  if (sql.includes('kind')) { factIndexes(db); return; }

  /* Citations that RESOLVE, not citations that exist — the two differ, and
     comparing one against the other made this throw on a DB that was fine.
     Row 3694 carries subject_kind='person_facts' with a person id in
     subject_id, so it has never pointed at a fact and never will; what has to
     be preserved across the rebuild is how many find their fact, which is the
     number an id renumbering would destroy. */
  const resolvable = () => db.prepare(`SELECT COUNT(*) n FROM claim_citations c
      WHERE c.subject_kind='person_facts'
        AND EXISTS (SELECT 1 FROM person_facts f WHERE f.id = CAST(c.subject_id AS INTEGER))`).get().n;
  const citesBefore = resolvable();
  const factsBefore = db.prepare('SELECT COUNT(*) n FROM person_facts').get().n;

  // Refuse to run rather than lose anything: `events` held no rows for its whole
  // life, and if this ever finds one it means somebody started using it between
  // the survey and the migration, and dropping it would take their work.
  const strays = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='events'").get().n
    ? db.prepare('SELECT COUNT(*) n FROM events').get().n : 0;
  if (strays) throw new Error(`events has ${strays} row(s); migrate them into person_facts before retiring it`);

  db.exec('PRAGMA foreign_keys=off');
  db.exec(`
    BEGIN;
    CREATE TABLE person_facts_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id  TEXT NOT NULL REFERENCES people(id),
      kind       TEXT NOT NULL DEFAULT 'other'
                   CHECK (kind IN (${FACT_KINDS.map((k) => `'${k}'`).join(',')})),
      label_he   TEXT NOT NULL DEFAULT '',
      label_en   TEXT NOT NULL DEFAULT '',
      value_he   TEXT NOT NULL DEFAULT '',
      value_en   TEXT NOT NULL DEFAULT '',
      start_date      TEXT NOT NULL DEFAULT '',
      start_precision TEXT NOT NULL DEFAULT '' CHECK (start_precision IN ('day','month','year','')),
      end_date        TEXT NOT NULL DEFAULT '',
      end_precision   TEXT NOT NULL DEFAULT '' CHECK (end_precision   IN ('day','month','year','')),
      place_id   INTEGER REFERENCES places(id),
      place_text TEXT NOT NULL DEFAULT '',
      as_of      TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL DEFAULT 'confirmed'
                   CHECK (confidence IN ('confirmed','probable','candidate','disproven')),
      details    TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      created_by TEXT NOT NULL DEFAULT '',
      deleted_at INTEGER
    );
    INSERT INTO person_facts_new
      (id, person_id, label_he, label_en, value_he, value_en, as_of, confidence,
       sort_order, created_at, created_by, deleted_at)
      SELECT id, person_id, label_he, label_en, value_he, value_en, as_of, confidence,
             sort_order, created_at, created_by, deleted_at FROM person_facts;
    DROP TABLE person_facts;
    ALTER TABLE person_facts_new RENAME TO person_facts;
    CREATE INDEX IF NOT EXISTS person_facts_person ON person_facts(person_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS person_facts_kind   ON person_facts(kind)      WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS person_facts_place  ON person_facts(place_id);

    CREATE TABLE IF NOT EXISTS fact_people (
      fact_id   INTEGER NOT NULL REFERENCES person_facts(id),
      person_id TEXT    NOT NULL REFERENCES people(id),
      role      TEXT    NOT NULL DEFAULT 'subject',
      PRIMARY KEY (fact_id, person_id, role)
    );
    CREATE INDEX IF NOT EXISTS fact_people_person ON fact_people(person_id);

    CREATE TABLE IF NOT EXISTS fact_links (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id   INTEGER NOT NULL REFERENCES person_facts(id),
      to_id     INTEGER NOT NULL REFERENCES person_facts(id),
      relation  TEXT NOT NULL DEFAULT 'see-also'
                  CHECK (relation IN (${FACT_RELATIONS.map((k) => `'${k}'`).join(',')})),
      note      TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      created_by TEXT NOT NULL DEFAULT '',
      UNIQUE (from_id, to_id, relation)
    );
    CREATE INDEX IF NOT EXISTS fact_links_to ON fact_links(to_id);

    -- The subject, mirrored, so "every fact this person is in" is one join.
    INSERT OR IGNORE INTO fact_people (fact_id, person_id, role)
      SELECT id, person_id, 'subject' FROM person_facts;

    DROP TABLE IF EXISTS event_people;
    DROP TABLE IF EXISTS events;
    COMMIT;`);
  db.exec('PRAGMA foreign_keys=on');

  const bad = db.prepare('PRAGMA foreign_key_check').all();
  if (bad.length) throw new Error(`person_facts rebuild broke ${bad.length} foreign key(s)`);
  const factsAfter = db.prepare('SELECT COUNT(*) n FROM person_facts').get().n;
  const citesAfter = resolvable();
  if (factsAfter !== factsBefore) throw new Error(`person_facts rebuild lost rows: ${factsBefore} → ${factsAfter}`);
  // The ids are the whole point. If a citation no longer finds its fact, the
  // renumbering this guards against has happened and the evidence layer is
  // pointing at the wrong rows.
  if (citesAfter !== citesBefore) throw new Error(`person_facts rebuild orphaned citations: ${citesBefore} → ${citesAfter}`);
  factIndexes(db);
  console.log(`[family] person_facts migrated: ${factsAfter} facts, ${citesAfter} citations intact, events retired`);
}

/* The indexes and relation tables, created every open rather than once.
   schema-service.sql cannot hold the two that name `kind` and `place_id`: it
   runs before this does, against a DB where those columns may not exist yet.
   All of it is IF NOT EXISTS, so this is a no-op on the second open. */
function factIndexes(db) {
  /* A plain ADD COLUMN, not another rebuild: `source` carries no CHECK and no
     foreign key, so there is nothing here that ALTER TABLE cannot do. The
     rebuild in migrateFacts() exists only because `kind` needed a constraint. */
  const cols = new Set(db.prepare('PRAGMA table_info(person_facts)').all().map((c) => c.name));
  if (!cols.has('source')) db.exec("ALTER TABLE person_facts ADD COLUMN source TEXT NOT NULL DEFAULT ''");

  db.exec(`
    CREATE INDEX IF NOT EXISTS person_facts_kind  ON person_facts(kind) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS person_facts_place ON person_facts(place_id);
    CREATE INDEX IF NOT EXISTS fact_people_person ON fact_people(person_id);
    CREATE INDEX IF NOT EXISTS fact_links_to      ON fact_links(to_id);

    /* ── the subject row, guaranteed by the DB ─────────────────────────────
       listFacts() reaches a fact by joining fact_people, so a fact with no
       subject row is a fact NOBODY CAN SEE — it is in the table, it is on
       nobody's card, and nothing reports it. addFact() writes the row, but
       eight scripts under scripts/ INSERT into person_facts directly, and one
       of them ran during the afternoon this was built and left six invisible
       facts behind. A convention every writer must remember is one a writer
       will forget, so this is a trigger and not a rule.

       The UPDATE trigger is for the same reason in the other direction: move a
       fact to another person with a hand-written UPDATE and the old subject row
       would be left behind, showing the fact on a card it no longer belongs to. */
    CREATE TRIGGER IF NOT EXISTS person_facts_subject_ins
      AFTER INSERT ON person_facts
    BEGIN
      INSERT OR IGNORE INTO fact_people (fact_id, person_id, role)
        VALUES (NEW.id, NEW.person_id, 'subject');
    END;

    CREATE TRIGGER IF NOT EXISTS person_facts_subject_upd
      AFTER UPDATE OF person_id ON person_facts
      WHEN OLD.person_id <> NEW.person_id
    BEGIN
      DELETE FROM fact_people WHERE fact_id = OLD.id AND person_id = OLD.person_id AND role = 'subject';
      INSERT OR IGNORE INTO fact_people (fact_id, person_id, role)
        VALUES (NEW.id, NEW.person_id, 'subject');
    END;`);

  /* And heal whatever slipped in before the trigger existed. Cheap — it is an
     anti-join over a table of a few hundred rows — and it runs on every open so
     a DB that was written to by an older copy of this code comes back correct
     rather than staying quietly broken. */
  const healed = db.prepare(`INSERT OR IGNORE INTO fact_people (fact_id, person_id, role)
    SELECT f.id, f.person_id, 'subject' FROM person_facts f
     WHERE NOT EXISTS (SELECT 1 FROM fact_people fp
                        WHERE fp.fact_id = f.id AND fp.person_id = f.person_id AND fp.role = 'subject')`).run();
  if (healed.changes) console.log(`[family] ${healed.changes} fact(s) had no subject row; fixed`);
}

/**
 * Give the two geocoded tables a country.
 *
 * `CREATE TABLE IF NOT EXISTS` in schema-service.sql only shapes a DB that does
 * not have these yet, and this one has had them since the map shipped. So:
 * `addresses` takes an ordinary added column, and `places` is rebuilt, because
 * what changed there is its primary key — a town is (name, country) now, and
 * SQLite cannot alter a key in place.
 *
 * Every existing row carries country '' , which is Israel and is what they all
 * were. Nothing is re-geocoded and no coordinate moves.
 */
function migrateCountries(db) {
  const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
  if (!cols('addresses').has('country'))
    db.exec("ALTER TABLE addresses ADD COLUMN country TEXT NOT NULL DEFAULT ''");
  if (cols('places').has('country')) return;
  db.exec(`
    BEGIN;
    CREATE TABLE places_new (
      name       TEXT NOT NULL,
      country    TEXT NOT NULL DEFAULT '',
      lat        REAL,
      lng        REAL,
      display    TEXT NOT NULL DEFAULT '',
      source     TEXT NOT NULL DEFAULT '',
      queried_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (name, country)
    );
    INSERT INTO places_new (name, country, lat, lng, display, source, queried_at, updated_at)
      SELECT name, '', lat, lng, display, source, queried_at, updated_at FROM places;
    DROP TABLE places;
    ALTER TABLE places_new RENAME TO places;
    COMMIT;`);
  db.exec('PRAGMA foreign_keys=on');
  const bad = db.prepare('PRAGMA foreign_key_check').all();
  if (bad.length) throw new Error(`places rebuild broke ${bad.length} foreign key(s)`);
}

/**
 * Give `places` an integer id, and a parent.
 *
 * Same reason `migrateCountries` rebuilt it: what changes is the primary key,
 * and SQLite cannot alter one in place. Other tables point at a place now — a
 * birth, a job, a memorial — and pointing at a two-column text key from four
 * places is how you end up with four spellings of Carpineni.
 *
 * Nothing moves. (name, country) is still unique, which is what every existing
 * query and every ON CONFLICT in lib/places.mjs relies on, and no coordinate is
 * re-geocoded. The extra `id` / `parent_id` columns are simply ignored by the
 * `SELECT *` readers in lib/places.mjs and the map.
 */
function migratePlaceIds(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(places)').all().map((c) => c.name));
  if (cols.has('id')) return;
  // node:sqlite turns foreign keys ON, unlike the C library's default, so this
  // is SQLite's documented table-rebuild recipe rather than a plain BEGIN: with
  // enforcement live, DROP TABLE places fails the moment any child row points at
  // it. The pragma cannot be toggled inside a transaction, hence the three calls.
  db.exec('PRAGMA foreign_keys=off');
  db.exec(`
    BEGIN;
    CREATE TABLE places_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      country    TEXT NOT NULL DEFAULT '',
      -- Self-referencing the table being built, not "places": the old table is
      -- still there and still has no id, so REFERENCES places(id) is a foreign
      -- key mismatch and the INSERT below fails. The RENAME rewrites this to
      -- "places" for us.
      parent_id  INTEGER REFERENCES places_new(id),
      lat        REAL,
      lng        REAL,
      display    TEXT NOT NULL DEFAULT '',
      source     TEXT NOT NULL DEFAULT '',
      queried_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE (name, country)
    );
    INSERT INTO places_new (name, country, lat, lng, display, source, queried_at, updated_at)
      SELECT name, country, lat, lng, display, source, queried_at, updated_at FROM places;
    DROP TABLE places;
    ALTER TABLE places_new RENAME TO places;
    COMMIT;`);
}

/**
 * Widen the `changes.kind` CHECK for the evidence layer.
 *
 * The change log is what the family reads in יומן שינויים and what `undo`
 * replays, so a fact, an event or a citation must be able to appear in it. A
 * CHECK constraint cannot be altered, and a row that violates one is rejected
 * at INSERT — so without this every write through the new editors would fail at
 * the log line, after the edit itself had already gone in.
 */
function migrateChangeKinds(db) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='changes'").get()?.sql || '';
  if (sql.includes('fact.add')) return;
  const KINDS = ['add', 'edit', 'delete', 'restore', 'undo',
    'photo.add', 'photo.delete', 'union.add', 'union.edit', 'union.delete',
    'doc.add', 'doc.edit', 'doc.delete',
    'fact.add', 'fact.edit', 'fact.delete',
    'event.add', 'event.edit', 'event.delete',
    'citation.add', 'citation.edit', 'citation.delete',
    'name.add', 'name.delete',
    'question.add', 'question.edit', 'question.delete'];
  const list = KINDS.map((k) => `'${k}'`).join(',');
  db.exec('PRAGMA foreign_keys=off');
  db.exec(`
    BEGIN;
    CREATE TABLE changes_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      actor      TEXT NOT NULL DEFAULT '',
      actor_no   INTEGER,
      kind       TEXT NOT NULL CHECK (kind IN (${list})),
      person_id  TEXT,
      person_no  INTEGER,
      summary    TEXT NOT NULL DEFAULT '',
      before     TEXT NOT NULL DEFAULT '',
      after      TEXT NOT NULL DEFAULT '',
      -- Self-referencing the table being built: pointing at "changes" would tie
      -- every migrated row to the table this is about to drop.
      undone_by  INTEGER REFERENCES changes_new(id)
    );
    INSERT INTO changes_new SELECT * FROM changes;
    DROP TABLE changes;
    ALTER TABLE changes_new RENAME TO changes;
    CREATE INDEX IF NOT EXISTS changes_ts     ON changes(ts DESC);
    CREATE INDEX IF NOT EXISTS changes_person ON changes(person_id);
    CREATE INDEX IF NOT EXISTS changes_actor  ON changes(actor);
    COMMIT;`);
  db.exec('PRAGMA foreign_keys=on');
  const bad = db.prepare('PRAGMA foreign_key_check').all();
  if (bad.length) throw new Error(`changes rebuild broke ${bad.length} foreign key(s)`);
}

/** The one normalisation both sides of a login lookup must agree on. */
export const normEmail = (v) => String(v ?? '').trim().toLowerCase();

/**
 * The person an address logs in as, or null. Case and stray whitespace are
 * stripped on both sides — the email column is hand-maintained over hundreds of
 * rows and will otherwise eventually hold ` Example@Gmail.com `, which is the same
 * credential to Google and a different string to SQLite.
 */
export function personByEmail(db, email) {
  const e = normEmail(email);
  if (!e) return null;
  return db.prepare(`SELECT * FROM people
                       WHERE lower(trim(email)) = ? AND deleted_at IS NULL`).get(e) || null;
}

/**
 * The other normalisation, for the other credential. A phone number is written
 * down half a dozen ways — `052-000-0000`, `+972 52 000 0000`, `0520000000` —
 * and all of them are one WhatsApp account. E.164 without the plus (`972…`) is
 * the form WhatsApp addresses, so that is what both sides compare.
 *
 * A string this cannot read as an Israeli number is '' rather than a guess. In
 * particular a bare `526779872` is refused: with no trunk zero and no country
 * code there is nothing to distinguish it from a truncated foreign number, and
 * inventing the missing digits would invent a recipient.
 */
export const normPhone = (v) => {
  let d = String(v ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('972')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  else return '';
  return d.length >= 8 && d.length <= 9 ? `972${d}` : '';
};

/**
 * The person a phone number logs in as, or null.
 *
 * Unlike the email column there is no unique index behind this, because no SQL
 * expression this schema can index knows that '052-000-0000' and '0520000000'
 * are the same credential — the folding has to happen in JS, over the few
 * hundred rows that have a number at all. That makes the duplicate case
 * something this function has to handle rather than something the database
 * refuses: two live rows claiming one number is an ambiguity, and the answer is
 * null. Resolving it to whichever row SQLite reached first would file one
 * relative's edits under the other one's name.
 */
export function personByPhone(db, phone) {
  const want = normPhone(phone);
  if (!want) return null;
  const rows = db.prepare(`SELECT * FROM people
                             WHERE deleted_at IS NULL AND trim(coalesce(phone,'')) <> ''`).all();
  const hits = rows.filter((r) => normPhone(r.phone) === want);
  return hits.length === 1 ? hits[0] : null;
}

// ── names ────────────────────────────────────────────────────────────────────
// The tree shows given name and surname separately, but name_he is what the
// wiki renderer and every existing script read. Both are kept; name_he is
// always the join of the two, never edited directly.

export function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  const last = parts.pop();
  return { first: parts.join(' '), last };
}

/* A name with the researcher's aside taken off: "Moshe (father of Joil)",
   "Levi (given name blank in registry)". Those notes only ever appear on the
   English side, and splitting one gives a person the surname "Joil)". */
export const bareName = (full) => String(full || '').replace(/\s*\(.*?\)\s*/g, ' ').trim();

export const joinName = (first, last) => [first, last].map((s) => String(s || '').trim()).filter(Boolean).join(' ');

// ── person numbers ───────────────────────────────────────────────────────────
// Assigned once, in the order the rows already sit in (which is roster order —
// the root person is 1), and never reused. A deleted person keeps their number so that a
// number quoted in a message a year ago still points at the same human.

export function nextPersonNo(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key='next_person_no'").get();
  const n = row ? +row.value : 1;
  db.prepare("INSERT INTO meta (key,value) VALUES ('next_person_no',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(n + 1));
  return n;
}

/** Give every person without one a number, oldest row first. Idempotent. */
export function assignPersonNumbers(db) {
  const missing = db.prepare('SELECT rowid, id FROM people WHERE person_no IS NULL ORDER BY rowid').all();
  const set = db.prepare('UPDATE people SET person_no=? WHERE id=?');
  for (const p of missing) set.run(nextPersonNo(db), p.id);
  return missing.length;
}

/** Fill first_he/last_he and first_en/last_en for rows that predate the split. */
export function backfillNameParts(db) {
  const he = db.prepare("SELECT id, name_he FROM people WHERE first_he='' AND last_he='' AND name_he<>''").all();
  const setHe = db.prepare('UPDATE people SET first_he=?, last_he=? WHERE id=?');
  for (const r of he) { const { first, last } = splitName(r.name_he); setHe.run(first, last, r.id); }

  const en = db.prepare("SELECT id, name_en FROM people WHERE first_en='' AND last_en='' AND name_en<>''").all();
  const setEn = db.prepare('UPDATE people SET first_en=?, last_en=? WHERE id=?');
  for (const r of en) { const { first, last } = splitName(r.name_en); setEn.run(first, last, r.id); }

  return he.length + en.length;
}

// ── marriages ────────────────────────────────────────────────────────────────

const pair = (a, b) => (a < b ? [a, b] : [b, a]);

/** Turn the legacy one-spouse column into union rows. Idempotent. */
export function backfillUnions(db) {
  const rows = db.prepare("SELECT id, spouse_id FROM people WHERE spouse_id IS NOT NULL AND spouse_id<>''").all();
  const seen = new Set();
  const ins = db.prepare(`INSERT OR IGNORE INTO unions (a_id,b_id,status,start_date,created_by)
                          VALUES (?,?,'married','','seed')`);
  let n = 0;
  for (const r of rows) {
    const [a, b] = pair(r.id, r.spouse_id);
    const key = a + '|' + b;
    if (seen.has(key)) continue;
    seen.add(key);
    // Only pair people who both exist; the legacy column has no FK enforcement.
    if (!db.prepare('SELECT 1 FROM people WHERE id=?').get(b)) continue;
    ins.run(a, b);
    n++;
  }
  return n;
}

export function unionsFor(db, id) {
  return db.prepare(`SELECT * FROM unions WHERE a_id=? OR b_id=? ORDER BY
                     CASE status WHEN 'married' THEN 0 WHEN 'partners' THEN 1 ELSE 2 END, id`).all(id, id);
}

/** The partner to show on the tree: the live marriage, else the most recent. */
export function currentSpouse(db, id) {
  const u = unionsFor(db, id)[0];
  if (!u) return '';
  return u.a_id === id ? u.b_id : u.a_id;
}

/** Re-derive people.spouse_id from unions so the wiki renderer stays correct. */
export function syncSpouseColumn(db, ids) {
  const targets = ids || db.prepare('SELECT id FROM people').all().map((r) => r.id);
  const set = db.prepare('UPDATE people SET spouse_id=? WHERE id=?');
  for (const id of targets) set.run(currentSpouse(db, id) || null, id);
}

/**
 * Re-derive the three life-place FKs from the text columns beside them.
 *
 * Deliberately a SWEEP and not another thing every caller must remember.
 * syncSpouseColumn has twenty-five call sites across scripts/, and a derivation
 * that depends on being invoked is one a branch-import script will silently skip
 * — so this converges instead: the write path calls it for the row it touched,
 * and the ten-minute wiki sync calls it for everything, which catches whatever a
 * script wrote in between. A row whose id is still null renders from the text,
 * so nothing is broken while it waits.
 *
 * Returns how many rows changed, so the sweep can stay quiet when it is a no-op.
 */
export function syncPlaceIds(db, ids) {
  const where = ids?.length ? `AND id IN (${ids.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`SELECT id, birth_city, birth_country, death_city, death_country,
                                  burial_city, burial_country,
                                  birth_place_id, death_place_id, burial_place_id
                             FROM people WHERE deleted_at IS NULL ${where}`).all(...(ids || []));
  const set = db.prepare('UPDATE people SET birth_place_id=?, death_place_id=?, burial_place_id=? WHERE id=?');
  let changed = 0;
  for (const r of rows) {
    const want = [
      resolvePlaceId(db, r.birth_city, r.birth_country),
      resolvePlaceId(db, r.death_city, r.death_country),
      resolvePlaceId(db, r.burial_city, r.burial_country),
    ];
    if (want[0] === r.birth_place_id && want[1] === r.death_place_id && want[2] === r.burial_place_id) continue;
    set.run(...want, r.id);
    changed++;
  }
  return changed;
}

// ── curated fields ───────────────────────────────────────────────────────────

export const curatedOf = (row) => { try { return JSON.parse(row.curated || '[]'); } catch { return []; } };

export function markCurated(db, id, fields) {
  const row = db.prepare('SELECT curated FROM people WHERE id=?').get(id);
  if (!row) return;
  const set = new Set(curatedOf(row));
  for (const f of fields) set.add(f);
  db.prepare('UPDATE people SET curated=? WHERE id=?').run(JSON.stringify([...set]), id);
}

/**
 * Rebuild the curated list for one person from the change log.
 *
 * Needed after an undo: the reverted field no longer holds a human's value, so
 * leaving it marked would freeze it against the registry forever on the
 * strength of an edit that was taken back. The log is the only place that knows
 * whether some *earlier* edit also touched it.
 */
export function recomputeCurated(db, id) {
  const rows = db.prepare(`SELECT after FROM changes WHERE person_id=? AND undone_by IS NULL
                           AND kind IN ('add','edit')`).all(id);
  const fields = new Set();
  for (const r of rows) {
    let after = {};
    try { after = JSON.parse(r.after || '{}'); } catch { after = {}; }
    for (const k of Object.keys(after)) if (ALL_EDITABLE.includes(k)) fields.add(k);
  }
  db.prepare('UPDATE people SET curated=? WHERE id=?').run(JSON.stringify([...fields]), id);
  return [...fields];
}

/**
 * Where a human and the population registry disagree about a fact that cannot
 * change. Feeds the flag block on the wiki.
 */
export function registryMismatches(db) {
  const out = [];
  const rows = db.prepare("SELECT * FROM people WHERE tz<>'' AND deleted_at IS NULL").all();
  for (const p of rows) {
    const curated = new Set(curatedOf(p));
    for (const f of IMMUTABLE_REGISTRY_FIELDS) {
      const reg = f === 'sex' ? p.registry_sex : p.registry_birth_date;
      if (!reg || !curated.has(f)) continue;
      const mine = p[f];
      if (!mine || mine === reg) continue;
      // A year-only registry value and a full date in the same year agree.
      if (f === 'birth_date' && reg.length === 4 && String(mine).slice(0, 4) === reg) continue;
      out.push({ id: p.id, person_no: p.person_no, name_he: p.name_he, field: f, ours: mine, registry: reg });
    }
  }
  return out;
}

// ── origin ───────────────────────────────────────────────────────────────────
// Where a family came FROM, which is not where a person was born. Almost nobody
// is from one place, so the answer is fractional: a person is half their father's
// mix and half their mother's, recursively, and three- or four-country mixes fall
// out naturally after a couple of generations.
//
// Own foreign birth anchors someone only when the trail stops there. If a parent
// is traceable the blend wins, counting only the traceable sides — being born in
// the USSR to a Romanian mother does not make you half Soviet, it makes the USSR
// a place the family was passing through.
//
// Lives here rather than in the backfill script because the web service has to
// run it too: an origin a relative types in must flow down to their descendants
// immediately. It needs no registry access — birth_country is a stored column.
export function recomputeOrigins(db, { actor = '' } = {}) {
  const rows = db.prepare(`SELECT id,father_id,mother_id,birth_country,origin_override,
                                  origin_override_note,origin_country,origin_mix,origin_basis
                           FROM people WHERE deleted_at IS NULL`).all();
  const P = {}; for (const r of rows) P[r.id] = r;
  const foreign = (c) => !!c && c !== 'ישראל' && c !== ORIGIN_UNKNOWN;

  const kidsOf = {}, partnersOf = {}, sibsOf = {};
  for (const r of rows) { kidsOf[r.id] = []; partnersOf[r.id] = new Set(); }
  for (const r of rows) {
    for (const pid of [r.father_id, r.mother_id]) if (pid && P[pid]) kidsOf[pid].push(r);
    if (r.father_id && r.mother_id && P[r.father_id] && P[r.mother_id]) {
      partnersOf[r.father_id].add(r.mother_id); partnersOf[r.mother_id].add(r.father_id);
    }
  }
  for (const u of db.prepare('SELECT a_id,b_id FROM unions').all())
    if (P[u.a_id] && P[u.b_id]) { partnersOf[u.a_id].add(u.b_id); partnersOf[u.b_id].add(u.a_id); }
  for (const r of rows)
    sibsOf[r.id] = (r.father_id || r.mother_id) ? rows.filter((s) => s.id !== r.id &&
      ((r.father_id && s.father_id === r.father_id) || (r.mother_id && s.mother_id === r.mother_id))) : [];

  // Anchors are single countries: what a human asserted, else own foreign birth,
  // else a country borrowed sideways. Never a blend — blends read anchors and
  // never become one, which is what stops the derivation feeding on itself.
  const anchor = {}, basis = {}, from = {};
  for (const r of rows) {
    if (r.origin_override && r.origin_override !== ORIGIN_UNKNOWN) {
      anchor[r.id] = r.origin_override;
      basis[r.id] = `override${r.origin_override_note ? ': ' + r.origin_override_note : ''}`;
    } else if (foreign(r.birth_country)) { anchor[r.id] = r.birth_country; basis[r.id] = 'self'; }
  }

  const blend = (mixes) => {
    const out = {};
    for (const m of mixes) for (const [c, f] of Object.entries(m)) out[c] = (out[c] || 0) + f / mixes.length;
    let t = 0;
    for (const c of Object.keys(out)) { out[c] = Math.round(out[c] * 1e6) / 1e6; t += out[c]; }
    if (t) for (const c of Object.keys(out)) out[c] = Math.round(out[c] / t * 1e6) / 1e6;
    return out;
  };
  const atOrAbove = (a, b) => {
    const seen = new Set(); const stack = [b];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === a) return true;
      if (seen.has(cur) || !P[cur]) continue;
      seen.add(cur);
      for (const pid of [P[cur].father_id, P[cur].mother_id]) if (pid) stack.push(pid);
    }
    return false;
  };

  let M = {};
  const build = () => {
    M = {};
    const memo = {}, busy = new Set();
    const mixOf = (id) => {
      if (id in memo) return memo[id];
      if (busy.has(id)) return null;
      busy.add(id);
      const r = P[id];
      const parts = []; let haveF = false, haveM = false, blank = 0;
      for (const [pid, isF] of [[r.father_id, true], [r.mother_id, false]]) {
        if (!pid || !P[pid]) continue;
        // Refuse a parent whose origin was itself borrowed downward from this
        // person or their line — that would launder a location into a lineage.
        // Refusing is not the same as "unknown": we are declining to use an
        // answer we do have, so this half is left out of the sum rather than
        // counted against it.
        const src = from[pid];
        if (src && (src === id || atOrAbove(id, src))) continue;
        const pm = mixOf(pid);
        if (pm) { parts.push(pm.mix); if (isF) haveF = true; else haveM = true; }
        // A parent who IS in the tree and whose line genuinely runs out is half
        // of this person, and that half is unknown. Dropping them and
        // normalising the other parent to 100% is how Arya, whose father's line
        // is untraced, read as 50% Romanian and 50% Tunisian when she is a
        // quarter of each and half unaccounted for.
        else blank++;
      }
      busy.delete(id);
      let out = null;
      if (parts.length) {
        const mixes = parts.slice();
        for (let i = 0; i < blank; i++) mixes.push({ [ORIGIN_UNKNOWN]: 1 });
        out = { mix: blend(mixes), basis: (haveF && haveM) ? 'parents' : (haveF ? 'father-only' : 'mother-only') };
      }
      else if (anchor[id]) out = { mix: { [anchor[id]]: 1 }, basis: basis[id] };
      memo[id] = out;
      if (out) M[id] = out;
      return out;
    };
    for (const r of rows) mixOf(r.id);
  };

  // Sideways fallbacks, only for people whose own birthplace is unknown. A child
  // born in X puts this person in X; siblings then partners are weaker still.
  const fallback = () => {
    let found = 0;
    for (const r of rows) {
      if (anchor[r.id] || M[r.id] || r.birth_country) continue;
      const kid = kidsOf[r.id].map((k) => ({ k, c: anchor[k.id] || '' })).filter((x) => foreign(x.c));
      let c = '', b = '', src = '';
      if (kid.length) {
        const t = {};
        for (const x of kid) t[x.c] = (t[x.c] || 0) + 1;
        const rank = Object.entries(t).sort((x, y) => y[1] - x[1]);
        c = rank[0][0];
        let note = '';
        if (rank.length > 1) {
          const pc = [...partnersOf[r.id]].map((id) => P[id] && P[id].birth_country).filter(foreign);
          const agreed = rank.find(([cc]) => pc.includes(cc));
          if (agreed) { c = agreed[0]; note = '+spouse'; }
          note += `!conflict(${rank.map(([cc, n]) => `${cc}×${n}`).join(' vs ')})`;
        }
        src = kid.find((x) => x.c === c).k.id;
        b = `child:${src}${note}`;
      } else {
        const sib = sibsOf[r.id].find((s) => foreign(s.birth_country));
        const sp = [...partnersOf[r.id]].map((id) => P[id]).find((x) => x && foreign(x.birth_country));
        if (sib) { c = sib.birth_country; b = `sibling:${sib.id}`; src = sib.id; }
        else if (sp) { c = sp.birth_country; b = `spouse:${sp.id}`; src = sp.id; }
      }
      if (c) { anchor[r.id] = c; basis[r.id] = b; from[r.id] = src; found++; }
    }
    return found;
  };

  for (let i = 0; i < 20; i++) { build(); if (!fallback()) break; }
  build();

  const upd = db.prepare(`UPDATE people SET origin_country=?, origin_mix=?, origin_basis=?
                          WHERE id=?`);
  let changed = 0;
  for (const r of rows) {
    const m = M[r.id];
    // Nothing traceable: say so, rather than leaving it blank. ORIGIN_UNKNOWN is
    // deliberately not an anchor and is not inherited — a child of one unknown
    // parent still reports the parent they CAN be traced through, normalised.
    const mix = m ? m.mix : { [ORIGIN_UNKNOWN]: 1 };
    const country = Object.entries(mix).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const json = JSON.stringify(mix);
    const bas = m ? m.basis : 'unknown';
    if (r.origin_country === country && r.origin_mix === json && r.origin_basis === bas) continue;
    upd.run(country, json, bas, r.id);
    changed++;
  }
  return changed;
}

// ── when an address last moved ───────────────────────────────────────────────
// `updated_at` answers a different question: "when was this row last touched".
// A parent whose Instagram was filled in this morning would outrank the parent
// who actually moved house last year, and the tree's "take the parents'
// address" button picks between exactly those two. The change log is the only
// record of when the ADDRESS itself moved, so read it there.
//
// Every kind counts, not just `edit`: an `add` states an address and an `undo`
// restores one, and both put the field in `after`. Undone edits are not
// filtered out either — the undo that reverted one carries a LATER ts, so the
// max already lands on the value the row actually holds.
//
// Parsed rather than matched with LIKE: `"city"` inside somebody's notes is not
// a change of address, and the whole table is a few hundred rows.

const ADDRESS_FIELDS = ['country', 'city', 'street', 'house'];

/* The towns a person carries besides the one they live in. Watched separately
   from the address, and deliberately not folded into ADDRESS_FIELDS: `addressAt`
   answers "which of these two addresses is fresher", which the form asks before
   offering to copy a parent's — and a birthplace typed today is not evidence
   that anybody's street is current. The geocoder wants both lists; nothing else
   wants this one. */
/* Derived from LIFE_EVENTS rather than typed out again — the same six columns
   were already listed there, and syncPlaceIds() now reads this too, so a fourth
   life event would otherwise need the same list edited in three files. */
export const LIFE_PLACE_FIELDS = LIFE_EVENTS.flatMap((e) => [e.city, e.country]);

function lastChangeTouching(db, fields, id = null) {
  const rows = id
    ? db.prepare('SELECT person_id, ts, after FROM changes WHERE person_id=?').all(id)
    : db.prepare('SELECT person_id, ts, after FROM changes WHERE person_id IS NOT NULL').all();
  const at = new Map();
  for (const r of rows) {
    let obj;
    try { obj = JSON.parse(r.after || '{}'); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (!fields.some((k) => k in obj)) continue;
    if ((at.get(r.person_id) || 0) < r.ts) at.set(r.person_id, r.ts);
  }
  return at;
}

/** person_id → unix ts of the last change that touched city/street/house. */
export const addressChangedAt = (db, id = null) => lastChangeTouching(db, ADDRESS_FIELDS, id);

/** person_id → unix ts of the last change that touched a birth/death/burial place. */
export const lifePlaceChangedAt = (db, id = null) => lastChangeTouching(db, LIFE_PLACE_FIELDS, id);

// ── who is actually using this ───────────────────────────────────────────────

/* How long a visit stays "the same visit" for the purpose of the write below.
   A page load is a dozen requests and a reader stays for minutes; recording
   each one would be a write per request to draw a line that says "now". */
const SEEN_THROTTLE_MS = 5 * 60 * 1000;

/** person id → when this process last wrote their `last_seen_at`. */
const seenWrittenAt = new Map();

/**
 * Note that a relative is using the app, right now.
 *
 * This is LAST ACTIVE, not last login, and the difference is the whole point.
 * A session here lasts weeks, so `login.success` fires once and then goes on
 * saying "three weeks ago" about somebody who opens the tree every morning.
 * The question a family asks about this app is "is anyone actually using it",
 * and only a request can answer that; a login can only answer "did they ever
 * get through the door" — which, since getting in is what produces the first
 * request, this column answers too (0 means neither ever happened).
 *
 * Why a column and not a query against the shared audit log at
 * the sign-in audit DB, which already records every one of these:
 *   - that log prunes at 180 days, so a relative who looked once in the spring
 *     would silently turn back into somebody who never came;
 *   - and drawing one line on a card would otherwise cost a cross-file join on
 *     every page load, forever.
 * scripts/backfill-last-seen.mjs seeds this column from that log once, which
 * is the only time the two ever meet.
 *
 * Deliberately NOT routed through recordChange(). Nobody EDITED anything by
 * visiting: filing it in the append-only log would bury real edits under a row
 * per page load, and recomputeCurated() reads that log — so the column would
 * end up "curated", i.e. frozen against `family sync`, for a fact the family
 * never asserted.
 *
 * Best-effort by the same rule the audit log follows: a service token is not a
 * person and never lands here, and a failed write costs a timestamp, not a
 * request.
 */
export function touchSeen(db, personId, now = Date.now()) {
  if (!personId) return false;
  if (now - (seenWrittenAt.get(personId) || 0) < SEEN_THROTTLE_MS) return false;
  seenWrittenAt.set(personId, now);
  try {
    db.prepare('UPDATE people SET last_seen_at=? WHERE id=?').run(Math.floor(now / 1000), personId);
  } catch { return false; }
  return true;
}

// ── the payload the browser gets ─────────────────────────────────────────────
// Shaped exactly like the seed array the design shipped with, so the front-end
// needs no translation layer. Fields the family agreed not to publish — ת.ז.,
// the registry's spelling of the name, and the research notes — are not in it
// unless the viewer is the owner.

/**
 * Which wiki pages exist for each person, by language.
 *
 * `wiki_pages` is written by family.mjs when it pushes a page, so a row here is
 * a page that has actually been CREATED, which is the only useful basis for
 * drawing a link. Reading people.wiki_title_* instead would be wrong even now
 * that every person has one: a title is an intention, and the page behind it
 * does not exist until the sync has run, so a person added in the last ten
 * minutes would get a red link.
 *
 * Built once for the whole tree by allPeople(), per the same rule as
 * addressChangedAt() and documentCounts(): 130 rows read in one pass beats one
 * query per person repeated 1,284 times.
 */
export function wikiTitles(db, personId = null) {
  const sql = `SELECT person_id, lang, title FROM wiki_pages${personId ? ' WHERE person_id = ?' : ''}`;
  const rows = personId ? db.prepare(sql).all(personId) : db.prepare(sql).all();
  const out = new Map();
  for (const r of rows) {
    const e = out.get(r.person_id) || {};
    if (r.lang === 'he' || r.lang === 'en') e[r.lang] = r.title;
    out.set(r.person_id, e);
  }
  return out;
}

export function publicPerson(db, p, { owner = false, addressAt = null, docCount = null, wiki = null } = {}) {
  const rec = {
    id: p.id,
    no: p.person_no,
    first: p.first_he || splitName(p.name_he).first,
    last: p.last_he || splitName(p.name_he).last,
    /* The English half, split the same way the Hebrew one is a line above.
       That fallback is not cosmetic: FamilyFuzzy.personNames() — the ranking
       behind the header search, the map's search and both relation pickers —
       reads firstEn/lastEn and never name_en. 125 people carried a perfectly
       good English name in `name_en` with the split columns empty, and every
       one of them was unfindable by an English search and rendered in Hebrew
       inside the English UI. Where there is no English name at all the fields
       stay empty and the UI falls back to the Hebrew, as it always did. */
    firstEn: p.first_en || splitName(bareName(p.name_en)).first,
    lastEn: p.last_en || splitName(bareName(p.name_en)).last,
    maiden: p.maiden_name || '',
    g: p.sex === 'F' ? 'f' : p.sex === 'M' ? 'm' : '',
    born: p.birth_date || '',
    // Not a second date — the one bit `birth_date` cannot hold. The pages
    // derive the Hebrew date from the pair; nothing stores that derivation.
    afterSunset: !!p.born_after_sunset,
    died: p.death_date || '',
    /* Whether they have died, which is NOT the same question as when. 59 people
       carry the flag with no date — 19th-century ancestors, and registry rows
       marked deceased without one — and every consumer that tested `died`
       treated them as living. FamilyContacts.linksFor() is the one that shows:
       it draws WhatsApp and Instagram buttons for anyone not `died`, so the
       tree was offering to message them. */
    deceased: !!p.deceased || !!String(p.death_date || '').trim(),
    parents: [p.father_id, p.mother_id].filter(Boolean),
    branch: p.branch || '',
    // '' is Israel, and is sent as '' rather than filled in: the form shows the
    // home country either way, and a blank that means "nobody has said" is the
    // one thing an explicit 'IL' on 700 rows would destroy.
    country: p.country || '',
    city: p.city || '',
    street: p.street || '',
    house: p.house || '',
    job: p.occupation || '',
    email: p.email || '',
    phone: p.phone || '',
    // Stored as the full canonical URL rather than a handle — see contacts.js
    // for why "the handle" is not one thing on Facebook or LinkedIn. Both pages
    // hand these straight to FamilyContacts.linksFor().
    instagram: p.instagram || '',
    facebook: p.facebook || '',
    linkedin: p.linkedin || '',
    // No kinship field here, and no column behind one either. Both pages
    // compute the real relation for whoever is reading, from lib/relations.mjs;
    // shipping a stored one only ever gave a relative a second, staler answer.
    // GET /api/relation?a=&b= answers for any pair.
    birthCountry: p.birth_country || '',
    // The three places a life has, beside the address it is lived at. Sent to
    // everyone: a birthplace is on every headstone and in every obituary, and a
    // cemetery plot is a thing relatives tell each other so they can go. The one
    // judgement made here is that they are FACTS about the person and not
    // research working-out, which is what keeps them out of the `owner` block
    // that `notes` and `tz` sit in.
    birthCity: p.birth_city || '',
    deathCity: p.death_city || '',
    deathCountry: p.death_country || '',
    burialCity: p.burial_city || '',
    burialCountry: p.burial_country || '',
    burialPlace: p.burial_place || '',
    burialPlot: p.burial_plot || '',
    /* Behind the editor's "more fields" fold. Sent to everyone, like the
       occupation and the contact details beside them — these are things a
       person tells their family, not evidence about the research. Without them
       here the form's boxes save on the way in and come back empty on the way
       out, which reads as the edit having been lost. */
    almaMater: p.alma_mater || '',
    interests: p.interests || '',
    maritalStatus: p.marital_status || '',
    /* Not cosmetic: the wiki page writes "an only child" on the strength of
       this, so the form has to be able to show whether it is already set. */
    childrenComplete: !!p.children_complete,
    origin: p.origin_country || '',
    // Parsed so the UI can render the breakdown without knowing the encoding.
    originMix: (() => { try { return JSON.parse(p.origin_mix || '{}'); } catch { return {}; } })(),
    originSet: p.origin_override || '',
    // Whether asserting an origin here would do anything, and if not, which
    // ancestors it arrives through. Sent to everyone, not just the owner: this
    // is not evidence about the research, it is whether the form should offer a
    // field — and the page has to decide that for whoever is reading.
    originEditable: !originIsDerived(p),
    originFrom: originSources(p),
    addedBy: p.created_by || 'seed',
    updatedBy: p.updated_by || '',
    updatedAt: (p.updated_at || 0) * 1000,
    // When they last used the app; 0 is "never signed in", which is a real and
    // useful answer rather than a gap — see touchSeen(). Sent to every signed-in
    // relative, not just the owner: the owner's call, and the same one that puts
    // phone, email and full date of birth in this payload. It is not evidence
    // about the research, which is what the `owner` block below holds.
    lastSeen: (p.last_seen_at || 0) * 1000,
    // When the address last moved — see addressChangedAt(). Falls back to the
    // row's own timestamp for anyone whose address arrived before there was a
    // log to write it in, so the field is always a real answer to "which of
    // these two is fresher" rather than a zero that sorts last.
    addressAt: (((addressAt instanceof Map ? addressAt : addressChangedAt(db, p.id)).get(p.id))
      || p.updated_at || 0) * 1000,
  };
  /* Which row in `places` each of the three towns is, so the card can offer
     "show it on the map" without re-deriving lifeCountry() in the browser —
     'בסרביה' and 'Bessarabia' are one key here and would be two there. Sent
     only for a person who has one: fifteen people in eleven hundred do, and an
     empty string on the other 1,092 is payload nobody reads.

     The key is a promise about `places`, not about coordinates: a town nobody
     has managed to geocode has a key and no pin, and the card says so rather
     than drawing a button that goes nowhere. */
  if (p.birth_city) rec.birthPlaceKey = lifePlaceKey(p.birth_city, p.birth_country);
  if (p.death_city) rec.deathPlaceKey = lifePlaceKey(p.death_city, p.death_country);
  if (p.burial_city) rec.burialPlaceKey = lifePlaceKey(p.burial_city, p.burial_country);

  const avatar = db.prepare('SELECT id FROM photos WHERE person_id=? AND deleted_at IS NULL ORDER BY is_avatar DESC, uploaded_at LIMIT 1').get(p.id);
  if (avatar) rec.photo = avatar.id;
  // How many documents hang off this person, not which ones. The card fetches
  // the list when it opens; what the payload has to carry is enough to decide
  // whether to draw the shelf at all — and 1,107 people times a document query
  // is the kind of thing allPeople() already pre-computes rather than asks.
  rec.docs = docCount instanceof Map
    ? (docCount.get(p.id) || 0)
    : (db.prepare('SELECT COUNT(*) n FROM documents WHERE person_id=? AND deleted_at IS NULL').get(p.id)?.n || 0);
  /* The wiki pages this person has, if any — `{he}`, `{en}` or both. Sent only
     for the 102 people who have one, on the same reasoning as birthPlaceKey
     above: an empty object on the other 1,182 is payload nobody reads.

     Titles, not URLs. Which host serves the wiki is a deployment fact the
     browser is told once (window.FAMILY_WIKI_ORIGIN), not something to bake
     into 102 rows of a data file that is cached. */
  const wikiFor = (wiki instanceof Map ? wiki : wikiTitles(db, p.id)).get(p.id);
  if (wikiFor && (wikiFor.he || wikiFor.en)) rec.wiki = wikiFor;
  const sp = currentSpouse(db, p.id);
  if (sp) rec.spouse = sp;
  // The date on that union, where there is one. `spouse` alone cannot answer
  // "how long have they been married", which is the question an anniversary is.
  // Purely additive: a client that does not know the field ignores it, which is
  // what the tree page did before v2 existed and still does.
  //
  // Note for whoever reads this next: as of writing, NO row in `unions` has a
  // `start_date` — the column has been there since the table was created and
  // nothing in the UI has ever collected one. So this ships empty on purpose.
  // The v2 "Dates" view says so out loud rather than rendering a blank month and
  // letting the reader conclude the feature is broken.
  if (sp) {
    const u = unionsFor(db, p.id)[0];
    if (u && u.start_date) rec.weddingDate = u.start_date;
  }
  if (owner) {
    // `notes` is research working-out too — provenance, ת.ז. cross-references,
    // "not in the 2006 snapshot". It was owner-only and is now not sent at all.
    rec.tz = p.tz || ''; rec.registryName = p.registry_name || '';
    // How the origin was reached — evidence, so owner-only alongside the notes.
    rec.originBasis = p.origin_basis || '';
  }
  return rec;
}

export function allPeople(db, opts = {}) {
  const rows = db.prepare('SELECT * FROM people WHERE deleted_at IS NULL ORDER BY person_no').all();
  // One pass over the log for the whole tree, rather than publicPerson asking
  // per person and reading it 380 times.
  const addressAt = addressChangedAt(db);
  const docCount = documentCounts(db);
  const wiki = wikiTitles(db);
  return rows.map((p) => publicPerson(db, p, { ...opts, addressAt, docCount, wiki }));
}

// ── documents ────────────────────────────────────────────────────────────────
// A photo is what somebody looked like. A document is what somebody can be
// PROVEN by — a birth certificate, a Yad Vashem card, a burial-society record,
// the newspaper page that names them. Two tables rather than one because they
// are read in different places and by different rules: photos become the face
// on a node and go in the album; documents are evidence hung under the fact
// they establish, and half of them are PDFs, which no album can show.
//
// Bytes live on disk, like photos. Unlike photos the filename is NOT always the
// id: `documents/` already held eleven files with names a human gave them —
// `yv-1256306-basya-levi-orhei.jpg` says more at the bottom of a directory
// listing than a hex stem ever will — and registering those without renaming
// them is the whole reason there is a `file` column instead of an `ext` one.
// Uploads still land at `documents/<id>.<ext>`; both kinds are read the same way.

/** What a document is evidence OF. `other` is a real answer, not a fallback. */
export const DOC_KINDS = ['birth', 'death', 'burial', 'marriage', 'immigration',
  'military', 'press', 'registry', 'other'];

/** Extensions we will store and serve. Anything else is refused at upload. */
export const DOC_EXT = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/heic': 'heic', 'image/tiff': 'tif', 'text/plain': 'txt',
  // Video, added 2026-09-04 on the owner's instruction: some families' Holocaust
  // testimonies exist only as film, and a tree that cannot hold the file cannot
  // hold the testimony.
  'video/mp4': 'mp4',
};

export const DOC_MIME = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', tif: 'image/tiff',
  tiff: 'image/tiff', txt: 'text/plain; charset=utf-8', mp4: 'video/mp4',
};

export const newDocumentId = () => crypto.randomBytes(8).toString('hex');

/**
 * The absolute path of a document's bytes, or null if the row points outside
 * `documents/`.
 *
 * The check is not paranoia about the family: `file` is written by the upload
 * handler and by the registration script, and one of those two takes a path
 * from the command line. A row saying `../../etc/shadow` would otherwise be a
 * file this service happily serves to anyone signed in.
 */
export function docPath(row) {
  const rel = String(row?.file || '').trim();
  if (!rel) return null;
  const abs = path.resolve(DOC_DIR, rel.replace(/^documents\//, ''));
  return abs === DOC_DIR || abs.startsWith(DOC_DIR + path.sep) ? abs : null;
}

/** Every live document on one person, oldest first. */
export function listDocuments(db, personId) {
  return db.prepare(`SELECT id, person_id, file, ext, bytes, title, kind, note, source,
                            uploaded_at, uploaded_by
                       FROM documents WHERE person_id=? AND deleted_at IS NULL
                   ORDER BY uploaded_at, rowid`).all(personId)
    .map((d) => ({ ...d, missing: !fileExists(docPath(d)) }));
}

const fileExists = (abs) => { try { return !!abs && fs.statSync(abs).isFile(); } catch { return false; } };

/** person_id → how many live documents, in one query for the whole tree. */
export function documentCounts(db) {
  const out = new Map();
  for (const r of db.prepare(`SELECT person_id, COUNT(*) n FROM documents
                               WHERE deleted_at IS NULL GROUP BY person_id`).all())
    out.set(r.person_id, r.n);
  return out;
}

// ── the evidence layer ───────────────────────────────────────────────────────
// Reads and writes for the tables that hold a claim plus who says so. The shape
// deliberately mirrors documents above — list / add / edit / delete, soft
// deletes, the caller records the change — so the editor's facts shelf is the
// documents shelf with different columns rather than a second set of habits.

export const CONFIDENCE = ['confirmed', 'probable', 'candidate', 'disproven'];

/**
 * What a fact IS. The eleven `events` had, plus the ones this tree's 697 rows
 * turned out to be made of — a registry snapshot block, a contact line, a list
 * of mutual friends, a candidate ת.ז.
 *
 * `narrative` is the residue and is named on purpose: page prose that describes
 * a life without asserting anything datable. Hiding it in 'other' would make it
 * unfindable, and the whole point of typing these was to be able to ask what is
 * still unstructured. See scripts/classify-facts.mjs.
 */
export const FACT_KINDS = [
  // the life
  'birth', 'death', 'burial', 'memorial',
  // who they were
  'name', 'identity', 'registry', 'dna',
  // where they were
  'residence', 'migration', 'evacuation',
  // what they did
  'education', 'employment', 'military-service', 'award',
  // who they were to each other
  'marriage', 'divorce', 'family', 'social', 'contact',
  // the rest
  'interests', 'health', 'property', 'research', 'narrative', 'other',
];

/** How one fact bears on another. Directed: `from` bears on `to`. */
export const FACT_RELATIONS = ['supersedes', 'contradicts', 'supports',
  'derived-from', 'part-of', 'duplicate-of', 'see-also'];

/** The columns a fact write may set, beside the people and the links. */
export const FACT_FIELDS = ['kind', 'label_he', 'label_en', 'value_he', 'value_en',
  'start_date', 'start_precision', 'end_date', 'end_precision',
  'place_id', 'place_text', 'as_of', 'source', 'confidence', 'details', 'sort_order'];
export const CITATION_KINDS = ['headstone', 'registry', 'archive-card', 'directory',
  'newspaper', 'testimony', 'dna', 'photo', 'web', 'other'];
/**
 * The facts a person is IN — as the subject, or in any other role.
 *
 * Joined through `fact_people` rather than read off `person_facts.person_id`,
 * which is what makes a fact that involves three people show up on all three
 * cards instead of only the one it happens to be filed under. The subject is
 * mirrored into that table, so this needs no union of two shapes.
 *
 * Ordered by when it happened, then by the hand-set order, then by id: a fact
 * with no date is not pushed to the bottom, it sits where it was put.
 */
export function listFacts(db, personId) {
  /* The coordinates travel with the fact so a card can offer "show me this"
     without a second round trip and without re-deriving which `places` row a
     town is. `place_lat` null is a real answer — a town nobody has managed to
     geocode — and the client falls back to searching by name. */
  const rows = db.prepare(`SELECT f.*, pl.name AS place_name, pl.country AS place_country,
             pl.lat AS place_lat, pl.lng AS place_lng, fp.role AS role
      FROM person_facts f
      JOIN fact_people fp ON fp.fact_id = f.id AND fp.person_id = ?
      LEFT JOIN places pl ON pl.id = f.place_id
      WHERE f.deleted_at IS NULL
      ORDER BY f.start_date, f.sort_order, f.id`).all(personId);
  for (const f of rows) {
    f.people = db.prepare(`SELECT fp.person_id, fp.role, p.name_he, p.name_en, p.person_no
        FROM fact_people fp JOIN people p ON p.id = fp.person_id
        WHERE fp.fact_id = ? ORDER BY (fp.role='subject') DESC, p.person_no`).all(f.id);
    f.links = factLinks(db, f.id);
  }
  return rows;
}

/** Both directions at once — what this bears on, and what bears on it. */
export function factLinks(db, factId) {
  return db.prepare(`
    SELECT l.id, l.relation, l.note, 'out' AS dir, l.to_id AS other_id,
           f.label_he AS other_he, f.label_en AS other_en, f.kind AS other_kind
      FROM fact_links l JOIN person_facts f ON f.id = l.to_id WHERE l.from_id = ?
    UNION ALL
    SELECT l.id, l.relation, l.note, 'in' AS dir, l.from_id AS other_id,
           f.label_he, f.label_en, f.kind
      FROM fact_links l JOIN person_facts f ON f.id = l.from_id WHERE l.to_id = ?
    ORDER BY relation, other_id`).all(factId, factId);
}

/**
 * A fact, and everyone in it.
 *
 * `people` is a list of {person_id, role} because that is the whole reason this
 * is not a column on `people`: a base naming its power station after someone is
 * ONE fact holding the man it commemorates, the widow who unveiled the plaque
 * and the son who stood with her. The subject is always written in too, so the
 * participant table is never a partial picture.
 */
export function addFact(db, personId, patch, actor = '', people = []) {
  const cols = FACT_FIELDS.filter((k) => patch[k] !== undefined);
  db.prepare(`INSERT INTO person_facts (person_id, created_by${cols.length ? ', ' + cols.join(', ') : ''})
              VALUES (?, ?${cols.length ? ', ' + cols.map(() => '?').join(', ') : ''})`)
    .run(personId, actor, ...cols.map((k) => patch[k]));
  const id = db.prepare('SELECT last_insert_rowid() id').get().id;
  setFactPeople(db, id, [{ person_id: personId, role: 'subject' }, ...(people || [])]);
  return id;
}

export function editFact(db, id, patch, people) {
  const cols = FACT_FIELDS.filter((k) => patch[k] !== undefined);
  if (cols.length)
    db.prepare(`UPDATE person_facts SET ${cols.map((k) => `${k}=?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((k) => patch[k]), id);
  if (people) {
    const subject = db.prepare('SELECT person_id FROM person_facts WHERE id = ?').get(id)?.person_id;
    setFactPeople(db, id, [...(subject ? [{ person_id: subject, role: 'subject' }] : []), ...people]);
  }
  return cols.length > 0 || !!people;
}

/**
 * Replace the cast of a fact.
 *
 * The subject is re-inserted by every caller rather than preserved here, so
 * there is exactly one rule about who ends up in this table and it is visible
 * at the call site. A role is slugged because it is queried: " Unveiled By "
 * and "unveiled-by" must not be two roles.
 */
export function setFactPeople(db, factId, people = []) {
  db.prepare('DELETE FROM fact_people WHERE fact_id = ?').run(factId);
  const ins = db.prepare('INSERT OR IGNORE INTO fact_people (fact_id, person_id, role) VALUES (?, ?, ?)');
  const seen = new Set();
  for (const p of people) {
    if (!p?.person_id) continue;
    const role = String(p.role || 'subject').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40) || 'subject';
    const key = `${p.person_id}|${role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ins.run(factId, p.person_id, role);
  }
}

/** Link one fact to another. Returns the row id, or 0 if it already existed. */
export function linkFacts(db, fromId, toId, relation = 'see-also', note = '', actor = '') {
  // A fact that supersedes itself is a loop in the argument, not an argument.
  if (Number(fromId) === Number(toId)) return 0;
  if (!FACT_RELATIONS.includes(relation)) relation = 'see-also';
  db.prepare(`INSERT OR IGNORE INTO fact_links (from_id, to_id, relation, note, created_by)
              VALUES (?, ?, ?, ?, ?)`).run(fromId, toId, relation, note, actor);
  return db.prepare('SELECT id FROM fact_links WHERE from_id=? AND to_id=? AND relation=?')
    .get(fromId, toId, relation)?.id || 0;
}

export const unlinkFacts = (db, id) => db.prepare('DELETE FROM fact_links WHERE id = ?').run(id);

/* Soft, like a person and a document: a fact somebody removes is a fact that can
   be argued about later, and `disproven` is a confidence rather than a deletion. */
export const deleteFact = (db, id) =>
  db.prepare("UPDATE person_facts SET deleted_at = strftime('%s','now') WHERE id = ?").run(id);

/** person_id → how many live facts, in one query for the whole tree. */
export function factCounts(db) {
  const out = new Map();
  for (const r of db.prepare(`SELECT person_id, COUNT(*) n FROM person_facts
                               WHERE deleted_at IS NULL GROUP BY person_id`).all())
    out.set(r.person_id, r.n);
  return out;
}

const CITATION_FIELDS = ['ref_name', 'kind', 'archive', 'collection', 'record_id',
  'citation_he', 'citation_en', 'url', 'document_id', 'read_at'];

export const listCitations = (db) =>
  db.prepare('SELECT * FROM citations WHERE deleted_at IS NULL ORDER BY ref_name, id').all();

/**
 * A source, created once and cited from everywhere.
 *
 * `ref_name` is unique when set because it becomes a <ref name="…"> on the wiki:
 * two sources sharing one name render as a cite error, so the constraint lives in
 * the schema and this surfaces it as a refusal rather than a 500.
 */
export function addCitation(db, patch, actor = '') {
  const ref = String(patch.ref_name ?? '').trim();
  if (ref) {
    const clash = db.prepare('SELECT id FROM citations WHERE ref_name = ? AND deleted_at IS NULL').get(ref);
    if (clash) return { error: `ref_name "${ref}" is already used by citation #${clash.id}` };
  }
  const cols = CITATION_FIELDS.filter((k) => patch[k] !== undefined);
  db.prepare(`INSERT INTO citations (created_by${cols.length ? ', ' + cols.join(', ') : ''})
              VALUES (?${cols.length ? ', ' + cols.map(() => '?').join(', ') : ''})`)
    .run(actor, ...cols.map((k) => patch[k]));
  return { id: db.prepare('SELECT last_insert_rowid() id').get().id };
}

/**
 * Attach a source to a claim — a people column, a fact, an event, a question.
 *
 * `supports = 0` is the half that carries the research: a source that contradicts
 * the claim, or, on a question, a search that found nothing. Re-citing the same
 * source for the same claim updates the note instead of erroring, so the editor
 * can be used to correct a typo without a delete-then-add dance.
 */
export function citeClaim(db, { subjectKind, subjectId, citationId, supports = 1, noteHe = '', noteEn = '' }, actor = '') {
  db.prepare(`INSERT INTO claim_citations (subject_kind, subject_id, citation_id, supports, note_he, note_en, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(subject_kind, subject_id, citation_id) DO UPDATE SET
                supports = excluded.supports, note_he = excluded.note_he, note_en = excluded.note_en`)
    .run(subjectKind, String(subjectId), citationId, supports ? 1 : 0, noteHe, noteEn, actor);
}

export const uncite = (db, subjectKind, subjectId, citationId) =>
  db.prepare('DELETE FROM claim_citations WHERE subject_kind=? AND subject_id=? AND citation_id=?')
    .run(subjectKind, String(subjectId), citationId);

/** Every source behind one claim, with whether it supports or contradicts it. */
export const citationsFor = (db, subjectKind, subjectId) =>
  db.prepare(`SELECT cc.supports, cc.note_he, cc.note_en, c.*
                FROM claim_citations cc JOIN citations c ON c.id = cc.citation_id
               WHERE cc.subject_kind = ? AND cc.subject_id = ? AND c.deleted_at IS NULL
            ORDER BY cc.supports DESC, c.ref_name`).all(subjectKind, String(subjectId));

/* `events` was retired on 2026-08-28 and its shape now lives on person_facts —
   see migrateFacts(). It never held a row; the table it duplicated held 697. */

export const listQuestions = (db, personId) =>
  db.prepare(`SELECT * FROM research_questions WHERE person_id = ? AND deleted_at IS NULL
              ORDER BY status, id`).all(personId);

/* The columns a question write may set. Mirrors FACT_FIELDS / CITATION_FIELDS:
   `person_id` is the caller's argument, and id / timestamps are the table's. */
export const QUESTION_FIELDS = ['question_he', 'question_en', 'candidate_he', 'candidate_en',
  'next_step_he', 'next_step_en', 'status'];

export function addQuestion(db, personId, patch) {
  const cols = QUESTION_FIELDS.filter((k) => patch[k] !== undefined);
  db.prepare(`INSERT INTO research_questions (person_id${cols.length ? ', ' + cols.join(', ') : ''})
              VALUES (?${cols.length ? ', ' + cols.map(() => '?').join(', ') : ''})`)
    .run(personId, ...cols.map((k) => patch[k]));
  return db.prepare('SELECT last_insert_rowid() id').get().id;
}

export function editQuestion(db, id, patch) {
  const cols = QUESTION_FIELDS.filter((k) => patch[k] !== undefined);
  if (!cols.length) return false;
  const resolved = patch.status && patch.status !== 'open' ? ", resolved_at = strftime('%s','now')" : '';
  db.prepare(`UPDATE research_questions SET ${cols.map((k) => `${k}=?`).join(', ')}${resolved} WHERE id = ?`)
    .run(...cols.map((k) => patch[k]), id);
  return true;
}

export const deleteQuestion = (db, id) =>
  db.prepare("UPDATE research_questions SET deleted_at = strftime('%s','now') WHERE id = ?").run(id);

export const listNameVariants = (db, personId) =>
  db.prepare('SELECT * FROM name_variants WHERE person_id = ? AND deleted_at IS NULL ORDER BY id').all(personId);

export function addNameVariant(db, personId, { value, script = '', lang = '', record_system = '', note = '' }) {
  db.prepare(`INSERT INTO name_variants (person_id, value, script, lang, record_system, note)
              VALUES (?, ?, ?, ?, ?, ?)`).run(personId, value, script, lang, record_system, note);
  return db.prepare('SELECT last_insert_rowid() id').get().id;
}

export const deleteNameVariant = (db, id) =>
  db.prepare("UPDATE name_variants SET deleted_at = strftime('%s','now') WHERE id = ?").run(id);

// ── the change log ───────────────────────────────────────────────────────────
// Two sinks, written in this order: the DB row first (so the id exists), then
// one JSON line appended to changes.log. The file is never rewritten — undoing
// a change appends an `undo` entry rather than removing anything.

export function recordChange(db, e) {
  const info = db.prepare(`INSERT INTO changes (ts,actor,actor_no,kind,person_id,person_no,summary,before,after)
                           VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(e.ts || Math.floor(Date.now() / 1000), e.actor || '', e.actor_no ?? null, e.kind,
         e.person_id ?? null, e.person_no ?? null, e.summary || '',
         JSON.stringify(e.before || {}), JSON.stringify(e.after || {}));
  const id = Number(info.lastInsertRowid);
  const line = JSON.stringify({
    id, ts: e.ts || Math.floor(Date.now() / 1000), actor: e.actor || '', actor_no: e.actor_no ?? null,
    kind: e.kind, person_id: e.person_id ?? null, person_no: e.person_no ?? null,
    summary: e.summary || '', before: e.before || {}, after: e.after || {},
  });
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch (err) {
    // The DB row is already committed. Losing the mirror is worth a loud log
    // line but not a failed request — the DB remains the recoverable copy.
    console.error('[family] changes.log append failed:', err?.message || err);
  }
  // Typing an address into the tree is only half of letting someone in; the
  // other half is Cloudflare Access. Hooked here rather than in the route
  // handlers so it holds for every writer — web edit, undo, delete, CLI.
  try {
    const hasEmail = () => !!(e.person_id
      && db.prepare('SELECT email FROM people WHERE id=?').get(e.person_id)?.email);
    if (changeAffectsAllowlist(e, hasEmail)) requestCfSync(`${e.kind} #${e.person_no ?? '?'}`);
  } catch (err) {
    console.error('[family] cf-sync trigger skipped:', err?.message || err);
  }
  // And the other half of typing an address: the pin. The map reads coordinates
  // out of `places`/`addresses` and never geocodes in a request, so a brand new
  // address has none until the geocoder next runs — which was daily, and meant
  // a relative who corrected their street watched the map keep them in the
  // middle of town until the morning. Hooked in the same place, for the same
  // reason: every writer goes through recordChange.
  try {
    if (changeAffectsGeocode(e)) requestGeocode(`${e.kind} #${e.person_no ?? '?'}`);
  } catch (err) {
    console.error('[family] geocode trigger skipped:', err?.message || err);
  }
  return id;
}

export function recentChanges(db, limit = 200) {
  return db.prepare(`SELECT c.*, p.name_he, p.name_en FROM changes c
                     LEFT JOIN people p ON p.id=c.person_id
                     ORDER BY c.id DESC LIMIT ?`).all(limit);
}

// ── ids ──────────────────────────────────────────────────────────────────────
// New people get a slug derived from their name, because every existing id is a
// readable slug and a tree full of `p_8f21ac` would end that.

export function makeId(db, first, last) {
  // Hebrew is kept as-is: the form the family types into is Hebrew, and a
  // transliterated guess would be both wrong and unreadable. Only when a name
  // reduces to nothing usable do we fall back to a random stem.
  let base = [first, last].filter(Boolean).join('_').trim().toLowerCase()
    .replace(/['"״׳]/g, '').replace(/\s+/g, '_').replace(/[^a-z0-9_֐-׿]/g, '')
    .replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!base) base = 'p' + crypto.randomBytes(3).toString('hex');
  let id = base;
  for (let i = 2; db.prepare('SELECT 1 FROM people WHERE id=?').get(id); i++) id = `${base}_${i}`;
  return id;
}

export const newPhotoId = () => crypto.randomBytes(8).toString('hex');
