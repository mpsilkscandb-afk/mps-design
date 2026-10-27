/*
 * API layer. Two interchangeable backends with the same interface:
 *   RemoteBackend - talks to the Google Apps Script web app (real mode)
 *   DemoBackend   - keeps data in browser localStorage (demo mode ONLY; not shared, not in Google Sheets)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.MPSApi = factory(root.MPSCore);
})(this, function (Core) {
  'use strict';

  function RemoteBackend(url) {
    this.url = url; this.demo = false;
  }
  RemoteBackend.prototype._get = async function (params) {
    var q = new URLSearchParams(params).toString();
    var res = await fetch(this.url + (this.url.indexOf('?') > -1 ? '&' : '?') + q, { method: 'GET', redirect: 'follow' });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    return res.json();
  };
  RemoteBackend.prototype._post = async function (body) {
    // text/plain avoids a CORS preflight, which Apps Script cannot answer
    var res = await fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    return res.json();
  };
  RemoteBackend.prototype.auth = function (pin) { return this._get({ action: 'auth', pin: pin }); };
  RemoteBackend.prototype.list = function (pin) { return this._get({ action: 'list', pin: pin }); };
  RemoteBackend.prototype.register = function (pin, payload) { return this._post(Object.assign({ action: 'register', pin: pin }, payload)); };
  RemoteBackend.prototype.signatures = function (pin, supplier) { return this._get({ action: 'signatures', pin: pin, supplier: supplier }); };
  RemoteBackend.prototype.verify = function (pin, payload) { return this._post(Object.assign({ action: 'verify', pin: pin }, payload)); };
  RemoteBackend.prototype.updateSettings = function (pin, s) { return this._post(Object.assign({ action: 'updateSettings', pin: pin }, s)); };

  // ---------------- demo backend (mirrors Code.gs rules) ----------------
  var KEY = 'mps-demo-db-v1';
  function DemoBackend(storage) {
    this.demo = true; this.store = storage;
  }
  DemoBackend.prototype._load = function () {
    try { var v = JSON.parse(this.store.getItem(KEY)); if (v) return v; } catch (e) {}
    return { designs: [], sightings: [], settings: { inactive_days: String(Core.DEFAULTS.inactiveDays) } };
  };
  DemoBackend.prototype._save = function (db) { this.store.setItem(KEY, JSON.stringify(db)); };
  DemoBackend.prototype.signatures = async function (pin, supplier) {
    var db = this._load(), key = Core.supplierKey(supplier), out = {};
    (db.signatures || []).forEach(function (r) { if (Core.supplierKey(r.supplier) === key) out[r.design_no] = r.signature; });
    return { ok: true, signatures: out };
  };
  DemoBackend.prototype.verify = async function () { return { ok: true, available: false }; };   // Gemini needs the real backend
  DemoBackend.prototype.auth = async function () { return { ok: true }; };
  DemoBackend.prototype.list = async function () {
    var db = this._load();
    return { ok: true, designs: db.designs, sightings: db.sightings, settings: db.settings, serverTime: new Date().toISOString() };
  };
  DemoBackend.prototype.updateSettings = async function (pin, s) {
    var d = parseInt(s.inactive_days, 10);
    if (isNaN(d) || d < 1 || d > 1000) return { ok: false, code: 'VALIDATION', errors: ['Inactive days must be between 1 and 1000.'] };
    var db = this._load(); db.settings.inactive_days = String(d); this._save(db);
    return { ok: true, settings: db.settings };
  };
  DemoBackend.prototype.register = async function (pin, b) {
    var errors = Core.validateRegistration(b);
    if (!b.staff || !String(b.staff).trim()) errors.push('Staff name is required.');
    if (b.mode !== 'new' && b.mode !== 'seen') errors.push('Invalid mode.');
    if (errors.length) return { ok: false, code: 'VALIDATION', errors: errors };
    var db = this._load(), supplier = Core.normalizeSupplier(b.supplier), now = new Date().toISOString();
    var opts = { inactiveDays: Number(db.settings.inactive_days) || Core.DEFAULTS.inactiveDays };
    var prior = db.sightings.filter(function (s) { return s.request_id === b.requestId; })[0];
    if (prior) return { ok: true, duplicate_request: true, outcome: prior.type === 'REGISTER' ? 'NEW' : 'SEEN', design_no: prior.design_no, supplier: supplier };
    var thumb = b.photoSmall || '';
    if (b.mode === 'seen') {
      var d = db.designs.filter(function (x) { return x.design_no === b.designNo; })[0];
      if (!d) return { ok: false, code: 'NOT_FOUND', errors: ['Design ' + b.designNo + ' does not exist.'] };
      if (Core.supplierKey(d.supplier) !== Core.supplierKey(supplier)) return { ok: false, code: 'SUPPLIER_MISMATCH', errors: ['That design belongs to a different supplier.'] };
      var sim = Core.similarity(b.fingerprint, d.fingerprint);
      db.sightings.push({ sighting_id: 's' + Date.now() + Math.random(), design_no: d.design_no, supplier: d.supplier, type: 'SEEN', timestamp: now, staff: b.staff, photo_url: '', request_id: b.requestId, similarity: sim.toFixed(3) });
      this._save(db);
      return { ok: true, outcome: 'SEEN', design_no: d.design_no, supplier: d.supplier, similarity: sim };
    }
    if (!b.force) {
      var strong = Core.findMatches(b.fingerprint, db.designs, supplier, opts).filter(function (m) { return m.strong; });
      if (strong.length) return { ok: false, code: 'POSSIBLE_DUPLICATE', errors: ['This looks like an existing design from the same supplier.'], candidates: strong.slice(0, 3).map(function (m) { return { design_no: m.design_no, score: m.score, photo_url: m.design.photo_url }; }) };
    }
    var no = Core.nextDesignNo(supplier, db.designs);
    if (b.signature && /^S1:\d+:/.test(String(b.signature))) (db.signatures = db.signatures || []).push({ design_no: no, supplier: supplier, signature: b.signature });
    db.designs.push({ design_no: no, supplier: supplier, supplier_code: Core.supplierCode(supplier), fingerprint: b.fingerprint, photo_url: thumb, photo_id: '', created_at: now, created_by: b.staff, notes: b.notes || '' });
    db.sightings.push({ sighting_id: 's' + Date.now() + Math.random(), design_no: no, supplier: supplier, type: 'REGISTER', timestamp: now, staff: b.staff, photo_url: thumb, request_id: b.requestId, similarity: '' });
    try { this._save(db); } catch (e) { return { ok: false, code: 'STORAGE_FULL', errors: ['Demo storage is full. Connect the real Google Sheets backend.'] }; }
    return { ok: true, outcome: 'NEW', design_no: no, supplier: supplier, photo_url: thumb };
  };

  return { RemoteBackend: RemoteBackend, DemoBackend: DemoBackend };
});
