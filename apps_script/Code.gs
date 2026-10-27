/**
 * MPS Design Registry - backend (Google Apps Script, container-bound to the Google Sheet).
 *
 * Files in this project: Code.gs (this file) + Core.gs (shared logic, generated from js/core.js).
 * Setup: run setup() once, then Deploy > New deployment > Web app
 *        (Execute as: Me, Who has access: Anyone). Copy the /exec URL into js/config.js.
 *
 * Sheets created: Designs, Sightings, Settings.   Photos go to a Drive folder.
 */

var SHEETS = {
  Designs:   ['design_no', 'supplier', 'supplier_code', 'fingerprint', 'photo_url', 'photo_id', 'created_at', 'created_by', 'notes'],
  Signatures: ['design_no', 'supplier', 'signature'],
  Sightings: ['sighting_id', 'design_no', 'supplier', 'type', 'timestamp', 'staff', 'photo_url', 'request_id', 'similarity'],
  Settings:  ['key', 'value']
};
var PHOTO_FOLDER_NAME = 'MPS Design Photos';
var GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';   // override with Script property GEMINI_MODEL
var GEMINI_MAX_CANDIDATES = 5;

/** Run once from the editor. Creates sheets, photo folder, and an access PIN. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = SHEETS[name];
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    // Plain-text columns so Sheets never turns ISO dates / hex fingerprints into numbers or dates
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
    sh.setFrozenRows(1);
  });
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('APP_PIN')) {
    var pin = String(Math.floor(100000 + Math.random() * 900000));
    props.setProperty('APP_PIN', pin);
    Logger.log('Your staff access PIN is: ' + pin + '  (change it in Project Settings > Script properties > APP_PIN)');
  }
  var settings = ss.getSheetByName('Settings');
  if (settings.getLastRow() < 2) {
    settings.getRange(2, 1, 1, 2).setValues([['inactive_days', String(MPSCore.DEFAULTS.inactiveDays)]]);
  }
  getPhotoFolder_();
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);
}

// ---------------- HTTP entry points ----------------
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (p.action === 'ping') return json_({ ok: true, service: 'mps-design-registry' });
    requirePin_(p.pin);
    if (p.action === 'list') {
      return json_({
        ok: true,
        designs: readAll_('Designs'),
        sightings: readAll_('Sightings'),
        settings: readSettings_(),
        serverTime: new Date().toISOString()
      });
    }
    if (p.action === 'signatures') {
      var key = MPSCore.supplierKey(p.supplier), out = {};
      readAll_('Signatures').forEach(function (r) { if (MPSCore.supplierKey(r.supplier) === key) out[r.design_no] = r.signature; });
      return json_({ ok: true, signatures: out });
    }
    if (p.action === 'auth') return json_({ ok: true });
    return json_({ ok: false, code: 'BAD_ACTION', error: 'Unknown action.' });
  } catch (err) {
    return json_(errorBody_(err));
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);       // sent as text/plain to avoid CORS preflight
    requirePin_(body.pin);
    if (body.action === 'register') return json_(register_(body));
    if (body.action === 'updateSettings') return json_(updateSettings_(body));
    if (body.action === 'verify') return json_(verify_(body));
    return json_({ ok: false, code: 'BAD_ACTION', error: 'Unknown action.' });
  } catch (err) {
    return json_(errorBody_(err));
  }
}

// ---------------- core operation ----------------
function register_(b) {
  var errors = MPSCore.validateRegistration(b);
  if (!b.staff || !String(b.staff).trim()) errors.push('Staff name is required.');
  if (b.mode !== 'new' && b.mode !== 'seen') errors.push('Invalid mode.');
  if (errors.length) return { ok: false, code: 'VALIDATION', errors: errors };

  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var supplier = MPSCore.normalizeSupplier(b.supplier);
    var settings = readSettings_();
    var opts = { inactiveDays: Number(settings.inactive_days) || MPSCore.DEFAULTS.inactiveDays };

    // Idempotency: a retried request returns the original result and writes nothing
    var sightings = readAll_('Sightings');
    for (var i = 0; i < sightings.length; i++) {
      if (sightings[i].request_id === b.requestId) {
        return { ok: true, duplicate_request: true, outcome: sightings[i].type === 'REGISTER' ? 'NEW' : 'SEEN',
                 design_no: sightings[i].design_no, supplier: supplier };
      }
    }

    var designs = readAll_('Designs');
    var now = new Date().toISOString();

    if (b.mode === 'seen') {
      var d = null;
      designs.forEach(function (x) { if (x.design_no === b.designNo) d = x; });
      if (!d) return { ok: false, code: 'NOT_FOUND', errors: ['Design ' + b.designNo + ' does not exist.'] };
      if (MPSCore.supplierKey(d.supplier) !== MPSCore.supplierKey(supplier)) {
        return { ok: false, code: 'SUPPLIER_MISMATCH', errors: ['That design belongs to a different supplier.'] };
      }
      var sim = MPSCore.similarity(b.fingerprint, d.fingerprint);
      var photo = savePhoto_(b.photo, d.design_no + '_seen_' + now.slice(0, 10));
      append_('Sightings', {
        sighting_id: Utilities.getUuid(), design_no: d.design_no, supplier: d.supplier, type: 'SEEN', timestamp: now,
        staff: b.staff, photo_url: photo.url, request_id: b.requestId, similarity: sim.toFixed(3)
      });
      return { ok: true, outcome: 'SEEN', design_no: d.design_no, supplier: d.supplier, similarity: sim };
    }

    // mode === 'new'
    if (!b.force) {
      var strong = MPSCore.findMatches(b.fingerprint, designs, supplier, opts).filter(function (m) { return m.strong; });
      if (strong.length) {
        return { ok: false, code: 'POSSIBLE_DUPLICATE',
                 errors: ['This looks like an existing design from the same supplier.'],
                 candidates: strong.slice(0, 3).map(function (m) { return { design_no: m.design_no, score: m.score, photo_url: m.design.photo_url }; }) };
      }
    }
    var designNo = MPSCore.nextDesignNo(supplier, designs);
    var saved = savePhoto_(b.photo, designNo);
    append_('Designs', {
      design_no: designNo, supplier: supplier, supplier_code: MPSCore.supplierCode(supplier), fingerprint: b.fingerprint,
      photo_url: saved.url, photo_id: saved.id, created_at: now, created_by: b.staff, notes: b.notes || ''
    });
    if (b.signature && /^S1:\d+:/.test(String(b.signature)) && String(b.signature).length < 49000) {
      append_('Signatures', { design_no: designNo, supplier: supplier, signature: b.signature });
    }
    append_('Sightings', {
      sighting_id: Utilities.getUuid(), design_no: designNo, supplier: supplier, type: 'REGISTER', timestamp: now,
      staff: b.staff, photo_url: saved.url, request_id: b.requestId, similarity: ''
    });
    return { ok: true, outcome: 'NEW', design_no: designNo, supplier: supplier, photo_url: saved.url };
  } finally {
    lock.releaseLock();
  }
}

function updateSettings_(b) {
  var days = parseInt(b.inactive_days, 10);
  if (isNaN(days) || days < 1 || days > 1000) return { ok: false, code: 'VALIDATION', errors: ['Inactive days must be between 1 and 1000.'] };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Settings');
  var rows = sh.getDataRange().getValues();
  var done = false;
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === 'inactive_days') { sh.getRange(i + 1, 2).setValue(String(days)); done = true; }
  }
  if (!done) sh.appendRow(['inactive_days', String(days)]);
  return { ok: true, settings: readSettings_() };
}

// ---------------- helpers ----------------
function requirePin_(pin) {
  var expected = PropertiesService.getScriptProperties().getProperty('APP_PIN');
  if (!expected || String(pin) !== expected) {
    var e = new Error('Wrong or missing PIN.'); e.code = 'AUTH'; throw e;
  }
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function errorBody_(err) {
  return { ok: false, code: err.code || 'SERVER_ERROR', error: err.code === 'AUTH' ? err.message : 'Server error: ' + err.message };
}
function toIso_(v) { return v instanceof Date ? v.toISOString() : String(v == null ? '' : v); }
// Text typed by staff must never be read by Sheets as a formula: quote it when it starts with = + - @
function sheetSafe_(v) { return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v; }
function sheetUnquote_(v) { return typeof v === 'string' && /^'[=+\-@]/.test(v) ? v.slice(1) : v; }
function readAll_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getRange(1, 1, sh.getLastRow(), SHEETS[name].length).getValues();
  var head = values[0];
  return values.slice(1).filter(function (r) { return r[0] !== ''; }).map(function (r) {
    var o = {};
    head.forEach(function (h, i) { o[h] = sheetUnquote_(toIso_(r[i])); });
    return o;
  });
}
function append_(name, obj) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  var row = SHEETS[name].map(function (h) { return obj[h] == null ? '' : sheetSafe_(obj[h]); });
  var r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
}
function readSettings_() {
  var out = {};
  readAll_('Settings').forEach(function (r) { out[r.key] = r.value; });
  return out;
}
function getPhotoFolder_() {
  var it = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER_NAME);
}
function savePhoto_(dataUrlOrBase64, name) {
  if (!dataUrlOrBase64) return { id: '', url: '' };
  var b64 = String(dataUrlOrBase64).replace(/^data:image\/\w+;base64,/, '');
  var blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', name + '.jpg');
  var file = getPhotoFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { id: file.getId(), url: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w600' };
}

// ---------------- Gemini second opinion (optional) ----------------
// Needs a free API key from Google AI Studio saved as Script property GEMINI_API_KEY. Without it, verify returns available:false
// and the app simply uses its own pattern check. Photos are sent to Google for this check (see README: privacy).
function verify_(b) {
  var props = PropertiesService.getScriptProperties(), apiKey = props.getProperty('GEMINI_API_KEY');
  if (!apiKey) return { ok: true, available: false };
  if (!b.photo) return { ok: false, code: 'VALIDATION', errors: ['Photo is required.'] };
  var supplierKey = MPSCore.supplierKey(b.supplier), wanted = (b.candidates || []).slice(0, GEMINI_MAX_CANDIDATES), cands = [];
  readAll_('Designs').forEach(function (d) {
    if (MPSCore.supplierKey(d.supplier) === supplierKey && wanted.indexOf(d.design_no) > -1 && d.photo_id) cands.push(d);
  });
  if (!cands.length) return { ok: true, available: true, results: [] };

  var parts = [{ text: 'You compare photos of woven silk / saree products for a textile business. The FIRST image is the NEW product. ' +
    'It is followed by CANDIDATE products, each introduced by a text label with its design number.\n' +
    'For every candidate decide whether it is the SAME DESIGN as the new product. Same design means the same woven motifs, the same arrangement of border, ' +
    'pallu and body motifs and the same weaving pattern. IGNORE colour (the same design is often made in several colours), lighting, folding, ' +
    'camera angle, zoom and background. Different motif shapes or a different layout means a DIFFERENT design even when the colours match.\n' +
    'Answer ONLY with JSON: {"results":[{"design_no":"...","same_design":true,"confidence":0.0,"reason":"max 15 words"}]} ' +
    'with one entry per candidate. confidence is 0 to 1. If you are unsure use a low confidence; do not guess.' },
    { text: 'NEW product photo:' }, { inline_data: { mime_type: 'image/jpeg', data: String(b.photo).replace(/^data:image\/\w+;base64,/, '') } }];
  cands.forEach(function (d) {
    try {
      var blob = DriveApp.getFileById(d.photo_id).getBlob();
      parts.push({ text: 'CANDIDATE design_no ' + d.design_no + ':' });
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: Utilities.base64Encode(blob.getBytes()) } });
    } catch (e) { /* photo missing in Drive: skip that candidate */ }
  });
  var model = props.getProperty('GEMINI_MODEL') || GEMINI_DEFAULT_MODEL;
  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify({ contents: [{ parts: parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } })
  });
  var code = res.getResponseCode();
  if (code !== 200) {
    return { ok: true, available: true, error: code === 429 ? 'Gemini free limit reached for now. Using the built-in check only.' : 'Gemini returned error ' + code + '. Using the built-in check only.' };
  }
  try {
    var data = JSON.parse(res.getContentText()), text = data.candidates[0].content.parts[0].text;
    text = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    var parsed = JSON.parse(text), known = {};
    cands.forEach(function (d) { known[d.design_no] = true; });
    var results = (parsed.results || []).filter(function (r) { return known[r.design_no]; }).map(function (r) {
      return { design_no: r.design_no, same_design: r.same_design === true, confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)), reason: String(r.reason || '').slice(0, 120) };
    });
    return { ok: true, available: true, results: results, model: model };
  } catch (e) {
    return { ok: true, available: true, error: 'Could not read Gemini\'s answer. Using the built-in check only.' };
  }
}
