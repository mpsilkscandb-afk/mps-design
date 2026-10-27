/*
 * MPS Design Registry - core logic.
 * Pure functions, no DOM, no network. Shared by the browser app, the demo
 * backend and the Google Apps Script backend (apps_script/Core.gs is a
 * generated copy of this file - run `node tools/build-gs.js`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MPSCore = factory();
})(this, function () {
  'use strict';

  var DEFAULTS = {
    inactiveDays: 90,      // no activity for more than this many days => inactive
    strongMatch: 0.97,     // whole-photo similarity >= : practically the same photo; the server refuses to register it again as new
    possibleMatch: 0.40,   // whole-photo similarity >= : listed as a candidate for the pattern check
    verifyTop: 12,         // how many ranked candidates get the (slower) pattern check
    patternSame: 0.10,     // pattern check: share of stored patches that agree on one placement => "same design"
    patternMaybe: 0.035,   // weaker agreement => "possible" (this is where a different COLOUR of the design usually lands)
    globalMaybe: 0.72,     // very similar overall layout => "possible" even if the pattern check is weak
    sigMaxPatches: 240,    // patches stored per design
    tzOffsetMin: 330,      // IST, used to decide which calendar day an event falls on
    brandPrefix: 'MPS'
  };

  // ---------- supplier helpers ----------
  function normalizeSupplier(name) {
    return String(name || '').replace(/\s+/g, ' ').trim();
  }
  function supplierKey(name) {
    return normalizeSupplier(name).toLowerCase();
  }
  // "Sri Lakshmi Silks" -> SLS ; "Kanchi" -> KAN
  function supplierCode(name) {
    var words = normalizeSupplier(name).toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(' ').filter(Boolean);
    if (!words.length) return 'XXX';
    if (words.length === 1) return (words[0] + 'XXX').slice(0, 3);
    return words.slice(0, 3).map(function (w) { return w[0]; }).join('').padEnd(3, 'X');
  }

  // ---------- design numbers ----------
  // MPS-SLS-0001. Sequence is per supplier code; existing numbers are scanned so it never repeats.
  function nextDesignNo(supplier, designs, prefix) {
    prefix = prefix || DEFAULTS.brandPrefix;
    var code = supplierCode(supplier);
    var head = prefix + '-' + code + '-';
    var max = 0;
    (designs || []).forEach(function (d) {
      var n = String(d.design_no || '');
      if (n.indexOf(head) === 0) {
        var v = parseInt(n.slice(head.length), 10);
        if (!isNaN(v) && v > max) max = v;
      }
    });
    return head + String(max + 1).padStart(4, '0');
  }

  // ---------- image analysis (colour-blind: looks at shapes of motifs, not at colours) ----------
  // Browser and backend both start from a GRAYSCALE picture (480 px wide) - colour is thrown away on
  // purpose, so the same design woven in another colour still matches.
  var A = { W: 240, crop: 0.06, gW: 96, gH: 168, gCX: 4, gCY: 7, bins: 8, step: 8, patch: 32, cells: 4,
            ratio: 0.80, margin: 0.03, flat: 768, binPx: 10, scales: [0.85, 1.0, 1.18] };

  function resizeGray(src, sw, sh, dw, dh) {
    var out = new Float32Array(dw * dh), fx = sw / dw, fy = sh / dh, x, y, i, j;
    if (fx >= 1 && fy >= 1) {                       // shrinking: average the covered box
      for (y = 0; y < dh; y++) {
        var y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1) * fy)));
        for (x = 0; x < dw; x++) {
          var x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((x + 1) * fx)));
          var sum = 0, n = 0;
          for (j = y0; j < y1; j++) for (i = x0; i < x1; i++) { sum += src[j * sw + i]; n++; }
          out[y * dw + x] = sum / n;
        }
      }
    } else {                                        // enlarging: bilinear
      for (y = 0; y < dh; y++) {
        var sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5)), yy = Math.floor(sy), wy = sy - yy, yb = Math.min(sh - 1, yy + 1);
        for (x = 0; x < dw; x++) {
          var sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5)), xx = Math.floor(sx), wx = sx - xx, xb = Math.min(sw - 1, xx + 1);
          out[y * dw + x] = (src[yy * sw + xx] * (1 - wx) + src[yy * sw + xb] * wx) * (1 - wy) + (src[yb * sw + xx] * (1 - wx) + src[yb * sw + xb] * wx) * wy;
        }
      }
    }
    return out;
  }
  function cropGray(g, w, h, frac) {
    var x0 = Math.round(w * frac), y0 = Math.round(h * frac), cw = w - 2 * x0, ch = h - 2 * y0, out = new Float32Array(cw * ch);
    for (var y = 0; y < ch; y++) for (var x = 0; x < cw; x++) out[y * cw + x] = g[(y + y0) * w + x + x0];
    return { g: out, w: cw, h: ch };
  }
  function blurGray(g, w, h, sigma) {
    var r = Math.max(1, Math.ceil(sigma * 3)), k = [], sum = 0, i, x, y;
    for (i = -r; i <= r; i++) { var v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); sum += v; }
    for (i = 0; i < k.length; i++) k[i] /= sum;
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var a = 0; for (i = -r; i <= r; i++) a += k[i + r] * g[y * w + Math.min(w - 1, Math.max(0, x + i))];
      tmp[y * w + x] = a;
    }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var b = 0; for (i = -r; i <= r; i++) b += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = b;
    }
    return out;
  }
  // gradient magnitude and UNSIGNED orientation bin (so light-on-dark and dark-on-light look the same)
  function gradients(g, w, h, nb) {
    var mag = new Float32Array(w * h), bin = new Uint8Array(w * h), x, y;
    function P(xx, yy) { return g[Math.min(h - 1, Math.max(0, yy)) * w + Math.min(w - 1, Math.max(0, xx))]; }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var dx = (P(x + 1, y - 1) + 2 * P(x + 1, y) + P(x + 1, y + 1)) - (P(x - 1, y - 1) + 2 * P(x - 1, y) + P(x - 1, y + 1));
      var dy = (P(x - 1, y + 1) + 2 * P(x, y + 1) + P(x + 1, y + 1)) - (P(x - 1, y - 1) + 2 * P(x, y - 1) + P(x + 1, y - 1));
      var ang = Math.atan2(dy, dx); if (ang < 0) ang += Math.PI; if (ang >= Math.PI) ang -= Math.PI;
      mag[y * w + x] = Math.sqrt(dx * dx + dy * dy);
      bin[y * w + x] = Math.min(nb - 1, Math.floor(ang / Math.PI * nb));
    }
    return { mag: mag, bin: bin };
  }

  // Same, but for colour pictures (3 planes): at every pixel keep the colour channel with the strongest edge.
  // Colour-blind (hue does not matter) but still sees gold-on-yellow edges that plain grey would lose.
  function gradientsMulti(planes, w, h, nb) {
    var best = null, c;
    for (c = 0; c < planes.length; c++) {
      var gr = gradients(planes[c], w, h, nb);
      if (!best) best = gr;
      else for (var i = 0; i < gr.mag.length; i++) if (gr.mag[i] > best.mag[i]) { best.mag[i] = gr.mag[i]; best.bin[i] = gr.bin[i]; }
    }
    return best;
  }

  // ---- global fingerprint: where edges of each direction are, on a coarse grid (cheap, stored per design) ----
  function globalVector(g240, w, h) {
    var g = resizeGray(g240, w, h, A.gW, A.gH);
    g = blurGray(g, A.gW, A.gH, 1.0);
    var gr = gradients(g, A.gW, A.gH, A.bins), cw = A.gW / A.gCX, ch = A.gH / A.gCY, F = new Float32Array(A.gCX * A.gCY * A.bins);
    for (var y = 0; y < A.gH; y++) for (var x = 0; x < A.gW; x++) {
      var cell = Math.min(A.gCY - 1, Math.floor(y / ch)) * A.gCX + Math.min(A.gCX - 1, Math.floor(x / cw));
      F[cell * A.bins + gr.bin[y * A.gW + x]] += gr.mag[y * A.gW + x];
    }
    var mx = 1e-9, i; for (i = 0; i < F.length; i++) { F[i] = Math.sqrt(F[i]); if (F[i] > mx) mx = F[i]; }
    var hex = ''; for (i = 0; i < F.length; i++) { var q = Math.round(F[i] / mx * 255); hex += (q < 16 ? '0' : '') + q.toString(16); }
    return hex;
  }
  var GLEN = A.gCX * A.gCY * A.bins * 2;
  function makeFingerprint(globalHex) { return 'v2:' + globalHex; }
  function parseFingerprint(fp) {
    fp = String(fp || '');
    if (fp.indexOf('v2:') !== 0 || fp.length !== 3 + GLEN) return null;
    var v = new Float32Array(GLEN / 2); for (var i = 0; i < v.length; i++) v[i] = parseInt(fp.substr(3 + i * 2, 2), 16);
    return v;
  }
  // 0..1. Allows the photo to be shifted by one grid cell either way.
  function similarity(fpA, fpB) {
    var a = parseFingerprint(fpA), b = parseFingerprint(fpB);
    if (!a || !b) return 0;
    var gx = A.gCX, gy = A.gCY, nb = A.bins, best = -1;
    for (var sy = -1; sy <= 1; sy++) for (var sx = -1; sx <= 1; sx++) {
      var ma = 0, mb = 0, n = 0, x, y, k;
      for (y = Math.max(0, sy); y < gy + Math.min(0, sy); y++) for (x = Math.max(0, sx); x < gx + Math.min(0, sx); x++)
        for (k = 0; k < nb; k++) { ma += a[(y * gx + x) * nb + k]; mb += b[((y - sy) * gx + (x - sx)) * nb + k]; n++; }
      ma /= n; mb /= n;
      var dot = 0, na = 0, nbv = 0;
      for (y = Math.max(0, sy); y < gy + Math.min(0, sy); y++) for (x = Math.max(0, sx); x < gx + Math.min(0, sx); x++)
        for (k = 0; k < nb; k++) { var u = a[(y * gx + x) * nb + k] - ma, v = b[((y - sy) * gx + (x - sx)) * nb + k] - mb; dot += u * v; na += u * u; nbv += v * v; }
      var c = dot / (Math.sqrt(na * nbv) + 1e-9); if (c > best) best = c;
    }
    return Math.max(0, best);
  }

  // ---- dense patch descriptors (SIFT-like, on a regular grid; the "pattern" check) ----
  function denseDescriptors(planes, w, h, step) {
    var P = A.patch, C = A.cells, nb = A.bins, cs = P / C, D = C * C * nb;
    var gb = planes.map(function (p) { return blurGray(p, w, h, 1.2); }), gr = gradientsMulti(gb, w, h, nb), vecs = [], pts = [], hist = new Float32Array(D);
    for (var y = 0; y + P <= h; y += step) for (var x = 0; x + P <= w; x += step) {
      hist.fill(0);
      for (var j = 0; j < P; j++) for (var i = 0; i < P; i++) {
        var idx = (y + j) * w + x + i;
        hist[((Math.floor(j / cs)) * C + Math.floor(i / cs)) * nb + gr.bin[idx]] += gr.mag[idx];
      }
      var n = 0, k; for (k = 0; k < D; k++) n += hist[k] * hist[k]; n = Math.sqrt(n);
      if (n < A.flat) continue;                         // plain fabric without pattern: skip
      var v = new Float32Array(D), nn = 0;
      for (k = 0; k < D; k++) { v[k] = Math.sqrt(hist[k] / n); nn += v[k] * v[k]; }
      nn = Math.sqrt(nn) + 1e-9; for (k = 0; k < D; k++) v[k] /= nn;
      vecs.push(v); pts.push([x + P / 2, y + P / 2, n]);
    }
    return { vecs: vecs, pts: pts, dim: D };
  }
  // Everything the app needs from one photo.
  // rgba: RGBA pixels (e.g. canvas ImageData.data) of the photo scaled to ~480 px wide, size w x h.
  function analyseRGBA(rgba, w, h) {
    var planes = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)], i;
    for (i = 0; i < w * h; i++) { planes[0][i] = rgba[i * 4]; planes[1][i] = rgba[i * 4 + 1]; planes[2][i] = rgba[i * 4 + 2]; }
    var c0 = cropGray(planes[0], w, h, A.crop), dh = Math.max(A.patch * 2, Math.round(c0.h * A.W / c0.w));
    var out = planes.map(function (p) { var c = cropGray(p, w, h, A.crop); return resizeGray(c.g, c.w, c.h, A.W, dh); });
    var gray = new Float32Array(A.W * dh);
    for (i = 0; i < gray.length; i++) gray[i] = 0.299 * out[0][i] + 0.587 * out[1][i] + 0.114 * out[2][i];
    return { planes: out, w: A.W, h: dh, fingerprint: makeFingerprint(globalVector(gray, A.W, dh)) };
  }
  // Query side: descriptors of the new photo at a few sizes (so zoomed-in / zoomed-out photos still match).
  function queryPyramid(an) {
    return A.scales.map(function (s) {
      var w = Math.round(an.w * s), h = Math.round(an.h * s);
      var pl = s === 1 ? an.planes : an.planes.map(function (p) { return resizeGray(p, an.w, an.h, w, h); });
      return denseDescriptors(pl, w, h, A.step);
    });
  }
  // Stored side: sparse, quantised signature kept in the Sheet (~30 KB per design).
  function makeSignature(an) {
    var d = denseDescriptors(an.planes, an.w, an.h, 16), order = d.pts.map(function (p, i) { return i; });
    order.sort(function (a, b) { return d.pts[b][2] - d.pts[a][2]; });
    order = order.slice(0, DEFAULTS.sigMaxPatches);
    var out = 'S1:' + order.length + ':', hex3 = function (n) { return ('000' + Math.max(0, Math.min(4095, Math.round(n))).toString(16)).slice(-3); };
    order.forEach(function (i) {
      out += hex3(d.pts[i][0]) + hex3(d.pts[i][1]);
      for (var k = 0; k < d.dim; k++) out += Math.round(Math.min(d.vecs[i][k], 0.75) / 0.75 * 15).toString(16);
    });
    return out;
  }
  function parseSignature(sig) {
    sig = String(sig || '');
    var m = /^S1:(\d+):/.exec(sig); if (!m) return null;
    var n = parseInt(m[1], 10), D = A.cells * A.cells * A.bins, rec = 6 + D, off = m[0].length;
    if (sig.length !== off + n * rec) return null;
    var vecs = [], pts = [];
    for (var i = 0; i < n; i++) {
      var o = off + i * rec, v = new Float32Array(D), nn = 0, k;
      pts.push([parseInt(sig.substr(o, 3), 16), parseInt(sig.substr(o + 3, 3), 16)]);
      for (k = 0; k < D; k++) { v[k] = parseInt(sig.charAt(o + 6 + k), 16) / 15 * 0.75; nn += v[k] * v[k]; }
      nn = Math.sqrt(nn) + 1e-9; for (k = 0; k < D; k++) v[k] /= nn;
      vecs.push(v);
    }
    return { vecs: vecs, pts: pts, n: n, dim: D };
  }
  // Share (0..1) of the stored design's patches that find a look-alike in the new photo AND agree on one placement.
  function patternScore(pyramid, stored) {
    if (!stored || !stored.n) return 0;
    var best = 0;
    pyramid.forEach(function (q) {
      if (q.vecs.length < 5) return;
      var votes = {}, D = stored.dim;
      for (var i = 0; i < stored.n; i++) {
        var s1 = -1, s2 = -1, bj = -1, a = stored.vecs[i];
        for (var j = 0; j < q.vecs.length; j++) {
          var b = q.vecs[j], d = 0; for (var k = 0; k < D; k++) d += a[k] * b[k];
          if (d > s1) { s2 = s1; s1 = d; bj = j; } else if (d > s2) s2 = d;
        }
        if (s1 > A.ratio && s1 - s2 > A.margin) {
          var kx = Math.round((q.pts[bj][0] - stored.pts[i][0]) / A.binPx), ky = Math.round((q.pts[bj][1] - stored.pts[i][1]) / A.binPx);
          votes[kx + ',' + ky] = (votes[kx + ',' + ky] || 0) + 1;
        }
      }
      var bestKey = null, bestV = 0; for (var key in votes) if (votes[key] > bestV) { bestV = votes[key]; bestKey = key; }
      if (bestKey) {
        var p = bestKey.split(','), cx = +p[0], cy = +p[1], tot = 0;
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) tot += votes[(cx + dx) + ',' + (cy + dy)] || 0;
        if (tot > best) best = tot;
      }
    });
    return best / stored.n;
  }

  // Rank the SAME supplier's designs by whole-photo similarity (cheap).
  function findMatches(fp, designs, supplier, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    var key = supplierKey(supplier), list = [];
    (designs || []).forEach(function (d) {
      if (supplierKey(d.supplier) !== key) return;
      var s = similarity(fp, d.fingerprint);
      list.push({ design_no: d.design_no, score: s, strong: s >= opts.strongMatch, design: d });
    });
    list.sort(function (x, y) { return y.score - x.score; });
    return list.filter(function (m) { return m.score >= opts.possibleMatch; });
  }
  // Combine the two checks into one verdict per candidate.
  function verdict(pattern, global, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    return pattern >= opts.patternSame ? 'same' : (pattern >= opts.patternMaybe || global >= opts.globalMaybe) ? 'maybe' : 'no';
  }
  // Full local check of one new photo against one supplier's designs.
  //  an: result of analyseRGBA, pyramid: queryPyramid(an), sigs: { design_no: signatureString }
  // Returns candidates best-first: [{ design_no, global, pattern, verdict, design }], only 'same' / 'maybe'.
  function matchDesigns(an, pyramid, designs, sigs, supplier, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    var key = supplierKey(supplier), ranked = [];
    (designs || []).forEach(function (d) {
      if (supplierKey(d.supplier) !== key) return;
      ranked.push({ design_no: d.design_no, design: d, global: similarity(an.fingerprint, d.fingerprint) });
    });
    ranked.sort(function (a, b) { return b.global - a.global; });
    var out = [];
    ranked.slice(0, opts.verifyTop).forEach(function (c) {
      var sig = sigs && sigs[c.design_no] ? parseSignature(sigs[c.design_no]) : null;
      c.pattern = sig ? patternScore(pyramid, sig) : 0;
      c.verdict = verdict(c.pattern, c.global, opts);
      if (c.verdict !== 'no') out.push(c);
    });
    out.sort(function (a, b) { return (b.verdict === 'same') - (a.verdict === 'same') || b.pattern - a.pattern || b.global - a.global; });
    return out;
  }

  // ---------- dates and status ----------
  function localDayNumber(iso, tzOffsetMin) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return NaN;
    return Math.floor((t + tzOffsetMin * 60000) / 86400000);
  }
  function localDateString(iso, tzOffsetMin) {
    var t = new Date(iso).getTime() + (tzOffsetMin == null ? DEFAULTS.tzOffsetMin : tzOffsetMin) * 60000;
    return new Date(t).toISOString().slice(0, 10);
  }
  function lastActivityMap(designs, sightings) {
    var m = {};
    (designs || []).forEach(function (d) { m[d.design_no] = d.created_at; });
    (sightings || []).forEach(function (s) {
      if (!m[s.design_no] || new Date(s.timestamp) > new Date(m[s.design_no])) m[s.design_no] = s.timestamp;
    });
    return m;
  }
  // Inactive = no sighting/registration for MORE than `inactiveDays` days.
  // daysInactive = whole calendar days since last activity (shown for inactive designs).
  function statusFor(lastIso, nowIso, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    var days = localDayNumber(nowIso, opts.tzOffsetMin) - localDayNumber(lastIso, opts.tzOffsetMin);
    if (isNaN(days) || days < 0) days = 0;
    var inactive = days > opts.inactiveDays;
    return { status: inactive ? 'Inactive' : 'Active', daysSinceActivity: days, daysInactive: inactive ? days : 0 };
  }
  function designStatuses(designs, sightings, nowIso, opts) {
    var last = lastActivityMap(designs, sightings);
    var counts = {};
    (sightings || []).forEach(function (s) { counts[s.design_no] = (counts[s.design_no] || 0) + 1; });
    return (designs || []).map(function (d) {
      var st = statusFor(last[d.design_no], nowIso, opts);
      return Object.assign({}, d, st, { last_activity: last[d.design_no], sightings: counts[d.design_no] || 0 });
    });
  }

  // ---------- monthly report ----------
  // month: 1-12. Status is evaluated at the END of the month (or now, if the month is current/future).
  function monthlyReport(designs, sightings, year, month, nowIso, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    var tz = opts.tzOffsetMin;
    var ym = year + '-' + String(month).padStart(2, '0');
    var inMonth = function (iso) { return localDateString(iso, tz).slice(0, 7) === ym; };

    var monthEndLocal = Date.UTC(year, month, 1) - 1;                 // last ms of month in "local" clock
    var endIso = new Date(monthEndLocal - tz * 60000).toISOString();
    var evalIso = new Date(endIso) > new Date(nowIso) ? nowIso : endIso;

    // Only data that existed by the evaluation date
    var dsnap = (designs || []).filter(function (d) { return new Date(d.created_at) <= new Date(evalIso); });
    var ssnap = (sightings || []).filter(function (s) { return new Date(s.timestamp) <= new Date(evalIso); });
    var rows = designStatuses(dsnap, ssnap, evalIso, opts);

    var newDesigns = dsnap.filter(function (d) { return inMonth(d.created_at); });
    var seen = ssnap.filter(function (s) { return s.type === 'SEEN' && inMonth(s.timestamp); });

    var bySupplier = {};
    rows.forEach(function (r) {
      var k = r.supplier;
      var o = bySupplier[k] || (bySupplier[k] = { supplier: k, total: 0, active: 0, inactive: 0, newThisMonth: 0, seenThisMonth: 0 });
      o.total++; if (r.status === 'Active') o.active++; else o.inactive++;
    });
    newDesigns.forEach(function (d) { if (bySupplier[d.supplier]) bySupplier[d.supplier].newThisMonth++; });
    seen.forEach(function (s) { if (bySupplier[s.supplier]) bySupplier[s.supplier].seenThisMonth++; });

    var inactiveList = rows.filter(function (r) { return r.status === 'Inactive'; })
      .sort(function (a, b) { return b.daysInactive - a.daysInactive; });

    return {
      period: ym,
      evaluatedAt: evalIso,
      inactiveAfterDays: opts.inactiveDays,
      totals: {
        designs: rows.length,
        active: rows.length - inactiveList.length,
        inactive: inactiveList.length,
        newThisMonth: newDesigns.length,
        repeatSightings: seen.length
      },
      suppliers: Object.keys(bySupplier).sort().map(function (k) { return bySupplier[k]; }),
      inactiveDesigns: inactiveList,
      newDesigns: newDesigns
    };
  }

  // ---------- validation ----------
  function validateRegistration(p) {
    var errors = [];
    if (!normalizeSupplier(p.supplier)) errors.push('Supplier name is required.');
    if (normalizeSupplier(p.supplier).length > 80) errors.push('Supplier name is too long (max 80).');
    if (!parseFingerprint(p.fingerprint)) errors.push('Photo could not be analysed. Please retake it.');
    if (!p.requestId) errors.push('Missing request id.');
    return errors;
  }

  return {
    DEFAULTS: DEFAULTS,
    normalizeSupplier: normalizeSupplier, supplierKey: supplierKey, supplierCode: supplierCode,
    nextDesignNo: nextDesignNo,
    resizeGray: resizeGray, analyseRGBA: analyseRGBA, queryPyramid: queryPyramid, makeSignature: makeSignature,
    parseSignature: parseSignature, patternScore: patternScore, verdict: verdict, matchDesigns: matchDesigns,
    makeFingerprint: makeFingerprint, parseFingerprint: parseFingerprint,
    similarity: similarity, findMatches: findMatches,
    localDateString: localDateString, statusFor: statusFor,
    lastActivityMap: lastActivityMap, designStatuses: designStatuses,
    monthlyReport: monthlyReport, validateRegistration: validateRegistration
  };
});
