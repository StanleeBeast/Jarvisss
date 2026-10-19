// JARVIS Mails: Postfach-Übersicht nach Wichtigkeit, Vorlesen und Antworten.
// Die Mails holt die Home-Station auf deinem Laptop ab. Gesendet wird nur nach deiner ausdrücklichen Bestätigung,
// und „Gesendet“ steht erst da, wenn die Home-Station den Versand gemeldet hat.
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  const api = (path, options) => window.JarvisCore.api(path, options);
  const errorText = (e) => window.JarvisCore.errorText(e);
  const LEVEL = { 5: ['SOFORT', 'urgent'], 4: ['WICHTIG', 'high'], 3: ['NORMAL', 'normal'], 2: ['UNWICHTIG', 'low'], 1: ['WERBUNG', 'spam'] };
  const STATUS = { sending: 'wird gesendet …', send_failed: 'Senden fehlgeschlagen', replied: 'beantwortet', done: 'erledigt', read: 'gelesen' };
  const GUIDE = 'https://github.com/StanleeBeast/Jarvisss/blob/main/homestation/README-WINDOWS.md';
  const fmt = (iso) => {
    if (!iso) return '';
    const d = new Date(iso), today = new Date();
    return d.toDateString() === today.toDateString() ? 'heute ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
  const sender = (m) => m.fromName || m.fromAddr;
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  const section = document.createElement('section');
  section.id = 'view-mail';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = '<div class="mail-head">'
    + '<div class="mail-station" id="mailStation"><span class="mail-dot"></span><div><b id="mailStationTitle">Home-Station</b><small id="mailStationDetail">Wird geprüft …</small></div></div>'
    + '<div class="mail-tools"><button type="button" class="primary" id="mailReadTop">▶ Wichtigste vorlesen</button><button type="button" id="mailReload" aria-label="Neu laden">↻</button>'
    + '<label class="mail-toggle"><input type="checkbox" id="mailShowAll"> Erledigte zeigen</label></div></div>'
    + '<div id="mailSetup" class="panel mail-setup" hidden></div>'
    + '<div id="mailList" class="mail-list"></div>'
    + '<details class="panel mail-rules" id="mailRulesBox"><summary>Was ist mir wichtig?</summary>'
    + '<p class="hint">Danach sortiert JARVIS deine Mails (zusätzlich zu Fristen, persönlichen Nachrichten und Sicherheitswarnungen). Gilt ab der nächsten abgeholten Mail.</p>'
    + '<textarea id="mailRules" rows="4" maxlength="1500" placeholder="z. B. Mails von der Schule und vom Ausbildungsbetrieb sind immer wichtig. Newsletter und Shops sind unwichtig."></textarea>'
    + '<label class="hint"><input type="checkbox" id="mailPush" style="width:auto;margin-right:8px">Benachrichtigung bei sofort wichtigen Mails</label>'
    + '<button type="button" class="primary full" id="mailRulesSave">Speichern</button></details>'
    + '<p class="hint">JARVIS speichert pro Mail nur Absender, Betreff, Zeit, einen kurzen Auszug, die Einstufung und einen Antwortentwurf. Vorgelesen wird die Zusammenfassung. „Erledigt“ und „Entfernen“ betreffen nur JARVIS, nicht dein echtes Postfach.</p>';
  document.querySelector('main')?.append(section);

  let mails = [], station = null, loading = false;
  const watchers = new Map();

  function stationView(s) {
    station = s;
    const box = el('mailStation');
    const state = s?.state || 'unknown';
    box.dataset.state = state;
    el('mailStationTitle').textContent = state === 'connected' ? 'Home-Station online' : state === 'warning' ? 'Home-Station online – mit Hinweis' : state === 'unreachable' ? 'Home-Station offline' : state === 'not_configured' ? 'Keine Home-Station gekoppelt' : 'Home-Station';
    el('mailStationDetail').textContent = (s?.detail || '').replace(/JARVIS-Backend: ([a-z_]+)/g, (_, code) => errorText(code));
    const setup = el('mailSetup');
    setup.hidden = !['not_configured', 'migration_missing'].includes(state);
    if (setup.hidden) return;
    if (state === 'migration_missing') { setup.replaceChildren(node('p', 'hint', 'Die Datenbank-Tabellen für Mails fehlen noch. Deploy-Workflow erneut ausführen (Migration 0009).')); return; }
    const origin = (() => { try { return new URL(apiBase()).origin; } catch { return ''; } })();
    setup.innerHTML = '<h2>⌂ HOME-STATION EINRICHTEN</h2>'
      + '<p class="hint">Mails liest JARVIS über ein kleines Programm auf deinem Windows-Laptop. Es holt Gmail und iCloud Mail ab und sendet nur Antworten, die du hier bestätigst. Deine Mail-Passwörter bleiben auf dem Laptop.</p>'
      + '<ol class="mail-steps"><li>Auf dem Laptop die <a id="mailGuide" target="_blank" rel="noopener">Anleitung</a> öffnen und Node.js + Home-Station installieren (ca. 20 Minuten).</li>'
      + '<li>Auf der Einrichtungsseite der Station diese Backend-Adresse eintragen:<div class="mail-copy"><code id="mailOrigin"></code><button type="button" id="mailCopy">Kopieren</button></div></li>'
      + '<li>Kopplungscode erzeugen und dort eintragen:<div class="mail-copy"><code id="mailCode">—</code><button type="button" id="mailPair">Code erzeugen</button></div></li></ol>';
    el('mailGuide').href = GUIDE;
    el('mailOrigin').textContent = origin || 'Backend in „Stimme & KI“ eintragen';
    el('mailCopy').onclick = async () => { try { await navigator.clipboard.writeText(origin); toast('Adresse kopiert.'); } catch { toast('Kopieren nicht möglich – bitte abschreiben.'); } };
    el('mailPair').onclick = async () => {
      const res = await api('/api/auth/pair/start', { method: 'POST', body: {} });
      if (!res.ok) { toast('Kein Code: ' + errorText(res.error)); return; }
      el('mailCode').textContent = res.body.code;
      toast('Code 10 Minuten gültig.');
    };
  }

  function badge(m) {
    const [text, cls] = LEVEL[m.importance] || LEVEL[3];
    return node('span', 'mail-badge is-' + cls, m.suspicious ? 'VERDACHT' : text);
  }

  function card(m) {
    const c = node('article', 'mail-card');
    c.dataset.importance = m.importance;
    c.dataset.status = m.status;
    if (m.suspicious) c.dataset.suspicious = '1';
    const top = node('div', 'mail-top');
    top.append(badge(m), node('span', 'mail-from', sender(m)), node('span', 'mail-time', fmt(m.receivedAt)));
    c.append(top, node('h3', 'mail-subject', m.subject));
    if (m.summary) c.append(node('p', 'mail-summary', m.summary));
    const meta = [m.accountLabel, m.reason, m.needsReply && m.status !== 'replied' && !/antwort/i.test(m.reason || '') ? 'Antwort erwartet' : '', STATUS[m.status] || ''].filter(Boolean).join(' · ');
    c.append(node('small', 'mail-meta', meta));
    if (m.suspicious) c.append(node('p', 'mail-warn', '⚠ Möglicher Betrugsversuch. Keine Links öffnen, keine Daten eingeben. JARVIS antwortet darauf nicht.'));
    const actions = node('div', 'mail-actions');
    const listen = node('button', '', '▶ Vorlesen');
    listen.type = 'button';
    listen.onclick = () => { speak(readText([m], true)); if (m.status === 'new') setStatus(m, 'read', false); };
    actions.append(listen);
    if (!m.suspicious && !['sending', 'replied'].includes(m.status)) {
      const reply = node('button', m.needsReply ? 'primary' : '', '↩ Antworten');
      reply.type = 'button';
      reply.onclick = () => openEditor(c, m);
      actions.append(reply);
    }
    if (m.status === 'sending') {
      const stop = node('button', '', 'Senden abbrechen');
      stop.type = 'button';
      stop.onclick = async () => {
        const res = await api('/api/mail/' + encodeURIComponent(m.id) + '/reply/cancel', { method: 'POST', body: {} });
        toast(res.ok ? 'Versand abgebrochen – es wurde nichts gesendet.' : errorText(res.error || res.body?.error));
        load();
      };
      actions.append(stop);
    }
    if (m.status !== 'sending') {
      const done = node('button', '', m.status === 'done' ? 'Wieder offen' : '✓ Erledigt');
      done.type = 'button';
      done.onclick = () => setStatus(m, m.status === 'done' ? 'read' : 'done');
      const del = node('button', 'danger', 'Entfernen');
      del.type = 'button';
      del.onclick = () => confirmAction('Aus JARVIS entfernen', '„' + m.subject + '“ wird nur aus JARVIS entfernt. In deinem Postfach bleibt die Mail unverändert.', async () => {
        const res = await api('/api/mail/' + encodeURIComponent(m.id), { method: 'DELETE' });
        if (res.ok && res.body?.deleted) toast('Aus JARVIS entfernt.'); else toast('Nicht entfernt: ' + errorText(res.error || res.body?.error));
        load();
      });
      actions.append(done, del);
    }
    c.append(actions);
    if (m.status === 'sending') { const s = node('small', 'mail-send-state', 'Liegt bei der Home-Station – gesendet ist es erst, wenn sie den Versand meldet.'); c.append(s); watch(m.id, s); }
    if (m.status === 'send_failed') c.append(node('small', 'mail-send-state is-error', 'Die Home-Station konnte nicht senden. Du kannst es erneut versuchen.'));
    return c;
  }

  // Antwort-Editor: Entwurf prüfen, ändern, dann ausdrücklich bestätigen.
  function openEditor(c, m) {
    if (c.querySelector('.mail-editor')) return;
    const box = node('div', 'mail-editor');
    box.append(node('small', 'mail-meta', 'An: ' + (m.fromName ? m.fromName + ' <' + m.fromAddr + '>' : m.fromAddr) + ' · von deinem Postfach ' + (m.accountLabel || '')));
    const text = document.createElement('textarea');
    text.rows = 6; text.maxLength = 5000; text.value = m.draft || '';
    text.setAttribute('aria-label', 'Antworttext');
    const row = node('div', 'mail-actions');
    const send = node('button', 'primary', 'Senden …'); send.type = 'button';
    const close = node('button', '', 'Schließen'); close.type = 'button';
    const state = node('small', 'mail-send-state');
    row.append(send, close);
    box.append(text, row, state);
    c.append(box);
    text.focus();
    close.onclick = () => box.remove();
    send.onclick = () => sendReply(m, text.value, state, () => { send.disabled = true; text.disabled = true; });
  }

  // Gemeinsamer Versandweg für den Editor und für Vorschläge des Agenten.
  function sendReply(m, text, stateEl, onQueued) {
    const body = String(text || '').trim();
    if (!body) { toast('Bitte einen Antworttext eingeben.'); return; }
    const to = m.toName ? m.toName + ' <' + m.to + '>' : m.to || (m.fromName ? m.fromName + ' <' + m.fromAddr + '>' : m.fromAddr);
    confirmAction('Antwort wirklich senden?', 'An: ' + to + '\nBetreff: ' + (/^(re|aw):/i.test(m.subject) ? m.subject : 'Re: ' + m.subject) + '\n\n„' + body.slice(0, 240) + (body.length > 240 ? ' …' : '') + '“\n\nDie Home-Station sendet von deinem Postfach. Gesendet ist gesendet.', async () => {
      stateEl.textContent = 'Wird an die Home-Station übergeben …';
      const res = await api('/api/mail/' + encodeURIComponent(m.id) + '/reply', { method: 'POST', body: { text: body, confirm: true } });
      if (!res.ok || !res.body?.queued) { stateEl.textContent = 'Nicht gesendet: ' + errorText(res.error || res.body?.error); stateEl.classList.add('is-error'); return; }
      onQueued?.();
      stateEl.classList.remove('is-error');
      stateEl.textContent = res.body.stationOnline ? 'Liegt bei der Home-Station – gesendet ist es erst, wenn sie den Versand meldet.' : 'Die Home-Station ist gerade offline. Die Antwort wartet und wird gesendet, sobald der Laptop wieder läuft.';
      watch(m.id, stateEl);
    });
  }

  // Fragt den Versandstatus ab, bis die Station „gesendet“ oder „fehlgeschlagen“ gemeldet hat.
  function watch(id, stateEl) {
    if (watchers.has(id)) { watchers.get(id).els.add(stateEl); return; }
    const w = { els: new Set([stateEl]), tries: 0 };
    watchers.set(id, w);
    const tick = async () => {
      w.tries++;
      const res = await api('/api/mail/' + encodeURIComponent(id));
      const status = res.ok ? res.body?.mail?.status : null;
      const set = (t, err) => w.els.forEach(e => { e.textContent = t; e.classList.toggle('is-error', Boolean(err)); });
      if (status === 'replied') { set('✓ Gesendet – von der Home-Station bestätigt.'); window.JarvisCore.flash('success'); watchers.delete(id); setTimeout(load, 1500); return; }
      if (status === 'send_failed') { set('Senden fehlgeschlagen. Details im Protokoll der Home-Station.', true); window.JarvisCore.flash('error'); watchers.delete(id); setTimeout(load, 1500); return; }
      if (res.ok && status !== 'sending') { watchers.delete(id); return; }
      if (w.tries > 120) { watchers.delete(id); return; }
      setTimeout(tick, w.tries < 24 ? 5000 : 30000);
    };
    setTimeout(tick, 4000);
  }

  function readText(list, single) {
    if (!list.length) return 'Du hast keine offenen Mails.';
    const one = (m) => 'Von ' + sender(m) + (m.accountLabel ? ' an ' + m.accountLabel : '') + ', Betreff: ' + m.subject + '. ' + (m.summary || '') + (m.suspicious ? ' Achtung, das sieht nach einem Betrugsversuch aus.' : m.needsReply ? ' Eine Antwort wird erwartet' + (m.draft ? ', ein Entwurf liegt bereit.' : '.') : '');
    if (single) return one(list[0]);
    const ord = ['Erstens', 'Zweitens', 'Drittens', 'Viertens', 'Fünftens'];
    return (list.length === 1 ? 'Eine Mail ist wichtig. ' : list.length + ' Mails sind wichtig. ') + list.map((m, i) => ord[i] + ': ' + one(m)).join(' ');
  }

  async function setStatus(m, status, reload = true) {
    const res = await api('/api/mail/' + encodeURIComponent(m.id) + '/status', { method: 'POST', body: { status } });
    if (!res.ok) { toast('Nicht gespeichert: ' + errorText(res.error || res.body?.error)); return; }
    m.status = status;
    if (reload) load();
  }

  function render() {
    const list = el('mailList');
    if (!mails.length) {
      const empty = node('div', 'item');
      empty.append(node('small', '', station?.state === 'connected' || station?.state === 'warning' ? 'Keine offenen Mails. Neue Mails holt die Home-Station alle 5 Minuten ab.' : 'Noch keine Mails. Sobald die Home-Station läuft, erscheinen sie hier – die wichtigsten oben.'));
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...mails.map(card));
  }

  async function load() {
    if (loading) return;
    if (typeof apiBase !== 'function' || !apiBase() || !hasCredentials()) {
      stationView({ state: 'not_configured', detail: 'Zuerst das Backend unter „Stimme & KI“ verbinden.' });
      el('mailSetup').hidden = true;
      mails = []; render(); return;
    }
    loading = true;
    try {
      const res = await api('/api/mail/inbox' + (el('mailShowAll').checked ? '?status=all' : ''));
      if (!res.ok) {
        stationView({ state: res.error === 'not_found' ? 'error' : 'error', detail: res.error === 'not_found' ? 'Der deployte Worker ist älter als diese Seite. Deploy-Workflow erneut ausführen.' : errorText(res.error || res.body?.error) });
        return;
      }
      mails = res.body.mails || [];
      stationView(res.body.station);
      render();
      updateBadge();
    } finally { loading = false; }
  }
  async function loadSettings() {
    const res = await api('/api/mail/settings');
    if (!res.ok) return;
    el('mailRules').value = res.body.rules || '';
    el('mailPush').checked = res.body.push !== false;
  }
  function updateBadge() {
    const tab = document.querySelector('#tab-mail');
    if (!tab) return;
    const urgent = mails.filter(m => m.importance >= 4 && m.status === 'new' && !m.suspicious).length;
    tab.dataset.count = urgent ? String(urgent) : '';
  }

  el('mailReload').onclick = () => load();
  el('mailShowAll').onchange = () => load();
  el('mailReadTop').onclick = () => {
    const open = mails.filter(m => ['new', 'read', 'send_failed'].includes(m.status));
    const top = open.filter(m => m.importance >= 4 && !m.suspicious).slice(0, 5);
    speak(top.length ? readText(top) : open.length ? 'Gerade ist nichts besonders wichtig. ' + readText(open.slice(0, 3)) : 'Du hast keine offenen Mails.');
    top.filter(m => m.status === 'new').forEach(m => setStatus(m, 'read', false));
  };
  el('mailRulesSave').onclick = async () => {
    const res = await api('/api/mail/settings', { method: 'PUT', body: { rules: el('mailRules').value, push: el('mailPush').checked } });
    toast(res.ok && res.body?.saved ? 'Gespeichert.' : 'Nicht gespeichert: ' + errorText(res.error || res.body?.error));
  };
  el('mailRulesBox').addEventListener('toggle', () => { if (el('mailRulesBox').open) loadSettings(); });

  window.JarvisMail = {
    load,
    sendReply,
    open() { window.JarvisShell?.open('mail'); }
  };
  // Aus einer Benachrichtigung („Wichtige Mail“) direkt in den Bereich springen.
  if (new URLSearchParams(location.search).has('mail')) setTimeout(() => window.JarvisMail.open(), 1500);
})();
