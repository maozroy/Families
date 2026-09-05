// Node's view of the browser's country vocabulary — same trick as lib/fuzzy.mjs.
//
// The form has to offer countries and the geocoder has to ask about them, and
// those two have to agree about what "Italy", "איטליה" and "IT" are, or a
// relative picks a country the lookup then cannot use. One file, both sides.

import './fuzzy.mjs';
import './../web/public/app/countries.js';

const C = globalThis.FamilyCountries;
if (!C) throw new Error('countries.js did not define globalThis.FamilyCountries');

export const { CODES, HOME, name, label, resolve, normalize, isForeign, list } = C;
