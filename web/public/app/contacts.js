/* Where a person can be reached, as links.
 *
 * A classic script, not a module, because the tree page's logic block cannot
 * import. Both pages include it and use globalThis.FamilyContacts, and Node
 * reaches the same code through ../../../lib/contacts.mjs — so the handle the
 * server stores and the URL the page opens can never disagree.
 *
 * Four networks, and only one of them has a column of its own:
 *
 *  - **WhatsApp is derived from `phone`.** Nobody types a WhatsApp address;
 *    they type a phone number, and there has been one on the row since the
 *    contact seed. A separate column would be a second copy of the same fact
 *    that could go stale against the first.
 *  - **Instagram, Facebook and LinkedIn are stored as the canonical URL.** Not
 *    as a handle: Facebook has three shapes of profile address (a username,
 *    `profile.php?id=`, `people/<slug>/<id>`) and LinkedIn has four namespaces,
 *    so "the handle" is not one thing and rebuilding a URL from it is where the
 *    guessing would live. Storing what we will open is lossless; the short
 *    `@handle` the card shows is derived back out for display only.
 *
 * What comes IN is a handle or any of the URLs a phone's share sheet produces.
 * parse() is the only thing that turns one into the other, and it returns null
 * rather than a half-understood value — the server refuses the edit on null, so
 * a typo is reported at the point it was typed instead of becoming a dead link
 * on someone's card a month later.
 *
 * Nothing here is ever fetched. Every link is an <a target="_blank"> a person
 * clicks, which is the same rule the tree's "look them up" box already keeps:
 * no third party learns who is in this tree or who was looked at.
 */
(function (root) {
  'use strict';

  /* Every phone in this tree is an Israeli 10-digit string (`0500000000`) —
     the server's clean() strips it to digits and a `+`, and all 41 rows that
     have one look like that. So a bare local number means Israel. A number that
     announces itself as international (`+`, `00`) is taken at its word, which is
     what the relatives abroad need. */
  var DEFAULT_CC = '972';

  /** A phone number as wa.me wants it: digits only, country code, no `+`. */
  function waNumber(phone) {
    var s = String(phone || '').trim();
    if (!s) return '';
    var d = s.replace(/\D/g, '');
    if (/^\+/.test(s)) { /* already international */ }
    else if (/^00/.test(s)) d = d.replace(/^00/, '');
    else if (d.charAt(0) === '0') d = DEFAULT_CC + d.slice(1);
    else if (d.length <= 9) d = DEFAULT_CC + d;
    if (d.length < 8 || d.length > 15) return '';
    return d;
  }

  /** The path of a URL-ish string, without the query, hash or empty segments. */
  function segments(rest) {
    return String(rest).split(/[?#]/)[0].split('/').filter(Boolean);
  }

  var IG_HOST = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)?instagram\.com\//i;
  var FB_HOST = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)?(?:facebook\.com|fb\.com|fb\.me)\//i;
  var LI_HOST = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\//i;

  /* LinkedIn keeps people in four namespaces and a bare vanity name is always
     `/in/`. Anything else that is not one of these is not a profile address. */
  var LI_SPACES = { in: 2, pub: 4, company: 2, school: 2 };

  function parseInstagram(raw) {
    var h = IG_HOST.test(raw) ? (segments(raw.replace(IG_HOST, ''))[0] || '') : raw;
    h = h.replace(/^@/, '').trim();
    if (!/^[A-Za-z0-9._]{1,30}$/.test(h)) return null;
    return { handle: '@' + h, url: 'https://www.instagram.com/' + h + '/' };
  }

  function parseFacebook(raw) {
    if (FB_HOST.test(raw)) {
      var rest = raw.replace(FB_HOST, '');
      var id = rest.match(/^profile\.php\?(?:.*&)?id=(\d{1,25})/i);
      if (id) return { handle: '', url: 'https://www.facebook.com/profile.php?id=' + id[1] };
      var segs = segments(rest);
      // facebook.com/people/Some-Name/61550000000000 — the name is decoration,
      // the trailing number is the profile.
      if (/^people$/i.test(segs[0] || '') && /^\d{1,25}$/.test(segs[2] || '')) {
        return { handle: String(segs[1] || '').replace(/-/g, ' '),
          url: 'https://www.facebook.com/people/' + encodeURIComponent(segs[1]) + '/' + segs[2] + '/' };
      }
      raw = segs[0] || '';
    }
    var u = String(raw).replace(/^@/, '').trim();
    // Usernames are letters, digits and periods; a bare numeric id is also a
    // real address (facebook.com/4).
    if (!/^[A-Za-z0-9.]{1,60}$/.test(u)) return null;
    return { handle: u, url: 'https://www.facebook.com/' + u };
  }

  function parseLinkedin(raw) {
    var path;
    if (LI_HOST.test(raw)) {
      var segs = segments(raw.replace(LI_HOST, ''));
      var head = String(segs[0] || '').toLowerCase();
      // A linkedin.com URL that is not in one of these namespaces is not a
      // profile — `/feed/`, `/jobs/`, the bare domain. Reading it as a vanity
      // name would file everyone who pasted their own feed URL as `/in/feed`.
      if (!LI_SPACES[head]) return null;
      path = segs.slice(0, LI_SPACES[head]);
    } else {
      path = ['in', String(raw).replace(/^@/, '').trim()];
    }
    if (path.length < 2 || path.some(function (s) { return !/^[^\s/?#]{1,120}$/.test(s); })) return null;
    return { handle: decodeURIComponent(path[path.length - 1]).replace(/-[0-9a-f]{6,}$/i, ''),
      url: 'https://www.linkedin.com/' + path.join('/') + '/' };
  }

  /* Brand colour, glyph, and the parser, per network. The glyphs are drawn here
     rather than pulled from an icon set so that nothing on this page fetches
     anything from a network the family is being linked to. */
  var NETS = {
    whatsapp: {
      brand: '#25D366',
      // The message bubble with its tail, which is the shape the app is known by.
      svg: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>'
        + '<path d="M9.4 9.1c.2-.5.4-.5.6-.5h.5c.2 0 .4 0 .6.5l.7 1.6c.1.2 0 .4-.1.5l-.4.5c-.1.2-.2.3-.1.5.2.4.6 1 1.1 1.5.6.5 1.1.7 1.4.8.2.1.4 0 .5-.1l.5-.6c.2-.2.3-.2.5-.1l1.6.8c.2.1.4.2.4.4 0 .5-.2 1.2-.6 1.4-.4.3-.9.5-1.5.4-.9-.1-2.2-.6-3.5-1.7-1.3-1.2-2.1-2.6-2.4-3.5-.2-.7-.1-1.3.2-1.9z"/>',
    },
    instagram: {
      brand: '#E1306C',
      svg: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4.1"/><circle cx="17.4" cy="6.6" r="1.2"/>',
    },
    facebook: {
      brand: '#1877F2',
      svg: '<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>',
    },
    linkedin: {
      brand: '#0A66C2',
      svg: '<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4V8h4z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/>',
    },
  };

  /** The networks a person can carry, in the order a card shows them. */
  var ORDER = ['whatsapp', 'instagram', 'facebook', 'linkedin'];

  /** The `people` column each one is stored in; whatsapp rides on `phone`. */
  var COLUMNS = { instagram: 'instagram', facebook: 'facebook', linkedin: 'linkedin' };

  var PARSERS = { instagram: parseInstagram, facebook: parseFacebook, linkedin: parseLinkedin };

  /**
   * A typed handle or a pasted URL into `{handle, url}`, or null when it is not
   * a profile address at all. Blank in, blank out — clearing the field is how a
   * relative removes a link, and that is not an error.
   */
  function parse(kind, raw) {
    /* Trimmed, not de-spaced. Squeezing the blanks out of "first last" would turn
       a relative who does not know their own handle into a confident link to
       somebody else's account; the validators below reject the space instead. */
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return { handle: '', url: '' };
    var fn = PARSERS[kind];
    if (!fn) return null;
    return fn(s.replace(/\/+$/, ''));
  }

  /** What the server stores for this field: the canonical URL, or ''. */
  function normalize(kind, raw) {
    var got = parse(kind, raw);
    return got ? got.url : null;
  }

  /** The icon, as a data URI, ready for `background-image`. */
  function icon(kind, color) {
    var n = NETS[kind];
    if (!n) return '';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"'
      + ' stroke="' + (color || n.brand) + '" stroke-width="1.9" stroke-linecap="round"'
      + ' stroke-linejoin="round">' + n.svg + '</svg>';
    /* Single-quoted on purpose: the map writes this straight into a
       double-quoted style attribute, and encodeURIComponent leaves an
       apostrophe alone but escapes every quote in the SVG — so single quotes
       here are the pair that cannot collide with either. */
    return "url('data:image/svg+xml," + encodeURIComponent(svg) + "')";
  }

  var brandOf = function (kind) { return (NETS[kind] || {}).brand || 'currentColor'; };

  /**
   * Every way this person can be reached, in card order. Empty for anyone with
   * nothing on record — the caller draws no row at all rather than an empty one.
   *
   * **Nothing for the dead.** A phone number is reassigned and an account
   * nobody has opened in a decade is not somewhere to send a message; the same
   * judgement the "look them up" box already makes, for the same reason. Their
   * card keeps the phone and the email as text, as it always did.
   *
   * `labels` is the page's own translation table — one string per network — so
   * the wording stays where every other string on these pages lives.
   */
  function linksFor(p, labels) {
    // `deceased` and not `died`: the latter is the DATE, and 59 people are known
    // to have died without one. Testing the date drew WhatsApp buttons for them.
    if (!p || p.deceased || p.died) return [];
    var t = labels || {};
    var out = [];
    ORDER.forEach(function (kind) {
      var url = '', handle = '';
      if (kind === 'whatsapp') {
        var num = waNumber(p.phone);
        if (!num) return;
        url = 'https://wa.me/' + num;
        handle = p.phone;
      } else {
        var got = parse(kind, p[COLUMNS[kind]] || '');
        if (!got || !got.url) return;
        url = got.url;
        handle = got.handle;
      }
      var name = t[kind] || kind;
      out.push({
        kind: kind, url: url, handle: handle, label: name,
        title: handle ? name + ' · ' + handle : name,
        brand: brandOf(kind),
        icon: icon(kind),
      });
    });
    return out;
  }

  root.FamilyContacts = {
    ORDER: ORDER, COLUMNS: COLUMNS,
    parse: parse, normalize: normalize, waNumber: waNumber,
    icon: icon, brandOf: brandOf, linksFor: linksFor,
  };
}(typeof globalThis !== 'undefined' ? globalThis : window));
