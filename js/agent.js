// JARVIS Agent-Oberfläche: Vorschläge bestätigen, Anfragen abbrechen, Kosten und Berechtigungen anzeigen.
// Ein Vorschlag der KI ist keine Berechtigung. Gespeichert wird erst nach deinem Tipp auf „Speichern“,
// und „gespeichert“ wird erst angezeigt, wenn die Datenbank den Eintrag zurückgeliefert hat.
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  const PRIORITY = { high: 'hoch', normal: 'normal', low: 'niedrig' };
  const STATUS = { open: 'wieder offen', done: 'erledigt', cancelled: 'verworfen' };
  const KIND = { preference: 'Vorliebe', fact: 'Fakt', style: 'Stilhinweis', routine: 'Routine', project: 'Projekt' };
  const answer = el('n1Answer');

  // Abbrechen-Knopf in der Antwortkarte (nur während einer laufenden Anfrage sichtbar).
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.id = 'n1Cancel';
  cancel.className = 'n1-cancel';
  cancel.textContent = 'Abbrechen';
  cancel.addEventListener('click', () => { if (window.jarvisAbortAI) window.jarvisAbortAI(); });
  answer?.querySelector('.n1-answer-top')?.append(cancel);

  const box = document.createElement('div');
  box.id = 'n1Proposals';
  box.className = 'n1-proposals';
  box.setAttribute('aria-live', 'polite');
  answer?.append(box);
  if (answer) new MutationObserver(() => { if (answer.classList.contains('is-thinking')) box.replaceChildren(); })
    .observe(answer, { attributes: true, attributeFilter: ['class'] });

  function describe(p) {
    const lines = [];
    if (p.type === 'create_task') {
      lines.push(['Neue Aufgabe', p.payload.title]);
      if (p.payload.details) lines.push(['Details', p.payload.details]);
      if (p.dueText) lines.push(['Fällig', p.dueText]);
      lines.push(['Priorität', PRIORITY[p.payload.priority] || 'normal']);
    } else if (p.type === 'update_task') {
      lines.push(['Aufgabe ändern', p.target?.title || 'Aufgabe']);
      if (p.payload.title) lines.push(['Neuer Titel', p.payload.title]);
      if (p.dueText) lines.push(['Neu fällig', p.dueText]);
      if (p.payload.priority) lines.push(['Priorität', PRIORITY[p.payload.priority]]);
      if (p.payload.status) lines.push(['Status', STATUS[p.payload.status]]);
      if (p.payload.details) lines.push(['Details', p.payload.details]);
    } else if (p.type === 'alarm') {
      lines.push(['Wecker', p.payload.time + ' Uhr (' + p.payload.label + ')']);
      lines.push(['Über', 'Kurzbefehl „JARVIS Wecker“ auf diesem Gerät']);
    } else if (p.type === 'plan_change') {
      const day = new Date(p.date + 'T12:00:00Z').toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
      lines.push(['Tagesplan', day]);
      for (const c of p.changes || []) {
        if (c.action === 'skip') lines.push(['Fällt aus', c.title + ' (' + c.time + ')']);
        if (c.action === 'restore') lines.push(['Wieder im Plan', c.title + ' (' + c.time + ')']);
        if (c.action === 'add') lines.push(['Neu', c.title + ' (' + c.time + ')']);
        if (c.action === 'free') lines.push(['Freizeit', (c.minutes > 0 ? '+' : '') + c.minutes + ' min']);
      }
    } else if (p.type === 'mail_reply') {
      lines.push(['Antwort an', p.target.toName ? p.target.toName + ' <' + p.target.to + '>' : p.target.to]);
      lines.push(['Betreff', /^(re|aw):/i.test(p.target.subject) ? p.target.subject : 'Re: ' + p.target.subject]);
    } else if (p.type === 'save_memory') {
      lines.push(['Merken als ' + (KIND[p.payload.kind] || 'Erinnerung'), p.payload.text]);
    }
    return lines;
  }

  async function apply(p) {
    if (p.type === 'create_task') return window.JarvisCore.api('/api/tasks', { method: 'POST', body: p.payload });
    if (p.type === 'update_task') return window.JarvisCore.api('/api/tasks/' + encodeURIComponent(p.target.id), { method: 'PATCH', body: p.payload });
    if (p.type === 'save_memory') return window.JarvisCore.api('/api/memories', { method: 'POST', body: p.payload });
    if (p.type === 'plan_change') return window.JarvisCore.api('/api/planner/day/' + encodeURIComponent(p.date) + '/overrides', { method: 'PUT', body: p.payload });
    return { ok: false, error: 'unknown_proposal' };
  }

  function card(p) {
    const c = document.createElement('div');
    c.className = 'n1-proposal';
    const head = document.createElement('div');
    head.className = 'n1-proposal-head';
    head.textContent = 'VORSCHLAG · WARTET AUF DEINE BESTÄTIGUNG';
    c.append(head);
    for (const [label, value] of describe(p)) {
      const row = document.createElement('div');
      row.className = 'n1-proposal-row';
      row.append(Object.assign(document.createElement('span'), { textContent: label }), Object.assign(document.createElement('strong'), { textContent: value }));
      c.append(row);
    }
    const actions = document.createElement('div');
    actions.className = 'n1-proposal-actions';
    const ok = Object.assign(document.createElement('button'), { type: 'button', className: 'primary', textContent: 'Speichern' });
    const no = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Verwerfen' });
    const status = document.createElement('small');
    actions.append(ok, no, status);
    c.append(actions);
    if (p.type === 'mail_reply') {
      // Antwortvorschlag: Text bleibt änderbar, gesendet wird erst nach der zweiten, ausdrücklichen Bestätigung.
      const text = document.createElement('textarea');
      text.rows = 5; text.maxLength = 5000; text.value = p.payload.text || '';
      text.className = 'n1-proposal-text';
      text.setAttribute('aria-label', 'Antworttext');
      c.insertBefore(text, actions);
      ok.textContent = 'Senden …';
      ok.onclick = () => {
        if (!window.JarvisMail) return;
        window.JarvisMail.sendReply({ id: p.target.id, subject: p.target.subject, to: p.target.to, toName: p.target.toName }, text.value, status, () => {
          c.dataset.state = 'saved'; text.disabled = true; ok.remove(); no.remove();
        });
      };
      no.onclick = () => { c.dataset.state = 'rejected'; status.textContent = 'Verworfen. Es wurde nichts gesendet.'; ok.remove(); no.remove(); text.disabled = true; };
      return c;
    }
    if (p.type === 'alarm') {
      ok.textContent = 'Kurzbefehl starten';
      ok.onclick = () => {
        if (!window.JarvisAutomation?.runAlarmShortcut(p.payload.time)) return;
        c.dataset.state = 'saved';
        status.textContent = 'Kurzbefehl gestartet. Prüfe in der Uhr-App, ob der Wecker gestellt wurde – JARVIS kann das nicht selbst sehen.';
        ok.remove(); no.remove();
      };
      no.onclick = () => { c.dataset.state = 'rejected'; status.textContent = 'Verworfen. Es wurde nichts geändert.'; ok.remove(); no.remove(); };
      return c;
    }
    ok.onclick = async () => {
      ok.disabled = no.disabled = true;
      status.textContent = 'Speichere …';
      const res = await apply(p);
      const saved = res.ok && res.body?.saved;
      if (saved) {
        c.dataset.state = 'saved';
        status.textContent = '✓ Gespeichert – von der Datenbank bestätigt.';
        ok.remove(); no.remove();
        window.JarvisCore.flash('success');
        if (p.type === 'save_memory') window.JarvisMemory?.sync();
        window.JarvisPlanner?.refresh();
        if (p.type !== 'save_memory' && el('view-tasks')?.classList.contains('is-active')) window.JarvisTasks?.load();
      } else {
        c.dataset.state = 'error';
        status.textContent = 'Nicht gespeichert: ' + window.JarvisCore.errorText(res.error);
        ok.disabled = no.disabled = false;
        ok.textContent = 'Erneut versuchen';
        window.JarvisCore.flash('error');
      }
    };
    no.onclick = () => {
      c.dataset.state = 'rejected';
      status.textContent = 'Verworfen. Es wurde nichts geändert.';
      ok.remove(); no.remove();
    };
    return c;
  }

  function show(proposals) {
    box.replaceChildren(...proposals.slice(0, 5).map(card));
    if (proposals.length) box.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }

  // --- Kosten und Berechtigungen im Bereich „System“ ----------------------------------------------
  const grid = el('view-system')?.querySelector('.grid');
  const usagePanel = document.createElement('div');
  usagePanel.className = 'panel';
  usagePanel.innerHTML = '<h2>€ KOSTEN & NUTZUNG HEUTE</h2><div id="usageBox" class="list"><div class="item"><small>Wird geladen …</small></div></div>'
    + '<p class="hint">Zählung durch deinen Worker (Tag nach deutscher Zeit). Tageslimits lassen sich über die Worker-Variablen DAILY_MAX_CHAT_REQUESTS, DAILY_MAX_TOKENS und DAILY_MAX_TTS_CHARS ändern. Zusätzlich empfohlen: ein Monatsbudget im OpenAI-Dashboard unter Settings → Limits. Ein ChatGPT-Abo deckt diese API-Kosten nicht ab.</p>';
  const permPanel = document.createElement('div');
  permPanel.className = 'panel';
  permPanel.innerHTML = '<h2>⚿ BERECHTIGUNGEN DES AGENTEN</h2><div id="toolBox" class="list"><div class="item"><small>Wird geladen …</small></div></div>';
  grid?.append(usagePanel, permPanel);

  const CATEGORY = { A: 'A · Lesen', B: 'B · Vorschlagen' };
  const TOOL_TEXT = {
    get_current_time: 'Uhrzeit', get_weather: 'Wetter (Open-Meteo)', get_news: 'Nachrichten (Google News)', list_tasks: 'Aufgaben lesen', get_day_plan: 'Tagesplan lesen', get_calendar_events: 'Kalender lesen (Abo-Link, nur lesen)', propose_plan_change: 'Tagesplan-Änderung vorschlagen', list_study_sets: 'Lernsets lesen', list_message_insights: 'Chat-Auswertungen lesen', list_mails: 'Mails lesen (über die Home-Station)', propose_mail_reply: 'Mail-Antwort vorschlagen (Senden nur nach Bestätigung)',
    propose_task: 'Aufgabe vorschlagen', propose_task_update: 'Aufgabenänderung vorschlagen', propose_memory: 'Erinnerung vorschlagen', propose_alarm: 'Wecker über Kurzbefehl vorschlagen', draft_task: 'Text-Entwurf (ohne Datenbank)'
  };
  function meter(label, used, max) {
    const row = document.createElement('div');
    row.className = 'item usage-row';
    const pct = max ? Math.min(100, Math.round(used / max * 100)) : 0;
    row.append(Object.assign(document.createElement('strong'), { textContent: label }), Object.assign(document.createElement('small'), { textContent: used.toLocaleString('de-DE') + ' von ' + max.toLocaleString('de-DE') + ' (' + pct + ' %)' }));
    const bar = document.createElement('div');
    bar.className = 'usage-bar';
    bar.style.setProperty('--pct', pct + '%');
    if (pct >= 90) bar.dataset.tone = 'warn';
    row.append(bar);
    return row;
  }
  const info = (text) => { const d = document.createElement('div'); d.className = 'item'; d.append(Object.assign(document.createElement('small'), { textContent: text })); return d; };

  async function loadInsights() {
    const usageBox = el('usageBox'), toolBox = el('toolBox');
    if (!apiBase() || !hasCredentials()) {
      usageBox.replaceChildren(info('Kein Backend verbunden.'));
      toolBox.replaceChildren(info('Kein Backend verbunden. Ohne Backend gibt es keinen KI-Agenten.'));
      return;
    }
    const [usage, tools] = await Promise.all([window.JarvisCore.api('/api/usage'), window.JarvisCore.api('/api/tools')]);
    if (usage.ok && usage.body?.tracked) {
      const u = usage.body.usage, l = usage.body.limits;
      usageBox.replaceChildren(
        meter('KI-Anfragen', u.chatRequests, l.chatRequests),
        meter('Tokens (Ein- und Ausgabe)', u.promptTokens + u.completionTokens, l.tokens),
        meter('Zeichen Sprachausgabe', u.ttsChars, l.ttsChars)
      );
    } else {
      usageBox.replaceChildren(info(usage.ok ? (usage.body?.message || 'Nutzung wird nicht gezählt.') : window.JarvisCore.errorText(usage.error)));
    }
    if (tools.ok && Array.isArray(tools.body?.tools)) {
      const rows = tools.body.tools.filter(t => t.available).map(t => info(CATEGORY[t.category] + ' · ' + (TOOL_TEXT[t.name] || t.name) + (t.requiresConfirmation ? ' · speichert erst nach deiner Bestätigung' : ' · ohne Rückfrage')));
      rows.push(info('C · Verändern: Aufgaben und Erinnerungen speichern oder ändern – nur, wenn du einen Vorschlag mit „Speichern“ bestätigst.'));
      rows.push(info('D · Folgenreich: Nachrichten senden, Kalender ändern, Löschen – kann der Agent nicht. Löschen nur durch dich mit Rückfrage.'));
      rows.push(info('Kalender: nur lesen über einen freigegebenen Abo-Link – Termine anlegen oder ändern kann JARVIS nicht.'));
      rows.push(info('Kein Zugriff: WhatsApp, E-Mail, Dateien, Kamera, andere Apps.'));
      toolBox.replaceChildren(...rows);
    } else {
      toolBox.replaceChildren(info(tools.error === 'not_found' ? 'Der deployte Worker ist älter als dieses Frontend. Deploy-Workflow erneut ausführen.' : window.JarvisCore.errorText(tools.error)));
    }
  }
  el('sysRecheck')?.addEventListener('click', loadInsights);

  window.JarvisAgent = { show, loadInsights };
})();
