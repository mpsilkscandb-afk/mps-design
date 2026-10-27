(function () {
  'use strict';
  var Core = window.MPSCore, Api = window.MPSApi, CFG = window.MPS_CONFIG || {};
  var $app = document.getElementById('app');
  var LS = window.localStorage;

  var state = {
    backend: CFG.API_URL ? new Api.RemoteBackend(CFG.API_URL) : new Api.DemoBackend(LS),
    pin: LS.getItem('mps-pin') || '',
    staff: LS.getItem('mps-staff') || '',
    data: null, serverTime: null, loading: false, loadError: '',
    reg: freshReg(),
    f: { q: '', supplier: '', status: '' },
    month: defaultMonth()
  };
  state.demo = state.backend.demo;

  function freshReg() { return { supplier: '', photo: '', photoSmall: '', fingerprint: '', signature: '', an: null, pyramid: null, requestId: '', choice: null, busy: false, error: '', done: null, analysing: false, matches: [], matching: false, gem: { state: 'idle', error: '' }, runId: 0 }; }
  var sigCache = {};
  function defaultMonth() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function nowIso() { return state.serverTime || new Date().toISOString(); }
  function opts() {
    var d = state.data && state.data.settings && Number(state.data.settings.inactive_days);
    return { inactiveDays: d || Core.DEFAULTS.inactiveDays, tzOffsetMin: CFG.TZ_OFFSET_MIN || 330 };
  }
  function fmtDate(iso) { return iso ? Core.localDateString(iso, opts().tzOffsetMin) : '—'; }
  function authed() { return state.demo ? !!state.staff : !!(state.pin && state.staff); }

  var toastTimer;
  function toast(msg) {
    var t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }

  // ---------- data ----------
  async function load(force) {
    if (state.data && !force) return;
    state.loading = true; state.loadError = '';
    try {
      var r = await state.backend.list(state.pin);
      if (!r.ok) {
        if (r.code === 'AUTH') { signOut('Your PIN is no longer valid. Please sign in again.'); return; }
        throw new Error(r.error || 'Could not load data.');
      }
      state.data = r; state.serverTime = r.serverTime || null;
    } catch (e) {
      state.loadError = 'Could not reach the registry (' + e.message + '). Check your internet and try again.';
    }
    state.loading = false;
  }
  function signOut(msg) {
    LS.removeItem('mps-pin'); state.pin = ''; state.staff = ''; state.data = null;
    if (msg) toast(msg);
    go('register');
  }

  // ---------- routing ----------
  function go(v) { if (location.hash === '#' + v) render(); else location.hash = '#' + v; }
  window.addEventListener('hashchange', render);

  async function render() {
    var hash = (location.hash || '#register').slice(1);
    var parts = hash.split('/'), view = parts[0];
    document.getElementById('banner').hidden = !state.demo;
    if (state.demo) { var b = document.getElementById('banner'); b.className = 'banner demo'; b.textContent = 'Demo mode — records are kept only in this browser. Connect the Google Sheets backend to share data (see README).'; }
    document.getElementById('foot-mode').textContent = state.demo ? 'Demo mode' : 'Connected to Google Sheets';
    document.querySelectorAll('#nav a').forEach(function (a) { a.classList.toggle('on', a.dataset.view === (view === 'design' ? 'catalogue' : view)); });
    document.querySelector('#nav').style.visibility = authed() ? 'visible' : 'hidden';
    document.title = 'MPS Silks — Design Registry';

    if (!authed()) { $app.innerHTML = loginView(); return; }
    if (!state.data) {
      $app.innerHTML = '<div class="skeleton" role="status" aria-label="Loading"></div>';
      await load(false);
    }
    if (state.loadError) {
      $app.innerHTML = '<div class="empty"><b>Cannot load</b>' + esc(state.loadError) + '<div style="margin-top:20px"><button class="btn" data-act="reload">Try again</button></div></div>';
      return;
    }
    var views = { register: registerView, catalogue: catalogueView, status: statusView, report: reportView, settings: settingsView, design: function () { return designView(parts[1]); } };
    $app.innerHTML = (views[view] || registerView)();
    afterRender(view);
    window.scrollTo(0, 0);
  }

  // ---------- views ----------
  function loginView() {
    return '<form class="login" id="login" autocomplete="off">' +
      '<img class="login-logo" src="assets/mps-logo.png" alt="MPS">' +
      '<p class="eyebrow">Staff access</p><h1>Design Registry</h1>' +
      '<p class="lede">Photograph a product, and the registry gives it a design number — or tells you the one it already has.</p>' +
      '<div class="field"><label for="in-staff">Your name</label><input id="in-staff" type="text" required maxlength="40" value="' + esc(state.staff || LS.getItem('mps-staff') || '') + '"></div>' +
      (state.demo ? '' : '<div class="field"><label for="in-pin">Access PIN</label><input id="in-pin" type="password" inputmode="numeric" required></div>') +
      '<p class="err" id="login-err" role="alert"></p>' +
      '<button class="btn block" type="submit">Enter</button></form>';
  }

  function suppliersList() {
    var seen = {}, out = [];
    (state.data.designs || []).forEach(function (d) { var k = Core.supplierKey(d.supplier); if (!seen[k]) { seen[k] = 1; out.push(d.supplier); } });
    return out.sort();
  }
  function regMatches() { return state.reg.matches || []; }

  // Stored pattern signatures of one supplier's designs (cached; cleared after every registration).
  async function getSigs(supplier) {
    var key = Core.supplierKey(supplier);
    if (sigCache[key]) return sigCache[key];
    var res = await state.backend.signatures(state.pin, supplier);
    sigCache[key] = (res && res.ok && res.signatures) || {};
    return sigCache[key];
  }
  function tierOf(m) {
    var g = m.gem;
    if (m.verdict === 'same' || (g && g.same_design && g.confidence >= 0.6)) return 3;
    if (g && g.same_design) return 2;
    return 1;
  }
  function sortMatches(list) { list.sort(function (a, b) { return tierOf(b) - tierOf(a) || (b.pattern || 0) - (a.pattern || 0) || (b.global || 0) - (a.global || 0); }); return list; }

  // Local check (instant, free), then an optional Gemini second opinion. Always ends with staff choosing.
  async function runMatch() {
    var r = state.reg; r.runId++; var id = r.runId;
    r.matches = []; r.gem = { state: 'idle', error: '' };
    if (!r.an || !Core.normalizeSupplier(r.supplier) || !state.data) { render(); return; }
    r.matching = true; render();
    var sigs = {}, supplier = r.supplier;
    try { sigs = await getSigs(supplier); } catch (e) { sigs = {}; }
    if (id !== r.runId) return;
    var local = Core.matchDesigns(r.an, r.pyramid, state.data.designs, sigs, supplier, opts());
    r.matches = sortMatches(local); r.matching = false; defaultChoice();
    // candidates for Gemini: local hits plus the best whole-photo look-alikes (so a different colour that the local check missed can still be caught)
    var cand = local.map(function (m) { return m.design_no; });
    Core.findMatches(r.fingerprint, state.data.designs, supplier, opts()).slice(0, 4).forEach(function (m) { if (cand.indexOf(m.design_no) < 0) cand.push(m.design_no); });
    if (state.demo || !cand.length) { render(); return; }
    r.gem = { state: 'running', error: '' }; render();
    try {
      var v = await state.backend.verify(state.pin, { supplier: supplier, photo: r.photo, candidates: cand.slice(0, 5) });
      if (id !== r.runId) return;
      if (!v.ok) { r.gem = { state: 'error', error: (v.errors || [v.error || 'Gemini check failed.']).join(' ') }; }
      else if (!v.available) { r.gem = { state: 'off', error: '' }; }
      else if (v.error) { r.gem = { state: 'error', error: v.error }; }
      else {
        var byNo = {}; state.data.designs.forEach(function (d) { byNo[d.design_no] = d; });
        var have = {}; r.matches.forEach(function (m) { have[m.design_no] = m; });
        (v.results || []).forEach(function (g) {
          if (have[g.design_no]) have[g.design_no].gem = g;
          else if (g.same_design && byNo[g.design_no]) { var m = { design_no: g.design_no, design: byNo[g.design_no], global: Core.similarity(r.fingerprint, byNo[g.design_no].fingerprint), pattern: 0, verdict: 'no', gem: g }; r.matches.push(m); have[g.design_no] = m; }
        });
        r.matches = sortMatches(r.matches); r.gem = { state: 'done', error: '', model: v.model };
        if (r.choice && r.choice !== 'new') { var cur = have[r.choice]; if (cur && cur.gem && !cur.gem.same_design && cur.gem.confidence >= 0.8) r.choice = null; }
        defaultChoice();
      }
    } catch (e) { if (id !== r.runId) return; r.gem = { state: 'error', error: 'Could not reach Gemini (' + e.message + '). Using the built-in check only.' }; }
    render();
  }

  function registerView() {
    var r = state.reg, matches = regMatches();
    var left =
      '<div class="field"><label for="supplier">Supplier name</label>' +
      '<input id="supplier" type="text" list="suppliers" maxlength="80" autocomplete="off" value="' + esc(r.supplier) + '" placeholder="e.g. Sri Lakshmi Silks">' +
      '<datalist id="suppliers">' + suppliersList().map(function (s) { return '<option value="' + esc(s) + '">'; }).join('') + '</datalist></div>' +
      '<label>Product photo</label>' +
      '<div class="drop">' + (r.photoSmall ? '<img alt="Selected product" src="' + esc(r.photoSmall) + '">' : '<div class="hint">Take or choose a photo<small>Lay the piece flat, good light, fill the frame</small></div>') +
      '<input id="photo" type="file" accept="image/*" aria-label="Take or choose product photo"></div>';

    var right;
    if (r.done) {
      right = '<div class="result"><p class="eyebrow">' + (r.done.outcome === 'NEW' ? 'New design created' : 'Existing design') + '</p>' +
        '<div class="bignum" id="dn">' + esc(r.done.design_no) + '</div>' +
        '<p class="mute">' + esc(r.done.supplier) + (r.done.outcome === 'SEEN' ? ' · sighting recorded, design stays active.' : ' · saved to the registry.') + '</p>' +
        '<div class="row" style="margin-top:28px"><button class="btn" data-act="copy">Copy number</button><button class="btn ghost" data-act="again">Register another</button></div></div>';
    } else if (r.analysing) {
      right = '<div class="result"><p class="eyebrow">Analysing photo</p><div class="skeleton" style="height:120px"></div></div>';
    } else if (!r.fingerprint || !Core.normalizeSupplier(r.supplier)) {
      right = '<div class="result"><p class="eyebrow">How it works</p><h2>Supplier, then photo.</h2>' +
        '<p class="mute" style="max-width:44ch">Enter the supplier name and take a picture. The registry compares it with that supplier’s earlier photos. If it recognises the design you will see its number; otherwise a new one is created.</p></div>';
    } else {
      var sel = r.choice;
      var body = '';
      if (r.matching) {
        body += '<p class="eyebrow">Checking earlier designs</p><div class="skeleton" style="height:120px"></div>';
      } else if (matches.length) {
        var strong = tierOf(matches[0]) === 3;
        body += '<p class="eyebrow">' + (strong ? 'Looks like an existing design' : 'Possible matches') + '</p>' +
          '<h2>' + (strong ? 'We have seen this before.' : 'Is it one of these?') + '</h2>' +
          '<p class="mute">Compare the photos by eye and confirm. Colour is ignored when matching, so the same design in another colour is offered too.</p><div class="cands">' +
          matches.slice(0, 6).map(function (m) {
            var g = m.gem, local = m.verdict === 'same' ? 'Pattern: strong match' : m.verdict === 'maybe' ? 'Pattern: possible' : '';
            var gl = g ? (g.same_design ? 'Gemini: same design (' + Math.round(g.confidence * 100) + '%)' : 'Gemini: different design') : '';
            var clash = g && !g.same_design && g.confidence >= 0.8 && m.verdict === 'same' ? '<span class="err">Checks disagree: look closely.</span>' : '';
            return '<button type="button" class="cand" data-act="pick" data-no="' + esc(m.design_no) + '" aria-pressed="' + (sel === m.design_no) + '">' +
              (m.design.photo_url ? '<img alt="" src="' + esc(m.design.photo_url) + '" loading="lazy">' : '<img alt="">') +
              '<div><span class="num">' + esc(m.design_no) + '</span>' + (local ? '<span class="mute">' + local + '</span><br>' : '') + (gl ? '<span class="mute">' + esc(gl) + '</span>' : '') + (g && g.reason ? '<br><span class="mute">' + esc(g.reason) + '</span>' : '') + clash + '</div></button>';
          }).join('') +
          '<button type="button" class="cand" data-act="pick" data-no="new" aria-pressed="' + (sel === 'new') + '"><div style="padding:36px 12px"><span class="num">None of these</span><span class="mute">Create a new design</span></div></button></div>';
      } else {
        body += '<p class="eyebrow">No match found</p><h2>This is a new design.</h2><p class="mute">Nothing from ' + esc(Core.normalizeSupplier(r.supplier)) + ' looks like this photo. A new design number will be created.</p>';
      }
      if (r.gem.state === 'running') body += '<p class="mute">Asking Gemini for a second opinion…</p>';
      else if (r.gem.state === 'error') body += '<p class="mute">' + esc(r.gem.error) + '</p>';
      var label = (matches.length && sel && sel !== 'new') ? 'Confirm — same design' : 'Generate design number';
      body += '<p class="err" role="alert">' + esc(r.error) + '</p>' +
        '<button class="btn" data-act="submit"' + ((r.busy || r.matching || r.gem.state === 'running' || (matches.length && !sel)) ? ' disabled' : '') + '>' + (r.busy ? 'Saving…' : label) + '</button>';
      right = '<div class="result">' + body + '</div>';
    }
    return '<p class="eyebrow">Register</p><h1>Every design,<br>one number.</h1><div class="split"><div class="narrow" style="max-width:none">' + left + '</div><div>' + right + '</div></div>';
  }

  function enriched() { return Core.designStatuses(state.data.designs, state.data.sightings, nowIso(), opts()); }

  function filtered(rows) {
    var f = state.f, q = f.q.trim().toLowerCase();
    return rows.filter(function (r) {
      return (!q || r.design_no.toLowerCase().indexOf(q) > -1 || r.supplier.toLowerCase().indexOf(q) > -1) &&
        (!f.supplier || Core.supplierKey(r.supplier) === Core.supplierKey(f.supplier)) &&
        (!f.status || r.status === f.status);
    });
  }
  function filterBar(withStatus) {
    return '<div class="tools"><div class="field"><label for="f-q">Search</label><input id="f-q" type="text" value="' + esc(state.f.q) + '" placeholder="Design no. or supplier"></div>' +
      '<div class="field"><label for="f-s">Supplier</label><select id="f-s"><option value="">All suppliers</option>' + suppliersList().map(function (s) { return '<option' + (Core.supplierKey(s) === Core.supplierKey(state.f.supplier) ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select></div>' +
      (withStatus ? '<div class="field"><label for="f-t">Status</label><select id="f-t"><option value="">All</option><option' + (state.f.status === 'Active' ? ' selected' : '') + '>Active</option><option' + (state.f.status === 'Inactive' ? ' selected' : '') + '>Inactive</option></select></div>' : '') + '</div>';
  }
  function thumb(u, cls) { return u ? '<img src="' + esc(u) + '" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'">' : '<img alt="">'; }

  function catalogueView() {
    var rows = filtered(enriched()).sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    var out = '<p class="eyebrow">Catalogue</p><h1>All designs</h1>' + filterBar(true);
    if (!state.data.designs.length) return out + '<div class="empty"><b>Nothing registered yet</b>Photograph the first product on the Register page.</div>';
    if (!rows.length) return out + '<div class="empty"><b>No results</b>Try clearing the filters.</div>';
    return out + '<div class="grid">' + rows.map(function (r) {
      return '<a class="card" href="#design/' + encodeURIComponent(r.design_no) + '"><div class="ph">' + thumb(r.photo_url) + '</div>' +
        '<div class="meta"><div><span class="num">' + esc(r.design_no) + '</span><br><span class="mute">' + esc(r.supplier) + '</span></div>' +
        '<div style="text-align:right"><span class="tag ' + r.status.toLowerCase() + '">' + r.status + '</span>' + (r.status === 'Inactive' ? '<br><span class="mute">' + r.daysInactive + ' days</span>' : '') + '</div></div></a>';
    }).join('') + '</div>';
  }

  function designView(no) {
    no = decodeURIComponent(no || '');
    var d = enriched().filter(function (x) { return x.design_no === no; })[0];
    if (!d) return '<div class="empty"><b>Design not found</b><a href="#catalogue">Back to catalogue</a></div>';
    var hist = state.data.sightings.filter(function (s) { return s.design_no === no; }).sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
    return '<p class="eyebrow"><a href="#catalogue" style="text-decoration:none">← Catalogue</a></p><div class="split"><div class="drop" style="cursor:default">' + (d.photo_url ? '<img alt="Design ' + esc(no) + '" src="' + esc(d.photo_url) + '">' : '') + '</div><div>' +
      '<h1 class="num">' + esc(d.design_no) + '</h1><p class="lede" style="margin-bottom:24px">' + esc(d.supplier) + '</p>' +
      '<div class="kpis"><div class="kpi"><span class="eyebrow">Status</span><b>' + d.status + '</b></div><div class="kpi"><span class="eyebrow">Days since activity</span><b>' + d.daysSinceActivity + '</b></div><div class="kpi"><span class="eyebrow">Sightings</span><b>' + Math.max(0, hist.length - 1) + '</b></div></div>' +
      '<h2>History</h2><div class="tablewrap"><table><thead><tr><th>Date</th><th>Event</th><th>Staff</th></tr></thead><tbody>' +
      hist.map(function (h) { return '<tr><td>' + fmtDate(h.timestamp) + '</td><td>' + (h.type === 'REGISTER' ? 'Registered' : 'Seen again') + '</td><td>' + esc(h.staff) + '</td></tr>'; }).join('') + '</tbody></table></div></div></div>';
  }

  function statusTable(rows, extraHead) {
    return '<div class="tablewrap"><table><thead><tr><th></th><th>Design</th><th>Supplier</th><th>Last activity</th><th class="r">Days since</th><th>Status</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td>' + thumb(r.photo_url) + '</td><td><a class="num" href="#design/' + encodeURIComponent(r.design_no) + '">' + esc(r.design_no) + '</a></td><td>' + esc(r.supplier) + '</td><td>' + fmtDate(r.last_activity) + '</td><td class="r">' + r.daysSinceActivity + '</td><td><span class="tag ' + r.status.toLowerCase() + '">' + r.status + (r.status === 'Inactive' ? ' · ' + r.daysInactive + ' days' : '') + '</span></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function statusView() {
    var all = enriched(), act = all.filter(function (r) { return r.status === 'Active'; }).length;
    var rows = filtered(all).sort(function (a, b) { return b.daysSinceActivity - a.daysSinceActivity; });
    var o = '<p class="eyebrow">Status</p><h1>Active &amp; inactive</h1><p class="lede">A design is inactive when it has not been registered or seen again for more than ' + opts().inactiveDays + ' days.</p>' +
      '<div class="kpis"><div class="kpi"><span class="eyebrow">Designs</span><b>' + all.length + '</b></div><div class="kpi"><span class="eyebrow">Active</span><b>' + act + '</b></div><div class="kpi"><span class="eyebrow">Inactive</span><b>' + (all.length - act) + '</b></div></div>' + filterBar(true);
    if (!all.length) return o + '<div class="empty"><b>No data yet</b>Status appears once designs are registered.</div>';
    if (!rows.length) return o + '<div class="empty"><b>No results</b>Try clearing the filters.</div>';
    return o + '<div class="row noprint" style="margin-bottom:16px"><button class="btn ghost" data-act="csv">Download CSV</button></div>' + statusTable(rows);
  }

  function reportData() {
    var p = state.month.split('-');
    return Core.monthlyReport(state.data.designs, state.data.sightings, +p[0], +p[1], nowIso(), opts());
  }
  function reportView() {
    var o = '<p class="eyebrow noprint">Report</p><h1 class="noprint">Monthly review</h1>' +
      '<div class="tools noprint"><div class="field"><label for="m">Month</label><input id="m" type="month" value="' + esc(state.month) + '"></div><button class="btn" data-act="print">Download PDF</button></div>';
    var r = reportData(), name = new Date(r.period + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    if (!r.totals.designs) return o + '<div class="empty"><b>No designs by the end of ' + esc(name) + '</b>Pick another month.</div>';
    return o + '<div class="paper" id="paper"><div class="rhead"><div><p class="eyebrow">MPS Silks · Design Registry</p><h2 style="margin:0">Monthly review — ' + esc(name) + '</h2></div><div class="mute" style="text-align:right;font-size:12px">Status as of ' + fmtDate(r.evaluatedAt) + '<br>Inactive = no activity for more than ' + r.inactiveAfterDays + ' days</div></div>' +
      '<div class="kpis"><div class="kpi"><span class="eyebrow">Total designs</span><b>' + r.totals.designs + '</b></div><div class="kpi"><span class="eyebrow">Active</span><b>' + r.totals.active + '</b></div><div class="kpi"><span class="eyebrow">Inactive</span><b>' + r.totals.inactive + '</b></div><div class="kpi"><span class="eyebrow">New this month</span><b>' + r.totals.newThisMonth + '</b></div><div class="kpi"><span class="eyebrow">Repeat sightings</span><b>' + r.totals.repeatSightings + '</b></div></div>' +
      '<h2>By supplier</h2><div class="tablewrap"><table><thead><tr><th>Supplier</th><th class="r">Designs</th><th class="r">Active</th><th class="r">Inactive</th><th class="r">New</th><th class="r">Seen again</th></tr></thead><tbody>' +
      r.suppliers.map(function (s) { return '<tr><td>' + esc(s.supplier) + '</td><td class="r">' + s.total + '</td><td class="r">' + s.active + '</td><td class="r">' + s.inactive + '</td><td class="r">' + s.newThisMonth + '</td><td class="r">' + s.seenThisMonth + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      '<h2>Inactive designs</h2>' + (r.inactiveDesigns.length ? '<div class="tablewrap"><table><thead><tr><th>Design</th><th>Supplier</th><th>Last activity</th><th class="r">Days inactive</th></tr></thead><tbody>' +
        r.inactiveDesigns.map(function (d) { return '<tr><td class="num">' + esc(d.design_no) + '</td><td>' + esc(d.supplier) + '</td><td>' + fmtDate(d.last_activity) + '</td><td class="r">' + d.daysInactive + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<p class="mute">None — every design was active.</p>') +
      '<h2>New designs this month</h2>' + (r.newDesigns.length ? '<div class="tablewrap"><table><thead><tr><th>Design</th><th>Supplier</th><th>Date</th><th>By</th></tr></thead><tbody>' +
        r.newDesigns.map(function (d) { return '<tr><td class="num">' + esc(d.design_no) + '</td><td>' + esc(d.supplier) + '</td><td>' + fmtDate(d.created_at) + '</td><td>' + esc(d.created_by) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<p class="mute">No new designs.</p>') +
      '<p class="note">Days inactive = whole days from the last registration or repeat sighting to the report date. Design matching is visual and approximate; confirmations are made by staff.</p></div>';
  }

  function settingsView() {
    return '<p class="eyebrow">Settings</p><h1>Settings</h1><div class="split"><div class="narrow">' +
      '<form id="set-form"><div class="field"><label for="inact">Inactive after (days)</label><input id="inact" type="number" min="1" max="1000" value="' + opts().inactiveDays + '"></div><p class="err" id="set-err" role="alert"></p><button class="btn" type="submit">Save</button></form></div>' +
      '<div><h2>Session</h2><p class="mute">Signed in as <b>' + esc(state.staff) + '</b>.<br>Storage: ' + (state.demo ? 'Demo (this browser only)' : 'Google Sheets') + '.</p><div class="row"><button class="btn ghost" data-act="reload">Refresh data</button><button class="btn ghost" data-act="signout">Sign out</button></div></div></div>';
  }

  // ---------- photo analysis ----------
  function loadBitmap(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read this image.')); };
      img.src = url;
    });
  }
  async function analyse(file) {
    var img = await loadBitmap(file);
    var s = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
    var big = document.createElement('canvas'); big.width = Math.round(img.naturalWidth * s); big.height = Math.round(img.naturalHeight * s);
    big.getContext('2d').drawImage(img, 0, 0, big.width, big.height);
    var photo = big.toDataURL('image/jpeg', 0.8);
    var t = Math.min(1, 240 / Math.max(img.naturalWidth, img.naturalHeight));
    var sm = document.createElement('canvas'); sm.width = Math.round(img.naturalWidth * t); sm.height = Math.round(img.naturalHeight * t);
    sm.getContext('2d').drawImage(img, 0, 0, sm.width, sm.height);
    var photoSmall = sm.toDataURL('image/jpeg', 0.7);
    // colour-blind pattern analysis works from a 480 px wide copy
    var w = 480, h = Math.max(64, Math.round(img.naturalHeight * 480 / img.naturalWidth));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, w, h);
    await new Promise(function (r) { setTimeout(r, 0); });          // let the "Analysing" state paint
    var an = Core.analyseRGBA(ctx.getImageData(0, 0, w, h).data, w, h);
    return { photo: photo, photoSmall: photoSmall, an: an, pyramid: Core.queryPyramid(an), fingerprint: an.fingerprint, signature: Core.makeSignature(an) };
  }
  function uuid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'r' + Date.now() + Math.random().toString(16).slice(2); }

  // ---------- actions ----------
  async function submitRegistration() {
    var r = state.reg, matches = regMatches();
    if (r.busy) return;
    var mode = (matches.length && r.choice && r.choice !== 'new') ? 'seen' : 'new';
    r.busy = true; r.error = ''; render();
    try {
      var res = await state.backend.register(state.pin, {
        supplier: r.supplier, staff: state.staff, fingerprint: r.fingerprint, signature: r.signature, requestId: r.requestId,
        mode: mode, designNo: mode === 'seen' ? r.choice : undefined, force: mode === 'new' && matches.length > 0,
        photo: state.demo ? '' : r.photo, photoSmall: state.demo ? r.photoSmall : ''
      });
      r.busy = false;
      if (res.ok) { r.done = res; sigCache = {}; await load(true); render(); return; }
      if (res.code === 'POSSIBLE_DUPLICATE') { await load(true); r.error = 'This photo is practically identical to an existing design. Please review the matches below.'; r.choice = null; await runMatch(); return; }
      else r.error = (res.errors || [res.error || 'Something went wrong.']).join(' ');
    } catch (e) {
      r.busy = false; r.error = 'Network problem — nothing was lost. Press the button to try again. (' + e.message + ')';
    }
    render();
  }

  document.addEventListener('submit', async function (e) {
    if (e.target.id === 'login') {
      e.preventDefault();
      var staff = document.getElementById('in-staff').value.trim(), pinEl = document.getElementById('in-pin'), err = document.getElementById('login-err');
      var pin = pinEl ? pinEl.value.trim() : '';
      err.textContent = '';
      if (!staff) { err.textContent = 'Please enter your name.'; return; }
      if (!state.demo) {
        try { var a = await state.backend.auth(pin); if (!a.ok) { err.textContent = a.error || 'Wrong PIN.'; return; } }
        catch (x) { err.textContent = 'Cannot reach the registry. Check your internet connection.'; return; }
      }
      state.staff = staff; state.pin = pin; LS.setItem('mps-staff', staff); if (pin) LS.setItem('mps-pin', pin);
      state.data = null; go('register'); render();
    }
    if (e.target.id === 'set-form') {
      e.preventDefault();
      var v = document.getElementById('inact').value, er = document.getElementById('set-err'); er.textContent = '';
      try {
        var res = await state.backend.updateSettings(state.pin, { inactive_days: v });
        if (!res.ok) { er.textContent = (res.errors || [res.error]).join(' '); return; }
        await load(true); toast('Saved'); render();
      } catch (x) { er.textContent = 'Could not save: ' + x.message; }
    }
  });

  document.addEventListener('click', async function (e) {
    var t = e.target.closest('[data-act]'); if (!t) return;
    var act = t.dataset.act, r = state.reg;
    if (act === 'pick') { r.choice = t.dataset.no; render(); }
    else if (act === 'submit') submitRegistration();
    else if (act === 'again') { state.reg = freshReg(); render(); }
    else if (act === 'copy') { try { await navigator.clipboard.writeText(r.done.design_no); toast('Copied ' + r.done.design_no); } catch (x) { toast('Copy failed — select the number manually.'); } }
    else if (act === 'reload') { state.data = null; await load(true); render(); }
    else if (act === 'signout') signOut();
    else if (act === 'print') { document.title = 'MPS-Design-Report-' + state.month; window.print(); }
    else if (act === 'csv') downloadCsv();
  });

  document.addEventListener('input', function (e) {
    var id = e.target.id;
    if (id === 'supplier') {
      state.reg.supplier = e.target.value; state.reg.choice = null;
      // light refresh of the right panel only when photo already present
      if (state.reg.fingerprint) { clearTimeout(render._t); render._t = setTimeout(async function () { var pos = e.target.selectionStart; await runMatch(); var el = document.getElementById('supplier'); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }, 700); }
    }
    if (id === 'f-q') { state.f.q = e.target.value; clearTimeout(render._f); render._f = setTimeout(function () { var p = e.target.selectionStart; render(); var el = document.getElementById('f-q'); if (el) { el.focus(); el.setSelectionRange(p, p); } }, 200); }
  });
  document.addEventListener('change', async function (e) {
    var id = e.target.id;
    if (id === 'photo') {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      var r = state.reg; r.analysing = true; r.error = ''; r.done = null; render();
      try {
        var a = await analyse(f);
        r.photo = a.photo; r.photoSmall = a.photoSmall; r.fingerprint = a.fingerprint; r.signature = a.signature; r.an = a.an; r.pyramid = a.pyramid; r.requestId = uuid(); r.choice = null;
      } catch (x) { r.error = x.message; r.fingerprint = ''; r.an = null; }
      r.analysing = false; await runMatch();
    }
    if (id === 'f-s') { state.f.supplier = e.target.value; render(); }
    if (id === 'f-t') { state.f.status = e.target.value; render(); }
    if (id === 'm' && e.target.value) { state.month = e.target.value; render(); }
  });
  function defaultChoice() {
    var r = state.reg, m = regMatches();
    if (m.length && tierOf(m[0]) === 3 && !r.choice) r.choice = m[0].design_no;
  }

  function downloadCsv() {
    var rows = filtered(enriched());
    var head = ['design_no', 'supplier', 'status', 'last_activity', 'days_since_activity', 'days_inactive'];
    var q = function (v) { v = String(v == null ? '' : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
    var csv = [head.join(',')].concat(rows.map(function (r) { return [r.design_no, r.supplier, r.status, fmtDate(r.last_activity), r.daysSinceActivity, r.daysInactive].map(q).join(','); })).join('\n');
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'mps-design-status.csv'; a.click();
  }

  function afterRender() { /* hook for future per-view setup */ }

  if (!location.hash) location.hash = '#register'; else render();
})();
