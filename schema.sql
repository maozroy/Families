-- Family database. The system of record for who is related to whom.
--
-- The wiki does NOT hold these facts independently: the family tables on
-- [[Family tree]] are generated from this file by `family render`,
-- inside <!-- family-db:begin … --> markers. `family check` fails if the
-- wiki has drifted from the DB. Edit here, render there — never the reverse.

CREATE TABLE IF NOT EXISTS people (
  id               TEXT PRIMARY KEY,   -- stable slug; what father_id/mother_id/spouse_id point at
  name_en          TEXT NOT NULL DEFAULT '',
  name_he          TEXT NOT NULL DEFAULT '',
  sex              TEXT NOT NULL DEFAULT '' CHECK (sex IN ('M','F','')),
  birth_date       TEXT NOT NULL DEFAULT '',   -- YYYY-MM-DD, or YYYY when only the year is known
  birth_precision  TEXT NOT NULL DEFAULT ''  CHECK (birth_precision IN ('day','year','')),
  death_date       TEXT NOT NULL DEFAULT '',
  father_id        TEXT REFERENCES people(id),
  mother_id        TEXT REFERENCES people(id),
  spouse_id        TEXT REFERENCES people(id),
  relation_to_root TEXT NOT NULL DEFAULT '',
  branch           TEXT NOT NULL DEFAULT '',
  generation       INTEGER,            -- relative to the root person: 0 = their own, +1 children, -1 parents
  tz               TEXT NOT NULL DEFAULT '',   -- ת.ז., 9 digits, zero-padded
  city             TEXT NOT NULL DEFAULT '',   -- registry city (~2006 snapshot), for disambiguation
  registry_name    TEXT NOT NULL DEFAULT '',   -- exactly as the registry spells it, which is often not the everyday name
  source           TEXT NOT NULL DEFAULT '',   -- zeut | wiki | fb, comma-separated
  notes            TEXT NOT NULL DEFAULT '',
  no_sync          INTEGER NOT NULL DEFAULT 0,  -- referenced by other records but absent from the snapshot
  updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS people_tz     ON people(tz)     WHERE tz     <> '';
CREATE INDEX IF NOT EXISTS people_branch ON people(branch);
CREATE INDEX IF NOT EXISTS people_father ON people(father_id);
CREATE INDEX IF NOT EXISTS people_mother ON people(mother_id);

-- What the wiki currently shows, so drift is detectable without re-reading intent.
CREATE TABLE IF NOT EXISTS wiki_blocks (
  block_id    TEXT NOT NULL,           -- e.g. 'levi', 'roster'
  lang        TEXT NOT NULL CHECK (lang IN ('en','he')),
  page_title  TEXT NOT NULL,
  rendered    TEXT NOT NULL,           -- exactly what was last pushed
  pushed_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (block_id, lang)
);
