-- Additive schema for the family-tree web service.
--
-- Everything here layers on top of schema.sql. The `people` table stays the
-- system of record; this file adds the columns the service needs (contact
-- details, the human-facing person number, soft deletion) plus the tables that
-- only exist because people can now edit the tree from a browser.
--
-- Two rules the rest of the code depends on:
--   * `person_no` is assigned once and never reused. Deleting a person does not
--     free their number — that is the whole point of quoting it to relatives.
--   * `changes` is append-only. Nothing UPDATEs or DELETEs a row in it, and the
--     same record is mirrored to changes.log as one JSON line per change.

-- ── stable, human-facing person numbers ──────────────────────────────────────
-- The slug id (`dana_levi`, `avi_cohen`) stays the foreign key everything points
-- at; person_no is what a person reads off the screen and quotes back.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── marriages ────────────────────────────────────────────────────────────────
-- people.spouse_id can only hold one partner and cannot say "divorced", so it
-- becomes a derived cache of the current marriage (see currentSpouse() in
-- lib/store.mjs) and this table holds the truth. a_id/b_id are stored with the
-- lexicographically smaller id first so a couple can only be entered once.
CREATE TABLE IF NOT EXISTS unions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  a_id       TEXT NOT NULL REFERENCES people(id),
  b_id       TEXT NOT NULL REFERENCES people(id),
  status     TEXT NOT NULL DEFAULT 'married'
               CHECK (status IN ('married','divorced','widowed','partners')),
  start_date TEXT NOT NULL DEFAULT '',   -- YYYY-MM-DD, or YYYY, or ''
  end_date   TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  created_by TEXT NOT NULL DEFAULT '',
  UNIQUE (a_id, b_id, start_date)
);

CREATE INDEX IF NOT EXISTS unions_a ON unions(a_id);
CREATE INDEX IF NOT EXISTS unions_b ON unions(b_id);

-- ── photos ───────────────────────────────────────────────────────────────────
-- Bytes live on disk under photos/; only metadata is in the DB. `is_avatar`
-- marks the one that shows on the person's node in the tree.
CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,          -- random hex; also the filename stem
  person_id  TEXT NOT NULL REFERENCES people(id),
  ext        TEXT NOT NULL,             -- jpg | png | webp | gif
  bytes      INTEGER NOT NULL,
  width      INTEGER NOT NULL DEFAULT 0,
  height     INTEGER NOT NULL DEFAULT 0,
  caption    TEXT NOT NULL DEFAULT '',
  is_avatar  INTEGER NOT NULL DEFAULT 0,
  uploaded_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  uploaded_by TEXT NOT NULL DEFAULT '',
  deleted_at  INTEGER
);

CREATE INDEX IF NOT EXISTS photos_person ON photos(person_id) WHERE deleted_at IS NULL;

-- ── documents ────────────────────────────────────────────────────────────────
-- Evidence, as opposed to likenesses. A birth certificate, a Yad Vashem card, a
-- burial-society printout, the page of במחנה that names somebody: the things a
-- fact on this tree can be checked against. Kept apart from `photos` because
-- they are read in a different place (under the fact, not in the album), half
-- of them are PDFs, and every one of them wants a provenance line that a family
-- snapshot does not.
--
-- `file` is the path under documents/, NOT derived from the id: the directory
-- already held eleven research files with names a human chose, and those are
-- registered where they lie rather than renamed to hex. An upload writes
-- documents/<id>.<ext> and stores exactly that. Everything reading this column
-- goes through docPath() in lib/store.mjs, which refuses a path that climbs out
-- of the directory.
--
-- One file may be registered against several people — a marriage record names
-- two — so a row is an ATTACHMENT, not the document itself, and deleting one
-- attachment leaves the other alone. Soft deletion, like photos, so `undo`
-- has something to put back.
CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,          -- random hex; the filename stem of an upload
  person_id   TEXT NOT NULL REFERENCES people(id),
  file        TEXT NOT NULL,             -- path under documents/
  ext         TEXT NOT NULL,             -- pdf | jpg | png | webp | gif | heic | tif | txt
  bytes       INTEGER NOT NULL DEFAULT 0,
  title       TEXT NOT NULL DEFAULT '',  -- what it is, in the family's words
  -- What it is evidence OF, so the card can hang it under the right fact:
  -- birth | death | burial | marriage | immigration | military | press |
  -- registry | other. See DOC_KINDS in lib/store.mjs.
  kind        TEXT NOT NULL DEFAULT 'other',
  note        TEXT NOT NULL DEFAULT '',  -- what it says, for a document nobody can read
  source      TEXT NOT NULL DEFAULT '',  -- where it came from: archive reference, URL, a person
  uploaded_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  uploaded_by TEXT NOT NULL DEFAULT '',
  deleted_at  INTEGER
);

CREATE INDEX IF NOT EXISTS documents_person ON documents(person_id) WHERE deleted_at IS NULL;

-- ── families ─────────────────────────────────────────────────────────────────
-- A family (ענף) used to exist only as a string in people.branch and a hue the
-- client made up on the spot, which meant its colour changed the moment someone
-- was added and could not be argued with. It is a row now: one per branch key
-- (people.branch with any "(in-law)" suffix stripped, or the literals
-- 'unconfirmed' / 'other'), carrying the name in both languages and the colour
-- the family chose. Rows are created on demand from the branches that actually
-- occur in `people` — see ensureFamilies() in lib/families.mjs — so this table
-- never disagrees with the tree about which families exist.
--
-- `color` is a #rrggbb the family may change; the derived tints the map and the
-- branch chips draw with are computed from it, never stored, so one edit moves
-- every shade at once. `seq` is the creation order, which is what picks the
-- default colour off the palette and is why an existing family's default never
-- shifts when a new one appears.
CREATE TABLE IF NOT EXISTS families (
  key        TEXT PRIMARY KEY,
  name_he    TEXT NOT NULL DEFAULT '',
  name_en    TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT '',   -- #rrggbb
  seq        INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_by TEXT NOT NULL DEFAULT ''
);

-- ── origins ──────────────────────────────────────────────────────────────────
-- The countries a family came FROM, as rows rather than as strings scattered
-- across `people`. The sibling of `families`, and for the same reason: the tree
-- had thirteen country names hardcoded in a front-end file, in Hebrew only, so
-- an English reader got Hebrew labels and a fourteenth country drew grey with
-- no name in either language.
--
-- `key` is the string that actually travels in the data — `people.birth_country`,
-- `origin_override`, and the keys of the `origin_mix` JSON. It is Hebrew, because
-- that is what the registry produced and what is already stored; `name_he` and
-- `name_en` are what a reader is shown.
--
-- `region` groups the countries for the legend and, with `step`, is what picks
-- the colour: hue carries the region, a step inside the region's ramp carries
-- the country. See web/public/app/origin.js for why the encoding is composite
-- rather than one hue each. Both are frozen once assigned — a colour that
-- followed a country's rank in whichever chart is on screen would stop two
-- charts being comparable.
CREATE TABLE IF NOT EXISTS origins (
  key        TEXT PRIMARY KEY,          -- the Hebrew string stored in people.*
  name_he    TEXT NOT NULL DEFAULT '',
  name_en    TEXT NOT NULL DEFAULT '',
  region     TEXT NOT NULL DEFAULT '',  -- africa | asia | east | west | '' (unplaced)
  step       INTEGER NOT NULL DEFAULT 0,-- position in the region's ramp, frozen
  color      TEXT NOT NULL DEFAULT '',  -- #rrggbb; derived from region+step unless set
  seq        INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_by TEXT NOT NULL DEFAULT ''
);

-- What a relative may have typed that means a country we already know. The
-- origin field is free text — a relative in Toronto types "Poland", the registry
-- says "פולין", and without this they are two countries with two colours and
-- two slices of the same family. Seeded with both languages and the spellings
-- that have actually turned up; a new alias is one row.
CREATE TABLE IF NOT EXISTS origin_aliases (
  alias TEXT PRIMARY KEY,               -- lower-cased, trimmed
  key   TEXT NOT NULL REFERENCES origins(key)
);

-- ── places ───────────────────────────────────────────────────────────────────
-- Coordinates for the settlements people live in, keyed by the city string
-- exactly as it appears in people.city — including the malformed ones the
-- registry produced (reversed parentheses, a slash-separated list), because the
-- key has to match what is in the row, not what it should have said.
--
-- Filled by scripts/geocode-places.mjs and then left alone: the map reads this
-- table and never geocodes during a request. A settlement with no row is not an
-- error, it is a person the map has to admit it cannot place, which the page
-- says out loud rather than dropping them silently.
--
-- A town is (name, country), not a name: `טריפולי` in Libya and a namesake
-- anywhere else are two places with two sets of coordinates, and one primary
-- key over the name alone would let whichever was geocoded first answer for
-- both. `country` is an ISO 3166-1 alpha-2 code and '' means Israel — the same
-- convention people.country uses, so a town nobody has said anything about
-- keeps the row it already had.
-- A place has an `id` as well as its (name, country) key because other tables
-- point at it now — a birth, a job, a memorial. Every existing query still
-- works: (name, country) is still unique and still what ON CONFLICT names.
--
-- `parent_id` is the hierarchy a town needs once the tree reaches back past
-- living memory. Carpineni is a village in the Chișinău uyezd, in Bessarabia,
-- in what was Romania in 1925 and is Moldova now — four rows, not one string,
-- so correcting the district corrects every page that mentions it.
CREATE TABLE IF NOT EXISTS places (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,              -- verbatim people.city
  country    TEXT NOT NULL DEFAULT '',   -- '' = Israel
  parent_id  INTEGER REFERENCES places(id),
  lat        REAL,
  lng        REAL,
  display    TEXT NOT NULL DEFAULT '',   -- what the geocoder called it
  source     TEXT NOT NULL DEFAULT '',   -- design | nominatim | manual
  queried_at INTEGER,                    -- last lookup attempt, hit or miss
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE (name, country)
);

-- What a place was called, and when. The family's records span Russian Empire →
-- Romania → USSR → Moldova, and a record is only findable under the name the
-- archive used at the time: searching "Hîncești" finds nothing written in 1924.
CREATE TABLE IF NOT EXISTS place_names (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id  INTEGER NOT NULL REFERENCES places(id),
  name      TEXT NOT NULL,
  lang      TEXT NOT NULL DEFAULT '',   -- he | en | ro | ru | yi | ''
  from_year INTEGER,                    -- NULL = as far back as we know
  to_year   INTEGER,                    -- NULL = still current
  note      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS place_names_place ON place_names(place_id);

-- ── the address vocabulary ───────────────────────────────────────────────────
-- Every settlement in Israel and every street in each of them, from the
-- government's own list (data.gov.il resource 9ad3862c, ~63.5k streets).
-- Refilled by scripts/fetch-streets.mjs.
--
-- This exists so that "where do they live" can be picked rather than typed. The
-- free-text city column produced `פקיעין )בוקייעה(` and
-- `Giv'atayim/Geneva/Rome`, both of which are now permanent keys in `places`
-- because they are what somebody wrote down. A street typed the same way would
-- multiply that by every house in the country.
--
-- Picking from the list is not enforced: a relative in Toronto has to be able to
-- type an address that is not in an Israeli dataset. The list is help, not a
-- validator.
--
-- It is also Israel's list and only Israel's. A person whose `country` is set
-- to anywhere else is offered the towns the family already lives in there
-- instead (lib/places.mjs), and no street list at all — there is no gazetteer
-- here for the streets of Rome, and an empty picker under a country that has
-- one would read as "we have never heard of your street".
CREATE TABLE IF NOT EXISTS settlements (
  code       INTEGER PRIMARY KEY,        -- סמל ישוב
  name       TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS settlements_name ON settlements(name);

CREATE TABLE IF NOT EXISTS streets (
  settlement_code INTEGER NOT NULL REFERENCES settlements(code),
  code            INTEGER NOT NULL,      -- סמל רחוב
  name            TEXT NOT NULL,
  PRIMARY KEY (settlement_code, code)
);
CREATE INDEX IF NOT EXISTS streets_settlement ON streets(settlement_code);

-- ── exact addresses ──────────────────────────────────────────────────────────
-- One row per distinct city+street+house anyone in the tree lives at, geocoded
-- out of band exactly like `places`. Keyed by the address text rather than by
-- person, so a household of five is one lookup and moving house does not strand
-- a coordinate on somebody's row.
CREATE TABLE IF NOT EXISTS addresses (
  -- city|street|house, normalised, with |country appended when it is not in
  -- Israel. Appended rather than always present so every key written before
  -- there were countries still names the same address, and a hundred-odd
  -- geocoded houses did not have to be looked up a second time.
  key        TEXT PRIMARY KEY,
  city       TEXT NOT NULL DEFAULT '',
  street     TEXT NOT NULL DEFAULT '',
  house      TEXT NOT NULL DEFAULT '',
  country    TEXT NOT NULL DEFAULT '',   -- '' = Israel
  lat        REAL,
  lng        REAL,
  display    TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',   -- nominatim | manual | miss
  queried_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ── change log ───────────────────────────────────────────────────────────────
-- Append-only. One row per accepted mutation, mirrored to changes.log.
-- `before`/`after` are JSON objects holding only the fields that differed, so
-- an undo is a matter of re-applying `before`.
CREATE TABLE IF NOT EXISTS changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  actor      TEXT NOT NULL DEFAULT '',   -- Cloudflare Access email
  actor_no   INTEGER,                    -- person_no of the actor, when known
  kind       TEXT NOT NULL               -- what happened
               CHECK (kind IN ('add','edit','delete','restore','undo',
                               'photo.add','photo.delete','union.add',
                               'union.edit','union.delete',
                               'doc.add','doc.edit','doc.delete',
                               'fact.add','fact.edit','fact.delete',
                               'event.add','event.edit','event.delete',
                               'citation.add','citation.edit','citation.delete',
                               'name.add','name.delete',
                               'question.add','question.edit','question.delete')),
  person_id  TEXT,                       -- subject, when there is a single one
  person_no  INTEGER,
  summary    TEXT NOT NULL DEFAULT '',   -- Hebrew, shown in יומן שינויים
  before     TEXT NOT NULL DEFAULT '',   -- JSON, changed fields only
  after      TEXT NOT NULL DEFAULT '',   -- JSON, changed fields only
  undone_by  INTEGER REFERENCES changes(id)
);

CREATE INDEX IF NOT EXISTS changes_ts     ON changes(ts DESC);
CREATE INDEX IF NOT EXISTS changes_person ON changes(person_id);
CREATE INDEX IF NOT EXISTS changes_actor  ON changes(actor);

-- ── the evidence layer ───────────────────────────────────────────────────────
-- A claim is not a value. It is a value plus who says so and how sure we are.
--
-- The tree could get away without this while it held living relatives: everyone
-- knows their own birthday. It cannot once it reaches people nobody alive met,
-- where a fact arrives from a headstone, a Soviet award card and a 1924 trade
-- directory that disagree — and where three separate identifications of one
-- family were raised and refuted inside two days, each fitting on surname,
-- village, generation and fate.
--
-- A plain field is the shallow end of the same model: one source, confidence
-- 'confirmed'. Nothing here is required to add a cousin.

-- One row per source, reused by every claim that rests on it. This is why it is
-- a table and not a string on each fact: `<ref name="stone">` is cited three
-- times on one person's page alone, and the footnote must come out identical
-- each time or the page grows three slightly different versions of one headstone.
CREATE TABLE IF NOT EXISTS citations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_name    TEXT NOT NULL DEFAULT '',   -- renders as <ref name="stone">; unique when set
  kind        TEXT NOT NULL DEFAULT 'other'
                CHECK (kind IN ('headstone','registry','archive-card','directory',
                                'newspaper','testimony','dna','photo','web','other')),
  archive     TEXT NOT NULL DEFAULT '',   -- Yad Vashem | ЦАМО | JewishGen | …
  collection  TEXT NOT NULL DEFAULT '',
  record_id   TEXT NOT NULL DEFAULT '',   -- the archive's own reference
  citation_he TEXT NOT NULL DEFAULT '',   -- the footnote prose, as it renders
  citation_en TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  document_id TEXT REFERENCES documents(id),  -- the scan, when we hold one
  read_at     TEXT NOT NULL DEFAULT '',   -- when a human actually read it
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  created_by  TEXT NOT NULL DEFAULT '',
  deleted_at  INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS citations_ref ON citations(ref_name) WHERE ref_name <> '';

-- Provenance for ANY row: a people column, a fact, an event, a name variant, an
-- open question. `subject_kind` names the table (or table.column) and
-- `subject_id` the row, so a new kind of claim needs no new join table.
--
-- `supports = 0` is the load-bearing half. It records a source that CONTRADICTS
-- the claim — and, attached to a research_question, a search that found nothing.
-- "126 Yad Vashem records for a town, none of them the person sought" is a finding:
-- it is what stops someone running that same search again next year.
CREATE TABLE IF NOT EXISTS claim_citations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_kind TEXT NOT NULL,   -- 'people.birth_date' | 'events' | 'person_facts' | …
  subject_id   TEXT NOT NULL,   -- people.id, or a rowid as text
  citation_id  INTEGER NOT NULL REFERENCES citations(id),
  supports     INTEGER NOT NULL DEFAULT 1 CHECK (supports IN (0,1)),
  note_he      TEXT NOT NULL DEFAULT '',
  note_en      TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  created_by   TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS claim_citations_uniq
  ON claim_citations(subject_kind, subject_id, citation_id);
CREATE INDEX IF NOT EXISTS claim_citations_subject
  ON claim_citations(subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS claim_citations_citation ON claim_citations(citation_id);

-- Anything typed that happened to someone, with a start and maybe an end.
--
-- A residency, a job and a memorial are the same shape, so they are one table:
-- aliyah is a 'residence' starting 1973-02, not a column; "generator technician
-- at Nevatim" is an 'employment' with dates and a place, not a career string.
-- Birth, death and burial stay on `people` — they are singular, and the map,
-- the tree and the origin derivation all read them directly.
--
-- `details` is JSON for leaf attributes NOBODY FILTERS ON (a medal's name, a
-- plot number). Anything you would ever query — date, place, who, kind,
-- confidence — is a real column or a real row, because json_extract here is
-- neither indexed nor constrained. If you would ever ask "who else worked at
-- Nevatim", it does not go in `details`.
-- ── facts ────────────────────────────────────────────────────────────────────
--
-- ONE table, not two. There used to be `events` beside this — typed, dated,
-- placed, with an `event_people` many-to-many — and it held zero rows for its
-- entire life while every real assertion went into `person_facts`, which had a
-- label, a value and nothing else. Two tables for one idea meant the structured
-- one was always the one you were about to start using.
--
-- So the shape `events` had is here, on the table that has the data: a `kind`
-- from a fixed vocabulary, a date RANGE with its own precision, a place that is
-- a row in `places` and not a string, and — via `fact_people` — as many people
-- as the fact actually involves.
--
-- `person_id` stays as the SUBJECT, denormalised on purpose. 277 rows in
-- `claim_citations` point at these ids, `listFacts` reads them by person on
-- every card, and a fact almost always has one person it is chiefly about.
-- `fact_people` is the truth about who else is in it; the subject is mirrored
-- there too, with role='subject', so a query over participants never has to
-- special-case the owning column.
--
-- `as_of` is kept beside start_date/end_date and means something different: the
-- wiki's "Current / stale-able (as of 2026-08-08)" convention — when somebody
-- last CHECKED, as opposed to when the thing was true.
--
-- `details` is JSON and is for leaf attributes only (a grave's plot number).
-- Anything you would ever query — date, place, who, kind, confidence — is a
-- real column or a real row, because json_extract here is neither indexed nor
-- constrained. If you would ever ask "who else worked at Nevatim", it does not
-- go in `details`.
--
-- `narrative` in the vocabulary below is not a category, it is the RESIDUE: the
-- wiki prose that came in as page sections and describes a life rather than
-- asserting anything datable. It is deliberately nameable so it can be listed
-- and worked off, rather than hidden inside 'other'.
CREATE TABLE IF NOT EXISTS person_facts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  TEXT NOT NULL REFERENCES people(id),   -- the subject
  kind       TEXT NOT NULL DEFAULT 'other'
               CHECK (kind IN ('birth','death','burial','name','identity','registry',
                               'residence','migration','evacuation','education',
                               'employment','military-service','award','marriage',
                               'divorce','family','contact','social','interests',
                               'health','property','dna','memorial','research',
                               'narrative','other')),
  label_he   TEXT NOT NULL DEFAULT '',
  label_en   TEXT NOT NULL DEFAULT '',
  value_he   TEXT NOT NULL DEFAULT '',
  value_en   TEXT NOT NULL DEFAULT '',
  -- When it happened. '' end_date on a dated fact means still open — the
  -- current address, the job somebody is still in.
  start_date      TEXT NOT NULL DEFAULT '',   -- YYYY | YYYY-MM | YYYY-MM-DD
  start_precision TEXT NOT NULL DEFAULT '' CHECK (start_precision IN ('day','month','year','')),
  end_date        TEXT NOT NULL DEFAULT '',
  end_precision   TEXT NOT NULL DEFAULT '' CHECK (end_precision   IN ('day','month','year','')),
  -- Where. The row, so "Iaşi" on a birth and "Iaşi" on a residence are one
  -- town; the text, for a place no `places` row can be found for.
  place_id   INTEGER REFERENCES places(id),
  place_text TEXT NOT NULL DEFAULT '',
  -- When somebody last checked, NOT when it was true. See the note above.
  as_of      TEXT NOT NULL DEFAULT '',
  -- WHERE THIS CAME FROM, in the family's own shorthand: "Google Contacts",
  -- "מרשם האוכלוסין (zeut, ~2006)", "Yad Vashem 11216896", "confirmed by the owner
  -- 2026-08-08". Free text on purpose, and NOT a replacement for `citations` —
  -- a citation is a source described well enough to be found again by somebody
  -- else, which is a higher bar and a much smaller set. This is the line that
  -- was already being written into the middle of the value on 378 of 940 rows,
  -- given a column so it can be read, filtered and corrected.
  source     TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'confirmed'
               CHECK (confidence IN ('confirmed','probable','candidate','disproven')),
  details    TEXT NOT NULL DEFAULT '',   -- JSON object, leaf attributes only
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  created_by TEXT NOT NULL DEFAULT '',
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS person_facts_person ON person_facts(person_id) WHERE deleted_at IS NULL;
-- The indexes on `kind` and `place_id` are created by migrateFacts(), not here.
-- This file runs FIRST, against a DB whose person_facts may still be the old
-- three-column one — `CREATE TABLE IF NOT EXISTS` is then a no-op and an index
-- on a column that does not exist yet is a hard error on every open.

-- Who a fact involves, and as what. This is why a fact is not a per-person row:
-- the base naming its power station after Michael is ONE fact with three people
-- in it — the man it commemorates, the widow who unveiled the plaque, and the
-- son who stood with her. Filing that three times, once per person, is three
-- rows that can disagree.
--
-- The subject is in here too (role='subject'), mirroring person_facts.person_id,
-- so "every fact this person appears in" is one join and not a union of two
-- different shapes.
CREATE TABLE IF NOT EXISTS fact_people (
  fact_id   INTEGER NOT NULL REFERENCES person_facts(id),
  person_id TEXT    NOT NULL REFERENCES people(id),
  role      TEXT    NOT NULL DEFAULT 'subject',  -- subject|spouse|parent|child|employer|witness|…
  PRIMARY KEY (fact_id, person_id, role)
);

CREATE INDEX IF NOT EXISTS fact_people_person ON fact_people(person_id);

-- How facts bear on each other. Genealogy is mostly not a list of facts, it is
-- an argument: a 1942 evacuation card SUPERSEDES what the family remembered, a
-- candidate ת.ז. is CONTRADICTED by a death date, a patronymic is DERIVED-FROM
-- a headstone. Without this the reasoning lives in prose and is unqueryable —
-- which is exactly how 320 rows of wiki narrative came to exist.
--
-- Directed: `from` bears on `to`. Kept append-only in spirit — a link that
-- turns out to be wrong is deleted and the deletion is logged, like everything
-- else on this schema.
CREATE TABLE IF NOT EXISTS fact_links (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id   INTEGER NOT NULL REFERENCES person_facts(id),
  to_id     INTEGER NOT NULL REFERENCES person_facts(id),
  relation  TEXT NOT NULL DEFAULT 'see-also'
              CHECK (relation IN ('supersedes','contradicts','supports',
                                  'derived-from','part-of','duplicate-of','see-also')),
  note      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  created_by TEXT NOT NULL DEFAULT '',
  UNIQUE (from_id, to_id, relation)
);

CREATE INDEX IF NOT EXISTS fact_links_to ON fact_links(to_id);

-- One man is צבי on his headstone, Гершку in a 1924 Romanian trade directory and
-- Григорьевич in his son's 1970 Soviet award card. Those are not spelling
-- variants to be normalised away — each is the key that finds him in a different
-- archive, so each is a row with the record system that used it.
CREATE TABLE IF NOT EXISTS name_variants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id     TEXT NOT NULL REFERENCES people(id),
  value         TEXT NOT NULL,
  script        TEXT NOT NULL DEFAULT '',   -- hebrew | latin | cyrillic
  lang          TEXT NOT NULL DEFAULT '',
  record_system TEXT NOT NULL DEFAULT '',   -- headstone | soviet-army | romanian-directory | registry
  note          TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  deleted_at    INTEGER
);

CREATE INDEX IF NOT EXISTS name_variants_person ON name_variants(person_id) WHERE deleted_at IS NULL;

-- The "Still open" sections, which are the most valuable paragraphs on the wiki
-- and the ones a generated page would otherwise erase. A question carries the
-- candidate answer that is NOT yet proved and the next step that would settle
-- it, so the research survives whoever was holding it in their head.
CREATE TABLE IF NOT EXISTS research_questions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id    TEXT REFERENCES people(id),  -- NULL = about the family, not a person
  question_he  TEXT NOT NULL DEFAULT '',
  question_en  TEXT NOT NULL DEFAULT '',
  candidate_he TEXT NOT NULL DEFAULT '',    -- the unproved answer, stated as unproved
  candidate_en TEXT NOT NULL DEFAULT '',
  next_step_he TEXT NOT NULL DEFAULT '',    -- "the Red Army award card should decide it"
  next_step_en TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','answered','refuted')),
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  resolved_at  INTEGER,
  deleted_at   INTEGER
);

CREATE INDEX IF NOT EXISTS research_questions_person ON research_questions(person_id);

-- What each generated person page currently says, so the sync can tell in one
-- query which of 2270 pages need re-pushing without reading them all.
CREATE TABLE IF NOT EXISTS wiki_pages (
  person_id  TEXT NOT NULL REFERENCES people(id),
  lang       TEXT NOT NULL CHECK (lang IN ('en','he')),
  title      TEXT NOT NULL,
  hash       TEXT NOT NULL DEFAULT '',   -- of what was last CONFIRMED live, not what was sent
  pushed_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (person_id, lang)
);

-- The LLM-composed biography per person per language. A derived cache, like
-- wiki_pages — deliberately NOT change-logged: nobody EDITED anything, the
-- generator recomputed a rendering. `input_hash` is the sha256 of the
-- canonical structured input (lib/narrative-input.mjs); a person whose current
-- input hashes differently is "dirty" and gets regenerated. `status='failed'`
-- keeps the previous body — a failed generation must never blank a live page.
CREATE TABLE IF NOT EXISTS narratives (
  person_id    TEXT NOT NULL REFERENCES people(id),
  lang         TEXT NOT NULL CHECK (lang IN ('en','he')),
  input_hash   TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',   -- wikitext: lead paragraph + == sections ==
  model        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('ok','failed','pending')),
  error        TEXT NOT NULL DEFAULT '',
  generated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (person_id, lang)
);

-- Human wiki activity awaiting the discussion→DB loop. One row per non-Agents
-- RecentChanges entry (Talk-page notes, and article hand-edits captured to the
-- Talk page before the sync reverts them). scripts/wiki-inbox.mjs writes rows;
-- an agent drafts ops into `draft`; approval (Telegram) moves state onward;
-- scripts/family-apply.mjs is the only thing allowed to apply a draft.
CREATE TABLE IF NOT EXISTS wiki_inbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rcid       INTEGER UNIQUE,              -- MediaWiki recentchanges id
  ns         INTEGER NOT NULL,            -- 0 = article hand-edit, 1 = Talk note
  page_title TEXT NOT NULL,
  person_id  TEXT,                        -- resolved via wiki_pages when possible
  lang       TEXT,
  author     TEXT NOT NULL,
  comment    TEXT NOT NULL DEFAULT '',    -- the edit summary
  rev_old    INTEGER,
  rev_new    INTEGER,
  diff       TEXT NOT NULL DEFAULT '',    -- what changed, as readable text
  state      TEXT NOT NULL DEFAULT 'new'
               CHECK (state IN ('new','dispatched','drafted','applied','rejected','noop','failed')),
  draft      TEXT NOT NULL DEFAULT '',    -- the agent's proposed ops JSON
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS wiki_inbox_state ON wiki_inbox(state);
