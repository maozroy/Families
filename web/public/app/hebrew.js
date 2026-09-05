/* The Hebrew date of a civil one.
 *
 * Every date in this tree is Gregorian, because that is what the registry keeps
 * and what a form asks for. But a Hebrew birthday is the one the family marks —
 * it is what a יארצייט is counted from and what a grandmother means when she
 * says which day somebody was born. Nobody is going to type it twice, and a
 * second stored date would be a second thing to get wrong: it is derived here,
 * from `birth_date`, and never written to the DB.
 *
 * THE ONE CAVEAT, and it is not a rounding error: a Hebrew day starts at
 * sunset. A civil date alone cannot say which side of sunset a birth was on, so
 * this assumes daytime — the same assumption every genealogy tool makes, and
 * the same one a printed calendar makes. Somebody born at 9pm belongs to the
 * NEXT Hebrew day than the one shown here.
 *
 * The only fix is asking the person, so the tree asks: `born_after_sunset` is a
 * flag a relative sets on their own row, and every entry point here takes it.
 * It is a third state, not a correction — off means "daytime, or nobody has
 * said", and the two are the same date. What it must NOT do is move the civil
 * date: somebody born at 9pm on 8 March was born on 8 March, and it is only the
 * Hebrew day that had already turned.
 *
 * No dependency on Intl's `ca-hebrew`, though it agrees with this file day for
 * day (scripts/hebrew-selftest.mjs checks that over three centuries). Two
 * reasons: Node's ICU refuses `nu-hebr`, so gematria — ה׳ באלול תשפ״ו, which is
 * how the date is actually written — has to be done here anyway; and the
 * arithmetic below is fixed forever, while ICU's spelling of a month is not.
 *
 * A classic script, like the others in this directory: the tree's logic block
 * is not a module and cannot import. lib/hebrew.mjs is the Node view of it.
 */
(function (root) {
  'use strict';

  var DAY = 86400000;

  /* Days since 1970-01-01, UTC. Built the long way round because Date.UTC maps
     a two-digit year into the 1900s, and this tree has people born in 1901. */
  function civilToDay(y, m, d) {
    var dt = new Date(Date.UTC(2000, m - 1, d));
    dt.setUTCFullYear(y);
    return Math.floor(dt.getTime() / DAY);
  }

  function dayToCivil(n) {
    var dt = new Date(n * DAY);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }

  /* ── the calendar itself ───────────────────────────────────────────────────
     Seven leap years in every nineteen, on the Metonic cycle. A leap year gets
     a second Adar, which is why "born in Adar" is a question in some years. */
  function isLeapYear(y) { return ((7 * y + 1) % 19) < 7; }

  /* Days from the creation epoch to 1 Tishrei of `y`: the molad of Tishrei
     (mean new moon, counted in 1/1080ths of an hour), then the four dechiyot —
     the postponement rules that keep Yom Kippur off a Friday and Hoshana Rabba
     off a Shabbat. This is the classic Dershowitz–Reingold formulation; the
     magic numbers are the molad constants and are not worth renaming. */
  function elapsedDays(y) {
    var monthsElapsed = 235 * Math.floor((y - 1) / 19)      // whole cycles
      + 12 * ((y - 1) % 19)                                  // ordinary years since
      + Math.floor((7 * ((y - 1) % 19) + 1) / 19);           // their leap months
    var partsElapsed = 204 + 793 * (monthsElapsed % 1080);
    var hoursElapsed = 5 + 12 * monthsElapsed
      + 793 * Math.floor(monthsElapsed / 1080)
      + Math.floor(partsElapsed / 1080);
    var day = 1 + 29 * monthsElapsed + Math.floor(hoursElapsed / 24);
    var parts = 1080 * (hoursElapsed % 24) + partsElapsed % 1080;
    var alt = day;
    if (parts >= 19440                                             // molad zaken
      || (day % 7 === 2 && parts >= 9924 && !isLeapYear(y))        // GaTaRaD
      || (day % 7 === 1 && parts >= 16789 && isLeapYear(y - 1))) { // BeTuTaKaPoT
      alt = day + 1;
    }
    // lo ADU rosh — the new year cannot fall on a Sunday, Wednesday or Friday.
    if (alt % 7 === 0 || alt % 7 === 3 || alt % 7 === 5) return alt + 1;
    return alt;
  }

  /* Calibrated rather than written down: 1 Tishrei 5786 was 23 September 2025,
     which is a date anyone can check against a wall calendar, where the epoch
     constant (-1373429 in Rata Die) is a number you can only take on trust. */
  var EPOCH = civilToDay(2025, 9, 23) - elapsedDays(5786);

  function newYearDay(y) { return EPOCH + elapsedDays(y); }
  function daysInYear(y) { return newYearDay(y + 1) - newYearDay(y); }

  /* The months of one year, in order, with their lengths. Only two months vary:
     Heshvan gains a day in a "complete" year and Kislev loses one in a
     "deficient" year, which is how the calendar absorbs the drift between the
     lunar months and the postponed new year. */
  var MONTHS = {
    tishrei: { he: 'תשרי', en: 'Tishrei' }, heshvan: { he: 'חשוון', en: 'Cheshvan' },
    kislev: { he: 'כסלו', en: 'Kislev' }, tevet: { he: 'טבת', en: 'Tevet' },
    shevat: { he: 'שבט', en: 'Shevat' }, adar: { he: 'אדר', en: 'Adar' },
    adar1: { he: 'אדר א׳', en: 'Adar I' }, adar2: { he: 'אדר ב׳', en: 'Adar II' },
    nisan: { he: 'ניסן', en: 'Nisan' }, iyar: { he: 'אייר', en: 'Iyar' },
    sivan: { he: 'סיוון', en: 'Sivan' }, tamuz: { he: 'תמוז', en: 'Tammuz' },
    av: { he: 'אב', en: 'Av' }, elul: { he: 'אלול', en: 'Elul' },
  };

  function monthsOf(y) {
    var len = daysInYear(y);                       // 353–355, or 383–385 in a leap year
    var out = [
      { key: 'tishrei', days: 30 },
      { key: 'heshvan', days: len % 10 === 5 ? 30 : 29 },
      { key: 'kislev', days: len % 10 === 3 ? 29 : 30 },
      { key: 'tevet', days: 29 },
      { key: 'shevat', days: 30 },
    ];
    if (isLeapYear(y)) out.push({ key: 'adar1', days: 30 }, { key: 'adar2', days: 29 });
    else out.push({ key: 'adar', days: 29 });
    out.push({ key: 'nisan', days: 30 }, { key: 'iyar', days: 29 },
      { key: 'sivan', days: 30 }, { key: 'tamuz', days: 29 },
      { key: 'av', days: 30 }, { key: 'elul', days: 29 });
    return out;
  }

  /* ── conversion ───────────────────────────────────────────────────────────*/

  function fromDay(n) {
    /* The Hebrew year is the civil year plus 3760 or 3761; start from the
       larger and walk, which lands in at most two steps and needs no estimate
       of the mean year length. */
    var y = dayToCivil(n).y + 3761;
    while (newYearDay(y) > n) y--;
    while (newYearDay(y + 1) <= n) y++;

    var left = n - newYearDay(y);
    var months = monthsOf(y);
    for (var i = 0; i < months.length; i++) {
      if (left < months[i].days) {
        return { y: y, month: months[i].key, d: left + 1, leap: isLeapYear(y) };
      }
      left -= months[i].days;
    }
    return null;    // unreachable: the months of a year sum to its length
  }

  function toDay(h) {
    var months = monthsOf(h.y), n = newYearDay(h.y);
    for (var i = 0; i < months.length; i++) {
      if (months[i].key === h.month) return n + h.d - 1;
      n += months[i].days;
    }
    /* Asking for Adar in a leap year, or Adar II in an ordinary one — which is
       exactly what a Hebrew birthday does every few years. Fall back to the
       month the family keeps the date in: Adar → Adar II, Adar I/II → Adar. */
    var alias = h.month === 'adar' ? 'adar2' : 'adar';
    if (alias !== h.month) return toDay({ y: h.y, month: alias, d: h.d });
    return null;
  }

  /* ── gematria ─────────────────────────────────────────────────────────────
     ה׳ באלול תשפ״ו, not 5 באלול 5786. Latin digits are what a database prints;
     the letters are what an invitation, a headstone and a calendar print. */
  var ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
  var TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
  var HUNDREDS = ['', 'ק', 'ר', 'ש', 'ת', 'תק', 'תר', 'תש', 'תת', 'תתק'];

  function gematria(n) {
    n = Math.floor(n);
    if (!(n > 0)) return String(n);
    var out = HUNDREDS[Math.floor(n / 100) % 10] || '';
    var rest = n % 100;
    /* 15 and 16 are written טו and טז. Spelling them י-ה and י-ו would put two
       of the Name's letters on the page, which is not done — and every reader
       of a Hebrew calendar would notice. */
    if (rest === 15) out += 'טו';
    else if (rest === 16) out += 'טז';
    else out += TENS[Math.floor(rest / 10)] + ONES[rest % 10];
    /* One letter takes a geresh; more take a gershayim before the last. */
    if (out.length === 1) return out + '׳';
    return out.slice(0, -1) + '״' + out.slice(-1);
  }

  /* Years are said without the thousands — תשפ״ו, not ה׳תשפ״ו — the way "eighty
     six" means 1986 in speech. */
  function yearLabel(y, lang) {
    if (lang === 'en') return String(y);
    var short = y % 1000;
    return short ? gematria(short) : String(y);
  }

  function monthName(key, lang) {
    var m = MONTHS[key];
    if (!m) return key;
    return lang === 'en' ? m.en : m.he;
  }

  function format(h, lang) {
    if (!h) return '';
    if (lang === 'en') return h.d + ' ' + monthName(h.month, 'en') + ' ' + h.y;
    return gematria(h.d) + ' ב' + monthName(h.month, 'he') + ' ' + yearLabel(h.y, 'he');
  }

  /* ── what the pages call ──────────────────────────────────────────────────*/

  function parse(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    var c = { y: +m[1], m: +m[2], d: +m[3] };
    /* Shape is not validity. Date rolls 2026-02-30 forward into March and
       month 13 into the next year, so a typo would come back as a confident
       Hebrew date for a day nobody was born on. Convert and convert back: only
       a real date survives that. */
    var back = dayToCivil(civilToDay(c.y, c.m, c.d));
    if (back.y !== c.y || back.m !== c.m || back.d !== c.d) return null;
    return c;
  }

  /* One day later when the birth was after sunset, because the Hebrew day had
     already turned — the civil date is untouched, which is the whole point. */
  function partsOf(iso, afterSunset) {
    var c = parse(iso);
    return c ? fromDay(civilToDay(c.y, c.m, c.d) + (afterSunset ? 1 : 0)) : null;
  }

  /* A civil year straddles two Hebrew ones — somebody born "in 1988" was born
     in תשמ״ח or תשמ״ט and the record does not say which. Naming both is the
     honest answer, and still tells a reader more than a blank. */
  function spanOf(year, lang) {
    var a = fromDay(civilToDay(year, 1, 1)), b = fromDay(civilToDay(year, 12, 31));
    if (!a || !b) return '';
    if (a.y === b.y) return yearLabel(a.y, lang);
    return yearLabel(a.y, lang) + '–' + yearLabel(b.y, lang);
  }

  /* The one call the tree makes. Takes `born` exactly as the API ships it —
     'YYYY-MM-DD', or 'YYYY' when only the year is known, or '' — and returns
     something printable or nothing at all. Never throws: a malformed date in
     one row must not blank the whole card. */
  function of(born, lang, afterSunset) {
    var s = String(born || '').trim();
    if (!s) return '';
    try {
      /* A year on its own has no sunset to be on the far side of: the flag is
         about one evening and this date does not name one. Ignored rather than
         applied to 1 January, which would be a shift nobody asserted. */
      if (/^\d{4}$/.test(s)) return spanOf(+s, lang);
      return format(partsOf(s, afterSunset), lang);
    } catch (e) { return ''; }
  }

  /* The same date with the fact that moved it said out loud. A reader who
     checks the card against a calendar and finds it a day off should be able to
     see why from the card, rather than from the edit form. */
  var SUNSET_NOTE = { he: 'אחרי השקיעה', en: 'after sunset' };

  function noteOf(born, lang, afterSunset) {
    if (!afterSunset) return '';
    return /^\d{4}-\d{2}-\d{2}$/.test(String(born || '').trim()) ? SUNSET_NOTE[lang === 'en' ? 'en' : 'he'] : '';
  }

  function withNote(born, lang, afterSunset) {
    var text = of(born, lang, afterSunset);
    var note = text ? noteOf(born, lang, afterSunset) : '';
    return note ? text + ' · ' + note : text;
  }

  /* ── the Hebrew year as something to page through ─────────────────────────
     A list of birthdays needs a month to be in, a way to step to the next one,
     and a way to ask which people belong to it. In Hebrew that is three
     questions the Gregorian version does not have: a year has twelve months or
     thirteen, "next month" can cross a leap boundary, and a birthday in Adar
     has to land somewhere in a year with two of them. */

  /* n months forward (or back) from {y, month}. Walks the real month list of
     each year rather than counting modulo twelve, because the count is not
     twelve in seven years out of nineteen. */
  function stepMonth(h, n) {
    var y = h.y;
    var keys = monthsOf(y).map(function (m) { return m.key; });
    var i = keys.indexOf(h.month);
    if (i < 0) i = keys.indexOf(anniversary({ y: y, month: h.month, d: 1 }, y).month);
    var step = n < 0 ? -1 : 1;
    for (var left = Math.abs(n || 0); left > 0; left--) {
      i += step;
      if (i >= keys.length) { y++; keys = monthsOf(y).map(function (m) { return m.key; }); i = 0; }
      else if (i < 0) { y--; keys = monthsOf(y).map(function (m) { return m.key; }); i = keys.length - 1; }
    }
    return { y: y, month: keys[i] };
  }

  /* The birthday, in a given Hebrew year. Everything is the same date it always
     was except in Adar, which exists once in an ordinary year and twice in a
     leap one:
       - born in Adar, in a leap year   → Adar II, the month the year "ends" on
       - born in either Adar, ordinarily → plain Adar, the only one there is
     A 30th in a month that has 29 that year is deliberately NOT clamped: toDay
     rolls it onto the 1st of the next month, which is where the day is kept. */
  function anniversary(birth, y) {
    var keys = monthsOf(y).map(function (m) { return m.key; });
    var month = birth.month;
    if (keys.indexOf(month) < 0) month = month === 'adar' ? 'adar2' : 'adar';
    return { y: y, month: month, d: birth.d };
  }

  /* "אלול תשפ״ו" / "Elul 5786" — what the month picker says it is showing. */
  function monthLabel(h, lang) {
    if (!h) return '';
    return monthName(h.month, lang) + ' ' + yearLabel(h.y, lang);
  }

  /* The day on its own, for the column where a civil list puts 8 or 23. */
  function dayLabel(d, lang) {
    return lang === 'en' ? String(d) : gematria(d);
  }

  /* A date with no year — "י״א באדר", "11 Adar". What a birthday IS, as opposed
     to when it happened: the year belongs to the birth, not to the anniversary,
     and printing תש״נ next to "turns 36" says the same thing twice. */
  function dayMonthLabel(h, lang) {
    if (!h) return '';
    if (lang === 'en') return h.d + ' ' + monthName(h.month, 'en');
    return gematria(h.d) + ' ב' + monthName(h.month, 'he');
  }

  /* The same date in a later Hebrew year, back in civil terms: what "his Hebrew
     birthday this year" means — the Dates view runs on this when it is set to
     the Hebrew calendar. The reverse conversion is half the reason the
     arithmetic above is here rather than borrowed from Intl, which cannot do
     it at all. */
  function civilOfHebrew(h) {
    var n = toDay(h);
    if (n === null) return '';
    var c = dayToCivil(n);
    return String(c.y).padStart(4, '0') + '-'
      + String(c.m).padStart(2, '0') + '-' + String(c.d).padStart(2, '0');
  }

  root.FamilyHebrew = {
    of: of, withNote: withNote, noteOf: noteOf,
    partsOf: partsOf, format: format, spanOf: spanOf,
    civilOfHebrew: civilOfHebrew, monthName: monthName,
    stepMonth: stepMonth, anniversary: anniversary,
    monthLabel: monthLabel, dayLabel: dayLabel, dayMonthLabel: dayMonthLabel,
    gematria: gematria, yearLabel: yearLabel,
    isLeapYear: isLeapYear, daysInYear: daysInYear, monthsOf: monthsOf,
  };
}(typeof globalThis !== 'undefined' ? globalThis : window));
