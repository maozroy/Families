// The WhatsApp half of sign-in: a six-digit code, and what it is allowed to buy.
//
// The code itself is the weakest credential in this service — six digits, and
// the only thing between a guesser and a relative's account. Everything here is
// arranged around making guessing not work:
//
//   * the code is never stored, only an HMAC of it under the session key, so a
//     heap dump or a stray log line is not a login;
//   * a challenge dies after five wrong answers, so the search space is five
//     tries out of a million rather than a million tries;
//   * a challenge dies after ten minutes, and is single-use — verifying, right
//     or wrong-for-the-last-time, removes it;
//   * the browser that asked is the only one that may answer, because the
//     challenge id lives in a signed host-only cookie rather than in the URL.
//
// Rate limits are per number and global, and they run BEFORE the person lookup
// so that they apply identically to a number that is in the tree and one that
// is not. That ordering is the whole enumeration defence: every observable —
// the page, the timing class, the limit — has to be the same either way, or the
// form becomes a way to ask "is this cousin's number on file?".
//
// Sending is nanoclaw's job (POST /webhook/family-otp). It re-checks the number
// against family.db on its side, so a bug here that skips the lookup still
// cannot message a stranger.

import crypto from 'node:crypto';

import { normPhone } from '../lib/store.mjs';

export const OTP_TTL_MS = 10 * 60e3;
const MAX_TRIES = 5;

// Per number: three codes a quarter of an hour, and none within a minute of the
// last. The cooldown is the one a relative actually meets — it is there so a
// double-tapped button does not burn their first code.
const PER_PHONE_LIMIT = 3;
const PER_PHONE_WINDOW_MS = 15 * 60e3;
const RESEND_COOLDOWN_MS = 60e3;
// Across all numbers, an upper bound on what a scripted sweep can cost us in
// WhatsApp messages before someone notices the audit log.
const GLOBAL_LIMIT = 40;
const GLOBAL_WINDOW_MS = 60 * 60e3;

const digits = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/**
 * A challenge store and a sender, sharing one clock so the tests can drive it.
 *
 * `now` is injectable for the same reason `fetchImpl` is: a suite that has to
 * wait ten real minutes to check that a code expires is a suite that gets
 * deleted. Nothing else in the service passes a clock around.
 */
export function makeOtp(cfg, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const live = new Map();      // id → { phone, hash, exp, tries, personNo }
  const sends = new Map();     // normalised phone → [timestamps]; '*' is global

  const hashOf = (id, code) =>
    crypto.createHmac('sha256', cfg.sessionKey).update(`${id}:${code}`).digest();

  function prune() {
    const t = now();
    for (const [id, c] of live) if (c.exp <= t) live.delete(id);
    for (const [k, ts] of sends) {
      const window = k === '*' ? GLOBAL_WINDOW_MS : PER_PHONE_WINDOW_MS;
      const kept = ts.filter((x) => t - x < window);
      if (kept.length) sends.set(k, kept); else sends.delete(k);
    }
  }

  /** Why this number may not have another code right now, or ''. */
  function limited(phone) {
    const t = now();
    const mine = (sends.get(phone) ?? []).filter((x) => t - x < PER_PHONE_WINDOW_MS);
    if (mine.length && t - mine[mine.length - 1] < RESEND_COOLDOWN_MS) return 'cooldown';
    if (mine.length >= PER_PHONE_LIMIT) return 'per_phone';
    if ((sends.get('*') ?? []).filter((x) => t - x < GLOBAL_WINDOW_MS).length >= GLOBAL_LIMIT)
      return 'global';
    return '';
  }

  function record(phone) {
    const t = now();
    sends.set(phone, [...(sends.get(phone) ?? []), t]);
    sends.set('*', [...(sends.get('*') ?? []), t]);
  }

  return {
    /**
     * Mint a challenge for a number and try to get a code to it.
     *
     * The return value tells the ROUTE what happened, not the relative: 'sent'
     * and 'unknown' both render the same page, because the difference between
     * them is exactly the fact an enumerator is asking for. Only 'limited' and
     * 'send_failed' are shown as themselves, and neither depends on whether the
     * number is in the tree.
     *
     * A challenge is created even when the number is unknown to nanoclaw. That
     * is deliberate: the code form must be reachable, and answering it must take
     * the same work, or the shape of the response gives the game away.
     */
    async start(rawPhone, { lang = 'he' } = {}) {
      prune();
      const phone = normPhone(rawPhone);
      if (!phone) return { outcome: 'bad_number' };

      const why = limited(phone);
      if (why) return { outcome: 'limited', why };
      record(phone);

      const id = crypto.randomBytes(16).toString('base64url');
      const code = digits();
      live.set(id, { phone, hash: hashOf(id, code), exp: now() + OTP_TTL_MS, tries: 0 });

      let status = 0;
      try {
        const r = await fetchImpl(cfg.otpUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.otpToken}` },
          body: JSON.stringify({ phone, code, lang }),
          signal: AbortSignal.timeout(10_000),
        });
        status = r.status;
      } catch (e) {
        // The sender is down or unreachable — a real failure, and the one case
        // where saying so helps rather than leaks: it is true for every number.
        return { outcome: 'send_failed', id, error: String(e?.message || e) };
      }

      if (status === 200) return { outcome: 'sent', id, phone };
      // 404 (no person carries the number) and 409 (two people do) are answers
      // about the tree, and the relative asking must not be able to tell them
      // from success. 429 cannot normally happen — our own limiter is stricter
      // than nanoclaw's — and is folded in for the same reason.
      if (status === 404 || status === 409 || status === 429) return { outcome: 'unknown', id, status };
      return { outcome: 'send_failed', id, status };
    },

    /**
     * Answer a challenge. Returns the phone to sign in as, or why not.
     *
     * The comparison is timingSafeEqual over HMACs, which are fixed-length by
     * construction — the length check that guards `unsign` is unnecessary here
     * for that reason, not forgotten.
     */
    verify(id, rawCode) {
      prune();
      const c = id ? live.get(id) : null;
      if (!c) return { ok: false, reason: 'expired' };
      if (c.exp <= now()) { live.delete(id); return { ok: false, reason: 'expired' }; }

      const code = String(rawCode ?? '').replace(/\D/g, '');
      c.tries += 1;
      const ok = code.length === 6 && crypto.timingSafeEqual(hashOf(id, code), c.hash);
      if (ok) { live.delete(id); return { ok: true, phone: c.phone }; }
      // Out of tries, the challenge is gone — not merely wrong. Otherwise five
      // guesses become five hundred by asking again with the same cookie.
      if (c.tries >= MAX_TRIES) { live.delete(id); return { ok: false, reason: 'too_many' }; }
      return { ok: false, reason: 'wrong', left: MAX_TRIES - c.tries };
    },

    /** For the selftest: how many challenges are outstanding. */
    get size() { prune(); return live.size; },
  };
}
