// Test images for the matcher: two REAL silk photos (same design, two colours; 480 px wide RGBA)
// plus variants and synthetic "other designs" generated here with a seeded random generator.
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'meta.json'), 'utf8'));

function real(name) {
  const [w, h] = meta[name];
  return { w, h, d: Uint8ClampedArray.from(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, name + '.rgba.gz')))) };
}
function clone(im) { return { w: im.w, h: im.h, d: Uint8ClampedArray.from(im.d) }; }
function shift(im, dx, dy) {
  const o = clone(im);
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
    const sx = Math.min(im.w - 1, Math.max(0, x - dx)), sy = Math.min(im.h - 1, Math.max(0, y - dy));
    for (let c = 0; c < 4; c++) o.d[(y * im.w + x) * 4 + c] = im.d[(sy * im.w + sx) * 4 + c];
  }
  return o;
}
function zoom(im, frac) {            // closer photo: keep the central `frac`, scale back up (nearest neighbour is fine here)
  const o = clone(im), x0 = (1 - frac) / 2 * im.w, y0 = (1 - frac) / 2 * im.h;
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
    const sx = Math.floor(x0 + x * frac), sy = Math.floor(y0 + y * frac);
    for (let c = 0; c < 4; c++) o.d[(y * im.w + x) * 4 + c] = im.d[(sy * im.w + sx) * 4 + c];
  }
  return o;
}
function retake(im, seed) {           // another phone shot: softer, brighter, a little noise, nudged
  const r = rng(seed), o = shift(im, 6, -4), tmp = clone(o);
  for (let y = 1; y < im.h - 1; y++) for (let x = 1; x < im.w - 1; x++) for (let c = 0; c < 3; c++) {
    let s = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += tmp.d[((y + j) * im.w + x + i) * 4 + c];
    o.d[(y * im.w + x) * 4 + c] = Math.min(255, s / 9 * 1.1 + (r() - 0.5) * 8);
  }
  return o;
}
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
// An invented design: random background, random accent, random mix of motifs at random places.
function synth(seed, w = 480, h = 853) {
  const r = rng(seed * 7919 + 13), d = new Uint8ClampedArray(w * h * 4);
  const base = [20 + r() * 200, 20 + r() * 200, 20 + r() * 200], acc = [100 + r() * 155, 100 + r() * 155, 100 + r() * 155];
  for (let i = 0; i < w * h; i++) { d[i * 4] = base[0]; d[i * 4 + 1] = base[1]; d[i * 4 + 2] = base[2]; d[i * 4 + 3] = 255; }
  const dot = (x, y, t) => { for (let j = -t; j <= t; j++) for (let i = -t; i <= t; i++) { const px = Math.round(x + i), py = Math.round(y + j); if (px >= 0 && py >= 0 && px < w && py < h) { const k = (py * w + px) * 4; d[k] = acc[0]; d[k + 1] = acc[1]; d[k + 2] = acc[2]; } } };
  const line = (x0, y0, x1, y1, t) => { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); for (let i = 0; i <= n; i++) dot(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, t); };
  const ring = (cx, cy, rx, ry, t) => { for (let a = 0; a < 6.3; a += 0.03) dot(cx + rx * Math.cos(a), cy + ry * Math.sin(a), t); };
  const n = 25 + Math.floor(r() * 40);
  for (let k = 0; k < n; k++) {
    const kind = Math.floor(r() * 4), x = r() * w, y = h * 0.25 + r() * h * 0.7, s = 15 + r() * 90, t = 1 + Math.floor(r() * 3), a = r() * 6.28;
    if (kind === 0) ring(x, y, s, s * (0.4 + r() * 1.3), t);
    else if (kind === 1) line(x, y, x + Math.cos(a) * s * 2, y + Math.sin(a) * s * 2, t);
    else if (kind === 2) { line(x, y, x + s, y, t); line(x + s, y, x + s, y + s * 0.6, t); line(x + s, y + s * 0.6, x, y + s * 0.6, t); line(x, y + s * 0.6, x, y, t); }
    else { line(x, y, x + s, y + s * 0.5, t); line(x + s, y + s * 0.5, x + s * 0.3, y + s, t); line(x + s * 0.3, y + s, x, y, t); }
  }
  return { w, h, d };
}
module.exports = { real, shift, zoom, retake, synth };
