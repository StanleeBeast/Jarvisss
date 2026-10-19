// JARVIS ↔ iPhone/iPad: Apple-Kurzbefehle (Automationen) melden Ort, Fokus, Akku, Schritte usw.
// Der Kurzbefehl-Schlüssel darf nur Kontext senden – nichts lesen, nichts ändern. Er wird genau einmal angezeigt.
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  const api = (path, options) => window.JarvisCore.api(path, options);
  const RECIPES = [
    { title: 'Zu Hause angekommen / losgegangen', trigger: 'Automation → „Ankommen“ (bzw. „Verlassen“) → Ort: dein Zuhause → „Sofort ausführen“', body: '{"type":"location","value":"zuhause"}', alt: 'Beim Verlassen: "value":"unterwegs". Genauso für Schule oder Arbeit.' },
    { title: 'Fokus (z. B. Schlafen)', trigger: 'Automation → „Fokus“ → Schlafen → „Wenn aktiviert“ → „Sofort ausführen“', body: '{"type":"focus","value":"Schlafen an"}', alt: 'Zweite Automation „Wenn deaktiviert“ mit "Schlafen aus".' },
    { title: 'Akku niedrig', trigger: 'Automation → „Batteriestand“ → „Fällt unter 20 %“ → „Sofort ausführen“', body: '{"type":"battery","value":"20"}', alt: 'Für den genauen Wert vorher die Aktion „Batteriestand abrufen“ einfügen und die Variable statt 20 einsetzen.' },
    { title: 'Schritte am Abend', trigger: 'Automation → „Tageszeit“ → 21:00 → täglich → „Sofort ausführen“. Aktionen: „Health-Stichproben suchen“ (Schritte, heute) → „Statistik berechnen“ (Summe)', body: '{"type":"steps","value":"[Summe]"}', alt: 'Statt [Summe] die Variable aus „Statistik berechnen“ einsetzen.' }
  ];
  const section = document.createElement('section');
  section.id = 'view-context';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = '<div class="grid" style="margin-top:0">'
    + '<div class="panel"><h2>📱 WAS JARVIS GERADE WEISS</h2><div id="ctxList" class="list"></div><p class="hint">Kommt aus deinen Apple-Kurzbefehlen. JARVIS nutzt es, um passender zu reagieren (z. B. leiser, wenn „Schlafen“ an ist). Nichts wird an Dritte weitergegeben.</p><button type="button" id="ctxClear">Alles vergessen</button></div>'
    + '<div class="panel"><h2>🔑 KURZBEFEHL-SCHLÜSSEL</h2><p class="hint">Dieser Schlüssel darf <b>nur</b> Informationen an JARVIS schicken – er kann nichts lesen und nichts ändern. Er wird genau einmal angezeigt. Ein neuer Schlüssel macht den alten ungültig.</p>'
    + '<p class="hint" id="ctxKeyState"></p><div class="ctx-key" id="ctxKeyBox" hidden><code id="ctxKey"></code><button type="button" id="ctxKeyCopy">Kopieren</button></div>'
    + '<div class="inputrow"><button type="button" class="primary" id="ctxKeyNew">Schlüssel erzeugen</button><button type="button" id="ctxKeyRevoke">Widerrufen</button></div></div>'
    + '<div class="panel ctx-guide"><h2>⚙ SO RICHTEST DU ES EIN</h2><ol class="ctx-steps"><li>Öffne die App <b>Kurzbefehle</b> → unten <b>Automation</b> → <b>+</b> (bzw. „Neue Automation“).</li><li>Wähle den Auslöser (siehe unten) und <b>„Sofort ausführen“</b>.</li><li>Aktion hinzufügen: <b>„Inhalte von URL abrufen“</b>. Tippe auf den Pfeil und stelle ein:<ul><li>URL: <code id="ctxUrl"></code> <button type="button" id="ctxUrlCopy">Kopieren</button></li><li>Methode: <b>POST</b></li><li>Header: <b>Authorization</b> = <code>Bearer DEIN-SCHLÜSSEL</code></li><li>Anfragetext: <b>JSON</b>, Felder wie unten</li></ul></li><li>Fertig. Ab jetzt meldet dein iPhone/iPad das automatisch.</li></ol>'
    + '<div id="ctxRecipes"></div></div>'
    + '<div class="panel ctx-guide" id="alexaPanel"><h2>🔊 ALEXA</h2><p class="hint">Danach geht: <b>„Alexa, frag mein Jarvis, was heute ansteht.“</b> Ein eigener Skill nur für dein Amazon-Konto – keine Prüfung durch Amazon nötig. Antworten dauern höchstens ein paar Sekunden; braucht JARVIS länger, kommt die Antwort als Push aufs Handy. Vorschläge bestätigst du in der App.</p>'
    + '<p class="hint" id="alexaState"></p><ol class="ctx-steps">'
    + '<li>Öffne <b>developer.amazon.com/alexa/console/ask</b> und melde dich mit <b>demselben Amazon-Konto</b> an wie deine Alexa (kostenloses Entwicklerkonto).</li>'
    + '<li><b>„Skill erstellen“</b>: Name „Mein Jarvis“, Sprache <b>Deutsch</b>, Typ <b>Benutzerdefiniert</b>, Hosting <b>„Eigene bereitstellen“</b> (Provision your own), Vorlage „Von vorne beginnen“.</li>'
    + '<li>Links <b>Interaktionsmodell → JSON-Editor</b>: alles ersetzen durch dieses Modell <button type="button" id="alexaModelCopy">Modell kopieren</button> → „Modell speichern“ → „Modell erstellen“.</li>'
    + '<li>Oben die <b>Skill-ID</b> kopieren (beginnt mit amzn1.ask.skill…) und hier einfügen:<div class="ctx-key"><input id="alexaSkill" placeholder="amzn1.ask.skill.…" autocomplete="off"><button type="button" class="primary" id="alexaSetup">Endpunkt erzeugen</button></div></li>'
    + '<li>Links <b>Endpunkt → HTTPS</b>, Standard-Region: diese Adresse eintragen <div class="ctx-key" id="alexaEpBox" hidden><code id="alexaEp"></code><button type="button" id="alexaEpCopy">Kopieren</button></div> SSL-Zertifikat: <b>„Mein Endpunkt ist eine Subdomain einer Domain mit Wildcard-Zertifikat“</b> → Speichern.</li>'
    + '<li>Oben <b>Testen</b> → „Entwicklung“ einschalten. Fertig – der Skill ist auf deinen Echo-Geräten und in der Alexa-App verfügbar.</li></ol>'
    + '<button type="button" id="alexaRemove">Alexa trennen</button></div></div>';
  document.querySelector('main')?.append(section);

  const origin = () => { try { return new URL(apiBase()).origin; } catch { return ''; } };
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast('Kopiert.'); } catch { toast('Kopieren nicht möglich – bitte abschreiben.'); } };
  el('ctxRecipes').replaceChildren(...RECIPES.map(r => {
    const d = document.createElement('div');
    d.className = 'ctx-recipe';
    d.innerHTML = '<b></b><small></small><div class="ctx-key"><code></code><button type="button">JSON kopieren</button></div><small class="hint"></small>';
    d.querySelector('b').textContent = r.title;
    d.querySelector('small').textContent = 'Auslöser: ' + r.trigger;
    d.querySelector('code').textContent = r.body;
    d.querySelector('button').onclick = () => copy(r.body);
    d.querySelector('.hint').textContent = r.alt;
    return d;
  }));
  el('ctxUrlCopy').onclick = () => copy(origin() + '/api/context');
  el('ctxKeyCopy').onclick = () => copy(el('ctxKey').textContent);
  const fmtAge = (m) => m < 2 ? 'gerade eben' : m < 60 ? 'vor ' + m + ' Min.' : m < 48 * 60 ? 'vor ' + Math.round(m / 60) + ' Std.' : 'vor ' + Math.round(m / 1440) + ' Tagen';
  let load = async function () {
    el('ctxUrl').textContent = (origin() || 'https://DEIN-WORKER.workers.dev') + '/api/context';
    if (typeof apiBase !== 'function' || !apiBase() || !hasCredentials()) { el('ctxList').replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Zuerst das Backend unter „Stimme & KI“ verbinden.' })); return; }
    const res = await api('/api/context');
    if (!res.ok) { el('ctxList').replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: res.error === 'not_found' ? 'Der deployte Worker ist älter als diese Seite.' : window.JarvisCore.errorText(res.error || res.body?.error) })); return; }
    const items = res.body.items || [];
    el('ctxList').replaceChildren(...(items.length ? items.map(i => { const d = document.createElement('div'); d.className = 'item'; d.append(Object.assign(document.createElement('strong'), { textContent: i.label + ': ' + (typeof i.value === 'boolean' ? (i.value ? 'ja' : 'nein') : i.value) + (i.type === 'battery' ? ' %' : '') }), Object.assign(document.createElement('small'), { textContent: fmtAge(i.minutesAgo) + (i.device ? ' · ' + i.device : '') })); return d; }) : [Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Noch nichts gemeldet.' })]));
    el('ctxKeyState').textContent = res.body.keyCreatedAt ? 'Ein Schlüssel ist aktiv (erzeugt ' + new Date(res.body.keyCreatedAt).toLocaleString('de-DE') + ').' : 'Noch kein Schlüssel erzeugt.';
  };
  el('ctxKeyNew').onclick = () => confirmAction('Neuen Kurzbefehl-Schlüssel erzeugen?', 'Ein vorhandener Schlüssel wird ungültig – du musst ihn dann in deinen Kurzbefehlen ersetzen.', async () => {
    const res = await api('/api/context/key', { method: 'POST', body: {} });
    if (!res.ok) { toast('Nicht erzeugt: ' + window.JarvisCore.errorText(res.error || res.body?.error)); return; }
    el('ctxKey').textContent = res.body.key; el('ctxKeyBox').hidden = false;
    el('ctxKeyState').textContent = 'Neuer Schlüssel – nur jetzt sichtbar. Kopiere ihn in deine Kurzbefehle (Header „Authorization“: Bearer + Schlüssel). Nicht weitergeben.';
  });
  el('ctxKeyRevoke').onclick = () => confirmAction('Schlüssel widerrufen?', 'Deine Kurzbefehle können JARVIS dann nichts mehr melden, bis du einen neuen Schlüssel einträgst.', async () => {
    const res = await api('/api/context/key', { method: 'DELETE' });
    toast(res.ok ? 'Schlüssel widerrufen.' : 'Fehler: ' + window.JarvisCore.errorText(res.error));
    el('ctxKeyBox').hidden = true; load();
  });
  el('ctxClear').onclick = () => confirmAction('Alles vergessen?', 'JARVIS löscht, was die Kurzbefehle zuletzt gemeldet haben. Neue Meldungen kommen danach wieder an.', async () => { await api('/api/context', { method: 'DELETE' }); load(); });
  el('alexaModelCopy').onclick = async () => { try { const t = await (await fetch('assets/alexa/interaction-model-de.json')).text(); await copy(t); } catch { toast('Modell konnte nicht geladen werden.'); } };
  el('alexaEpCopy').onclick = () => copy(el('alexaEp').textContent);
  el('alexaSetup').onclick = async () => {
    const res = await api('/api/alexa/setup', { method: 'POST', body: { skillId: el('alexaSkill').value.trim() } });
    if (!res.ok) { toast(res.body?.error === 'invalid_skill_id' ? 'Das ist keine gültige Skill-ID (amzn1.ask.skill.…).' : 'Fehler: ' + window.JarvisCore.errorText(res.error || res.body?.error)); return; }
    el('alexaEp').textContent = res.body.endpoint; el('alexaEpBox').hidden = false;
    el('alexaState').textContent = 'Endpunkt erzeugt – nur jetzt sichtbar. Trage ihn im Alexa-Skill ein (Schritt 5). Ein neuer Endpunkt macht den alten ungültig.';
  };
  el('alexaRemove').onclick = () => confirmAction('Alexa trennen?', 'Der Alexa-Skill kann JARVIS danach nicht mehr erreichen.', async () => { await api('/api/alexa/setup', { method: 'DELETE' }); el('alexaEpBox').hidden = true; loadAlexa(); });
  async function loadAlexa() {
    const res = await api('/api/alexa/setup');
    el('alexaState').textContent = res.ok && res.body.keyCreatedAt ? 'Verbunden mit Skill ' + res.body.skillId + ' (eingerichtet ' + new Date(res.body.keyCreatedAt).toLocaleDateString('de-DE') + ').' : 'Noch nicht eingerichtet.';
    if (res.ok && res.body.skillId) el('alexaSkill').value = res.body.skillId;
  }
  const baseLoad = load;
  load = async () => { await baseLoad(); if (typeof apiBase === 'function' && apiBase() && hasCredentials()) loadAlexa(); };
  window.JarvisContext = { load: () => load() };
})();
