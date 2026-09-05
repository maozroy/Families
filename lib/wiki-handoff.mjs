// The bridge that lets a relative signed in at the family site read
// the wiki without either service learning the other's cookie.
//
// Why a handoff at all. The `fam_sess` cookie is host-only on purpose — see the
// comment over cookieHeader() in web/auth.mjs: a host-only cookie cannot be
// sent to another sibling hostname by construction, which is the single
// property that makes it safe to hand one to two hundred relatives while the
// internal estate sits on the same parent domain. Adding `Domain=` to reach the
// wiki would throw that away for every service at once. So instead the tree
// mints a one-shot, short-lived, audience-bound token, and the wiki exchanges
// it for a host-only cookie of its own. Two cookies, neither one portable.
//
// The signing key is DERIVED from FAMILY_SESSION_KEY rather than being a new
// secret to distribute and rotate. Both sides compute it from a file they can
// already read, and rolling FAMILY_SESSION_KEY — the documented lever for
// invalidating every session at once — invalidates outstanding handoffs too,
// which is the behaviour you want from that lever.
//
// It is derived, not reused, so that a token leaked out of a redirect chain (a
// URL, therefore a referer, a proxy log and browser history) can never be
// presented back to the tree as a session.

import crypto from 'node:crypto';

/** Sixty seconds is a redirect, not a session. */
export const HANDOFF_TTL_MS = 60e3;

export const HANDOFF_AUD = 'wiki';

/**
 * A distinct key per purpose, from the one secret both services already hold.
 * The label is versioned: changing it is how you'd cut over to a new derivation
 * without a flag day, since an old token simply stops verifying.
 */
export function handoffKey(sessionKey) {
  const k = String(sessionKey || '').trim();
  if (!k) throw new Error('wiki-handoff: empty session key');
  return crypto.createHmac('sha256', k).update('wiki-handoff-v1').digest();
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Same wire format as web/auth.mjs's sign(): `<body>.<mac>`, both base64url.
 * Deliberately identical so there is one shape to reason about, and reimplemented
 * here rather than imported so this module stays loadable by the wiki gate
 * without dragging in the tree's auth configuration and its boot-time validation.
 */
export function signHandoff(key, payload) {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`;
}

/**
 * The payload this key signed, or null. Every rejection is a null: a truncated
 * token, a flipped byte, an expired one and a value that is not a token at all
 * are all just "not signed in". Length is compared before timingSafeEqual,
 * which throws on unequal buffers and would otherwise turn a garbage query
 * parameter into a 500.
 */
export function verifyHandoff(key, token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  let got;
  try { got = Buffer.from(token.slice(dot + 1), 'base64url'); } catch { return null; }
  const want = crypto.createHmac('sha256', key).update(body).digest();
  if (got.length !== want.length) return null;
  if (!crypto.timingSafeEqual(got, want)) return null;

  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!p || typeof p !== 'object') return null;

  // Audience is checked here and not by the caller, because forgetting to check
  // it is exactly how a token minted for one relying party gets replayed at
  // another. There is one audience today; the check is what keeps adding a
  // second one safe.
  if (p.aud !== HANDOFF_AUD) return null;
  if (!(typeof p.exp === 'number' && p.exp > now)) return null;

  // A handoff must not outlive the session that authorised it, even if this
  // token is presented inside its own sixty seconds.
  if (!(typeof p.sexp === 'number' && p.sexp > now)) return null;

  const kind = p.k === 'whatsapp' ? 'whatsapp' : 'google';
  return {
    email: String(p.e || ''),
    phone: String(p.p || ''),
    kind,
    sub: typeof p.sub === 'string' ? p.sub : '',
    iat: typeof p.iat === 'number' ? p.iat : 0,
    sexp: p.sexp,
  };
}

/**
 * What the tree puts in the redirect. `sexp` carries the authorising session's
 * own expiry so the wiki can cap its cookie by it rather than inventing a
 * lifetime the tree never granted.
 */
export function mintHandoff(key, sess, { now = Date.now() } = {}) {
  return signHandoff(key, {
    aud: HANDOFF_AUD,
    e: sess.email || '',
    p: sess.phone || '',
    k: sess.kind === 'whatsapp' ? 'whatsapp' : 'google',
    sub: sess.sub || '',
    iat: sess.iat || now,
    sexp: sess.exp,
    exp: now + HANDOFF_TTL_MS,
  });
}
