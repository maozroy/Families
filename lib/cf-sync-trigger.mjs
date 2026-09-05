// ⛔ RETIRED, AND INTENTIONALLY INERT ON THIS INSTALL (2026-09-04).
//
// The family site no longer sits behind Cloudflare Access. The app took
// over sign-in itself around 2026-08-13 (AUTH_MODE=google, two doors: Google and
// WhatsApp codes), and the whole Cloudflare tool-chain was retired the next day
// to backups/retired-cf-scripts/ — cf-setup.mjs, cf-staging.mjs, cf-teardown.mjs
// and sync-cf-allowlist.mjs. Neither family-cf-sync.service nor .timer exists.
//
// This module was left wired into recordChange (lib/store.mjs) and kept trying
// to start the missing unit, so every edit that touched people.email printed
//   "cf-sync trigger failed: ... Unit family-cf-sync.service not found"
// which reads like a broken sync rather than a retired one. It is now a
// documented no-op: it notices the unit is absent, says so once per process,
// and does nothing.
//
// ⚠ DELIBERATELY NOT DELETED. The call site stays so that reinstalling the unit
// revives the mechanism with no code change — the same "kept as the revert path"
// treatment the poker Access app got when its edge gate was replaced. If you are
// reviving it, the script is in backups/retired-cf-scripts/ and Cloudflare
// changes need the operator's OK first (standing infra rule).
//
// ── Original design notes, still accurate if the unit is ever reinstalled ──
//
// Push the Cloudflare Access allow-list the moment the email column moves.
//
// The allow-list is generated from `people.email` by scripts/sync-cf-allowlist.mjs,
// which family-cf-sync.timer ran hourly. That hourly cadence is what made
// "I added a relative's address, why can't they get in?" a real question: the
// row was correct and Access still bounced them for up to an hour. This closed
// that window. The timer was the backstop — it covered a change made while the
// box was down, a failed API call, or drift introduced from the Cloudflare
// dashboard.
//
// The request is deliberately not the sync itself. It enqueues the existing
// unit, so there is still exactly one definition of how the sync runs (working
// directory, token access, journal), and so a burst of edits collapses into one
// systemd job instead of one Cloudflare API call per keystroke-sized change.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Where systemd keeps unit files, most specific first. Checked instead of
// shelling out to `systemctl list-unit-files`, which would cost a process on a
// path that must stay cheap enough to sit inside recordChange.
const UNIT_DIRS = ['/etc/systemd/system', '/run/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system'];

// Touched before the unit is started, read by the sync script on both sides of
// its run. Two writers racing — or a start job that systemd merged into an
// already-running one — would otherwise let a change be silently skipped until
// the next hour; the script re-runs instead when it sees this file move under
// it. See "the dirty flag" in scripts/sync-cf-allowlist.mjs.
export const WANTED_PATH = path.join(HERE, '..', '.cf-sync-wanted');

export const UNIT = 'family-cf-sync.service';

// Set FAMILY_CF_SYNC_TRIGGER=0 to keep a process from touching Cloudflare —
// bulk registry walks, restores from a backup, anything where the DB is being
// rewritten wholesale and one sync at the end is the sane granularity.
const ENABLED = process.env.FAMILY_CF_SYNC_TRIGGER !== '0';

/* Is the unit actually installed?
 *
 * ⚠ IT IS NOT, ON THIS INSTALL, AND THAT IS NOT A BUG IN THE CALLER — see the
 * retirement note at the top of this file. Before this check existed,
 * every edit that touched people.email printed
 *   "cf-sync trigger failed: Failed to start family-cf-sync.service: Unit ... not found"
 * which reads like a broken sync rather than an absent one. The two need to look
 * different: a missing unit is a dormant feature and is reported once; a unit
 * that exists and fails to start is a real fault and is reported every time.
 */
let unitInstalled = null; // null = not yet checked
let reportedMissing = false;

function isUnitInstalled() {
  if (unitInstalled === null) {
    unitInstalled = UNIT_DIRS.some((d) => {
      try { return fs.existsSync(path.join(d, UNIT)); } catch { return false; }
    });
  }
  return unitInstalled;
}

/** Ask for an allow-list sync as soon as systemd can get to it. Never throws. */
export function requestCfSync(reason = '') {
  if (!ENABLED) return false;

  if (!isUnitInstalled()) {
    if (!reportedMissing) {
      reportedMissing = true;
      console.error(
        `[family] ${UNIT} is not installed — the Cloudflare Access allow-list is not synced from `
        + 'people.email, and that is intentional: the CF gate was retired ~2026-08-13 when the app '
        + 'took over sign-in (AUTH_MODE=google). Nothing is broken and the DB write succeeded. '
        + 'Revert path: backups/retired-cf-scripts/. Reported once per process.',
      );
    }
    return false;
  }

  try {
    fs.writeFileSync(WANTED_PATH, `${Date.now()} ${reason}\n`);
  } catch (err) {
    // Losing the flag costs us the re-run guarantee, not the sync itself.
    console.error('[family] cf-sync flag write failed:', err?.message || err);
  }
  // Detached and unwatched on purpose: an edit must not wait on Cloudflare, and
  // must not fail because the allow-list did.
  execFile('systemctl', ['start', '--no-block', UNIT], (err) => {
    if (!err) return;
    // The unit was on disk a moment ago, so this is a genuine failure to start
    // (masked, bad ExecStart, systemd refusing the job) and must stay loud.
    console.error(`[family] cf-sync trigger failed (${reason}):`, err.message);
  });
  return true;
}

/**
 * Does this change log entry move the set of addresses Access should admit?
 *
 * The allow-list is every non-empty email on a row that is not soft-deleted, so
 * two kinds of change matter: the address itself, and whether the row counts.
 * `hasEmail` is a thunk because it costs a query and the common change — a
 * birthday, a city — is decided without it.
 */
export function changeAffectsAllowlist(e, hasEmail = () => false) {
  const before = e?.before || {};
  const after = e?.after || {};
  if ('email' in before || 'email' in after) return true;

  // delete/restore carry no field diff of their own, and an undo of either
  // shows up as a deleted_at flip. Only worth a sync if the row has an address.
  const visibility = e?.kind === 'delete' || e?.kind === 'restore'
    || 'deleted_at' in before || 'deleted_at' in after;
  return visibility && !!hasEmail();
}
