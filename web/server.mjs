#!/usr/bin/env node
// The family tree, editable by the family.
//
// Every request arrives through a Cloudflare Tunnel. Who is on the other end is
// decided by AUTH_MODE:
//
//   cf      Cloudflare Access gates the hostname and injects a signed
//           `Cf-Access-Jwt-Assertion`. Capped at 50 seats on the free plan.
//   google  this app owns sign-in on every hostname and issues its own
//           host-only session cookie. No seat cap.
//   both    the migration window: the live hostname keeps CF, the staging
//           hostname exercises the app's own sign-in, bound per Host so neither
//           is a way around the other.
//
// Where the app owns sign-in there are two doors, either or both of which may
// be configured: Google, and a code sent to the phone number on the person's
// row over WhatsApp. WhatsApp needs no GCP project, and reaches the larger half
// of the family — 41 people have a mobile on file against 28 with an email.
//
// Either way the credential is only a claim; `whoami` is what turns it into an
// identity, and it refuses any address or number that is not on a person row.
// Under CF that check was invisible because the Access allow-list was generated
// from the same column. Once this app owns sign-in it is the only thing standing
// between the tree and every Google account on earth. See web/auth.mjs.
//
// Authorisation is deliberately flat: anyone the family lets in may edit anyone.
// What protects the data is not permissions but the change log — every mutation
// is attributed, reversible, and mirrored to an append-only file.
//
//   PORT               listen port                      (default 3011)
//   AUTH_MODE          cf | both | google               (default cf)
//   CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD                required unless google
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET              enables Google sign-in
//   FAMILY_OTP_URL / FAMILY_OTP_TOKEN                    enables WhatsApp codes
//   FAMILY_SESSION_KEY 32 random bytes, hex              required unless cf
//   FAMILY_LIVE_HOST / FAMILY_STAGING_HOST               hostname binding
//   FAMILY_OWNER_EMAIL owner; the only one who sees ת.ז. / notes
//   FAMILY_DEV_TOKEN   file holding a token for scripts (X-Family-Token)
//
// The secrets live in /etc/family-web.env (0600), not in the unit file.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  openDb, allPeople, publicPerson, recordChange, recentChanges, markCurated,
  makeId, joinName, nextPersonNo, newPhotoId, syncSpouseColumn, syncPlaceIds, unionsFor, recomputeCurated,
  CONFIDENCE, CITATION_KINDS, FACT_KINDS, FACT_RELATIONS,
  listFacts, addFact, editFact, deleteFact, setFactPeople, linkFacts, unlinkFacts,
  listCitations, addCitation, citeClaim, uncite, citationsFor,
  listQuestions, addQuestion, editQuestion, deleteQuestion,
  listNameVariants, addNameVariant, deleteNameVariant,
  EDITABLE, ADVANCED_EDITABLE, ALL_EDITABLE, LOCKED,
  LANGS, PHOTO_DIR, ROOT, ORIGIN_INPUTS, LIFE_PLACE_FIELDS, recomputeOrigins,
  originIsDerived, originSources,
  DOC_DIR, DOC_KINDS, DOC_EXT, DOC_MIME, newDocumentId, docPath, listDocuments,
  touchSeen,
} from '../lib/store.mjs';
import {
  ensureFamilies, listFamilies, setFamilyColor, setFamilyNames, restoreFamily,
} from '../lib/families.mjs';
import {
  ensureOrigins, listOrigins, setOrigin, restoreOrigin, canonicalOrigin, REGIONS as ORIGIN_REGIONS,
} from '../lib/origins.mjs';
import { listPlaces, listLifePlaces, listSettlements, listStreets, listAddresses, addressKey, resolvePlaceId } from '../lib/places.mjs';
import { normalize as normCountry } from '../lib/countries.mjs';
import { isHex } from '../lib/colors.mjs';
import { normalize as normalizeContact } from '../lib/contacts.mjs';
import { graphFrom, relationBetween } from '../lib/relations.mjs';
import {
  SERVICE_ACTOR, loadAuthConfig, hostOf, makeBanList, makeCfVerifier, maybeRoll,
  methodsFor, readSession, resolveIdentity,
} from './auth.mjs';
import { makeAuthRoutes } from './auth-routes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const PORT = +(process.env.PORT || 3011);

/**
 * The origin serving the family wiki, or '' to draw no wiki links at all.
 *
 * Person cards link through `/gate/login?rd=...` rather than straight at
 * `/wiki/<Title>`: that entry point sends a reader who already holds a wiki
 * session directly to the page, and walks one who does not through the handoff
 * first (see the wiki's own README). Either way the link lands on the article,
 * signed in, with no dead end for the relative who has never opened the wiki.
 */
const WIKI_ORIGIN = process.env.FAMILY_WIKI_ORIGIN ?? '';

// Throws on a half-configured gate rather than starting one. Losing the service
// is recoverable; running it with the lock only half on is not.
const AUTH = loadAuthConfig();
const OWNER = AUTH.owner;

/* Where /api/diag writes. Beside the DB rather than under logs/ so it travels
   with the app the way changes.log does. */
const DIAG_LOG = path.join(ROOT, 'diag.jsonl');

const DEV_TOKEN = (() => {
  try { return fs.readFileSync(process.env.FAMILY_DEV_TOKEN || path.join(ROOT, '.dev-token'), 'utf8').trim(); }
  catch { return ''; }
})();

/* Optional shared access log, wired by absolute path because it belongs to a
   different service on the same box. Unset — the ordinary case for anyone who
   is not running that service — leaves the no-op stub in place, so the whole
   feature is off rather than half on. */
let audit = { log() {}, wrapHttp: (_a, h) => h };
if (process.env.FAMILY_AUDIT_MODULE) {
  try {
    const { createRequire } = await import('node:module');
    audit = createRequire(import.meta.url)(process.env.FAMILY_AUDIT_MODULE);
  } catch (err) {
    console.error('[family] FAMILY_AUDIT_MODULE could not be loaded — access logging is off:',
      err?.message || err);
  }
}

const db = openDb();
fs.mkdirSync(PHOTO_DIR, { recursive: true });

// A family is a row, not a string the client colours in on the fly. Reconciled
// at boot so a branch that arrived since the last start has a colour before
// anyone loads the map; new branches created while running are picked up by the
// same call on the read path.
ensureFamilies(db);

// The same for the countries this family came from. Seeded at boot so the very
// first page load has a name in both languages and a colour for every origin
// that occurs — including the ones no hardcoded list anticipated.
ensureOrigins(db);

// ── who is asking ────────────────────────────────────────────────────────────

const verifyCf = makeCfVerifier(AUTH);
const bans = makeBanList();
const clientIp = (req) => audit.clientIp?.(req) || req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || '';
const authRoute = makeAuthRoutes({ db, cfg: AUTH, audit, bans, clientIp });

/**
 * Who is asking. Returns null when the caller has no verified identity — there
 * is no anonymous path into this app, not even a read-only one — and null is
 * also the answer for a verified address that no one in the tree carries.
 *
 * That last part is the whole of the authorisation model. Every caller below
 * reads `me.person?.…` and copes with null, so an address let through without a
 * person row would edit the entire tree as nobody in particular; under CF that
 * could not happen only because CF's allow-list was generated from the same
 * column this function queries.
 */
async function whoami(req, res) {
  const method = methodsFor(AUTH, hostOf(req));
  let email = '';
  let phone = '';
  let sub = '';
  let kind = '';

  // 1. A relative who has signed in — with Google, or with a code sent to their
  //    WhatsApp. Both mint the same cookie; the cookie says which, because the
  //    two are re-checked against different columns on every request.
  let sess = null;
  if (method.session) {
    sess = readSession(AUTH, req);
    if (sess) ({ email, phone, sub, kind } = sess);
  }

  // 2. A script, not a person. Loopback alone is not enough: the tunnel also
  //    arrives from loopback, so a missing credential must never fall through
  //    to trust. The token identifies as a service so that a year from now the
  //    change log can still say which edits a human actually made.
  if (!kind && DEV_TOKEN && req.headers['x-family-token'] === DEV_TOKEN) {
    req.audit = { ...(req.audit || {}), actor: SERVICE_ACTOR, actor_kind: 'service' };
    return { email: SERVICE_ACTOR, owner: true, person: null, kind: 'service' };
  }

  // 3. Cloudflare Access, while this hostname still accepts it. Verified, not
  //    merely present — anything that reaches :3011 can set the header.
  if (!kind && method.cf) {
    const hdr = req.headers['cf-access-jwt-assertion'];
    const cf = await verifyCf(hdr);
    if (hdr && !cf) {
      req.audit = { ...(req.audit || {}), action: 'login.fail', outcome: 'denied',
        actor_kind: 'cf-access', external: true, alert: true,
        detail: { reason: 'invalid Cloudflare Access assertion' } };
      return null;
    }
    if (cf) { email = cf.email; kind = 'cf-access'; }
  }

  if (!kind) return null;

  const verdict = resolveIdentity(db, AUTH, { email, phone, sub, kind });
  if (!verdict.ok) {
    // Post-cutover this is the stranger-knocking signal, and it is worth more
    // than it used to be: nothing filtered it out before it got here.
    //
    // Deliberately not a strike against the IP. Getting here with a cookie
    // means the address was on a person row when it was issued and has since
    // been taken off — one page load is a dozen requests, so counting these
    // would ban a relative whose entry was edited. The callback counts fresh
    // attempts; the audit log's own burst detection covers the rest.
    req.audit = { ...(req.audit || {}),
      action: verdict.reason === 'sub_mismatch' ? 'login.sub_mismatch' : 'login.unknown_account',
      outcome: 'denied', actor: email || (phone ? `phone:${phone}` : ''),
      actor_kind: kind || 'unknown', external: true, alert: true,
      detail: { reason: verdict.reason } };
    return null;
  }

  // Only once the session is known good, so a refused request never leaves with
  // a freshly minted cookie.
  if (sess) maybeRoll(AUTH, res, sess);

  // identity.email, not the raw credential: a relative who signed in by phone
  // is logged under the same actor as when they sign in with Google.
  const me = verdict.identity.person;
  req.audit = { ...(req.audit || {}), actor: verdict.identity.email, actor_kind: kind,
    ...(me ? { actor_label: me.name_he } : {}) };
  /* Every request by a human whose row we found, throttled inside touchSeen to
     one write per five minutes. Here rather than on the /app/data.js route
     because a phone with the app on its home screen revalidates and posts diag
     without ever re-fetching the bootstrap, and here rather than on login
     because the cookie lasts weeks — see touchSeen() for the whole argument.
     The service token returned above and is not a person. */
  if (me) touchSeen(db, me.id);
  return verdict.identity;
}

/**
 * What an unauthenticated caller gets. A browser asking for a page is sent to
 * sign in; a fetch() is told 401 in JSON, because a Google consent screen
 * rendered into an XHR handler is the "<!doctype is not valid JSON" failure
 * that has bitten every other service on this box.
 */
function denyUnauthenticated(req, res, url) {
  const wantsHtml = req.method === 'GET'
    && !url.pathname.startsWith('/api/')
    && !req.headers['x-family-token']
    && String(req.headers.accept || '').includes('text/html');

  // `session`, not `google`: the sign-in page is worth showing on any hostname
  // this app gates itself, including one where the only method is WhatsApp.
  if (wantsHtml && methodsFor(AUTH, hostOf(req)).session) {
    res.writeHead(302, {
      location: `/auth/login?rd=${encodeURIComponent(url.pathname + url.search)}`,
      'cache-control': 'no-store',
    });
    return res.end();
  }
  return json(res, 401, { error: 'לא מזוהה. התחברו מחדש.' });
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Errors travel in both languages. The client shows whichever the reader picked
// rather than guessing, and nothing has to round-trip an error code table.
const ERR_EN = {
  'לא מזוהה. התחברו מחדש.': 'Not signed in. Sign in again.',
  'לא נמצא': 'Not found',
  'צריך שם': 'A name is required',
  'הקישור הזה יוצר לולאה בעץ': 'That link would make a loop in the tree',
  'רק JPEG, PNG, WebP או GIF': 'Only JPEG, PNG, WebP or GIF',
  'התמונה גדולה מדי (מקסימום 12MB)': 'That image is too large (12MB maximum)',
  'קובץ ריק': 'Empty file',
  'אין שינוי לבטל': 'Nothing to undo',
  'אפשר לבטל רק שינויים שלך': 'You can only undo your own changes',
  'סוג השינוי הזה לא ניתן לביטול אוטומטי': 'That kind of change cannot be undone automatically',
  'אי אפשר לחתן אדם עם עצמו': 'A person cannot be married to themselves',
  'שגיאת שרת': 'Server error',
  'bad path': 'bad path', 'not found': 'not found',
};

const json = (res, code, body) => {
  if (body && body.error && !body.error_en) {
    const en = ERR_EN[body.error];
    if (en) body.error_en = en;
  }
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
};

function body(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const jsonBody = async (req) => { const b = await body(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; };

/** A person by number (`17`) or slug (`dana_levi`). Numbers are what people quote. */
function findPerson(ref) {
  const s = String(ref || '').trim();
  if (/^\d+$/.test(s)) return db.prepare('SELECT * FROM people WHERE person_no=?').get(+s) || null;
  return db.prepare('SELECT * FROM people WHERE id=?').get(s) || null;
}

const label = (p) => (p ? (p.name_he || joinName(p.first_he, p.last_he) || p.id) : '');

// ── validation ───────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4}|\d{4}-\d{2}|\d{4}-\d{2}-\d{2})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(patch) {
  const out = {}, bad = [];
  for (const [k, vRaw] of Object.entries(patch)) {
    /* person_no, tz and google_sub are in neither list and never will be —
       see LOCKED in lib/store.mjs for why each one is refused. Everything the
       advanced page offers is in ADVANCED_EDITABLE and falls through to the
       same switch, so a structural column is validated exactly as hard as a
       phone number rather than being trusted because the page looked serious. */
    if (!ALL_EDITABLE.includes(k)) continue;
    let v = typeof vRaw === 'string' ? vRaw.trim() : vRaw;
    if (v === null || v === undefined) v = '';
    switch (k) {
      case 'birth_date': case 'death_date':
        if (v && !DATE_RE.test(v)) { bad.push([`${heField(k)}: כתבו 1988 או 1988-04 או 1988-04-12`, `${enField(k)}: use 1988, 1988-04 or 1988-04-12`]); continue; }
        break;
      case 'sex':
        if (v && !['M', 'F'].includes(v)) { bad.push(['מין: M או F', 'sex: M or F']); continue; }
        break;
      case 'email':
        v = String(v).toLowerCase();
        if (v && !EMAIL_RE.test(v)) { bad.push(['אימייל: לא כתובת תקינה', 'email: not a valid address']); continue; }
        break;
      case 'phone':
        v = String(v).replace(/[^\d+]/g, '');
        if (v && v.replace(/\D/g, '').length < 9) { bad.push(['טלפון: קצר מדי', 'phone: too short']); continue; }
        break;
      case 'instagram': case 'facebook': case 'linkedin': {
        // A handle or any of the URLs a phone's share sheet produces, stored as
        // the one URL we will open. null means it was neither, and the edit is
        // refused here rather than becoming a dead link on somebody's card.
        const url = normalizeContact(k, v);
        if (url === null) { bad.push([`${heField(k)}: לא כתובת פרופיל תקינה`, `${enField(k)}: not a valid profile address`]); continue; }
        v = url;
        break;
      }
      case 'country':
        /* Stored as an ISO 3166-1 alpha-2 code wherever the name resolves to
           one, so "Italy", "איטליה" and "IT" are one country and not three.
           What does not resolve is kept as typed rather than refused — the same
           rule the town and the street follow — and simply cannot narrow a
           geocode. 'IL' is normalised away to '', which is what every row that
           never left the country already says. */
        v = normCountry(v);
        if (v.toUpperCase() === 'IL') v = '';
        break;
      case 'city': case 'street':
      // The three life-event towns follow the town rule, not the country one:
      // free text, whitespace collapsed, never refused. A birthplace is copied
      // off a certificate in whatever alphabet the certificate used.
      case 'birth_city': case 'death_city': case 'burial_city':
        // Collapse the double space somebody's phone keyboard produced, so the
        // same street is one entry in `addresses` and not three.
        v = String(v).replace(/\s+/g, ' ').slice(0, 120);
        break;
      case 'birth_country': case 'death_country': case 'burial_country':
        /* Deliberately NOT normalised to a code, unlike `country` above. A life
           event happened in whatever the country was called at the time, and
           half of those have no code: ברית המועצות, בסרביה, Ottoman Palestine.
           Folding them to the modern state would rewrite the fact. What is
           stored is what was typed; lib/places.mjs resolves it to a code for
           the geocoder where one exists, and shrugs where it does not.
           `birth_country` additionally feeds the origin derivation, whose whole
           vocabulary is historic names — one more reason not to touch it. */
        v = String(v).replace(/\s+/g, ' ').slice(0, 120);
        break;
      case 'burial_place':
        // The cemetery, by name: "בית העלמין הישן", "Iaşi Jewish Cemetery".
        v = String(v).replace(/\s+/g, ' ').slice(0, 200);
        break;
      case 'burial_plot':
        /* Where in it: גוש י', חלקה 28, שורה 19, מספר 32. Copied verbatim off a
           burial-society record and stored unparsed on purpose — every חברה
           קדישא numbers its ground differently, and a schema that insisted on
           block/row/number would have to refuse the ones that use letters, or
           two numbers, or a name. Newlines flattened, nothing else touched. */
        v = String(v).replace(/\s*\n\s*/g, ' · ').replace(/[ \t]+/g, ' ').slice(0, 300);
        break;
      case 'house':
        // "14", "14א", "14/3", "14 ב'" are all real; a sentence is not.
        v = String(v).replace(/\s+/g, ' ').slice(0, 16);
        break;
      case 'born_after_sunset':
        /* The one boolean column the family writes, and it arrives as whatever
           a form or a hand-rolled PATCH felt like sending. Stored as 0/1 rather
           than passed through, because '' and 'false' are both truthy strings
           and either would silently move somebody's Hebrew birthday by a day.
           Anything unrecognised means "not asserted", which is the default. */
        v = (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
        break;
      case 'father_id': case 'mother_id':
        if (v && !findPerson(v)) { bad.push([`${heField(k)}: אין אדם כזה`, `${enField(k)}: no such person`]); continue; }
        if (v) v = findPerson(v).id;
        break;

      // ── the advanced columns ──────────────────────────────────────────────

      case 'generation':
        /* Which row of the tree this person is drawn on, relative to the root
           person. Blank is a real answer — most of the imported branches have
           none — and is stored as NULL rather than 0, because 0 is the root
           person's own generation and would silently promote a stranger into
           that row.
           Bounded because the layout walks every generation between the
           extremes: a fat-fingered 1988 is 1,990 empty rows to draw. */
        if (v === '' ) { v = null; break; }
        if (!/^-?\d{1,2}$/.test(String(v)) || Math.abs(+v) > 20) {
          bad.push(['דור: מספר שלם בין 20- ל-20, או ריק', 'generation: a whole number between -20 and 20, or blank']);
          continue;
        }
        v = +v;
        break;
      case 'no_sync': case 'deceased':
        // Same rule born_after_sunset follows above, and for the same reason:
        // '' and 'false' are both truthy strings.
        v = (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
        break;
      case 'lang':
        if (v && !LANGS.includes(v)) { bad.push([`שפה: ${LANGS.join(' או ')}`, `language: ${LANGS.join(' or ')}`]); continue; }
        break;
      case 'birth_precision':
        /* Normally derived from the shape of birth_date — see editPerson(). It
           is writable here for the one case the derivation cannot reach: a date
           written as a full ISO day that is really only known to the year,
           which is exactly what the registry's 1 January placeholders are. */
        if (v && !['day', 'year'].includes(v)) { bad.push(['דיוק תאריך: day או year', 'date precision: day or year']); continue; }
        break;
      case 'source':
        // A comma-separated provenance list — zeut, wiki, fb, web. Normalised
        // so 'wiki, zeut' and 'wiki,zeut' stay one value and not two.
        v = String(v).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).join(',').slice(0, 120);
        break;
      case 'branch': case 'dna_23andme':
      case 'wiki_title_he': case 'wiki_title_en':
        v = String(v).replace(/\s+/g, ' ').slice(0, 200);
        break;
      default:
        v = String(v).slice(0, 2000);
    }
    out[k] = v;
  }
  return { patch: out, bad };
}

/**
 * Refuse a parent link that would make someone their own ancestor. Without this
 * one mis-click turns the tree into a cycle and every layout walk hangs.
 */
function wouldCycle(childId, parentId) {
  if (!parentId) return false;
  if (parentId === childId) return true;
  const seen = new Set();
  let frontier = [parentId];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      if (id === childId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const p = db.prepare('SELECT father_id, mother_id FROM people WHERE id=?').get(id);
      if (p?.father_id) next.push(p.father_id);
      if (p?.mother_id) next.push(p.mother_id);
    }
    frontier = next;
  }
  return false;
}

/**
 * Keep name_he / name_en in step with the given/surname the form edits. The
 * full-name columns are what the wiki renderer and every older script read, so
 * they must never drift from the parts the app writes.
 */
function renameIfNeeded(id, patch, before) {
  if ('first_he' in patch || 'last_he' in patch) {
    const first = patch.first_he ?? before.first_he;
    const last = patch.last_he ?? before.last_he;
    db.prepare('UPDATE people SET name_he=? WHERE id=?').run(joinName(first, last), id);
  }
  if ('first_en' in patch || 'last_en' in patch) {
    const first = patch.first_en ?? before.first_en;
    const last = patch.last_en ?? before.last_en;
    db.prepare('UPDATE people SET name_en=? WHERE id=?').run(joinName(first, last), id);
  }
}

// ── routes ───────────────────────────────────────────────────────────────────

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/healthz') { res.audit = { skip: true }; return json(res, 200, { ok: true }); }

  // The icon and the manifest sit outside the gate on purpose: the browser asks
  // for them while rendering the sign-in page, and an icon of a tree gives away
  // nothing that the page title has not already said. Behind `whoami` they would
  // simply 302 to the login page and every tab would show a blank favicon.
  if (req.method === 'GET' && (p.startsWith('/icons/') || p === '/favicon.ico')) {
    if (p.includes('..')) return json(res, 400, { error: 'bad path' });
    res.audit = { skip: true };
    const file = p === '/favicon.ico' ? 'icons/favicon.ico' : p.slice(1);
    return sendFile(res, path.join(PUBLIC, file), 'public, max-age=604800');
  }

  // The v2 service worker is outside the gate for the same reason the icon is,
  // and for one more: a registration fetch made after the session lapsed would
  // otherwise be answered with the sign-in HTML, which the browser rejects as a
  // worker script and then keeps rejecting. The file holds no family data — it
  // is a cache policy — so there is nothing here to protect. Its path fixes its
  // scope to /v2/, which is what keeps it away from the live pages.
  // Served from the ROOT now, because a worker's scope is fixed by its path and
  // the pages it has to cover moved to the root with the cutover. `/v2/sw.js`
  // stays alongside it: phones that installed the app while it lived at /v2
  // have that one registered, and pulling it would leave them with a worker
  // that 404s on every update check.
  if (req.method === 'GET' && (p === '/sw.js' || p === '/v2/sw.js')) {
    res.audit = { skip: true };
    return sendFile(res, path.join(PUBLIC, 'v2-sw.js'), 'no-cache');
  }

  /* Per-correspondent DNA share pages: RETIRED 2026-08-26 at the owner's explicit
   * instruction ("remove this private page thing — don't expose this to people
   * outside; only persons we were able to link will be receiving access").
   * The ungated /dna/r/<token> route that lived here is gone; every token was
   * revoked and every rendered page deleted the same day, and no link was ever
   * sent to a correspondent. DNA relatives who get PLACED in the tree gain
   * access the normal way — an email address on their person row, through the
   * family auth gate like everyone else. Do not reintroduce an ungated route. */
  if (req.method === 'GET' && p.startsWith('/dna/r/')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }

  // Signing in has to happen before there is anyone to sign in as.
  if (p.startsWith('/auth/') && await authRoute(req, res, url)) return;

  const me = await whoami(req, res);
  if (!me) return denyUnauthenticated(req, res, url);

  // ── static + bootstrap ────────────────────────────────────────────────────
  // The map is the front door. The two pages are separate documents rather than
  // tabs, as the design has it, and they share the one bootstrap below — so it
  // costs one file and no second copy of the tree data.
  //
  // `/map` stays live because links to it are already out in the family, and
  // the tree keeps `/index.html` for the same reason. A link to `/?p=137` from
  // before the swap now opens the map on person 137, which is the nearest thing
  // to what it used to mean.
  // v2 IS the family tree as of 2026-08-14. It was reachable only by typing
  // /v2 for as long as it was a second opinion; it is now what the front door
  // opens on, and the pages it replaced are one path away rather than gone.
  if (req.method === 'GET' && (p === '/' || p === '/map' || p === '/map.html')) return sendDoc(res, 'map');
  if (req.method === 'GET' && (p === '/tree' || p === '/tree.html' || p === '/index.html')) return sendDoc(res, 'tree');
  // The DNA/ancestor map: 23andMe matches with inferred cousin distance and the
  // documented ancestors on one timeline. Behind the same gate as the tree —
  // it carries living relatives' names, shared-cM figures and profile links.
  if (req.method === 'GET' && (p === '/dna' || p === '/dna.html')) return sendDoc(res, 'dna');

  /* The advanced editor. A page of its own rather than a fold in the tree,
     because it is the only surface that reaches the structural columns and
     because tree-v2.html is ten thousand lines of a template engine that this
     form has no reason to be written in. Behind the same gate as everything
     else and offered to every signed-in relative — what protects the data here
     is what protects it everywhere in this app, which is the change log. */
  if (req.method === 'GET' && (p === '/edit' || p === '/edit.html')) return sendDoc(res, 'edit');

  /* The rest of the 23andMe visualisations — the gaps page above all, which
   * draws every unnamed ancestor slot and docks each relative's testimony to
   * the hole it could fill.
   *
   * These are BUILT artifacts: family-social/23-pedigree.mjs regenerates them
   * in place. They are therefore served from where they are generated rather
   * than copied in beside the tree — a copy is a thing to forget, and a stale
   * gaps page showing a slot that has since been filled is worse than no page.
   *
   * Same gate as everything above (`me` is resolved and enforced further up):
   * these carry living relatives' names, shared-cM figures, 23andMe profile
   * links AND correspondents' own email addresses, so they are strictly more
   * sensitive than the tree, never less.
   *
   * The allowlist is what makes serving a directory safe here — the path is
   * never joined from user input, only looked up, so `..` has nothing to walk.
   */
  if (req.method === 'GET' && (p === '/dna/' || p === '/dna/all')) return sendDnaAsset(res, 'index.html');
  if (req.method === 'GET' && (p === '/dna/gaps' || p === '/dna/hints')) return sendDnaAsset(res, 'pedigree-gaps.html');
  if (req.method === 'GET' && p.startsWith('/dna/')) return sendDnaAsset(res, p.slice('/dna/'.length));

  // The /v2 links are already out in the family — in the README, in chats, and
  // on at least one home screen. They keep working and land in the same place,
  // because a link that used to work and now 404s is worse than a duplicate
  // path. Nothing is generated pointing here any more.
  if (req.method === 'GET' && (p === '/v2' || p === '/v2/' || p === '/v2/map')) return sendDoc(res, 'map');
  if (req.method === 'GET' && p === '/v2/tree') return sendDoc(res, 'tree');

  // ── v1 ────────────────────────────────────────────────────────────────────
  // The pages that were the live ones until the swap. Kept reachable so the
  // cutover can be undone by editing two lines rather than by finding out what
  // else assumed them, and so anything v2 turns out not to do yet still has an
  // answer. Not linked from anywhere; delete both files when nothing misses it.
  if (req.method === 'GET' && (p === '/v1' || p === '/v1/' || p === '/v1/map')) return sendFile(res, path.join(PUBLIC, 'map.html'));
  if (req.method === 'GET' && p === '/v1/tree') return sendFile(res, path.join(PUBLIC, 'index.html'));

  if (req.method === 'GET' && p === '/app/data.js') {
    res.audit = { skip: true };
    const people = allPeople(db, { owner: me.owner });
    const js = `window.FAMILY = ${JSON.stringify(people)};\n`
      + `window.FAMILY_SELF = ${JSON.stringify(me.person?.id || '')};\n`
      // Families and settlements ride along with the tree: both pages need them
      // before first paint, and a second round trip would show an uncoloured
      // legend and an empty map for as long as it took.
      + `window.FAMILY_FAMILIES = ${JSON.stringify(ensureFamilies(db))};\n`
      // Origins likewise: the tree colours nodes by them, the person card names
      // them, and the form offers them as a list to pick from. All three want
      // them before first paint.
      + `window.FAMILY_ORIGINS = ${JSON.stringify(ensureOrigins(db))};\n`
      + `window.FAMILY_ORIGIN_REGIONS = ${JSON.stringify(ORIGIN_REGIONS.map(
        ({ key, nameHe, nameEn }) => ({ key, nameHe, nameEn })))};\n`
      + `window.FAMILY_PLACES = ${JSON.stringify(listPlaces(db))};\n`
      // The towns a life happened in, which is a different list from the towns
      // people live in — see lib/places.mjs. Shipped beside them so a card can
      // offer "show this on the map" without a round trip, and so a place that
      // has never been geocoded can say so instead of drawing a dead button.
      + `window.FAMILY_LIFE_PLACES = ${JSON.stringify(listLifePlaces(db))};\n`
      // Only the addresses that actually resolved — the map falls back to the
      // settlement for everyone else, and shipping the misses would just be
      // a list of nulls.
      + `window.FAMILY_ADDRESSES = ${JSON.stringify(listAddresses(db).filter((a) => a.lat != null))};\n`
      /* Where the family wiki lives, told to the browser once rather than baked
         into the ~1,900 rows of window.FAMILY that carry a `wiki` title. Which
         hostname serves it is a deployment fact and has already changed once;
         the data file is cached and the person cards are not the place to learn
         about it. Empty string disables the links outright, which is what a
         deployment with no wiki should do. */
      + `window.FAMILY_WIKI_ORIGIN = ${JSON.stringify(WIKI_ORIGIN)};\n`
      + `window.FAMILY_ME = ${JSON.stringify({
        email: me.email, owner: me.owner, no: me.person?.person_no || null,
        lang: me.person?.lang || '',
        // Only worth offering where this app owns the session; under CF,
        // signing out is Cloudflare's business, not ours.
        /* Whether THIS APP owns the session, not whether it was Google that
           opened it. `/auth/logout` clears `fam_sess`, and a code sent over
           WhatsApp mints exactly the same cookie — so testing for 'google' hid
           the only way out of the app from every relative who came in through
           the other door. That is the larger half of the family (16 people have
           a number and no address at all), and the scenario the button exists
           for is the shared iPad, where it matters most.
           Still absent under Cloudflare Access, where the session is not ours
           to end, and for the dev token, which is a script. */
        canSignOut: me.kind === 'google' || me.kind === 'whatsapp',
      })};\n`;
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(js);
  }

  if (req.method === 'GET' && p.startsWith('/app/')) {
    if (p.includes('..')) return json(res, 400, { error: 'bad path' });
    res.audit = { skip: true };
    return sendFile(res, path.join(PUBLIC, p), 'private, max-age=3600');
  }

  /* The bytes of one document. Same gate as everything else — these are birth
     certificates and Yad Vashem cards, which name living people's parents — and
     the same private cache header the photos carry. Served inline where a
     browser can show it (PDF, image) and downloaded otherwise, under the name
     the family gave it rather than the hex stem on disk. */
  if (req.method === 'GET' && p.startsWith('/doc/')) {
    res.audit = { skip: true };
    const id = p.slice('/doc/'.length).replace(/\.[a-z0-9]+$/i, '');
    const row = db.prepare('SELECT * FROM documents WHERE id=? AND deleted_at IS NULL').get(id);
    if (!row) return json(res, 404, { error: 'no such document' });
    const file = docPath(row);
    if (!file || !fs.existsSync(file)) return json(res, 404, { error: 'no such document' });
    const mime = DOC_MIME[String(row.ext || '').toLowerCase()] || 'application/octet-stream';
    const inline = /^(pdf|jpg|jpeg|png|webp|gif|txt|mp4)$/i.test(row.ext || '');
    // The filename is the title, stripped of everything a header cannot carry
    // and everything a filesystem would object to; falling back to the stored
    // name means a document with no title still downloads as something.
    const stem = String(row.title || '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 80)
      || path.basename(String(row.file || id), path.extname(String(row.file || '')));
    res.setHeader('content-disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(`${stem}.${row.ext}`)}`);
    return sendFile(res, file, 'private, max-age=86400', mime);
  }

  if (req.method === 'GET' && p.startsWith('/photo/')) {
    res.audit = { skip: true };
    const id = p.slice('/photo/'.length).replace(/\.[a-z0-9]+$/i, '');
    const row = db.prepare('SELECT * FROM photos WHERE id=? AND deleted_at IS NULL').get(id);
    if (!row) return json(res, 404, { error: 'no such photo' });
    return sendFile(res, path.join(PHOTO_DIR, `${row.id}.${row.ext}`), 'private, max-age=86400');
  }

  // ── read ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/lang') {
    const b = await jsonBody(req);
    const lang = LANGS.includes(b.lang) ? b.lang : '';
    if (!lang) return json(res, 400, { error: 'שפה לא מוכרת', error_en: 'Unknown language' });
    // Only a person the tree knows can have a preference saved; a viewer with
    // no row still gets the language, it just lives in their browser.
    if (me.person) db.prepare('UPDATE people SET lang=? WHERE id=?').run(lang, me.person.id);
    res.audit = { skip: true };
    return json(res, 200, { ok: true, lang, saved: !!me.person });
  }

  /* What the current documents are, so a page can tell whether it is one of
     them. Never cached by the worker (/api/* is network-only there), which is
     the whole point — a stale answer here would confirm a stale page. */
  if (req.method === 'GET' && p === '/api/build') {
    res.audit = { skip: true };
    return json(res, 200, { tree: buildStamp(path.join(PUBLIC, DOC_FILES.tree)),
      map: buildStamp(path.join(PUBLIC, DOC_FILES.map)) });
  }

  /* What the page actually got, from the device that got it.
   *
   * This exists because of a specific dead end. A phone showed a header, a row
   * of tabs with correct counts, and then nothing — and every way of looking at
   * it from here said the app was fine: it rendered clean headless at the same
   * viewport, clean through Cloudflare in a real browser, and the server had no
   * request log to say what that phone had even been handed. Two rounds of fixes
   * went out against a guess about which of those was lying. That is the cost
   * this is meant to remove: not being able to see the one screen that matters.
   *
   * It reports geometry and provenance, not content — how tall the layout came
   * out, which build the document is, whether a worker answered it. Nothing here
   * is about a person, so a family member's visit is not being watched; the
   * question it answers is "which copy of the app is this and did the layout
   * collapse", which is unanswerable from anywhere else.
   *
   * `POST` so the worker leaves it alone (it only handles GET), behind the same
   * session as everything else, and capped so a loop cannot fill the disk.
   */
  if (req.method === 'POST' && p === '/api/diag') {
    res.audit = { skip: true };
    let b = {};
    try { b = await jsonBody(req); } catch { b = {}; }
    const line = JSON.stringify({
      /* The page's report first, so what the server knows for itself overwrites
         it rather than the other way round: a line whose timestamp or author
         came out of the request body would be worth less than no line. */
      ...Object.fromEntries(Object.entries(b).slice(0, 40)),
      ts: new Date().toISOString(),
      who: me.email || me.kind || '?',
      ua: String(req.headers['user-agent'] || '').slice(0, 200),
      /* The server's opinion of the current build, recorded next to the page's,
         so the pair is readable without correlating two clocks. */
      serverBuild: buildStamp(path.join(PUBLIC, DOC_FILES[b.which === 'map' ? 'map' : 'tree'])),
    }).slice(0, 4000);
    try {
      /* Truncate rather than rotate: this is a debugging surface with one reader,
         and a file that needs a logrotate entry to stay safe is a file that will
         one day not have one. */
      if ((fs.existsSync(DIAG_LOG) ? fs.statSync(DIAG_LOG).size : 0) > (1 << 20)) fs.truncateSync(DIAG_LOG, 0);
      fs.appendFileSync(DIAG_LOG, line + '\n');
    } catch { /* a diagnostic that can break the app is worse than no diagnostic */ }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && p === '/api/me')
    return json(res, 200, {
      email: me.email, owner: me.owner,
      person: me.person ? publicPerson(db, me.person, { owner: me.owner }) : null,
    });

  if (req.method === 'GET' && p === '/api/people')
    return json(res, 200, { people: allPeople(db, { owner: me.owner }), self: me.person?.id || '' });

  if (req.method === 'GET' && p === '/api/families')
    return json(res, 200, { families: ensureFamilies(db) });

  /* How two people are related, worked out from the tree.
   *
   * This replaced a stored `relation_to_*` column. A column could only ever
   * answer for ONE fixed person, was written by a script that had to be
   * remembered after every edit, and drifted from the tree in between. The
   * relation between two people is a pure function of the parent and spouse
   * links; it is computed on demand, from the same calculator the pages use,
   * so there is no second answer to keep in step.
   *
   * `a` and `b` are person numbers or slugs. `null` for `relation` is a real
   * answer — the two are both in the tree with no path between them.
   */
  if (req.method === 'GET' && p === '/api/relation') {
    const A = findPerson(url.searchParams.get('a'));
    const B = findPerson(url.searchParams.get('b'));
    if (!A || !B) return json(res, 404, { error: 'לא נמצא', error_en: 'No such person' });
    const P = graphFrom(db.prepare('SELECT id,sex,father_id,mother_id,spouse_id,spouse_ex FROM people WHERE deleted_at IS NULL').all());
    const rel = relationBetween(P, A.id, B.id);
    return json(res, 200, {
      a: { id: A.id, no: A.person_no, name: label(A) },
      b: { id: B.id, no: B.person_no, name: label(B) },
      relation: rel && { he: rel.he, en: rel.en, kind: rel.kind, gen: rel.gen, half: rel.half },
    });
  }

  if (req.method === 'GET' && p === '/api/origins')
    return json(res, 200, { origins: ensureOrigins(db), regions: ORIGIN_REGIONS });

  if (req.method === 'GET' && p === '/api/places')
    return json(res, 200, { places: listPlaces(db) });

  // The address vocabulary. Settlements are small enough to hand over whole;
  // streets are 62k rows nationally, so they are asked for one settlement at a
  // time — which is also the only scope in which they are useful.
  //
  // Both are asked per COUNTRY. At home that is the government's list; abroad
  // it is the towns the family is already in, and no streets at all — see
  // listSettlements() for why an empty street list is the honest answer there
  // rather than a shorter one.
  if (req.method === 'GET' && p === '/api/settlements') {
    res.audit = { skip: true };
    const country = normCountry(url.searchParams.get('country') || '');
    return json(res, 200, { country, settlements: listSettlements(db, country) });
  }

  if (req.method === 'GET' && p === '/api/streets') {
    res.audit = { skip: true };
    const city = url.searchParams.get('city') || '';
    const country = normCountry(url.searchParams.get('country') || '');
    return json(res, 200, { city, country, streets: listStreets(db, city, country) });
  }

  if (req.method === 'GET' && p === '/api/changes') {
    const rows = recentChanges(db, Math.min(+(url.searchParams.get('limit') || 200), 500));
    return json(res, 200, {
      changes: rows.map((c) => {
        let after = {}; try { after = JSON.parse(c.after || '{}'); } catch { after = {}; }
        let before = {}; try { before = JSON.parse(c.before || '{}'); } catch { before = {}; }
        return {
          id: c.id, ts: c.ts, actor: c.actor, kind: c.kind, personId: c.person_id,
          personNo: c.person_no, name: c.name_he || '', nameEn: c.name_en || '',
          // The stored Hebrew sentence stays the canonical record in the log;
          // `fields` is what lets the client say the same thing in English.
          summary: c.summary,
          fields: Object.keys(after).filter((k) => ALL_EDITABLE.includes(k)),
          fieldsHe: Object.keys(after).filter((k) => ALL_EDITABLE.includes(k)).map(heField),
          fieldsEn: Object.keys(after).filter((k) => ALL_EDITABLE.includes(k)).map(enField),
          // A family edit has no person attached, so the client cannot name its
          // subject from `name`. Handing over the key and the new colour is what
          // lets the English log read as a sentence rather than fall back to the
          // stored Hebrew one.
          family: after.family || '',
          familyColor: after.family_color || '',
          familyName: after.family_name_he || '',
          // Likewise for an origin: no person, so the key and the new name are
          // what the English log has to build its sentence out of.
          origin: after.origin || '',
          originName: after.origin_name_en || after.origin_name_he || '',
          originRegion: after.origin_region || '',
          /* A document travels as an `edit` — see addDocument() — so nothing in
             `fields` describes it and the English log would say only "somebody
             was updated". The payload is what the client builds its sentence
             out of, exactly as it does for a family recolour. `before` is read
             for the delete case, where the removal is what `before` records. */
          document: after.document || before.document_deleted || '',
          documentTitle: after.document_title || before.document_title || '',
          documentGone: !!before.document_deleted,
          undone: !!c.undone_by, mine: c.actor === me.email,
        };
      }),
    });
  }

  if (req.method === 'GET' && /^\/api\/people\/[^/]+$/.test(p)) {
    const person = findPerson(decodeURIComponent(p.split('/')[3]));
    if (!person) return json(res, 404, { error: 'לא נמצא' });
    return json(res, 200, {
      person: publicPerson(db, person, { owner: me.owner }),
      photos: db.prepare('SELECT id,ext,caption,is_avatar FROM photos WHERE person_id=? AND deleted_at IS NULL ORDER BY is_avatar DESC, uploaded_at')
        .all(person.id),
      documents: listDocuments(db, person.id),
      unions: unionsFor(db, person.id),
      history: db.prepare('SELECT id,ts,actor,kind,summary FROM changes WHERE person_id=? ORDER BY id DESC LIMIT 50').all(person.id),
    });
  }

  /* Every column of one person, as a form spec rather than as a row.
     Deliberately not an extension of publicPerson(): that payload is shaped for
     the tree and the map, it renames columns (`born`, `g`, `job`) and it is
     fetched 1,100 at a time. This one is read one person at a time by one page,
     and its whole job is to say what the columns ARE — which is the thing a
     generic editor cannot guess and must not hardcode. */
  if (req.method === 'GET' && /^\/api\/people\/[^/]+\/raw$/.test(p)) {
    const person = findPerson(decodeURIComponent(p.split('/')[3]));
    if (!person) return json(res, 404, { error: 'לא נמצא' });
    res.audit = { skip: true };
    return json(res, 200, {
      id: person.id, no: person.person_no,
      nameHe: person.name_he || '', nameEn: person.name_en || '',
      deleted: !!person.deleted_at,
      groups: advancedFields(person, { owner: me.owner }),
      // Same list the ordinary card shows, and the reason the page needs no
      // second request to draw its history panel.
      history: db.prepare('SELECT id,ts,actor,kind,summary,undone_by FROM changes WHERE person_id=? ORDER BY id DESC LIMIT 60').all(person.id),
      unions: unionsFor(db, person.id),
      facts: listFacts(db, person.id),
      questions: listQuestions(db, person.id),
      names: listNameVariants(db, person.id),
      documents: listDocuments(db, person.id),
      photos: db.prepare('SELECT id,ext,caption,is_avatar FROM photos WHERE person_id=? AND deleted_at IS NULL ORDER BY is_avatar DESC, uploaded_at').all(person.id),
      vocab: { confidence: CONFIDENCE, factKinds: FACT_KINDS, factRelations: FACT_RELATIONS,
               precision: ['', 'day', 'month', 'year'],
               docKinds: DOC_KINDS, citationKinds: CITATION_KINDS,
               unionStatus: UNION_STATUS, questionStatus: ['open', 'answered', 'refuted'] },
    });
  }

  // ── write ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/people') return addPerson(req, res, me);
  if (req.method === 'PATCH' && /^\/api\/people\/[^/]+$/.test(p)) return editPerson(req, res, me, decodeURIComponent(p.split('/')[3]));
  if (req.method === 'DELETE' && /^\/api\/people\/[^/]+$/.test(p)) return deletePerson(req, res, me, decodeURIComponent(p.split('/')[3]));
  if (req.method === 'POST' && /^\/api\/people\/[^/]+\/restore$/.test(p)) return restorePerson(req, res, me, decodeURIComponent(p.split('/')[3]));
  if (req.method === 'POST' && /^\/api\/people\/[^/]+\/photo$/.test(p)) return addPhoto(req, res, me, decodeURIComponent(p.split('/')[3]));
  if (req.method === 'DELETE' && /^\/api\/photo\/[^/]+$/.test(p)) return deletePhoto(req, res, me, p.split('/')[3]);
  if (req.method === 'GET' && /^\/api\/people\/[^/]+\/documents$/.test(p)) {
    const person = findPerson(decodeURIComponent(p.split('/')[3]));
    if (!person) return json(res, 404, { error: 'לא נמצא' });
    res.audit = { skip: true };
    return json(res, 200, { documents: listDocuments(db, person.id) });
  }
  if (req.method === 'POST' && /^\/api\/people\/[^/]+\/document$/.test(p))
    return addDocument(req, res, me, decodeURIComponent(p.split('/')[3]), url);
  if (req.method === 'PATCH' && /^\/api\/documents\/[^/]+$/.test(p)) return editDocument(req, res, me, p.split('/')[3]);
  if (req.method === 'DELETE' && /^\/api\/documents\/[^/]+$/.test(p)) return deleteDocument(req, res, me, p.split('/')[3]);
  if (req.method === 'PATCH' && /^\/api\/families\/[^/]+$/.test(p))
    return editFamily(req, res, me, decodeURIComponent(p.split('/')[3]));
  if (req.method === 'PATCH' && /^\/api\/origins\/[^/]+$/.test(p))
    return editOrigin(req, res, me, decodeURIComponent(p.split('/')[3]));
  // ── the evidence layer ────────────────────────────────────────────────────
  // Shaped exactly like the document routes above: a collection under a person,
  // the rows themselves addressed by id. Everything returns the whole refreshed
  // list rather than the one row, so the editor never has to merge state.
  if (req.method === 'GET' && /^\/api\/people\/[^/]+\/facts$/.test(p)) {
    const person = findPerson(decodeURIComponent(p.split('/')[3]));
    if (!person) return json(res, 404, { error: 'לא נמצא' });
    res.audit = { skip: true };
    return json(res, 200, { facts: listFacts(db, person.id) });
  }
  if (req.method === 'POST' && /^\/api\/people\/[^/]+\/fact$/.test(p))
    return postFact(req, res, me, decodeURIComponent(p.split('/')[3]));
  if (req.method === 'PATCH' && /^\/api\/facts\/\d+$/.test(p)) return patchFact(req, res, me, p.split('/')[3]);
  if (req.method === 'DELETE' && /^\/api\/facts\/\d+$/.test(p)) return removeFact(req, res, me, p.split('/')[3]);

  if (req.method === 'GET' && p === '/api/citations') {
    res.audit = { skip: true };
    return json(res, 200, { citations: listCitations(db), kinds: CITATION_KINDS });
  }
  if (req.method === 'POST' && p === '/api/citations') return postCitation(req, res, me);
  if (req.method === 'GET' && p === '/api/claims') {
    const q = url.searchParams;
    res.audit = { skip: true };
    return json(res, 200, { citations: citationsFor(db, q.get('subject_kind') || '', q.get('subject_id') || '') });
  }
  if (req.method === 'POST' && p === '/api/claims') return postClaim(req, res, me);

  /* How one fact bears on another — a card SUPERSEDES what the family
     remembered, a date CONTRADICTS a candidate ת.ז. Both routes answer with the
     refreshed fact list for the person, like every other write on this page,
     so the editor never has to merge state. */
  if (req.method === 'POST' && /^\/api\/facts\/\d+\/link$/.test(p)) return postFactLink(req, res, me, p.split('/')[3]);
  if (req.method === 'DELETE' && /^\/api\/fact-links\/\d+$/.test(p)) return removeFactLink(req, res, me, p.split('/')[3]);

  if (req.method === 'GET' && /^\/api\/people\/[^/]+\/questions$/.test(p)) {
    const person = findPerson(decodeURIComponent(p.split('/')[3]));
    if (!person) return json(res, 404, { error: 'לא נמצא' });
    res.audit = { skip: true };
    return json(res, 200, { questions: listQuestions(db, person.id) });
  }
  if (req.method === 'POST' && /^\/api\/people\/[^/]+\/question$/.test(p))
    return postQuestion(req, res, me, decodeURIComponent(p.split('/')[3]));
  if (req.method === 'PATCH' && /^\/api\/questions\/\d+$/.test(p)) return patchQuestion(req, res, me, p.split('/')[3]);
  if (req.method === 'DELETE' && /^\/api\/questions\/\d+$/.test(p)) return removeQuestion(req, res, me, p.split('/')[3]);

  if (req.method === 'GET' && /^\/api\/people\/[^/]+\/names$/.test(p)) {
    const person = findPerson(decodeURIComponent(p.split('/')[3]));
    if (!person) return json(res, 404, { error: 'לא נמצא' });
    res.audit = { skip: true };
    return json(res, 200, { names: listNameVariants(db, person.id) });
  }
  if (req.method === 'POST' && /^\/api\/people\/[^/]+\/name$/.test(p))
    return postNameVariant(req, res, me, decodeURIComponent(p.split('/')[3]));
  if (req.method === 'DELETE' && /^\/api\/names\/\d+$/.test(p)) return removeNameVariant(req, res, me, p.split('/')[3]);

  if (req.method === 'POST' && p === '/api/unions') return addUnion(req, res, me);
  if (req.method === 'PATCH' && /^\/api\/unions\/\d+$/.test(p)) return editUnion(req, res, me, +p.split('/')[3]);
  if (req.method === 'DELETE' && /^\/api\/unions\/\d+$/.test(p)) return deleteUnion(req, res, me, +p.split('/')[3]);
  if (req.method === 'POST' && p === '/api/undo') return undo(req, res, me);

  return json(res, 404, { error: 'not found' });
}

// ── mutations ────────────────────────────────────────────────────────────────

async function addPerson(req, res, me) {
  const raw = await jsonBody(req);
  const { patch, bad } = clean(raw);
  if (bad.length) return json(res, 400, { error: bad.map((b) => b[0]).join('; '), error_en: bad.map((b) => b[1]).join('; ') });
  if (!patch.first_he && !patch.last_he) return json(res, 400, { error: 'צריך שם' });

  const id = makeId(db, patch.first_he, patch.last_he);
  const no = nextPersonNo(db);
  const name = joinName(patch.first_he, patch.last_he);

  /* Built from EDITABLE rather than from a hand-written column list. The list
     that used to be here named fifteen columns and was last updated when there
     were fifteen: anything added to EDITABLE afterwards — `street`, `house`,
     and before them `origin_override` and `birth_country` — was accepted by the
     validator, reported as saved, and then dropped on the floor by this INSERT.
     An edit a second later would store it, which is exactly the kind of bug
     nobody reports because the second attempt works. */
  const cols = {
    id, person_no: no, name_he: name, source: 'web',
    created_by: me.email, updated_by: me.email,
    curated: JSON.stringify(Object.keys(patch)),
    birth_precision: patch.birth_date ? (patch.birth_date.length === 4 ? 'year' : 'day') : '',
  };
  /* ALL_EDITABLE, not EDITABLE: the advanced page can create a person with a
     branch and a generation already on them, and the comment above is the whole
     argument for why this loop reads a list instead of naming columns. The two
     defaults above are overwritten by the loop where the request supplied them
     — `source` because a row typed on the advanced page may record where it
     really came from, `birth_precision` because 'year' is the honest answer for
     a date the registry only filed to the year. */
  for (const k of ALL_EDITABLE) {
    if (patch[k] === undefined) continue;
    // A parent link is a foreign key: '' is not "no parent", NULL is.
    cols[k] = (k === 'father_id' || k === 'mother_id') ? (patch[k] || null) : patch[k];
  }
  const names = Object.keys(cols);
  db.prepare(`INSERT INTO people (${names.join(',')},updated_at)
              VALUES (${names.map(() => '?').join(',')},strftime('%s','now'))`)
    .run(...names.map((k) => cols[k]));

  if (raw.spouse_id) {
    const sp = findPerson(raw.spouse_id);
    if (sp) linkUnion(db, id, sp.id, me.email);
  }
  // Unconditional here, unlike the edit path: a new row has no FKs at all, and
  // the call is a no-op when no life place was typed.
  syncPlaceIds(db, [id]);

  const row = findPerson(id);
  recordChange(db, {
    actor: me.email, actor_no: me.person?.person_no ?? null, kind: 'add',
    person_id: id, person_no: no, summary: `${name} נוסף/ה לעץ (#${no})`, after: patch,
  });
  res.audit = { ...(res.audit || {}), action: 'person.add', target: `person:${no}` };
  return json(res, 200, { person: publicPerson(db, row, { owner: me.owner }) });
}

async function editPerson(req, res, me, ref) {
  const before = findPerson(ref);
  if (!before || before.deleted_at) return json(res, 404, { error: 'לא נמצא' });
  const { patch, bad } = clean(await jsonBody(req));
  if (bad.length) return json(res, 400, { error: bad.map((b) => b[0]).join('; '), error_en: bad.map((b) => b[1]).join('; ') });

  for (const k of ['father_id', 'mother_id'])
    if (k in patch && wouldCycle(before.id, patch[k]))
      return json(res, 400, { error: 'הקישור הזה יוצר לולאה בעץ' });

  // An origin asserted on someone whose origin comes down from their parents is
  // not weighed against the parents and lost — recomputeOrigins never reads it.
  // Storing it would leave the row holding a value the tree does not use and the
  // page cannot show, so say no and name where the answer can be changed.
  //
  // Only when the parents are not themselves moving in this same request: a
  // re-parenting that detaches someone from their line and asserts an origin in
  // one go is coherent, and the recompute below settles which of the two wins.
  const reparenting = 'father_id' in patch || 'mother_id' in patch;
  if (!reparenting && ('origin_override' in patch || 'origin_override_note' in patch)
      && originIsDerived(before)) {
    const via = originSources(before).map((id) => findPerson(id)).filter(Boolean);
    const he = via.map((p) => p.name_he || p.id).join(' ו');
    const en = via.map((p) => p.name_en || p.name_he || p.id).join(' and ');
    // The English sentence takes the English name where there is one. label()
    // is the Hebrew record and is right for the Hebrew message; reading
    // "דנה לוי's origin" back to a relative in Toronto is not.
    const subjectEn = before.name_en || label(before);
    return json(res, 400, {
      error: `ארץ המקור של ${label(before)} מחושבת מההורים${he ? ` (${he})` : ''} — שנו אותה שם`,
      error_en: `${subjectEn}'s origin is derived from their parents${en ? ` (${en})` : ''} — change it there`,
      originFrom: originSources(before),
    });
  }

  // "Poland", "פולניה" and "פולין" are one country. Fold what was typed onto the
  // row the tree already draws, or open a row for a country it has never seen —
  // either way what lands in `people` is a key `origins` knows, so nothing
  // downstream has to cope with a country that has no name and no colour.
  if (patch.origin_override) patch.origin_override = canonicalOrigin(db, patch.origin_override);
  if (patch.birth_country) patch.birth_country = canonicalOrigin(db, patch.birth_country);

  const changed = {}, prev = {};
  for (const [k, v] of Object.entries(patch)) {
    const old = before[k] ?? '';
    /* `?? ''` on BOTH sides. `generation` is the one column that stores NULL
       for "not set", so clearing it sends null against a stored null — and
       String(null) is 'null' while `before[k] ?? ''` is '', which made every
       save of an unset generation look like a change and file a log entry
       saying a field had been updated from nothing to nothing. */
    if (String(old) === String(v ?? '')) continue;
    changed[k] = v; prev[k] = old;
  }
  if (!Object.keys(changed).length) return json(res, 200, { person: publicPerson(db, before, { owner: me.owner }), noop: true });

  const sets = Object.keys(changed).map((k) => `${k}=?`).join(', ');
  db.prepare(`UPDATE people SET ${sets}, updated_by=?, updated_at=strftime('%s','now') WHERE id=?`)
    .run(...Object.values(changed).map((v) => (v === '' ? '' : v)), me.email, before.id);
  renameIfNeeded(before.id, changed, before);
  /* The precision follows the shape of the date — unless the request said
     otherwise. The advanced page can state it outright, which is the only way
     to record "1938-01-01, but really only the year is known" — the registry's
     placeholder for an unknown day, and a date this derivation would otherwise
     keep re-labelling as exact on every save. */
  if ('birth_date' in changed && !('birth_precision' in patch))
    db.prepare('UPDATE people SET birth_precision=? WHERE id=?')
      .run(changed.birth_date ? (changed.birth_date.length === 4 ? 'year' : 'day') : '', before.id);
  markCurated(db, before.id, Object.keys(changed));

  // An origin the family asserts, a corrected birthplace, or a re-parenting all
  // change the ancestry of everyone BELOW this person, so re-derive the whole
  // tree rather than just this row. It is one in-memory pass over a few hundred
  // rows, which is cheaper than working out the affected subtree.
  let originRows = 0;
  if (ORIGIN_INPUTS.some((k) => k in changed)) originRows = recomputeOrigins(db);

  // Keep the life-place FKs in step with the text that was just typed. Only this
  // row: the ten-minute sweep catches anything a branch-import script wrote.
  if (LIFE_PLACE_FIELDS.some((k) => k in changed)) syncPlaceIds(db, [before.id]);

  recordChange(db, {
    actor: me.email, actor_no: me.person?.person_no ?? null, kind: 'edit',
    person_id: before.id, person_no: before.person_no,
    summary: `${label(before)} (#${before.person_no}) עודכן/ה: ${Object.keys(changed).map(heField).join(', ')}`
      + (originRows ? ` — ארץ מקור עודכנה ל-${originRows} אנשים` : ''),
    before: prev, after: changed,
  });
  res.audit = { ...(res.audit || {}), action: 'person.edit', target: `person:${before.person_no}`,
    detail: { fields: Object.keys(changed) } };
  return json(res, 200, { person: publicPerson(db, findPerson(before.id), { owner: me.owner }) });
}

async function deletePerson(req, res, me, ref) {
  const p = findPerson(ref);
  if (!p || p.deleted_at) return json(res, 404, { error: 'לא נמצא' });
  const kids = db.prepare('SELECT COUNT(*) c FROM people WHERE (father_id=? OR mother_id=?) AND deleted_at IS NULL').get(p.id, p.id).c;
  if (kids) return json(res, 400, {
    error: `לא ניתן למחוק — ${kids} ילדים מקושרים. נתקו אותם קודם.`,
    error_en: `Cannot delete — ${kids} children are still linked. Detach them first.`,
  });

  db.prepare("UPDATE people SET deleted_at=strftime('%s','now'), updated_by=? WHERE id=?").run(me.email, p.id);
  recordChange(db, {
    actor: me.email, actor_no: me.person?.person_no ?? null, kind: 'delete',
    person_id: p.id, person_no: p.person_no,
    summary: `${label(p)} (#${p.person_no}) הוסר/ה מהעץ`, before: { deleted_at: '' }, after: { deleted_at: 1 },
  });
  res.audit = { ...(res.audit || {}), action: 'person.delete', target: `person:${p.person_no}`, alert: true };
  return json(res, 200, { ok: true });
}

async function restorePerson(req, res, me, ref) {
  const p = findPerson(ref);
  if (!p) return json(res, 404, { error: 'לא נמצא' });
  db.prepare('UPDATE people SET deleted_at=NULL, updated_by=? WHERE id=?').run(me.email, p.id);
  recordChange(db, {
    actor: me.email, actor_no: me.person?.person_no ?? null, kind: 'restore',
    person_id: p.id, person_no: p.person_no, summary: `${label(p)} (#${p.person_no}) הוחזר/ה לעץ`,
  });
  return json(res, 200, { person: publicPerson(db, findPerson(p.id), { owner: me.owner }) });
}

// ── photos ───────────────────────────────────────────────────────────────────

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

async function addPhoto(req, res, me, ref) {
  const p = findPerson(ref);
  if (!p) return json(res, 404, { error: 'לא נמצא' });
  const ext = MIME_EXT[String(req.headers['content-type'] || '').split(';')[0].trim()];
  if (!ext) return json(res, 415, { error: 'רק JPEG, PNG, WebP או GIF' });
  let buf;
  try { buf = await body(req, 12 << 20); } catch { return json(res, 413, { error: 'התמונה גדולה מדי (מקסימום 12MB)' }); }
  if (buf.length < 100) return json(res, 400, { error: 'קובץ ריק' });

  const id = newPhotoId();
  fs.writeFileSync(path.join(PHOTO_DIR, `${id}.${ext}`), buf);
  const first = !db.prepare('SELECT 1 FROM photos WHERE person_id=? AND deleted_at IS NULL').get(p.id);
  db.prepare('INSERT INTO photos (id,person_id,ext,bytes,is_avatar,uploaded_by) VALUES (?,?,?,?,?,?)')
    .run(id, p.id, ext, buf.length, first ? 1 : 0, me.email);
  recordChange(db, {
    actor: me.email, actor_no: me.person?.person_no ?? null, kind: 'photo.add',
    person_id: p.id, person_no: p.person_no, summary: `תמונה נוספה ל${label(p)} (#${p.person_no})`,
    after: { photo: id },
  });
  res.audit = { ...(res.audit || {}), action: 'photo.add', target: `person:${p.person_no}` };
  return json(res, 200, { photo: { id, ext, is_avatar: first ? 1 : 0 } });
}

async function deletePhoto(req, res, me, id) {
  const row = db.prepare('SELECT * FROM photos WHERE id=? AND deleted_at IS NULL').get(id);
  if (!row) return json(res, 404, { error: 'לא נמצא' });
  db.prepare("UPDATE photos SET deleted_at=strftime('%s','now') WHERE id=?").run(id);
  const p = findPerson(row.person_id);
  // Losing the avatar should not leave the node blank when another photo exists.
  if (row.is_avatar) {
    const next = db.prepare('SELECT id FROM photos WHERE person_id=? AND deleted_at IS NULL ORDER BY uploaded_at LIMIT 1').get(row.person_id);
    if (next) db.prepare('UPDATE photos SET is_avatar=1 WHERE id=?').run(next.id);
  }
  recordChange(db, {
    actor: me.email, actor_no: me.person?.person_no ?? null, kind: 'photo.delete',
    person_id: row.person_id, person_no: p?.person_no ?? null,
    summary: `תמונה הוסרה מ${label(p)} (#${p?.person_no})`, before: { photo: id },
  });
  return json(res, 200, { ok: true });
}

// ── documents ────────────────────────────────────────────────────────────────
// Evidence. See the table comment in schema-service.sql for why these are not
// photos. Uploaded the same way photos are — raw body, the file's own content
// type, no multipart parser on either end — with the metadata in the query
// string, because the alternative is a boundary parser in a server that has no
// dependencies and never wanted one.

const docKind = (v) => (DOC_KINDS.includes(String(v || '').trim()) ? String(v).trim() : 'other');
const docText = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

async function addDocument(req, res, me, ref, url) {
  const p = findPerson(ref);
  if (!p) return json(res, 404, { error: 'לא נמצא' });
  const ext = DOC_EXT[String(req.headers['content-type'] || '').split(';')[0].trim()];
  if (!ext) {
    return json(res, 415, {
      error: 'רק PDF, JPEG, PNG, WebP, GIF, HEIC, TIFF, MP4 או טקסט',
      error_en: 'Only PDF, JPEG, PNG, WebP, GIF, HEIC, TIFF, MP4 or plain text',
    });
  }
  let buf;
  // 25MB rather than the photos' 12: a scanned certificate at 300dpi is bigger
  // than anything a phone camera produces, and re-scanning it is not something
  // a relative in an archive reading room can be asked to do.
  try { buf = await body(req, 25 << 20); } catch { return json(res, 413, { error: 'הקובץ גדול מדי (מקסימום 25MB)', error_en: 'That file is too large (25MB maximum)' }); }
  if (buf.length < 100) return json(res, 400, { error: 'קובץ ריק', error_en: 'Empty file' });

  const id = newDocumentId();
  const file = `${id}.${ext}`;
  fs.mkdirSync(DOC_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOC_DIR, file), buf);
  const q = url.searchParams;
  const doc = {
    id, person_id: p.id, file, ext, bytes: buf.length,
    title: docText(q.get('title'), 200), kind: docKind(q.get('kind')),
    note: docText(q.get('note'), 2000), source: docText(q.get('source'), 500),
  };
  db.prepare(`INSERT INTO documents (id,person_id,file,ext,bytes,title,kind,note,source,uploaded_by)
              VALUES ($id,$person_id,$file,$ext,$bytes,$title,$kind,$note,$source,$by)`)
    // Only $-prefixed keys: node:sqlite accepts bare names too, and handing it
    // both spellings of one parameter is an error rather than a convenience.
    .run({ $id: doc.id, $person_id: doc.person_id, $file: doc.file, $ext: doc.ext,
           $bytes: doc.bytes, $title: doc.title, $kind: doc.kind, $note: doc.note,
           $source: doc.source, $by: me.email });
  recordChange(db, {
    actor: me.email, actor_no: me.person?.person_no ?? null,
    /* Not a kind of its own. `changes.kind` carries a CHECK constraint and the
       table is append-only, so widening the list means rebuilding it — the same
       wall the family colour edits hit, and they took the same way round it.
       What makes this legible in the log is the payload, not the kind: `undo`
       branches on `after.document` before it reaches the generic edit case. */
    kind: 'edit', person_id: p.id, person_no: p.person_no,
    summary: `מסמך נוסף ל${label(p)} (#${p.person_no})${doc.title ? ' — ' + doc.title : ''}`,
    after: { document: id, document_title: doc.title, document_kind: doc.kind },
  });
  res.audit = { ...(res.audit || {}), action: 'document.add', target: `person:${p.person_no}` };
  return json(res, 200, { document: listDocuments(db, p.id).find((d) => d.id === id) });
}

/** Retitle, retag or annotate one. The bytes are never edited — only the label. */
async function editDocument(req, res, me, id) {
  const row = db.prepare('SELECT * FROM documents WHERE id=? AND deleted_at IS NULL').get(id);
  if (!row) return json(res, 404, { error: 'לא נמצא' });
  const b = await jsonBody(req).catch(() => ({}));
  const next = {
    title: b.title === undefined ? row.title : docText(b.title, 200),
    kind: b.kind === undefined ? row.kind : docKind(b.kind),
    note: b.note === undefined ? row.note : docText(b.note, 2000),
    source: b.source === undefined ? row.source : docText(b.source, 500),
  };
  const changed = Object.keys(next).filter((k) => next[k] !== row[k]);
  if (!changed.length) return json(res, 400, { error: 'אין מה לעדכן', error_en: 'Nothing to update' });
  db.prepare('UPDATE documents SET title=$title, kind=$kind, note=$note, source=$source WHERE id=$id')
    .run({ $title: next.title, $kind: next.kind, $note: next.note, $source: next.source, $id: id });
  const p = findPerson(row.person_id);
  recordChange(db, {
    actor: me.email, actor_no: me.person?.person_no ?? null, kind: 'edit',
    person_id: row.person_id, person_no: p?.person_no ?? null,
    summary: `פרטי מסמך עודכנו אצל ${label(p)} (#${p?.person_no})`,
    before: { document: id, ...Object.fromEntries(changed.map((k) => [`document_${k}`, row[k]])) },
    after: { document: id, ...Object.fromEntries(changed.map((k) => [`document_${k}`, next[k]])) },
  });
  return json(res, 200, { document: listDocuments(db, row.person_id).find((d) => d.id === id) });
}

/**
 * Unhang a document from a person.
 *
 * Soft, like a photo, and for a stronger reason: the bytes may be the only copy
 * of a record somebody drove to an archive for. The row is marked and the file
 * stays on disk — `undo` puts it straight back, and nothing in this service
 * ever unlinks a file in `documents/`.
 */
async function deleteDocument(req, res, me, id) {
  const row = db.prepare('SELECT * FROM documents WHERE id=? AND deleted_at IS NULL').get(id);
  if (!row) return json(res, 404, { error: 'לא נמצא' });
  db.prepare("UPDATE documents SET deleted_at=strftime('%s','now') WHERE id=?").run(id);
  const p = findPerson(row.person_id);
  recordChange(db, {
    actor: me.email, actor_no: me.person?.person_no ?? null, kind: 'edit',
    person_id: row.person_id, person_no: p?.person_no ?? null,
    summary: `מסמך הוסר מ${label(p)} (#${p?.person_no})${row.title ? ' — ' + row.title : ''}`,
    before: { document_deleted: id, document_title: row.title },
  });
  res.audit = { ...(res.audit || {}), action: 'document.delete', target: `person:${p?.person_no}` };
  return json(res, 200, { ok: true });
}

// ── families ─────────────────────────────────────────────────────────────────

/**
 * Recolour or rename a family.
 *
 * The colour is open to every relative, like every other edit in this app —
 * flat authorisation, protected by the log rather than by permissions. The
 * NAMES are not: they are shared vocabulary that the wiki and both languages of
 * the UI read off, so an accidental rename would show up in places the person
 * doing it never sees. Owner only, deliberately.
 */
async function editFamily(req, res, me, key) {
  const b = await jsonBody(req).catch(() => ({}));
  let fam = null;

  if (b.color !== undefined) {
    if (!isHex(b.color)) return json(res, 400, { error: 'צבע לא תקין', error_en: 'That is not a colour' });
    fam = setFamilyColor(db, key, b.color, me);
    if (!fam) return json(res, 404, { error: 'משפחה לא מוכרת', error_en: 'Unknown family' });
  }

  if (b.nameHe !== undefined || b.nameEn !== undefined) {
    if (!me.owner) return json(res, 403, { error: 'שינוי שם משפחה שמור לבעלים', error_en: 'Renaming a family is owner-only' });
    fam = setFamilyNames(db, key, b, me);
    if (!fam) return json(res, 404, { error: 'משפחה לא מוכרת', error_en: 'Unknown family' });
  }

  if (!fam) return json(res, 400, { error: 'אין מה לעדכן', error_en: 'Nothing to update' });
  res.audit = { ...(res.audit || {}), action: 'family.edit', target: `family:${key}` };
  return json(res, 200, { family: fam, families: listFamilies(db) });
}

// ── origins ──────────────────────────────────────────────────────────────────

/**
 * Name an origin, or place it in a region.
 *
 * Owner-only in full, and more firmly than a family rename: a family's name is
 * that family's to choose, but an origin's name appears on every relative's
 * legend in both languages, and its REGION is a claim about where a country
 * belongs that also decides its colour. Neither is a matter of taste.
 *
 * The colour is settable directly, but the ordinary path is to set the region
 * and let the ramp choose — that is what keeps two charts comparable.
 */
async function editOrigin(req, res, me, key) {
  if (!me.owner) {
    return json(res, 403, {
      error: 'עריכת ארץ מקור שמורה לבעלים',
      error_en: 'Editing a country of origin is owner-only',
    });
  }
  const b = await jsonBody(req).catch(() => ({}));
  const fields = ['nameHe', 'nameEn', 'region', 'step', 'color'];
  if (!fields.some((k) => b[k] !== undefined))
    return json(res, 400, { error: 'אין מה לעדכן', error_en: 'Nothing to update' });

  const origin = setOrigin(db, key, b, me);
  if (!origin) {
    return json(res, 400, {
      error: 'ארץ מקור לא מוכרת, או אזור/צבע לא תקין',
      error_en: 'Unknown origin, or an invalid region or colour',
    });
  }
  res.audit = { ...(res.audit || {}), action: 'origin.edit', target: `origin:${key}` };
  return json(res, 200, { origin, origins: listOrigins(db) });
}

// ── marriages ────────────────────────────────────────────────────────────────

function linkUnion(dbh, a, b, actor, status = 'married', start = '') {
  const [x, y] = a < b ? [a, b] : [b, a];
  dbh.prepare(`INSERT OR IGNORE INTO unions (a_id,b_id,status,start_date,created_by) VALUES (?,?,?,?,?)`)
    .run(x, y, status, start, actor);
  syncSpouseColumn(dbh, [x, y]);
  return dbh.prepare('SELECT * FROM unions WHERE a_id=? AND b_id=? AND start_date=?').get(x, y, start);
}

async function addUnion(req, res, me) {
  const b = await jsonBody(req);
  const A = findPerson(b.a), B = findPerson(b.b);
  if (!A || !B) return json(res, 400, { error: 'לא נמצא' });
  if (A.id === B.id) return json(res, 400, { error: 'אי אפשר לחתן אדם עם עצמו' });
  /* Constrained rather than passed through: `unions.status` has a CHECK, so an
     unrecognised string was a 500 from the depths of the driver instead of a
     message. The advanced editor is the first surface that lets a human type
     one. */
  const status = UNION_STATUS.includes(b.status) ? b.status : 'married';
  const u = linkUnion(db, A.id, B.id, me.email, status, b.start_date || '');
  recordChange(db, {
    actor: me.email, actor_no: me.person?.person_no ?? null, kind: 'union.add',
    person_id: A.id, person_no: A.person_no,
    summary: `${label(A)} (#${A.person_no}) ו${label(B)} (#${B.person_no}) קושרו כזוג`,
    after: { union: u?.id, status },
  });
  return json(res, 200, { union: u });
}

async function editUnion(req, res, me, id) {
  const u = db.prepare('SELECT * FROM unions WHERE id=?').get(id);
  if (!u) return json(res, 404, { error: 'לא נמצא' });
  const b = await jsonBody(req);
  const status = UNION_STATUS.includes(b.status) ? b.status : u.status;
  db.prepare('UPDATE unions SET status=?, start_date=?, end_date=?, notes=? WHERE id=?')
    .run(status, b.start_date ?? u.start_date, b.end_date ?? u.end_date, b.notes ?? u.notes, id);
  syncSpouseColumn(db, [u.a_id, u.b_id]);
  const A = findPerson(u.a_id), B = findPerson(u.b_id);
  recordChange(db, {
    actor: me.email, actor_no: me.person?.person_no ?? null, kind: 'union.edit',
    person_id: u.a_id, person_no: A?.person_no ?? null,
    summary: `הקשר בין ${label(A)} ל${label(B)} עודכן ל-${HE_STATUS[status] || status}`,
    before: { status: u.status }, after: { status },
  });
  return json(res, 200, { union: db.prepare('SELECT * FROM unions WHERE id=?').get(id) });
}

async function deleteUnion(req, res, me, id) {
  const u = db.prepare('SELECT * FROM unions WHERE id=?').get(id);
  if (!u) return json(res, 404, { error: 'לא נמצא' });
  db.prepare('DELETE FROM unions WHERE id=?').run(id);
  syncSpouseColumn(db, [u.a_id, u.b_id]);
  const A = findPerson(u.a_id), B = findPerson(u.b_id);
  recordChange(db, {
    actor: me.email, actor_no: me.person?.person_no ?? null, kind: 'union.delete',
    person_id: u.a_id, person_no: A?.person_no ?? null,
    summary: `הקשר בין ${label(A)} ל${label(B)} נמחק`,
    before: { a: u.a_id, b: u.b_id, status: u.status },
  });
  return json(res, 200, { ok: true });
}

/** The four values `unions.status` has a CHECK for, in the order a card lists
    them. Named here rather than written out at each use because there are now
    three: the validator below, the Hebrew labels beside it, and the picker the
    advanced editor draws from /api/people/:ref/raw. */
const UNION_STATUS = ['married', 'divorced', 'widowed', 'partners'];
const HE_STATUS = { married: 'נשואים', divorced: 'גרושים', widowed: 'אלמן/ה', partners: 'בני זוג' };

// ── undo ─────────────────────────────────────────────────────────────────────
// You may take back your own most recent change, and the owner may take back
// anyone's. Undo never rewrites history: it re-applies the previous values and
// appends a new `undo` entry saying so.

/* Which table each evidence change-log kind belongs to. Read by the undo branch
   and by the handlers below, so a new kind cannot be added in one and forgotten
   in the other. */
const EVIDENCE_TABLES = {
  fact: 'person_facts', question: 'research_questions',
  name: 'name_variants', citation: 'citations',
};

/* The nullish coalesce has to be on BOTH sides. Testing `String(v ?? '')` and
   then returning `String(v)` turns an absent value into the literal string
   "undefined" — invisible while every list lacked '', and a CHECK violation the
   moment one contained it. */
const oneOf = (v, list, dflt) => { const t = String(v ?? '').trim(); return list.includes(t) ? t : dflt; };
const txt = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
/* Not squashed like txt(): a fact's value and an event's note are the paragraphs
   that used to be wiki prose, and flattening their newlines would be the one
   place this migration lost formatting. */
const para = (v, n) => String(v ?? '').trim().slice(0, n);

/** Record an evidence mutation the way the undo branch expects to read it. */
function logEvidence(db, me, kind, person, payload) {
  recordChange(db, {
    actor: me.email, actor_no: me.person?.person_no ?? null, kind,
    person_id: person?.id ?? null, person_no: person?.person_no ?? null,
    summary: payload.summary,
    before: payload.before || {}, after: payload.after || {},
  });
}

const factPatch = (b) => ({
  kind: oneOf(b.kind, FACT_KINDS, 'other'),
  label_he: txt(b.label_he, 120), label_en: txt(b.label_en, 120),
  value_he: para(b.value_he, 4000), value_en: para(b.value_en, 4000),
  // When it happened, as a range. Distinct from `as_of`, which is when somebody
  // last CHECKED — the wiki's "stale-able as of" convention.
  start_date: txt(b.start_date, 10), end_date: txt(b.end_date, 10),
  start_precision: oneOf(b.start_precision, ['day', 'month', 'year', ''], ''),
  end_precision: oneOf(b.end_precision, ['day', 'month', 'year', ''], ''),
  place_text: txt(b.place_text, 200),
  as_of: txt(b.as_of, 20), source: txt(b.source, 300),
  confidence: oneOf(b.confidence, CONFIDENCE, 'confirmed'),
  details: para(b.details, 4000),
  sort_order: Number.isFinite(+b.sort_order) ? +b.sort_order : 0,
});

/* A place typed on a fact resolves the same way a birthplace does — through
   lifeCountry() and into one shared `places` row — so a fact in Carpineni and a
   birth in Carpineni are the same town and not two. */
const factPlaceId = (b) => (b.place_text ? resolvePlaceId(db, b.place_text, b.place_country || '') : null);

/* Who is in a fact, filtered to people who exist. The subject is NOT read from
   here — addFact/editFact write it themselves from the owning column, so a
   client that forgets to send it cannot detach a fact from its own person. */
function factPeople(b) {
  if (!Array.isArray(b.people)) return undefined;
  return b.people
    .map((x) => ({ person: findPerson(x?.person_id ?? x?.id ?? x), role: x?.role || 'subject' }))
    .filter((x) => x.person)
    .map((x) => ({ person_id: x.person.id, role: x.role }));
}

async function postFact(req, res, me, ref) {
  const p = findPerson(ref);
  if (!p || p.deleted_at) return json(res, 404, { error: 'לא נמצא' });
  const b = await jsonBody(req).catch(() => ({}));
  const patch = { ...factPatch(b), place_id: factPlaceId(b) };
  if (!patch.label_he && !patch.label_en) return json(res, 400, { error: 'צריך כותרת', error_en: 'A label is required' });
  const id = addFact(db, p.id, patch, me.email, factPeople(b) || []);
  logEvidence(db, me, 'fact.add', p, {
    summary: `פרט נוסף ל${label(p)} (#${p.person_no}) — ${patch.label_he || patch.label_en} (${patch.kind})`,
    after: { row: id, table: 'person_facts', label: patch.label_he || patch.label_en, kind: patch.kind },
  });
  res.audit = { ...(res.audit || {}), action: 'fact.add', target: `person:${p.person_no}` };
  return json(res, 200, { facts: listFacts(db, p.id) });
}

async function patchFact(req, res, me, id) {
  const row = db.prepare('SELECT * FROM person_facts WHERE id=? AND deleted_at IS NULL').get(+id);
  if (!row) return json(res, 404, { error: 'לא נמצא' });
  const p = findPerson(row.person_id);
  const b = await jsonBody(req).catch(() => ({}));
  const patch = factPatch({ ...row, ...b });
  // Only when the request actually carried a place: re-resolving from the row's
  // own text on every save would re-run the geocode lookup for nothing, and
  // would silently drop a place_id set by an import script that resolved it
  // against a spelling this lookup no longer finds.
  if (b.place_text !== undefined) patch.place_id = factPlaceId(b);
  const people = factPeople(b);
  const before = {}, after = {};
  for (const k of Object.keys(patch)) if (String(row[k] ?? '') !== String(patch[k])) { before[k] = row[k]; after[k] = patch[k]; }
  if (!Object.keys(after).length && !people) return json(res, 200, { facts: listFacts(db, row.person_id), noop: true });
  editFact(db, row.id, patch, people);
  logEvidence(db, me, 'fact.edit', p, {
    summary: `פרט עודכן אצל ${label(p)} (#${p.person_no}) — ${patch.label_he || patch.label_en}`
      + (people ? ` (${people.length} משתתפים)` : ''),
    before: { row: row.id, table: 'person_facts', fields: before },
    after: { row: row.id, fields: after },
  });
  return json(res, 200, { facts: listFacts(db, row.person_id) });
}

function removeFact(req, res, me, id) {
  const row = db.prepare('SELECT * FROM person_facts WHERE id=? AND deleted_at IS NULL').get(+id);
  if (!row) return json(res, 404, { error: 'לא נמצא' });
  const p = findPerson(row.person_id);
  deleteFact(db, row.id);
  logEvidence(db, me, 'fact.delete', p, {
    summary: `פרט הוסר מ${label(p)} (#${p.person_no}) — ${row.label_he || row.label_en}`,
    before: { row: row.id, table: 'person_facts', label: row.label_he || row.label_en },
  });
  return json(res, 200, { facts: listFacts(db, row.person_id) });
}

async function postCitation(req, res, me) {
  const b = await jsonBody(req).catch(() => ({}));
  const patch = {
    ref_name: txt(b.ref_name, 60).replace(/[^\w-]/g, ''),
    kind: oneOf(b.kind, CITATION_KINDS, 'other'),
    archive: txt(b.archive, 200), collection: txt(b.collection, 200), record_id: txt(b.record_id, 200),
    citation_he: para(b.citation_he, 4000), citation_en: para(b.citation_en, 4000),
    url: txt(b.url, 500), read_at: txt(b.read_at, 20),
  };
  if (!patch.citation_he && !patch.citation_en)
    return json(res, 400, { error: 'צריך טקסט מקור', error_en: 'The citation text is required' });
  const out = addCitation(db, patch, me.email);
  // The ref_name clash, surfaced as a refusal: two sources sharing one name
  // render as a red cite error on the wiki, so it is caught here not there.
  if (out.error) return json(res, 409, { error: 'שם המקור כבר תפוס', error_en: out.error });
  logEvidence(db, me, 'citation.add', null, {
    summary: `מקור נוסף: ${patch.ref_name || patch.citation_he || patch.citation_en}`.slice(0, 200),
    after: { row: out.id, table: 'citations' },
  });
  return json(res, 200, { citations: listCitations(db) });
}

/** Attach or detach a source. `supports: 0` is a contradicting source or a null search. */
async function postClaim(req, res, me) {
  const b = await jsonBody(req).catch(() => ({}));
  const subjectKind = txt(b.subject_kind, 60), subjectId = txt(b.subject_id, 80);
  if (!subjectKind || !subjectId) return json(res, 400, { error: 'חסר נושא', error_en: 'subject_kind and subject_id are required' });
  if (b.detach) {
    uncite(db, subjectKind, subjectId, +b.citation_id);
    return json(res, 200, { citations: citationsFor(db, subjectKind, subjectId) });
  }
  const c = db.prepare('SELECT id FROM citations WHERE id=? AND deleted_at IS NULL').get(+b.citation_id);
  if (!c) return json(res, 404, { error: 'מקור לא נמצא', error_en: 'No such citation' });
  citeClaim(db, {
    subjectKind, subjectId, citationId: c.id,
    supports: b.supports === 0 || b.supports === false ? 0 : 1,
    noteHe: para(b.note_he, 2000), noteEn: para(b.note_en, 2000),
  }, me.email);
  return json(res, 200, { citations: citationsFor(db, subjectKind, subjectId) });
}

/* `events` was retired on 2026-08-28: it duplicated person_facts, held zero
   rows for its whole life, and its shape — kind, a date range, a place row, a
   cast of people — is now on the table that has the data. See migrateFacts(). */

async function postFactLink(req, res, me, id) {
  const from = db.prepare('SELECT * FROM person_facts WHERE id=? AND deleted_at IS NULL').get(+id);
  if (!from) return json(res, 404, { error: 'לא נמצא' });
  const b = await jsonBody(req).catch(() => ({}));
  const to = db.prepare('SELECT * FROM person_facts WHERE id=? AND deleted_at IS NULL').get(+b.to_id);
  if (!to) return json(res, 400, { error: 'הפרט המקושר לא נמצא', error_en: 'No such fact to link to' });
  const relation = oneOf(b.relation, FACT_RELATIONS, 'see-also');
  const linkId = linkFacts(db, from.id, to.id, relation, txt(b.note, 500), me.email);
  if (!linkId) return json(res, 400, { error: 'אי אפשר לקשר פרט לעצמו', error_en: 'A fact cannot be linked to itself' });
  const p = findPerson(from.person_id);
  logEvidence(db, me, 'fact.edit', p, {
    summary: `פרט #${from.id} קושר ל-#${to.id} (${relation}) אצל ${label(p)}`,
    after: { row: from.id, table: 'person_facts', link: linkId, relation, to: to.id },
  });
  return json(res, 200, { facts: listFacts(db, from.person_id) });
}

function removeFactLink(req, res, me, id) {
  const row = db.prepare('SELECT * FROM fact_links WHERE id=?').get(+id);
  if (!row) return json(res, 404, { error: 'לא נמצא' });
  const from = db.prepare('SELECT * FROM person_facts WHERE id=?').get(row.from_id);
  unlinkFacts(db, row.id);
  const p = from ? findPerson(from.person_id) : null;
  logEvidence(db, me, 'fact.edit', p, {
    summary: `הקישור בין פרט #${row.from_id} ל-#${row.to_id} הוסר`,
    before: { row: row.from_id, table: 'person_facts', link: row.id, relation: row.relation, to: row.to_id },
  });
  return json(res, 200, { facts: from ? listFacts(db, from.person_id) : [] });
}

const questionPatch = (b) => ({
  question_he: para(b.question_he, 2000), question_en: para(b.question_en, 2000),
  candidate_he: para(b.candidate_he, 4000), candidate_en: para(b.candidate_en, 4000),
  next_step_he: para(b.next_step_he, 2000), next_step_en: para(b.next_step_en, 2000),
  status: oneOf(b.status, ['open', 'answered', 'refuted'], 'open'),
});

async function postQuestion(req, res, me, ref) {
  const p = findPerson(ref);
  if (!p || p.deleted_at) return json(res, 404, { error: 'לא נמצא' });
  const b = await jsonBody(req).catch(() => ({}));
  const patch = questionPatch(b);
  if (!patch.question_he && !patch.question_en) return json(res, 400, { error: 'צריך שאלה', error_en: 'A question is required' });
  const id = addQuestion(db, p.id, patch);
  logEvidence(db, me, 'question.add', p, {
    summary: `שאלת מחקר נוספה ל${label(p)} (#${p.person_no})`,
    after: { row: id, table: 'research_questions' },
  });
  return json(res, 200, { questions: listQuestions(db, p.id) });
}

async function patchQuestion(req, res, me, id) {
  const row = db.prepare('SELECT * FROM research_questions WHERE id=? AND deleted_at IS NULL').get(+id);
  if (!row) return json(res, 404, { error: 'לא נמצא' });
  const b = await jsonBody(req).catch(() => ({}));
  const patch = questionPatch({ ...row, ...b });
  const before = {}, after = {};
  for (const k of Object.keys(patch)) if (String(row[k] ?? '') !== String(patch[k])) { before[k] = row[k]; after[k] = patch[k]; }
  if (!Object.keys(after).length) return json(res, 200, { noop: true });
  editQuestion(db, row.id, patch);
  const p = findPerson(row.person_id);
  logEvidence(db, me, 'question.edit', p, {
    summary: `שאלת מחקר עודכנה${p ? ` אצל ${label(p)}` : ''}`,
    before: { row: row.id, table: 'research_questions', fields: before }, after: { row: row.id, fields: after },
  });
  return json(res, 200, { questions: listQuestions(db, row.person_id) });
}

function removeQuestion(req, res, me, id) {
  const row = db.prepare('SELECT * FROM research_questions WHERE id=? AND deleted_at IS NULL').get(+id);
  if (!row) return json(res, 404, { error: 'לא נמצא' });
  const p = findPerson(row.person_id);
  deleteQuestion(db, row.id);
  logEvidence(db, me, 'question.delete', p, {
    summary: `שאלת מחקר הוסרה${p ? ` מ${label(p)}` : ''}`,
    before: { row: row.id, table: 'research_questions' },
  });
  return json(res, 200, { questions: listQuestions(db, row.person_id) });
}

async function postNameVariant(req, res, me, ref) {
  const p = findPerson(ref);
  if (!p || p.deleted_at) return json(res, 404, { error: 'לא נמצא' });
  const b = await jsonBody(req).catch(() => ({}));
  const value = txt(b.value, 120);
  if (!value) return json(res, 400, { error: 'צריך שם', error_en: 'A name is required' });
  const id = addNameVariant(db, p.id, {
    value, script: txt(b.script, 20), lang: txt(b.lang, 10),
    record_system: txt(b.record_system, 60), note: txt(b.note, 500),
  });
  logEvidence(db, me, 'name.add', p, {
    summary: `שם נוסף ל${label(p)} (#${p.person_no}) — ${value}`,
    after: { row: id, table: 'name_variants' },
  });
  return json(res, 200, { names: listNameVariants(db, p.id) });
}

function removeNameVariant(req, res, me, id) {
  const row = db.prepare('SELECT * FROM name_variants WHERE id=? AND deleted_at IS NULL').get(+id);
  if (!row) return json(res, 404, { error: 'לא נמצא' });
  const p = findPerson(row.person_id);
  deleteNameVariant(db, row.id);
  logEvidence(db, me, 'name.delete', p, {
    summary: `שם הוסר מ${label(p)} — ${row.value}`,
    before: { row: row.id, table: 'name_variants' },
  });
  return json(res, 200, { names: listNameVariants(db, row.person_id) });
}

async function undo(req, res, me) {
  const b = await jsonBody(req).catch(() => ({}));
  const sql = me.owner && b.id
    ? 'SELECT * FROM changes WHERE id=? AND undone_by IS NULL'
    : 'SELECT * FROM changes WHERE actor=? AND undone_by IS NULL AND kind<>\'undo\' ORDER BY id DESC LIMIT 1';
  const e = me.owner && b.id ? db.prepare(sql).get(+b.id) : db.prepare(sql).get(me.email);
  if (!e) return json(res, 404, { error: 'אין שינוי לבטל' });
  if (!me.owner && e.actor !== me.email) return json(res, 403, { error: 'אפשר לבטל רק שינויים שלך' });

  const before = JSON.parse(e.before || '{}');
  const after = JSON.parse(e.after || '{}');
  const person = e.person_id ? db.prepare('SELECT * FROM people WHERE id=?').get(e.person_id) : null;

  if (e.kind === 'add' && person) {
    db.prepare("UPDATE people SET deleted_at=strftime('%s','now') WHERE id=?").run(person.id);
  } else if (e.kind === 'delete' && person) {
    db.prepare('UPDATE people SET deleted_at=NULL WHERE id=?').run(person.id);
  } else if (e.kind === 'edit' && (after.document || after.document_deleted || before.document_deleted)) {
    /* A document, which travels as an `edit` because `changes.kind` has a CHECK
       and the table is append-only — see addDocument(). Handled BEFORE the
       generic edit branch on purpose: a delete puts `document_deleted` in
       `before`, the generic branch would find no EDITABLE columns in it, do
       nothing at all, and still mark the change undone. A silent no-op is the
       one outcome an undo button must never have. */
    if (after.document && !before.document) {
      // An upload: unhang it. The bytes stay on disk, as they do for a delete.
      db.prepare("UPDATE documents SET deleted_at=strftime('%s','now') WHERE id=?").run(after.document);
    } else if (before.document_deleted) {
      db.prepare('UPDATE documents SET deleted_at=NULL WHERE id=?').run(before.document_deleted);
    } else if (before.document) {
      // A retitle/retag. Only the fields the entry actually recorded move back.
      const cols = ['title', 'kind', 'note', 'source'].filter((k) => `document_${k}` in before);
      if (cols.length) {
        db.prepare(`UPDATE documents SET ${cols.map((k) => `${k}=?`).join(', ')} WHERE id=?`)
          .run(...cols.map((k) => before[`document_${k}`]), before.document);
      }
    }
  } else if (e.kind === 'edit' && person && Object.keys(before).length) {
    const cols = Object.keys(before).filter((k) => ALL_EDITABLE.includes(k));
    if (cols.length) {
      db.prepare(`UPDATE people SET ${cols.map((k) => `${k}=?`).join(', ')}, updated_by=? WHERE id=?`)
        .run(...cols.map((k) => before[k]), me.email, person.id);
      renameIfNeeded(person.id, before, person);
    }
  } else if (e.kind === 'edit' && !e.person_id && before.family) {
    // A family recolour or rename. Without this branch the newest change in the
    // log would be one "undo my last change" cannot handle, and the button would
    // keep failing on it instead of reaching the person edit behind it.
    if (!restoreFamily(db, before.family, before)) {
      return json(res, 400, { error: 'משפחה לא מוכרת', error_en: 'Unknown family' });
    }
  } else if (e.kind === 'edit' && !e.person_id && before.origin) {
    // The same for an origin rename or re-placement, and for the same reason:
    // a log entry no undo branch handles is one the button gets stuck on.
    if (!restoreOrigin(db, before.origin, before)) {
      return json(res, 400, { error: 'ארץ מקור לא מוכרת', error_en: 'Unknown origin' });
    }
  } else if (EVIDENCE_TABLES[e.kind.split('.')[0]]) {
    /* Every evidence row — a fact, an event, a question, a name variant, a
       citation — undoes the same three ways, so this is one branch rather than
       fifteen. It has to exist at all for the reason the family and origin
       branches above do: "undo my last change" takes the NEWEST entry, and a
       kind no branch handles is one the button then gets stuck on forever. */
    const table = EVIDENCE_TABLES[e.kind.split('.')[0]];
    const verb = e.kind.split('.')[1];
    const row = after.row ?? before.row;
    if (!row) return json(res, 400, { error: 'סוג השינוי הזה לא ניתן לביטול אוטומטי' });
    if (verb === 'add') {
      db.prepare(`UPDATE ${table} SET deleted_at=strftime('%s','now') WHERE id=?`).run(row);
    } else if (verb === 'delete') {
      db.prepare(`UPDATE ${table} SET deleted_at=NULL WHERE id=?`).run(row);
    } else if (before.fields && Object.keys(before.fields).length) {
      const cols = Object.keys(before.fields);
      db.prepare(`UPDATE ${table} SET ${cols.map((k) => `${k}=?`).join(', ')} WHERE id=?`)
        .run(...cols.map((k) => before.fields[k]), row);
    } else {
      return json(res, 400, { error: 'סוג השינוי הזה לא ניתן לביטול אוטומטי' });
    }
  } else if (e.kind === 'photo.add') {
    const pid = JSON.parse(e.after || '{}').photo;
    if (pid) db.prepare("UPDATE photos SET deleted_at=strftime('%s','now') WHERE id=?").run(pid);
  } else if (e.kind === 'photo.delete') {
    const pid = JSON.parse(e.before || '{}').photo;
    if (pid) db.prepare('UPDATE photos SET deleted_at=NULL WHERE id=?').run(pid);
  } else {
    return json(res, 400, { error: 'סוג השינוי הזה לא ניתן לביטול אוטומטי' });
  }

  const newId = recordChange(db, {
    actor: me.email, actor_no: me.person?.person_no ?? null, kind: 'undo',
    person_id: e.person_id, person_no: e.person_no,
    summary: `בוטל: ${e.summary}`, before: JSON.parse(e.after || '{}'), after: before,
  });
  db.prepare('UPDATE changes SET undone_by=? WHERE id=?').run(newId, e.id);
  // The reverted edit no longer counts as a human choice, so the curated list
  // is rebuilt from what is left in the log rather than simply left alone.
  if (e.person_id) recomputeCurated(db, e.person_id);
  res.audit = { ...(res.audit || {}), action: 'change.undo', target: `change:${e.id}` };
  return json(res, 200, { ok: true, undone: e.id });
}

// ── static files ─────────────────────────────────────────────────────────────

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/* `type` overrides the extension-derived guess, for the one caller that knows
   better than the filename does: a document's content type comes off its DB row,
   because the eleven files registered where they already lay carry whatever
   suffix a researcher gave them and `.tif`/`.heic` are not in TYPES at all. */
function sendFile(res, file, cache = 'no-cache', type = '') {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': type || TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': cache, 'x-content-type-options': 'nosniff' });
    res.end(buf);
  });
}

/* ── how a page knows it is out of date ───────────────────────────────────────
 *
 * The service worker means a relative can be running a document that was
 * cached days ago, and a cached document that is BROKEN is the one state the
 * app cannot get itself out of: every reload serves the same stale copy, and
 * the page has no way to know. That cost a whole afternoon of "still broken"
 * screenshots on 2026-08-14, against a server that was serving the fix the
 * entire time.
 *
 * So each document is stamped, on the way out, with a hash of itself, and
 * `/api/build` says what the current stamps are. `/api/*` is network-only in
 * the worker, so that answer can never itself be stale. A page whose stamp does
 * not match drops the caches, unregisters the worker and reloads — once.
 *
 * Hashes are memoised on (size, mtime): a document is 300KB and this is on the
 * path of every page load.
 */
const buildCache = new Map();
function buildStamp(file) {
  try {
    const st = fs.statSync(file);
    const key = `${file}:${st.size}:${st.mtimeMs}`;
    const hit = buildCache.get(file);
    if (hit && hit.key === key) return hit.hash;
    const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
    buildCache.set(file, { key, hash });
    return hash;
  } catch { return ''; }
}

const DOC_FILES = { tree: 'tree-v2.html', map: 'map-v2.html', dna: 'ancestor-map.html',
  edit: 'edit.html' };

/**
 * A document, with its own stamp written into it.
 *
 * The placeholder is a `content=""` on a meta tag the page already carries, so
 * a document served by anything that does not know about this — a file server
 * in a dev loop, the service worker replaying a cached copy — still parses and
 * still runs; it just never finds itself stale, which is the safe direction.
 */
function sendDoc(res, name) {
  const file = path.join(PUBLIC, DOC_FILES[name]);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    const html = buf.toString('utf8').replace('name="x-build" content=""',
      `name="x-build" content="${buildStamp(file)}"`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(html);
  });
}

/* One of the DNA visualisation artifacts, by exact name.
 *
 * DNA_ASSETS is an allowlist, not a filter: the requested name must BE one of
 * these, so no user-supplied string ever reaches path.join and traversal is
 * impossible by construction rather than by escaping.
 */
const DNA_DIR = process.env.FAMILY_DNA_DIR || '';
const DNA_ASSETS = new Map([
  ['index.html', 'text/html; charset=utf-8'],
  ['pedigree-gaps.html', 'text/html; charset=utf-8'],
  ['ancestor-map.html', 'text/html; charset=utf-8'],
  ['dna-cloud.html', 'text/html; charset=utf-8'],
  ['dna-map.html', 'text/html; charset=utf-8'],
  ['_23-review.html', 'text/html; charset=utf-8'],
  ['FINDINGS.html', 'text/html; charset=utf-8'],
  ['FINDINGS.md', 'text/markdown; charset=utf-8'],
  ['leaflet.css', 'text/css; charset=utf-8'],
  ['leaflet.js', 'text/javascript; charset=utf-8'],
]);

function sendDnaAsset(res, name) {
  const type = DNA_ASSETS.get(name);
  if (!type) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  /* No directory configured means the feature is off. Checked here rather than
     left to path.join, which would turn '' into a RELATIVE lookup against the
     process's cwd and serve whatever happened to sit there. */
  if (!DNA_DIR) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  fs.readFile(path.join(DNA_DIR, name), (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': type,
      // Regenerated in place by 23-pedigree.mjs, so a cached copy goes stale
      // silently. Revalidate every time.
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      // These pages are gated; keep them out of any shared cache and out of
      // referrer headers pointing at 23andMe profile links.
      'referrer-policy': 'no-referrer',
    });
    res.end(buf);
  });
}

const FIELD_LABEL = {
  first_he: ['שם פרטי', 'given name'], last_he: ['שם משפחה', 'surname'],
  first_en: ['שם פרטי באנגלית', 'given name (English)'], last_en: ['שם משפחה באנגלית', 'surname (English)'],
  maiden_name: ['שם נעורים', 'maiden name'], sex: ['מין', 'sex'],
  birth_date: ['תאריך לידה', 'date of birth'], death_date: ['תאריך פטירה', 'date of death'],
  country: ['מדינה', 'country'],
  city: ['עיר', 'city'], street: ['רחוב', 'street'], house: ['מספר בית', 'house number'],
  occupation: ['עיסוק', 'occupation'],
  email: ['אימייל', 'email'], phone: ['טלפון', 'phone'],
  instagram: ['אינסטגרם', 'Instagram'], facebook: ['פייסבוק', 'Facebook'], linkedin: ['לינקדאין', 'LinkedIn'],
  father_id: ['אב', 'father'], mother_id: ['אם', 'mother'], notes: ['הערות', 'notes'],
  // Editable since origins arrived and unlabelled until now, so the change log
  // read "עודכן/ה: origin_override" — the column name, to a reader who has
  // never seen a column.
  origin_override: ['ארץ מקור', 'country of origin'],
  origin_override_note: ['מקור המידע על ארץ המקור', 'source for the country of origin'],
  birth_country: ['ארץ לידה', 'country of birth'],
  birth_city: ['עיר לידה', 'town of birth'],
  death_city: ['מקום פטירה', 'town of death'], death_country: ['ארץ פטירה', 'country of death'],
  burial_city: ['עיר הקבורה', 'town of burial'], burial_country: ['ארץ הקבורה', 'country of burial'],
  burial_place: ['בית העלמין', 'cemetery'], burial_plot: ['מיקום הקבר', 'grave location'],
  born_after_sunset: ['לידה אחרי השקיעה', 'born after sunset'],
  alma_mater: ['מוסד לימודים', 'alma mater'], interests: ['תחומי עניין', 'interests'],
  marital_status: ['מצב משפחתי', 'marital status'],
  children_complete: ['רשימת הילדים מלאה', 'children list complete'],
  /* The advanced columns. Unlabelled until the advanced page existed, which was
     survivable only because nothing could write them: the moment one can, the
     change log reads "עודכן/ה: no_sync" — a column name, to a reader who has
     never seen a column. Every writable field belongs in this table. */
  branch: ['ענף', 'branch'], generation: ['דור', 'generation'],
  source: ['מקורות', 'sources'], no_sync: ['ללא סנכרון מהמרשם', 'excluded from registry sync'],
  deceased: ['נפטר/ה', 'deceased'], dna_23andme: ['מזהה 23andMe', '23andMe profile'],
  lang: ['שפת ממשק', 'interface language'],
  birth_precision: ['דיוק תאריך הלידה', 'birth date precision'],
  wiki_title_he: ['דף הוויקי בעברית', 'Hebrew wiki page'],
  wiki_title_en: ['דף הוויקי באנגלית', 'English wiki page'],
};

/* ── the advanced editor's field spec ─────────────────────────────────────────
 *
 * What /api/people/:ref/raw hands over, and the only place the shape of that
 * page is described. The page renders whatever it is given and knows nothing
 * about columns: adding one to ADVANCED_EDITABLE and a line here is the whole
 * change, which is what keeps a new column from being accepted by the validator
 * and then invisible in the only UI that can reach it.
 *
 * `type` is how to draw it — text | textarea | int | bool | person | select.
 * `opts` supplies the choices for a select. Everything else takes its Hebrew
 * and English label from FIELD_LABEL above, so the form and the change log can
 * never disagree about what a field is called.
 */
const ADVANCED_GROUPS = [
  { key: 'identity', he: 'זהות', en: 'Identity',
    note_he: 'המפתחות שהעץ בנוי עליהם. רובם לקריאה בלבד.',
    note_en: 'The keys the tree is built on. Most are read-only.',
    fields: ['id', 'person_no', 'name_he', 'name_en', 'first_he', 'last_he',
             'first_en', 'last_en', 'maiden_name', 'sex', 'lang'] },
  { key: 'dates', he: 'תאריכים', en: 'Dates',
    note_he: '1988, או 1988-04, או 1988-04-12.',
    note_en: 'Write 1988, 1988-04 or 1988-04-12.',
    fields: ['birth_date', 'birth_precision', 'born_after_sunset', 'death_date', 'deceased'] },
  { key: 'links', he: 'הורים ובני זוג', en: 'Parents and spouses',
    note_he: 'בן/בת זוג נגזר מהקשרים שבתחתית העמוד, לא מכאן.',
    note_en: 'The spouse is derived from the unions at the foot of this page, not from here.',
    fields: ['father_id', 'mother_id', 'spouse_id'] },
  { key: 'structure', he: 'מבנה העץ', en: 'Tree structure',
    note_he: 'איך העץ מצייר את האדם הזה — הצבע, השורה, ומה שכתוב עליו בוויקי.',
    note_en: 'How the tree draws this person — the colour, the row, and what the wiki says about them.',
    fields: ['branch', 'generation', 'source', 'no_sync',
             'wiki_title_he', 'wiki_title_en', 'dna_23andme'] },
  { key: 'address', he: 'כתובת', en: 'Address',
    note_he: 'הכתובת הנוכחית — ריקה עבור מי שנפטר.',
    note_en: 'The current postal address — empty for anyone who has died.',
    fields: ['country', 'city', 'street', 'house'] },
  { key: 'life', he: 'מקומות בחיים', en: 'Life places',
    note_he: 'הארץ כאן היא שם, לא קוד: "בסרביה" ו"ברית המועצות" הן תשובות אמיתיות.',
    note_en: 'The country here is a name, not a code: "Bessarabia" and "the Soviet Union" are real answers.',
    fields: ['birth_city', 'birth_country', 'death_city', 'death_country',
             'burial_city', 'burial_country', 'burial_place', 'burial_plot'] },
  { key: 'origin', he: 'ארץ מקור', en: 'Origin',
    note_he: 'רק ההצהרה נכתבת ביד. השאר מחושב ממנה ומההורים.',
    note_en: 'Only the assertion is written by hand. The rest is derived from it and from the parents.',
    fields: ['origin_override', 'origin_override_note',
             'origin_country', 'origin_mix', 'origin_basis'] },
  { key: 'contact', he: 'פרטי קשר', en: 'Contact',
    fields: ['email', 'phone', 'instagram', 'facebook', 'linkedin'] },
  { key: 'about', he: 'על האדם', en: 'About',
    fields: ['occupation', 'alma_mater', 'interests', 'marital_status',
             'children_complete', 'notes'] },
  { key: 'registry', he: 'רשות האוכלוסין', en: 'Population registry',
    note_he: 'מה שהמרשם אמר, כלשונו. `family sync` כותב את השורות האלה מחדש בכל ריצה.',
    note_en: 'What the registry said, verbatim. `family sync` rewrites these on every run.',
    fields: ['tz', 'registry_name', 'registry_sex', 'registry_birth_date'] },
  { key: 'derived', he: 'שדות מחושבים', en: 'Derived',
    note_he: 'נכתבים אוטומטית. מוצגים כדי שאפשר יהיה לראות מה קרה, לא כדי לערוך.',
    note_en: 'Written automatically. Shown so you can see what happened, not so you can change it.',
    fields: ['birth_place_id', 'death_place_id', 'burial_place_id',
             'curated', 'last_seen_at', 'created_by', 'updated_by', 'updated_at'] },
];

/** How each column is drawn. Anything unlisted is a single-line text box. */
const FIELD_TYPE = {
  notes: 'textarea', origin_override_note: 'textarea', burial_plot: 'textarea',
  interests: 'textarea', curated: 'textarea', origin_mix: 'textarea',
  generation: 'int', person_no: 'int',
  birth_place_id: 'int', death_place_id: 'int', burial_place_id: 'int',
  born_after_sunset: 'bool', children_complete: 'bool', no_sync: 'bool', deceased: 'bool',
  father_id: 'person', mother_id: 'person', spouse_id: 'person',
  sex: 'select', lang: 'select', birth_precision: 'select',
  updated_at: 'time', last_seen_at: 'time',
};

const FIELD_OPTS = {
  sex: [['', '—'], ['M', 'זכר · male'], ['F', 'נקבה · female']],
  lang: [['', 'ברירת מחדל · default'], ['he', 'עברית · Hebrew'], ['en', 'אנגלית · English']],
  birth_precision: [['', '—'], ['day', 'יום · exact day'], ['year', 'שנה בלבד · year only']],
};

/** Never sent to anybody, at all. */
const NEVER = ['tz', 'google_sub'];

/**
 * Columns only the owner sees on this page.
 *
 * This page is open to every signed-in relative, which is the same rule the
 * rest of the app follows — but "every column" cannot mean a wider audience for
 * a column than the tree already gives it. publicPerson() stopped sending
 * `notes` to anyone at all precisely because it holds research working-out, and
 * roster.mjs shows what that looks like in practice: "ת.ז. 014961171 — not in
 * the 2006 snapshot". Shipping it here would hand every relative the ת.ז. that
 * NEVER above exists to withhold, by the back door.
 *
 * The rest are the same judgement publicPerson() already makes: the registry
 * mirrors and `origin_basis` are evidence about the research, and sit in its
 * `if (owner)` block. `dna_23andme` is a pointer at somebody's DNA profile and
 * is not sent to the tree by any path.
 *
 * Read-only-ness is decided separately, by ALL_EDITABLE. This list is about who
 * SEES the box at all.
 */
const OWNER_ONLY = ['notes', 'registry_name', 'registry_sex', 'registry_birth_date',
  'origin_basis', 'dna_23andme'];

/**
 * Every column of one person, with what may be written to it and why not.
 *
 * `tz` is the owner's explicit carve-out for this page and is not merely locked but
 * absent — a value you cannot see is one no bug in the form can echo back into
 * the DB — and `google_sub` is a sign-in credential, which is a stronger reason
 * for the same treatment.
 */
function advancedFields(p, { owner = false } = {}) {
  const out = [];
  for (const g of ADVANCED_GROUPS) {
    const fields = [];
    for (const k of g.fields) {
      if (NEVER.includes(k)) continue;
      if (!owner && OWNER_ONLY.includes(k)) continue;
      const lock = LOCKED[k];
      const editable = ALL_EDITABLE.includes(k);
      // A column in neither list and with no LOCKED entry is a column somebody
      // added to ADVANCED_GROUPS and nowhere else. Say so in the payload rather
      // than drawing an input that silently discards what is typed into it.
      const why = editable ? null : (lock || [heField(k), enField(k), '', '']);
      let value = p[k];
      if (value === null || value === undefined) value = '';
      fields.push({
        key: k, he: heField(k), en: enField(k),
        type: FIELD_TYPE[k] || 'text',
        opts: FIELD_OPTS[k] || null,
        advanced: ADVANCED_EDITABLE.includes(k),
        editable, value,
        lockHe: why ? (why[2] || '') : '', lockEn: why ? (why[3] || '') : '',
      });
    }
    // The registry group is nothing but ת.ז. and three sync mirrors on a person
    // who has no ת.ז.; drawing an empty card there is a question with no answer.
    if (fields.length) out.push({ key: g.key, he: g.he, en: g.en,
      noteHe: g.note_he || '', noteEn: g.note_en || '', fields });
  }
  return out;
}
/* FIELD_LABEL first, then LOCKED — whose entries start with the same [he, en]
   pair precisely so a read-only column needs its name written in one place and
   not two. Falling through to the column name is the last resort and shows up
   in the advanced editor as a field labelled `burial_place_id`, which is what
   scripts/advanced-edit-selftest.mjs checks for. */
function heField(k) { return (FIELD_LABEL[k] || LOCKED[k] || [k])[0]; }
function enField(k) { return (FIELD_LABEL[k] || LOCKED[k] || [k, k])[1] || k; }

// ── listen ───────────────────────────────────────────────────────────────────

const server = http.createServer(audit.wrapHttp('family', (req, res) => {
  handle(req, res).catch((err) => {
    console.error('[family]', req.method, req.url, err?.message || err);
    if (!res.headersSent) json(res, 500, { error: 'שגיאת שרת' });
  });
}));

// Loopback only: cloudflared reaches the app over 127.0.0.1, and this LXC has
// no firewall, so there is no reason for the LAN or the tailnet to see the port.
// Every request is still gated — by CF, by the session cookie, or by both,
// depending on AUTH_MODE and the hostname it arrived on.
server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  const hosts = AUTH.mode === 'both'
    ? `  live=${AUTH.liveHost}:cf  staging=${AUTH.stagingHost}:google`
    : '';
  console.log(`[family] listening on :${PORT}  owner=${OWNER}  auth=${AUTH.mode}${hosts}`);
});

for (const sig of ['SIGTERM', 'SIGINT'])
  process.on(sig, () => { server.close(() => { db.close(); process.exit(0); }); });
