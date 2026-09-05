// Node's view of the browser's colour module.
//
// web/public/app/colors.js is a classic script (the tree page cannot import a
// module), so importing it here runs it for its side effect — it assigns
// globalThis.FamilyColors — and this file re-exports that surface as ESM. One
// implementation, so a colour the server defaults to and a colour the page
// draws can never be two different colours.

import './../web/public/app/colors.js';

const C = globalThis.FamilyColors;
if (!C) throw new Error('colors.js did not define globalThis.FamilyColors');

export const { HUES, hexToOklch, oklchToHex, defaultColor, shades, isHex, normHex } = C;
