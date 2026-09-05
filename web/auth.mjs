// Who is allowed into the family tree, and how they prove it.
//
// The rule this file exists to enforce is one sentence long: an email address
// grants access only because it sits on a person row in family.db. Everything
// else here — Google's OAuth dance, the cookie, the CF assertion — is only ever
// a way of learning *which* address is asking. resolve() is where the answer is
// turned into a yes or a no, and it is the only place that says yes.
//
// That mattered less when Cloudflare Access stood in front: the allow-list CF
// enforced was itself generated from the email column, so CF was silently doing
// the check the app assumed it was doing itself. With Google sign-in, any
// account on earth completes step one and arrives here. The check has to be
// real now.
//
// Three ways in, in the order resolve() tries them:
//
//   fam_sess cookie   a relative who signed in — with Google, or with a code
//                     sent to their WhatsApp
//   X-Family-Token    a script (the wiki renderer); a service actor, not a human
//   CF assertion      the old path, while AUTH_MODE still allows it
//
// AUTH_MODE picks which are live, and in `both` the choice is bound to the
// hostname: the live name accepts CF only, the staging name accepts the app's
// own sign-in only. Without that binding the ungated staging hostname would be
// a way to present a forged CF header to the same process and skip sign-in
// entirely.
//
// Google and WhatsApp are two doors into the same room, and the room is the
// same sentence as before: an email OR a phone number grants access only
// because it sits on a person row. The phone case is the stricter of the two —
// there is no owner bypass for a number, because the owner has a row.
//
// Which method is on is decided by whether its credentials are present, so a
// half-configured method is off rather than broken. `phone` is why this is
// worth having at all: 41 people in the tree have a mobile and 28 have an
// email, so the code path nobody has built yet is the one that reaches most of
// the family.

import crypto from 'node:crypto';

import { normEmail, normPhone, personByEmail, personByPhone } from '../lib/store.mjs';

export const SESS_COOKIE = 'fam_sess';
export const OAUTH_COOKIE = 'fam_oauth';
// Holds the id of an outstanding WhatsApp challenge. The id is a 128-bit secret
// and lives nowhere else — not in the URL, not in the form — which is what ties
// a code to the browser that asked for it.
export const OTP_COOKIE = 'fam_otp';

// The dev token grants owner-level reads to whatever holds the file on disk.
// It is not a person and must not borrow the operator's name in the change log,
// or a year from now nobody can tell which edits a human actually made.
export const SERVICE_ACTOR = 'service:family-dev-token';

const DAY = 86400e3;
const SESSION_TTL_MS = 30 * DAY;   // how long a cookie is good for
const SESSION_MAX_MS = 90 * DAY;   // and how long it may be rolled forward
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISS = new Set(['https://accounts.google.com', 'accounts.google.com']);

const MODES = new Set(['cf', 'both', 'google']);

// ── configuration ────────────────────────────────────────────────────────────

/**
 * Read the auth configuration, or throw. Throwing is the point: a missing
 * client secret must stop the service at boot, exactly as a missing
 * CF_ACCESS_AUD does, rather than quietly leaving a door open. systemd will
 * report the reason and not restart into a half-configured gate.
 */
export function loadAuthConfig(env = process.env) {
  const mode = String(env.AUTH_MODE || 'cf').trim().toLowerCase();
  if (!MODES.has(mode)) throw new Error(`AUTH_MODE must be one of ${[...MODES].join(' | ')} (got ${mode})`);

  const cfg = {
    mode,
    owner: normEmail(env.FAMILY_OWNER_EMAIL || ''),
    cfTeamDomain: String(env.CF_ACCESS_TEAM_DOMAIN || '').trim(),
    cfAud: String(env.CF_ACCESS_AUD || '').trim(),
    clientId: String(env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: String(env.GOOGLE_CLIENT_SECRET || '').trim(),
    otpUrl: String(env.FAMILY_OTP_URL || '').trim(),
    otpToken: String(env.FAMILY_OTP_TOKEN || '').trim(),
    sessionKey: String(env.FAMILY_SESSION_KEY || '').trim(),
    liveHost: String(env.FAMILY_LIVE_HOST || '').trim().toLowerCase(),
    /* Who a stuck relative is told to go to. A name, not the address: the hint
       is read by people who know the person, and the mailbox is already in
       `owner`. Configurable because this source is public. */
    ownerNameHe: String(env.FAMILY_OWNER_NAME_HE || 'מנהל האתר').trim(),
    ownerNameEn: String(env.FAMILY_OWNER_NAME_EN || 'the site owner').trim(),
    stagingHost: String(env.FAMILY_STAGING_HOST || '').trim().toLowerCase(),
    sessionTtlMs: SESSION_TTL_MS,
    sessionMaxMs: SESSION_MAX_MS,
  };

  /* There is no default owner. A wrong one is worse than none: it would hand
     the owner's powers to whatever address happened to be compiled in. */
  if (!cfg.owner) throw new Error('FAMILY_OWNER_EMAIL must be set (the owner account)');

  // A method is on when its own credentials are present, and off otherwise. Half
  // of one is neither: a client id with no secret is a typo, not a decision.
  if (Boolean(cfg.clientId) !== Boolean(cfg.clientSecret))
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together');
  if (Boolean(cfg.otpUrl) !== Boolean(cfg.otpToken))
    throw new Error('FAMILY_OTP_URL and FAMILY_OTP_TOKEN must be set together');
  cfg.google = Boolean(cfg.clientId && cfg.clientSecret);
  cfg.whatsapp = Boolean(cfg.otpUrl && cfg.otpToken);

  if (cfg.whatsapp && !/^https?:\/\//i.test(cfg.otpUrl))
    throw new Error('FAMILY_OTP_URL must be an http(s) URL (the nanoclaw /webhook/family-otp endpoint)');

  if (mode !== 'google' && !(cfg.cfTeamDomain && cfg.cfAud))
    throw new Error(`AUTH_MODE=${mode} needs CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD`);
  if (mode !== 'cf') {
    // One door is enough, and it no longer has to be Google's: WhatsApp codes
    // need no GCP project, so the cutover off Cloudflare Access is not blocked
    // on one.
    if (!cfg.google && !cfg.whatsapp)
      throw new Error(`AUTH_MODE=${mode} means this app owns sign-in, so it needs at least one`
        + ' method: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET, or FAMILY_OTP_URL + FAMILY_OTP_TOKEN');
    // 32 bytes. A short key is worse than none, because it looks configured.
    if (!/^[0-9a-f]{64}$/i.test(cfg.sessionKey))
      throw new Error('FAMILY_SESSION_KEY must be 32 random bytes as 64 hex characters'
        + ' (openssl rand -hex 32)');
  } else if (cfg.whatsapp) {
    // Refusing to start is the point. In `cf` mode Cloudflare Access gates every
    // hostname, so a relative with a phone and no allow-listed email cannot
    // reach a login page to ask for a code — the method would be configured,
    // billed for, and unreachable, which is exactly the silent half-on state
    // this function exists to prevent.
    throw new Error('AUTH_MODE=cf gates every hostname at the Cloudflare edge, so WhatsApp'
      + ' sign-in would be unreachable. Unset FAMILY_OTP_URL/FAMILY_OTP_TOKEN, or move to'
      + ' AUTH_MODE=both (staging hostname) or google.');
  }
  if (mode === 'both' && !cfg.stagingHost)
    throw new Error('AUTH_MODE=both needs FAMILY_STAGING_HOST — the whole point of `both` is'
      + ' that CF and Google are bound to different hostnames');
  if (cfg.stagingHost && cfg.stagingHost === cfg.liveHost)
    throw new Error('FAMILY_STAGING_HOST must differ from FAMILY_LIVE_HOST');

  return cfg;
}

/** The hostname this request was addressed to, lowercased and without the port. */
export function hostOf(req) {
  const h = String(req.headers?.host || '').trim().toLowerCase();
  return h.replace(/:\d+$/, '');
}

/**
 * Which credentials this hostname accepts. In `both` the live name keeps
 * working through CF exactly as it does today and the staging name — which has
 * no Access app in front of it — is the only one that will look at a session
 * cookie or a CF header. Neither name accepts both, so the untested path can
 * never be a way around the tested one.
 *
 * `session` is the load-bearing one: it says this hostname is gated by the app
 * rather than by the edge, and it is what decides whether a `fam_sess` cookie
 * is even looked at. Google and WhatsApp are the two ways to *obtain* such a
 * cookie, so both are subordinate to it — a hostname CF gates must not accept
 * an app-issued session no matter which method minted it.
 */
export function methodsFor(cfg, host) {
  const appOwned = cfg.mode === 'google' || (cfg.mode === 'both' && host === cfg.stagingHost);
  return {
    cf: !appOwned,
    session: appOwned,
    google: appOwned && Boolean(cfg.google),
    whatsapp: appOwned && Boolean(cfg.whatsapp),
  };
}

/** Where Google sends the browser back. Never taken from an unknown Host header. */
export function redirectUri(cfg, host) {
  if (host !== cfg.liveHost && (!cfg.stagingHost || host !== cfg.stagingHost)) return '';
  return `https://${host}/auth/callback`;
}

// ── cookies ──────────────────────────────────────────────────────────────────

export function cookies(req) {
  const out = {};
  for (const part of String(req.headers?.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

/**
 * No Domain attribute, deliberately. A host-only cookie cannot be sent to
 * another sibling hostname by construction, so two hundred relatives
 * holding one of these can never reach the internal estate — which is the whole
 * reason this service signs its own sessions instead of reusing homelab-auth.
 */
function cookieHeader(name, value, { maxAge, path = '/' }) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'Secure', 'SameSite=Lax'];
  // Lax, not Strict: the browser arrives at /auth/callback as a top-level
  // navigation from Google, and Strict would withhold the cookie exactly there.
  bits.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return bits.join('; ');
}

export function setCookie(res, name, value, opts) {
  const prev = res.getHeader('set-cookie');
  const list = prev == null ? [] : (Array.isArray(prev) ? [...prev] : [String(prev)]);
  list.push(cookieHeader(name, value, opts));
  res.setHeader('set-cookie', list);
}

export const clearCookie = (res, name, path = '/') => setCookie(res, name, '', { maxAge: 0, path });

// ── signing ──────────────────────────────────────────────────────────────────

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function sign(key, payload) {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`;
}

/**
 * The payload of a token this key signed, or null. Every rejection is a null —
 * a truncated cookie, a flipped byte and a value that is not a token at all are
 * all simply "not signed in". In particular the length is checked before
 * timingSafeEqual, which throws on unequal buffers and would otherwise turn a
 * garbage cookie into a 500.
 */
export function unsign(key, token) {
  if (typeof token !== 'string' || !token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  let got;
  try { got = Buffer.from(token.slice(dot + 1), 'base64url'); } catch { return null; }
  const want = crypto.createHmac('sha256', key).update(body).digest();
  if (got.length !== want.length) return null;
  if (!crypto.timingSafeEqual(got, want)) return null;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

// ── the session ──────────────────────────────────────────────────────────────

/**
 * The payload carries the credential, not the person — the person is looked up
 * again on every request. That is what makes revocation instant and
 * storage-free: clear an address or a number off a person row and the next
 * request that cookie makes is refused, with no session table to sweep and no
 * revocation list to keep.
 *
 * Which credential depends on how they signed in, and the cookie says so (`k`).
 * A WhatsApp session stores the *phone*, not the email it happened to resolve
 * to at login, precisely so that revocation keeps working: storing the email
 * would let someone whose number had been removed carry on through the address
 * still on the row.
 *
 * `sub` rides along so the pin can be re-checked per request rather than only at
 * login; `iat` is the original sign-in and never moves, so rolling the cookie
 * forward cannot outrun the absolute cap.
 */
export function readSession(cfg, req) {
  const p = unsign(cfg.sessionKey, cookies(req)[SESS_COOKIE]);
  if (!p) return null;
  // Cookies minted before WhatsApp existed carry no kind and are Google's.
  const kind = p.k === 'whatsapp' ? 'whatsapp' : 'google';
  const email = normEmail(p.e);
  const phone = normPhone(p.p);
  const now = Date.now();
  if (!(kind === 'whatsapp' ? phone : email)) return null;
  if (!(typeof p.exp === 'number' && p.exp > now)) return null;
  if (!(typeof p.iat === 'number' && p.iat > 0 && now - p.iat <= cfg.sessionMaxMs)) return null;
  return { email, phone, kind, sub: typeof p.sub === 'string' ? p.sub : '', iat: p.iat, exp: p.exp };
}

export function issueSession(cfg, res, { email = '', phone = '', kind = 'google', sub = '', iat = Date.now() }) {
  const exp = Date.now() + cfg.sessionTtlMs;
  setCookie(res, SESS_COOKIE,
    sign(cfg.sessionKey, { e: normEmail(email), p: normPhone(phone), k: kind, sub, iat, exp }),
    // The cookie's own lifetime is capped by how much of the absolute window is
    // left, so the browser stops presenting one the server would refuse anyway.
    { maxAge: Math.min(cfg.sessionTtlMs, iat + cfg.sessionMaxMs - Date.now()) / 1000 });
}

/** Refresh once past the half-life, so an active relative is never logged out. */
function maybeRoll(cfg, res, sess) {
  if (sess.exp - Date.now() > cfg.sessionTtlMs / 2) return;
  if (Date.now() - sess.iat > cfg.sessionMaxMs - 60e3) return;   // the cap is the cap
  issueSession(cfg, res, sess);
}

// ── Cloudflare Access ────────────────────────────────────────────────────────

/**
 * A CF assertion is only ever accepted after its RS256 signature verifies
 * against the team JWKS and the audience matches ours. "The header is present"
 * is not a check: cloudflared and anything else that reaches :3011 arrive from
 * the same loopback address, so presence proves nothing about who sent it.
 */
export function makeCfVerifier(cfg, { fetchImpl = fetch } = {}) {
  let jwks = { keys: [], at: 0 };

  async function keys(force) {
    if (!force && jwks.keys.length && Date.now() - jwks.at < 3600e3) return jwks.keys;
    try {
      const j = await fetchImpl(`https://${cfg.cfTeamDomain}/cdn-cgi/access/certs`).then((r) => r.json());
      if (Array.isArray(j.keys)) jwks = { keys: j.keys, at: Date.now() };
    } catch { /* keep stale keys rather than locking the family out on a blip */ }
    return jwks.keys;
  }

  return async function verifyCf(token) {
    if (!token || !cfg.cfTeamDomain || !cfg.cfAud) return null;
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    let header, payload;
    try { header = decodeJwtPart(parts[0]); payload = decodeJwtPart(parts[1]); } catch { return null; }
    if (!header || !payload || header.alg !== 'RS256') return null;
    const jwk = (await keys()).find((k) => k.kid === header.kid)
      || (await keys(true)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    let pub;
    try { pub = crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { return null; }
    let ok = false;
    try {
      ok = crypto.createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`)
        .verify(pub, Buffer.from(parts[2], 'base64url'));
    } catch { return null; }
    if (!ok) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(cfg.cfAud)) return null;
    if (payload.iss !== `https://${cfg.cfTeamDomain}`) return null;
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    const email = normEmail(payload.email || payload.identity || '');
    return email ? { email } : null;
  };
}

export function decodeJwtPart(part) {
  return JSON.parse(Buffer.from(String(part), 'base64url').toString('utf8'));
}

// ── Google ───────────────────────────────────────────────────────────────────

/**
 * The id_token comes back over a direct TLS connection to Google's token
 * endpoint rather than through the browser, so its signature is not the thing
 * standing between us and a forgery — the TLS session is. The claims still have
 * to be checked, and all four of these matter: `aud` because a token minted for
 * some other app is not a login here, `iss` and `exp` for the obvious reasons,
 * and `email_verified` because an unverified address is a claim, not an
 * identity.
 */
export function verifyIdToken(cfg, idToken, now = Date.now()) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return null;
  let c;
  try { c = decodeJwtPart(parts[1]); } catch { return null; }
  if (!c || typeof c !== 'object') return null;
  if (!GOOGLE_ISS.has(c.iss)) return null;
  if (c.aud !== cfg.clientId) return null;
  if (!(typeof c.exp === 'number' && c.exp * 1000 > now)) return null;
  if (c.email_verified !== true && c.email_verified !== 'true') return null;
  const email = normEmail(c.email);
  const sub = String(c.sub || '');
  if (!email || !sub) return null;
  return { email, sub, name: String(c.name || '') };
}

export function authorizeUrl(cfg, { host, state, verifier }) {
  const u = new URL(GOOGLE_AUTH);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', redirectUri(cfg, host));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
  u.searchParams.set('code_challenge_method', 'S256');
  // Relatives share devices. Landing straight into whichever account the phone
  // happens to be signed into is how someone edits the tree as their spouse.
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

/** Same-origin paths only, so `rd` cannot be turned into an open redirect. */
export function safeRd(rd) {
  const s = typeof rd === 'string' ? rd : '';
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\')) return '/';
  if (s.startsWith('/auth/')) return '/';     // never bounce back into the login dance
  return s;
}

// ── denial bookkeeping ───────────────────────────────────────────────────────

/**
 * A cheap in-process brake on the callback, which is internet-facing once CF
 * Access is gone. It is not a security boundary — the edge rate-limit is — but
 * it keeps a bot loop from burying the one alert that matters under a thousand
 * identical ones. Keyed on CF-Connecting-IP, which is trustworthy here because
 * only the tunnel can reach the port.
 */
export function makeBanList({ hits = 5, windowMs = 15 * 60e3, banMs = 60 * 60e3 } = {}) {
  const seen = new Map();

  const prune = (now) => {
    for (const [ip, v] of seen) if (now > v.until && now - v.first > windowMs) seen.delete(ip);
  };

  return {
    banned(ip) {
      if (!ip) return false;
      const v = seen.get(ip);
      return !!v && Date.now() < v.until;
    },
    strike(ip) {
      if (!ip) return false;
      const now = Date.now();
      if (seen.size > 500) prune(now);
      const v = seen.get(ip);
      if (!v || now - v.first > windowMs) { seen.set(ip, { n: 1, first: now, until: 0 }); return false; }
      v.n += 1;
      if (v.n >= hits) { v.until = now + banMs; v.first = now; v.n = 0; return true; }
      return false;
    },
    clear(ip) { seen.delete(ip); },
    get size() { return seen.size; },
  };
}

// ── the answer ───────────────────────────────────────────────────────────────

/**
 * Turn a verified credential into an identity, or into null.
 *
 * The two lines that matter are the person lookup and the refusal beneath it.
 * Every caller downstream tolerates `person: null` through optional chaining —
 * `me.person?.person_no ?? null` — so a credential admitted without a person row
 * would read and edit the entire tree as nobody in particular.
 */
export function resolveIdentity(db, cfg, { email = '', phone = '', sub = '', kind }) {
  if (kind === 'whatsapp') return resolveByPhone(db, cfg, phone);

  const me = personByEmail(db, email);

  // An address grants access only because it is attached to a person in the
  // tree. Without this, any Google account on earth arrives here and is let in.
  if (!me && email !== cfg.owner) return { ok: false, reason: 'unknown_account', email };

  // A pinned Google account is the one that may use this address from now on.
  // Email is reassignable; `sub` is not.
  if (kind === 'google' && me && me.google_sub && sub && me.google_sub !== sub)
    return { ok: false, reason: 'sub_mismatch', email, person: me };

  return { ok: true, identity: { email, owner: email === cfg.owner, person: me || null, kind } };
}

/**
 * The same rule for the other credential, with one deliberate difference: there
 * is no owner bypass. The email bypass exists so a misconfigured `people` table
 * cannot lock the operator out of their own service; a phone number that
 * belongs to no row is simply not a relative, and admitting one would be the
 * `person: null` hole this whole file is here to keep shut.
 *
 * `identity.email` is what the change log records as the actor, and it must
 * never be empty — `undo` compares `change.actor` against it, and rows written
 * by scripts have an empty actor, so an identity with `email: ''` would be able
 * to undo them. A relative who has an address gets it, so signing in by phone
 * and by Google produce the same actor for the same person; one who has none
 * gets their permanent person number, which is public, stable, and not their
 * phone number in an append-only log.
 */
function resolveByPhone(db, cfg, phone) {
  const p = normPhone(phone);
  const me = p ? personByPhone(db, p) : null;
  if (!me) return { ok: false, reason: 'unknown_number', phone: p };

  const email = normEmail(me.email);
  const actor = email || (me.person_no ? `person:${me.person_no}` : `phone:${p}`);
  return { ok: true, identity: { email: actor, phone: p, owner: email === cfg.owner, person: me, kind: 'whatsapp' } };
}

/**
 * Record which Google account this person signs in with, the first time they do.
 *
 * If the same account is already pinned to a different row the pin is moved
 * rather than refused: that only happens when an address was moved from one
 * person to another by hand, and the sub↔email binding the pin exists to
 * enforce is checked separately, above.
 */
export function pinGoogleSub(db, person, sub) {
  if (!person || !sub || person.google_sub === sub) return false;
  db.prepare("UPDATE people SET google_sub='' WHERE google_sub=? AND id<>?").run(sub, person.id);
  db.prepare('UPDATE people SET google_sub=? WHERE id=?').run(sub, person.id);
  return true;
}

export { maybeRoll };
