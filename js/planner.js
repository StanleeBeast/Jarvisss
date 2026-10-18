// JARVIS Tagesplaner: Zeitleiste auf der Startseite und Bereich „Tagesplan“ im Kontrollzentrum.
// Der Plan wird vom Worker aus Aufgaben, festen Zeiten, Routinen und Pausen berechnet (ohne KI).
// Geändert wird nur durch deinen Tipp oder durch einen bestätigten Vorschlag von JARVIS.
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const KIND = {
    school: { label: 'Schule', color: '#ffb347' },
    work: { label: 'Arbeit', color: '#ff8a3d' },
    sport: { label: 'Sport', color: '#4fe0b0' },
    routine: { label: 'Routine', color: '#f0d9a8' },
    other: { label: 'Termin', color: '#ffd27a' },
    task: { label: 'Aufgabe', color: '#ff5a3c' },
    break: { label: 'Pause', color: '#7fc9b0' },
    free: { label: 'Freizeit', color: '#c9a46a' },
    calendar: { label: 'Kalender', color: '#6fd3e8' }
  };
  const PRIORITY = { high: 'hoch', normal: 'normal', low: 'niedrig' };
  const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin'; } catch { return 'Europe/Berlin'; } };
  const localDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: tz() });
  const shiftDate = (date, days) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const toMin = (t) => { const [a, b] = String(t || '0:0').split(':').map(Number); return a * 60 + b; };
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const dur = (m) => m >= 60 ? Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '') : m + ' min';
  const ready = () => typeof apiBase === 'function' && apiBase() && typeof hasCredentials === 'function' && hasCredentials();

  let date = localDate();
  let plan = null, prefs = null, loading = false;

  // --- Startseite: Tagesverlauf -------------------------------------------------------------------
  const strip = h('section', 'n1-day');
  strip.id = 'n1Day';
  strip.setAttribute('aria-label', 'Tagesverlauf');
  strip.innerHTML = '<div class="n1-day-head"><div class="n1-day-headline"><span class="n1-day-kicker">TAGESVERLAUF</span><span class="n1-day-now" id="n1DayNow">Wird geladen …</span></div>'
    + '<button type="button" class="n1-day-open" id="n1DayOpen">Plan öffnen <span>↗</span></button></div>'
    + '<div class="n1-day-track" id="n1DayTrack"><div class="n1-day-rail"></div><div class="n1-day-segs" id="n1DaySegs"></div><div class="n1-day-ticks" id="n1DayTicks"></div>'
    + '<div class="n1-day-marker" id="n1DayMarker" hidden><i></i><span id="n1DayMarkerTime">--:--</span></div></div>'
    + '<div class="n1-day-legend" id="n1DayLegend"></div>';
  const layout = document.querySelector('#nexusOne .n1-layout');
  layout?.append(strip);
  el('n1DayOpen').addEventListener('click', () => openTab());
  strip.querySelector('.n1-day-track').addEventListener('click', () => openTab());

  // Schnellbefehl „Tagesplan“ öffnet jetzt den echten Plan statt einer freien KI-Antwort.
  const chip = [...document.querySelectorAll('[data-n1-command]')].find(b => /Tagesplan/i.test(b.textContent));
  if (chip) {
    const fresh = chip.cloneNode(true);
    fresh.removeAttribute('data-n1-command');
    fresh.addEventListener('click', () => openTab());
    chip.replaceWith(fresh);
  }

  function openTab() {
    date = localDate();
    window.JarvisShell?.open('day');
  }

  function renderStrip() {
    const segs = el('n1DaySegs'), ticks = el('n1DayTicks'), legend = el('n1DayLegend'), now = el('n1DayNow');
    if (!ready()) {
      strip.dataset.state = 'offline';
      now.textContent = 'Verbinde das Backend, dann plant JARVIS deinen Tag.';
      segs.replaceChildren(); ticks.replaceChildren(); legend.replaceChildren(); el('n1DayMarker').hidden = true;
      return;
    }
    const today = plan && plan.date === localDate() ? plan : stripPlan;
    if (!today) return;
    strip.dataset.state = 'ready';
    const start = toMin(today.window.start), end = toMin(today.window.end), span = Math.max(1, end - start);
    const pos = (m) => Math.max(0, Math.min(100, (m - start) / span * 100));
    segs.replaceChildren(...today.blocks.map((b, i) => {
      const s = h('div', 'n1-day-seg');
      s.dataset.kind = b.kind;
      s.style.left = pos(toMin(b.startTime)) + '%';
      s.style.width = Math.max(.6, pos(toMin(b.endTime)) - pos(toMin(b.startTime))) + '%';
      s.style.setProperty('--c', KIND[b.kind]?.color || '#55eaff');
      s.style.setProperty('--i', i);
      s.title = b.startTime + '–' + b.endTime + ' · ' + b.title;
      return s;
    }));
    const tickEls = [];
    for (let m = Math.ceil(start / 120) * 120; m <= end; m += 120) {
      const t = h('span', 'n1-day-tick', String(m / 60).padStart(2, '0'));
      t.style.left = pos(m) + '%';
      tickEls.push(t);
    }
    ticks.replaceChildren(...tickEls);
    const kinds = [...new Set(today.blocks.map(b => b.kind))];
    legend.replaceChildren(...kinds.map(k => { const l = h('span', 'n1-day-key', KIND[k]?.label || k); l.style.setProperty('--c', KIND[k]?.color); return l; }));
    updateMarker(today);
    const cur = today.current, next = today.next;
    now.textContent = cur
      ? 'Jetzt: ' + cur.title + ' bis ' + cur.endTime + (next ? ' · danach ' + next.title + ' um ' + next.startTime : '')
      : next ? 'Als Nächstes: ' + next.title + ' um ' + next.startTime : (today.blocks.length ? 'Für heute ist nichts mehr geplant.' : 'Noch nichts geplant.');
  }
  function updateMarker(today) {
    const marker = el('n1DayMarker');
    if (!today) return;
    const start = toMin(today.window.start), end = toMin(today.window.end), m = nowMin();
    marker.hidden = !(m >= start && m <= end);
    marker.style.left = ((m - start) / Math.max(1, end - start) * 100) + '%';
    el('n1DayMarkerTime').textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  // --- Bereich „Tagesplan“ ------------------------------------------------------------------------
  const view = h('section', 'view');
  view.id = 'view-day';
  view.hidden = true;
  view.innerHTML = ''
    + '<div class="day-hero">'
    + '<div class="day-dial" aria-hidden="true"><svg viewBox="0 0 220 220" id="dayDial"><defs><filter id="dayGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>'
    + '<circle class="day-dial-orbit" cx="110" cy="110" r="104"/><circle class="day-dial-base" cx="110" cy="110" r="86"/><g id="dayDialTicks"></g><g id="dayDialArcs" filter="url(#dayGlow)"></g>'
    + '<g id="dayDialNeedle" class="day-dial-needle"><line x1="110" y1="110" x2="110" y2="18"/><circle cx="110" cy="18" r="3.2"/></g><circle class="day-dial-hub" cx="110" cy="110" r="52"/></svg>'
    + '<div class="day-dial-center"><b id="dayDialBig">--:--</b><span id="dayDialSmall">TAGESPLAN</span></div></div>'
    + '<div class="day-hero-text"><div class="day-kicker"><span class="day-live"></span><span id="dayKicker">TAGESPLAN</span></div>'
    + '<h3 class="day-title" id="dayTitle">Heute</h3><p class="day-status" id="dayStatus">Wird geladen …</p>'
    + '<div class="day-stats" id="dayStats"></div>'
    + '<div class="day-nav"><button type="button" id="dayPrev" aria-label="Vorheriger Tag">‹</button><button type="button" id="dayToday">Heute</button><button type="button" id="dayNext" aria-label="Nächster Tag">›</button><button type="button" id="dayReload" aria-label="Neu laden">↻</button></div></div>'
    + '</div>'
    + '<div class="day-replan"><div class="day-ask"><input id="dayAsk" maxlength="300" autocomplete="off" placeholder="Was ändert sich? z. B. „Sport fällt heute aus“" aria-label="Plan ändern"><button type="button" id="dayAskSend" aria-label="An JARVIS senden">↗</button></div>'
    + '<div class="day-quick"><button type="button" data-free="30">+30 min Freizeit</button><button type="button" data-free="60">+60 min Freizeit</button><button type="button" id="dayReset">Änderungen zurücksetzen</button></div>'
    + '<p class="hint">JARVIS schlägt Änderungen nur vor – der Plan ändert sich erst nach deiner Bestätigung. Termine kommen aus Aufgaben mit Uhrzeit, festen Zeiten und – wenn verbunden – deinem Kalender (nur lesen).</p></div>'
    + '<div id="dayNotes" class="day-notes"></div>'
    + '<ol class="day-timeline" id="dayTimeline"></ol>'
    + '<div id="dayExtra" class="day-extra"></div>'
    + '<details class="day-rhythm" id="dayRhythm"><summary><span>Mein Rhythmus</span><small>Aufstehen, Schlafen, feste Zeiten, Pausen</small></summary>'
    + '<div class="day-rhythm-grid">'
    + '<label class="hint">Aufstehen<input type="time" id="prefWake"></label><label class="hint">Schlafen<input type="time" id="prefSleep"></label>'
    + '<label class="hint">Konzentriert am Stück (min)<input type="number" min="25" max="240" id="prefFocus"></label><label class="hint">Pause danach (min)<input type="number" min="0" max="60" id="prefBreak"></label>'
    + '<label class="hint">Freizeit am Abend mindestens (min)<input type="number" min="0" max="600" id="prefFree"></label></div>'
    + '<div class="day-fixed-head"><strong>Feste Zeiten</strong><button type="button" id="prefAdd">+ Block</button></div><div id="prefFixed" class="day-fixed"></div>'
    + '<div class="day-rhythm-actions"><button type="button" class="primary" id="prefSave">Rhythmus speichern</button><small id="prefState"></small></div></details>'
    + '<details class="day-rhythm" id="dayCalendar"><summary><span>Kalender verbinden</span><small id="calSummary">Nur lesen · iCloud, Google oder Outlook</small></summary>'
    + '<div class="day-cal-body">'
    + '<p class="hint"><strong>So geht es auf dem iPhone/iPad:</strong> Kalender-App öffnen → unten „Kalender“ → beim gewünschten Kalender auf ⓘ tippen → „Öffentlicher Kalender“ einschalten → „Link teilen …“ → „Kopieren“. Den Link hier einfügen.</p>'
    + '<p class="hint day-cal-warn">Wichtig: Ein öffentlicher Kalender kann von jedem gelesen werden, der den Link kennt. Nimm am besten einen eigenen Kalender nur für JARVIS (z. B. „Schule & Termine“) und teile den Link mit niemandem. JARVIS liest nur – er kann keine Termine anlegen, ändern oder löschen. Änderungen erscheinen nach bis zu 15 Minuten.</p>'
    + '<div class="day-cal-row"><input id="calUrl" type="url" inputmode="url" autocomplete="off" placeholder="webcal://p…-caldav.icloud.com/published/2/…" aria-label="Kalender-Abo-Link"><button type="button" class="primary" id="calSave">Prüfen &amp; verbinden</button></div>'
    + '<div class="day-cal-state" id="calState"></div>'
    + '<div class="day-cal-actions"><button type="button" id="calRefresh">Jetzt neu laden</button><button type="button" id="calRemove">Verbindung trennen</button></div>'
    + '<div id="calList" class="day-cal-list"></div></div></details>';
  document.querySelector('main')?.append(view);

  function explain(error) {
    const cal = { calendar_url_required: 'Bitte einen Link einfügen.', invalid_calendar_url: 'Das sieht nicht wie ein Kalender-Abo-Link aus.', calendar_host_not_allowed: 'Nur Abo-Links von iCloud, Google Kalender oder Outlook sind erlaubt.', calendar_not_found: 'Unter diesem Link gibt es keinen Kalender (mehr). Ist „Öffentlicher Kalender“ noch eingeschaltet?', calendar_unreachable: 'Der Kalender ist gerade nicht erreichbar.', not_a_calendar: 'Unter diesem Link liegt kein Kalender.', calendar_too_large: 'Der Kalender ist zu groß (über 3 MB).', calendar_storage_unavailable: 'Kalender-Tabelle fehlt. Deploy-Workflow erneut ausführen (Migration 0008).' };
    if (cal[error]) return cal[error];
    if (error === 'storage_not_configured') return 'Der Tagesplaner braucht die D1-Datenbank (backend/SETUP_TASKS.md).';
    if (error === 'planner_storage_unavailable') return 'Die Tabelle für den Tagesplaner fehlt. Deploy-Workflow erneut ausführen (Migration 0007).';
    if (error === 'not_found') return 'Der deployte Worker ist älter als diese Seite. Deploy-Workflow erneut ausführen.';
    return window.JarvisCore?.errorText(error) || String(error);
  }

  function dial() {
    const arcs = el('dayDialArcs'), ticks = el('dayDialTicks'), needle = el('dayDialNeedle');
    if (!plan) return;
    const start = toMin(plan.window.start), end = toMin(plan.window.end), span = Math.max(1, end - start);
    const SWEEP = 300, FROM = -150, R = 86, C = 110;
    const ang = (m) => FROM + Math.max(0, Math.min(1, (m - start) / span)) * SWEEP;
    const pt = (a, r = R) => { const rad = (a - 90) * Math.PI / 180; return [C + r * Math.cos(rad), C + r * Math.sin(rad)]; };
    const arc = (a0, a1, r = R) => { const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r); return 'M' + x0.toFixed(2) + ' ' + y0.toFixed(2) + ' A' + r + ' ' + r + ' 0 ' + (a1 - a0 > 180 ? 1 : 0) + ' 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2); };
    const ns = 'http://www.w3.org/2000/svg';
    arcs.replaceChildren(...plan.blocks.map((b, i) => {
      const p = document.createElementNS(ns, 'path');
      const a0 = ang(toMin(b.startTime)) + .8, a1 = Math.max(a0 + .6, ang(toMin(b.endTime)) - .8);
      p.setAttribute('d', arc(a0, a1));
      p.setAttribute('class', 'day-arc');
      p.setAttribute('pathLength', '100');
      p.style.setProperty('--c', KIND[b.kind]?.color || '#55eaff');
      p.style.setProperty('--i', i);
      p.dataset.kind = b.kind;
      return p;
    }));
    const tickEls = [];
    for (let m = Math.ceil(start / 60) * 60; m <= end; m += 60) {
      const [x0, y0] = pt(ang(m), 96), [x1, y1] = pt(ang(m), m % 180 === 0 ? 102 : 99);
      const l = document.createElementNS(ns, 'line');
      l.setAttribute('x1', x0); l.setAttribute('y1', y0); l.setAttribute('x2', x1); l.setAttribute('y2', y1);
      l.setAttribute('class', 'day-dial-tick');
      tickEls.push(l);
      if (m % 180 === 0) {
        const [tx, ty] = pt(ang(m), 66);
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('x', tx); t.setAttribute('y', ty + 3); t.setAttribute('class', 'day-dial-label');
        t.textContent = String(m / 60).padStart(2, '0');
        tickEls.push(t);
      }
    }
    ticks.replaceChildren(...tickEls);
    const m = nowMin();
    const show = plan.isToday && m >= start && m <= end;
    needle.style.display = show ? '' : 'none';
    needle.style.transform = 'rotate(' + ang(m) + 'deg)';
    el('dayDialBig').textContent = plan.isToday ? new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : plan.window.start + '–' + plan.window.end;
    el('dayDialSmall').textContent = plan.isToday ? (plan.current ? (KIND[plan.current.kind]?.label || '').toUpperCase() : 'FREI') : 'TAGESFENSTER';
  }

  function stat(label, value, kind) {
    const s = h('div', 'day-stat');
    if (kind) s.style.setProperty('--c', KIND[kind]?.color);
    s.append(h('b', null, value), h('span', null, label));
    return s;
  }

  function blockActions(b) {
    const out = [];
    if (b.kind === 'task' && b.taskId) {
      out.push(action('Erledigt', () => confirmAction('Aufgabe erledigt?', '„' + b.title + '“ wird als erledigt markiert.', () => setTaskDone(b))));
    }
    if (b.source === 'calendar') { out.push(action('Im Plan ausblenden', () => confirmAction('Im Plan ausblenden?', '„' + b.title + '“ wird nur im Tagesplan für diesen Tag ausgeblendet. Im Kalender selbst ändert JARVIS nichts.', () => saveOverrides({ skip: [...plan.overrides.skip, b.id] }, 'Ausgeblendet.')))); return out; }
    if (b.fixed && b.source !== 'today') out.push(action('Fällt heute aus', () => confirmAction('Fällt heute aus?', '„' + b.title + '“ (' + b.startTime + '–' + b.endTime + ') wird nur für diesen Tag aus dem Plan genommen. Deine festen Zeiten bleiben unverändert.', () => saveOverrides({ skip: [...plan.overrides.skip, b.id] }, 'Aus dem Plan genommen.'))));
    if (b.source === 'today') out.push(action('Entfernen', () => confirmAction('Block entfernen?', '„' + b.title + '“ wird aus dem Plan für diesen Tag entfernt.', () => saveOverrides({ added: plan.overrides.added.filter(a => !(a.title === b.title && a.start === b.startTime)) }, 'Entfernt.'))));
    return out;
  }
  function action(text, fn) {
    const btn = h('button', 'day-act', text);
    btn.type = 'button';
    btn.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return btn;
  }

  function renderView() {
    if (!plan) return;
    const d = new Date(plan.date + 'T12:00:00Z');
    el('dayTitle').textContent = d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
    el('dayKicker').textContent = plan.isToday ? 'TAGESPLAN · HEUTE · LIVE' : plan.date < localDate() ? 'TAGESPLAN · VERGANGEN' : 'TAGESPLAN · VORSCHAU';
    view.dataset.live = plan.isToday ? 'true' : 'false';
    el('dayStatus').textContent = plan.isToday
      ? (plan.current ? 'Jetzt: ' + plan.current.title + ' bis ' + plan.current.endTime + '. ' : 'Gerade ist nichts geplant. ') + (plan.next ? 'Als Nächstes: ' + plan.next.title + ' um ' + plan.next.startTime + '.' : '')
      : 'Tagesfenster ' + plan.window.start + '–' + plan.window.end + '.';
    const st = plan.stats;
    el('dayStats').replaceChildren(
      stat('Aufgaben', st.plannedTasks + ' · ' + dur(st.taskMinutes), 'task'),
      stat('Feste Zeiten', dur(st.fixedMinutes), 'school'),
      stat('Pausen', dur(st.breakMinutes), 'break'),
      stat('Freizeit', dur(st.freeMinutes), 'free')
    );
    const notes = [...plan.notes];
    if (plan.overrides.extraFreeMinutes) notes.unshift('Heute zusätzlich ' + plan.overrides.extraFreeMinutes + ' min Freizeit eingeplant.');
    el('dayNotes').replaceChildren(...notes.map(n => h('div', 'day-note', n)));

    const m = nowMin();
    const items = plan.blocks.map((b, i) => {
      const li = h('li', 'day-block');
      li.dataset.kind = b.kind;
      const s = toMin(b.startTime), e = toMin(b.endTime);
      li.dataset.state = !plan.isToday ? (plan.date < localDate() ? 'past' : 'future') : e <= m ? 'past' : s <= m ? 'now' : 'future';
      li.style.setProperty('--c', KIND[b.kind]?.color || '#55eaff');
      li.style.setProperty('--i', Math.min(i, 14));
      const time = h('div', 'day-time');
      time.append(h('b', null, b.startTime), h('small', null, b.endTime));
      const node = h('div', 'day-node');
      const card = h('div', 'day-card');
      const meta = [KIND[b.kind]?.label || b.kind];
      if (b.priority && b.kind === 'task') meta.push('Priorität ' + PRIORITY[b.priority]);
      if (b.overdue) meta.push('überfällig');
      if (b.due) meta.push('mit Uhrzeit');
      if (b.source === 'today') meta.push('nur heute');
      if (b.source === 'calendar') meta.push('nur gelesen' + (b.location ? ' · ' + b.location : ''));
      card.append(h('div', 'day-card-kind', meta.join(' · ').toUpperCase()), h('div', 'day-card-title', b.title), h('div', 'day-card-meta', dur(e - s)));
      if (li.dataset.state === 'now') {
        const bar = h('div', 'day-progress');
        bar.style.setProperty('--p', Math.round((m - s) / Math.max(1, e - s) * 100) + '%');
        card.append(bar);
      }
      const acts = li.dataset.state === 'past' ? [] : blockActions(b);
      if (acts.length) { const a = h('div', 'day-card-actions'); a.append(...acts); card.append(a); }
      li.append(time, node, card);
      return li;
    });
    el('dayTimeline').replaceChildren(...(items.length ? items : [h('li', 'day-empty', 'Für diesen Tag ist nichts geplant. Lege feste Zeiten unter „Mein Rhythmus“ an oder speichere Aufgaben.')]));

    const extra = [];
    if (plan.skipped.length) {
      const box = h('div', 'day-panel');
      box.append(h('div', 'day-panel-title', 'FÄLLT HEUTE AUS'));
      for (const s of plan.skipped) {
        const row = h('div', 'day-row');
        row.append(h('span', null, s.startTime + '–' + s.endTime + ' · ' + s.title), action('Zurückholen', () => saveOverrides({ skip: plan.overrides.skip.filter(id => id !== s.id) }, 'Wieder im Plan.')));
        box.append(row);
      }
      extra.push(box);
    }
    if (plan.unscheduled.length) {
      const box = h('div', 'day-panel');
      box.append(h('div', 'day-panel-title', 'PASST HEUTE NICHT MEHR REIN'));
      for (const t of plan.unscheduled) box.append(h('div', 'day-row', t.title + ' · ca. ' + t.minutes + ' min · Priorität ' + PRIORITY[t.priority]));
      box.append(h('p', 'hint', 'Tipp: Sag JARVIS z. B. „Verschiebe das Zimmer-Aufräumen auf morgen“ – er schlägt die Änderung vor.'));
      extra.push(box);
    }
    if (plan.allDay?.length) {
      const box = h('div', 'day-panel');
      box.append(h('div', 'day-panel-title', 'GANZTÄGIG · AUS DEM KALENDER'));
      for (const a of plan.allDay) box.append(h('div', 'day-row', a.title + (a.location ? ' · ' + a.location : '')));
      extra.unshift(box);
    }
    el('dayExtra').replaceChildren(...extra);
    dial();
  }

  function renderPrefs() {
    if (!prefs) return;
    el('prefWake').value = prefs.wake; el('prefSleep').value = prefs.sleep;
    el('prefFocus').value = prefs.focusMinutes; el('prefBreak').value = prefs.breakMinutes; el('prefFree').value = prefs.minFreeMinutes;
    el('prefFixed').replaceChildren(...prefs.fixed.map(fixedRow));
    if (!prefs.fixed.length) el('prefFixed').append(h('p', 'hint day-fixed-empty', 'Noch keine festen Zeiten. Beispiel: Schule Mo–Fr 08:00–15:00, Training Di + Do 18:00–19:30.'));
  }
  function fixedRow(f) {
    const row = h('div', 'day-fixed-row');
    const title = Object.assign(h('input'), { value: f.title, maxLength: 80, placeholder: 'z. B. Schule' });
    title.dataset.f = 'title';
    title.setAttribute('aria-label', 'Titel');
    const kind = h('select');
    kind.dataset.f = 'kind';
    kind.setAttribute('aria-label', 'Art');
    for (const k of ['school', 'work', 'sport', 'routine', 'other']) kind.append(Object.assign(h('option', null, KIND[k].label), { value: k }));
    kind.value = f.kind;
    const start = Object.assign(h('input'), { type: 'time', value: f.start }); start.dataset.f = 'start'; start.setAttribute('aria-label', 'Beginn');
    const end = Object.assign(h('input'), { type: 'time', value: f.end }); end.dataset.f = 'end'; end.setAttribute('aria-label', 'Ende');
    const days = h('div', 'day-days');
    DAYS.forEach((name, i) => {
      const b = h('button', 'day-daybtn', name);
      b.type = 'button';
      b.dataset.day = String(i + 1);
      b.setAttribute('aria-pressed', String(f.days.includes(i + 1)));
      b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')));
      days.append(b);
    });
    const remove = h('button', 'day-remove', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Block entfernen');
    remove.addEventListener('click', () => row.remove());
    row.append(title, kind, start, end, days, remove);
    return row;
  }
  function readPrefs() {
    const fixed = [...el('prefFixed').querySelectorAll('.day-fixed-row')].map(row => ({
      title: row.querySelector('[data-f=title]').value.trim(),
      kind: row.querySelector('[data-f=kind]').value,
      start: row.querySelector('[data-f=start]').value,
      end: row.querySelector('[data-f=end]').value,
      days: [...row.querySelectorAll('.day-daybtn[aria-pressed=true]')].map(b => Number(b.dataset.day))
    }));
    return { wake: el('prefWake').value, sleep: el('prefSleep').value, focusMinutes: Number(el('prefFocus').value), breakMinutes: Number(el('prefBreak').value), minFreeMinutes: Number(el('prefFree').value), taskMinutes: prefs?.taskMinutes, fixed };
  }

  // --- Daten --------------------------------------------------------------------------------------
  let stripPlan = null;
  async function load(options = {}) {
    if (!ready()) { renderStrip(); setStatus('Kein Backend verbunden. Der Tagesplan wird vom Worker berechnet.'); return; }
    if (loading) return;
    loading = true;
    try {
      const res = await window.JarvisCore.api('/api/planner/day?date=' + date + '&tz=' + encodeURIComponent(tz()));
      if (!res.ok) { setStatus(explain(res.error || res.body?.error)); strip.dataset.state = 'error'; el('n1DayNow').textContent = 'Tagesplan nicht verfügbar: ' + explain(res.error || res.body?.error); return; }
      plan = res.body.plan;
      if (plan.date === localDate()) stripPlan = plan;
      renderStrip();
      renderView();
      if (options.prefs) loadCalendar();
      if (options.prefs || !prefs) {
        const p = await window.JarvisCore.api('/api/planner/prefs');
        if (p.ok) { prefs = p.body.prefs; renderPrefs(); if (!p.body.configured) el('dayRhythm').open = true; }
      }
    } finally { loading = false; }
  }
  async function loadStrip() {
    if (!ready()) { renderStrip(); return; }
    const res = await window.JarvisCore.api('/api/planner/day?date=' + localDate() + '&tz=' + encodeURIComponent(tz()));
    if (res.ok) { stripPlan = res.body.plan; renderStrip(); }
    else { strip.dataset.state = 'error'; el('n1DayNow').textContent = 'Tagesplan nicht verfügbar: ' + explain(res.error || res.body?.error); }
  }
  function setStatus(text) { el('dayStatus').textContent = text; }

  async function saveOverrides(change, okText) {
    const body = { ...plan.overrides, ...change };
    const res = await window.JarvisCore.api('/api/planner/day/' + plan.date + '/overrides', { method: 'PUT', body });
    if (res.ok && res.body?.saved) { window.JarvisCore.flash('success'); toastMsg(okText + ' Vom Server bestätigt.'); await load(); }
    else { window.JarvisCore.flash('error'); toastMsg('Nicht gespeichert: ' + explain(res.error || res.body?.error)); }
  }
  async function setTaskDone(b) {
    const res = await window.JarvisCore.api('/api/tasks/' + encodeURIComponent(b.taskId), { method: 'PATCH', body: { status: 'done' } });
    if (res.ok && res.body?.saved) { window.JarvisCore.flash('success'); toastMsg('„' + b.title + '“ ist erledigt.'); await load(); }
    else { window.JarvisCore.flash('error'); toastMsg('Nicht gespeichert: ' + explain(res.error || res.body?.error)); }
  }
  function toastMsg(text) {
    const t = el('n1Toast');
    if (!t) return;
    t.textContent = text; t.style.display = 'block';
    clearTimeout(window.n1ToastTimer);
    window.n1ToastTimer = setTimeout(() => { t.style.display = 'none'; }, 3200);
  }

  // --- Kalender (nur lesen) -----------------------------------------------------------------------
  async function loadCalendar() {
    const state = el('calState'), list = el('calList');
    const res = await window.JarvisCore.api('/api/calendar/settings');
    if (!res.ok) { state.textContent = explain(res.error || res.body?.error); return; }
    const on = res.body.configured;
    el('calSummary').textContent = on ? 'Verbunden (nur lesen) · ' + res.body.source : 'Nur lesen · iCloud, Google oder Outlook';
    el('calRefresh').hidden = el('calRemove').hidden = !on;
    el('calSave').textContent = on ? 'Link ersetzen' : 'Prüfen & verbinden';
    if (!on) { state.textContent = 'Kein Kalender verbunden.'; list.replaceChildren(); return; }
    await showEvents(false);
  }
  async function showEvents(refresh) {
    const state = el('calState'), list = el('calList');
    state.textContent = 'Lade Termine …';
    const res = await window.JarvisCore.api('/api/calendar/events?days=14&tz=' + encodeURIComponent(tz()) + (refresh ? '&refresh=1' : ''));
    if (!res.ok) { state.textContent = explain(res.error || res.body?.error); return; }
    const b = res.body;
    const when = b.fetchedAt ? new Date(b.fetchedAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';
    state.textContent = (b.error ? 'Letzter Abruf fehlgeschlagen: ' + explain(b.error) + (b.stale ? ' Angezeigt werden die zuletzt geladenen Termine.' : '') + ' ' : '') + b.events.length + ' Termine in den nächsten 14 Tagen · Stand ' + when + '.';
    list.replaceChildren(...b.events.slice(0, 30).map(e => {
      const row = h('div', 'day-row');
      const d = new Date(e.start);
      const t = e.allDay ? new Date(e.date + 'T12:00:00Z').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' }) + ' · ganztägig'
        : d.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      row.append(h('span', null, t + ' · ' + e.title + (e.location ? ' · ' + e.location : '')));
      return row;
    }));
  }
  el('calSave').addEventListener('click', async () => {
    const url = el('calUrl').value.trim();
    const state = el('calState');
    if (!url) { state.textContent = explain('calendar_url_required'); return; }
    state.textContent = 'Prüfe den Link …';
    const res = await window.JarvisCore.api('/api/calendar/settings?tz=' + encodeURIComponent(tz()), { method: 'PUT', body: { url } });
    if (res.ok && res.body?.saved) { el('calUrl').value = ''; window.JarvisCore.flash('success'); toastMsg('Kalender verbunden – ' + res.body.events + ' Termine gefunden.'); await loadCalendar(); await load(); }
    else { state.textContent = 'Nicht verbunden: ' + explain(res.error || res.body?.error); window.JarvisCore.flash('error'); }
  });
  el('calRefresh').addEventListener('click', async () => { await showEvents(true); await load(); });
  el('calRemove').addEventListener('click', () => confirmAction('Kalender trennen?', 'JARVIS vergisst den Abo-Link und die zwischengespeicherten Termine. Dein Kalender selbst bleibt unverändert. Tipp: Schalte in der Kalender-App „Öffentlicher Kalender“ wieder aus, wenn du den Link nicht mehr brauchst.', async () => {
    const res = await window.JarvisCore.api('/api/calendar/settings', { method: 'DELETE' });
    if (res.ok) { toastMsg('Kalender getrennt.'); await loadCalendar(); await load(); }
    else toastMsg('Nicht getrennt: ' + explain(res.error || res.body?.error));
  }));

  el('dayPrev').addEventListener('click', () => { date = shiftDate(date, -1); load(); });
  el('dayNext').addEventListener('click', () => { date = shiftDate(date, 1); load(); });
  el('dayToday').addEventListener('click', () => { date = localDate(); load(); });
  el('dayReload').addEventListener('click', () => load({ prefs: true }));
  view.querySelectorAll('[data-free]').forEach(b => b.addEventListener('click', () => {
    if (!plan) return;
    saveOverrides({ extraFreeMinutes: Math.min(360, (plan.overrides.extraFreeMinutes || 0) + Number(b.dataset.free)) }, '+' + b.dataset.free + ' min Freizeit eingeplant.');
  }));
  el('dayReset').addEventListener('click', () => {
    if (!plan) return;
    confirmAction('Änderungen zurücksetzen?', 'Alle Änderungen für ' + plan.date + ' (ausgefallene Blöcke, zusätzliche Freizeit, hinzugefügte Blöcke) werden entfernt. Aufgaben bleiben unverändert.', async () => {
      const res = await window.JarvisCore.api('/api/planner/day/' + plan.date + '/overrides', { method: 'DELETE' });
      if (res.ok) { toastMsg(res.body.deleted ? 'Zurückgesetzt.' : 'Es gab keine Änderungen.'); await load(); }
      else toastMsg('Nicht zurückgesetzt: ' + explain(res.error || res.body?.error));
    });
  });
  function ask() {
    const text = el('dayAsk').value.trim();
    if (!text) return;
    const input = el('n1Input'), sendBtn = el('n1Send');
    if (!input || !sendBtn) return;
    const prefix = plan && !plan.isToday ? 'Für den ' + plan.date + ': ' : '';
    input.value = prefix + text;
    el('dayAsk').value = '';
    el('n1SettingsClose')?.click();
    sendBtn.click();
    setTimeout(() => el('n1Answer')?.scrollIntoView({ block: 'center' }), 400);
  }
  el('dayAskSend').addEventListener('click', ask);
  el('dayAsk').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
  el('prefAdd').addEventListener('click', () => {
    el('prefFixed').querySelector('.day-fixed-empty')?.remove();
    el('prefFixed').append(fixedRow({ title: '', kind: 'school', start: '08:00', end: '15:00', days: [1, 2, 3, 4, 5] }));
  });
  el('prefSave').addEventListener('click', async () => {
    const state = el('prefState');
    const body = readPrefs();
    if (body.fixed.some(f => !f.title)) { state.textContent = 'Jeder Block braucht einen Titel.'; return; }
    if (body.fixed.some(f => !f.days.length)) { state.textContent = 'Jeder Block braucht mindestens einen Wochentag.'; return; }
    if (body.fixed.some(f => f.end <= f.start)) { state.textContent = 'Das Ende muss nach dem Beginn liegen.'; return; }
    state.textContent = 'Speichere …';
    const res = await window.JarvisCore.api('/api/planner/prefs', { method: 'PUT', body });
    if (res.ok && res.body?.saved) { prefs = res.body.prefs; state.textContent = '✓ Gespeichert – vom Server bestätigt.'; window.JarvisCore.flash('success'); renderPrefs(); await load(); }
    else { state.textContent = 'Nicht gespeichert: ' + ({ invalid_day_window: 'Zwischen Aufstehen und Schlafen müssen mindestens 2 Stunden liegen.', invalid_block: 'Ein Block ist unvollständig.', too_many_blocks: 'Höchstens 20 feste Blöcke.' }[res.body?.error] || explain(res.error || res.body?.error)); window.JarvisCore.flash('error'); }
  });

  // Zeitleiste und Zeiger laufen live mit; der Plan selbst wird alle 5 Minuten neu berechnet.
  setInterval(() => { updateMarker(stripPlan); if (plan?.isToday && view.classList.contains('is-active')) dial(); }, 30_000);
  setInterval(() => { if (document.visibilityState === 'visible') loadStrip(); }, 300_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadStrip(); });
  setTimeout(loadStrip, 900);

  window.JarvisPlanner = { load, loadStrip, open: openTab, refresh: () => { loadStrip(); if (view.classList.contains('is-active')) load(); } };
})();
