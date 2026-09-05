/* v2 service worker — the family tree, offline.
 *
 * Both pages are installable and have been since the manifest landed: the README
 * tells relatives to add them to the home screen. Without a worker, that gives
 * you a standalone window that shows a blank page the moment the train goes into
 * a tunnel. This is the missing half.
 *
 * SCOPE. Served from /sw.js, so its scope is the whole site. It used to be
 * served from /v2/sw.js precisely so it could NOT touch the live pages at / and
 * /tree — and then v2 became those pages, which turned that safeguard into the
 * thing stopping the app from working offline. It is still also served at the
 * old path for phones that registered it there.
 *
 * THREE CACHES, THREE POLICIES, because the three kinds of thing here have
 * genuinely different needs:
 *
 *   shell   the JS bundles, the CSS, the fonts, Leaflet. Versioned by SHELL
 *           below; stale-while-revalidate, so a visit is instant and the next
 *           one has the update. The two DOCUMENTS live in the same cache but
 *           are network-first with a two-second fallback — a stale bundle is a
 *           day out of date, a stale document can be a broken app nobody can
 *           reload their way out of. See the fetch handler.
 *   data    /app/data.js — the whole family, rendered as a script. Network
 *           first, falling back to the last copy. This is what makes an offline
 *           visit show the tree rather than an empty page.
 *   media   /photo/* — immutable once written, so cache-first forever.
 *
 * Everything else — every /api/ call — is network only. An edit made offline
 * cannot be honestly acknowledged (the change log is server-side and undo
 * depends on it), so the page says it is offline and does not pretend.
 *
 * ON CACHING data.js. The server sends it `no-store`, and storing it anyway is a
 * deliberate override, so: it holds exactly what the page it belongs to holds,
 * on a device that is already displaying it. What it must not do is outlive the
 * session, so any 401 from anywhere drops the data cache on the floor — a lapsed
 * session, a sign-out, or a different relative signing in on the same phone all
 * come through as a 401 sooner or later, and none of them should find the
 * previous person's family still sitting there.
 */

/* Bump SHELL whenever a document starts depending on something NEW in a file
   that is cached separately from it. Stale-while-revalidate refreshes each entry
   on its own schedule, so the document and its scripts can be a generation
   apart; a page that calls a function its cached copy of origin.js does not have
   yet does not degrade, it throws on load and shows nothing. Bumping drops the
   whole shell cache on activate, so the set comes back consistent.

   -2: origins became rows, and both documents now call FamilyOrigin.load().
   -3: v2 became the live pages, so the paths this caches changed.
   -4: the contact row and the "tell us about yourself" prompt — both documents
       now call into /app/contacts.js and /app/profile.js, which did not exist.
   -5: the documents became network-first (see the fetch handler), so every
       phone still holding a shell-4 copy of one is dropped rather than served
       it one more time.
   -6: the same again, and this one is the point rather than a side effect. A
       phone was rendering a broken document out of shell-5 and could not be
       talked out of it — network-first still lost the two-second race, and the
       document's own stale check excused itself because that copy predated the
       stamp. Both of those are fixed alongside this, but neither reaches a
       phone until it has thrown that copy away, and the only thing that can
       make it do that from here is a cache name it does not have. Bumping is
       the one instruction in this file that a stuck client cannot ignore.
   -7: the tree learned to draw a share card and to print itself, and both of
       those live in new files under /app/ that a shell-6 phone has never
       fetched. Neither would break a cached document — the page guards on the
       module and simply shows no button — but a relative who is told "share
       it" and has no button is a bug report, so the shell is replaced rather
       than left to fill in on its own schedule.
   -8: both pages now say how the reader is related to each family — the tree's
       families panel and the map's legend — and all of it is new in
       /app/relations.js: who introduces a family, and the kinship words, which
       moved out of the tree so the two cannot name the same person
       differently. Both pages guard on the functions, so a shell-7 phone
       degrades to the panels it already had rather than breaking; it would
       just never show the line, on its own schedule, forever.
   -9: and that guard was not enough, which is the lesson this entry is for. The
       kinship words grew a shorter form ("גיסתי" for "גיסה שלי") AFTER shell-8
       went out, so a phone that had already taken shell-8 held a relations.js
       with introduce() but without mine() — the tree guarded on the first,
       called the second, and threw: a blank page reading "R.mine is not a
       function". A cache version bumped once does not cover a file that keeps
       changing inside it. So the documents now ask for `/app/relations.js?v=2`,
       which is a URL no cache can answer with the old file, and the guards test
       the function each page actually calls. Bump the query, not just this, the
       next time that file grows something a document depends on.
  -10: v=3, and the rule is wider than "grows something": relate() learned that
       your spouse's sibling's spouse is your גיס, which adds no function for a
       guard to test — the same call simply answers better. A shell that keeps
       the old copy is not broken, it just goes on saying "אשת האח של אשתי"
       where the tree beside it says "גיסתי", and stale-while-revalidate means
       the reader sees the fix one visit after they were told about it. The
       query moves whenever the ANSWERS move, not only when the API does.
  -11: v=4, same reason: an aunt's husband is now דוד rather than בעל הדודה,
       and a family reached through somebody is named after them — "משפחת דודי
       אבי" where the branch column had nobody closer than his mother.
  -12: the person card now carries a Hebrew date of birth, computed in a new
       /app/hebrew.js. The tree guards on the module, so a shell-11 phone would
       simply go on showing the civil date alone — correct, but a relative who
       is told the Hebrew date is there and cannot see it has no way to know it
       is their cache.
  -13: v=2, and this is the -9 lesson arriving on schedule. hebrew.js grew
       withNote() the same day it shipped — the form learned to ask whether a
       birth was after sunset, and the card has to say so — and the document
       calls that function. A phone holding the shell-12 copy has of() and not
       withNote(), which the guard catches and turns into no Hebrew row at all.
       So the query moves with the file, not only this constant.
  -14: v=3. The birthday list learned to be counted in Hebrew months — which
       needs stepMonth(), anniversary() and the two label helpers, none of
       which a shell-13 copy of hebrew.js has. The switch is hidden when they
       are missing rather than the list breaking, so this bump is what makes it
       appear rather than what keeps the page alive.
  -15: countries.js — a FILE that did not exist, which is the -9 case again and
       not the -13 one. Both documents now ask for it, and both guard on the
       object: a phone still holding the shell-14 copy of the document has no
       country picker in its form and no country in its address lines, rather
       than a page that throws. The bump is what gets it the document that has
       them.
  -16: the places a life happened — born, died, buried — and the documents that
       prove them. All of it is inside the two documents themselves, and the one
       thing they read from elsewhere (window.FAMILY_LIFE_PLACES, out of
       /app/data.js) is guarded with a `|| []`, so a shell-15 phone is in no
       danger: it simply has a card with no birthplace on it and a form with
       nowhere to type one. This is the -12 case exactly — the feature is
       announced to the family, and a cached document is the one thing that can
       make it invisible on a particular phone with no way for its owner to
       know why.
  -17: every person in the tree now has a wiki page, and the link to it moved
       out of its own labelled row and up next to the name as an icon. This is
       the -13 case and NOT the -12 one: the styling lives in v2-base.css, which
       IS in this cache, so a phone holding shell-16 would take the new document
       — documents are network-first — and render its `.wiki-btn` against a
       stylesheet that has no such rule. Not a missing feature but a visibly
       broken one: an unstyled, unsized link with an empty span in it, sitting
       beside every name in the tree. A markup change that depends on new CSS
       has to bump, even though nothing throws.
  -18: `deceased` became a field of its own on every person, separate from
       `died`, which is the DATE. 59 people are known to have died with no date
       on record, and every consumer testing `p.died` had been treating them as
       living — /app/contacts.js drew WhatsApp and Instagram buttons for them,
       and the tree listed their birthdays. contacts.js IS in this cache and its
       behaviour changed without its API changing, which is the -10 case: a
       shell-17 phone is not broken, it simply goes on offering to message a man
       born in 1783. */
/* The documents, under both the current paths and the ones they were reached by
   before the cutover — the same two files either way. Anything not listed falls
   through to the network untouched, so a path missed here costs an offline
   visit, never a broken one. */
const DOCS = ['/', '/tree', '/map', '/v2', '/v2/', '/v2/tree', '/v2/map'];

const SHELL = 'fam-v2-shell-18';
const DATA = 'fam-v2-data-1';
const MEDIA = 'fam-v2-media-1';
const MINE = [SHELL, DATA, MEDIA];

/* The documents and the handful of files they cannot start without. Anything
   missed here is picked up on first use by the shell handler below; this list is
   only what makes the FIRST offline visit work. */
const PRECACHE = [
  '/',
  '/tree',
  '/app/v2-base.css',
  '/app/v2-theme.js',
  '/app/colors.js',
  '/app/origin.js?v=2',
  '/app/urlstate.js',
  '/app/fuzzy.js?v=2',
  '/app/countries.js?v=1',
  '/app/relations.js?v=4',
  '/app/contacts.js',
  '/app/profile.js',
  '/app/hebrew.js?v=3',
  '/app/sharecard.js?v=2',
  '/app/treeprint.js?v=2',
  '/app/leaflet-1.9.4.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      /* Individually, not addAll: addAll is all-or-nothing, and one 404 in that
         list would leave the worker with no cache at all rather than with nine
         useful entries. */
      .then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('fam-v2-') && MINE.indexOf(k) < 0)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* A 401 anywhere means this cached family is no longer this reader's to see. */
function dropDataIfUnauthorised(res) {
  if (res && res.status === 401) caches.delete(DATA);
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  /* Never cached, never guessed at. */
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    e.respondWith(fetch(req).then(dropDataIfUnauthorised).catch(() => new Response(
      JSON.stringify({ error: 'offline' }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    )));
    return;
  }

  /* The family, as a script. Network first so an open tab is never a day
     behind, last-known copy when there is no network. */
  if (url.pathname === '/app/data.js') {
    e.respondWith(
      fetch(req)
        .then(dropDataIfUnauthorised)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(DATA).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || new Response(
          '/* offline, and no saved copy of the family on this device yet */',
          { headers: { 'content-type': 'application/javascript' } }
        )))
    );
    return;
  }

  /* Photos never change once written — the id is the content. */
  if (url.pathname.startsWith('/photo/')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then(dropDataIfUnauthorised).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(MEDIA).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => new Response('', { status: 504 })))
    );
    return;
  }

  /* The documents under both the current paths and the ones they were reached
     by before the cutover — the same two files either way. Anything not listed
     falls through to the network untouched, so a path missed here costs an
     offline visit, never a broken one. */
  const isShell = url.pathname.startsWith('/app/')
    || url.pathname.startsWith('/icons/')
    || DOCS.indexOf(url.pathname) >= 0;

  if (!isShell) return;

  /* THE DOCUMENTS ARE NETWORK-FIRST, with the cache as a fallback after two
     seconds or on failure. Everything else here is stale-while-revalidate.

     They used to be stale-while-revalidate too, and the argument for it was
     that a page which changes a few times a year should load instantly and
     update on the next visit. What that misses is the case where the cached
     copy is BROKEN: the reader is then one visit behind a fix they cannot get
     to, every reload serves the same broken page, and the app has no way to
     tell them why. A cached document that is a day old is a small cost; a
     cached document that is wrong is the whole app.

     There is a timeout rather than a plain network-first so a tunnel still gets
     the page — that is what the worker is for — and the /app/* bundles below
     stay stale-while-revalidate, because they are big, they are versioned by
     SHELL, and none of them is what a reader is looking at.

     It was two seconds, and two seconds is inside the range a phone on cellular
     answers in: the timeout was firing on connections that were about to work,
     which handed the reader the cached copy — and if that copy is the broken
     one, this is the mechanism that keeps handing it to them. Eight is past
     where a working request lands and still short of giving up on the page. The
     document's own stamp check is the backstop underneath this; the point of
     the longer wait is to not need it. */
  const DOC_NET_MS = 8000;

  if (DOCS.indexOf(url.pathname) >= 0) {
    e.respondWith(
      new Promise((resolve) => {
        let settled = false;
        const done = (r) => { if (!settled && r) { settled = true; resolve(r); } };
        const fallback = () => caches.match(req).then((hit) => done(hit
          || new Response('<!doctype html><meta charset="utf-8"><title>offline</title>'
            + '<p style="font:16px system-ui;padding:2rem;text-align:center">אין חיבור — נסו שוב.<br>Offline — try again.</p>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } })));
        const timer = setTimeout(fallback, DOC_NET_MS);
        fetch(req)
          .then(dropDataIfUnauthorised)
          .then((res) => {
            clearTimeout(timer);
            if (res && res.ok && res.status === 200) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(req, copy));
            }
            done(res);
          })
          .catch(() => { clearTimeout(timer); fallback(); });
      })
    );
    return;
  }

  /* Stale-while-revalidate for everything else in the shell: answer from the
     cache if we have it, and refresh in the background either way. */
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then(dropDataIfUnauthorised)
        .then((res) => {
          /* A 401 here is the sign-in redirect, not the page. Caching that
             would pin every future visit to a login screen. */
          if (res && res.ok && res.status === 200) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
