// JARVIS Kontrollzentrum: bündelt alle Bereiche im Einstellungs-Overlay der Hauptoberfläche.
// Die bestehenden Bereiche (Gedächtnis, Planung, Design, Verlauf) werden nur verschoben, nicht neu gebaut.
(function () {
  'use strict';
  const TAB_KEY = 'jarvis_settings_tab_v1';
  // Fünf Bereiche statt 13 Tabs. Die einzelnen Ansichten bleiben dieselben (ids tab-*/view-*).
  const GROUPS = [
    { id: 'today', label: 'Heute', icon: '◷', tabs: ['day', 'tasks'] },
    { id: 'comm', label: 'Kommunikation', short: 'Post', icon: '✉', tabs: ['mail', 'messages'] },
    { id: 'learn', label: 'Lernen', icon: '✎', tabs: ['study'] },
    { id: 'jarvis', label: 'JARVIS', icon: '◎', tabs: ['autonomy', 'settings', 'memory', 'improve', 'automation', 'assistant', 'planner'] },
    { id: 'system', label: 'System', icon: '⚙', tabs: ['system', 'devices', 'context', 'design'] }
  ];
  const TABS = [
    { id: 'system', label: 'Status', view: 'view-system' },
    { id: 'day', label: 'Tagesplan', view: 'view-day' },
    { id: 'mail', label: 'Mails', view: 'view-mail' },
    { id: 'tasks', label: 'Aufgaben', view: 'view-tasks' },
    { id: 'study', label: 'Lernen', view: 'view-study' },
    { id: 'messages', label: 'Chats (WhatsApp)', view: 'view-messages' },
    { id: 'autonomy', label: 'Autonomie', view: 'view-autonomy' },
    { id: 'settings', label: 'Stimme & KI', view: 'view-settings' },
    { id: 'devices', label: 'Geräte', view: 'view-devices' },
    { id: 'context', label: 'iPhone, iPad & Alexa', view: 'view-context' },
    { id: 'automation', label: 'Automatisierungen', view: 'view-automation' },
    { id: 'memory', label: 'Gedächtnis', view: 'view-memory' },
    { id: 'improve', label: 'Verbesserungen', view: 'view-improve' },
    { id: 'planner', label: 'Entwürfe', view: 'view-planner' },
    { id: 'design', label: 'Design', view: 'view-design' },
    { id: 'assistant', label: 'Verlauf', view: 'view-assistant' }
  ];
  const groupOf = (tabId) => GROUPS.find(g => g.tabs.includes(tabId)) || GROUPS[0];
  const el = (id) => document.getElementById(id);
  const overlay = el('n1SettingsOverlay'), content = el('n1SettingsContent');
  if (!overlay || !content) return;

  // WhatsApp-Entwurf lag auf der alten, ausgeblendeten Startseite. Er gehört zu den Entwürfen.
  const waPanel = el('waPrepare')?.closest('.panel');
  const plannerGrid = el('view-planner')?.querySelector('.grid');
  if (waPanel && plannerGrid) plannerGrid.append(waPanel);

  const tabBar = document.createElement('nav');
  tabBar.className = 'n1-panel-tabs n1-nav';
  tabBar.setAttribute('aria-label', 'Bereiche');
  const groupRow = document.createElement('div');
  groupRow.className = 'n1-groups';
  const subRow = document.createElement('div');
  subRow.className = 'n1-subtabs';
  subRow.setAttribute('role', 'tablist');
  for (const g of GROUPS) {
    const gb = document.createElement('button');
    gb.type = 'button';
    gb.className = 'n1-group-btn';
    gb.dataset.group = g.id;
    gb.innerHTML = '<span class="n1-group-icon" aria-hidden="true"></span><span class="n1-group-label"></span>';
    gb.querySelector('.n1-group-icon').textContent = g.icon;
    gb.querySelector('.n1-group-label').textContent = g.label;
    gb.querySelector('.n1-group-label').dataset.short = g.short || g.label;
    gb.addEventListener('click', () => activate(g.tabs[0]));
    groupRow.append(gb);
    const head = document.createElement('div');
    head.className = 'n1-sub-head';
    head.dataset.group = g.id;
    head.textContent = g.icon + '  ' + g.label;
    subRow.append(head);
    for (const tabId of g.tabs) {
      const tab = TABS.find(t => t.id === tabId);
      const view = el(tab.view);
      if (!view) continue;
      view.hidden = false;
      view.classList.add('n1-settings-view');
      view.setAttribute('role', 'tabpanel');
      content.append(view);
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'tab-' + tab.id;
      button.className = 'n1-tab';
      button.dataset.group = g.id;
      button.textContent = tab.label;
      button.setAttribute('role', 'tab');
      button.addEventListener('click', () => activate(tab.id));
      subRow.append(button);
    }
  }
  tabBar.append(groupRow, subRow);
  // Breite Bildschirme: Seitenleiste neben dem Inhalt; schmale: Bereiche oben, Unterpunkte darunter.
  const body = document.createElement('div');
  body.className = 'n1-settings-body';
  content.before(body);
  body.append(tabBar, content);

  function activate(id) {
    const tab = TABS.find(t => t.id === id) || TABS[0];
    const group = groupOf(tab.id);
    tabBar.dataset.group = group.id;
    groupRow.querySelectorAll('.n1-group-btn').forEach(b => b.setAttribute('aria-current', String(b.dataset.group === group.id)));
    for (const t of TABS) {
      el(t.view)?.classList.toggle('is-active', t.id === tab.id);
      el('tab-' + t.id)?.setAttribute('aria-selected', String(t.id === tab.id));
    }
    el('tab-' + tab.id)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    content.scrollTop = 0;
    try { localStorage.setItem(TAB_KEY, tab.id); } catch { /* optional */ }
    if (tab.id === 'tasks') window.JarvisTasks?.load();
    if (tab.id === 'system') {
      const last = window.JarvisCore?.lastStatus;
      if (!last || Date.now() - new Date(last.checkedAt).getTime() > 60_000) window.JarvisCore?.checkSystem();
      window.JarvisAgent?.loadInsights();
    }
    if (tab.id === 'devices') window.JarvisAuth?.loadDevices();
    if (tab.id === 'automation') window.JarvisAutomation?.load();
    if (tab.id === 'study') window.JarvisStudy?.load();
    if (tab.id === 'messages') window.JarvisMessages?.load();
    if (tab.id === 'mail') window.JarvisMail?.load();
    if (tab.id === 'autonomy') window.JarvisAutonomy?.load();
    if (tab.id === 'context') window.JarvisContext?.load();
    if (tab.id === 'improve') window.JarvisImprove?.load();
    if (tab.id === 'day') window.JarvisPlanner?.load({ prefs: true });
    if (tab.id === 'memory') window.JarvisMemory?.sync();
    if (tab.id === 'assistant') renderChat();
    if (tab.id === 'planner') renderEvents();
  }
  function open(id) {
    activate(id);
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('n1-settings-open');
    el('n1SettingsClose')?.focus();
  }
  let initial = 'day';
  try { initial = localStorage.getItem(TAB_KEY) || 'day'; } catch { /* optional */ }
  activate(initial);

  window.JarvisShell = { open };
  el('n1Tasks')?.addEventListener('click', () => open('tasks'));
  el('n1Study')?.addEventListener('click', () => open('study'));
  el('n1StateBtn')?.addEventListener('click', () => open('system'));

  // Bestehende Befehle („Termin …“, „Nachricht an …“) öffnen jetzt den passenden Bereich.
  goView = function (name) {
    const map = { planner: 'planner', home: 'planner', memory: 'memory', design: 'design', settings: 'settings', assistant: 'assistant' };
    if (map[name]) open(map[name]);
  };
  window.n1Show = function (text, label = 'JARVIS BRIEFING') {
    if (el('n1AnswerText')) el('n1AnswerText').textContent = text;
    if (el('n1AnswerLabel')) el('n1AnswerLabel').textContent = label;
    if (el('n1AnswerTime')) el('n1AnswerTime').textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  };

  // Stimme: Quelle, KI-Stimme und Prüfung vor dem Senden werden im Profil gespeichert.
  const engine = el('voiceEngine'), aiVoice = el('aiVoice'), review = el('reviewVoice');
  if (engine) { engine.value = data.profile.voiceEngine || 'neural'; engine.onchange = () => { data.profile.voiceEngine = engine.value; saveData(); toast('Stimmquelle gespeichert.'); }; }
  if (aiVoice) { aiVoice.value = data.profile.aiVoice || 'coral'; aiVoice.onchange = () => { data.profile.aiVoice = aiVoice.value; saveData(); toast('KI-Stimme gespeichert. Teste sie mit „Stimme testen“.'); }; }
  if (review) { review.checked = Boolean(data.profile.reviewVoice); review.onchange = () => { data.profile.reviewVoice = review.checked; saveData(); }; }

  // Design: Layout-Varianten wirken nur auf die frühere Ansicht und sind deshalb ehrlich deaktiviert.
  const layout = el('layoutPreset');
  if (layout) {
    layout.disabled = true;
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'Farbsignatur, Akzentfarbe, Glow und Animationen wirken auf die Hauptansicht. Layout-Varianten werden mit dem neuen Designstudio (Phase 9) neu umgesetzt und sind bis dahin deaktiviert. Designs werden nur lokal in diesem Browser gespeichert.';
    layout.closest('label')?.after(note);
  }
})();
