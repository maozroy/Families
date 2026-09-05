// /auth/* — signing in, and the pages that say why not.
//
// Two doors, one room. Google is the OAuth round trip below; WhatsApp is a
// six-digit code sent to the number on the person's row (web/otp.mjs). Both end
// at the same place: `resolveIdentity`, which admits a credential only because
// a person in the tree carries it, and `issueSession`, which mints one cookie
// whose payload says which door was used so that the right column is re-checked
// on every later request.
//
// The two flows are structurally the same, and the structure is the point:
//
//                    Google                   WhatsApp
//   we mint          nonce + PKCE verifier    a 6-digit code
//   browser holds    signed fam_oauth cookie  signed fam_otp cookie (challenge id)
//   they prove       Google vouches for them  they read the code off their phone
//   binds to browser cookie nonce = state     challenge id is only in the cookie
//
// The security-relevant parts of the Google round trip, in the order they run:
//
//   login     mints a nonce and a PKCE verifier, keeps both in a short-lived
//             host-only cookie, and sends only the nonce (inside a signed
//             `state`) to Google.
//   callback  requires the returned state to be signed by us AND its nonce to
//             equal the one in that cookie. A signed state on its own proves the
//             request came from our login endpoint, not that it came from *this
//             browser* — without the cookie half, an attacker can complete a
//             login into someone else's session (login CSRF).
//   exchange  sends the verifier, so an intercepted authorisation code is not
//             redeemable on its own.
//
// Then, and only then, the address is looked up against the tree. An account
// Google is perfectly happy to vouch for still gets nothing if no person row
// carries its address.

import crypto from 'node:crypto';

import { personByPhone } from '../lib/store.mjs';
import { mintHandoff, handoffKey } from '../lib/wiki-handoff.mjs';
import {
  GOOGLE_TOKEN, OAUTH_COOKIE, OTP_COOKIE, SESS_COOKIE,
  authorizeUrl, clearCookie, cookies, hostOf, issueSession, methodsFor, pinGoogleSub,
  readSession, redirectUri, resolveIdentity, safeRd, setCookie, sign, unsign, verifyIdToken,
} from './auth.mjs';
import { OTP_TTL_MS, makeOtp } from './otp.mjs';

const OAUTH_TTL_MS = 10 * 60e3;

/**
 * Every origin this service will vouch to, by name. An allowlist and not a
 * pattern: a `*.example.org` wildcard would cover every internal service on
 * the box, and
 * the whole point of handing a token to the wiki is that it is the ONE other
 * place a relative's sign-in should reach.
 */
const HANDOFF_TARGETS = {
  wiki: String(process.env.FAMILY_HANDOFF_WIKI_ORIGINS
    || '')
    .split(',').map((o) => o.trim()).filter(Boolean),
};

const redirect = (res, to) => {
  res.writeHead(302, { location: to, 'cache-control': 'no-store' });
  res.end();
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * A standalone page, in both languages, for the moments the app itself is not
 * reachable — before a session exists there is no bundle to render an error
 * into, and a bare 403 tells a relative nothing they can act on.
 */
function page(res, code, { he, en, hint = '', hintEn = '', action = '' }) {
  const html = `<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(he)}</title>
<meta name="theme-color" content="#f5ead8">
<link rel="icon" href="/icons/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/icon-180.png">
<style>
 :root { color-scheme: light dark }
 body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0;
        min-height: 100vh; display: flex; align-items: center; justify-content: center;
        background: #f5ead8; color: #2c2418; padding: 1.5rem }
 .card { background: #fffdf8; border: 1px solid #e0d3ba; border-radius: 16px; padding: 2rem;
         max-width: 30rem; box-shadow: 0 6px 24px rgba(60,45,20,.10) }
 .mark { display: block; width: 72px; height: 72px; margin: 0 auto 1rem; border-radius: 16px }
 h1 { font-size: 1.15rem; margin: 0 0 .75rem }
 p { margin: 0 0 .75rem; line-height: 1.6 }
 .en { direction: ltr; text-align: left; color: #6b5c44; font-size: .95rem }
 .hint { font-size: .9rem; color: #6b5c44 }
 a.btn, button { display: inline-block; margin-top: 1rem; padding: .6rem 1.1rem; border: 0;
        border-radius: 10px; background: #7a5c2e; color: #fff; font: inherit; cursor: pointer;
        text-decoration: none }
 input { width: 100%; box-sizing: border-box; margin-top: .6rem; padding: .6rem .8rem;
        border: 1px solid #d8c9ae; border-radius: 10px; background: #fff; color: inherit;
        font: inherit; direction: ltr; text-align: left }
 input.code { letter-spacing: .5em; font-size: 1.4rem; text-align: center }
 form { margin: 0 }
 hr { border: 0; border-top: 1px solid #e0d3ba; margin: 1.5rem 0 1rem }
 a.alt { display: inline-block; margin-top: .5rem; color: #7a5c2e }
 @media (prefers-color-scheme: dark) {
   body { background: #1a1712; color: #ece3d2 }
   .card { background: #241f18; border-color: #3a3226; box-shadow: none }
   .en, .hint { color: #a89b80 }
   input { background: #1a1712; border-color: #3a3226; color: inherit }
   hr { border-color: #3a3226 }
   a.alt { color: #d7b878 }
 }
</style></head><body><div class="card">
<img class="mark" src="/icons/icon-120.png" width="72" height="72" alt="">
<h1>${esc(he)}</h1>
${hint ? `<p class="hint">${esc(hint)}</p>` : ''}
<p class="en">${esc(en)}</p>
${hintEn ? `<p class="en hint">${esc(hintEn)}</p>` : ''}
${action}
</div></body></html>`;
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

async function exchangeCode(cfg, host, code, verifier) {
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri(cfg, host),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.id_token ? j : null;
}

// ── form plumbing ────────────────────────────────────────────────────────────

/** A urlencoded form body, capped. The two OTP forms are the only POSTs here. */
function formBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { req.destroy(); resolve(new URLSearchParams()); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve(new URLSearchParams()); }
    });
    req.on('error', () => resolve(new URLSearchParams()));
  });
}

/**
 * A cross-site POST to these endpoints is only an annoyance — the challenge is
 * bound to a cookie the attacker cannot plant, so login CSRF does not work here
 * the way it would against a bare callback. Checking the origin anyway is one
 * line, and it keeps a stranger's page from spending a relative's daily codes.
 */
function sameOrigin(req, host) {
  const o = req.headers.origin || req.headers.referer || '';
  if (!o) return true;                       // some browsers omit it on same-origin POSTs
  try { return new URL(o).host.toLowerCase().replace(/:\d+$/, '') === host; }
  catch { return false; }
}

const PATHS = new Set([
  '/auth/login', '/auth/callback', '/auth/logout', '/auth/whatsapp', '/auth/whatsapp/verify',
  '/auth/handoff',
]);

/**
 * @param bans  the shared denial brake; the same one whoami() strikes, so five
 *              refusals spread across the callback, the code form and the API
 *              still add up.
 * @param otp   injectable so the selftest can drive a fake sender and clock.
 */
export function makeAuthRoutes({ db, cfg, audit, bans, clientIp, otp = cfg.whatsapp ? makeOtp(cfg) : null }) {
  return async function authRoute(req, res, url) {
    const p = url.pathname;
    if (!PATHS.has(p)) return false;

    const host = hostOf(req);
    const m = methodsFor(cfg, host);
    const ip = clientIp(req);

    // Logging out is the one thing that must work on the CF hostname too.
    if (p === '/auth/logout') return logout(req, res);

    // A hostname Cloudflare Access gates has no second login — and neither has
    // one whose method is switched off. Bounce rather than render a form that
    // cannot work.
    const enabled = p.startsWith('/auth/whatsapp') ? m.whatsapp
      : p === '/auth/callback' ? m.google
        : m.session;
    if (!enabled) {
      res.audit = { skip: true };
      redirect(res, '/');
      return true;
    }

    if (bans.banned(ip)) {
      req.audit = { action: 'login.throttled', outcome: 'denied', actor_kind: 'google', external: true };
      page(res, 429, {
        he: 'יותר מדי ניסיונות התחברות', en: 'Too many sign-in attempts.',
        hint: 'נסו שוב בעוד שעה.', hintEn: 'Try again in an hour.',
      });
      return true;
    }

    if (p === '/auth/login') return login(req, res, url, host, m);
    if (p === '/auth/handoff') return handoff(req, res, url, host);
    if (p === '/auth/whatsapp') return whatsappStart(req, res, host);
    if (p === '/auth/whatsapp/verify') return whatsappVerify(req, res, host, ip);
    return callback(req, res, url, host, ip);
  };

  // ── GET /auth/handoff ──────────────────────────────────────────────────────

  /**
   * Vouch, once, to another service on this box — today only the family wiki.
   *
   * This service already knows who the relative is; the wiki does not, and must
   * not be given the cookie that would tell it (see lib/wiki-handoff.mjs). So it
   * sends the browser here, and this mints a sixty-second, audience-bound token
   * that the wiki exchanges for a session of its own.
   *
   * The identity is re-resolved rather than taken from the cookie, so a relative
   * whose address was cleared off their row between signing in here and clicking
   * through to the wiki does not get vouched for. The cookie carries a
   * credential; the tree decides what it is worth, every time.
   */
  function handoff(req, res, url, host) {
    const rd = String(url.searchParams.get('rd') || '');

    // Where the token may be sent, checked against an exact origin rather than a
    // suffix. `rd` ends up in a Location header with a bearer token on it, so a
    // sloppy check here is a token-exfiltration bug, not just an open redirect.
    let target;
    try { target = new URL(rd); } catch { target = null; }
    if (!target || !HANDOFF_TARGETS.wiki.includes(target.origin) || target.searchParams.has('t')) {
      req.audit = { action: 'handoff.fail', outcome: 'denied', actor_kind: 'google',
        detail: { reason: 'bad rd', rd } };
      page(res, 400, { he: 'יעד לא מוכר', en: 'Unrecognised handoff target.' });
      return true;
    }

    const sess = readSession(cfg, req);
    if (!sess) {
      // Not signed in yet: send them through the normal door and come straight
      // back here afterwards, so the wiki link works on a cold browser.
      res.audit = { skip: true };
      const back = `/auth/handoff?to=wiki&rd=${encodeURIComponent(rd)}`;
      redirect(res, `/auth/login?rd=${encodeURIComponent(back)}`);
      return true;
    }

    const r = resolveIdentity(db, cfg, sess);
    if (!r.ok) {
      req.audit = { action: 'handoff.fail', outcome: 'denied', actor_kind: sess.kind,
        detail: { reason: r.reason } };
      page(res, 403, {
        he: 'החשבון הזה כבר לא מחובר לאדם בעץ', en: 'This account is no longer linked to anyone in the tree.',
      });
      return true;
    }

    target.searchParams.set('t', mintHandoff(handoffKey(cfg.sessionKey), sess));
    req.audit = { action: 'handoff.ok', outcome: 'allowed', actor_kind: sess.kind,
      actor: r.identity.email, detail: { to: 'wiki' } };
    redirect(res, target.toString());
    return true;
  }

  // ── GET /auth/login ────────────────────────────────────────────────────────

  function login(req, res, url, host, m) {
    const rd = safeRd(url.searchParams.get('rd'));

    // With a code form available, /auth/login is a choice rather than a
    // redirect. `?method=google` is how the button on that page skips it —
    // and when Google is the only method there is nothing to choose, so the
    // old behaviour (straight to the consent screen) is unchanged.
    if (m.whatsapp && url.searchParams.get('method') !== 'google') {
      res.audit = { skip: true };
      return signInPage(res, { rd, google: m.google });
    }
    if (!m.google) {
      res.audit = { skip: true };
      return signInPage(res, { rd, google: false });
    }

    if (!redirectUri(cfg, host)) {
      // An unrecognised Host would put an unregistered redirect_uri in front of
      // Google, so refuse rather than send the relative into a confusing error.
      req.audit = { action: 'login.fail', outcome: 'denied', actor_kind: 'google',
        detail: { reason: 'unknown host', host } };
      page(res, 400, { he: 'כתובת לא מוכרת', en: 'Unrecognised hostname.' });
      return true;
    }

    const nonce = crypto.randomBytes(16).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const exp = Date.now() + OAUTH_TTL_MS;

    // The verifier never leaves this browser; only its SHA-256 goes to Google.
    setCookie(res, OAUTH_COOKIE, sign(cfg.sessionKey, { n: nonce, v: verifier, exp }),
      { maxAge: OAUTH_TTL_MS / 1000, path: '/auth' });

    res.audit = { skip: true };
    redirect(res, authorizeUrl(cfg, { host, state: sign(cfg.sessionKey, { n: nonce, rd, exp }), verifier }));
    return true;
  }

  // ── the sign-in pages ──────────────────────────────────────────────────────

  /** Pick a door. Rendered only when the code form is available. */
  function signInPage(res, { rd, google }) {
    const alt = google
      ? `<hr><a class="alt" href="/auth/login?method=google&rd=${encodeURIComponent(rd)}">`
        + 'להתחברות עם חשבון Google · Sign in with Google</a>'
      : '';
    page(res, 200, {
      he: 'כניסה לעץ המשפחה',
      en: 'Sign in to the family tree.',
      hint: 'הזינו את מספר הטלפון שלכם ונשלח לכם קוד ב-WhatsApp. המספר צריך להיות רשום אצלכם בעץ.',
      hintEn: 'Enter your phone number and we will send a code on WhatsApp. '
        + 'The number has to be the one on your entry in the tree.',
      action: `<form method="post" action="/auth/whatsapp">
<input type="hidden" name="rd" value="${esc(rd)}">
<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="050-000-0000"
       aria-label="מספר טלפון · Phone number" required autofocus>
<button type="submit">שלחו לי קוד · Send me a code</button>
</form>${alt}`,
    });
    return true;
  }

  /**
   * Where a relative lands whether or not their number is in the tree — the two
   * cases must be indistinguishable, so the copy says "if" out loud rather than
   * promising a message that is never coming.
   */
  function codePage(res, { status = 200, error = '', errorEn = '' } = {}) {
    page(res, status, {
      he: 'הזינו את הקוד',
      en: 'Enter the code.',
      hint: error || `אם המספר הזה רשום אצלכם בעץ, שלחנו לשם קוד בן 6 ספרות ב-WhatsApp. `
        + `הקוד תקף ל-${OTP_TTL_MS / 60e3} דקות.`,
      hintEn: errorEn || 'If that number is on your entry in the tree, a 6-digit code is on its way '
        + 'on WhatsApp. It is good for 10 minutes.',
      action: `<form method="post" action="/auth/whatsapp/verify">
<input class="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*"
       maxlength="6" aria-label="קוד · Code" required autofocus>
<button type="submit">כניסה · Sign in</button>
</form><hr><a class="alt" href="/auth/login">מספר אחר · A different number</a>`,
    });
    return true;
  }

  // ── POST /auth/whatsapp ────────────────────────────────────────────────────

  /**
   * Ask for a code. Everything that can be observed from outside — the page, the
   * status, the next step — is identical for a number in the tree and a number
   * that is not, because the difference is exactly what an enumerator wants.
   * The refusals that ARE shown (a malformed number, a rate limit, a sender that
   * is down) are all true regardless of who the number belongs to.
   */
  async function whatsappStart(req, res, host) {
    if (req.method !== 'POST') { redirect(res, '/auth/login'); return true; }
    if (!sameOrigin(req, host)) { redirect(res, '/auth/login'); return true; }

    const form = await formBody(req);
    const rd = safeRd(form.get('rd'));
    // Their own language for the message, when we can tell. This lookup changes
    // nothing else about the response — an unknown number and a known one still
    // produce byte-identical pages — so it is not an enumeration channel.
    const who = personByPhone(db, form.get('phone'));
    const r = await otp.start(form.get('phone'), { lang: who?.lang === 'en' ? 'en' : 'he' });

    if (r.outcome === 'bad_number') {
      res.audit = { skip: true };
      page(res, 400, {
        he: 'מספר לא תקין', en: 'That does not look like a phone number.',
        hint: 'מספר נייד ישראלי, למשל 050-000-0000.',
        hintEn: 'An Israeli mobile number, e.g. 050-000-0000.',
        action: '<a class="btn" href="/auth/login">חזרה · Back</a>',
      });
      return true;
    }

    if (r.outcome === 'limited') {
      req.audit = { action: 'login.otp_throttled', outcome: 'denied', actor_kind: 'whatsapp',
        external: true, detail: { why: r.why } };
      page(res, 429, r.why === 'cooldown' ? {
        he: 'הקוד כבר בדרך', en: 'A code is already on its way.',
        hint: 'חכו דקה לפני שמבקשים עוד אחד.', hintEn: 'Wait a minute before asking for another.',
        action: '<a class="btn" href="/auth/login">חזרה · Back</a>',
      } : {
        he: 'יותר מדי בקשות', en: 'Too many code requests.',
        hint: 'נסו שוב בעוד רבע שעה.', hintEn: 'Try again in fifteen minutes.',
      });
      return true;
    }

    if (r.outcome === 'send_failed') {
      // Not the relative's fault and not about them: WhatsApp or nanoclaw is
      // down, which is equally true for every number.
      req.audit = { action: 'login.otp_send_failed', outcome: 'error', actor_kind: 'whatsapp',
        alert: true, detail: { status: r.status ?? null, error: r.error ?? '' } };
      page(res, 502, {
        he: 'לא הצלחנו לשלוח את הקוד', en: 'We could not send the code right now.',
        hint: 'זאת תקלה אצלנו, לא אצלכם. נסו שוב בעוד כמה דקות.',
        hintEn: 'That is a fault on our side. Try again in a few minutes.',
        action: '<a class="btn" href="/auth/login">נסו שוב · Try again</a>',
      });
      return true;
    }

    // 'sent' and 'unknown' from here down — deliberately the same page.
    setCookie(res, OTP_COOKIE, sign(cfg.sessionKey, { id: r.id, rd, exp: Date.now() + OTP_TTL_MS }),
      { maxAge: OTP_TTL_MS / 1000, path: '/auth' });
    req.audit = { action: 'login.otp_requested', outcome: 'ok', actor_kind: 'whatsapp',
      external: true, detail: { delivered: r.outcome === 'sent' } };
    return codePage(res);
  }

  // ── POST /auth/whatsapp/verify ─────────────────────────────────────────────

  async function whatsappVerify(req, res, host, ip) {
    if (req.method !== 'POST') { redirect(res, '/auth/login'); return true; }
    if (!sameOrigin(req, host)) { redirect(res, '/auth/login'); return true; }

    const form = await formBody(req);
    const held = unsign(cfg.sessionKey, cookies(req)[OTP_COOKIE]);
    const expired = () => {
      clearCookie(res, OTP_COOKIE, '/auth');
      req.audit = { action: 'login.otp_fail', outcome: 'denied', actor_kind: 'whatsapp',
        external: true, detail: { reason: 'no live challenge' } };
      page(res, 400, {
        he: 'הקוד פג', en: 'That code has expired.',
        hint: 'בקשו קוד חדש.', hintEn: 'Ask for a new one.',
        action: '<a class="btn" href="/auth/login">קוד חדש · New code</a>',
      });
      return true;
    };
    if (!held || !(held.exp > Date.now()) || !held.id) return expired();

    const v = otp.verify(held.id, form.get('code'));

    if (!v.ok) {
      // A wrong digit keeps the challenge (and the cookie) alive; running out of
      // tries, or a challenge that is gone, does not.
      if (v.reason === 'wrong') {
        // No strike for a fumbled digit. Five of those already kill the
        // challenge, and getting another one costs a rate-limited code request
        // — striking here as well would lock a relative out of their own
        // account for an hour over one mistyped code.
        req.audit = { action: 'login.otp_fail', outcome: 'denied', actor_kind: 'whatsapp',
          external: true, detail: { reason: 'wrong code', left: v.left } };
        return codePage(res, {
          status: 401,
          error: `הקוד לא נכון. נשארו ${v.left} ניסיונות.`,
          errorEn: `That code is not right. ${v.left} attempts left.`,
        });
      }
      bans.strike(ip);
      clearCookie(res, OTP_COOKIE, '/auth');
      req.audit = { action: 'login.otp_fail', outcome: 'denied', actor_kind: 'whatsapp',
        external: true, alert: v.reason === 'too_many', detail: { reason: v.reason } };
      page(res, v.reason === 'too_many' ? 429 : 400, v.reason === 'too_many' ? {
        he: 'יותר מדי ניסיונות', en: 'Too many wrong codes.',
        hint: 'הקוד בוטל. בקשו קוד חדש.', hintEn: 'That code is cancelled. Ask for a new one.',
        action: '<a class="btn" href="/auth/login">קוד חדש · New code</a>',
      } : {
        he: 'הקוד פג', en: 'That code has expired.',
        hint: 'בקשו קוד חדש.', hintEn: 'Ask for a new one.',
        action: '<a class="btn" href="/auth/login">קוד חדש · New code</a>',
      });
      return true;
    }

    clearCookie(res, OTP_COOKIE, '/auth');

    // Holding the code proves the number, and the number was on a person row
    // when the code went out. Re-resolving is for the minutes in between: a row
    // can be edited or soft-deleted while a code is in flight, and the identity
    // must be the one that is true now.
    const verdict = resolveIdentity(db, cfg, { phone: v.phone, kind: 'whatsapp' });
    if (!verdict.ok) {
      req.audit = { action: 'login.unknown_number', outcome: 'denied', actor_kind: 'whatsapp',
        external: true, alert: true, detail: { reason: verdict.reason } };
      page(res, 403, {
        he: 'המספר הזה כבר לא רשום בעץ',
        en: 'That number is no longer on anyone’s entry in the tree.',
        hint: `פנו ל${cfg.ownerNameHe}.`, hintEn: `Contact ${cfg.ownerNameEn}.`,
      });
      return true;
    }

    issueSession(cfg, res, { phone: v.phone, kind: 'whatsapp', iat: Date.now() });
    bans.clear(ip);
    req.audit = {
      action: 'login.success', outcome: 'ok', actor: verdict.identity.email, actor_kind: 'whatsapp',
      actor_label: verdict.identity.person?.name_he,
      detail: { person_no: verdict.identity.person?.person_no ?? null, owner: verdict.identity.owner },
    };
    redirect(res, safeRd(held.rd));
    return true;
  }

  // ── GET /auth/callback ─────────────────────────────────────────────────────

  async function callback(req, res, url, host, ip) {
    clearCookie(res, OAUTH_COOKIE, '/auth');   // one round trip, one use

    const fail = (reason, detail = {}) => {
      bans.strike(ip);
      req.audit = { action: 'login.fail', outcome: 'denied', actor_kind: 'google',
        external: true, alert: true, detail: { reason, ...detail } };
      page(res, 400, {
        he: 'ההתחברות לא הושלמה', en: 'Sign-in did not complete.',
        hint: 'נסו שוב מהתחלה.', hintEn: 'Start again.',
        action: '<a class="btn" href="/auth/login">התחברות · Sign in</a>',
      });
      return true;
    };

    const err = url.searchParams.get('error');
    if (err) return fail('google returned an error', { error: err });

    const code = url.searchParams.get('code');
    const state = unsign(cfg.sessionKey, url.searchParams.get('state') || '');
    const held = unsign(cfg.sessionKey, cookies(req)[OAUTH_COOKIE]);
    const now = Date.now();

    if (!code) return fail('no code');
    if (!state || !(state.exp > now)) return fail('bad or expired state');
    if (!held || !(held.exp > now)) return fail('missing or expired oauth cookie');
    // Browser binding. A signed state alone was minted by us, but not
    // necessarily for the browser now presenting it.
    if (!held.n || !state.n || held.n !== state.n) return fail('state/nonce mismatch');
    if (!held.v) return fail('no pkce verifier');
    if (!redirectUri(cfg, host)) return fail('unknown host', { host });

    let tok;
    try { tok = await exchangeCode(cfg, host, code, held.v); }
    catch (e) { return fail('token endpoint unreachable', { error: String(e?.message || e) }); }
    if (!tok) return fail('token exchange rejected');

    const claims = verifyIdToken(cfg, tok.id_token);
    if (!claims) return fail('id_token failed validation');

    const { email, sub } = claims;
    const verdict = resolveIdentity(db, cfg, { email, sub, kind: 'google' });

    if (!verdict.ok) {
      bans.strike(ip);
      const known = verdict.reason === 'sub_mismatch';
      req.audit = {
        action: known ? 'login.sub_mismatch' : 'login.unknown_account',
        outcome: 'denied', actor: email, actor_kind: 'google', external: true, alert: true,
        ...(verdict.person ? { actor_label: verdict.person.name_he } : {}),
        detail: known
          ? { reason: 'a different Google account is pinned to this person', person_no: verdict.person?.person_no }
          : { reason: 'no person in the tree carries this address' },
      };
      page(res, 403, known ? {
        he: 'החשבון הזה לא מתאים לרשומה',
        en: 'This Google account does not match the one on file for that address.',
        hint: `פנו ל${cfg.ownerNameHe} — הכתובת הזאת כבר משויכת לחשבון גוגל אחר.`,
        hintEn: `Contact ${cfg.ownerNameEn} — that address is already pinned to a different Google account.`,
      } : {
        he: 'הכתובת הזאת לא רשומה בעץ',
        en: `Signed in as ${email}, but no one in the family tree has that address.`,
        hint: `נכנסתם בתור ${email}. כדי לקבל גישה, הכתובת צריכה להופיע אצלכם בעץ — בקשו מ${cfg.ownerNameHe} להוסיף אותה.`,
        hintEn: `Ask ${cfg.ownerNameEn} to add it to your entry, or sign in with a different account.`,
        action: '<a class="btn" href="/auth/login">חשבון אחר · Try another account</a>',
      });
      return true;
    }

    if (verdict.identity.person) {
      try { pinGoogleSub(db, verdict.identity.person, sub); }
      catch (e) { console.error('[family] pinning google_sub failed:', e?.message || e); }
    }

    issueSession(cfg, res, { email, sub, iat: Date.now() });
    bans.clear(ip);
    req.audit = {
      action: 'login.success', outcome: 'ok', actor: email, actor_kind: 'google',
      ...(verdict.identity.person ? { actor_label: verdict.identity.person.name_he } : {}),
      detail: { person_no: verdict.identity.person?.person_no ?? null, owner: verdict.identity.owner },
    };
    redirect(res, safeRd(state.rd));
    return true;
  }

  // ── /auth/logout ───────────────────────────────────────────────────────────

  /**
   * POST, or a GET that renders a button. A plain GET logout is reachable from
   * any page on the internet through a top-level navigation, which SameSite=Lax
   * does nothing about — annoyance-grade, but free to close.
   */
  function logout(req, res) {
    if (req.method === 'POST') {
      /* Read the kind BEFORE clearing it: the access log said 'google' for
         every sign-out, including the WhatsApp ones, which are now the ones
         that can actually happen from the button. */
      const was = readSession(cfg, req);
      clearCookie(res, SESS_COOKIE);
      req.audit = { action: 'logout', outcome: 'ok', actor_kind: (was && was.kind) || 'session' };
      redirect(res, '/');
      return true;
    }
    res.audit = { skip: true };
    page(res, 200, {
      he: 'להתנתק?', en: 'Sign out of the family tree?',
      action: '<form method="post" action="/auth/logout"><button type="submit">התנתקות · Sign out</button></form>',
    });
    return true;
  }
}
