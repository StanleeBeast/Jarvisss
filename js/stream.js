// JARVIS Live-Antwort: Das Backend schickt die Antwort Wort für Wort (Server-Sent Events).
// Der Text erscheint sofort, JARVIS spricht ab dem ersten fertigen Satz, und während er Werkzeuge nutzt,
// steht da, was er gerade tut („Suche im Internet: …“) und welche Quellen er gefunden hat.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let live = null; // { text, label, sources }
  // Einstufung aus der Recherche: Faustregel, kein Urteil – deshalb vorsichtig formuliert.
  const TRUST = { green: ['●', 'Seriöse Quelle'], yellow: ['●', 'Unklare Quelle – mit anderen abgleichen'], red: ['▲', 'Warnzeichen'] };

  function show() {
    if (!live) return;
    const answer = $('n1AnswerText'), label = $('n1AnswerLabel'), status = $('n1Status');
    if (answer && live.text) answer.textContent = live.text;
    if (label) label.textContent = live.text ? 'JARVIS ANTWORTET …' : (live.label ? live.label.toUpperCase() + ' …' : 'ANFRAGE IN BEARBEITUNG');
    if (status && live.label && !live.text) status.textContent = live.label + ' …';
    renderSources();
  }
  function renderSources() {
    let box = $('n1Sources');
    const host = $('n1Answer');
    if (!host) return;
    if (!box) { box = document.createElement('div'); box.id = 'n1Sources'; box.className = 'n1-sources'; host.append(box); }
    const list = live?.sources || [];
    box.hidden = !list.length;
    box.replaceChildren(...list.slice(0, 6).map(s => {
      const a = document.createElement('a');
      a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      let site = ''; try { site = new URL(s.url).hostname.replace(/^www\./, ''); } catch { /* ungültig */ }
      const t = TRUST[s.trust];
      if (t) { a.dataset.trust = s.trust; a.title = t[1] + (Array.isArray(s.reasons) && s.reasons.length ? ': ' + s.reasons.join(', ') : ''); }
      a.append(Object.assign(document.createElement('b'), { textContent: (t ? t[0] + ' ' : '') + site }), Object.assign(document.createElement('span'), { textContent: s.title || s.url }));
      if (s.trust === 'red' && s.reasons?.length) a.append(Object.assign(document.createElement('small'), { textContent: '⚠ ' + s.reasons.join(', ') }));
      return a;
    }));
  }

  // Screenshot einer Website, die JARVIS geöffnet hat (Tippen = groß).
  function showShot(ev) {
    const host = $('n1Answer');
    if (!host) return;
    const fig = document.createElement('figure');
    fig.className = 'n1-shot';
    fig.dataset.device = ev.device === 'desktop' ? 'desktop' : 'phone';
    const img = Object.assign(document.createElement('img'), { src: ev.src, alt: 'Screenshot von ' + (ev.host || 'der Website'), loading: 'lazy' });
    img.onclick = () => fig.classList.toggle('is-big');
    const cap = document.createElement('figcaption');
    const link = Object.assign(document.createElement('a'), { href: ev.url, target: '_blank', rel: 'noopener noreferrer', textContent: (ev.host || 'Website') + ' öffnen ↗' });
    cap.append(Object.assign(document.createElement('span'), { textContent: (ev.title ? ev.title + ' · ' : '') + (fig.dataset.device === 'desktop' ? 'Computer' : 'Handy') + ' · tippen zum Vergrößern' }), link);
    fig.append(img, cap);
    let box = $('n1Shots');
    if (!box) { box = document.createElement('div'); box.id = 'n1Shots'; box.className = 'n1-shots'; host.append(box); }
    box.append(fig);
  }

  // Liest den Stream bis zum Ende. Rückgabe: das done- bzw. error-Ereignis (wie die bisherige JSON-Antwort).
  async function read(res, onActivity) {
    live = { text: '', label: '', sources: [] };
    $('n1Sources')?.replaceChildren();
    $('n1Shots')?.replaceChildren();
    window.JarvisSpeech?.streamStart?.();
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', last = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        onActivity?.();
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = block.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === 'delta') { live.text += ev.text; window.JarvisSpeech?.streamPush?.(ev.text); }
          else if (ev.type === 'reset') { live.text = ''; window.JarvisSpeech?.streamReset?.(); }
          else if (ev.type === 'tool') live.label = ev.label || '';
          else if (ev.type === 'sources') { for (const s of ev.sources || []) if (s?.url && !live.sources.some(x => x.url === s.url)) live.sources.push(s); }
          else if (ev.type === 'image' && /^data:image\/(jpeg|png|webp);base64,/.test(ev.src || '')) showShot(ev);
          else if (ev.type === 'done' || ev.type === 'error') last = ev;
          show();
        }
      }
    } finally {
      if (last?.type === 'done' && typeof last.reply === 'string') window.JarvisSpeech?.streamEnd?.(last.reply.trim());
      else window.JarvisSpeech?.streamCancel?.();
    }
    return last || { type: 'error', error: 'stream_interrupted' };
  }

  window.JarvisStream = { read, sources: () => (live?.sources || []).slice() };
})();
