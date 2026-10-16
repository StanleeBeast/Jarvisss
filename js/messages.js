// JARVIS Nachrichten: ausgewählte Chats importieren (WhatsApp „Chat exportieren“ oder Text einfügen),
// auf dem Gerät pseudonymisieren, auswerten lassen. Aufgaben werden erst nach Tipp gespeichert,
// Antworten sind Entwürfe – JARVIS sendet nie selbst und hat keinen Zugriff auf WhatsApp.
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  const api = (path, options) => window.JarvisCore.api(path, options);
  const W = window.JarvisWhatsApp;
  const MAP_KEY = 'jarvis_message_maps_v1', OWN_KEY = 'jarvis_message_own_name_v1';
  const PRIO = { hoch: 'warn', mittel: 'info', niedrig: 'muted' };
  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* privater Modus */ } };
  const fmt = (iso) => iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '—';

  const section = document.createElement('section');
  section.id = 'view-messages';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = '<div id="msgHome" class="grid" style="margin-top:0">'
    + '<div class="panel"><h2>✉ CHAT AUSWERTEN</h2>'
    + '<p class="hint">JARVIS hat keinen Zugriff auf WhatsApp. Du wählst selbst aus, was er sehen darf: In WhatsApp den Chat öffnen → Name oben antippen → „Chat exportieren“ → „Ohne Medien“ → „In Dateien sichern“. Dann hier die Datei wählen (.zip oder .txt) oder einzelne Nachrichten einfügen.</p>'
    + '<label class="hint">Name des Chats<input id="msgLabel" maxlength="120" placeholder="z. B. Familie oder Jugendclub"></label>'
    + '<label class="hint">Export-Datei<input id="msgFile" type="file" accept=".txt,.zip,text/plain,application/zip"></label>'
    + '<label class="hint">… oder Nachrichten einfügen<textarea id="msgText" rows="4" placeholder="Lisa: Denk an den Jugendclub heute 18 Uhr!"></textarea></label>'
    + '<div class="inputrow"><label class="hint" style="flex:1">Zeitraum<select id="msgDays"><option value="1">Letzter Tag</option><option value="3">Letzte 3 Tage</option><option value="7" selected>Letzte 7 Tage</option><option value="30">Letzte 30 Tage</option><option value="0">Alles (max. 400)</option></select></label>'
    + '<label class="hint" style="flex:1">Dein Name im Chat<input id="msgOwn" maxlength="60" placeholder="wie er im Export steht"></label></div>'
    + '<label class="hint"><input id="msgPseudo" type="checkbox" checked style="width:auto;margin-right:8px">Namen anderer Personen vor dem Senden durch „Person A/B/…“ ersetzen (empfohlen)</label>'
    + '<button id="msgPreview" class="full">Vorschau</button>'
    + '<div id="msgPreviewBox" class="item" hidden></div>'
    + '<button id="msgAnalyze" class="primary full" hidden>Auswerten</button>'
    + '<div id="msgProgress" class="item" hidden><small></small></div></div>'
    + '<div class="panel"><h2>⚖ MEINE PRIORITÄTEN</h2><p class="hint">Woran JARVIS erkennt, was wichtig ist. Namen hier werden genauso pseudonymisiert wie im Chat. Die Regeln werden über deine Datenbank synchronisiert.</p>'
    + '<textarea id="msgRules" rows="4" placeholder="z. B. Nachrichten von Mama und vom Ausbildungsbetrieb sind immer wichtig. Die Fußballgruppe ist unwichtig, außer es geht um Termine."></textarea>'
    + '<button id="msgRulesSave" class="primary full" style="margin-top:8px">Regeln speichern</button></div>'
    + '<div class="panel"><h2>☰ AUSWERTUNGEN</h2><div id="msgList" class="list"></div><p class="hint">Gespeichert wird nur die Auswertung (mit Pseudonymen), nie der Originalchat. Echte Namen setzt nur dieses Gerät wieder ein.</p></div></div>'
    + '<div id="msgDetail" hidden></div>';
  document.querySelector('main')?.append(section);

  const info = (text) => { const d = document.createElement('div'); d.className = 'item'; d.append(Object.assign(document.createElement('small'), { textContent: text })); return d; };
  const show = (view) => { el('msgHome').hidden = view !== 'home'; el('msgDetail').hidden = view !== 'detail'; el('n1SettingsContent').scrollTop = 0; };
  const progress = (text) => { el('msgProgress').hidden = !text; el('msgProgress').firstChild.textContent = text || ''; };
  el('msgOwn').value = read(OWN_KEY, '') || '';
  el('msgOwn').addEventListener('change', () => write(OWN_KEY, el('msgOwn').value.trim()));

  let prepared = null;
  async function prepare() {
    const file = el('msgFile').files[0];
    let text = el('msgText').value;
    let source = 'paste';
    if (file) {
      if (file.size > 30 * 1024 * 1024) throw new Error('Die Datei ist größer als 30 MB. Bitte „Ohne Medien“ exportieren.');
      const buf = await file.arrayBuffer();
      const isZip = /\.zip$/i.test(file.name) || new Uint8Array(buf.slice(0, 2))[0] === 0x50;
      try { text = isZip ? await W.readZip(buf) : new TextDecoder().decode(buf); }
      catch (e) { throw new Error(e.message === 'zip_not_supported' ? 'Dieses Gerät kann die ZIP-Datei nicht entpacken. Öffne sie in der Dateien-App und wähle die .txt-Datei.' : 'Die Datei ist kein lesbarer WhatsApp-Export.'); }
      source = 'whatsapp_export';
    }
    if (!text || !text.trim()) throw new Error('Bitte eine Datei wählen oder Nachrichten einfügen.');
    const parsed = W.parseChat(text);
    const recent = W.filterRecent(parsed.messages, Number(el('msgDays').value), 400);
    if (!recent.length) throw new Error('Im gewählten Zeitraum gibt es keine Nachrichten.');
    const own = el('msgOwn').value.trim();
    write(OWN_KEY, own);
    const rules = el('msgRules').value.trim();
    const pseudo = el('msgPseudo').checked ? W.pseudonymize(recent, own, rules) : { messages: recent.map(m => ({ ...m, sender: own && m.sender.toLowerCase() === own.toLowerCase() ? 'Ich' : m.sender })), rules, mapping: null };
    const senders = [...new Set(recent.map(m => m.sender))];
    prepared = { source, label: el('msgLabel').value.trim() || (file ? file.name.replace(/\.(zip|txt)$/i, '') : 'Eingefügte Nachrichten'), messages: pseudo.messages, rules: pseudo.rules, mapping: pseudo.mapping, total: parsed.messages.length, skipped: parsed.skipped, senders, ownFound: senders.some(s => own && s.toLowerCase() === own.toLowerCase()) };
    return prepared;
  }

  el('msgPreview').addEventListener('click', async () => {
    const box = el('msgPreviewBox');
    try {
      const p = await prepare();
      const times = p.messages.map(m => m.at).filter(Boolean).sort();
      const lines = [
        p.messages.length + ' Nachrichten werden ausgewertet' + (p.total > p.messages.length ? ' (von ' + p.total + ' im Export)' : '') + (p.skipped ? ', ' + p.skipped + ' Medien-/Systemzeilen übersprungen' : '') + '.',
        times.length ? 'Zeitraum: ' + fmt(times[0]) + ' bis ' + fmt(times.at(-1)) + '.' : 'Ohne Zeitstempel.',
        p.mapping ? 'Pseudonyme: ' + Object.entries(p.mapping).map(([k, v]) => k + ' = ' + v).join(', ') + '. Telefonnummern und E-Mail-Adressen werden maskiert.' : 'Ohne Pseudonymisierung – echte Namen werden übertragen.',
        p.ownFound ? '„' + el('msgOwn').value.trim() + '“ wird als „Ich“ behandelt.' : 'Hinweis: Dein Name wurde im Chat nicht gefunden. Trage ihn so ein, wie er im Export steht, damit JARVIS weiß, welche Nachrichten von dir sind.',
        'Beim Auswerten werden diese Nachrichten an das KI-Modell (OpenAI) übertragen. Bitte nur Chats wählen, bei denen das für dich in Ordnung ist – sie enthalten auch Nachrichten anderer.'
      ];
      box.replaceChildren(...lines.map(t => Object.assign(document.createElement('small'), { textContent: t })));
      box.hidden = false;
      el('msgAnalyze').hidden = false;
    } catch (e) { box.hidden = false; box.replaceChildren(Object.assign(document.createElement('small'), { textContent: e.message })); el('msgAnalyze').hidden = true; }
  });

  el('msgAnalyze').addEventListener('click', async () => {
    if (!prepared) return;
    if (!apiBase() || !hasCredentials()) { toast('Zuerst das Backend verbinden.'); return; }
    el('msgAnalyze').disabled = true;
    progress('JARVIS liest ' + prepared.messages.length + ' Nachrichten …');
    const res = await api('/api/messages/analyze', { method: 'POST', timeout: 100000, body: { label: prepared.label, source: prepared.source, messages: prepared.messages, rules: prepared.rules, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
    el('msgAnalyze').disabled = false;
    if (!res.ok || !res.body?.saved) { progress('Nicht ausgewertet: ' + window.JarvisCore.errorText(res.error)); window.JarvisCore.flash('error'); return; }
    if (prepared.mapping) { const maps = read(MAP_KEY, {}); maps[res.body.import.id] = prepared.mapping; write(MAP_KEY, maps); }
    progress('');
    el('msgFile').value = ''; el('msgText').value = ''; el('msgPreviewBox').hidden = true; el('msgAnalyze').hidden = true;
    prepared = null;
    window.JarvisCore.flash('success');
    openImport(res.body.import);
  });

  el('msgRulesSave').addEventListener('click', async () => {
    const res = await api('/api/messages/settings', { method: 'PUT', body: { rules: el('msgRules').value } });
    toast(res.ok && res.body?.saved ? 'Prioritäten gespeichert.' : 'Nicht gespeichert: ' + window.JarvisCore.errorText(res.error));
  });

  async function load() {
    show('home');
    const list = el('msgList');
    if (!apiBase() || !hasCredentials()) { list.replaceChildren(info('Zuerst das Backend verbinden.')); return; }
    const [imports, settings] = await Promise.all([api('/api/messages/imports'), api('/api/messages/settings')]);
    if (settings.ok && !el('msgRules').value) el('msgRules').value = settings.body.rules || '';
    if (!imports.ok) { list.replaceChildren(info(imports.error === 'storage_not_configured' ? 'Der Nachrichten-Assistent benötigt die D1-Datenbank.' : window.JarvisCore.errorText(imports.error))); return; }
    if (!imports.body.imports.length) { list.replaceChildren(info('Noch keine Auswertungen.')); return; }
    const maps = read(MAP_KEY, {});
    list.replaceChildren(...imports.body.imports.map(i => {
      const row = document.createElement('div'); row.className = 'item task-row';
      const d = document.createElement('div'); d.className = 'details';
      d.append(Object.assign(document.createElement('strong'), { textContent: i.label }), Object.assign(document.createElement('small'), { textContent: 'Importiert ' + fmt(i.importedAt) + ' · ' + i.messageCount + ' Nachrichten · ' + (i.source === 'whatsapp_export' ? 'WhatsApp-Export' : 'eingefügt') }), Object.assign(document.createElement('small'), { textContent: W.restoreNames(i.summary, maps[i.id]) }));
      const open = Object.assign(document.createElement('button'), { type: 'button', className: 'primary', textContent: 'Öffnen' });
      open.onclick = async () => { const r = await api('/api/messages/imports/' + i.id); if (r.ok) openImport(r.body.import); else toast(window.JarvisCore.errorText(r.error)); };
      const actions = document.createElement('div'); actions.className = 'task-actions'; actions.append(open);
      row.append(d, actions);
      return row;
    }));
  }

  function openImport(imp) {
    const map = read(MAP_KEY, {})[imp.id];
    const real = (t) => W.restoreNames(t, map);
    const box = el('msgDetail');
    box.innerHTML = '<div class="grid" style="margin-top:0"><div class="panel"><div class="eyebrow">AUSWERTUNG · ' + (imp.source === 'whatsapp_export' ? 'WHATSAPP-EXPORT' : 'EINGEFÜGT') + '</div><h2 id="msgDetailTitle"></h2><small class="muted" id="msgDetailMeta"></small><p id="msgDetailSummary"></p><h3 class="study-h">Wichtig</h3><div id="msgImportant" class="list"></div><h3 class="study-h">Offene Fragen</h3><div id="msgQuestions" class="list"></div></div>'
      + '<div class="panel"><h2>☑ ERKANNTE AUFGABEN</h2><div id="msgTasks" class="list"></div><h2 style="margin-top:18px">✎ ANTWORTENTWÜRFE</h2><p class="hint">JARVIS sendet nichts. „In WhatsApp öffnen“ öffnet WhatsApp mit dem Text – du wählst den Chat und sendest selbst.</p><div id="msgDrafts" class="list"></div>'
      + '<div class="quick" style="margin-top:14px"><button id="msgBack">Zurück</button><button id="msgDelete">Auswertung löschen</button></div></div></div>';
    el('msgDetailTitle').textContent = imp.label;
    el('msgDetailMeta').textContent = 'Importiert ' + fmt(imp.importedAt) + ' · ' + imp.messageCount + ' Nachrichten · ' + fmt(imp.rangeFrom) + ' bis ' + fmt(imp.rangeTo) + (map ? ' · Namen auf diesem Gerät wieder eingesetzt' : '');
    el('msgDetailSummary').textContent = real(imp.summary);
    el('msgImportant').replaceChildren(...(imp.important.length ? imp.important.map(i => {
      const d = document.createElement('div'); d.className = 'item sys-row';
      d.append(Object.assign(document.createElement('strong'), { textContent: real(i.sender) + ': „' + real(i.excerpt) + '“' }), Object.assign(document.createElement('span'), { className: 'sys-badge', textContent: i.priority }), Object.assign(document.createElement('small'), { textContent: real(i.why) }));
      d.querySelector('.sys-badge').dataset.tone = PRIO[i.priority];
      return d;
    }) : [info('Nichts Dringendes gefunden.')]));
    el('msgQuestions').replaceChildren(...(imp.openQuestions.length ? imp.openQuestions.map(q => info(real(q))) : [info('Keine.')]));
    el('msgTasks').replaceChildren(...(imp.tasks.length ? imp.tasks.map(t => {
      const row = document.createElement('div'); row.className = 'item task-row';
      const d = document.createElement('div'); d.className = 'details';
      d.append(Object.assign(document.createElement('strong'), { textContent: real(t.title) }), Object.assign(document.createElement('small'), { textContent: [t.dueText ? 'fällig ' + t.dueText : 'ohne Termin', t.fromSender ? 'von ' + real(t.fromSender) : '', real(t.details)].filter(Boolean).join(' · ') }));
      const save = Object.assign(document.createElement('button'), { type: 'button', className: 'primary', textContent: 'Als Aufgabe speichern' });
      save.onclick = async () => {
        save.disabled = true;
        const body = { title: real(t.title).slice(0, 180), details: [real(t.details), 'Aus Chat „' + imp.label + '“'].filter(Boolean).join(' · ').slice(0, 2000) };
        if (t.dueAt) body.dueAt = t.dueAt;
        const r = await api('/api/tasks', { method: 'POST', body });
        if (r.ok && r.body?.saved) { save.textContent = '✓ Gespeichert'; window.JarvisCore.flash('success'); }
        else { save.disabled = false; toast('Nicht gespeichert: ' + window.JarvisCore.errorText(r.error)); }
      };
      const a = document.createElement('div'); a.className = 'task-actions'; a.append(save);
      row.append(d, a);
      return row;
    }) : [info('Keine Aufgaben erkannt.')]));
    el('msgDrafts').replaceChildren(...(imp.replyDrafts.length ? imp.replyDrafts.map(dr => {
      const row = document.createElement('div'); row.className = 'item';
      const text = real(dr.text);
      row.append(Object.assign(document.createElement('small'), { textContent: 'An ' + real(dr.to) + ' · ' + real(dr.context) }), Object.assign(document.createElement('div'), { className: 'msg-draft', textContent: text }));
      const copy = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Kopieren' });
      copy.onclick = async () => { try { await navigator.clipboard.writeText(text); toast('Entwurf kopiert.'); } catch { toast('Kopieren nicht möglich.'); } };
      const wa = Object.assign(document.createElement('button'), { type: 'button', textContent: 'In WhatsApp öffnen' });
      wa.onclick = () => window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
      const q = document.createElement('div'); q.className = 'quick'; q.append(copy, wa);
      row.append(q);
      return row;
    }) : [info('Keine Antwort nötig.')]));
    el('msgBack').onclick = load;
    el('msgDelete').onclick = () => confirmAction('Auswertung löschen', '„' + imp.label + '“ wird endgültig gelöscht. Dein WhatsApp-Chat bleibt unberührt.', async () => {
      const r = await api('/api/messages/imports/' + imp.id, { method: 'DELETE' });
      if (r.ok && r.body?.deleted) { const maps = read(MAP_KEY, {}); delete maps[imp.id]; write(MAP_KEY, maps); toast('Auswertung gelöscht.'); load(); }
      else toast('Nicht gelöscht: ' + window.JarvisCore.errorText(r.error));
    });
    show('detail');
  }

  window.JarvisMessages = { load };
})();
