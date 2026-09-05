// Node's view of the browser's matching module — same trick as lib/colors.mjs.
//
// The geocoder has to decide whether the answer it got back is about the place
// it asked about, and the pickers have to decide whether what somebody typed is
// that place. Those are the same question, so they use the same Hebrew
// normalisation: one place to get the maqaf and the gershayim right.

import './../web/public/app/fuzzy.js';

const F = globalThis.FamilyFuzzy;
if (!F) throw new Error('fuzzy.js did not define globalThis.FamilyFuzzy');

export const { norm, bare, score, rank } = F;
