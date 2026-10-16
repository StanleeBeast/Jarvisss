// JARVIS Lernmodus: PDF (z. B. Goodnotes-Export) oder Text → Lernzettel, Karteikarten, Quiz.
// Getippter PDF-Text wird im Browser gelesen (pdf.js, lokal im Repository). Bei Handschrift werden höchstens
// 8 Seiten als Bild an die KI geschickt. Ein direkter Zugriff auf die Goodnotes-Bibliothek existiert nicht.
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  const api = (path, options) => window.JarvisCore.api(path, options);
  const MAX_PAGES_TEXT = 40, MAX_PAGES_IMAGES = 8, MIN_CHARS_PER_PAGE = 120;
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Einstieg in der Kopfzeile
  const top = el('n1Tasks');
  if (top) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'n1Study'; btn.className = 'n1-settings-btn n1-tasks-btn';
    btn.setAttribute('aria-label', 'Lernmodus öffnen');
    btn.innerHTML = '<span class="n1-settings-glyph n1-static">✎</span><span>Lernen</span>';
    top.before(btn);
  }

  const section = document.createElement('section');
  section.id = 'view-study';
  section.className = 'view';
  section.hidden = true;
  section.innerHTML = '<div id="studyHome" class="grid" style="margin-top:0">'
    + '<div class="panel"><h2>✎ NEUES LERNSET</h2>'
    + '<label class="hint">Thema<input id="studyTitle" maxlength="120" placeholder="z. B. Herz-Kreislauf-System"></label>'
    + '<label class="hint">PDF aus Goodnotes (Teilen → Exportieren → PDF → In Dateien sichern)<input id="studyFile" type="file" accept="application/pdf,.pdf"></label>'
    + '<label class="hint">… oder Text einfügen<textarea id="studyText" rows="4" placeholder="Notizen, Skript, Abschnitte …"></textarea></label>'
    + '<label class="hint"><input id="studyImages" type="checkbox" style="width:auto;margin-right:8px">Seiten als Bild lesen (für Handschrift; wird bei wenig Text automatisch aktiviert)</label>'
    + '<label class="hint"><input id="studyEnrich" type="checkbox" style="width:auto;margin-right:8px">Mit allgemeinem Fachwissen ergänzen (getrennt und gekennzeichnet)</label>'
    + '<label class="hint"><input id="studyTrack" type="checkbox" checked style="width:auto;margin-right:8px">Lernfortschritt speichern</label>'
    + '<div class="inputrow"><label class="hint" style="flex:1">Karteikarten<input id="studyCards" type="number" min="0" max="30" value="12"></label><label class="hint" style="flex:1">Quizfragen<input id="studyQuiz" type="number" min="0" max="30" value="8"></label></div>'
    + '<button id="studyCreate" class="primary full">Lernset erstellen</button>'
    + '<div id="studyProgress" class="item" hidden><small></small></div>'
    + '<p class="hint">Die Unterlagen werden zur Auswertung an das KI-Modell (OpenAI) übertragen und das Ergebnis in deiner Datenbank gespeichert. Seiten als Bild kosten mehr als Text. Ergänzungen stammen aus dem allgemeinen Wissen des Modells und sind keine geprüften Quellen – JARVIS nennt deshalb keine.</p></div>'
    + '<div class="panel"><h2>☰ MEINE LERNSETS</h2><div id="studyList" class="list"></div></div></div>'
    + '<div id="studySet" hidden></div><div id="studySession" hidden></div>';
  document.querySelector('main')?.append(section);

  const info = (text) => { const d = document.createElement('div'); d.className = 'item'; d.append(Object.assign(document.createElement('small'), { textContent: text })); return d; };
  function progress(text) { const box = el('studyProgress'); box.hidden = !text; box.firstChild.textContent = text || ''; }
  function show(view) { el('studyHome').hidden = view !== 'home'; el('studySet').hidden = view !== 'set'; el('studySession').hidden = view !== 'session'; el('n1SettingsContent').scrollTop = 0; }

  // --- PDF lesen ----------------------------------------------------------------------------------
  let pdfjsReady = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfjsReady) pdfjsReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/pdfjs/pdf.min.js';
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js'; resolve(window.pdfjsLib); };
      s.onerror = () => { pdfjsReady = null; reject(new Error('PDF-Leser konnte nicht geladen werden (offline?).')); };
      document.head.append(s);
    });
    return pdfjsReady;
  }
  async function readPdf(file, forceImages) {
    const lib = await loadPdfJs();
    const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = pdf.numPages;
    let text = '';
    for (let i = 1; i <= Math.min(pages, MAX_PAGES_TEXT); i++) {
      progress('Lese Text … Seite ' + i + ' von ' + Math.min(pages, MAX_PAGES_TEXT));
      const content = await (await pdf.getPage(i)).getTextContent();
      text += '\n\n--- Seite ' + i + ' ---\n' + content.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
    }
    const chars = text.replace(/--- Seite \d+ ---/g, '').replace(/\s/g, '').length;
    const handwriting = forceImages || chars < MIN_CHARS_PER_PAGE * Math.min(pages, MAX_PAGES_TEXT);
    const images = [];
    if (handwriting) {
      for (let i = 1; i <= Math.min(pages, MAX_PAGES_IMAGES); i++) {
        progress('Wenig getippter Text gefunden – bereite Seite ' + i + ' von ' + Math.min(pages, MAX_PAGES_IMAGES) + ' als Bild vor (Handschrift) …');
        const page = await pdf.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, 1300 / base.width) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        let url = canvas.toDataURL('image/jpeg', 0.72);
        if (url.length > 1_500_000) url = canvas.toDataURL('image/jpeg', 0.5);
        images.push(url);
        canvas.width = canvas.height = 0;
      }
    }
    return { text: handwriting && chars < 40 ? '' : text.trim(), images, pages, handwriting, truncated: handwriting ? pages > MAX_PAGES_IMAGES : pages > MAX_PAGES_TEXT };
  }

  el('studyCreate').addEventListener('click', async () => {
    if (!apiBase() || !hasCredentials()) { toast('Zuerst das Backend verbinden.'); return; }
    const file = el('studyFile').files[0];
    const pasted = el('studyText').value.trim();
    if (!file && !pasted) { toast('Bitte ein PDF wählen oder Text einfügen.'); return; }
    const btn = el('studyCreate');
    btn.disabled = true;
    try {
      let material = { text: pasted, images: [], truncated: false, handwriting: false };
      if (file) {
        if (file.size > 40 * 1024 * 1024) throw new Error('Das PDF ist größer als 40 MB.');
        material = await readPdf(file, el('studyImages').checked);
        if (pasted) material.text = (material.text + '\n\n' + pasted).trim();
        if (material.truncated) toast(material.handwriting ? 'Nur die ersten ' + MAX_PAGES_IMAGES + ' Seiten werden als Bild gelesen. Teile längere Unterlagen in mehrere Lernsets.' : 'Nur die ersten ' + MAX_PAGES_TEXT + ' Seiten werden gelesen.');
      }
      progress('JARVIS erstellt Lernzettel, Karteikarten und Quiz … das kann bis zu einer Minute dauern.');
      const res = await api('/api/study/generate', {
        method: 'POST', timeout: 130000,
        body: {
          title: el('studyTitle').value.trim(), text: material.text, images: material.images,
          sourceName: file ? file.name : 'Eingefügter Text', sourceKind: file ? 'pdf' : 'text',
          options: { flashcards: Number(el('studyCards').value) || 0, quiz: Number(el('studyQuiz').value) || 0, enrich: el('studyEnrich').checked, trackProgress: el('studyTrack').checked }
        }
      });
      if (!res.ok || !res.body?.saved) throw new Error(window.JarvisCore.errorText(res.error));
      progress('');
      el('studyFile').value = ''; el('studyText').value = ''; el('studyTitle').value = '';
      toast('Lernset gespeichert.');
      window.JarvisCore.flash('success');
      openSet(res.body.set);
    } catch (e) {
      progress('Nicht erstellt: ' + e.message);
      window.JarvisCore.flash('error');
    } finally { btn.disabled = false; }
  });

  // --- Listen & Lernzettel ------------------------------------------------------------------------
  async function loadList() {
    show('home');
    const box = el('studyList');
    if (!apiBase() || !hasCredentials()) { box.replaceChildren(info('Zuerst das Backend verbinden.')); return; }
    const res = await api('/api/study/sets');
    if (!res.ok) { box.replaceChildren(info(res.error === 'storage_not_configured' ? 'Der Lernassistent benötigt die D1-Datenbank.' : window.JarvisCore.errorText(res.error))); return; }
    if (!res.body.sets.length) { box.replaceChildren(info('Noch keine Lernsets.')); return; }
    box.replaceChildren(...res.body.sets.map(s => {
      const row = document.createElement('div');
      row.className = 'item task-row';
      const d = document.createElement('div'); d.className = 'details';
      const pct = s.cards ? Math.round(s.mastered / s.cards * 100) : 0;
      d.append(Object.assign(document.createElement('strong'), { textContent: s.title }), Object.assign(document.createElement('small'), { textContent: s.cards + ' Karten · ' + (s.trackProgress ? pct + ' % sicher' : 'ohne Fortschritt') + (s.marked ? ' · ' + s.marked + ' schwierig' : '') + ' · ' + new Date(s.createdAt).toLocaleDateString('de-DE') }));
      const open = Object.assign(document.createElement('button'), { type: 'button', className: 'primary', textContent: 'Öffnen' });
      open.onclick = async () => { const r = await api('/api/study/sets/' + s.id); if (r.ok) openSet(r.body.set); else toast(window.JarvisCore.errorText(r.error)); };
      const actions = document.createElement('div'); actions.className = 'task-actions'; actions.append(open);
      row.append(d, actions);
      return row;
    }));
  }
  function markdown(md) {
    const lines = esc(md).split('\n');
    let html = '', list = false;
    for (const raw of lines) {
      const line = raw.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
      if (bullet) { if (!list) { html += '<ul>'; list = true; } html += '<li>' + bullet[1] + '</li>'; continue; }
      if (list) { html += '</ul>'; list = false; }
      const head = /^\s*#{1,4}\s+(.*)$/.exec(line);
      if (head) html += '<h3>' + head[1] + '</h3>';
      else if (line.trim()) html += '<p>' + line + '</p>';
    }
    return html + (list ? '</ul>' : '');
  }
  let current = null;
  function openSet(set) {
    current = set;
    const flash = set.cards.filter(c => c.kind === 'flashcard'), quiz = set.cards.filter(c => c.kind === 'quiz'), marked = set.cards.filter(c => c.marked);
    const box = el('studySet');
    box.innerHTML = '<div class="grid" style="margin-top:0"><div class="panel study-sheet"><div class="eyebrow">LERNZETTEL · AUS DEINEN UNTERLAGEN</div><h2 id="studySetTitle"></h2><small class="muted" id="studySetMeta"></small><div id="studySummary" class="study-md"></div></div>'
      + '<div class="panel"><h2>▶ LERNEN</h2><div class="stack"><button id="studyFlash" class="primary">Karteikarten (' + flash.length + ')</button><button id="studyQuizBtn" class="primary">Quiz starten (' + quiz.length + ')</button><button id="studyHard">Nur schwierige (' + marked.length + ')</button><button id="studySpeak">Lernzettel vorlesen</button><button id="studyBack">Zurück zur Übersicht</button><button id="studyDelete">Lernset löschen</button></div>'
      + '<div id="studyUnclear"></div><div id="studyAdditions"></div></div></div>';
    el('studySetTitle').textContent = set.title;
    el('studySetMeta').textContent = 'Quelle: ' + (set.sourceName || '—') + ' · gelesen als ' + ({ text: 'Text', images: 'Seitenbilder (Handschrift)', mixed: 'Text und Seitenbilder' }[set.readMode] || set.readMode) + ' · ' + new Date(set.createdAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
    el('studySummary').innerHTML = markdown(set.summary);
    if (set.unclear.length) el('studyUnclear').innerHTML = '<h3 class="study-h">⚠ Unklare Stellen</h3>' + set.unclear.map(u => '<div class="item"><strong>' + esc(u.excerpt) + '</strong><small>' + esc(u.reason) + '</small></div>').join('');
    if (set.additions.length) el('studyAdditions').innerHTML = '<h3 class="study-h">＋ Ergänzungen</h3><p class="hint">Aus dem allgemeinen Wissen des KI-Modells, nicht aus deinen Unterlagen und ohne geprüfte Quelle. Bitte mit Lehrbuch oder Lehrkraft abgleichen.</p>' + set.additions.map(a => '<div class="item study-addition"><small>Sicherheit: ' + esc(a.confidence) + '</small>' + esc(a.text) + '</div>').join('');
    el('studyFlash').onclick = () => startSession('flashcard', flash);
    el('studyQuizBtn').onclick = () => startSession('quiz', quiz);
    el('studyHard').onclick = () => startSession('mixed', marked);
    el('studySpeak').onclick = () => speak(set.title + '. ' + set.summary.replace(/[#*•-]/g, ' ').replace(/\s+/g, ' '));
    el('studyBack').onclick = loadList;
    el('studyDelete').onclick = () => confirmAction('Lernset löschen', '„' + set.title + '“ mit allen Karten und dem Lernfortschritt endgültig löschen?', async () => {
      const r = await api('/api/study/sets/' + set.id, { method: 'DELETE' });
      if (r.ok && r.body?.deleted) { toast('Lernset gelöscht.'); loadList(); } else toast('Nicht gelöscht: ' + window.JarvisCore.errorText(r.error));
    });
    show('set');
  }

  // --- Abfrage ------------------------------------------------------------------------------------
  // Falsch beantwortete Karten kommen ans Ende und werden wiederholt, bis jede einmal richtig war.
  function startSession(mode, cards) {
    if (!cards.length) { toast(mode === 'mixed' ? 'Noch keine Karte als schwierig markiert.' : 'Dieses Lernset hat keine solchen Karten.'); return; }
    const queue = [...cards].sort((a, b) => (a.box - b.box) || (Date.parse(a.dueAt || 0) - Date.parse(b.dueAt || 0)));
    const stats = { total: cards.length, solved: 0, wrong: 0 };
    const box = el('studySession');
    show('session');
    const next = () => {
      if (!queue.length) {
        box.innerHTML = '<div class="panel study-done"><h2>✓ GESCHAFFT</h2><p>Alle ' + stats.total + ' Karten mindestens einmal richtig. ' + (stats.wrong ? stats.wrong + ' Wiederholung(en) waren nötig.' : 'Ohne Fehler!') + '</p><div class="quick"><button id="studyAgain" class="primary">Noch einmal</button><button id="studyToSet">Zum Lernzettel</button></div></div>';
        el('studyAgain').onclick = () => startSession(mode, cards);
        el('studyToSet').onclick = () => reopen();
        window.JarvisCore.flash('success');
        return;
      }
      const card = queue.shift();
      const isQuiz = card.kind === 'quiz';
      box.innerHTML = '<div class="panel study-card"><div class="study-progress"><span id="studyCount"></span><button id="studyMark" type="button"></button><button id="studyStop" type="button">Beenden</button></div>'
        + '<div class="study-origin" id="studyOrigin"></div><div class="study-prompt" id="studyPrompt"></div><div id="studyBody"></div></div>';
      el('studyCount').textContent = stats.solved + ' / ' + stats.total + ' sicher' + (stats.wrong ? ' · ' + stats.wrong + ' Wiederholungen' : '');
      el('studyPrompt').textContent = card.prompt;
      el('studyOrigin').textContent = card.origin === 'addition' ? 'ERGÄNZUNG · nicht aus deinen Unterlagen' : 'AUS DEINEN UNTERLAGEN';
      const markBtn = el('studyMark');
      const renderMark = () => { markBtn.textContent = card.marked ? '★ schwierig' : '☆ als schwierig markieren'; };
      renderMark();
      markBtn.onclick = async () => { const r = await api('/api/study/cards/' + card.id, { method: 'PATCH', body: { marked: !card.marked } }); if (r.ok) { card.marked = r.body.card.marked; renderMark(); } };
      el('studyStop').onclick = () => reopen();
      const record = async (correct) => {
        if (correct) stats.solved++; else { stats.wrong++; queue.push(card); }
        const r = await api('/api/study/cards/' + card.id + '/review', { method: 'POST', body: { correct } });
        if (r.ok && r.body.card) Object.assign(card, { box: r.body.card.box, dueAt: r.body.card.dueAt });
      };
      const body = el('studyBody');
      if (isQuiz) {
        body.innerHTML = '<div class="study-options">' + card.options.map((o, i) => '<button type="button" data-i="' + i + '">' + esc(o) + '</button>').join('') + '</div><div id="studyFeedback"></div>';
        body.querySelectorAll('[data-i]').forEach(b => b.onclick = async () => {
          const chosen = Number(b.dataset.i), correct = chosen === card.correctIndex;
          body.querySelectorAll('[data-i]').forEach(x => { x.disabled = true; if (Number(x.dataset.i) === card.correctIndex) x.dataset.state = 'right'; });
          if (!correct) b.dataset.state = 'wrong';
          el('studyFeedback').innerHTML = '<p class="study-explain"><strong>' + (correct ? '✓ Richtig.' : '✕ Leider falsch. Diese Frage kommt später noch einmal.') + '</strong> ' + esc(card.explanation || '') + '</p><button id="studyNext" class="primary">Weiter</button>';
          await record(correct);
          el('studyNext').onclick = next;
        });
      } else {
        body.innerHTML = '<button id="studyReveal" class="primary full">Antwort zeigen</button>';
        el('studyReveal').onclick = () => {
          body.innerHTML = '<div class="study-answer"></div><div class="quick"><button id="studyKnew" class="primary">✓ Gewusst</button><button id="studyMissed">✕ Nicht gewusst</button></div>';
          body.querySelector('.study-answer').textContent = card.answer;
          el('studyKnew').onclick = async () => { await record(true); next(); };
          el('studyMissed').onclick = async () => { await record(false); next(); };
        };
      }
    };
    next();
  }
  async function reopen() {
    const r = await api('/api/study/sets/' + current.id);
    if (r.ok) openSet(r.body.set); else loadList();
  }

  window.JarvisStudy = { load: loadList };
})();
