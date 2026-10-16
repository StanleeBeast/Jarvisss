// JARVIS Gerätesitzung im Browser.
// Gespeichert wird nur der rotierende Geräteschlüssel (30 Tage). Der 15-Minuten-Zugangsschlüssel liegt
// ausschließlich im Arbeitsspeicher. Nach der Anmeldung wird das gemeinsame Admin-Token vom Gerät entfernt.
(function () {
  'use strict';
  const SESSION_KEY = 'jarvis_device_session_v1';
  const ADMIN_KEY = 'jarvis_access_token_v1';
  const REFRESH_MARGIN_MS = 60_000;
  let access = null, accessExpiresAt = 0, inflight = null;

  const el = (id) => document.getElementById(id);
  const readSession = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } };
  const writeSession = (session) => { try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* privater Modus */ } };
  const fmt = (iso) => iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function guessDeviceName() {
    const ua = navigator.userAgent;
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'PC';
    return 'Browser';
  }

  async function post(path, body, token) {
    const base = apiBase();
    if (!base) return { ok: false, status: 0, error: 'no_endpoint' };
    try {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body || {}), cache: 'no-store', signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined });
      let data = null;
      try { data = await res.json(); } catch { /* kein JSON */ }
      return { ok: res.ok, status: res.status, body: data, error: res.ok ? null : (data && data.error) || 'http_' + res.status };
    } catch (e) {
      return { ok: false, status: 0, error: navigator.onLine === false ? 'offline' : 'unreachable' };
    }
  }

  function adopt(result) {
    writeSession({ refreshToken: result.refreshToken, refreshExpiresAt: result.refreshExpiresAt, device: result.device, since: readSession()?.since || new Date().toISOString() });
    access = result.accessToken;
    accessExpiresAt = Date.parse(result.accessExpiresAt) || Date.now() + 10 * 60_000;
  }
  function forget() {
    access = null; accessExpiresAt = 0;
    try { localStorage.removeItem(SESSION_KEY); } catch { /* egal */ }
    render();
  }
  function handleRevoked() {
    if (!readSession()) return;
    forget();
    toast('Dieses Gerät wurde abgemeldet. Unter Einstellungen → Geräte kannst du es neu anmelden.');
    window.JarvisCore?.flash('warning');
  }

  async function refreshOnce() {
    const session = readSession();
    if (!session?.refreshToken) return null;
    // Ein anderer Tab hat eventuell schon erneuert.
    if (access && accessExpiresAt - Date.now() > REFRESH_MARGIN_MS) return access;
    const res = await post('/api/auth/refresh', { refreshToken: session.refreshToken });
    if (res.ok && res.body?.accessToken) { adopt(res.body); return access; }
    if (res.error === 'refresh_superseded') {
      // Paralleler Tab ohne Web-Locks: kurz warten und den inzwischen gespeicherten Schlüssel nutzen.
      await sleep(700);
      const latest = readSession();
      if (latest && latest.refreshToken !== session.refreshToken) {
        const retry = await post('/api/auth/refresh', { refreshToken: latest.refreshToken });
        if (retry.ok && retry.body?.accessToken) { adopt(retry.body); return access; }
      }
      return null;
    }
    if (['device_revoked', 'device_expired', 'unauthorized'].includes(res.error)) handleRevoked();
    return null;
  }
  async function token() {
    if (!readSession()) return localStorageAdmin();
    if (access && accessExpiresAt - Date.now() > REFRESH_MARGIN_MS) return access;
    if (!inflight) {
      inflight = (navigator.locks?.request ? navigator.locks.request('jarvis-auth-refresh', refreshOnce) : refreshOnce())
        .finally(() => { inflight = null; });
    }
    return (await inflight) || '';
  }
  function localStorageAdmin() { try { return localStorage.getItem(ADMIN_KEY) || ''; } catch { return ''; } }
  function removeAdminToken() {
    try { localStorage.removeItem(ADMIN_KEY); } catch { /* egal */ }
    ['aiAccessToken', 'aiAccessTokenSettings'].forEach(id => { const f = el(id); if (f) { f.value = ''; f.placeholder = 'Nicht nötig – dieses Gerät ist sicher angemeldet'; } });
  }

  // Tauscht das gemeinsame Admin-Token gegen eine eigene Gerätesitzung (nur wenn D1 eingerichtet ist).
  async function upgrade({ silent = true, name } = {}) {
    const admin = localStorageAdmin();
    if (!admin || readSession()) return { ok: false, error: readSession() ? 'already_signed_in' : 'no_token' };
    const res = await post('/api/auth/login', { deviceName: name || guessDeviceName() }, admin);
    if (res.ok && res.body?.refreshToken) {
      adopt(res.body);
      removeAdminToken();
      toast('Gerät „' + res.body.device.name + '“ sicher angemeldet. Das gemeinsame Token wurde von diesem Gerät entfernt.');
      window.JarvisCore?.flash('success');
      render();
      window.JarvisCore?.checkSystem();
      window.JarvisMemory?.sync();
      return { ok: true };
    }
    if (!silent) toast('Anmeldung nicht möglich: ' + window.JarvisCore.errorText(res.error));
    render();
    return { ok: false, error: res.error };
  }

  async function pair(endpoint, code, name) {
    let url;
    try { url = new URL(endpoint.trim()); } catch { return { ok: false, error: 'invalid_url' }; }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return { ok: false, error: 'invalid_url' };
    const previous = getAIEndpoint();
    localStorage.setItem('jarvis_ai_endpoint_v1', url.href);
    const res = await post('/api/auth/pair/complete', { code, deviceName: name || guessDeviceName() });
    if (res.ok && res.body?.refreshToken) {
      adopt(res.body);
      removeAdminToken();
      syncAIEndpointFields();
      return { ok: true, device: res.body.device };
    }
    if (previous) localStorage.setItem('jarvis_ai_endpoint_v1', previous); else localStorage.removeItem('jarvis_ai_endpoint_v1');
    return { ok: false, error: res.error };
  }

  // --- Bereich „Geräte“ -------------------------------------------------------------------------
  const section = document.createElement('section');
  section.id = 'view-devices';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = '<div class="grid" style="margin-top:0">'
    + '<div class="panel"><h2>⌁ DIESES GERÄT</h2><div id="devState" class="item"><small>Wird geprüft …</small></div>'
    + '<label class="hint">Gerätename<input id="devName" maxlength="60" placeholder="z. B. iPad"></label>'
    + '<div class="quick"><button id="devLogin" class="primary">Dieses Gerät sicher anmelden</button><button id="devLogout">Dieses Gerät abmelden</button></div>'
    + '<p class="hint">Sichere Anmeldung: Statt des gemeinsamen Tokens erhält jedes Gerät einen eigenen Schlüssel. Er erneuert sich automatisch, läuft nach 30 Tagen ohne Nutzung ab und lässt sich einzeln widerrufen. Benötigt die D1-Datenbank.</p></div>'
    + '<div class="panel"><h2>⊕ NEUES GERÄT KOPPELN</h2><p class="hint">Erzeuge hier einen Einmal-Code und gib ihn auf dem neuen Gerät (z. B. iPhone) unter Einstellungen → Geräte ein. Der Code gilt 10 Minuten.</p>'
    + '<button id="devPairStart" class="primary full">Kopplungscode erzeugen</button><div id="devPairCode" class="item pair-code" hidden></div></div>'
    + '<div class="panel"><h2>⇢ MIT CODE ANMELDEN</h2><p class="hint">Auf dem neuen Gerät: Backend-Adresse und Code eintragen. Das gemeinsame Token wird dafür nicht gebraucht.</p>'
    + '<label class="hint">Chat-Backend<input id="pairEndpoint" type="url" placeholder="https://dein-worker.workers.dev/api/chat"></label>'
    + '<label class="hint">Kopplungscode<input id="pairCode" maxlength="9" autocapitalize="characters" autocomplete="one-time-code" placeholder="ABCD-EFGH"></label>'
    + '<label class="hint">Gerätename<input id="pairName" maxlength="60" placeholder="z. B. iPhone"></label>'
    + '<button id="pairSubmit" class="primary full">Gerät koppeln</button></div>'
    + '<div class="panel"><h2>☰ ALLE GERÄTE</h2><div class="quick"><button id="devReload">Neu laden</button></div><div id="devList" class="list" style="margin-top:10px"></div></div>'
    + '<div class="panel"><h2>⎙ AKTIVITÄTSPROTOKOLL</h2><p class="hint">Wichtige Aktionen der letzten Zeit – ohne Inhalte, nur Art, Zeitpunkt und Gerät.</p><div id="devAudit" class="list"></div></div>'
    + '</div>';
  document.querySelector('main')?.append(section);

  const ACTION_TEXT = {
    device_login: 'Gerät angemeldet', device_paired: 'Gerät gekoppelt', pairing_started: 'Kopplungscode erzeugt', pairing_failed: 'Falscher Kopplungscode',
    device_revoked: 'Gerät widerrufen', device_logout: 'Gerät abgemeldet', device_revoked_reuse: 'Gerät gesperrt (alter Schlüssel wiederverwendet)',
    task_created: 'Aufgabe angelegt', task_updated: 'Aufgabe geändert', memory_created: 'Erinnerung gespeichert', memory_updated: 'Erinnerung geändert',
    memory_deleted: 'Erinnerung gelöscht', memories_cleared: 'Gedächtnis geleert'
  };
  let pairTimer = 0, devices = [];

  function render() {
    const box = el('devState');
    if (!box) return;
    const session = readSession();
    const admin = localStorageAdmin();
    let text, tone;
    if (session) { text = 'Sicher angemeldet als „' + (session.device?.name || 'Gerät') + '“ seit ' + fmt(session.since) + '. Schlüssel gültig bis ' + fmt(session.refreshExpiresAt) + ' (verlängert sich bei Nutzung).'; tone = 'ok'; }
    else if (admin) { text = 'Angemeldet mit dem gemeinsamen Token. Das funktioniert, ist aber weniger sicher: Wer das Token kennt, hat dauerhaft Zugriff.'; tone = 'warn'; }
    else { text = 'Nicht angemeldet. Trage unter „Stimme & KI“ Backend und Token ein oder koppele dieses Gerät mit einem Code.'; tone = 'muted'; }
    box.dataset.tone = tone;
    box.replaceChildren(Object.assign(document.createElement('small'), { textContent: text }));
    el('devLogin').hidden = Boolean(session) || !admin;
    el('devLogout').hidden = !session;
    el('devPairStart').disabled = !hasCredentials();
    if (!el('devName').value) el('devName').value = session?.device?.name || guessDeviceName();
    if (!el('pairName').value) el('pairName').value = guessDeviceName();
    if (!el('pairEndpoint').value) el('pairEndpoint').value = getAIEndpoint();
  }

  async function loadDevices() {
    render();
    const list = el('devList'), auditBox = el('devAudit');
    if (!hasCredentials()) { list.replaceChildren(info('Nicht angemeldet.')); auditBox.replaceChildren(); return; }
    const res = await window.JarvisCore.api('/api/auth/devices');
    if (!res.ok) {
      list.replaceChildren(info(res.error === 'storage_not_configured' ? 'Gerätesitzungen benötigen die D1-Datenbank (Anleitung: docs/BESTANDSAUFNAHME.md, Abschnitt 4.2).' : window.JarvisCore.errorText(res.error)));
      auditBox.replaceChildren();
      return;
    }
    devices = res.body.devices || [];
    list.replaceChildren(...(devices.length ? devices.map(deviceRow) : [info('Noch keine Gerätesitzungen. Melde dieses Gerät oben sicher an.')]));
    const log = await window.JarvisCore.api('/api/auth/audit');
    auditBox.replaceChildren(...(log.ok && log.body.entries?.length ? log.body.entries.slice(0, 20).map(auditRow) : [info('Noch keine Einträge.')]));
  }
  function info(text) { const d = document.createElement('div'); d.className = 'item'; d.append(Object.assign(document.createElement('small'), { textContent: text })); return d; }
  function deviceName(id) { if (!id) return ''; const d = devices.find(x => x.id === id); return d ? d.name : 'Gerät ' + id.slice(0, 6); }
  function auditRow(entry) {
    const actor = entry.actor === 'admin' ? 'Admin-Schlüssel' : entry.actor.startsWith('device:') ? deviceName(entry.actor.slice(7)) : entry.actor === 'anonymous' ? 'Unbekannt' : 'System';
    return info(fmt(entry.at) + ' · ' + (ACTION_TEXT[entry.action] || entry.action) + ' · ' + actor);
  }
  function deviceRow(device) {
    const row = document.createElement('div');
    row.className = 'item task-row';
    const details = document.createElement('div');
    details.className = 'details';
    details.append(Object.assign(document.createElement('strong'), { textContent: device.name + (device.current ? ' (dieses Gerät)' : '') }));
    const meta = device.revokedAt
      ? (device.revokedReason === 'refresh_reuse' ? 'Gesperrt (Sicherheitsverdacht) ' : 'Abgemeldet ') + fmt(device.revokedAt)
      : 'Zuletzt aktiv ' + fmt(device.lastSeenAt) + ' · angemeldet ' + fmt(device.createdAt);
    details.append(Object.assign(document.createElement('small'), { textContent: meta }));
    row.append(details);
    if (!device.revokedAt) {
      const actions = document.createElement('div');
      actions.className = 'task-actions';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = device.current ? 'Abmelden' : 'Widerrufen';
      btn.onclick = () => device.current ? logout() : confirmAction('Gerät widerrufen', '„' + device.name + '“ verliert sofort den Zugriff auf JARVIS. Es kann später neu gekoppelt werden.', async () => {
        const res = await window.JarvisCore.api('/api/auth/devices/' + encodeURIComponent(device.id) + '/revoke', { method: 'POST', body: {} });
        if (res.ok && res.body?.revoked) { toast('„' + device.name + '“ wurde widerrufen.'); window.JarvisCore.flash('success'); }
        else toast('Nicht widerrufen: ' + window.JarvisCore.errorText(res.error));
        loadDevices();
      });
      actions.append(btn);
      row.append(actions);
    }
    return row;
  }
  function logout() {
    confirmAction('Dieses Gerät abmelden', 'Die Gerätesitzung wird beendet. Für einen neuen Zugang brauchst du einen Kopplungscode von einem anderen Gerät oder das gemeinsame Token.', async () => {
      const res = await window.JarvisCore.api('/api/auth/logout', { method: 'POST', body: {} });
      forget();
      toast(res.ok ? 'Gerät abgemeldet.' : 'Lokal abgemeldet. Der Server konnte nicht bestätigt werden – widerrufe das Gerät notfalls von einem anderen Gerät aus.');
      window.JarvisCore.checkSystem();
      loadDevices();
    });
  }

  el('devLogin').addEventListener('click', async () => { await upgrade({ silent: false, name: el('devName').value.trim() }); loadDevices(); });
  el('devLogout').addEventListener('click', logout);
  el('devReload').addEventListener('click', loadDevices);
  el('devPairStart').addEventListener('click', async () => {
    const res = await window.JarvisCore.api('/api/auth/pair/start', { method: 'POST', body: {} });
    const box = el('devPairCode');
    if (!res.ok) { toast('Kein Code: ' + window.JarvisCore.errorText(res.error)); return; }
    clearInterval(pairTimer);
    box.hidden = false;
    const until = Date.parse(res.body.expiresAt);
    const tick = () => {
      const left = Math.max(0, Math.round((until - Date.now()) / 1000));
      box.replaceChildren(
        Object.assign(document.createElement('strong'), { textContent: left ? res.body.code : 'Abgelaufen' }),
        Object.assign(document.createElement('small'), { textContent: left ? 'Noch ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + ' Min. gültig · nur einmal verwendbar' : 'Erzeuge bei Bedarf einen neuen Code.' })
      );
      if (!left) clearInterval(pairTimer);
    };
    tick();
    pairTimer = setInterval(tick, 1000);
    loadDevices();
  });
  el('pairSubmit').addEventListener('click', async () => {
    const res = await pair(el('pairEndpoint').value, el('pairCode').value, el('pairName').value.trim());
    if (res.ok) {
      el('pairCode').value = '';
      toast('Gekoppelt als „' + res.device.name + '“.');
      window.JarvisCore.flash('success');
      window.JarvisCore.checkSystem();
      loadNews();
      window.JarvisMemory?.sync();
      loadDevices();
    } else {
      toast(res.error === 'invalid_url' ? 'Bitte eine gültige HTTPS-Backend-Adresse eintragen.' : 'Kopplung fehlgeschlagen: ' + window.JarvisCore.errorText(res.error));
      window.JarvisCore.flash('error');
    }
  });

  window.JarvisAuth = {
    token, upgrade, forget, handleRevoked, loadDevices, render,
    hasSession: () => Boolean(readSession()?.refreshToken),
    invalidate: () => { access = null; accessExpiresAt = 0; },
    session: readSession
  };
  if (readSession()) removeAdminToken();
  render();
})();
