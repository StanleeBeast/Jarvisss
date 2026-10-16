// JARVIS Automatisierungen: Benachrichtigungen, Morgenbriefing, Erinnerungen, Ankunft zu Hause, Wecker-Kurzbefehl.
// Ehrliche Grenzen: Eine Web-App kann sich nicht selbst im Hintergrund öffnen, nicht mithören und keinen Wecker stellen.
// Zeitgesteuerte Hinweise kommen als Push-Benachrichtigung vom Worker-Zeitplaner (alle 5 Minuten).
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  const api = (path, options) => window.JarvisCore.api(path, options);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';
  const appUrl = location.origin + location.pathname.replace(/index\.html$/, '');
  const DAYS = [[1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'], [5, 'Fr'], [6, 'Sa'], [7, 'So']];
  const SECTION = { local: 'Region', saxony: 'Sachsen', germany: 'Deutschland', world: 'Welt' };
  const fmt = (iso) => new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const standalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const section = document.createElement('section');
  section.id = 'view-automation';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = '<div class="grid" style="margin-top:0">'
    + '<div class="panel"><h2>🔔 BENACHRICHTIGUNGEN</h2><div id="autoPushState" class="item"><small>Wird geprüft …</small></div>'
    + '<div class="quick"><button id="autoPushEnable" class="primary">Auf diesem Gerät erlauben</button><button id="autoPushTest">Test senden</button><button id="autoPushDisable">Auf diesem Gerät abschalten</button></div>'
    + '<p class="hint">Auf iPad und iPhone funktionieren Benachrichtigungen nur, wenn JARVIS über Safari → Teilen → „Zum Home-Bildschirm“ installiert und von dort geöffnet wurde (ab iOS/iPadOS 16.4). Der Inhalt wird verschlüsselt über Apples Push-Dienst zugestellt.</p>'
    + '<div id="autoPushDevices" class="list"></div></div>'
    + '<div class="panel"><h2>☀ MORGENBRIEFING</h2>'
    + '<label class="hint"><input id="mbEnabled" type="checkbox" style="width:auto;margin-right:8px">Morgenbriefing per Benachrichtigung</label>'
    + '<label class="hint">Uhrzeit<input id="mbTime" type="time" value="06:20"></label>'
    + '<div class="day-picker" id="mbDays"></div>'
    + '<label class="hint"><input id="mbWeather" type="checkbox" checked style="width:auto;margin-right:8px">Wetter</label>'
    + '<label class="hint"><input id="mbTasks" type="checkbox" checked style="width:auto;margin-right:8px">Fällige und überfällige Aufgaben</label>'
    + '<label class="hint"><input id="mbNews" type="checkbox" checked style="width:auto;margin-right:8px">Nachrichten (Region → Sachsen → Deutschland → Welt)</label>'
    + '<div class="quick"><button id="mbSave" class="primary">Speichern</button><button id="mbNow">Briefing jetzt erstellen</button></div>'
    + '<p class="hint" id="mbInfo">Der Zeitplaner prüft alle 5 Minuten. Das Briefing kommt also bis zu 5 Minuten nach der eingestellten Zeit. Verpasste Briefings werden höchstens 3 Stunden nachgeholt.</p></div>'
    + '<div class="panel"><h2>⏰ ERINNERUNGEN & WECKER</h2>'
    + '<label class="hint"><input id="trEnabled" type="checkbox" style="width:auto;margin-right:8px">Bei fälligen Aufgaben benachrichtigen</label>'
    + '<label class="hint"><input id="trHide" type="checkbox" style="width:auto;margin-right:8px">Aufgabentitel auf dem Sperrbildschirm verbergen</label>'
    + '<button id="trSave" class="primary full">Speichern</button>'
    + '<div class="line"></div><p class="hint"><strong>Wecker:</strong> Eine Web-App kann keinen Wecker stellen. Lege einmalig in der Kurzbefehle-App einen Kurzbefehl namens <strong>„JARVIS Wecker“</strong> an: Aktion „Wecker erstellen“ (Uhr), als Zeit die „Kurzbefehl-Eingabe“ verwenden. Danach startet JARVIS ihn auf Wunsch mit der gewünschten Uhrzeit. Ob der Wecker gestellt wurde, prüfst du in der Uhr-App.</p>'
    + '<div class="inputrow"><input id="alarmTest" type="time" value="07:00" aria-label="Weckzeit"><button id="alarmRun">Kurzbefehl testen</button></div></div>'
    + '<div class="panel"><h2>⌂ ANKUNFT ZU HAUSE</h2>'
    + '<label class="hint"><input id="arEnabled" type="checkbox" style="width:auto;margin-right:8px">Nach der Ankunft erst Ruhe, dann Überblick</label>'
    + '<label class="hint">Ankommensphase in Minuten<input id="arDelay" type="number" min="0" max="240" value="20"></label>'
    + '<button id="arSave" class="primary full">Speichern</button>'
    + '<p class="hint">Einrichtung in der Kurzbefehle-App: Automation → Neue Automation → „Ankommen“ → dein Zuhause → „Sofort ausführen“ → Aktion „URL öffnen“ mit der Adresse unten. Beim Ankommen öffnet sich JARVIS, begrüßt dich und meldet sich nach der Ankommensphase mit dem Überblick. iPadOS fragt je nach Version nach einer Bestätigung. Ohne Kurzbefehl öffnest du die Adresse einfach selbst.</p>'
    + '<div class="inputrow"><input id="arUrl" readonly aria-label="Adresse für den Kurzbefehl"><button id="arCopy">Kopieren</button></div></div>'
    + '<div class="panel"><h2>◷ GEPLANT</h2><div id="autoPending" class="list"></div><button id="autoReload" class="full" style="margin-top:8px">Neu laden</button></div>'
    + '</div>';
  document.querySelector('main')?.append(section);
  el('mbDays').innerHTML = DAYS.map(([d, l]) => '<label class="day"><input type="checkbox" value="' + d + '"' + (d <= 5 ? ' checked' : '') + '><span>' + l + '</span></label>').join('');
  el('arUrl').value = appUrl + '?welcome=home';

  const info = (text) => { const d = document.createElement('div'); d.className = 'item'; d.append(Object.assign(document.createElement('small'), { textContent: text })); return d; };
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4)), c => c.charCodeAt(0));
  const ready = () => apiBase() && hasCredentials();

  async function currentSubscription() {
    if (!pushSupported()) return null;
    // serviceWorker.ready wird nie fertig, wenn kein Service Worker aktiv ist – deshalb mit Zeitlimit.
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(resolve => setTimeout(() => resolve(null), 3000))]);
    if (!reg) return null;
    try { return await reg.pushManager.getSubscription(); } catch { return null; }
  }
  async function renderPush() {
    const box = el('autoPushState');
    let text, tone = 'muted';
    const sub = await currentSubscription();
    if (!pushSupported()) text = standalone() ? 'Dieser Browser unterstützt keine Web-Push-Benachrichtigungen.' : 'Benachrichtigungen sind hier nicht verfügbar. Installiere JARVIS über Safari → Teilen → „Zum Home-Bildschirm“ und öffne es von dort.';
    else if (Notification.permission === 'denied') { text = 'Benachrichtigungen wurden abgelehnt. Erlaube sie unter Einstellungen → Mitteilungen → JARVIS.'; tone = 'warn'; }
    else if (sub) { text = 'Dieses Gerät empfängt Benachrichtigungen.'; tone = 'ok'; }
    else text = 'Auf diesem Gerät noch nicht eingeschaltet.';
    box.dataset.tone = tone;
    box.replaceChildren(Object.assign(document.createElement('small'), { textContent: text }));
    el('autoPushEnable').hidden = !pushSupported() || Boolean(sub) || Notification.permission === 'denied';
    el('autoPushDisable').hidden = !sub;
    const list = el('autoPushDevices');
    if (!ready()) { list.replaceChildren(); return; }
    const res = await api('/api/push/subscriptions');
    if (res.ok) list.replaceChildren(...(res.body.subscriptions.length ? res.body.subscriptions.map(s => info('🔔 ' + s.label + (s.current ? ' (dieses Gerät)' : '') + ' · ' + (s.lastSuccessAt ? 'zuletzt zugestellt ' + fmt(s.lastSuccessAt) : 'noch nichts zugestellt') + (s.failures ? ' · ' + s.failures + ' Fehlversuche' : ''))) : [info('Noch kein Gerät angemeldet.')]));
    else list.replaceChildren(info(window.JarvisCore.errorText(res.error)));
  }

  el('autoPushEnable').addEventListener('click', async () => {
    if (!ready()) { toast('Zuerst das Backend verbinden.'); return; }
    // iOS verlangt, dass die Berechtigung direkt nach einem Tipp angefragt wird.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { toast('Benachrichtigungen wurden nicht erlaubt.'); renderPush(); return; }
    const key = await api('/api/push/public-key');
    if (!key.ok) { toast('Kein Schlüssel vom Backend: ' + window.JarvisCore.errorText(key.error)); return; }
    try {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(resolve => setTimeout(() => resolve(null), 5000))]);
      if (!reg) { toast('Der Offline-Dienst (Service Worker) ist nicht aktiv. JARVIS einmal schließen und neu öffnen.'); return; }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key.body.publicKey) });
      const res = await api('/api/push/subscribe', { method: 'POST', body: { label: window.JarvisAuth?.session()?.device?.name || (/iPhone/.test(navigator.userAgent) ? 'iPhone' : 'iPad'), subscription: sub.toJSON() } });
      if (res.ok && res.body?.saved) { toast('Benachrichtigungen eingeschaltet. Tippe auf „Test senden“, um es zu prüfen.'); window.JarvisCore.flash('success'); }
      else { toast('Nicht gespeichert: ' + window.JarvisCore.errorText(res.error)); await sub.unsubscribe(); }
    } catch (e) {
      toast('Anmeldung beim Push-Dienst fehlgeschlagen: ' + (e.message || e.name));
    }
    renderPush();
  });
  el('autoPushTest').addEventListener('click', async () => {
    const res = await api('/api/push/test', { method: 'POST', body: {} });
    if (res.ok && res.body.sent) toast('Der Push-Dienst hat ' + res.body.sent + ' Nachricht(en) angenommen. Sie sollte in wenigen Sekunden erscheinen.');
    else if (res.status === 404) toast('Noch kein Gerät für Benachrichtigungen angemeldet.');
    else toast('Test fehlgeschlagen: ' + window.JarvisCore.errorText(res.error || 'push_failed'));
    renderPush();
  });
  el('autoPushDisable').addEventListener('click', async () => {
    const sub = await currentSubscription();
    if (!sub) return;
    await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
    await sub.unsubscribe();
    toast('Benachrichtigungen auf diesem Gerät abgeschaltet.');
    renderPush();
  });

  // --- Routinen ---------------------------------------------------------------------------------
  let routines = null;
  async function loadRoutines() {
    if (!ready()) { el('mbInfo').textContent = 'Zuerst das Backend verbinden.'; return; }
    const res = await api('/api/routines');
    if (!res.ok) { el('mbInfo').textContent = res.error === 'storage_not_configured' ? 'Automatisierungen benötigen die D1-Datenbank.' : window.JarvisCore.errorText(res.error); return; }
    routines = res.body.routines;
    const mb = routines.morning_briefing;
    el('mbEnabled').checked = mb.enabled; el('mbTime').value = mb.config.time;
    el('mbDays').querySelectorAll('input').forEach(i => { i.checked = mb.config.days.includes(Number(i.value)); });
    el('mbWeather').checked = mb.config.include.weather; el('mbTasks').checked = mb.config.include.tasks; el('mbNews').checked = mb.config.include.news;
    el('trEnabled').checked = routines.task_reminders.enabled; el('trHide').checked = routines.task_reminders.config.hideContent;
    el('arEnabled').checked = routines.arrival.enabled; el('arDelay').value = routines.arrival.config.delayMinutes;
    el('mbInfo').textContent = mb.enabled
      ? 'Aktiv: ' + mb.config.time + ' Uhr an ' + DAYS.filter(([d]) => mb.config.days.includes(d)).map(([, l]) => l).join(', ') + (mb.lastRunDay ? ' · zuletzt am ' + mb.lastRunDay : '') + '. Der Zeitplaner prüft alle 5 Minuten.'
      : 'Ausgeschaltet. Der Zeitplaner prüft alle 5 Minuten; verpasste Briefings werden höchstens 3 Stunden nachgeholt.';
  }
  async function saveRoutine(kind, body, message) {
    const res = await api('/api/routines/' + kind, { method: 'PUT', body: { ...body, timezone: tz } });
    if (res.ok && res.body?.saved) { toast(message); window.JarvisCore.flash('success'); }
    else toast('Nicht gespeichert: ' + window.JarvisCore.errorText(res.error));
    await loadRoutines();
    if (res.ok && body.enabled) { const sub = await currentSubscription(); if (!sub) toast(message + ' Hinweis: Auf diesem Gerät sind Benachrichtigungen noch nicht eingeschaltet.'); }
  }
  el('mbSave').addEventListener('click', () => saveRoutine('morning_briefing', {
    enabled: el('mbEnabled').checked,
    config: { time: el('mbTime').value, days: [...el('mbDays').querySelectorAll('input:checked')].map(i => Number(i.value)), include: { weather: el('mbWeather').checked, tasks: el('mbTasks').checked, news: el('mbNews').checked } }
  }, 'Morgenbriefing gespeichert.'));
  el('trSave').addEventListener('click', () => saveRoutine('task_reminders', { enabled: el('trEnabled').checked, config: { hideContent: el('trHide').checked } }, 'Erinnerungen gespeichert.'));
  el('arSave').addEventListener('click', () => saveRoutine('arrival', { enabled: el('arEnabled').checked, config: { delayMinutes: Number(el('arDelay').value) } }, 'Ankunfts-Routine gespeichert.'));
  el('arCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(el('arUrl').value); toast('Adresse kopiert.'); } catch { el('arUrl').select(); toast('Adresse markiert – jetzt kopieren.'); } });
  el('mbNow').addEventListener('click', async () => { closeOverlay(); await showBriefing('new'); });
  el('alarmRun').addEventListener('click', () => runAlarmShortcut(el('alarmTest').value));
  el('autoReload').addEventListener('click', () => load());

  async function loadPending() {
    const box = el('autoPending');
    if (!ready()) { box.replaceChildren(info('Zuerst das Backend verbinden.')); return; }
    const res = await api('/api/notifications');
    if (!res.ok) { box.replaceChildren(info(window.JarvisCore.errorText(res.error))); return; }
    box.replaceChildren(...(res.body.notifications.length ? res.body.notifications.map(n => {
      const row = info(fmt(n.sendAt) + ' · ' + n.body);
      const btn = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Absagen' });
      btn.onclick = async () => { await api('/api/notifications/' + n.id + '/cancel', { method: 'POST', body: {} }); loadPending(); };
      row.classList.add('task-row'); row.append(btn);
      return row;
    }) : [info('Nichts geplant.')]));
  }
  async function load() { await Promise.all([renderPush(), loadRoutines(), loadPending()]); }

  // --- Wecker über Kurzbefehl -------------------------------------------------------------------
  function runAlarmShortcut(time) {
    if (!/^\d{2}:\d{2}$/.test(time || '')) { toast('Bitte eine Uhrzeit wählen.'); return false; }
    location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent('JARVIS Wecker') + '&input=text&text=' + encodeURIComponent(time);
    return true;
  }

  // --- Briefing anzeigen ------------------------------------------------------------------------
  const num = (v) => Number.isFinite(v) ? Math.round(v) : '–';
  function briefingText(b) {
    const h = new Date(b.createdAt).getHours();
    const lines = [(h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend') + ', ' + (data.profile.name || 'Chef') + '. Hier ist dein Überblick vom ' + new Date(b.createdAt).toLocaleString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) + '.'];
    if (b.weather) lines.push(b.weather.error ? 'Wetter: gerade nicht abrufbar.' : 'Wetter in ' + b.weather.location + ': jetzt ' + num(b.weather.nowC) + ' Grad, ' + b.weather.condition + ', heute ' + num(b.weather.minC) + ' bis ' + num(b.weather.maxC) + ' Grad' + (b.weather.rainPercent != null ? ', Regenrisiko ' + b.weather.rainPercent + ' Prozent' : '') + ' (Quelle: Open-Meteo).');
    if (b.tasks) {
      if (b.tasks.error) lines.push('Aufgaben: gerade nicht abrufbar.');
      else {
        if (b.tasks.overdue.length) lines.push('Überfällig: ' + b.tasks.overdue.map(t => t.title).join('; ') + '.');
        lines.push(b.tasks.dueToday.length ? 'Heute fällig: ' + b.tasks.dueToday.map(t => fmtTime(t.dueAt) + ' ' + t.title).join('; ') + '.' : 'Heute ist keine Aufgabe mit Uhrzeit fällig.');
        if (b.tasks.highPriority.length) lines.push('Wichtig ohne Termin: ' + b.tasks.highPriority.map(t => t.title).join('; ') + '.');
        lines.push(b.tasks.open + ' offene Aufgabe(n) insgesamt.');
      }
    }
    if (b.news) {
      const ok = b.news.filter(n => !n.error);
      if (ok.length) lines.push('Nachrichten:\n' + ok.map(n => {
        const age = n.published ? (Date.parse(b.createdAt) - Date.parse(n.published)) / 3600000 : null;
        return '• ' + SECTION[n.section] + ': ' + n.title + ' (' + n.source + (n.published ? ', ' + new Date(n.published).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '') + (age > 24 ? ', älter als 24 Stunden' : '') + ')';
      }).join('\n'));
      else lines.push('Nachrichten: gerade nicht abrufbar.');
    }
    lines.push('Kalendertermine sind nicht verbunden.');
    return lines.join('\n\n');
  }
  async function showBriefing(id) {
    window.n1Show?.('Ich stelle deinen Überblick zusammen …', 'JARVIS BRIEFING');
    const res = id === 'new' ? await api('/api/briefings', { method: 'POST', body: { timezone: tz }, timeout: 30000 }) : await api('/api/briefings/' + encodeURIComponent(id));
    if (!res.ok) { window.n1Show?.('Das Briefing konnte nicht geladen werden: ' + window.JarvisCore.errorText(res.error), 'JARVIS BRIEFING'); return; }
    const text = briefingText(res.body.briefing);
    window.n1Show?.(text, 'JARVIS BRIEFING');
    addChat('jarvis', text);
    offerSpeech(text);
  }
  // Safari spielt Ton erst nach einem Tipp ab – deshalb ein ausdrücklicher „Vorlesen“-Knopf.
  function offerSpeech(text) {
    const answer = el('n1Answer');
    answer?.querySelector('.n1-speak')?.remove();
    const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'primary n1-speak', textContent: '▶ Vorlesen' });
    btn.onclick = () => { speak(text); btn.remove(); };
    answer?.append(btn);
  }
  function closeOverlay() { el('n1SettingsClose')?.click(); }

  // --- Aufruf per Benachrichtigung oder Kurzbefehl ---------------------------------------------
  async function handleLaunch() {
    const params = new URLSearchParams(location.search);
    const briefing = params.get('briefing'), welcome = params.get('welcome'), task = params.get('task');
    if (!briefing && !welcome && !task) return;
    history.replaceState(null, '', location.pathname);
    if (!ready()) return;
    document.getElementById('bootSkip')?.click();
    if (briefing) { await showBriefing(briefing); return; }
    if (task) { el('n1Tasks')?.click(); return; }
    if (welcome === 'home') {
      const res = await api('/api/arrival', { method: 'POST', body: {} });
      const name = data.profile.name || 'Chef';
      const text = res.ok && res.body.scheduled
        ? 'Willkommen zurück, ' + name + '. Komm erst einmal in Ruhe an. In ' + res.body.delayMinutes + ' Minuten melde ich mich mit deinem Überblick.'
        : res.ok && res.body.reason === 'already_scheduled'
          ? 'Willkommen zurück, ' + name + '. Dein Überblick kommt um ' + fmtTime(res.body.sendAt) + ' Uhr.'
          : 'Willkommen zurück, ' + name + '.' + (res.ok ? ' Möchtest du gleich einen Überblick? Tippe auf „Briefing“.' : '');
      window.n1Show?.(text, 'WILLKOMMEN ZURÜCK');
      offerSpeech(text);
    }
  }

  window.JarvisAutomation = { load, showBriefing, runAlarmShortcut };
  setTimeout(handleLaunch, 1200);
})();
