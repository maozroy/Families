/* Family relations both pages have to agree about.
 *
 * A classic script, sibling of colors.js and origin.js, for the same reason
 * those exist: the tree draws a person's close family as chips in a panel and
 * the map draws it as chips in a sheet, in two entirely different idioms — but
 * the two must never disagree about the *facts*. Wording stays in each page's
 * own translation table, where every other string on these pages lives; what
 * lives here is the judgement.
 */
(function (root) {
  /**
   * Two people who share a parent: half-siblings, or just siblings?
   *
   * "Half" is a claim about the family, and a parent merely missing from the
   * tree is not evidence for it. The obvious test — "they share fewer than two
   * parents" — read a set of brothers and an in-law pair
   * as half-siblings purely because a single parent is recorded for each of
   * them: four pairs libelled to save a condition. Say half only where both
   * sides have two parents on record and only one of them matches.
   *
   * Takes the two parent-id arrays, so it does not care what shape a person is
   * on the page calling it.
   */
  function halfSibs(pa, pb) {
    const a = pa || [], b = pb || [];
    if (a.length !== 2 || b.length !== 2) return false;
    return a.filter(x => b.indexOf(x) >= 0).length < 2;
  }

  /**
   * Everyone above one person, and how many generations up they sit.
   *
   * Parents only — a spouse is not an ancestor and neither is a step-parent the
   * tree has no link for. Capped at fourteen because a cycle in the data (two
   * people each recorded as the other's parent, which a typo can produce)
   * would otherwise hang the page rather than draw it slightly wrong.
   */
  const MAXUP = 14;

  /* The original breadth-first walk, kept as the reference implementation.
     ancestorsOf() below must agree with it for every input — scripts/
     kinship-selftest.mjs asserts exactly that, over the real tree and over
     synthetic cycles, pedigree collapse, missing parents and chains deeper
     than the cap. Also the fallback where WeakMap is unavailable. */
  function ancestorsBfs(P, id) {
    const out = {};
    out[id] = 0;
    let frontier = [id], d = 0;
    while (frontier.length && d < MAXUP) {
      const next = [];
      frontier.forEach(x => {
        if (!P[x]) return;
        (P[x].parents || []).forEach(pa => { if (!(pa in out)) { out[pa] = d + 1; next.push(pa); } });
      });
      frontier = next; d++;
    }
    return out;
  }

  /* One person's ancestors, built from their PARENTS' ancestors and memoised.
   *
   * relate() asks for both sides on every call, and a page relates one root to
   * everybody, so the root's set was being walked once per person — 1,284 walks
   * for one screen. A person's ancestors are their parents' sets shifted down a
   * generation, so each is computed once and every descendant reuses it.
   *
   * The cache is a WeakMap keyed on P ITSELF, which is what makes it safe to
   * hold: tree-v2's base() builds a brand-new P whenever state.rev moves, so an
   * edit cannot be served a stale set — the old P is simply unreachable and the
   * entry goes with it. Keying on person id in a module-level object would
   * survive the edit and hand back the pre-edit tree, which is the bug this
   * shape exists to avoid.
   *
   * FOUR THINGS THE SHIFT-AND-MERGE MUST GET RIGHT, all asserted by the test:
   *   min, not first — with pedigree collapse the same ancestor is reached at
   *     two depths and the SHORTER one names the relation. Object key order
   *     would otherwise decide it.
   *   unknown parents still count — a parent id with no row is recorded at its
   *     depth and simply has no ancestors of its own, exactly as the BFS did.
   *   the cap is a cycle guard — depths above MAXUP are dropped, so a person
   *     recorded as their own ancestor terminates instead of hanging the page.
   *   a cyclic result is never memoised — it is truncated by whichever entry
   *     the walk happened to start from, so caching it would leak that
   *     arbitrary starting point into later answers.
   *
   * The returned object is SHARED. Callers read it (relate, and tree-v2's
   * ancestors()); nobody may mutate it.
   */
  const ANC_CACHE = typeof WeakMap === 'function' ? new WeakMap() : null;

  function ancestorsOf(P, id) {
    if (!ANC_CACHE) return ancestorsBfs(P, id);
    let memo = ANC_CACHE.get(P);
    if (!memo) { memo = new Map(); ANC_CACHE.set(P, memo); }
    return ancWalk(P, id, memo, Object.create(null)).out;
  }

  function ancWalk(P, id, memo, onPath) {
    const hit = memo.get(id);
    if (hit) return { out: hit, cyclic: false };
    if (onPath[id]) return { out: null, cyclic: true };   // back-edge: stop here

    onPath[id] = true;
    const out = {};
    out[id] = 0;
    let cyclic = false;
    const parents = (P[id] && P[id].parents) || [];
    for (let i = 0; i < parents.length; i++) {
      const pa = parents[i];
      if (out[pa] === undefined || out[pa] > 1) out[pa] = 1;
      if (!P[pa]) continue;                                // unknown: recorded, not walked
      const sub = ancWalk(P, pa, memo, onPath);
      if (sub.cyclic) { cyclic = true; continue; }
      for (const k in sub.out) {
        const nd = sub.out[k] + 1;
        if (nd > MAXUP) continue;
        if (out[k] === undefined || out[k] > nd) out[k] = nd;   // shortest wins
      }
    }
    onPath[id] = false;

    if (!cyclic) memo.set(id, out);
    return { out, cyclic };
  }

  /**
   * How B is related to A, as structure rather than words.
   *
   * This was the tree's own method until the map needed the same answer for its
   * legend. It returns a descriptor and never a string, which is what makes an
   * English tree possible at all and what lets two pages with entirely separate
   * translation tables agree about a fact: the tree says "my great-grandmother"
   * and the map may say it differently, but they can never disagree about
   * WHICH great-grandmother, or about whether she is one.
   *
   * `gen` on every descriptor: how many generations BELOW a that b sits. 0 is
   * the same level, -1 a parent's generation, +1 a child's. It is not a new
   * traversal — every branch below already knows the two distances to the
   * common ancestor, and the answer is just their difference. `blood` says
   * whether that common ancestor exists at all, which is the other half of the
   * question "who is my generation" and the reason the two ship together.
   *
   * Deliberately NOT people.generation, which is one integer measured from the
   * tree's root person and stored on the row. It cannot answer this for anyone else, and it is
   * blank for the one person nobody has placed.
   *
   * P wants `parents`, `spouse` and `g` on each row, with spouse links pointing
   * both ways — a page whose data has them one-directional has to symmetrise
   * before calling, or half its marriages read as no relation at all.
   */
  function relate(P, a, b, depth) {
    const d0 = depth || 0;
    const A = P[a], B = P[b];
    if (!A || !B) return { kind: 'none' };
    if (a === b) return { kind: 'self', gen: 0, blood: true };
    const f = B.g === 'f';
    // Not the same thing as `!f`: 11 people in this tree have no sex on
    // record, and every gendered label was calling all of them male.
    const gu = !B.g;
    // A marriage is the one relation that crosses no generation at all.
    if (A.spouse === b) return { kind: 'spouse', f, gu, gen: 0, blood: false, ex: !!(A.spouseEx || B.spouseEx) };

    const Aa = ancestorsOf(P, a), Ba = ancestorsOf(P, b);
    if (b in Aa) return { kind: 'ancestor', up: Aa[b], f, gu, gen: -Aa[b], blood: true };
    if (a in Ba) return { kind: 'descendant', down: Ba[a], f, gu, gen: Ba[a], blood: true };

    let best = null;
    Object.keys(Aa).forEach(c => {
      if (!(c in Ba)) return;
      const u = Aa[c], v = Ba[c];
      if (!best || u + v < best.u + best.v || (u + v === best.u + best.v && Math.abs(u - v) < Math.abs(best.u - best.v))) best = { u, v, c };
    });

    if (best) {
      /* a is u generations below the shared ancestor and b is v, so b sits
         v - u below a. That is the whole of it: "removed" on a cousin has
         always been the size of this number, and now the sign travels too. */
      const { u, v, c } = best;
      const gen = v - u;

      /* Half travels DOWN the tree, it does not stop at siblings.
         Two women can both be daughters of one mother by two different
         fathers. That makes בלה a HALF grand-aunt — and it was only
         being seen when the pair themselves were the two people being compared
         (u===1 && v===1). Every aunt, nephew and cousin whose descent runs
         through a half-sibling pair was reported as full.
         So the pair at the top of the path is found and asked. halfSibs()
         refuses to answer unless BOTH of them have two parents on record, which
         is what keeps an unresearched parent from being read as a second
         marriage. */
      const onLine = (X, Xa, d) => {
        if (d === 0) return X;
        const ids = Object.keys(Xa);
        for (let i = 0; i < ids.length; i++) {
          if (Xa[ids[i]] === d && P[ids[i]] && (P[ids[i]].parents || []).indexOf(c) >= 0) return ids[i];
        }
        return null;
      };
      const xa = onLine(a, Aa, u - 1), xb = onLine(b, Ba, v - 1);
      const half = !!(xa && xb && P[xa] && P[xb] && halfSibs(P[xa].parents, P[xb].parents));

      if (u === 1 && v === 1) return { kind: 'sibling', half: halfSibs(A.parents, B.parents), f, gu, gen, blood: true };
      if (u === 1) return { kind: 'nibling', k: v - 1, half, f, gu, gen, blood: true };   // sibling's child / grandchild
      if (v === 1) return { kind: 'pibling', k: u - 1, half, f, gu, gen, blood: true };   // parent's sibling
      return { kind: 'cousin', deg: Math.min(u, v) - 1, removed: Math.abs(u - v), half, f, gu, gen, blood: true };
    }

    if (d0 > 0) return { kind: 'none' };

    // Not blood: try through B's spouse, then through A's.
    /* Married in, so `blood` is false throughout — and the generation is
       whoever they married, because a marriage crosses none. That is what puts
       a cousin's husband on your level and your nephew's wife one below. */
    if (B.spouse && P[B.spouse]) {
      const inner = relate(P, a, B.spouse, d0 + 1);
      if (inner.kind !== 'none') {
        if (inner.kind === 'sibling') return { kind: 'sibling-in-law', f, gu, gen: 0, blood: false };
        if (inner.kind === 'descendant' && inner.down === 1) return { kind: 'child-in-law', f, gu, gen: 1, blood: false };
        /* Your aunt's husband is your uncle. Not "the husband of your aunt" —
           nobody has ever introduced him that way, in Hebrew or in English,
           and the tree was calling him בעל הדודה because the marriage is the
           only thing linking you. `blood` still says how he got there, which
           is what the tree colours and counts by; only the word changes. Held
           to the first generation: a great-aunt's husband is far enough out
           that spelling the marriage is the clearer answer. */
        /* An aunt's husband is your uncle — but her EX-husband is not, and
           calling him one erases a divorce the family knows about. A marriage
           that ended keeps the marriage in the word. */
        if (inner.kind === 'pibling' && inner.k === 1 && !B.spouseEx) {
          return { kind: 'pibling', k: 1, f, gu, gen: inner.gen, blood: false };
        }
        return { kind: 'spouse-of', inner, f, gu, gen: inner.gen, blood: false, ex: !!B.spouseEx };
      }
    }
    if (A.spouse && P[A.spouse]) {
      const inner = relate(P, A.spouse, b, d0 + 1);
      if (inner.kind !== 'none') {
        if (inner.kind === 'ancestor' && inner.up === 1) return { kind: 'parent-in-law', f, gu, gen: -1, blood: false };
        if (inner.kind === 'sibling') return { kind: 'sibling-in-law', f, gu, gen: 0, blood: false };
        return { kind: 'via-spouse', inner, f, gu, spouseF: A.g === 'f', gen: inner.gen, blood: false };
      }
    }

    /* Two marriages, one word.
     *
     * My wife's brother's wife is my גיסה, and so is my wife's sister's
     * husband my גיס — Hebrew does not walk that path out loud, and neither
     * does English ("co-sibling-in-law" is a term for genealogists, not for
     * people). Both branches above stop after a single marriage, so this pair
     * used to come out of relate() as no relation at all and get spelled as a
     * route: "אשת האח של אשתי". Three links to say גיסתי.
     *
     * Deliberately the ONE extra rule rather than a deeper recursion. Letting
     * the branches above nest would name thousands of distant pairs through
     * compounds nobody says — "the spouse of the spouse of my mother's
     * cousin" — and the honest "no family connection", with the route under
     * it, beats a phrase that is technically derivable and never spoken. The
     * condition is exact: both sides are married, and the two spouses are
     * siblings by blood. Nothing else matches it.
     */
    if (A.spouse && B.spouse && P[A.spouse] && P[B.spouse]) {
      const spouses = relate(P, A.spouse, B.spouse, d0 + 1);
      if (spouses.kind === 'sibling') return { kind: 'sibling-in-law', f, gu, gen: 0, blood: false };
    }
    return { kind: 'none' };
  }

  /**
   * The route from one person to another, step by step.
   *
   * What relate() cannot reach — two marriages out, where a single kinship word
   * runs out — this can still describe: [up, spouse, down] is "my parent's
   * spouse's child". Each step carries the person it lands on, because the word
   * for a step depends on who it lands on ("the mother", "the wife").
   */
  function pathBetween(P, a, b) {
    if (a === b) return [];
    const kids = childIndex(P);
    const edges = (id) => {
      const p = P[id], out = [];
      if (!p) return out;
      (p.parents || []).forEach(x => { if (P[x]) out.push([x, 'up']); });
      (kids[id] || []).forEach(x => out.push([x, 'down']));
      if (p.spouse && P[p.spouse]) out.push([p.spouse, 'spouse']);
      return out;
    };
    const prev = {}; prev[a] = null;
    let q = [a];
    while (q.length) {
      const nq = [];
      for (const cur of q) {
        for (const [nx, t] of edges(cur)) {
          if (nx in prev) continue;
          prev[nx] = [cur, t];
          if (nx === b) {
            const hops = []; let x = b;
            while (prev[x]) { hops.unshift({ id: x, type: prev[x][1] }); x = prev[x][0]; }
            return hops;
          }
          nq.push(nx);
        }
      }
      q = nq;
    }
    return null;
  }

  /**
   * A route in its shortest honest form: up-then-down is a sibling.
   *
   * Without this every sibling in a chain reads as "my father's son", which is
   * both longer and a strange thing to call your brother. Half-siblings keep
   * their own step, because that IS the shorter true statement.
   */
  function collapsePath(P, a, hops) {
    let types = hops.map(h => h.type);
    let ids = [a].concat(hops.map(h => h.id));
    let i = 0;
    while (i < types.length - 1) {
      if (types[i] === 'up' && types[i + 1] === 'down') {
        const from = P[ids[i]], to = P[ids[i + 2]];
        const shared = (from.parents || []).filter(x => (to.parents || []).indexOf(x) >= 0).length;
        types.splice(i, 2, shared >= 2 ? 'sib' : 'half');
        ids.splice(i + 1, 1);
      } else i++;
    }
    return types.map((t, k) => ({ type: t, id: ids[k + 1] }));
  }

  /** Who is whose child, from the parent links, which are the ones on the row. */
  function childIndex(P) {
    const kids = {};
    Object.keys(P).forEach(id => {
      (P[id].parents || []).forEach(pa => { (kids[pa] = kids[pa] || []).push(id); });
    });
    return kids;
  }

  /**
   * How far everyone sits from one person, counted in family steps.
   *
   * A step is a parent, a child or a spouse — the three edges the tree draws —
   * so a grandmother is two, an aunt three, and a wife one. That is the same
   * number a reader would count on the page with a finger, which is the whole
   * reason it is hops and not generations: generations put your sister and your
   * second cousin at the same distance, and nobody thinks of them that way.
   *
   * Takes the people index by id, and builds its own child index from the
   * parent links so a caller that has no `kids` on its rows (the map) gets the
   * same answer as one that does (the tree).
   */
  function distances(P, from) {
    const out = {};
    if (!P || !P[from]) return out;
    const kids = childIndex(P);
    /* Twice: once over blood alone, once over blood and marriage. A node is
       "blood" when the two agree, which is to say when the shortest way to it
       never passes through a wedding. Two passes rather than one carrying a
       flag, because a flag has to survive being reached from several sides at
       the same depth, and getting that subtly wrong reads as an arbitrary
       preference for whoever the loop happened to see first. */
    const walk = (married) => {
      const seen = { [from]: 0 };
      let frontier = [from], d = 0;
      while (frontier.length) {
        const next = [];
        frontier.forEach(id => {
          const p = P[id];
          if (!p) return;
          const step = (x) => { if (x && P[x] && !(x in seen)) { seen[x] = d + 1; next.push(x); } };
          (p.parents || []).forEach(step);
          (kids[id] || []).forEach(step);
          if (married) step(p.spouse);
        });
        frontier = next; d++;
      }
      return seen;
    };
    const blood = walk(false), all = walk(true);
    Object.keys(all).forEach(id => { out[id] = { hops: all[id], blood: blood[id] === all[id] }; });
    return out;
  }

  /**
   * Who best answers "how am I related to that family", best candidate first.
   *
   * An ordered list rather than one winner, because whether a person can be put
   * into WORDS is not something this file knows: a page's own relation
   * vocabulary runs out well before the graph does — two marriages deep and the
   * honest answer is "no family connection" even though a path exists. The
   * caller walks this list until it finds someone it can actually name, which
   * is the difference between "my brother-in-law's mother" and a subtitle that
   * says a family you married into is unrelated to you.
   *
   * The order: closest first, because a family is reached THROUGH somebody and
   * the reader wants the shortest way in. Blood before marriage at the same
   * distance — a grandmother is a better way into her family than a brother's
   * wife is. Then the oldest, which puts the senior name on the line and,
   * unlike "first in the array", gives the same answer on every render and on
   * both pages; whoever has no birth year at all sorts last rather than first,
   * because a blank is not evidence of age.
   *
   * `groupOf` is the caller's own idea of a family, so this file does not have
   * to know that a family key is a branch minus its suffix — nor that the two
   * pages disagree about it on purpose. The tree folds a person into the one
   * family they were born into; the map counts a spouse into the family they
   * married into as well, because that is the set its filter draws. So the
   * callback may hand back one key or several, and somebody who married in is
   * a legitimate way into their in-laws on the page that thinks so.
   *
   * Families with nobody reachable are simply absent — that is a real answer,
   * and it is the caller's to word.
   */
  function rankPerGroup(P, from, groupOf) {
    const dist = distances(P, from);
    const out = {};
    Object.keys(dist).forEach(id => {
      const p = P[id];
      if (!p) return;
      const g = groupOf(p);
      (Array.isArray(g) ? g : [g]).forEach(k => { (out[k] = out[k] || []).push(id); });
    });
    Object.keys(out).forEach(g => {
      out[g].sort((x, y) => {
        const dx = dist[x], dy = dist[y];
        if (dx.hops !== dy.hops) return dx.hops - dy.hops;
        if (dx.blood !== dy.blood) return dx.blood ? -1 : 1;
        return olderFirst(P[x], P[y]);
      });
    });
    return out;
  }

  /** Oldest first; an unknown birth year goes last, and id breaks the last tie. */
  function olderFirst(a, b) {
    const ba = String((a && a.born) || ''), bb = String((b && b.born) || '');
    if (!ba !== !bb) return ba ? -1 : 1;
    if (ba !== bb) return ba < bb ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : 1;
  }

  /**
   * Who introduces a family to the reader, and on what terms.
   *
   * Handed the ranked candidates from rankPerGroup(), this walks outwards and
   * returns the first one it can honestly say something about:
   *
   *   { self: true }   the reader is in this family
   *   { id, rel }      a relation with a word for it — "my great-grandmother"
   *   { id, hops }     no single word, but a route — "my brother's wife's mother"
   *   null             nothing, and the caller should say so plainly
   *
   * Why not simply the closest: relate() reaches blood and one marriage, and
   * past that says "no family connection". Used as a subtitle that came out as
   * "אין קשר משפחתי שלי" — not a sentence, and a lie about a family the reader
   * married into. So a named relation outranks a nearer unnameable one, and a
   * route is better than a shrug.
   *
   * `maxLinks` caps the route, because past about four a chain has stopped
   * being a relationship and become directions. The route is returned uncollapsed
   * — chainLabel() collapses it — but the cap is measured on the collapsed form,
   * which is what a reader would actually be asked to follow.
   */
  function introduce(P, from, candidates, maxLinks) {
    const list = candidates || [];
    const cap = maxLinks || 4;
    let first = '';
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      if (id === from) return { self: true };
      if (!first) first = id;
      const rel = relate(P, from, id, 0);
      if (rel.kind !== 'none') return { id, rel };
    }
    if (!first) return null;
    const hops = pathBetween(P, from, first);
    if (!hops || !hops.length) return null;
    const route = collapsePath(P, from, hops);

    /* Whose family it is.
     *
     * A `branch` records how somebody entered the tree, not what line they
     * came from: a man married into another family, so he is filed under it,
     * and his OWN family — his parents and sisters — had nobody in it closer to
     * the reader than his mother. Hence "האמא של בעל האחות של אמי", four links
     * to reach a family whose whole claim on the reader is that it is their
     * uncle's.
     *
     * So when the last step of the route is a step WITHIN the family — a
     * parent, a child, a sibling, never a marriage — the person it steps from
     * is of that family whatever their branch says, and they are returned like
     * any other member: his birth family's row is introduced by "דודי אבי". Only the
     * last step, and only that person: reaching back further would name a
     * house after somebody who is genuinely not in it.
     */
    if (route.length >= 2 && route[route.length - 1].type !== 'spouse') {
      const bridge = route[route.length - 2].id;
      const rel = relate(P, from, bridge, 0);
      if (rel.kind !== 'none') return { id: bridge, rel };
    }
    return route.length <= cap ? { id: first, hops } : null;
  }

  /* ───────── the words ─────────
   *
   * Kinship vocabulary, which is the one kind of wording this file does keep.
   * The rule everywhere else on these pages is that strings live in the page's
   * own translation table — but "is she a גיסה or a כלה" is not a caption, it
   * is the same judgement relate() makes, said out loud. Two tables would be
   * two answers to that, and the whole point of this file is that there is one.
   * A page's own words for its own furniture stay in its own table.
   *
   * The tree wrote these; the map now says them too, so a family introduced as
   * "my great-grandmother" on one page is not "my mother's mother's mother" on
   * the other.
   */
  /* "half" in front in English, " למחצה" behind in Hebrew — the shape the
     tree's own hand-written labels already used ("half great-aunt",
     "דודה מדרגה שנייה למחצה"). */
  const HALF = (rel, en, t) => (rel && rel.half ? (en ? 'half ' + t : t + ' למחצה') : t);
  const ORD_M = ['', '', 'שני', 'שלישי', 'רביעי', 'חמישי'];
  const ORD_F = ['', 'אחת', 'שנייה', 'שלישית', 'רביעית', 'חמישית'];
  const ANC = [[], ['אבא', 'אמא'], ['סבא', 'סבתא'], ['סבא רבא', 'סבתא רבתא'], ['סבא רבא רבא', 'סבתא רבתא רבתא']];
  const DESC = [[], ['בן', 'בת'], ['נכד', 'נכדה'], ['נין', 'נינה'], ['נין רבא', 'נינה רבתא']];
  const ORD_EN = ['', 'first', 'second', 'third', 'fourth', 'fifth'];
  const TIMES_EN = ['', 'once', 'twice', 'three times', 'four times', 'five times'];
  const greats = (n, base) => 'great-'.repeat(Math.max(0, n)) + base;

  /** A descriptor from relate(), in words. Hebrew reproduces the original wording. */
  function label(rel, lang) {
      const f = !!rel.f;

      /* Somebody whose sex nobody has filled in.
         `f` is `B.g === 'f'`, so every branch below reads a missing value as
         male and calls an 11-year-old girl her brother's brother. A guess
         presented as a fact about a real person is worse than a word that
         declines to guess, so these get the neutral term — and only these:
         where the sex IS on record nothing about the wording changes.
         Hebrew has no neutral singular, so it says both. */
      if (rel.gu) {
        const en = lang === 'en';
        const many = (k, one) => (k > 1 ? (en ? greats(k - 2, one) : one + ' מדרגה ' + ORD_F[k]) : one);
        switch (rel.kind) {
          case 'spouse': return rel.ex ? (en ? 'former spouse' : 'בן/בת זוג לשעבר')
            : (en ? 'spouse' : 'בן/בת זוג');
          case 'ancestor': return rel.up === 1 ? (en ? 'parent' : 'הורה')
            : (en ? greats(rel.up - 2, 'grandparent') : 'סב/תא' + (rel.up > 2 ? ' רבא' : ''));
          case 'descendant': return rel.down === 1 ? (en ? 'child' : 'ילד/ה')
            : (en ? greats(rel.down - 2, 'grandchild') : 'נכד/ה' + (rel.down > 2 ? ' רבא' : ''));
          case 'sibling': return en ? (rel.half ? 'half-sibling' : 'sibling')
            : 'אח/ות' + (rel.half ? ' למחצה' : '');
          case 'nibling': return HALF(rel, en, many(rel.k, en ? "sibling's child" : 'אחיין/ית'));
          case 'pibling': return HALF(rel, en, many(rel.k, en ? "parent's sibling" : 'דוד/ה'));
          case 'sibling-in-law': return en ? 'sibling-in-law' : 'גיס/ה';
          case 'child-in-law': return en ? 'child-in-law' : 'חתן/כלה';
          case 'parent-in-law': return en ? 'parent-in-law' : 'חם/חמות';
          case 'spouse-of': return en ? label(rel.inner, lang) + (rel.ex ? "'s former spouse" : "'s spouse")
            : (rel.ex ? 'בן/בת הזוג לשעבר של ' : 'בן/בת הזוג של ') + label(rel.inner, lang);
          /* A cousin IS the same word either way in English — "second cousin
             once removed" names nobody's sex. It is NOT in Hebrew: the table
             below is `f ? 'בת דודה' : 'בן דוד'`, so falling through handed the
             MALE form to all 25 people whose sex nobody has filled in, which is
             the exact failure this block exists to prevent. Degree and removal
             are counted with ORD_F here, as `מדרגה`/`בהסרה` are feminine — the
             same construction the neutral pibling and nibling forms use. */
          case 'cousin': {
            if (en) break;
            let t = 'בן/בת דוד';
            if (rel.deg > 1) t += ' מדרגה ' + ORD_F[rel.deg];
            if (rel.removed > 0) t += ' בהסרה ' + ORD_F[rel.removed];
            return HALF(rel, en, t);
          }
          // 'self' and 'none' say the same thing either way, so they fall
          // through to the tables below rather than being restated here.
          default: break;
        }
      }

      if (lang === 'en') {
        switch (rel.kind) {
          case 'self': return 'the same person';
          case 'spouse': return (rel.ex ? 'ex-' : '') + (f ? 'wife' : 'husband');
          case 'ancestor': return rel.up === 1 ? (f ? 'mother' : 'father')
            : greats(rel.up - 2, f ? 'grandmother' : 'grandfather');
          case 'descendant': return rel.down === 1 ? (f ? 'daughter' : 'son')
            : greats(rel.down - 2, f ? 'granddaughter' : 'grandson');
          case 'sibling': return (rel.half ? 'half-' : '') + (f ? 'sister' : 'brother');
          case 'nibling': return HALF(rel, true, rel.k === 1 ? (f ? 'niece' : 'nephew')
            : greats(rel.k - 2, f ? 'grand-niece' : 'grand-nephew'));
          case 'pibling': return HALF(rel, true, rel.k === 1 ? (f ? 'aunt' : 'uncle')
            : greats(rel.k - 2, f ? 'grand-aunt' : 'grand-uncle'));
          case 'cousin': {
            let t = (ORD_EN[rel.deg] || rel.deg + 'th') + ' cousin';
            if (rel.removed > 0) t += ' ' + (TIMES_EN[rel.removed] || rel.removed + ' times') + ' removed';
            return HALF(rel, true, t);
          }
          case 'sibling-in-law': return f ? 'sister-in-law' : 'brother-in-law';
          case 'child-in-law': return f ? 'daughter-in-law' : 'son-in-law';
          case 'parent-in-law': return f ? 'mother-in-law' : 'father-in-law';
          // Built as compound nouns so that "my " + label reads correctly.
          case 'spouse-of': return label(rel.inner, lang) + "'s " + (rel.ex ? 'ex-' : '') + (f ? 'wife' : 'husband');
          case 'via-spouse': return (rel.spouseF ? 'husband' : 'wife') + "'s " + label(rel.inner, lang);
          default: return 'no family connection';
        }
      }
      switch (rel.kind) {
        case 'self': return 'אותו אדם';
        case 'spouse': return (f ? 'אישה' : 'בעל') + (rel.ex ? ' לשעבר' : '');
        case 'ancestor': return (ANC[rel.up] || ['אב קדמון', 'אם קדמונית'])[f ? 1 : 0];
        case 'descendant': return (DESC[rel.down] || ['צאצא', 'צאצאית'])[f ? 1 : 0];
        case 'sibling': return (f ? 'אחות' : 'אח') + (rel.half ? ' למחצה' : '');
        case 'nibling': return HALF(rel, false, (f ? 'אחיינית' : 'אחיין') + (rel.k > 1 ? ' מדרגה ' + ORD_F[rel.k] : ''));
        case 'pibling': return HALF(rel, false, (f ? 'דודה' : 'דוד') + (rel.k > 1 ? ' מדרגה ' + ORD_F[rel.k] : ''));
        case 'cousin': {
          let t = f ? 'בת דודה' : 'בן דוד';
          if (rel.deg > 1) t += ' ' + (f ? ORD_F[rel.deg] : ORD_M[rel.deg]);
          if (rel.removed > 0) t += ' בהסרה ' + ORD_F[rel.removed];
          return HALF(rel, false, t);
        }
        case 'sibling-in-law': return f ? 'גיסה' : 'גיס';
        case 'child-in-law': return f ? 'כלה' : 'חתן';
        case 'parent-in-law': return f ? 'חמות' : 'חם';
        case 'spouse-of': {
          const t = label(rel.inner, lang);
          const sfx = rel.ex ? ' לשעבר' : '';
          return t.indexOf(' ') < 0 ? (f ? 'אשת ה' : 'בעל ה') + t + sfx
            : (f ? 'בת הזוג' : 'בן הזוג') + sfx + ' של ' + t;
        }
        case 'via-spouse': return label(rel.inner, lang) + ' של ' + (rel.spouseF ? 'הבעל' : 'האישה');
        default: return 'אין קשר משפחתי';
      }
    }

  /**
   * One step of a route, in words: "the mother", "the wife".
   *
   * Definite in Hebrew because a chain reads "the mother OF the wife of my
   * brother"; bare in English because it reads "my brother's wife's mother".
   * Which of the two a page stacks is the page's business — the words are not.
   */
  function stepWord(type, isF, lang) {
    if (lang === 'en') {
      if (type === 'up') return isF ? 'mother' : 'father';
      if (type === 'down') return isF ? 'daughter' : 'son';
      if (type === 'spouse') return isF ? 'wife' : 'husband';
      if (type === 'sib') return isF ? 'sister' : 'brother';
      return isF ? 'half-sister' : 'half-brother';
    }
    if (type === 'up') return isF ? 'האמא' : 'האבא';
    if (type === 'down') return isF ? 'הבת' : 'הבן';
    if (type === 'spouse') return isF ? 'האישה' : 'הבעל';
    if (type === 'sib') return isF ? 'האחות' : 'האח';
    return isF ? 'האחות למחצה' : 'האח למחצה';
  }

  /**
   * A whole route in words, first person: "my brother's wife's mother".
   *
   * The chain both pages fall back to where a single kinship word runs out.
   * Hebrew stacks its possessives the other way round from English, which is
   * the only thing this does beyond joining: "האמא של האישה של האח" reads
   * outside-in, "brother's wife's mother" inside-out.
   */
  function chainLabel(P, from, hops, lang) {
    if (!hops || !hops.length) return '';
    const steps = collapsePath(P, from, hops);

    /* Name the longest run this file HAS a word for, then chain only what is
       left. Without this the route is spelled out step by step from the root
       and "aunt's husband's father" comes out "mother's sister's husband's
       father" — longer, and it makes the reader re-derive a relation we can
       already name. Longest-first because "aunt" should beat "mother's
       sister"; the walk stops before the last step so something is always
       chained, which is what makes this a chain and not a relabelling of
       relate(). */
    let head = '', rest = steps;
    for (let k = steps.length - 1; k >= 1; k--) {
      const rel = relate(P, from, steps[k - 1].id, 0);
      if (rel && rel.kind !== 'none') {
        const t = label(rel, lang);
        if (t && t !== 'no family connection' && t !== 'אין קשר משפחתי') { head = t; rest = steps.slice(k); break; }
      }
    }

    const words = rest.map(h => stepWord(h.type, P[h.id] && P[h.id].g === 'f', lang));
    if (lang === 'en') return head ? [head].concat(words).join("'s ") : words.join("'s ");
    /* Hebrew stacks outside-in, so the named head is the innermost thing and
       goes last — "האבא של הבעל של הדודה". */
    return (head ? words.reverse().concat(head) : words.reverse()).join(' של ');
  }

  /* ───────── the short way of saying it ─────────
   *
   * "גיסה שלי" is how you write it out; "גיסתי" is how anybody says it. Hebrew
   * carries the possessive in the word, and a list of families is exactly the
   * place that pays off — every line is about the same person, me, so the
   * "שלי" on the end of each of them is a word repeated fourteen times to no
   * effect.
   *
   * Only where the suffixed form is the one people actually use. "סבא רבא שלי"
   * has no short form worth having and "בן דוד שני בהסרה אחת" cannot take one
   * at all, so those keep the long way round rather than getting an invention.
   * Anyone whose sex is not on record keeps it too: Hebrew's suffix picks a
   * side, and that is the guess this file refuses to make everywhere else.
   */
  function shortHe(rel) {
    if (rel.gu) return '';
    const f = !!rel.f;
    switch (rel.kind) {
      case 'spouse': return f ? 'אשתי' : 'בעלי';
      case 'ancestor': return rel.up === 1 ? (f ? 'אמי' : 'אבי')
        : rel.up === 2 ? (f ? 'סבתי' : 'סבי') : '';
      case 'descendant': return rel.down === 1 ? (f ? 'בתי' : 'בני')
        : rel.down === 2 ? (f ? 'נכדתי' : 'נכדי') : '';
      case 'sibling': return (f ? 'אחותי' : 'אחי') + (rel.half ? ' למחצה' : '');
      case 'nibling': return rel.k === 1 ? (f ? 'אחייניתי' : 'אחייני') : '';
      case 'pibling': return rel.k === 1 ? (f ? 'דודתי' : 'דודי') : '';
      case 'cousin': return (rel.deg === 1 && !rel.removed) ? (f ? 'בת דודתי' : 'בן דודי') : '';
      case 'sibling-in-law': return f ? 'גיסתי' : 'גיסי';
      case 'child-in-law': return f ? 'כלתי' : 'חתני';
      case 'parent-in-law': return f ? 'חמותי' : 'חמי';
      default: return '';
    }
  }

  /**
   * What this person is to the reader: "גיסתי", "my sister-in-law".
   *
   * English has no shorter form than "my X", so there it is exactly the label
   * with a possessive in front. Hebrew takes the suffix where one exists and
   * falls back to "X שלי" where it does not.
   */
  function mine(rel, lang) {
    if (lang === 'en') return 'my ' + label(rel, 'en');
    return shortHe(rel) || (label(rel, 'he') + ' שלי');
  }

  /** The innermost step of a route, carrying the possessive: "אחי", "אשתי". */
  function stepMineHe(type, isF) {
    if (type === 'up') return isF ? 'אמי' : 'אבי';
    if (type === 'down') return isF ? 'בתי' : 'בני';
    if (type === 'spouse') return isF ? 'אשתי' : 'בעלי';
    if (type === 'sib') return isF ? 'אחותי' : 'אחי';
    return (isF ? 'אחותי' : 'אחי') + ' למחצה';
  }

  /**
   * A route, said the way somebody would say it out loud.
   *
   * "האבא של האישה של האח של האמא שלי" is eight words of scaffolding for four
   * facts. Hebrew binds these with the construct state instead: the step
   * closest to the reader takes the possessive suffix, a marriage binds
   * straight onto what follows it — "אשת אחי", "בעל האחות" — and only a parent
   * or a child keeps its "של", because "אם אשת אחי" is a sentence out of a
   * ketubah and not out of a kitchen. The same four facts come out as "האבא של
   * אשת האח של אמי".
   *
   * English is left alone: "my brother's wife's father" is already as short as
   * that language gets.
   */
  function chainMine(P, from, hops, lang) {
    if (!hops || !hops.length) return '';
    const steps = collapsePath(P, from, hops)
      .map(h => ({ type: h.type, f: !!(P[h.id] && P[h.id].g === 'f') }));
    if (lang === 'en') return 'my ' + steps.map(s => stepWord(s.type, s.f, 'en')).join("'s ");
    let phrase = stepMineHe(steps[0].type, steps[0].f);
    for (let i = 1; i < steps.length; i++) {
      const s = steps[i];
      phrase = s.type === 'spouse'
        ? (s.f ? 'אשת ' : 'בעל ') + phrase
        : stepWord(s.type, s.f, 'he') + ' של ' + phrase;
    }
    return phrase;
  }

  root.FamilyRelations = {
    halfSibs, ancestorsOf, ancestorsBfs, relate, pathBetween, collapsePath, distances, rankPerGroup,
    introduce, label, mine, stepWord, chainLabel, chainMine,
  };
})(globalThis);
