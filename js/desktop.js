// JARVIS am Laptop: als App installieren (Edge/Chrome), Tastenkürzel, Sprungmarken aus dem App-Menü.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  // Installieren: Edge/Chrome bieten das an; Safari (iPad/iPhone) über „Teilen → Zum Home-Bildschirm“.
  let deferred = null;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.id = 'installApp'; btn.className = 'install-pill'; btn.hidden = true;
  btn.textContent = '⤓ JARVIS als App installieren';
  document.body.append(btn);
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; if (!matchMedia('(display-mode: standalone)').matches) btn.hidden = false; });
  btn.addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice.catch(() => null); deferred = null; btn.hidden = true; });
  addEventListener('appinstalled', () => { btn.hidden = true; toast('JARVIS ist installiert – du findest ihn im Startmenü.'); });

  // Tastenkürzel (nicht während der Eingabe in Textfeldern, außer Esc)
  const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const help = 'Tastenkürzel: / oder Strg+K = fragen · M = Mikrofon · B = Briefing · T = Tagesplan · E = Mails · S = Stopp · , = Kontrollzentrum · ? = diese Hilfe';
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('n1Input')?.focus(); return; }
    if (typing(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    const act = {
      '/': () => $('n1Input')?.focus(),
      m: () => window.listen?.(),
      b: () => document.querySelector('[data-n1-command*="Briefing"]')?.click(),
      t: () => window.JarvisShell?.open('day'),
      e: () => window.JarvisShell?.open('mail'),
      s: () => window.stopSpeaking?.(),
      ',': () => window.JarvisShell?.open('settings'),
      '?': () => toast(help)
    }[k];
    if (act) { e.preventDefault(); act(); }
  });
  // Sprungmarken aus dem App-Menü (Rechtsklick auf das App-Symbol)
  const q = new URLSearchParams(location.search);
  if (q.get('open')) setTimeout(() => window.JarvisShell?.open(q.get('open')), 1200);
  if (q.get('do') === 'briefing') setTimeout(() => document.querySelector('[data-n1-command*="Briefing"]')?.click(), 1800);
  window.JarvisDesktop = { help };
})();
