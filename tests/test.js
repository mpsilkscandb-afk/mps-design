const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const C = require('../js/core.js');

const F = require('./fixtures/load.js');
// ---------- test photos: two REAL silk photos (same design, two colours) + invented other designs ----------
const cache = {};
function analyse(key, img) {
  if (!cache[key]) { const an = C.analyseRGBA(img.d, img.w, img.h); cache[key] = { an, fp: an.fingerprint, sig: C.makeSignature(an), pyr: C.queryPyramid(an) }; }
  return cache[key];
}
const Y = F.real('yellow'), B = F.real('blue');
const photo = {
  yellow: () => analyse('yellow', Y), blue: () => analyse('blue', B),
  yellowRetake: () => analyse('yr', F.retake(Y, 1)), blueRetake: () => analyse('br', F.retake(B, 2)),
  yellowShift: () => analyse('ys', F.shift(Y, -25, 40)), blueZoom: () => analyse('bz', F.zoom(B, 0.82)),
  other: (i) => analyse('n' + i, F.synth(i))
};
const makePhoto = (seed) => photo.other(seed).fp;     // fingerprint of an invented design

test('supplier codes and design numbers', () => {
  assert.strictEqual(C.supplierCode('Sri Lakshmi Silks'), 'SLS');
  assert.strictEqual(C.supplierCode('Kanchi'), 'KAN');
  assert.strictEqual(C.supplierCode('  '), 'XXX');
  assert.strictEqual(C.nextDesignNo('Kanchi', []), 'MPS-KAN-0001');
  assert.strictEqual(C.nextDesignNo('Kanchi', [{ design_no: 'MPS-KAN-0007' }, { design_no: 'MPS-SLS-0100' }]), 'MPS-KAN-0008');
});

test('fingerprint is stable and the same photo matches itself', () => {
  const y = photo.yellow();
  assert.ok(C.parseFingerprint(y.fp));
  assert.ok(C.similarity(y.fp, y.fp) > 0.999);
  assert.ok(C.parseSignature(y.sig).n >= 100, 'signature should hold many patches');
  assert.ok(y.sig.length < 49000, 'signature must fit in one Sheet cell');
  assert.strictEqual(C.similarity('old-format', y.fp), 0);
});

test('same photo / retake / shifted / closer photo => verdict "same"', () => {
  const y = photo.yellow(), b = photo.blue();
  const cases = [['same photo', y, y], ['retake', photo.yellowRetake(), y], ['shifted', photo.yellowShift(), y], ['closer photo', photo.blueZoom(), b], ['retake of blue', photo.blueRetake(), b]];
  cases.forEach(([name, q, s]) => {
    const p = C.patternScore(q.pyr, C.parseSignature(s.sig)), v = C.verdict(p, C.similarity(q.fp, s.fp));
    assert.strictEqual(v, 'same', name + ' scored ' + p.toFixed(3));
  });
});

test('SAME DESIGN IN ANOTHER COLOUR (your yellow / blue photos) is offered as a match', () => {
  const y = photo.yellow(), b = photo.blue();
  [[b, y], [y, b], [photo.blueZoom(), y], [photo.blueRetake(), y]].forEach(([q, s], i) => {
    const p = C.patternScore(q.pyr, C.parseSignature(s.sig)), v = C.verdict(p, C.similarity(q.fp, s.fp));
    assert.notStrictEqual(v, 'no', 'colourway case ' + i + ' pattern ' + p.toFixed(3));
  });
});

test('invented different designs are not offered (against the real photos)', () => {
  let worst = 0, offered = 0, n = 0;
  [photo.yellow(), photo.blue()].forEach((stored) => {
    for (let i = 1; i <= 12; i++) {
      const q = photo.other(i), p = C.patternScore(q.pyr, C.parseSignature(stored.sig));
      worst = Math.max(worst, p); n++;
      if (C.verdict(p, C.similarity(q.fp, stored.fp)) !== 'no') offered++;
    }
  });
  assert.ok(offered <= 1, offered + ' of ' + n + ' unrelated designs were offered (worst pattern ' + worst.toFixed(3) + ')');
});

test('matchDesigns: only the same supplier, best first, and ignores designs without a signature', () => {
  const y = photo.yellow(), b = photo.blue();
  const designs = [
    { design_no: 'MPS-AAA-0001', supplier: 'Alpha', fingerprint: y.fp },
    { design_no: 'MPS-AAA-0002', supplier: 'Alpha', fingerprint: photo.other(3).fp },
    { design_no: 'MPS-BBB-0001', supplier: 'Beta', fingerprint: y.fp }
  ];
  const sigs = { 'MPS-AAA-0001': y.sig, 'MPS-AAA-0002': photo.other(3).sig, 'MPS-BBB-0001': y.sig };
  const m = C.matchDesigns(photo.yellowRetake().an, photo.yellowRetake().pyr, designs, sigs, ' alpha ');
  assert.strictEqual(m[0].design_no, 'MPS-AAA-0001');
  assert.strictEqual(m[0].verdict, 'same');
  assert.ok(m.every(x => x.design.supplier === 'Alpha'));
  assert.strictEqual(C.matchDesigns(photo.yellowRetake().an, photo.yellowRetake().pyr, designs, sigs, 'Gamma').length, 0);
  const noSig = C.matchDesigns(b.an, b.pyr, designs.slice(0, 1), {}, 'Alpha');   // colourway but no stored signature: falls back to whole-photo similarity
  assert.ok(noSig.length === 0 || noSig[0].pattern === 0);
});

test('active / inactive status and days', () => {
  const now = '2026-10-27T10:00:00Z';
  assert.deepStrictEqual(C.statusFor('2026-10-20T10:00:00Z', now), { status: 'Active', daysSinceActivity: 7, daysInactive: 0 });
  const s = C.statusFor('2026-06-01T10:00:00Z', now);
  assert.strictEqual(s.status, 'Inactive');
  assert.strictEqual(s.daysInactive, 148);
  // boundary: exactly 90 days is still active, 91 is inactive
  assert.strictEqual(C.statusFor('2026-07-29T10:00:00Z', now).status, 'Active');   // 90 days
  assert.strictEqual(C.statusFor('2026-07-28T10:00:00Z', now).status, 'Inactive'); // 91 days
});

test('sighting refreshes last activity', () => {
  const designs = [{ design_no: 'D1', supplier: 'A', created_at: '2026-01-01T00:00:00Z' }];
  const sightings = [{ design_no: 'D1', supplier: 'A', type: 'SEEN', timestamp: '2026-10-01T00:00:00Z' }];
  const r = C.designStatuses(designs, sightings, '2026-10-27T00:00:00Z')[0];
  assert.strictEqual(r.status, 'Active');
  assert.strictEqual(r.daysSinceActivity, 26);
  assert.strictEqual(r.sightings, 1);
});

test('monthly report counts and is evaluated at month end', () => {
  const designs = [
    { design_no: 'D1', supplier: 'A', created_at: '2026-03-05T05:00:00Z' },
    { design_no: 'D2', supplier: 'A', created_at: '2026-09-10T05:00:00Z' },
    { design_no: 'D3', supplier: 'B', created_at: '2026-09-20T05:00:00Z' },
    { design_no: 'D4', supplier: 'B', created_at: '2026-10-02T05:00:00Z' } // after Sept: must not appear
  ];
  const sightings = [
    { design_no: 'D2', supplier: 'A', type: 'SEEN', timestamp: '2026-09-25T05:00:00Z' },
    { design_no: 'D1', supplier: 'A', type: 'REGISTER', timestamp: '2026-03-05T05:00:00Z' }
  ];
  const r = C.monthlyReport(designs, sightings, 2026, 9, '2026-10-27T00:00:00Z');
  assert.strictEqual(r.totals.designs, 3);
  assert.strictEqual(r.totals.newThisMonth, 2);
  assert.strictEqual(r.totals.repeatSightings, 1);
  assert.strictEqual(r.totals.inactive, 1);                       // D1, last seen March
  assert.strictEqual(r.inactiveDesigns[0].design_no, 'D1');
  assert.strictEqual(r.suppliers.length, 2);
  assert.strictEqual(r.totals.active + r.totals.inactive, r.totals.designs);
});

test('validation', () => {
  assert.ok(C.validateRegistration({ supplier: '', fingerprint: 'x', requestId: '' }).length >= 3);
  assert.strictEqual(C.validateRegistration({ supplier: 'A', fingerprint: makePhoto(1), requestId: 'r' }).length, 0);
});

// ---------- backend (Code.gs) against an in-memory Google mock ----------
function buildGas() {
  class Range {
    constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
    setValues(v) { v.forEach((row, i) => row.forEach((x, j) => { (this.sh.data[this.r - 1 + i] ||= [])[this.c - 1 + j] = x; })); return this; }
    getValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(((this.sh.data[this.r - 1 + i] || [])[this.c - 1 + j]) ?? ''); out.push(row); }
      return out;
    }
    setValue(x) { return this.setValues([[x]]); }
    setFontWeight() { return this; } setNumberFormat() { return this; }
  }
  class Sheet {
    constructor(n) { this.name = n; this.data = []; }
    getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
    getDataRange() { return new Range(this, 1, 1, this.data.length, Math.max(0, ...this.data.map(x => x.length))); }
    getLastRow() { return this.data.filter(r => r && r.some(v => v !== '' && v != null)).length; }
    getMaxRows() { return 1000; } setFrozenRows() {}
    appendRow(row) { this.data.push(row); }
  }
  const sheets = {};
  const ss = {
    getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = new Sheet(n)),
    getSheets: () => Object.values(sheets), deleteSheet: () => {}
  };
  const files = [], props = { APP_PIN: '123456' }, logs = [], fetches = [], gemini = { status: 200, body: null };
  let uuid = 0, lockHeld = false;
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() { if (lockHeld) throw new Error('lock contention'); lockHeld = true; }, releaseLock() { lockHeld = false; } }) },
    Logger: { log: m => logs.push(m) },
    Utilities: { getUuid: () => 'uuid-' + (++uuid), base64Decode: s => Buffer.from(s, 'base64'), base64Encode: b => Buffer.from(b).toString('base64'), newBlob: (b, t, n) => ({ b, t, n }) },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 1 }, Permission: { VIEW: 1 },
      getFoldersByName: () => ({ hasNext: () => true, next: () => ({ createFile: blob => { files.push(blob); const id = 'file' + files.length; return { getId: () => id, setSharing() {} }; } }) }),
      getFileById: id => { const blob = files[Number(id.replace('file', '')) - 1]; if (!blob) throw new Error('not found'); return { getBlob: () => ({ getBytes: () => Array.from(Buffer.from('jpeg-of-' + id)) }) }; },
      createFolder: () => ({})
    },
    UrlFetchApp: { fetch: (url, opt) => { fetches.push({ url, opt }); return { getResponseCode: () => gemini.status, getContentText: () => typeof gemini.body === 'string' ? gemini.body : JSON.stringify(gemini.body) }; } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ getContent: () => s, setMimeType() { return this; } }) }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps_script/Core.gs'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps_script/Code.gs'), 'utf8'), ctx);
  const post = b => JSON.parse(vm.runInContext('doPost', ctx)({ postData: { contents: JSON.stringify(b) } }).getContent());
  const get = p => JSON.parse(vm.runInContext('doGet', ctx)({ parameter: p }).getContent());
  vm.runInContext('setup', ctx)();
  return { post, get, sheets, files, props, logs, fetches, gemini };
}
const PHOTO = Buffer.from('fakejpeg').toString('base64');
const reg = (o) => Object.assign({ action: 'register', pin: '123456', staff: 'Meena', supplier: 'Sri Lakshmi Silks', mode: 'new', photo: PHOTO, requestId: 'r' + Math.random() }, o);

test('backend: auth required', () => {
  const g = buildGas();
  assert.strictEqual(g.get({ action: 'list', pin: 'bad' }).code, 'AUTH');
  assert.strictEqual(g.post({ action: 'register', pin: '' }).code, 'AUTH');
  assert.strictEqual(g.get({ action: 'ping' }).ok, true);
});

test('backend: setup creates sheets, headers and keeps the PIN', () => {
  const g = buildGas();
  assert.deepStrictEqual(Object.keys(g.sheets).sort(), ['Designs', 'Settings', 'Sightings', 'Signatures']);
  assert.strictEqual(g.sheets.Designs.data[0][0], 'design_no');
  assert.strictEqual(g.props.APP_PIN, '123456');
});

test('backend: new design gets a number, photo and rows; survives a reload (list)', () => {
  const g = buildGas();
  const fp = makePhoto(11);
  const r = g.post(reg({ fingerprint: fp }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.outcome, 'NEW');
  assert.strictEqual(r.design_no, 'MPS-SLS-0001');
  assert.strictEqual(g.files.length, 1);
  const list = g.get({ action: 'list', pin: '123456' });
  assert.strictEqual(list.designs.length, 1);
  assert.strictEqual(list.sightings.length, 1);
  assert.strictEqual(list.designs[0].fingerprint, fp);
  assert.strictEqual(list.sightings[0].type, 'REGISTER');
});

test('backend: numbers increment per supplier', () => {
  const g = buildGas();
  assert.strictEqual(g.post(reg({ fingerprint: makePhoto(21) })).design_no, 'MPS-SLS-0001');
  assert.strictEqual(g.post(reg({ fingerprint: makePhoto(22) })).design_no, 'MPS-SLS-0002');
  assert.strictEqual(g.post(reg({ supplier: 'Kanchi', fingerprint: makePhoto(23) })).design_no, 'MPS-KAN-0001');
});

test('backend: retried request is idempotent', () => {
  const g = buildGas();
  const body = reg({ fingerprint: makePhoto(31), requestId: 'same-id' });
  const a = g.post(body), b = g.post(body);
  assert.strictEqual(a.design_no, b.design_no);
  assert.strictEqual(b.duplicate_request, true);
  assert.strictEqual(g.get({ action: 'list', pin: '123456' }).designs.length, 1);
  assert.strictEqual(g.files.length, 1);
});

test('backend: same design re-photographed is flagged, not silently duplicated', () => {
  const g = buildGas();
  g.post(reg({ fingerprint: photo.yellow().fp }));
  const again = g.post(reg({ fingerprint: photo.yellowRetake().fp }));
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.code, 'POSSIBLE_DUPLICATE');
  assert.strictEqual(again.candidates[0].design_no, 'MPS-SLS-0001');
  assert.strictEqual(g.get({ action: 'list', pin: '123456' }).designs.length, 1);
});

test('backend: staff can override (force) or confirm as seen; sighting updates activity', () => {
  const g = buildGas();
  g.post(reg({ fingerprint: photo.yellow().fp }));
  const forced = g.post(reg({ fingerprint: photo.yellow().fp, force: true }));
  assert.strictEqual(forced.design_no, 'MPS-SLS-0002');
  const seen = g.post(reg({ mode: 'seen', designNo: 'MPS-SLS-0001', fingerprint: photo.yellowRetake().fp }));
  assert.strictEqual(seen.outcome, 'SEEN');
  const list = g.get({ action: 'list', pin: '123456' });
  assert.strictEqual(list.sightings.filter(s => s.type === 'SEEN').length, 1);
});

test('backend: seen on another supplier\'s design or unknown design is rejected', () => {
  const g = buildGas();
  g.post(reg({ fingerprint: makePhoto(61) }));
  assert.strictEqual(g.post(reg({ mode: 'seen', designNo: 'MPS-SLS-0001', supplier: 'Other', fingerprint: makePhoto(61) })).code, 'SUPPLIER_MISMATCH');
  assert.strictEqual(g.post(reg({ mode: 'seen', designNo: 'MPS-SLS-0099', fingerprint: makePhoto(61) })).code, 'NOT_FOUND');
});

test('backend: invalid input gives readable errors and writes nothing', () => {
  const g = buildGas();
  const r = g.post(reg({ supplier: '', fingerprint: 'bad', staff: '' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'VALIDATION');
  assert.ok(r.errors.length >= 3);
  assert.strictEqual(g.get({ action: 'list', pin: '123456' }).designs.length, 0);
});

test('backend: lock is always released, even after an error', () => {
  const g = buildGas();
  g.post(reg({ mode: 'seen', designNo: 'nope', fingerprint: makePhoto(71) }));
  assert.strictEqual(g.post(reg({ fingerprint: makePhoto(72) })).ok, true);
});

test('backend: inactive-days setting is validated and applied', () => {
  const g = buildGas();
  assert.strictEqual(g.post({ action: 'updateSettings', pin: '123456', inactive_days: 'abc' }).ok, false);
  assert.strictEqual(g.post({ action: 'updateSettings', pin: '123456', inactive_days: 60 }).settings.inactive_days, '60');
});

test('backend: signature is stored with a new design and served per supplier only', () => {
  const g = buildGas(), y = photo.yellow();
  g.post(reg({ fingerprint: y.fp, signature: y.sig }));
  g.post(reg({ supplier: 'Kanchi', fingerprint: photo.other(5).fp, signature: photo.other(5).sig }));
  const r = g.get({ action: 'signatures', pin: '123456', supplier: ' sri lakshmi SILKS ' });
  assert.deepStrictEqual(Object.keys(r.signatures), ['MPS-SLS-0001']);
  assert.strictEqual(r.signatures['MPS-SLS-0001'], y.sig);
  assert.strictEqual(g.get({ action: 'signatures', pin: 'bad', supplier: 'x' }).code, 'AUTH');
  assert.strictEqual(g.post(reg({ fingerprint: photo.other(6).fp, signature: 'junk' })).ok, true);   // junk signature is ignored, not stored
  assert.strictEqual(Object.keys(g.get({ action: 'signatures', pin: '123456', supplier: 'Sri Lakshmi Silks' }).signatures).length, 1);
});

test('backend: text starting with = + - @ is stored safely and read back unchanged', () => {
  const g = buildGas();
  g.post(reg({ supplier: '=IMPORTXML("http://x")', staff: '+cmd', fingerprint: photo.other(7).fp }));
  const raw = g.sheets.Designs.data[1];
  assert.ok(raw[1].startsWith("'="), 'stored value must be quoted: ' + raw[1]);
  const list = g.get({ action: 'list', pin: '123456' });
  assert.strictEqual(list.designs[0].supplier, '=IMPORTXML("http://x")');
  assert.strictEqual(list.designs[0].created_by, '+cmd');
});

test('backend: Gemini verify is off without a key', () => {
  const g = buildGas();
  const r = g.post({ action: 'verify', pin: '123456', supplier: 'A', photo: PHOTO, candidates: [] });
  assert.deepStrictEqual(r, { ok: true, available: false });
  assert.strictEqual(g.fetches.length, 0, 'must not call out without a key');
});

test('backend: Gemini verify sends photos, parses the answer, ignores unknown designs', () => {
  const g = buildGas(); g.props.GEMINI_API_KEY = 'KEY123';
  g.post(reg({ fingerprint: photo.yellow().fp })); g.post(reg({ fingerprint: photo.other(8).fp }));
  g.post(reg({ supplier: 'Kanchi', fingerprint: photo.other(9).fp }));
  g.gemini.body = { candidates: [{ content: { parts: [{ text: '```json\n{"results":[{"design_no":"MPS-SLS-0001","same_design":true,"confidence":0.92,"reason":"same border motifs"},{"design_no":"MPS-SLS-0002","same_design":false,"confidence":0.8,"reason":"different layout"},{"design_no":"MPS-KAN-0001","same_design":true,"confidence":1,"reason":"other supplier"}]}\n```' }] } }] };
  const r = g.post({ action: 'verify', pin: '123456', supplier: 'Sri Lakshmi Silks', photo: 'data:image/jpeg;base64,' + PHOTO, candidates: ['MPS-SLS-0001', 'MPS-SLS-0002', 'MPS-KAN-0001'] });
  assert.strictEqual(r.available, true);
  assert.deepStrictEqual(r.results.map(x => [x.design_no, x.same_design]), [['MPS-SLS-0001', true], ['MPS-SLS-0002', false]]);
  const call = g.fetches[0];
  assert.ok(call.url.includes('generateContent'));
  assert.strictEqual(call.opt.headers['x-goog-api-key'], 'KEY123');
  assert.ok(!call.url.includes('KEY123'), 'key must not be in the URL');
  const parts = JSON.parse(call.opt.payload).contents[0].parts;
  assert.strictEqual(parts.filter(p => p.inline_data).length, 3, 'new photo + 2 candidate photos (other supplier excluded)');
  assert.ok(!JSON.stringify(parts).includes('data:image'), 'data-URL prefix must be stripped');
});

test('backend: Gemini errors degrade gracefully (rate limit, bad answer)', () => {
  const g = buildGas(); g.props.GEMINI_API_KEY = 'K';
  g.post(reg({ fingerprint: photo.yellow().fp }));
  const call = () => g.post({ action: 'verify', pin: '123456', supplier: 'Sri Lakshmi Silks', photo: PHOTO, candidates: ['MPS-SLS-0001'] });
  g.gemini.status = 429; g.gemini.body = {};
  let r = call(); assert.strictEqual(r.ok, true); assert.ok(/limit/i.test(r.error)); assert.strictEqual(r.results, undefined);
  g.gemini.status = 200; g.gemini.body = { candidates: [{ content: { parts: [{ text: 'not json at all' }] } }] };
  r = call(); assert.strictEqual(r.ok, true); assert.ok(r.error);
  g.gemini.body = {}; r = call(); assert.ok(r.error);
});

test('backend: verify needs the PIN and a photo', () => {
  const g = buildGas(); g.props.GEMINI_API_KEY = 'K';
  assert.strictEqual(g.post({ action: 'verify', pin: 'bad', supplier: 'A', photo: PHOTO, candidates: [] }).code, 'AUTH');
  assert.strictEqual(g.post({ action: 'verify', pin: '123456', supplier: 'A', candidates: [] }).code, 'VALIDATION');
});
