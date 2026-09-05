# Family tree

A self-hosted, bilingual (Hebrew RTL / English) family tree that the family
itself edits: a tree view, a map view, and a full per-person editor, over a
SQLite database. Every change is attributed and appended to a log, and any of
them can be undone.

It was built for one family and then generalised. Nothing about that family is
in this repository — no names, no data, no hostnames. What used to be compiled
in is now configuration.

## What it does

- **Tree view** — pan/zoom, branch filters, household collapsing, and a
  computed kinship label between any two people ("my second cousin once
  removed"), in Hebrew and English.
- **Map view** — households by door, life places, and origin-country mixes.
- **Person editor** — an ordinary form for the common fields, and an advanced
  page reaching every column plus the evidence tables (facts, citations, name
  variants, documents, photos).
- **Change log** — every edit attributed to the signed-in relative, appended to
  an immutable log, and reversible.
- **Sign-in** — Google, or one-time codes over WhatsApp. A person may sign in
  when their own row in the tree carries their address or number.

## Requirements

Node 22 or newer, and nothing else. There are no dependencies — the server uses
`node:sqlite`, and the pages are hand-written with no build step.

## Running it

```sh
cp .env.example /etc/family-web.env    # then edit it
cp config/seed-names.example.json config/seed-names.json
sqlite3 family.db < schema.sql         # or: node -e "..." with node:sqlite
node web/server.mjs
```

`FAMILY_OWNER_EMAIL` and `FAMILY_SESSION_KEY` are required; the server refuses
to start half-configured rather than run with the lock half on. See
`.env.example` for the rest, and `systemd/family-web.service.example` for a
unit.

## Configuration worth knowing about

| Variable | What it decides |
|---|---|
| `FAMILY_OWNER_EMAIL` | The owner account. Required; there is no default. |
| `FAMILY_ROOT_NAME_HE` / `_EN` | The person the tree is drawn around — generation 0, and what `relation_to_root` is measured against. |
| `FAMILY_OWNER_NAME_HE` / `_EN` | Who a stuck relative is told to contact. |
| `config/seed-names.json` | Hebrew and English display names per branch. Only a seed: once a family row exists, the database wins. |

`people.relation_to_root` and `people.generation` are both measured from the
root person. `generation` is blank for anyone unplaced, and stored as NULL
rather than 0, because 0 is the root person's own row.

## Layout

```
web/server.mjs      routes, validation, the API
web/auth.mjs        auth config; refuses to start half-configured
web/auth-routes.mjs the sign-in doors (Google, WhatsApp codes)
lib/store.mjs       the database, the editable-column lists, the change log
lib/families.mjs    branches as rows, with names and colours
lib/places.mjs      towns, streets, addresses
lib/origins.mjs     origin countries and mixes
web/public/         tree-v2.html, map-v2.html, edit.html + app/
schema.sql          the schema
```

Three lists govern what may be written: `EDITABLE` (the ordinary form),
`ADVANCED_EDITABLE` (the advanced page), and `ALL_EDITABLE` = both. Four places
must read `ALL_EDITABLE` or they fail *silently* — the insert, `undo()`,
`recomputeCurated()`, and the change-log field list. There is a self-test that
says so out loud.

## Not included

- The family database, photographs and documents. Obviously.
- The DNA pages served at `/dna`: they are generated elsewhere and read from
  `FAMILY_DNA_DIR`, which is unset by default.
- The v1 tree and map, still routed at `/v1`. Those routes 404 without them.
- "Roobert Hebrew", a commercially licensed font — see [NOTICE](NOTICE).

## Licence

MIT — see [LICENSE](LICENSE).
