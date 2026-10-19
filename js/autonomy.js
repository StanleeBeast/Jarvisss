// JARVIS Autonomie: was JARVIS von selbst getan hat, offene Vorschläge und die Schalter dafür.
// Vorschläge aus der Tagesvorbereitung werden erst nach deiner Bestätigung gespeichert (auch per Stimme: „Ja“).
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  const api = (path, options) => window.JarvisCore.api(path, options);
  const KIND = { day_prep: ['☀', 'Tagesvorbereitung'], event_soon: ['⏱', 'Termin gleich'], overdue: ['!', 'Überfällig'], mail_watch: ['✉', 'Mail wartet'], evening_preview: ['☾', 'Morgen'] };
  const JOBS = [
    ['dayPrep', 'Tag vorbereiten (KI)', 'Morgens fasst JARVIS deinen Tag zusammen und schlägt bei Bedarf Aufgaben oder Planänderungen vor. Kostet ca. 1–2 Cent pro Tag, entfällt im Sparmodus.', 'time'],
    ['eventSoon', 'Termin beginnt bald', 'Push kurz vor einem Kalendertermin (Kalender muss verbunden sein).', 'minutes'],
    ['mailWatch', 'Wichtige Mail wartet', 'Push, wenn eine sofort wichtige Mail seit einigen Stunden unbeantwortet ist.', 'hours'],
    ['overdue', 'Überfällige Aufgaben', 'Einmal am Tag eine Erinnerung an Überfälliges.', 'time'],
    ['eveningPreview', 'Vorschau auf morgen', 'Abends: Termine und Fälliges von morgen.', 'time']
  ];
  const section = document.createElement('section');
  section.id = 'view-autonomy';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = '<div class="auto-head"><div><h3 class="auto-title">Was JARVIS selbst tut</h3><p class="hint" id="autoIntro">JARVIS behält deinen Tag im Blick und meldet sich, wenn etwas wichtig wird. Er ändert nichts selbst – Vorschläge warten hier auf dein OK.</p></div><button type="button" id="autoReload" aria-label="Neu laden">↻</button></div>'
    + '<div id="autoFeed" class="auto-feed"></div>'
    + '<details class="panel auto-settings" id="autoSettings"><summary>Einstellungen</summary><div id="autoJobs"></div>'
    + '<div class="auto-quiet"><label class="hint">Ruhezeit von<input type="time" id="autoQuietFrom"></label><label class="hint">bis<input type="time" id="autoQuietTo"></label></div>'
    + '<p class="hint">In der Ruhezeit kommen keine Hinweise (außer der vorbereitete Tag am Morgen). Push-Nachrichten müssen unter JARVIS → Automatisierungen auf diesem Gerät eingeschaltet sein.</p>'
    + '<button type="button" class="primary full" id="autoSave">Speichern</button><p class="hint" id="autoState"></p></details>';
  document.querySelector('main')?.append(section);

  let settings = null;
  const fmt = (iso) => new Date(iso).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  function entryCard(e) {
    const c = document.createElement('article');
    c.className = 'auto-entry';
    c.dataset.kind = e.kind;
    c.id = 'auto-' + e.id;
    if (!e.seen) c.dataset.new = '1';
    const [icon, label] = KIND[e.kind] || ['•', e.kind];
    const top = document.createElement('div');
    top.className = 'auto-top';
    top.append(Object.assign(document.createElement('span'), { className: 'auto-icon', textContent: icon }), Object.assign(document.createElement('span'), { className: 'auto-label', textContent: label }), Object.assign(document.createElement('span'), { className: 'auto-time', textContent: fmt(e.at) }));
    c.append(top, Object.assign(document.createElement('h4'), { textContent: e.title }));
    if (e.detail) c.append(Object.assign(document.createElement('p'), { textContent: e.detail }));
    const actions = document.createElement('div');
    actions.className = 'auto-actions';
    if (e.detail) {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: '▶ Vorlesen' });
      b.onclick = () => { speak(e.detail); markSeen(e); };
      actions.append(b);
    }
    c.append(actions);
    if (e.proposals?.length && window.JarvisAgent?.renderProposals) {
      const box = document.createElement('div');
      box.className = 'auto-proposals n1-proposals';
      window.JarvisAgent.renderProposals(box, e.proposals);
      c.append(box);
    }
    return c;
  }
  async function markSeen(e) { if (!e.seen) { e.seen = true; await api('/api/autonomy/' + encodeURIComponent(e.id) + '/seen', { method: 'POST', body: {} }); } }
  function renderJobs() {
    const box = el('autoJobs');
    box.replaceChildren(...JOBS.map(([key, title, hint, field]) => {
      const job = settings[key];
      const row = document.createElement('div');
      row.className = 'auto-job';
      row.innerHTML = '<label class="auto-switch"><input type="checkbox" data-k="enabled"><span></span></label><div class="auto-job-text"><b></b><small></small></div><div class="auto-job-field"></div>';
      row.querySelector('b').textContent = title;
      row.querySelector('small').textContent = hint;
      const cb = row.querySelector('input'); cb.checked = job.enabled; cb.dataset.job = key;
      const f = row.querySelector('.auto-job-field');
      if (field === 'time') f.innerHTML = '<input type="time" data-k="time">';
      if (field === 'minutes') f.innerHTML = '<select data-k="minutes"><option value="15">15 min vorher</option><option value="30">30 min vorher</option><option value="60">60 min vorher</option></select>';
      if (field === 'hours') f.innerHTML = '<select data-k="hours"><option value="1">nach 1 Std.</option><option value="3">nach 3 Std.</option><option value="6">nach 6 Std.</option></select>';
      const input = f.querySelector('[data-k]'); input.dataset.job = key; input.value = String(job[field]);
      return row;
    }));
    el('autoQuietFrom').value = settings.quiet.from; el('autoQuietTo').value = settings.quiet.to;
  }
  async function load() {
    const feed = el('autoFeed');
    if (typeof apiBase !== 'function' || !apiBase() || !hasCredentials()) { feed.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Zuerst das Backend unter „Stimme & KI“ verbinden.' })); return; }
    const res = await api('/api/autonomy');
    if (!res.ok) { feed.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: res.error === 'not_found' ? 'Der deployte Worker ist älter als diese Seite. Deploy-Workflow erneut ausführen.' : window.JarvisCore.errorText(res.error || res.body?.error) })); return; }
    settings = res.body.settings;
    const entries = res.body.entries || [];
    feed.replaceChildren(...(entries.length ? entries.map(entryCard) : [Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Noch nichts passiert. Sobald JARVIS etwas Wichtiges bemerkt oder deinen Tag vorbereitet hat, steht es hier – und kommt als Push-Nachricht.' })]));
    if (res.body.budget?.level && res.body.budget.level !== 'ok') el('autoIntro').textContent = 'Sparmodus wegen der Monatsgrenze: Die KI-Tagesvorbereitung pausiert, die anderen Hinweise laufen kostenlos weiter.';
    renderJobs();
    return entries;
  }
  el('autoReload').onclick = load;
  el('autoSave').onclick = async () => {
    const body = { quiet: { from: el('autoQuietFrom').value, to: el('autoQuietTo').value } };
    section.querySelectorAll('#autoJobs [data-job]').forEach(i => {
      body[i.dataset.job] ||= {};
      body[i.dataset.job][i.dataset.k] = i.type === 'checkbox' ? i.checked : i.dataset.k === 'time' ? i.value : Number(i.value);
    });
    const res = await api('/api/autonomy/settings', { method: 'PUT', body });
    el('autoState').textContent = res.ok && res.body?.saved ? 'Gespeichert – vom Backend bestätigt.' : 'Nicht gespeichert: ' + window.JarvisCore.errorText(res.error || res.body?.error);
    if (res.ok) settings = res.body.settings;
  };
  window.JarvisAutonomy = { load, open: () => window.JarvisShell?.open('autonomy') };
  // Aus einer Push-Nachricht direkt zum Eintrag – die Tagesvorbereitung wird vorgelesen.
  const target = new URLSearchParams(location.search).get('autonomy');
  if (target) setTimeout(async () => {
    window.JarvisShell?.open('autonomy');
    const entries = await load();
    const e = (entries || []).find(x => x.id === target);
    el('auto-' + target)?.scrollIntoView({ block: 'start' });
    if (e?.kind === 'day_prep' && e.detail) { window.n1Show?.(e.detail, 'JARVIS · DEIN TAG'); speak(e.detail); markSeen(e); }
  }, 1600);
})();
