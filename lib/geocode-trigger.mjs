// Put a freshly typed address on the map now, rather than tomorrow morning.
//
// Coordinates are filled out of band by scripts/geocode-places.mjs, which
// family-geocode.timer runs daily at 04:20. That cadence is what made "I just
// fixed נעמי's address and the map still shows her somewhere else" a real
// question: the row was right, `addresses` had no coordinates for it yet, and
// the map did the only thing it can with an address it cannot place — fall back
// to the middle of town, for up to a day. This closes that window.
//
// Same shape as the CF allow-list trigger next door, and for the same reasons:
// the request is not the geocode. It enqueues a unit, so there is one
// definition of how a geocode runs, and a burst of edits collapses into one
// systemd job instead of one Nominatim call per keystroke-sized change.
//
// The unit it starts is NOT family-geocode.service: that one runs
// fetch-streets.mjs first, and re-walking the 62k-row street dataset on every
// address edit would be absurd. family-geocode-now.service is the geocoder
// alone.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Touched before the unit is started, read by the geocoder on both sides of its
// run. systemd merges a start request into an already-running job, so without
// this an edit made while the geocoder was mid-run would be silently skipped
// until the next morning — exactly the bug this file exists to fix. See "going
// round again" in scripts/geocode-places.mjs.
export const WANTED_PATH = path.join(HERE, '..', '.geocode-wanted');

export const UNIT = 'family-geocode-now.service';

// Set FAMILY_GEOCODE_TRIGGER=0 to keep a process off Nominatim — registry
// backfills, restores from a backup, anything that rewrites addresses wholesale
// and wants one geocode at the end rather than one per row.
const ENABLED = process.env.FAMILY_GEOCODE_TRIGGER !== '0';

/** The flag's current value, or '' if there is none. Never throws. */
export function wantedStamp() {
  try { return fs.readFileSync(WANTED_PATH, 'utf8'); } catch { return ''; }
}

/** Ask for a geocode as soon as systemd can get to it. Never throws. */
export function requestGeocode(reason = '') {
  if (!ENABLED) return false;
  try {
    fs.writeFileSync(WANTED_PATH, `${Date.now()} ${reason}\n`);
  } catch (err) {
    // Losing the flag costs the re-run guarantee, not the geocode itself.
    console.error('[family] geocode flag write failed:', err?.message || err);
  }
  // Detached and unwatched on purpose: saving an address must not wait on
  // Nominatim, and must not fail because Nominatim did.
  execFile('systemctl', ['start', '--no-block', UNIT], (err) => {
    if (err) console.error(`[family] geocode trigger failed (${reason}):`, err.message);
  });
  return true;
}

/**
 * Does this change log entry move somebody's pin?
 *
 * The three address fields do. A new city needs a settlement lookup, a new
 * street or house number needs an address lookup, and a *cleared* field needs
 * one too — the person falls back a level and the level they fall back to may
 * itself never have been looked up.
 *
 * So do the three life-event towns, since the card offers to show each of them
 * on the map and a town with no coordinates has no button. A birthplace is
 * typed far less often than an address, which is the argument FOR triggering on
 * it rather than against: nobody is going to type Iaşi again tomorrow, so if
 * this run does not place it, the next thing that will is the nightly backstop.
 */
export function changeAffectsGeocode(e) {
  /* `country` belongs here for the same reason `city` does: placeKey() appends
     it when it is foreign, so moving somebody from '' to 'US' does not edit an
     existing pin — it asks for a different `places` row entirely, one with no
     coordinates yet. Without it, correcting a country left the person on the
     map at their old key, or nowhere. The life-event countries were already
     listed; the residence one had been missed. */
  const fields = ['city', 'street', 'house', 'country',
    'birth_city', 'birth_country', 'death_city', 'death_country',
    'burial_city', 'burial_country'];
  const before = e?.before || {};
  const after = e?.after || {};
  return fields.some((k) => k in before || k in after);
}
