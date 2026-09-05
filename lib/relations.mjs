/* The kinship calculator, as a module Node can import.
 *
 * THE CALCULATOR ITSELF IS web/public/app/relations.js, and there is exactly
 * one of it. That file is a classic browser script — the tree and the map load
 * it with <script src> and read `FamilyRelations` off the global from inline
 * code in a dozen places — so it cannot also be an ES module without rewriting
 * two very large pages. This wrapper is the seam: it evaluates that one file
 * once and hands back what it defines, so server-side callers `import` it like
 * anything else instead of each repeating an eval.
 *
 * Why one calculator matters, in the words of the field this replaced: there
 * used to be two. lib/pedigree.mjs computed an English blood term server-side
 * while relations.js computed a bilingual one in the browser, and they did not
 * agree — "great-aunt" against "grand-aunt" — and pedigree could not express an
 * in-law at all, because it ignores spouse links by design. Two calculators for
 * one question is how the stored `relation_to_*` columns drifted from the tree
 * they described. Import this; do not write a second one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '..', 'web', 'public', 'app', 'relations.js');

/* Evaluated against a bare object rather than the real globalThis: the script
   assigns one property to whatever it is handed, and there is no reason for a
   server process to grow a global because a library was loaded. */
const scope = {};
new Function('globalThis', readFileSync(SRC, 'utf8')).call(scope, scope);

/** @type {{relate:Function,pathBetween:Function,label:Function,chainLabel:Function,mine:Function,chainMine:Function,distances:Function,introduce:Function}} */
export const R = scope.FamilyRelations;
if (!R) throw new Error(`${SRC} did not define FamilyRelations`);

/**
 * The shape the calculator wants, from the shape the DB holds.
 *
 * It reads people as the pages send them — sex as a one-letter `g`, parents as
 * one array — not as `people` rows. Kept here so every server-side caller
 * builds it identically; a caller that forgets `spouseEx` silently turns every
 * ended marriage back into a current one.
 */
export function graphFrom(rows) {
  const P = {};
  for (const p of rows) {
    P[p.id] = {
      id: p.id,
      g: p.sex === 'F' ? 'f' : p.sex === 'M' ? 'm' : '',
      spouse: p.spouse_id || '',
      spouseEx: !!p.spouse_ex,
      parents: [p.father_id, p.mother_id].filter(Boolean),
    };
  }
  return P;
}

/**
 * How `b` is related to `a`, in both languages, or null when the graph holds no
 * path between them.
 *
 * `gen` is b's generation RELATIVE TO a — 0 the same, -1 a parent's, +1 a
 * child's — and is null for a relation reached by a chain rather than by a
 * named kind, because a chain through marriages has no single generation to
 * report. It is deliberately not `people.generation`, which was one integer
 * measured from a single fixed person and could not answer this for anyone
 * else.
 */
export function relationBetween(P, aId, bId) {
  if (!P[aId] || !P[bId]) return null;
  if (aId === bId) return { en: 'self', he: 'עצמו', kind: 'self', gen: 0, chain: false };

  const rel = R.relate(P, aId, bId, 0);
  if (rel && rel.kind !== 'none') {
    /* `k`, `deg` and `removed` are carried through because the label alone
       cannot be matched on safely: "aunt" is a substring of "aunt's sister",
       and a caller counting aunts with a regex silently counts both. Compare
       the structured fields, not the words. */
    return {
      en: R.label(rel, 'en'), he: R.label(rel, 'he'),
      kind: rel.kind, gen: rel.gen ?? null, chain: false,
      k: rel.k ?? null, deg: rel.deg ?? null, removed: rel.removed ?? 0, half: !!rel.half,
    };
  }
  /* No named kind, but the two may still be joined by a route through
     marriages — "my brother's wife's father". That is a real answer and the
     only one those pairs have. */
  const hops = R.pathBetween(P, aId, bId);
  if (!hops || !hops.length) return null;
  return {
    en: R.chainLabel(P, aId, hops, 'en'),
    he: R.chainLabel(P, aId, hops, 'he'),
    kind: 'chain', gen: null, chain: true,
    k: null, deg: null, removed: 0, half: false,
  };
}
