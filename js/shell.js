// JARVIS Kontrollzentrum: bündelt alle Bereiche im Einstellungs-Overlay der Hauptoberfläche.
// Die bestehenden Bereiche (Gedächtnis, Planung, Design, Verlauf) werden nur verschoben, nicht neu gebaut.
(function () {
  'use strict';
  const TAB_KEY = 'jarvis_settings_tab_v1';
  const TABS = [
    { id: 'system', label: 'System', view: 'view-system' },
    { id: 'tasks', label: 'Aufgaben', view: 'view-tasks' },
    { id: 'settings', label: 'Stimme & KI', view: 'view-settings' },
    { id: 'memory', label: 'Gedächtnis', view: 'view-memory' },
    { id: 'planner', label: 'Planung & Entwürfe', view: 'view-planner' },
    { id: 'design', label: 'Design', view: 'view-design' },
    { id: 'assistant', label: 'Verlauf', view: 'view-assistant' }
  ];
  const el = (id) => document.getElementById(id);
  const overlay = el('n1SettingsOverlay'), content = el('n1SettingsContent');
  if (!overlay || !content) return;

  // WhatsApp-Entwurf lag auf der alten, ausgeblendeten Startseite. Er gehört zu den Entwürfen.
  const waPanel = el('waPrepare')?.closest('.panel');
  const plannerGrid = el('view-planner')?.querySelector('.grid');
  if (waPanel && plannerGrid) plannerGrid.append(waPanel);

  const tabBar = document.createElement('nav');
  tabBar.className = 'n1-panel-tabs';
  tabBar.setAttribute('role', 'tablist');
  tabBar.setAttribute('aria-label', 'Bereiche');
  for (const tab of TABS) {
    const view = el(tab.view);
    if (!view) continue;
    view.hidden = false;
    view.classList.add('n1-settings-view');
    view.setAttribute('role', 'tabpanel');
    content.append(view);
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'tab-' + tab.id;
    button.textContent = tab.label;
    button.setAttribute('role', 'tab');
    button.addEventListener('click', () => activate(tab.id));
    tabBar.append(button);
  }
  overlay.querySelector('.n1-settings-head')?.after(tabBar);

  function activate(id) {
    const tab = TABS.find(t => t.id === id) || TABS[0];
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
    }
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
  let initial = 'system';
  try { initial = localStorage.getItem(TAB_KEY) || 'system'; } catch { /* optional */ }
  activate(initial);

  el('n1Tasks')?.addEventListener('click', () => open('tasks'));
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
