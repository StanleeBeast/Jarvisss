// JARVIS Sprache: Zuhören über Aufnahme + Transkription im eigenen Backend und Sprechen Satz für Satz.
//
// Zuhören: Die Browser-Spracherkennung startet in iPad-Home-Bildschirm-Apps oft gar nicht oder bricht ab.
// Deshalb nimmt JARVIS selbst auf (MediaRecorder), erkennt das Ende des Satzes an der Stille und lässt den Text
// im Worker transkribieren (/api/stt). Ohne Backend bleibt die Browser-Spracherkennung als Rückfall.
// Sprechen: Statt den ganzen Text auf einmal zu vertonen (dauert bei langen Briefings sehr lange), wird der
// erste Satz sofort angefragt und abgespielt, die nächsten Abschnitte werden währenddessen geladen.
// Gesprächsmodus: Nach einer gesprochenen Frage hört JARVIS nach seiner Antwort automatisch wieder zu.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const legacyListen = window.listen, legacySpeakLocal = window.speakLocal;
  const body = document.body;
  const profile = () => (window.data && data.profile) || {};
  const backendReady = () => typeof apiBase === 'function' && apiBase() && hasCredentials();

  // --- Ein Audio-Element, beim ersten Tippen freigeschaltet (iOS spielt sonst nach Wartezeiten nichts ab) ---
  const player = new Audio();
  player.preload = 'auto';
  player.setAttribute('playsinline', '');
  const SILENT = 'data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA=='; // 10 ms Stille
  let unlocked = false;
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    try { player.src = SILENT; const p = player.play(); p?.catch?.(() => { unlocked = false; }); } catch { unlocked = false; }
  }
  ['touchend', 'click', 'keydown'].forEach(ev => document.addEventListener(ev, unlock, { capture: true, passive: true }));

  // --- Sprechen ---------------------------------------------------------------------------------------
  let seq = 0, urls = [];
  const energy = (v) => { const orb = $('voicepanel')?.querySelector('.orb'); if (orb) v == null ? orb.style.removeProperty('--voice-energy') : orb.style.setProperty('--voice-energy', String(v)); };
  function setSpeaking(on) {
    $('voicepanel')?.classList.toggle('talking', on);
    body.classList.toggle('jarvis-speaking', on);
    energy(on ? .8 : null);
  }
  function chunks(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const sentences = clean.match(/[^.!?…]+[.!?…]+["“”»]?\s*|[^.!?…]+$/g) || [clean];
    const out = [];
    let cur = '';
    for (const s of sentences) {
      const limit = out.length === 0 ? 160 : 420; // erster Abschnitt kurz → JARVIS fängt schnell an
      if (cur && (cur + s).length > limit) { out.push(cur.trim()); cur = ''; }
      cur += s;
      if (out.length === 0 && cur.length >= 40) { out.push(cur.trim()); cur = ''; }
    }
    if (cur.trim()) out.push(cur.trim());
    return out.filter(Boolean);
  }
  async function fetchAudio(part, token, my) {
    const r = await fetch(apiBase() + '/api/tts', {
      method: 'POST', cache: 'no-store',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({ text: part, voice: profile().aiVoice || undefined, mode: profile().ttsMode || 'quality' }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined
    });
    if (!r.ok) throw new Error('TTS HTTP ' + r.status);
    window.JarvisVoice?.noteProvider(r.headers.get('X-Jarvis-Tts'));
    const blob = await r.blob();
    if (!blob.size) throw new Error('Leere Audiodatei');
    if (my !== seq) return null;
    const url = URL.createObjectURL(blob);
    urls.push(url);
    return url;
  }
  function play(url, my) {
    return new Promise((resolve, reject) => {
      if (my !== seq) return resolve();
      player.onended = () => resolve();
      player.onerror = () => reject(new Error('Wiedergabe fehlgeschlagen'));
      player.src = url;
      player.volume = Math.max(0, Math.min(1, Number(profile().volume ?? 1)));
      const p = player.play();
      if (p?.catch) p.catch(reject);
    });
  }
  function stop() {
    seq++;
    try { window.speechSynthesis?.cancel(); } catch { /* egal */ }
    try { player.pause(); } catch { /* egal */ }
    player.onended = player.onerror = null;
    urls.forEach(u => URL.revokeObjectURL(u)); urls = [];
    setSpeaking(false);
  }
  async function speak(text) {
    stop();
    const my = seq;
    const say = String(text || '').trim();
    if (!say) return;
    if (!backendReady() || profile().voiceEngine === 'system') { legacySpeakLocal?.(say); return; }
    const parts = chunks(say);
    setSpeaking(true);
    let spoken = 0;
    try {
      const token = await authToken();
      let next = fetchAudio(parts[0], token, my);
      for (let i = 0; i < parts.length; i++) {
        const url = await next;
        if (my !== seq || !url) return;
        next = i + 1 < parts.length ? fetchAudio(parts[i + 1], token, my) : null;
        next?.catch(() => null);
        await play(url, my);
        spoken = i + 1;
      }
    } catch (e) {
      if (my !== seq) return;
      console.warn('KI-Stimme nicht verfügbar, verwende Systemstimme.', e);
      const rest = parts.slice(spoken).join(' ');
      setSpeaking(false);
      if (rest) legacySpeakLocal?.(rest);
      return;
    }
    if (my === seq) { setSpeaking(false); afterSpeech(); }
  }

  // --- Zuhören -----------------------------------------------------------------------------------------
  const ERR = {
    NotAllowedError: 'Mikrofonzugriff verweigert. Erlaube ihn in den iPad-Einstellungen → Datenschutz → Mikrofon bzw. für diese Website und versuche es erneut.',
    NotFoundError: 'Kein Mikrofon gefunden.',
    NotReadableError: 'Das Mikrofon wird gerade von einer anderen App benutzt.'
  };
  let rec = null, voiceTurn = false, voiceTimer = 0;
  const supported = () => navigator.mediaDevices?.getUserMedia && window.MediaRecorder;
  function setListening(on, label) {
    body.classList.toggle('jarvis-listening', on);
    const btn = $('listenBtn');
    if (btn) btn.textContent = on ? '🎙 Ich höre zu …' : '🎙 Spracheingabe';
    const mic = $('n1Mic');
    if (mic) { mic.classList.toggle('is-live', on); mic.setAttribute('aria-label', on ? 'Zuhören beenden' : 'Spracheingabe'); }
    if (label) window.n1Show?.(label, 'JARVIS · ZUHÖREN');
  }
  function mime() {
    for (const t of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported?.(t)) return t;
    return '';
  }
  async function listen({ auto = false } = {}) {
    if (rec) { rec.finish(); return; }
    if (!backendReady() || !supported()) { voiceTurn = false; return legacyListen?.(); }
    stop();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      toast(ERR[e?.name] || 'Mikrofon konnte nicht gestartet werden.');
      window.JarvisCore?.flash('error');
      return;
    }
    const type = mime();
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const parts = [];
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const started = performance.now();
    let heard = false, lastVoice = started, raf = 0, done = false, noise = 0.008;
    const state = { finish: () => end(true), cancel: () => end(false) };
    rec = state;
    function level() {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      return Math.sqrt(sum / buf.length);
    }
    function tick() {
      if (done) return;
      const now = performance.now(), l = level();
      if (now - started < 400) noise = Math.max(noise, l * 1.4); // Grundrauschen der ersten Zehntelsekunden
      energy(Math.min(1, .25 + l * 12));
      if (l > Math.max(0.018, noise * 2.2)) { heard = true; lastVoice = now; }
      if (heard && now - lastVoice > 1300) return end(true);             // Satzende: 1,3 s Stille
      if (!heard && now - started > (auto ? 6000 : 8000)) return end(false, 'silence'); // gar nichts gesagt
      if (now - started > 30000) return end(true);                       // höchstens 30 s
      raf = requestAnimationFrame(tick);
    }
    function end(send, why) {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        ctx.close?.();
        rec = null;
        setListening(false);
        energy(null);
        if (!send || !heard) {
          voiceTurn = false;
          if (why === 'silence' && !auto) { toast('Ich habe nichts gehört. Tippe auf das Mikrofon und sprich direkt los.'); window.JarvisCore?.flash('warning'); }
          return;
        }
        await transcribe(new Blob(parts, { type: recorder.mimeType || type || 'audio/mp4' }));
      };
      try { recorder.stop(); } catch { recorder.onstop(); }
    }
    recorder.ondataavailable = (e) => { if (e.data?.size) parts.push(e.data); };
    recorder.start(250);
    setListening(true, auto ? 'Ich höre zu …' : 'Ich höre zu … sprich einfach los.');
    raf = requestAnimationFrame(tick);
  }
  async function transcribe(blob) {
    window.n1Show?.('Verstehe …', 'JARVIS · ZUHÖREN');
    window.JarvisCore?.setCore?.('processing');
    const res = await fetch(apiBase() + '/api/stt', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + await authToken(), 'Content-Type': (blob.type || 'audio/mp4').split(';')[0] },
      body: blob
    }).then(async r => ({ ok: r.ok, body: await r.json().catch(() => ({})) }), () => ({ ok: false, body: { error: 'network' } }));
    const text = (res.body?.text || '').trim();
    if (!res.ok) { voiceTurn = false; toast('Spracherkennung fehlgeschlagen: ' + (window.JarvisCore?.errorText(res.body?.error) || res.body?.error)); window.JarvisCore?.flash('error'); return; }
    if (!text) { voiceTurn = false; toast('Ich habe dich nicht verstanden. Bitte noch einmal.'); return; }
    voiceTurn = true;
    clearTimeout(voiceTimer); voiceTimer = setTimeout(() => { voiceTurn = false; }, 90000); // nur die direkte Antwort zählt
    if (profile().reviewVoice && window.n1Prefill) { window.n1Prefill(text); toast('Erkannt. Prüfe den Text und tippe auf Senden.'); voiceTurn = false; return; }
    if (window.n1Send) { window.n1Send(text); return; }
    $('quickCommand').value = text;
    const reply = await processCommand(text, true);
    if (reply) speak(reply);
  }
  // Gesprächsmodus: nach der gesprochenen Antwort auf eine gesprochene Frage wieder zuhören.
  function afterSpeech() {
    if (!voiceTurn) return;
    voiceTurn = false;
    if (profile().conversation === false || document.hidden) return;
    setTimeout(() => { if (!rec && !body.classList.contains('jarvis-speaking')) listen({ auto: true }); }, 350);
  }

  // Bestehende Aufrufer übernehmen (globale Funktionen und direkt gebundene Knöpfe).
  window.speak = speak;
  window.stopSpeaking = stop;
  window.listen = (opts) => listen(opts);
  window.stopListening = () => rec?.cancel();
  ['listenBtn', 'chatListen'].forEach(id => { const b = $(id); if (b) b.onclick = () => listen(); });
  window.JarvisSpeech = { speak, stop, listen, chunks };
})();
