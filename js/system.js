// JARVIS Systemkern: API-Client, ORB-Zustände und überprüfter Systemstatus.
// Ein Status gilt nur dann als erfolgreich, wenn er in diesem Durchlauf tatsächlich geprüft wurde.
(function () {
  'use strict';
  const BUILD = '0.14.0';
  const LAST_STATUS_KEY = 'jarvis_last_status_v1';
  const LAST_AI_OK_KEY = 'jarvis_last_ai_ok_v1';
  const CORE_LABELS = { idle: 'BEREIT', listening: 'ZUHÖREN', processing: 'VERARBEITE', speaking: 'SPRICHT', success: 'BESTÄTIGT', warning: 'HINWEIS', offline: 'OFFLINE', error: 'FEHLER' };
  const STATE_TEXT = {
    available: 'Verfügbar', connected: 'Verbunden', configured: 'Eingerichtet', not_configured: 'Noch nicht eingerichtet',
    migration_missing: 'Migration fehlt', unreachable: 'Nicht erreichbar', error: 'Fehler', manual_only: 'Nur manuell', read_only: 'Nur lesen', warning: 'Mit Hinweis',
    in_development: 'In Entwicklung', not_available: 'Nicht verfügbar', permission_missing: 'Berechtigung fehlt', unknown: 'Unbekannt'
  };
  const STATE_TONE = {
    available: 'ok', connected: 'ok', configured: 'info', not_configured: 'warn', migration_missing: 'warn', unreachable: 'error',
    error: 'error', manual_only: 'warn', read_only: 'ok', warning: 'warn', in_development: 'warn', not_available: 'muted', permission_missing: 'warn', unknown: 'muted'
  };
  const COMPONENT_LABELS = {
    frontend: 'Frontend', network: 'Internetverbindung', serviceWorker: 'PWA · Offline-Cache', localStore: 'Lokaler Speicher',
    speechInput: 'Spracheingabe', microphone: 'Mikrofon-Berechtigung', systemVoice: 'Systemstimme', backend: 'Backend (Cloudflare Worker)',
    auth: 'Zugang', ai: 'KI-Modell', tts: 'KI-Stimme', news: 'Nachrichtenrecherche', storage: 'Datenbank (D1)', tasks: 'Aufgaben-API',
    devices: 'Gerätesitzungen', memory: 'Gedächtnis (D1)', tools: 'Agenten-Werkzeuge', costs: 'Kosten & Tageslimit', push: 'Benachrichtigungen', scheduler: 'Zeitplaner', study: 'Lernassistent', planner: 'Tagesplaner', calendar: 'Kalender', automations: 'Automatisierungen', sync: 'Geräte-Synchronisation', messaging: 'Nachrichten (WhatsApp)', mail: 'E-Mail & Home-Station'
  };
  const ERROR_TEXT = {
    no_endpoint: 'Kein Backend eingetragen (Einstellungen → Stimme & KI).',
    no_token: 'Zugangstoken fehlt.',
    session_refresh_failed: 'Die Gerätesitzung konnte nicht erneuert werden (offline oder Backend nicht erreichbar).',
    device_revoked: 'Dieses Gerät wurde abgemeldet. Unter „Geräte“ neu anmelden oder koppeln.',
    token_expired: 'Der Sitzungsschlüssel ist abgelaufen.',
    admin_token_required: 'Dafür wird der Admin-Schlüssel benötigt.',
    invalid_pairing_code: 'Der Kopplungscode ist falsch, abgelaufen oder schon benutzt.',
    memory_storage_unavailable: 'Der Gedächtnisspeicher antwortet gerade nicht.',
    daily_limit_reached: 'Das tägliche Limit ist erreicht (setzt sich um Mitternacht zurück).',
    model_timeout: 'Das KI-Modell hat zu lange gebraucht.',
    stream_interrupted: 'Die Verbindung ist während der Antwort abgebrochen.',
    website_brief_too_short: 'Bitte mindestens den Namen und eine kurze Beschreibung angeben.',
    website_limit_reached: 'Es gibt schon 30 Website-Entwürfe. Lösche zuerst alte.',
    website_generation_failed: 'Die KI hat keine gültige Website geliefert. Bitte nochmal versuchen.',
    website_not_found: 'Diesen Website-Entwurf gibt es nicht (mehr).',
    website_instructions_missing: 'Schreib kurz, was anders werden soll.',
    nothing_to_undo: 'Es gibt keine vorige Version.',
    legal_details_missing: 'Im Impressum fehlen noch Angaben.',
    publishing_not_configured: 'Veröffentlichen ist nicht eingerichtet (GitHub-Secret JARVIS_GITHUB_TOKEN fehlt).',
    publish_workflow_missing: 'Der Veröffentlichungs-Ablauf fehlt auf GitHub (publish-site.yml).',
    github_token_invalid: 'Der GitHub-Schlüssel (JARVIS_GITHUB_TOKEN) ist ungültig oder hat zu wenige Rechte.',
    github_unavailable: 'GitHub ist gerade nicht erreichbar.',
    websites_storage_unavailable: 'Website-Speicher fehlt – Deploy-Workflow erneut ausführen (Migration 0013).',
    model_unreachable: 'Der KI-Anbieter ist nicht erreichbar.',
    model_quota_exhausted: 'Das OpenAI-Guthaben ist aufgebraucht oder es ist keine Zahlungsmethode hinterlegt (platform.openai.com → Settings → Billing).',
    model_key_invalid: 'Der OpenAI-Schlüssel wird abgelehnt (GitHub-Secret OPENAI_API_KEY prüfen).',
    model_rate_limited: 'OpenAI meldet zu viele Anfragen. Gleich noch einmal versuchen.',
    empty_model_response: 'Das KI-Modell hat keine Antwort geliefert.',
    agent_step_limit: 'Die Aufgabe war zu umfangreich für einen Durchgang. Bitte in kleinere Schritte teilen.',
    task_not_found: 'Die Aufgabe existiert nicht mehr.',
    task_storage_unavailable: 'Der Aufgabenspeicher antwortet gerade nicht.',
    automation_storage_unavailable: 'Der Speicher für Automatisierungen antwortet nicht (Migration 0004 angewendet?).',
    push_storage_unavailable: 'Der Speicher für Benachrichtigungen antwortet nicht (Migration 0004 angewendet?).',
    briefing_not_found: 'Dieses Briefing gibt es nicht mehr.',
    invalid_time: 'Bitte eine gültige Uhrzeit wählen.',
    invalid_days: 'Bitte mindestens einen Wochentag wählen.',
    invalid_delay: 'Die Ankommensphase muss zwischen 0 und 240 Minuten liegen.',
    study_material_required: 'Bitte ein PDF wählen oder Text einfügen.',
    invalid_page_image: 'Eine Seite konnte nicht als Bild vorbereitet werden.',
    too_many_pages: 'Zu viele Seiten auf einmal (höchstens 8 als Bild).',
    model_refused: 'Das KI-Modell hat die Bearbeitung abgelehnt.',
    invalid_model_output: 'Das KI-Modell hat eine unbrauchbare Antwort geliefert. Bitte erneut versuchen.',
    empty_study_result: 'Aus den Unterlagen ließ sich kein Lernzettel erstellen. Ist das PDF lesbar?',
    study_storage_unavailable: 'Der Speicher des Lernassistenten antwortet nicht (Migration 0005 angewendet?).',
    study_set_not_found: 'Dieses Lernset gibt es nicht mehr.',
    request_too_large: 'Die Unterlagen sind zu groß. Bitte weniger Seiten wählen.',
    messages_required: 'Keine auswertbaren Nachrichten gefunden.',
    too_many_messages: 'Zu viele Nachrichten auf einmal (höchstens 400).',
    empty_message_result: 'Aus den Nachrichten ließ sich nichts auswerten.',
    planner_storage_unavailable: 'Der Tagesplaner-Speicher antwortet nicht (Migration 0007 angewendet?).',
    message_storage_unavailable: 'Der Speicher für Nachrichten-Auswertungen antwortet nicht (Migration 0006 angewendet?).',
    message_import_not_found: 'Diese Auswertung gibt es nicht mehr.',
    monthly_budget_reached: 'Die Monatsgrenze von 5 $ ist erreicht. Bis zum Monatsersten keine kostenpflichtigen KI-Anfragen – lokale Funktionen laufen weiter.',
    mail_storage_unavailable: 'Der Mail-Speicher antwortet nicht (Migration 0009 angewendet?).',
    mail_not_found: 'Diese Mail gibt es in JARVIS nicht mehr.',
    mail_already_sending: 'Diese Antwort wird bereits gesendet.',
    mail_suspicious: 'Diese Mail steht unter Betrugsverdacht – JARVIS antwortet darauf nicht.',
    reply_text_required: 'Bitte einen Antworttext eingeben.',
    confirmation_required: 'Der Versand muss ausdrücklich bestätigt werden.',
    nothing_to_cancel: 'Die Home-Station hat den Versand schon übernommen – Abbrechen ist nicht mehr möglich.',
    station_device_required: 'Dieser Zugang ist nur für die gekoppelte Home-Station.',
    unauthorized: 'Das Zugangstoken wird vom Backend abgelehnt.',
    backend_not_configured: 'Im Worker fehlen Secrets (JARVIS_ACCESS_TOKEN bzw. OPENAI_API_KEY).',
    storage_not_configured: 'Die D1-Datenbank ist noch nicht eingerichtet.',
    task_storage_unavailable: 'Die Datenbank antwortet gerade nicht.',
    status_endpoint_missing: 'Der deployte Worker ist älter als dieses Frontend. Deploy-Workflow erneut ausführen.',
    timeout: 'Zeitüberschreitung.',
    offline: 'Keine Internetverbindung.',
    unreachable: 'Backend nicht erreichbar (URL, Deployment oder CORS/ALLOWED_ORIGINS prüfen).',
    not_found: 'Endpunkt nicht gefunden – ist der Worker aktuell deployed?',
    model_request_failed: 'Der KI-Anbieter hat die Anfrage abgelehnt.'
  };
  const TOOL_LABELS = { get_news: 'Nachrichten', list_tasks: 'Aufgaben gelesen', get_current_time: 'Uhrzeit', draft_task: 'Entwurf erstellt' };

  let flashState = null, flashTimer = 0, backend = { state: 'unknown' }, lastStatus = null, checking = null;

  const readStore = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const writeStore = (key, value) => { try { localStorage.setItem(key, value); } catch { /* privater Modus */ } };
  const errorText = (code) => ERROR_TEXT[code] || ('Fehler: ' + code);
  const fmtTime = (iso) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.valueOf()) ? d.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '—'; };

  async function api(path, options = {}) {
    const res = await request(path, options);
    // Ein abgelaufener 15-Minuten-Schlüssel wird einmal erneuert, dann wird die Anfrage wiederholt.
    if (res.error === 'token_expired' && window.JarvisAuth?.hasSession()) {
      window.JarvisAuth.invalidate();
      return request(path, options);
    }
    if (res.error === 'device_revoked') window.JarvisAuth?.handleRevoked();
    return res;
  }
  async function request(path, { method = 'GET', body, timeout = 12000, auth = true } = {}) {
    const base = apiBase();
    if (!base) return { ok: false, status: 0, error: 'no_endpoint' };
    const token = auth ? await authToken() : '';
    if (auth && !token) return { ok: false, status: 0, error: hasCredentials() ? 'session_refresh_failed' : 'no_token' };
    const headers = { Accept: 'application/json' };
    if (auth) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: ctl.signal });
      let data = null;
      try { data = await res.json(); } catch { /* kein JSON */ }
      return { ok: res.ok, status: res.status, body: data, error: res.ok ? null : (data && data.error) || ('http_' + res.status) };
    } catch (e) {
      return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : (navigator.onLine === false ? 'offline' : 'unreachable') };
    } finally {
      clearTimeout(timer);
    }
  }

  // --- ORB-Zustand: wird ausschließlich aus echten App-Ereignissen abgeleitet ----------------
  function deriveCore() {
    if (navigator.onLine === false) return 'offline';
    const cls = document.body.classList;
    if (cls.contains('jarvis-listening')) return 'listening';
    if (cls.contains('jarvis-speaking')) return 'speaking';
    if (document.getElementById('n1Answer')?.classList.contains('is-thinking')) return 'processing';
    return flashState || 'idle';
  }
  function applyCore() {
    const state = deriveCore();
    const app = document.getElementById('nexusOne');
    if (app && app.dataset.core !== state) app.dataset.core = state;
    const label = document.getElementById('n1CoreState');
    if (label) label.textContent = CORE_LABELS[state];
    refreshLabel();
  }
  function flash(state, ms = 2600) {
    flashState = state;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashState = null; applyCore(); }, ms);
    applyCore();
  }
  function refreshLabel() {
    const el = document.getElementById('n1Status'), btn = document.getElementById('n1StateBtn');
    if (!el) return;
    let text, tone;
    if (navigator.onLine === false) { text = 'OFFLINE'; tone = 'error'; }
    else if (!apiBase()) { text = 'LOKALER MODUS'; tone = 'warn'; }
    else if (backend.state === 'checking') { text = 'PRÜFE SYSTEM …'; tone = 'warn'; }
    else if (backend.state === 'ok') { text = backend.degraded ? 'BACKEND VERBUNDEN · EINGESCHRÄNKT' : 'BACKEND VERBUNDEN'; tone = backend.degraded ? 'warn' : 'ok'; }
    else if (backend.state === 'error') { text = 'BACKEND NICHT BEREIT'; tone = 'error'; }
    else { text = 'STATUS UNGEPRÜFT'; tone = 'warn'; }
    if (deriveCore() === 'processing') text = 'DENKE NACH …';
    el.textContent = text;
    if (btn) btn.dataset.tone = tone;
  }
  function recordTools(log) {
    const answer = document.getElementById('n1Answer');
    if (!answer) return;
    let box = document.getElementById('n1Tools');
    if (!box) { box = document.createElement('div'); box.id = 'n1Tools'; answer.append(box); }
    box.textContent = log.length ? 'Werkzeuge: ' + log.map(t => (TOOL_LABELS[t.tool] || t.tool) + (t.ok ? ' ✓' : ' ✕')).join(' · ') : '';
    if (log.some(t => !t.ok)) setTimeout(() => flash('warning'), 50);
  }

  // --- Prüfungen auf dem Gerät --------------------------------------------------------------
  async function clientChecks() {
    const out = {};
    out.frontend = { state: 'available', detail: 'Build ' + BUILD + ' läuft.', verified: true };
    out.network = navigator.onLine === false
      ? { state: 'unreachable', detail: 'Das Gerät meldet keine Verbindung.', verified: true }
      : { state: 'available', detail: 'Das Gerät meldet eine Verbindung.', verified: true };
    if (!('serviceWorker' in navigator)) out.serviceWorker = { state: 'not_available', detail: 'Browser unterstützt keine Service Worker.' };
    else out.serviceWorker = navigator.serviceWorker.controller
      ? { state: 'available', detail: 'Offline-Cache aktiv. Neue Versionen werden beim Online-Start geladen.', verified: true }
      : { state: 'configured', detail: 'Wird beim nächsten Öffnen aktiv.' };
    try {
      localStorage.setItem('jarvis_probe', '1'); localStorage.removeItem('jarvis_probe');
      out.localStore = { state: 'available', detail: 'Profil, Gedächtnis, Verlauf und Design liegen nur in diesem Browser.', verified: true };
    } catch {
      out.localStore = { state: 'error', detail: 'Browser-Speicher gesperrt (privater Modus?). Einstellungen gehen beim Schließen verloren.', verified: true };
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    out.speechInput = SR
      ? { state: 'available', detail: 'Browser-Spracherkennung vorhanden. Kein dauerhaftes Mithören im Hintergrund.' }
      : { state: 'not_available', detail: 'Nutze das Diktat der Bildschirmtastatur.' };
    out.microphone = { state: 'unknown', detail: 'Wird beim ersten Tippen auf das Mikrofon abgefragt.' };
    try {
      const perm = await navigator.permissions?.query({ name: 'microphone' });
      if (perm?.state === 'granted') out.microphone = { state: 'available', detail: 'Zugriff erlaubt.', verified: true };
      else if (perm?.state === 'denied') out.microphone = { state: 'permission_missing', detail: 'Zugriff verweigert. In den Safari-/Systemeinstellungen freigeben.', verified: true };
    } catch { /* Safari unterstützt die Abfrage teilweise nicht */ }
    if ('speechSynthesis' in window) {
      const de = speechSynthesis.getVoices().filter(v => v.lang?.toLowerCase().startsWith('de')).length;
      out.systemVoice = { state: 'available', detail: de ? de + ' deutsche Stimme(n) gefunden.' : 'Keine deutsche Stimme gemeldet; das Gerät nutzt seine Standardstimme.', verified: true };
    } else out.systemVoice = { state: 'not_available', detail: 'Keine Sprachausgabe im Browser.' };
    return out;
  }

  function serverDegraded(components) {
    return ['ai', 'storage', 'tasks'].some(key => ['error', 'not_configured', 'migration_missing', 'unreachable'].includes(components[key]?.state));
  }

  async function checkSystem() {
    if (checking) return checking;
    checking = (async () => {
      backend = { state: 'checking' }; refreshLabel();
      const client = await clientChecks();
      let server = null, error = null;
      if (!apiBase()) { error = 'no_endpoint'; backend = { state: 'none' }; }
      else {
        const health = await api('/health', { auth: false, timeout: 8000 });
        if (!health.ok) { error = health.error; backend = { state: 'error' }; }
        else {
          const status = await api('/api/status', { timeout: 10000 });
          if (status.ok && status.body?.components) {
            server = status.body.components;
            backend = { state: 'ok', degraded: serverDegraded(server) };
          } else {
            error = status.error === 'not_found' ? 'status_endpoint_missing' : status.error;
            backend = status.error === 'not_found' ? { state: 'ok', degraded: true } : { state: 'error' };
          }
        }
      }
      lastStatus = { checkedAt: new Date().toISOString(), client, server, error };
      const previous = JSON.parse(readStore(LAST_STATUS_KEY) || '{}');
      writeStore(LAST_STATUS_KEY, JSON.stringify({
        lastCheck: lastStatus.checkedAt,
        lastSuccess: backend.state === 'ok' ? lastStatus.checkedAt : previous.lastSuccess || null,
        lastError: error && error !== 'no_endpoint' ? { code: error, at: lastStatus.checkedAt } : previous.lastError || null
      }));
      render();
      applyCore();
      if (server?.devices?.state === 'available' && !window.JarvisAuth?.hasSession() && getAIAccessToken()) window.JarvisAuth?.upgrade();
      return lastStatus;
    })();
    try { return await checking; } finally { checking = null; }
  }

  async function liveAiTest() {
    const btn = document.getElementById('sysAiTest');
    if (btn) btn.disabled = true;
    const res = await api('/api/chat', { method: 'POST', timeout: 45000, body: { messages: [{ role: 'user', content: 'Antworte nur mit: OK' }], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
    if (btn) btn.disabled = false;
    if (res.ok && typeof res.body?.reply === 'string') {
      writeStore(LAST_AI_OK_KEY, new Date().toISOString());
      toast('KI antwortet (' + (res.body.model || 'Modell unbekannt') + ').');
      flash('success');
    } else {
      toast('KI-Test fehlgeschlagen: ' + errorText(res.error));
      flash('error');
    }
    render();
  }

  // --- Darstellung --------------------------------------------------------------------------
  const section = document.createElement('section');
  section.id = 'view-system';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = '<div class="grid" style="margin-top:0">'
    + '<div class="panel"><h2>◎ SYSTEMSTATUS <span class="muted" id="sysCheckedAt">ungeprüft</span></h2>'
    + '<p class="hint" id="sysSummary">Jeder Eintrag zeigt, ob er gerade wirklich geprüft wurde.</p>'
    + '<div class="quick"><button id="sysRecheck" class="primary">Jetzt prüfen</button><button id="sysAiTest">KI live testen</button></div>'
    + '<p class="hint">„KI live testen“ sendet eine echte, sehr kurze Anfrage an das Modell und verursacht geringe API-Kosten.</p>'
    + '<div id="sysHistory" class="item"><small>Noch keine Prüfung gespeichert.</small></div></div>'
    + '<div class="panel"><h2>⌁ GERÄT</h2><div id="sysClient" class="list"></div></div>'
    + '<div class="panel"><h2>☁ BACKEND & INTEGRATIONEN</h2><div id="sysServer" class="list"></div></div>'
    + '</div>';
  document.querySelector('main')?.append(section);

  function row(key, comp) {
    const d = document.createElement('div');
    d.className = 'item sys-row';
    const title = document.createElement('strong');
    title.textContent = COMPONENT_LABELS[key] || key;
    const badge = document.createElement('span');
    badge.className = 'sys-badge';
    badge.dataset.tone = STATE_TONE[comp.state] || 'muted';
    badge.textContent = STATE_TEXT[comp.state] || comp.state;
    const detail = document.createElement('small');
    detail.textContent = (comp.detail || '') + (comp.model ? ' Modell: ' + comp.model + '.' : '') + (comp.verified ? ' · geprüft' : ' · nicht live geprüft');
    d.append(title, badge, detail);
    return d;
  }
  function render() {
    const clientBox = document.getElementById('sysClient'), serverBox = document.getElementById('sysServer');
    if (!clientBox || !serverBox) return;
    clientBox.replaceChildren();
    serverBox.replaceChildren();
    if (!lastStatus) return;
    for (const [key, comp] of Object.entries(lastStatus.client)) clientBox.append(row(key, comp));
    if (lastStatus.server) {
      for (const [key, comp] of Object.entries(lastStatus.server)) serverBox.append(row(key, comp));
    } else {
      const state = { no_endpoint: 'not_configured', no_token: 'not_configured', status_endpoint_missing: 'error', unauthorized: 'permission_missing', backend_not_configured: 'not_configured' }[lastStatus.error] || 'unreachable';
      serverBox.append(row('backend', { state, detail: errorText(lastStatus.error), verified: state !== 'not_configured' }));
      serverBox.append(row('calendar', { state: 'not_available', detail: 'Termine nur als .ics-Export. Echter Apple-Kalender-Zugriff braucht eine native App (EventKit).' }));
    }
    if (lastStatus.server && lastStatus.error) serverBox.prepend(row('backend', { state: 'error', detail: errorText(lastStatus.error), verified: true }));
    document.getElementById('sysCheckedAt').textContent = 'geprüft ' + fmtTime(lastStatus.checkedAt);
    const hist = JSON.parse(readStore(LAST_STATUS_KEY) || '{}');
    const aiOk = readStore(LAST_AI_OK_KEY);
    const lines = [
      'Letzte erfolgreiche Backend-Prüfung: ' + fmtTime(hist.lastSuccess),
      'Letzte echte KI-Antwort: ' + fmtTime(aiOk),
      'Letzter Fehler: ' + (hist.lastError ? errorText(hist.lastError.code) + ' (' + fmtTime(hist.lastError.at) + ')' : '—')
    ];
    const box = document.getElementById('sysHistory');
    box.replaceChildren(...lines.map(text => { const s = document.createElement('small'); s.textContent = text; return s; }));
    const summary = document.getElementById('sysSummary');
    summary.textContent = backend.state === 'ok'
      ? (backend.degraded ? 'Backend erreichbar, einzelne Bereiche sind noch nicht eingerichtet.' : 'Backend erreichbar und vollständig eingerichtet.')
      : backend.state === 'none' ? 'Kein Backend eingetragen – JARVIS arbeitet im lokalen Modus.' : 'Backend nicht bereit: ' + errorText(lastStatus.error);
  }

  document.getElementById('sysRecheck')?.addEventListener('click', () => checkSystem());
  document.getElementById('sysAiTest')?.addEventListener('click', liveAiTest);

  // --- Ereignisse ---------------------------------------------------------------------------
  new MutationObserver(applyCore).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  const answer = document.getElementById('n1Answer');
  if (answer) new MutationObserver(() => {
    if (answer.classList.contains('is-thinking')) { const tools = document.getElementById('n1Tools'); if (tools) tools.textContent = ''; }
    applyCore();
  }).observe(answer, { attributes: true, attributeFilter: ['class'] });
  addEventListener('online', () => { applyCore(); checkSystem(); loadNews(); });
  addEventListener('offline', () => { applyCore(); toast('Keine Internetverbindung. KI, Nachrichten und Aufgaben sind offline nicht verfügbar.'); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!lastStatus || Date.now() - new Date(lastStatus.checkedAt).getTime() > 5 * 60_000)) checkSystem();
  });
  ['saveAiEndpoint', 'saveAiEndpointSettings'].forEach(id => document.getElementById(id)?.addEventListener('click', () => setTimeout(() => { checkSystem(); loadNews(); }, 400)));

  window.JarvisCore = { api, errorText, flash, applyCore, refreshLabel, recordTools, checkSystem, get lastStatus() { return lastStatus; }, BUILD };
  applyCore();
  setTimeout(checkSystem, 500);
})();
