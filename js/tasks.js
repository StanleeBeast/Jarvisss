// JARVIS Aufgaben: dauerhaft in Cloudflare D1 über /api/tasks.
// „Gespeichert“ wird erst angezeigt, wenn die Datenbank den Eintrag zurückgeliefert hat.
(function () {
  'use strict';
  const PRIORITY_TEXT = { high: 'Hoch', normal: 'Normal', low: 'Niedrig' };
  const STATUS_TEXT = { open: 'Offen', done: 'Erledigt', cancelled: 'Verworfen' };

  const section = document.createElement('section');
  section.id = 'view-tasks';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = '<div class="grid" style="margin-top:0">'
    + '<div class="panel"><h2>☑ NEUE AUFGABE</h2><div class="stack">'
    + '<label class="hint">Titel<input id="taskTitle" maxlength="180" placeholder="z. B. Jugendclub: Getränke bestellen"></label>'
    + '<label class="hint">Details (optional)<textarea id="taskDetails" rows="2" maxlength="2000" placeholder="Was genau ist zu tun?"></textarea></label>'
    + '<label class="hint">Fällig (optional, deine Ortszeit)<input id="taskDue" type="datetime-local"></label>'
    + '<label class="hint">Priorität<select id="taskPriority"><option value="normal">Normal</option><option value="high">Hoch</option><option value="low">Niedrig</option></select></label>'
    + '<button id="taskCreate" class="primary">Aufgabe speichern</button></div>'
    + '<p class="hint">Aufgaben liegen in deiner Cloudflare-D1-Datenbank und sind damit auf allen Geräten mit demselben Backend verfügbar. JARVIS kann sie im Chat lesen, aber nicht selbst ändern.</p></div>'
    + '<div class="panel"><h2>◷ AUFGABENLISTE <span class="muted" id="taskCount">–</span></h2>'
    + '<div class="inputrow"><select id="taskFilter" aria-label="Filter"><option value="open">Offen</option><option value="done">Erledigt</option><option value="cancelled">Verworfen</option><option value="all">Alle</option></select><button id="taskReload">Neu laden</button></div>'
    + '<div id="taskState" class="item" style="margin-top:10px"><small>Noch nicht geladen.</small></div>'
    + '<div id="taskList" class="list" style="margin-top:10px"></div></div>'
    + '</div>';
  document.querySelector('main')?.append(section);

  const el = (id) => document.getElementById(id);
  let busy = false;

  function setState(text, tone = 'muted') {
    const box = el('taskState');
    box.hidden = !text;
    box.dataset.tone = tone;
    box.replaceChildren(Object.assign(document.createElement('small'), { textContent: text || '' }));
  }
  function setBusy(value) {
    busy = value;
    section.querySelectorAll('button').forEach(b => { b.disabled = value; });
  }
  function explain(error) {
    if (error === 'storage_not_configured') return 'Die Datenbank ist noch nicht eingerichtet. Anleitung: backend/SETUP_TASKS.md im Repository. Es wurde nichts gespeichert.';
    return window.JarvisCore.errorText(error);
  }
  function formatDue(iso, status) {
    if (!iso) return '';
    const d = new Date(iso);
    const text = 'fällig ' + d.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return status === 'open' && d < new Date() ? text + ' · überfällig' : text;
  }

  function render(tasks) {
    const list = el('taskList');
    list.replaceChildren();
    el('taskCount').textContent = tasks.length + (tasks.length === 1 ? ' Eintrag' : ' Einträge');
    if (!tasks.length) { setState('Keine Aufgaben in dieser Ansicht.'); return; }
    setState('');
    for (const task of tasks) {
      const row = document.createElement('div');
      row.className = 'item task-row';
      row.dataset.priority = task.priority;
      const info = document.createElement('div');
      info.className = 'details';
      const title = document.createElement('strong');
      title.textContent = task.title;
      const meta = document.createElement('small');
      const due = formatDue(task.dueAt, task.status);
      meta.textContent = [PRIORITY_TEXT[task.priority], STATUS_TEXT[task.status], due].filter(Boolean).join(' · ');
      if (due.includes('überfällig')) meta.classList.add('task-overdue');
      info.append(title, meta);
      if (task.details) info.append(Object.assign(document.createElement('small'), { textContent: task.details }));
      const actions = document.createElement('div');
      actions.className = 'task-actions';
      const button = (label, fn, primary) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (primary) b.className = 'primary'; b.onclick = fn; actions.append(b); };
      if (task.status === 'open') {
        button('Erledigt', () => update(task, { status: 'done' }, 'Als erledigt gespeichert.'), true);
        button('Verwerfen', () => confirmAction('Aufgabe verwerfen', '„' + task.title + '“ wird als verworfen markiert. Sie bleibt gespeichert und kann wieder geöffnet werden.', () => update(task, { status: 'cancelled' }, 'Aufgabe verworfen.')));
      } else {
        button('Wieder öffnen', () => update(task, { status: 'open' }, 'Aufgabe wieder geöffnet.'));
      }
      row.append(info, actions);
      list.append(row);
    }
  }

  async function load() {
    if (busy) return;
    if (!apiBase() || !getAIAccessToken()) {
      el('taskList').replaceChildren();
      el('taskCount').textContent = '–';
      setState('Kein Backend verbunden. Trage Worker-URL und Zugangstoken unter „Stimme & KI“ ein.', 'warn');
      return;
    }
    setBusy(true);
    setState('Lade Aufgaben …');
    const res = await window.JarvisCore.api('/api/tasks?status=' + encodeURIComponent(el('taskFilter').value) + '&limit=100');
    setBusy(false);
    if (!res.ok || !Array.isArray(res.body?.tasks)) {
      el('taskList').replaceChildren();
      el('taskCount').textContent = '–';
      setState(explain(res.error), res.error === 'storage_not_configured' ? 'warn' : 'error');
      return;
    }
    render(res.body.tasks);
  }

  async function create() {
    const title = el('taskTitle').value.trim();
    if (!title) { toast('Bitte einen Titel eingeben.'); el('taskTitle').focus(); return; }
    const payload = { title, details: el('taskDetails').value.trim(), priority: el('taskPriority').value };
    const dueValue = el('taskDue').value;
    if (dueValue) {
      const due = new Date(dueValue);
      if (Number.isNaN(due.valueOf())) { toast('Das Fälligkeitsdatum ist ungültig.'); return; }
      payload.dueAt = due.toISOString();
    }
    setBusy(true);
    const res = await window.JarvisCore.api('/api/tasks', { method: 'POST', body: payload });
    setBusy(false);
    if (res.ok && res.body?.saved && res.body.task?.id) {
      el('taskTitle').value = ''; el('taskDetails').value = ''; el('taskDue').value = ''; el('taskPriority').value = 'normal';
      toast('Aufgabe gespeichert – von der Datenbank bestätigt.');
      window.JarvisCore.flash('success');
      el('taskFilter').value = 'open';
      await load();
    } else {
      toast('Nicht gespeichert: ' + explain(res.error));
      window.JarvisCore.flash(res.error === 'storage_not_configured' ? 'warning' : 'error');
    }
  }

  async function update(task, change, message) {
    setBusy(true);
    const res = await window.JarvisCore.api('/api/tasks/' + encodeURIComponent(task.id), { method: 'PATCH', body: change });
    setBusy(false);
    if (res.ok && res.body?.saved && res.body.task?.status === (change.status || task.status)) {
      toast(message);
      window.JarvisCore.flash('success');
      await load();
    } else {
      toast('Änderung nicht gespeichert: ' + explain(res.error));
      window.JarvisCore.flash('error');
    }
  }

  el('taskCreate').addEventListener('click', create);
  el('taskTitle').addEventListener('keydown', e => { if (e.key === 'Enter') create(); });
  el('taskReload').addEventListener('click', load);
  el('taskFilter').addEventListener('change', load);

  window.JarvisTasks = { load };
})();
