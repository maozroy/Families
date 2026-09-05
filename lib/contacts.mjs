// Node's view of the browser's contact-link module.
//
// web/public/app/contacts.js is a classic script (the tree page cannot import a
// module), so importing it here runs it for its side effect — it assigns
// globalThis.FamilyContacts — and this file re-exports that surface as ESM.
// One implementation, so the URL the server stores and the URL the page opens
// can never be two different URLs.

import './../web/public/app/contacts.js';

const C = globalThis.FamilyContacts;
if (!C) throw new Error('contacts.js did not define globalThis.FamilyContacts');

export const { ORDER, COLUMNS, parse, normalize, waNumber, icon, brandOf, linksFor } = C;
