// JARVIS Gedächtnis-Synchronisation über /api/memories (D1).
// Ist D1 eingerichtet, ist der Server die Quelle der Wahrheit; der Browser hält nur eine Kopie für den Offline-Fall.
// Einträge, die vor der Synchronisation nur lokal existierten, werden erst nach ausdrücklicher Zustimmung hochgeladen.
(function () {
  'use strict';
  const MODE_KEY = 'jarvis_memory_mode_v1';
  const KIND_TEXT = { preference: 'Vorliebe', fact: 'Fakt', style: 'Stilhinweis', routine: 'Routine', project: 'Projekt' };
  let mode = (() => { try { return localStorage.getItem(MODE_KEY) || 'local'; } catch { return 'local'; } })();
  let lastSync = null, syncing = null, lastError = null;

  const el = (id) => document.getElementById(id);
  const api = (path, options) => window.JarvisCore.api(path, options);
  const setMode = (value) => { mode = value; try { localStorage.setItem(MODE_KEY, value); } catch { /* egal */ } };
  const fromServer = (m) => ({ id: m.id, serverId: m.id, text: m.text, kind: m.kind, createdAt: m.createdAt, updatedAt: m.updatedAt });
  const isLocalOnly = (m) => !m.serverId;

  // Statuszeile oberhalb der Liste.
  const statusLine = document.createElement('div');
  statusLine.className = 'item memory-sync';
  statusLine.id = 'memorySyncState';
  const memoryList = el('memories');
  memoryList?.before(statusLine);
  const hint = memoryList?.closest('.panel')?.querySelector('.hint');
  if (hint) hint.textContent = 'Nur Informationen, die du ausdrücklich speicherst. Mit eingerichteter D1-Datenbank werden sie zwischen deinen Geräten synchronisiert, sonst bleiben sie in diesem Browser. Bitte keine Passwörter oder hochsensiblen Daten speichern.';

  function renderStatus() {
    const legacy = data.memories.filter(m => isLocalOnly(m) && m.legacyLocal).length;
    statusLine.replaceChildren();
    const text = document.createElement('small');
    if (mode === 'cloud') {
      text.textContent = '☁ Synchronisiert über D1' + (lastSync ? ' · zuletzt ' + new Date(lastSync).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '') + (lastError ? ' · ' + window.JarvisCore.errorText(lastError) + ' (lokale Kopie wird angezeigt)' : '');
      statusLine.dataset.tone = lastError ? 'warn' : 'ok';
    } else {
      text.textContent = '◇ Nur lokal in diesem Browser.' + (lastError && lastError !== 'storage_not_configured' ? ' ' + window.JarvisCore.errorText(lastError) : ' Synchronisation startet automatisch, sobald D1 eingerichtet ist.');
      statusLine.dataset.tone = 'muted';
    }
    statusLine.append(text);
    if (mode === 'cloud' && legacy) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'primary';
      btn.textContent = legacy + ' lokale Einträge in die Cloud übernehmen';
      btn.onclick = () => confirmAction('Lokale Erinnerungen übernehmen', legacy + ' Einträge aus diesem Browser werden in deine D1-Datenbank übertragen und sind danach auf allen angemeldeten Geräten sichtbar.', uploadLegacy);
      statusLine.append(btn);
    }
  }

  renderMemories = function () {
    const box = el('memories');
    box.replaceChildren();
    renderStatus();
    if (!data.memories.length) { box.innerHTML = '<div class="item"><small>Noch keine gespeicherten Erinnerungen.</small></div>'; return; }
    for (const m of data.memories) {
      const row = document.createElement('div');
      row.className = 'item memory';
      const textBox = document.createElement('div');
      textBox.textContent = m.text;
      const meta = document.createElement('small');
      const where = m.serverId ? '☁' : (mode === 'cloud' && !m.legacyLocal ? 'wird übertragen …' : 'lokal');
      meta.textContent = (KIND_TEXT[m.kind] || 'Erinnerung') + ' · ' + (m.createdAt ? new Date(m.createdAt).toLocaleString('de-DE') : 'älterer Eintrag') + ' · ' + where;
      textBox.append(meta);
      const edit = document.createElement('button');
      edit.textContent = 'Bearbeiten';
      edit.onclick = () => editMemory(m);
      const del = document.createElement('button');
      del.textContent = 'Löschen';
      del.onclick = () => confirmAction('Erinnerung löschen', '„' + m.text.slice(0, 120) + '“ wird ' + (m.serverId ? 'auf allen Geräten ' : '') + 'endgültig gelöscht.', () => deleteMemory(m));
      row.append(textBox, edit, del);
      box.append(row);
    }
    // Neue Einträge (z. B. über „Merk dir: …“ oder Feedback) im Cloud-Modus sofort übertragen.
    if (mode === 'cloud' && data.memories.some(m => isLocalOnly(m) && !m.legacyLocal)) setTimeout(pushPending, 0);
  };

  async function editMemory(m) {
    const next = prompt('Erinnerung bearbeiten:', m.text);
    if (next === null) return;
    const text = next.trim();
    if (!text) { toast('Leerer Inhalt nicht gespeichert.'); return; }
    if (m.serverId) {
      const res = await api('/api/memories/' + encodeURIComponent(m.serverId), { method: 'PATCH', body: { text } });
      if (!res.ok || !res.body?.saved) { toast('Nicht gespeichert: ' + window.JarvisCore.errorText(res.error)); return; }
      Object.assign(m, fromServer(res.body.memory));
    } else {
      m.text = text; m.updatedAt = new Date().toISOString();
    }
    saveData(); renderMemories(); toast('Erinnerung aktualisiert.');
  }
  async function deleteMemory(m) {
    if (m.serverId) {
      const res = await api('/api/memories/' + encodeURIComponent(m.serverId), { method: 'DELETE' });
      if (!res.ok && res.error !== 'memory_not_found') { toast('Nicht gelöscht: ' + window.JarvisCore.errorText(res.error)); return; }
    }
    data.memories = data.memories.filter(x => x !== m);
    saveData(); renderMemories(); toast('Erinnerung gelöscht.');
  }

  async function upload(m) {
    const res = await api('/api/memories', { method: 'POST', body: { text: m.text.slice(0, 500), kind: KIND_TEXT[m.kind] ? m.kind : 'preference' } });
    if (res.ok && res.body?.saved) { Object.assign(m, fromServer(res.body.memory)); delete m.legacyLocal; return true; }
    lastError = res.error;
    return false;
  }
  let pushing = null;
  function pushPending() {
    if (mode !== 'cloud') return Promise.resolve();
    if (pushing) return pushing;
    const pending = data.memories.filter(m => isLocalOnly(m) && !m.legacyLocal);
    if (!pending.length) return Promise.resolve();
    pushing = (async () => {
      for (const m of pending) if (!(await upload(m))) break;
      saveData();
    })().finally(() => { pushing = null; renderMemories(); });
    return pushing;
  }

  el('addMemory').onclick = async () => {
    const text = el('memoryInput').value.trim();
    if (!text) return;
    const m = { id: Date.now(), text, kind: 'preference', createdAt: new Date().toISOString() };
    data.memories.unshift(m);
    saveData();
    el('memoryInput').value = '';
    renderMemories();
    if (mode !== 'cloud') { toast('Erinnerung lokal in diesem Browser gespeichert.'); return; }
    await pushPending();
    toast(m.serverId ? 'Erinnerung gespeichert und mit deinen Geräten synchronisiert.' : 'Vorerst nur lokal gespeichert: ' + window.JarvisCore.errorText(lastError) + ' Wird später erneut übertragen.');
  };
  async function uploadLegacy() {
    const legacy = data.memories.filter(m => isLocalOnly(m) && m.legacyLocal);
    let ok = 0;
    for (const m of legacy) if (await upload(m)) ok++; else break;
    saveData(); renderMemories();
    toast(ok === legacy.length ? ok + ' Einträge übertragen und vom Server bestätigt.' : ok + ' von ' + legacy.length + ' übertragen: ' + window.JarvisCore.errorText(lastError));
  }

  async function sync() {
    if (syncing) return syncing;
    if (!apiBase() || !hasCredentials()) { renderStatus(); return; }
    syncing = (async () => {
      const res = await api('/api/memories');
      if (res.ok && Array.isArray(res.body?.memories)) {
        if (mode !== 'cloud') {
          // Erster Wechsel in den Cloud-Modus: vorhandene lokale Einträge nur nach Zustimmung hochladen.
          data.memories.forEach(m => { if (isLocalOnly(m)) m.legacyLocal = true; });
          setMode('cloud');
        }
        const unsynced = data.memories.filter(isLocalOnly);
        data.memories = [...unsynced, ...res.body.memories.map(fromServer)];
        lastSync = Date.now(); lastError = null;
        saveData();
      } else if (res.error === 'storage_not_configured') {
        lastError = res.error;
        if (mode === 'cloud') setMode('local');
      } else {
        lastError = res.error;
      }
    })();
    try { await syncing; } finally { syncing = null; }
    renderMemories();
    pushPending();
  }

  // „Alle löschen“ löscht im Cloud-Modus auch auf dem Server – mit ausdrücklicher Bestätigung.
  el('forgetAll').onclick = () => confirmAction('Gedächtnis löschen', mode === 'cloud'
    ? 'Alle Erinnerungen und Stilhinweise werden auf allen Geräten endgültig gelöscht (D1 und dieser Browser).'
    : 'Alle gespeicherten Erinnerungen und Stilhinweise werden aus diesem Browser entfernt.', async () => {
    if (mode === 'cloud') {
      const res = await api('/api/memories?all=confirm', { method: 'DELETE' });
      if (!res.ok) { toast('Nicht gelöscht: ' + window.JarvisCore.errorText(res.error)); return; }
    }
    data.memories = []; data.feedback = [];
    saveData(); renderMemories(); renderFeedback(); toast('Gedächtnis geleert.');
  });

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  addEventListener('online', () => sync());
  window.JarvisMemory = { sync, get mode() { return mode; } };
  renderMemories();
  setTimeout(sync, 900);
})();
