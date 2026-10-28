// JARVIS Website-Studio: Website-Entwürfe ansehen (Handy/Computer), ändern lassen, Angaben fürs Impressum ergänzen,
// herunterladen und – nur nach ausdrücklicher Bestätigung – auf Cloudflare Pages veröffentlichen.
// Die Vorschau läuft in einem abgeschotteten iframe (sandbox ohne same-origin), Links darin schalten nur die Seite um.
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  const api = (path, options) => window.JarvisCore.api(path, options);
  const errorText = (code) => window.JarvisCore?.errorText(code) || code;
  const STATUS = { draft: 'Entwurf', publishing: 'Wird veröffentlicht …', live: 'Online', failed: 'Veröffentlichen fehlgeschlagen' };
  const PAGES = [['index.html', 'Start'], ['impressum.html', 'Impressum'], ['datenschutz.html', 'Datenschutz']];
  const FIELDS = [['owner', 'Inhaber/in (Vor- und Nachname)'], ['street', 'Straße und Hausnummer'], ['zip_city', 'PLZ und Ort'], ['phone', 'Telefon'], ['email', 'E-Mail']];
  const SLOW = 200000; // KI baut 1–2 Minuten

  const section = document.createElement('section');
  section.id = 'view-sites';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = '<div class="auto-head"><div><h3 class="auto-title">Website-Studio</h3><p class="hint">Sag JARVIS z. B. „Bau eine Website für Friseur Schmidt in Kamenz“ – oder nutze das Formular. Du siehst den Entwurf hier, lässt ihn ändern und veröffentlichst ihn erst, wenn er passt.</p></div><button type="button" id="siteReload" aria-label="Neu laden">↻</button></div>'
    + '<div id="siteList" class="site-list"></div>'
    + '<div id="siteDetail" class="site-detail" hidden></div>'
    + '<details class="panel" id="siteNew"><summary>Neue Website</summary><div class="site-form">'
    + '<label class="hint">Name der Firma<input id="siteName" maxlength="80" placeholder="Friseur Schmidt"></label>'
    + '<label class="hint">Branche<input id="siteKind" maxlength="80" placeholder="Friseur"></label>'
    + '<label class="hint">Ort<input id="siteCity" maxlength="80" placeholder="Kamenz"></label>'
    + '<label class="hint">Was soll drauf? (Leistungen, Besonderheiten, Ton)<textarea id="siteDesc" rows="4" maxlength="2000" placeholder="Damen- und Herrenschnitte, Färben, Termine nach Absprache, freundlich und modern"></textarea></label>'
    + '<label class="hint">Stil / Farben (optional)<input id="siteStyle" maxlength="300" placeholder="warm, Terrakotta, elegant"></label>'
    + '<button type="button" class="primary full" id="siteCreate">Entwurf bauen (ca. 1–2 Min., ein paar Cent)</button><p class="hint" id="siteCreateState"></p></div></details>'
    + '<details class="panel"><summary>Eigene Domain (z. B. friseur-schmidt.de) verbinden</summary><ol class="ctx-steps">'
    + '<li>Die Domain bucht am besten <b>der Kunde selbst</b> (ca. 5–15 € pro Jahr, z. B. bei Cloudflare, IONOS oder Strato). So gehört sie ihm.</li>'
    + '<li>Website hier veröffentlichen. Sie ist danach unter <code>jarvis-….pages.dev</code> erreichbar.</li>'
    + '<li>dash.cloudflare.com → <b>Workers & Pages</b> → das Projekt <code>jarvis-…</code> → <b>Custom domains</b> → <b>Set up a custom domain</b> → Domain eintragen.</li>'
    + '<li>Cloudflare zeigt an, welchen DNS-Eintrag (CNAME) der Kunde bei seinem Anbieter setzen muss – oder macht es selbst, wenn die Domain bei Cloudflare liegt. Das HTTPS-Zertifikat kommt automatisch.</li></ol>'
    + '<p class="hint">Einmalig nötig: Der Cloudflare-Schlüssel in GitHub (<code>CLOUDFLARE_API_TOKEN</code>) braucht zusätzlich das Recht <b>Cloudflare Pages: Edit</b>.</p></details>';
  document.querySelector('main')?.append(section);

  let sites = [], current = null, page = 'index.html', width = 'phone', canPublish = false;

  const btn = (text, cls, onclick, data) => { const b = Object.assign(document.createElement('button'), { type: 'button', className: cls || '', textContent: text, onclick }); Object.assign(b.dataset, data || {}); return b; };
  function state(text) { const s = el('siteState'); if (s) s.textContent = text || ''; }

  function renderList() {
    const box = el('siteList');
    if (!sites.length) { box.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Noch keine Website. Frag JARVIS oder öffne „Neue Website“.' })); return; }
    box.replaceChildren(...sites.map(s => {
      const b = btn('', 'site-chip' + (current?.id === s.id ? ' is-active' : ''), () => open(s.id));
      b.append(Object.assign(document.createElement('b'), { textContent: s.name }), Object.assign(document.createElement('small'), { textContent: (STATUS[s.status] || s.status) + ' · Version ' + s.version }));
      b.dataset.status = s.status;
      return b;
    }));
  }

  // Seite in die Vorschau: Links zu den eigenen Seiten schalten um, alles andere bleibt in der Vorschau wirkungslos.
  function previewHtml(html) {
    const hook = '<script>document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a");if(!a)return;var h=a.getAttribute("href")||"";if(h.charAt(0)==="#")return;e.preventDefault();parent.postMessage({jarvisSite:h},"*")},true)<\/script>';
    return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, hook + '</body>') : html + hook;
  }
  function renderPreview() {
    const frame = el('siteFrame');
    if (!frame || !current) return;
    frame.srcdoc = previewHtml(current.files[page] || '');
    el('siteFrameWrap').dataset.width = width;
    section.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('is-active', b.dataset.page === page));
    section.querySelectorAll('[data-width]').forEach(b => b.classList.toggle('is-active', b.dataset.width === width));
  }
  window.addEventListener('message', (e) => {
    const frame = el('siteFrame');
    if (!frame || e.source !== frame.contentWindow || typeof e.data?.jarvisSite !== 'string') return;
    const h = e.data.jarvisSite.split('#')[0];
    if (PAGES.some(([p]) => p === h)) { page = h; renderPreview(); }
    else toast('In der Vorschau nicht geöffnet: ' + h.slice(0, 80));
  });

  function renderDetail() {
    const d = el('siteDetail');
    if (!current) { d.hidden = true; return; }
    d.hidden = false;
    const w = current;
    d.innerHTML = '<div class="site-head"><div><h4></h4><small class="hint" id="siteMeta"></small></div></div>'
      + '<div class="site-toolbar"><div class="site-seg" id="sitePages"></div><div class="site-seg" id="siteWidths"></div></div>'
      + '<div class="site-frame-wrap" id="siteFrameWrap"><iframe id="siteFrame" title="Vorschau" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe></div>'
      + '<p class="hint" id="siteState" role="status"></p>'
      + '<div class="site-change"><textarea id="siteChange" rows="2" maxlength="2000" placeholder="Was soll anders werden? z. B. „Farben blauer, Öffnungszeiten weiter nach oben“"></textarea></div>'
      + '<div class="auto-actions" id="siteActions"></div>'
      + '<details class="panel" id="siteLegal"><summary>Angaben fürs Impressum</summary><div class="site-form" id="siteLegalForm"></div></details>';
    d.querySelector('h4').textContent = w.name;
    el('siteMeta').textContent = (STATUS[w.status] || w.status) + ' · Version ' + w.version + (w.url ? ' · ' + w.url : '');
    el('sitePages').append(...PAGES.map(([p, label]) => btn(label, '', () => { page = p; renderPreview(); }, { page: p })));
    el('siteWidths').append(btn('📱 Handy', '', () => { width = 'phone'; renderPreview(); }, { width: 'phone' }), btn('🖥 Computer', '', () => { width = 'desktop'; renderPreview(); }, { width: 'desktop' }));
    const actions = el('siteActions');
    actions.append(btn('Ändern lassen', 'primary', revise));
    if (w.canUndo) actions.append(btn('Rückgängig', '', undo));
    actions.append(btn('Herunterladen', '', download));
    actions.append(btn(w.status === 'draft' || w.status === 'failed' || w.publishedVersion !== w.version ? 'Veröffentlichen' : 'Erneut veröffentlichen', '', publish));
    if (w.status === 'publishing' || w.status === 'live' || w.status === 'failed') actions.append(btn('Status prüfen', '', checkStatus));
    if (w.url && w.status === 'live') actions.append(Object.assign(document.createElement('a'), { href: w.url, target: '_blank', rel: 'noopener', className: 'imp-link', textContent: 'Live ansehen ↗' }));
    actions.append(btn('Löschen', 'danger', remove));
    const form = el('siteLegalForm');
    form.append(...FIELDS.map(([f, label]) => { const l = Object.assign(document.createElement('label'), { className: 'hint', textContent: label }); const i = Object.assign(document.createElement('input'), { value: w.brief?.contact?.[f] || '', maxLength: 200 }); i.dataset.f = f; l.append(i); return l; }));
    form.append(btn('Speichern (kostenlos)', 'primary full', saveLegal), Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Impressum und Datenschutz sind Vorlagen – der Kunde muss sie prüfen. Das ist keine Rechtsberatung.' }));
    if (w.missing?.length) { el('siteLegal').open = true; state('Fürs Impressum fehlen noch: ' + w.missing.map(f => FIELDS.find(x => x[0] === f)?.[1] || f).join(', ') + '.'); }
    renderPreview();
  }

  async function load(selectId) {
    const list = el('siteList');
    if (typeof apiBase !== 'function' || !apiBase() || !hasCredentials()) { list.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Zuerst das Backend unter „Stimme & KI“ verbinden.' })); return; }
    const res = await api('/api/websites');
    if (!res.ok) { list.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: res.error === 'not_found' ? 'Der deployte Worker ist älter als diese Seite. Deploy-Workflow erneut ausführen.' : errorText(res.error || res.body?.error) })); return; }
    sites = res.body.websites || []; canPublish = Boolean(res.body.canPublish);
    const id = selectId || current?.id || sites[0]?.id;
    renderList();
    if (id) await open(id, true); else { current = null; renderDetail(); }
  }
  async function open(id, quiet) {
    const res = await api('/api/websites/' + encodeURIComponent(id));
    if (!res.ok) { if (!quiet) toast(errorText(res.error || res.body?.error)); return; }
    if (current?.id !== id) page = 'index.html';
    current = res.body.website;
    renderList(); renderDetail();
  }
  async function busy(label, fn) {
    section.querySelectorAll('#siteActions button, #siteCreate').forEach(b => { b.disabled = true; });
    state(label);
    try { return await fn(); } finally { section.querySelectorAll('#siteActions button, #siteCreate').forEach(b => { b.disabled = false; }); }
  }
  async function revise() {
    const text = el('siteChange').value.trim();
    if (text.length < 3) { state('Schreib kurz, was anders werden soll.'); return; }
    const res = await busy('JARVIS ändert die Website … (ca. 1–2 Minuten)', () => api('/api/websites/' + current.id + '/revise', { method: 'POST', body: { instructions: text }, timeout: SLOW }));
    if (!res.ok) { state('Nicht geändert: ' + errorText(res.error || res.body?.error)); return; }
    await load(current.id); state('Geändert – vom Backend bestätigt (Version ' + current.version + ').');
  }
  async function undo() {
    const res = await busy('Stelle die vorige Version wieder her …', () => api('/api/websites/' + current.id + '/undo', { method: 'POST', body: {} }));
    if (!res.ok) { state(errorText(res.error || res.body?.error)); return; }
    await load(current.id); state('Vorige Version wiederhergestellt.');
  }
  async function saveLegal() {
    const contact = {};
    section.querySelectorAll('#siteLegalForm input').forEach(i => { contact[i.dataset.f] = i.value.trim(); });
    const res = await api('/api/websites/' + current.id + '/business', { method: 'PUT', body: { contact } });
    if (!res.ok) { state('Nicht gespeichert: ' + errorText(res.error || res.body?.error)); return; }
    await load(current.id);
    state(res.body.missing?.length ? 'Gespeichert. Es fehlt noch: ' + res.body.missing.map(f => FIELDS.find(x => x[0] === f)?.[1] || f).join(', ') + '.' : 'Gespeichert – Impressum und Datenschutz sind vollständig ausgefüllt.');
  }
  function download() {
    for (const [p] of PAGES) {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([current.files[p]], { type: 'text/html' })), download: current.slug + '-' + p });
      document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
    state('Drei Dateien heruntergeladen (Start, Impressum, Datenschutz).');
  }
  function publish() {
    if (!canPublish) { state('Veröffentlichen ist noch nicht eingerichtet (GitHub-Secret JARVIS_GITHUB_TOKEN fehlt).'); return; }
    const missing = current.missing || [];
    const warn = missing.length ? ' ACHTUNG: Im Impressum fehlen noch Angaben (' + missing.length + ') – sie stehen dann als gelbe Platzhalter online. Besser vorher ausfüllen.' : '';
    confirmAction('Website veröffentlichen?', '„' + current.name + '“ (Version ' + current.version + ') geht öffentlich ins Internet unter jarvis-' + current.slug + '.pages.dev. Jeder kann sie dann aufrufen.' + warn, async () => {
      const res = await busy('Wird veröffentlicht …', () => api('/api/websites/' + current.id + '/publish', { method: 'POST', body: { confirm: true, allowPlaceholders: true }, timeout: 60000 }));
      if (!res.ok) { state('Nicht veröffentlicht: ' + errorText(res.error || res.body?.error)); return; }
      await load(current.id);
      state('Gestartet. In 1–2 Minuten ist sie unter ' + res.body.url + ' online – dann „Status prüfen“.');
    });
  }
  async function checkStatus() {
    const res = await api('/api/websites/' + current.id + '/publish-status', { timeout: 20000 });
    if (!res.ok) { state(errorText(res.error || res.body?.error)); return; }
    const s = res.body.state;
    if (s === 'live') { await load(current.id); state('Online unter ' + res.body.url + ' – von GitHub bestätigt.'); }
    else if (s === 'running') state('Läuft noch … in einer Minute nochmal prüfen.');
    else if (s === 'failed') state('Fehlgeschlagen. Häufigster Grund: Dem Cloudflare-Schlüssel fehlt das Recht „Cloudflare Pages: Edit“ (siehe unten).' + (res.body.runUrl ? ' Details: ' + res.body.runUrl : ''));
    else state('Noch kein Veröffentlichungslauf gefunden.');
  }
  function remove() {
    confirmAction('Entwurf löschen?', '„' + current.name + '“ wird aus JARVIS gelöscht.' + (current.url ? ' Die veröffentlichte Seite bleibt online, bis du das Projekt bei Cloudflare löschst.' : ''), async () => {
      const res = await api('/api/websites/' + current.id, { method: 'DELETE', body: { confirm: true } });
      if (!res.ok) { state(errorText(res.error || res.body?.error)); return; }
      current = null; await load(); toast('Entwurf gelöscht.');
    });
  }
  el('siteCreate').onclick = async () => {
    const body = { name: el('siteName').value.trim(), kind: el('siteKind').value.trim(), city: el('siteCity').value.trim(), description: el('siteDesc').value.trim(), style: el('siteStyle').value.trim() };
    const st = el('siteCreateState');
    if (body.name.length < 2 || body.description.length < 10) { st.textContent = 'Bitte mindestens Name und eine kurze Beschreibung angeben.'; return; }
    st.textContent = 'JARVIS baut den Entwurf … (ca. 1–2 Minuten)';
    const res = await busy('', () => api('/api/websites', { method: 'POST', body, timeout: SLOW }));
    if (!res.ok) { st.textContent = 'Nicht gebaut: ' + errorText(res.error || res.body?.error); return; }
    st.textContent = 'Fertig.'; el('siteNew').open = false;
    await load(res.body.website.id);
  };
  el('siteReload').onclick = () => load();

  // Aus einer JARVIS-Antwort heraus: Knopf „Website ansehen“ unter der Antwort.
  function offer(list) {
    const host = el('n1Answer');
    if (!host || !list?.length) return;
    host.querySelector('.site-offer')?.remove();
    const w = list[list.length - 1];
    const b = btn('Website „' + w.name + '“ ansehen →', 'site-offer primary', () => { window.JarvisShell?.open('sites'); load(w.id); });
    host.append(b);
  }
  window.JarvisSites = { load, open: (id) => { window.JarvisShell?.open('sites'); return load(id); }, offer };
})();
