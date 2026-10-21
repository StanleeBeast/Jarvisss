// JARVIS verbessert sich selbst: Wünsche, an denen gebaut wird, fertige Änderungen zum Freigeben.
// Live geht nur, was du hier ausdrücklich freigibst. Geschützte Bereiche (Anmeldung, Sicherheit, Kostengrenze) sind tabu.
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  const api = (path, options) => window.JarvisCore.api(path, options);
  const STATE = { working: ['◌', 'Wird gebaut …', 'Claude Code arbeitet daran. Das dauert meist 5–20 Minuten.'], ready: ['●', 'Bereit zur Freigabe', 'Prüfe die Beschreibung (oder die Änderung auf GitHub) und gib sie frei.'], live: ['✓', 'Live', 'Ist übernommen. App ganz schließen und neu öffnen, um sie zu sehen.'], rejected: ['✕', 'Abgelehnt', ''], closed: ['✕', 'Geschlossen', 'Es wurde keine Änderung erstellt (z. B. Fehler beim Bauen).'] };
  const section = document.createElement('section');
  section.id = 'view-improve';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = '<div class="auto-head"><div><h3 class="auto-title">JARVIS verbessert sich</h3><p class="hint">Sag JARVIS einfach, was er an sich ändern soll („Mach die Schrift größer“, „Bau mir einen Timer“). Er formuliert den Auftrag, du bestätigst, eine Code-KI baut die Änderung – und erst dein „Freigeben“ bringt sie live.</p><p class="hint" id="impUsage"></p></div><button type="button" id="impReload" aria-label="Neu laden">↻</button></div>'
    + '<div id="impList" class="auto-feed"></div>'
    + '<details class="panel" id="impSetup"><summary>Einrichten (einmalig)</summary><ol class="ctx-steps">'
    + '<li><b>Anthropic-Schlüssel:</b> console.anthropic.com → API Keys → „Create Key“. Unter <b>Limits</b> ein Monatslimit setzen (z. B. 5 $). Kosten: ca. 0,50–2 $ pro Änderung.</li>'
    + '<li><b>GitHub-Token:</b> github.com → Settings → Developer settings → <b>Fine-grained tokens</b> → „Generate new token“. Repository: nur <b>Jarvisss</b>. Rechte: <b>Issues</b>, <b>Pull requests</b>, <b>Contents</b>, <b>Actions</b> jeweils „Read and write“, <b>Checks</b> „Read“.</li>'
    + '<li>Im Repository → Settings → Secrets and variables → Actions zwei Secrets anlegen: <code>ANTHROPIC_API_KEY</code> und <code>GITHUB_TOKEN_JARVIS</code>. Schlüssel nie in den Chat schreiben.</li>'
    + '<li>Im Repository → Settings → Actions → General: „Allow GitHub Actions to create and approve pull requests“ einschalten.</li>'
    + '<li>Deploy-Workflow einmal neu starten (oder mir „Weiter“ sagen). Danach steht hier „eingerichtet“.</li></ol></details>';
  document.querySelector('main')?.append(section);

  function card(x) {
    const c = document.createElement('article');
    c.className = 'auto-entry imp-entry';
    c.dataset.kind = x.state === 'ready' ? 'day_prep' : x.state === 'live' ? 'live' : 'overdue';
    const [icon, label, hint] = STATE[x.state] || STATE.working;
    const top = document.createElement('div'); top.className = 'auto-top';
    top.append(Object.assign(document.createElement('span'), { className: 'auto-icon', textContent: icon }), Object.assign(document.createElement('span'), { className: 'auto-label', textContent: label }), Object.assign(document.createElement('span'), { className: 'auto-time', textContent: new Date(x.createdAt).toLocaleDateString('de-DE') }));
    c.append(top, Object.assign(document.createElement('h4'), { textContent: x.title.replace(/^JARVIS-Wunsch:\s*/, '') }));
    if (x.pr?.body) c.append(Object.assign(document.createElement('p'), { textContent: x.pr.body.replace(/Closes #\d+/gi, '').trim().slice(0, 600) }));
    if (hint) c.append(Object.assign(document.createElement('small'), { className: 'hint', textContent: hint }));
    const actions = document.createElement('div'); actions.className = 'auto-actions';
    const link = Object.assign(document.createElement('a'), { href: x.pr?.url || x.issueUrl, target: '_blank', rel: 'noopener', textContent: x.pr ? 'Änderung ansehen ↗' : 'Auftrag ansehen ↗', className: 'imp-link' });
    actions.append(link);
    if (x.state === 'ready') {
      const ok = Object.assign(document.createElement('button'), { type: 'button', className: 'primary', textContent: 'Freigeben' });
      const no = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Ablehnen' });
      const st = Object.assign(document.createElement('small'), { className: 'mail-send-state' });
      ok.onclick = () => confirmAction('Änderung freigeben?', '„' + x.title.replace(/^JARVIS-Wunsch:\s*/, '') + '“ wird übernommen und geht live. Geprüft wird vorher automatisch: Tests grün, keine geschützten Dateien.', async () => {
        st.textContent = 'Wird geprüft und übernommen …';
        const res = await api('/api/improvements/' + x.pr.number + '/merge', { method: 'POST', body: { confirm: true } });
        const MSG = { protected_files_changed: 'Abgelehnt: Die Änderung betrifft geschützte Bereiche (' + (res.body?.files || []).join(', ') + ').', checks_failed: 'Noch nicht: Die automatischen Tests sind rot.', checks_running: 'Die Tests laufen noch – in ein paar Minuten erneut versuchen.', not_mergeable: 'Kann nicht übernommen werden (Konflikt).' };
        st.textContent = res.ok && res.body?.merged ? '✓ Übernommen. Website aktualisiert sich in 1–3 Minuten' + (res.body.workerDeployStarted ? ', Backend wird neu ausgerollt.' : '.') : (MSG[res.body?.error] || 'Fehler: ' + window.JarvisCore.errorText(res.error || res.body?.error));
        if (res.ok) setTimeout(load, 2500);
      });
      no.onclick = () => confirmAction('Änderung ablehnen?', 'Die Änderung wird verworfen. Es geht nichts live.', async () => { await api('/api/improvements/' + x.pr.number + '/close', { method: 'POST', body: { confirm: true } }); load(); });
      actions.append(ok, no);
      c.append(actions, st);
    } else c.append(actions);
    return c;
  }
  async function load() {
    const list = el('impList');
    if (typeof apiBase !== 'function' || !apiBase() || !hasCredentials()) { list.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Zuerst das Backend unter „Stimme & KI“ verbinden.' })); return; }
    const res = await api('/api/improvements');
    if (!res.ok) {
      const off = res.body?.error === 'improvements_not_configured' || res.error === 'improvements_not_configured';
      el('impSetup').open = off;
      list.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: off ? 'Noch nicht eingerichtet – siehe „Einrichten“ unten.' : res.error === 'not_found' ? 'Der deployte Worker ist älter als diese Seite.' : window.JarvisCore.errorText(res.body?.error || res.error) }));
      return;
    }
    el('impUsage').textContent = 'Diesen Monat: ' + res.body.usedThisMonth + ' von ' + res.body.maxPerMonth + ' Verbesserungen.';
    const items = res.body.improvements || [];
    list.replaceChildren(...(items.length ? items.map(card) : [Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Noch keine Wünsche. Sag JARVIS zum Beispiel: „Ich will, dass du …“' })]));
  }
  el('impReload').onclick = load;
  window.JarvisImprove = { load };
})();
