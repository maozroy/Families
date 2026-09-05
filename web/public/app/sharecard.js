/* The relation route, as a picture you can send.
 *
 * "How are we related" is the one answer on this site that a relative wants to
 * forward to somebody else, and until now the only way to do it was a
 * screenshot of a phone-shaped panel with the pickers and half the family
 * filter still in frame. This draws the answer on its own — the question, the
 * verdict, the sentence, and the chain of people it runs through — at a size
 * WhatsApp will not turn to mush.
 *
 * It is a CANVAS and not a server route on purpose. Everything on the card is
 * already in the reader's browser, and the alternative — an image endpoint —
 * would be a URL that renders family names and faces, which is a thing that
 * gets pasted into a group chat and then fetched by a link preview crawler that
 * has no session. Drawing it here keeps the picture inside the perimeter until
 * the reader themselves hands it to somebody: the same trust boundary a
 * screenshot has, which is the one they already have.
 *
 * A classic script, like colors.js and origin.js beside it: the page's logic
 * block is not a module and cannot import.
 */
(function (root) {
  'use strict';

  var W = 1080;                     /* WhatsApp re-encodes anything wider */
  var PAD = 76;

  /* The card is drawn in the LIGHT palette whatever the reader's theme is.
     A dark card is not wrong on a phone, but this picture's whole job is to be
     recognisably from this site, and the site is cream. */
  var BG = '#f5ead8', SURFACE = '#ebddc5', INK = '#201e1d';
  var ACCENT = '#8c491a', ACCENT_DEEP = '#643312';
  var MUTED = 'rgba(32,30,29,0.62)';
  var HEAD = '"Caprasimo", "Roobert Hebrew", system-ui, sans-serif';
  var BODY = '"Roobert Hebrew", "Figtree", system-ui, sans-serif';

  var MAX_ROWS = 9;                 /* longest real path in this tree is 8 hops */

  function ctxFont(size, weight, family) {
    return String(weight || 400) + ' ' + size + 'px ' + (family || BODY);
  }

  /* Word wrap, measured in the font it will actually be drawn in. Hebrew words
     are short and this splits on whitespace, so a line never breaks mid-word in
     either language — which also means one very long word overflows rather than
     hyphenating, and at these sizes nothing in the data does. */
  function wrap(ctx, text, font, maxW) {
    ctx.font = font;
    var words = String(text || '').split(/\s+/).filter(Boolean);
    var lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var next = cur ? cur + ' ' + words[i] : words[i];
      if (cur && ctx.measureText(next).width > maxW) { lines.push(cur); cur = words[i]; }
      else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function ellipsize(ctx, text, font, maxW) {
    ctx.font = font;
    var s = String(text || '');
    if (ctx.measureText(s).width <= maxW) return s;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  /* Same-origin photos, so the canvas stays untainted and toBlob() works. A
     photo that will not load is not an error — the initials avatar underneath
     is the normal state for 374 of the 383 people here. */
  function loadImage(src) {
    return new Promise(function (resolve) {
      if (!src) return resolve(null);
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  function circleImage(ctx, img, cx, cy, r) {
    /* cover, not stretch: portraits are taller than they are wide and squashing
       a face is the one distortion everybody notices. */
    var s = Math.max((r * 2) / img.width, (r * 2) / img.height);
    var dw = img.width * s, dh = img.height * s;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * Measure first, then draw. The card's height depends on how the title and
   * the sentence wrap and on how many hops the route has, and a canvas cannot
   * be resized after it has been drawn on — so everything is laid out twice,
   * once into a throwaway context for the geometry and once for real.
   */
  function layout(ctx, card) {
    var rtl = card.lang !== 'en';
    var inner = W - PAD * 2;
    var titleFont = ctxFont(74, 400, HEAD);
    var phraseFont = ctxFont(34, 400, BODY);
    var titleLines = wrap(ctx, card.title, titleFont, inner);
    var phraseLines = wrap(ctx, card.phrase, phraseFont, inner);

    var rows = (card.rows || []).slice(0, MAX_ROWS);
    var dropped = (card.rows || []).length - rows.length;

    var y = PAD;
    y += 40;                                        /* kicker */
    y += titleLines.length * 84;
    y += 18 + phraseLines.length * 48;
    y += 44;                                        /* rule + chain heading */
    var chainTop = y + 16;                          /* the heading's descenders */
    y += rows.length * 118 + (dropped ? 60 : 0);
    y += 34 + 40 + PAD;                             /* footer */

    return { rtl: rtl, inner: inner, titleFont: titleFont, phraseFont: phraseFont,
      titleLines: titleLines, phraseLines: phraseLines, rows: rows, dropped: dropped,
      chainTop: chainTop, height: Math.round(y) };
  }

  /**
   * card = {
   *   lang, kicker, title, phrase, chainTitle, footer, moreText(n),
   *   rows: [{ step, name, rel, photo, initials, fill, ink, edge }]
   * }
   * Colours come in already resolved — the caller knows the family palette and
   * whether it is allowed to use the theme-wrapped shades (it is not; paper and
   * WhatsApp are both light).
   */
  function render(card) {
    var probe = document.createElement('canvas').getContext('2d');
    var L = layout(probe, card);

    var cv = document.createElement('canvas');
    cv.width = W;
    cv.height = L.height;
    var ctx = cv.getContext('2d');
    var rtl = L.rtl;
    /* Bidi is the browser's problem, not ours: set the direction and anchor the
       text to the reading edge, and a Hebrew name with a Latin surname in it
       comes out in the right order without any of it being reordered by hand. */
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.textAlign = rtl ? 'right' : 'left';
    ctx.textBaseline = 'alphabetic';
    var edge = rtl ? W - PAD : PAD;
    var far = rtl ? PAD : W - PAD;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, L.height);

    var y = PAD + 30;

    ctx.font = ctxFont(27, 600, BODY);
    ctx.fillStyle = ACCENT;
    ctx.fillText(card.kicker || '', edge, y);
    y += 10;

    ctx.font = L.titleFont;
    ctx.fillStyle = ACCENT_DEEP;
    L.titleLines.forEach(function (ln) { y += 84; ctx.fillText(ln, edge, y); });

    y += 18;
    ctx.font = L.phraseFont;
    ctx.fillStyle = INK;
    L.phraseLines.forEach(function (ln) { y += 48; ctx.fillText(ln, edge, y); });

    y += 44;
    ctx.strokeStyle = 'rgba(32,30,29,0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD, y - 26);
    ctx.lineTo(W - PAD, y - 26);
    ctx.stroke();

    ctx.font = ctxFont(24, 700, BODY);
    ctx.fillStyle = MUTED;
    ctx.fillText(card.chainTitle || '', edge, y);

    var imgs = L.rows.map(function (r) { return r.photo; });
    return Promise.all(imgs.map(loadImage)).then(function (loaded) {
      var ry = L.chainTop;
      L.rows.forEach(function (r, i) {
        var top = ry + i * 118;
        roundRect(ctx, PAD, top, L.inner, 100, 26);
        ctx.fillStyle = SURFACE;
        ctx.fill();

        var cx = rtl ? W - PAD - 34 - 20 : PAD + 34 + 20;
        var cy = top + 50;
        ctx.beginPath();
        ctx.arc(cx, cy, 34, 0, Math.PI * 2);
        ctx.fillStyle = r.fill || '#eee7db';
        ctx.fill();
        if (loaded[i]) circleImage(ctx, loaded[i], cx, cy, 34);
        else {
          ctx.font = ctxFont(26, 700, BODY);
          ctx.fillStyle = r.ink || '#645c50';
          ctx.textAlign = 'center';
          ctx.fillText(r.initials || '', cx, cy + 9);
          ctx.textAlign = rtl ? 'right' : 'left';
        }
        ctx.lineWidth = 3;
        ctx.strokeStyle = r.edge || '#dcd3c4';
        ctx.beginPath();
        ctx.arc(cx, cy, 34, 0, Math.PI * 2);
        ctx.stroke();

        var tx = rtl ? cx - 34 - 22 : cx + 34 + 22;
        var room = rtl ? (tx - PAD - 70) : (W - PAD - 70 - tx);
        ctx.font = ctxFont(33, 700, BODY);
        ctx.fillStyle = INK;
        ctx.fillText(ellipsize(ctx, r.name, ctxFont(33, 700, BODY), room), tx, top + 45);
        ctx.font = ctxFont(25, 400, BODY);
        ctx.fillStyle = MUTED;
        ctx.fillText(ellipsize(ctx, r.rel, ctxFont(25, 400, BODY), room), tx, top + 79);

        /* The step number sits at the far edge, where it reads as an index
           rather than as part of the name. */
        ctx.font = ctxFont(24, 700, BODY);
        ctx.fillStyle = 'rgba(32,30,29,0.34)';
        ctx.textAlign = rtl ? 'left' : 'right';
        ctx.fillText(String(r.step), far + (rtl ? 26 : -26), top + 60);
        ctx.textAlign = rtl ? 'right' : 'left';
      });

      var fy = ry + L.rows.length * 118;
      if (L.dropped) {
        ctx.font = ctxFont(26, 400, BODY);
        ctx.fillStyle = MUTED;
        ctx.fillText(card.moreText ? card.moreText(L.dropped) : '+' + L.dropped, edge, fy + 38);
        fy += 60;
      }

      ctx.font = ctxFont(26, 600, BODY);
      ctx.fillStyle = ACCENT;
      ctx.fillText(card.footer || '', edge, fy + 62);

      return cv;
    });
  }

  function toBlob(canvas) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) canvas.toBlob(resolve, 'image/png');
      else resolve(null);
    });
  }

  /**
   * Hand the picture over. Three outcomes, and the caller has to tell them
   * apart because they need different words: the share sheet took it, the
   * browser downloaded it instead (every desktop that has no share sheet for
   * files — which is most of them), or nothing happened.
   *
   * A share the reader cancels is NOT a failure. `navigator.share` rejects with
   * an AbortError when they back out of the sheet, and reporting that as "could
   * not share" is telling somebody their deliberate action broke.
   */
  function deliver(canvas, opts) {
    var o = opts || {};
    var name = o.filename || 'family.png';
    return toBlob(canvas).then(function (blob) {
      if (!blob) return 'failed';
      var file = null;
      try { file = new File([blob], name, { type: 'image/png' }); } catch (e) { file = null; }
      var canFiles = !!(file && navigator.canShare && navigator.share
        && navigator.canShare({ files: [file] }));
      if (canFiles) {
        return navigator.share({ files: [file], title: o.title, text: o.text })
          .then(function () { return 'shared'; })
          .catch(function (err) { return (err && err.name === 'AbortError') ? 'cancelled' : download(blob, name); });
      }
      return download(blob, name);
    }).catch(function () { return 'failed'; });
  }

  function download(blob, name) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return 'saved';
    } catch (e) { return 'failed'; }
  }

  /* Custom fonts are loaded by the document, and a canvas asked to draw in one
     before it has arrived silently falls back to the system face — which on a
     first visit means the card that gets shared is the only thing on the whole
     site not in the site's own type. */
  function ready() {
    return (document.fonts && document.fonts.ready) ? document.fonts.ready.catch(function () {}) : Promise.resolve();
  }

  root.FamilyShareCard = { render: render, deliver: deliver, toBlob: toBlob, ready: ready, WIDTH: W };
}(typeof globalThis !== 'undefined' ? globalThis : window));
