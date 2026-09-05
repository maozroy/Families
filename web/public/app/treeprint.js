/* The tree, on paper.
 *
 * Two things had to be decided before a line of this was written, and both of
 * them are why it does not simply print the page.
 *
 * **It cannot reuse the on-screen tree.** What is on screen is a pannable,
 * zoomable, clipped viewport with a CSS transform on it, inside a flex column
 * whose height is 100dvh. Print engines resolve exactly none of that the way a
 * reader expects: the transform scales the paint but not the layout, the
 * viewport clips to whatever the last pan left visible, and dvh is meaningless
 * on paper. So the diagram is rebuilt as an SVG in the layout's own pixel
 * coordinates and handed to the page through a viewBox, which is the one
 * mechanism that scales geometry and type together and is exact at any size.
 *
 * **One page is usually the wrong answer.** The full tree is about 33,000px
 * wide and 800px tall — the widest generation has 151 people in it. Fitted onto
 * A3 that puts the names at under half a millimetre, which is not a small
 * version of the tree, it is a grey smear. So there are two modes and the
 * dialog says out loud what each will cost: `fit` squeezes the current
 * selection onto one sheet, and `poster` picks a size names can actually be
 * read at and tiles it across as many sheets as that takes, with an overlap to
 * tape along and a map on the last page saying which sheet goes where.
 *
 * Which is also why the filters matter more here than anywhere else in the app:
 * "print" means "print WHAT IS SELECTED", and one family, or one person's
 * ancestors, is a page. The whole tree is a wall.
 *
 * plan() is pure arithmetic and has no DOM in it, so scripts/print-selftest.mjs
 * can check the tiling without a browser. Everything below it draws.
 */
(function (root) {
  'use strict';

  var NW = 190, NH = 66;            /* must match the tree's own node box */

  /* Portrait millimetres. Israel prints on A-series; Letter is not offered
     because nothing in this family has a printer that wants it. */
  var PAPERS = { a4: [210, 297], a3: [297, 420] };

  var DEF = {
    marginMm: 9,
    headerMm: 13,
    overlapMm: 7,        /* the strip you cut or tape along */
    targetNodeMm: 44,    /* a person's box on a poster: about a thumb's width */
    minNodeMm: 26,       /* below this the years line stops being readable */
    maxPages: 60,
  };

  /**
   * Work out how many sheets this is and what each one shows.
   *
   * Returns millimetres per layout-pixel (`mmPerPx`) as the single scale
   * everything else is derived from, plus one entry per page carrying the
   * viewBox that crops the diagram to that sheet. Tiles overlap by `overlapMm`,
   * so a name that lands on a seam is printed whole on one side of it.
   */
  function plan(opts) {
    var o = Object.assign({}, DEF, opts || {});
    var w = Math.max(1, o.w || 1), h = Math.max(1, o.h || 1);
    var paper = PAPERS[o.paper] || PAPERS.a4;
    var pw = o.landscape ? paper[1] : paper[0];
    var ph = o.landscape ? paper[0] : paper[1];
    var cw = pw - o.marginMm * 2;
    var ch = ph - o.marginMm * 2 - o.headerMm;
    var fitScale = Math.min(cw / w, ch / h);

    if (o.mode !== 'poster') {
      return {
        mode: 'fit', paper: o.paper, landscape: !!o.landscape,
        pageMm: [pw, ph], contentMm: [cw, ch], marginMm: o.marginMm, headerMm: o.headerMm,
        mmPerPx: fitScale, cols: 1, rows: 1, clamped: false,
        pages: [{ i: 0, row: 0, col: 0, vx: 0, vy: 0, vw: w, vh: h,
          /* Centred rather than stretched: the tree is far wider than it is
             tall and letterboxing it is what keeps the node boxes square. */
          drawMm: [w * fitScale, h * fitScale] }],
      };
    }

    /* Poster. Start at the readable size and give ground only to the page cap —
       a reader who filters to one family gets the size they asked for, and one
       who prints all 383 people gets told how many sheets that is before they
       press anything. */
    var floor = o.minNodeMm / NW;
    var scale = snap(o.targetNodeMm / NW);
    var tiles = null, clamped = false;
    for (var guard = 0; guard < 200; guard++) {
      tiles = tileAt(scale);
      if (tiles.cols * tiles.rows <= o.maxPages) break;
      if (scale <= floor) { clamped = true; break; }
      scale = Math.max(floor, snap(scale * 0.9));
    }

    /**
     * Give up a little size to save a whole sheet.
     *
     * The tree is 830px tall and one A4 landscape tile at the target size is
     * 756px, so the last 74px of it — one row of children — spilled onto a
     * SECOND row of sheets. That doubled a 28-sheet poster to 56, of which half
     * were nine-tenths white. Shrinking by 9% fits it in one row and costs
     * 0.3mm of name height, which is a trade nobody would decline if asked.
     *
     * So: alongside the requested scale, consider the exact scale that makes
     * the diagram fill a whole number of tiles on each axis, and take the one
     * that prints on the fewest sheets. Ties go to the larger type.
     *
     * The 15% limit is the whole of the judgement here. Without it this is a
     * page-count minimiser, and page count always wants smaller: unbounded, it
     * traded a third of the name height to go from 26 sheets to 17, which is
     * not the deal that was being offered. It is allowed to shave a sliver off
     * to lose a nearly-empty row. It is not allowed to decide the poster should
     * be a different size than the reader asked for.
     */
    function snap(want) {
      var best = want, bestPages = tileAt(want).cols * tileAt(want).rows;
      var limit = Math.max(floor, want * 0.85);
      var cand = [];
      var i;
      for (i = 1; i <= 40; i++) cand.push((i * cw - (i - 1) * o.overlapMm) / w);
      for (i = 1; i <= 40; i++) cand.push((i * ch - (i - 1) * o.overlapMm) / h);
      cand.forEach(function (s) {
        if (!(s > 0) || s > want || s < limit) return;
        var t = tileAt(s), pages = t.cols * t.rows;
        if (pages < bestPages || (pages === bestPages && s > best)) { best = s; bestPages = pages; }
      });
      return best;
    }
    /* Never make a poster smaller than the single-page version of itself: at
       that point the honest answer is one sheet. */
    if (scale <= fitScale) {
      var one = plan(Object.assign({}, o, { mode: 'fit' }));
      one.collapsed = true;
      return one;
    }

    function tileAt(s) {
      var tw = cw / s, th = ch / s;               /* one sheet, in layout px */
      var ov = o.overlapMm / s;
      var stepW = Math.max(1, tw - ov), stepH = Math.max(1, th - ov);
      var cols = w <= tw ? 1 : Math.ceil((w - ov) / stepW);
      var rows = h <= th ? 1 : Math.ceil((h - ov) / stepH);
      return { tw: tw, th: th, cols: cols, rows: rows, stepW: stepW, stepH: stepH };
    }

    var pages = [];
    for (var r = 0; r < tiles.rows; r++) {
      for (var c = 0; c < tiles.cols; c++) {
        pages.push({
          i: pages.length, row: r, col: c,
          vx: c * tiles.stepW, vy: r * tiles.stepH, vw: tiles.tw, vh: tiles.th,
          drawMm: [cw, ch],
        });
      }
    }
    return {
      mode: 'poster', paper: o.paper, landscape: !!o.landscape,
      pageMm: [pw, ph], contentMm: [cw, ch], marginMm: o.marginMm, headerMm: o.headerMm,
      mmPerPx: scale, cols: tiles.cols, rows: tiles.rows, clamped: clamped, pages: pages,
    };
  }

  /** How big a person's name comes out, in millimetres. What the dialog needs
      to say instead of a scale factor nobody can picture. */
  function nameMm(p) { return Math.round(14 * p.mmPerPx * 10) / 10; }

  // ── drawing ────────────────────────────────────────────────────────────────

  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  var _probe = null;
  function measure(text, font) {
    if (!_probe) _probe = document.createElement('canvas').getContext('2d');
    _probe.font = font;
    return _probe.measureText(String(text || '')).width;
  }

  /* SVG has no text-overflow, so a name too long for its box has to be cut
     here. Measured in the same font and the same pixel units the SVG draws in,
     which is exactly right because the viewBox scales both together. */
  function fitText(text, font, maxW) {
    var s = String(text || '');
    if (!s || measure(s, font) <= maxW) return s;
    while (s.length > 1 && measure(s + '…', font) > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  var NAME_FONT = '600 14px "Roobert Hebrew", "Figtree", system-ui, sans-serif';
  var YEAR_FONT = '400 12px "Roobert Hebrew", "Figtree", system-ui, sans-serif';

  /**
   * One node, in layout pixel coordinates.
   *
   * The avatar sits on the reading edge and the text runs away from it, which
   * is what the on-screen node does — mirrored, so a Hebrew print is not an
   * English print with the words moved.
   */
  function nodeSvg(n, rtl) {
    var ax = rtl ? n.x + NW - 12 - 17 : n.x + 12 + 17;
    var cy = n.y + NH / 2;
    var tx = rtl ? ax - 17 - 9 : ax + 17 + 9;
    var room = rtl ? (tx - n.x - 12) : (n.x + NW - 12 - tx);
    var out = '<g>'
      + '<rect x="' + n.x + '" y="' + n.y + '" width="' + NW + '" height="' + NH + '" rx="20"'
      + ' fill="' + esc(n.bg) + '" stroke="' + esc(n.border) + '" stroke-width="' + (n.borderW || 1.5) + '"/>';
    if (n.pie && n.pie.length) {
      /* "Colour by origin" paints the avatar as the person's whole mix. On
         screen that is a conic gradient, which SVG has no equivalent of, so the
         same segments are drawn as arcs. Printing a plain grey disc instead
         would put a legend on the sheet explaining colours that are not on it. */
      out += pieSvg(n.pie, ax, cy, 17)
        + '<circle cx="' + ax + '" cy="' + cy + '" r="17" fill="none" stroke="' + esc(n.avRing) + '" stroke-width="1.5"/>';
    } else if (n.photo) {
      out += '<clipPath id="cp' + esc(n.id) + '"><circle cx="' + ax + '" cy="' + cy + '" r="17"/></clipPath>'
        + '<image href="' + esc(n.photo) + '" x="' + (ax - 17) + '" y="' + (cy - 17) + '" width="34" height="34"'
        + ' preserveAspectRatio="xMidYMid slice" clip-path="url(#cp' + esc(n.id) + ')"/>'
        + '<circle cx="' + ax + '" cy="' + cy + '" r="17" fill="none" stroke="' + esc(n.avRing) + '" stroke-width="1.5"/>';
    } else {
      out += '<circle cx="' + ax + '" cy="' + cy + '" r="17" fill="' + esc(n.av) + '" stroke="' + esc(n.avRing) + '" stroke-width="1.5"/>'
        + '<text x="' + ax + '" y="' + (cy + 4) + '" text-anchor="middle" font-size="12" font-weight="700"'
        + ' fill="' + esc(n.avInk) + '">' + esc(n.initials) + '</text>';
    }
    /* text-anchor "start" rather than "end": in SVG the anchor is named for the
       inline direction, so under direction:rtl "start" IS the right-hand edge.
       Using "end" here mirrors every name onto the wrong side of its own box. */
    out += '<text x="' + tx + '" y="' + (n.y + 30) + '" text-anchor="start" font-size="14" font-weight="600"'
      + ' fill="' + esc(n.ink || '#201e1d') + '">' + esc(fitText(n.name, NAME_FONT, room)) + '</text>';
    if (n.years) {
      out += '<text x="' + tx + '" y="' + (n.y + 48) + '" text-anchor="start" font-size="12"'
        + ' fill="rgba(32,30,29,0.55)">' + esc(fitText(n.years, YEAR_FONT, room)) + '</text>';
    }
    return out + '</g>';
  }

  /* Segments → arcs. A single full-circle segment is drawn as a circle: an arc
     whose start and end points are the same point is a zero-length path, and
     the 313 people in this tree whose origin is one country would all print as
     an empty ring. */
  function pieSvg(segs, cx, cy, r) {
    var total = segs.reduce(function (s, x) { return s + (x.frac || 0); }, 0);
    if (total <= 0) return '';
    if (segs.length === 1) {
      return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + esc(segs[0].color) + '"/>';
    }
    var at = -Math.PI / 2, out = '';
    segs.forEach(function (s) {
      var sweep = ((s.frac || 0) / total) * Math.PI * 2;
      var x1 = cx + r * Math.cos(at), y1 = cy + r * Math.sin(at);
      at += sweep;
      var x2 = cx + r * Math.cos(at), y2 = cy + r * Math.sin(at);
      out += '<path d="M' + cx + ' ' + cy + ' L' + x1.toFixed(2) + ' ' + y1.toFixed(2)
        + ' A' + r + ' ' + r + ' 0 ' + (sweep > Math.PI ? 1 : 0) + ' 1 '
        + x2.toFixed(2) + ' ' + y2.toFixed(2) + ' Z" fill="' + esc(s.color) + '"/>';
    });
    return out;
  }

  function linksSvg(links) {
    return links.map(function (l) {
      return '<path d="' + esc(l.d) + '" fill="none" stroke="' + esc(l.stroke || 'rgba(32,30,29,0.3)')
        + '" stroke-width="' + (l.w || 1.6) + '" stroke-linecap="round" stroke-linejoin="round"/>';
    }).join('');
  }

  /* Only what this sheet can see. Cheap, and it keeps a 17-page poster from
     carrying 383 nodes seventeen times over. A node that straddles a seam is
     kept on both sheets and clipped by the viewBox — that is what the overlap
     is for. */
  function within(page, x, y, w, h) {
    return x + w >= page.vx && x <= page.vx + page.vw
      && y + h >= page.vy && y <= page.vy + page.vh;
  }

  function pageSvg(model, page) {
    var nodes = model.nodes.filter(function (n) { return within(page, n.x, n.y, NW, NH); });
    var links = model.links.filter(function (l) {
      return !l.box || within(page, l.box[0], l.box[1], l.box[2], l.box[3]);
    });
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + page.vx + ' ' + page.vy + ' ' + page.vw + ' ' + page.vh + '"'
      + ' width="' + page.drawMm[0] + 'mm" height="' + page.drawMm[1] + 'mm"'
      + ' style="direction: ' + (model.rtl ? 'rtl' : 'ltr') + '" preserveAspectRatio="xMidYMid meet">'
      + linksSvg(links) + nodes.map(function (n) { return nodeSvg(n, model.rtl); }).join('') + '</svg>';
  }

  function legendSvg(model) {
    if (!model.legend || !model.legend.length) return '';
    return '<div class="pp-legend">' + model.legend.map(function (f) {
      return '<span class="pp-chip"><i style="background:' + esc(f.color) + '"></i>'
        + esc(f.name) + ' <b>' + esc(f.n) + '</b></span>';
    }).join('') + '</div>';
  }

  /* The assembly map. A tiled poster is a pile of identical-looking sheets and
     the page number alone does not say which corner it goes in; this does. */
  function mapSvg(p) {
    var cell = 26, out = '', n = 0;
    for (var r = 0; r < p.rows; r++) {
      for (var c = 0; c < p.cols; c++) {
        n++;
        var x = c * cell, y = r * cell;
        out += '<rect x="' + x + '" y="' + y + '" width="' + (cell - 2) + '" height="' + (cell - 2) + '"'
          + ' fill="#f9f4ed" stroke="rgba(32,30,29,0.35)"/>'
          + '<text x="' + (x + cell / 2 - 1) + '" y="' + (y + cell / 2 + 3) + '" text-anchor="middle"'
          + ' font-size="10" fill="#201e1d">' + n + '</text>';
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + (p.cols * cell) + '" height="' + (p.rows * cell) + '"'
      + ' viewBox="0 0 ' + (p.cols * cell) + ' ' + (p.rows * cell) + '">' + out + '</svg>';
  }

  /**
   * The whole print job as one HTML string, dropped into #printroot.
   *
   * model = { title, subtitle, note, rtl, nodes, links, legend, legendTitle,
   *           pageLabel(page, plan), mapTitle, mapNote }
   */
  function build(model, p) {
    var pages = p.pages.map(function (page) {
      return '<section class="pp" style="width:' + p.pageMm[0] + 'mm;height:' + p.pageMm[1] + 'mm;padding:' + p.marginMm + 'mm">'
        + '<div class="pp-head" style="height:' + p.headerMm + 'mm">'
        + '<span class="pp-title">' + esc(model.title) + '</span>'
        + '<span class="pp-sub">' + esc(model.subtitle) + '</span>'
        + '<span class="pp-no">' + esc(model.pageLabel ? model.pageLabel(page, p) : (page.i + 1)) + '</span>'
        + '</div>'
        + (p.pages.length === 1 ? legendSvg(model) : '')
        + '<div class="pp-body">' + pageSvg(model, page) + '</div>'
        + '</section>';
    });
    if (p.pages.length > 1) {
      pages.push('<section class="pp" style="width:' + p.pageMm[0] + 'mm;height:' + p.pageMm[1] + 'mm;padding:' + p.marginMm + 'mm">'
        + '<div class="pp-head" style="height:' + p.headerMm + 'mm">'
        + '<span class="pp-title">' + esc(model.mapTitle || '') + '</span>'
        + '<span class="pp-sub">' + esc(model.subtitle) + '</span></div>'
        + '<div class="pp-map">' + mapSvg(p) + '<p>' + esc(model.mapNote || '') + '</p></div>'
        + legendSvg(model)
        + '</section>');
    }
    return pages.join('');
  }

  root.FamilyTreePrint = {
    PAPERS: PAPERS, DEFAULTS: DEF, NW: NW, NH: NH,
    plan: plan, nameMm: nameMm, build: build, fitText: fitText,
  };
}(typeof globalThis !== 'undefined' ? globalThis : window));
