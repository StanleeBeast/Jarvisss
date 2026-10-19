// JARVIS Visuals: Animations-Schalter, Topografie-Hintergrund, Partikel-ORB und Startanimation
// (Weltkarte → Deutschland → Miltitz). Alles läuft lokal im Browser (Canvas), ohne externe Abrufe.
// Kartendaten: Natural Earth über world-atlas (gemeinfrei), vorbereitet in assets/geo/geo.json.
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  const HOME = { lat: 51.255, lon: 14.18, name: 'MILTITZ · NEBELSCHÜTZ' };
  // Orte zur Orientierung: tier 1 = Großstädte, 2 = Region, 3 = Umgebung (Koordinaten gerundet)
  const TOWNS = [
    { name: 'BERLIN', lat: 52.520, lon: 13.405, tier: 1 }, { name: 'LEIPZIG', lat: 51.340, lon: 12.375, tier: 1 },
    { name: 'DRESDEN', lat: 51.050, lon: 13.737, tier: 1 }, { name: 'PRAG', lat: 50.075, lon: 14.438, tier: 1 },
    { name: 'WROCŁAW', lat: 51.108, lon: 17.038, tier: 1 },
    { name: 'COTTBUS', lat: 51.761, lon: 14.334, tier: 2 }, { name: 'GÖRLITZ', lat: 51.153, lon: 14.987, tier: 2 },
    { name: 'ZITTAU', lat: 50.896, lon: 14.807, tier: 2 }, { name: 'BAUTZEN', lat: 51.181, lon: 14.424, tier: 2 },
    { name: 'HOYERSWERDA', lat: 51.438, lon: 14.235, tier: 2 },
    { name: 'KAMENZ', lat: 51.268, lon: 14.094, tier: 3 }, { name: 'BISCHOFSWERDA', lat: 51.127, lon: 14.180, tier: 3 },
    { name: 'RADEBERG', lat: 51.117, lon: 13.917, tier: 3 }, { name: 'PULSNITZ', lat: 51.183, lon: 14.017, tier: 3 },
    { name: 'KÖNIGSBRÜCK', lat: 51.265, lon: 13.905, tier: 3 }, { name: 'WITTICHENAU', lat: 51.385, lon: 14.244, tier: 3 }
  ];
  const distKm = (a, b) => { const R = 6371, D = Math.PI / 180, dLat = (b.lat - a.lat) * D, dLon = (b.lon - a.lon) * D; const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D) * Math.cos(b.lat * D) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

  // --- Animationen: System / Immer an / Aus ------------------------------------------------------
  const MOTION_KEY = 'jarvis_motion_mode_v1';
  const INTRO_KEY = 'jarvis_intro_enabled_v1';
  const reducedQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false, addEventListener() {} };
  const original = new WeakMap();
  const listeners = new Set();
  const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* optional */ } };
  function mode() { const m = read(MOTION_KEY, 'system'); return ['system', 'on', 'off'].includes(m) ? m : 'system'; }
  function allowed() { const m = mode(); return m === 'on' || (m === 'system' && !reducedQuery.matches); }
  function eachMotionRule(fn) {
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules || []) {
        if (rule.type !== 4) continue; // CSSMediaRule
        const text = original.get(rule) ?? rule.media.mediaText;
        if (!/prefers-reduced-motion/.test(text)) continue;
        if (!original.has(rule)) original.set(rule, text);
        fn(rule, text);
      }
    }
  }
  function applyMotion() {
    const m = mode();
    // „Immer an“ schaltet die Regeln für reduzierte Bewegung ab, „Aus“ erzwingt sie.
    eachMotionRule((rule, text) => { rule.media.mediaText = m === 'on' ? 'not all' : m === 'off' ? 'all' : text; });
    document.body.classList.toggle('no-motion', !allowed());
    document.documentElement.dataset.motion = allowed() ? 'on' : 'off';
    listeners.forEach(fn => { try { fn(allowed()); } catch { /* ignore */ } });
  }
  function setMode(m) { write(MOTION_KEY, m); applyMotion(); renderMotionPanel(); }
  reducedQuery.addEventListener?.('change', applyMotion);
  window.JarvisMotion = { mode, allowed, set: setMode, onChange: (fn) => listeners.add(fn), systemReduced: () => reducedQuery.matches };
  applyMotion();

  // --- Leistung: „Hoch“ / „Leicht“ / „Automatisch“ ------------------------------------------------
  // Leicht: kein Milchglas-Effekt (der wird über bewegtem Hintergrund in jedem Bild neu berechnet), weniger
  // Partikel, niedrigere Auflösung, 30 Bilder/s für die Kugel und ein langsam aktualisierter Hintergrund.
  // Automatisch: auf Touch-Geräten (iPad, iPhone) leicht, sonst hoch – und herunterschalten, wenn es ruckelt.
  const QUALITY_KEY = 'jarvis_quality_v1';
  const qListeners = new Set();
  const touch = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
  let autoLite = touch;
  function qualityMode() { const m = read(QUALITY_KEY, 'auto'); return ['auto', 'high', 'lite'].includes(m) ? m : 'auto'; }
  function lite() { const m = qualityMode(); return m === 'lite' || (m === 'auto' && autoLite); }
  function applyQuality() { document.documentElement.classList.toggle('perf-lite', lite()); qListeners.forEach(fn => fn(lite())); renderMotionPanel(); }
  function setQuality(m) { write(QUALITY_KEY, m); applyQuality(); }
  function reportSlow() { if (qualityMode() === 'auto' && !autoLite) { autoLite = true; applyQuality(); } }
  window.JarvisQuality = { mode: qualityMode, lite, set: setQuality, onChange: (fn) => qListeners.add(fn), reportSlow };
  document.documentElement.classList.toggle('perf-lite', lite());
  // Verdeckt das Einstellungsfenster die Animationen, pausieren sie.
  const covered = () => document.body.classList.contains('n1-settings-open') || document.hidden;

  // Bedienelement im Bereich „Design“
  function renderMotionPanel() {
    const box = el('motionPanel');
    if (!box) return;
    box.querySelectorAll('[data-motion]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.motion === mode())));
    box.querySelectorAll('[data-quality]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.quality === window.JarvisQuality?.mode())));
    const qs = el('qualityState');
    if (qs && window.JarvisQuality) qs.textContent = window.JarvisQuality.lite() ? 'Leicht: flüssiger auf iPad und iPhone, weniger Effekte.' + (window.JarvisQuality.mode() === 'auto' ? ' (automatisch gewählt)' : '') : 'Hoch: alle Effekte. Ruckelt es, wähle „Automatisch“ oder „Leicht“.';
    const intro = el('introToggle');
    if (intro) intro.checked = read(INTRO_KEY, '1') !== '0';
    el('motionState').textContent = reducedQuery.matches
      ? 'Auf diesem Gerät ist „Bewegung reduzieren“ eingeschaltet (Einstellungen → Bedienungshilfen → Bewegung). ' + (allowed() ? 'JARVIS zeigt Animationen trotzdem, weil du „Immer an“ gewählt hast.' : 'Deshalb sind Animationen aus. Mit „Immer an“ laufen sie trotzdem.')
      : allowed() ? 'Animationen laufen.' : 'Animationen sind ausgeschaltet.';
  }
  function mountMotionPanel() {
    const grid = el('view-design')?.querySelector('.grid');
    if (!grid || el('motionPanel')) return;
    const panel = document.createElement('div');
    panel.className = 'panel motion-panel';
    panel.id = 'motionPanel';
    panel.innerHTML = '<h2>◈ ANIMATIONEN</h2><div class="motion-seg" role="group" aria-label="Animationen">'
      + '<button type="button" data-motion="on">Immer an</button><button type="button" data-motion="system">Wie das Gerät</button><button type="button" data-motion="off">Aus</button></div>'
      + '<p class="motion-state" id="motionState"></p>'
      + '<h3 class="motion-sub">Leistung</h3><div class="motion-seg" role="group" aria-label="Leistung">'
      + '<button type="button" data-quality="high">Hoch</button><button type="button" data-quality="auto">Automatisch</button><button type="button" data-quality="lite">Leicht</button></div>'
      + '<p class="motion-state" id="qualityState"></p>'
      + '<label class="hint"><input type="checkbox" id="introToggle" style="width:auto;margin-right:8px">Startanimation (Weltkarte → Miltitz) beim Öffnen zeigen</label>'
      + '<h3 class="motion-sub">Startmusik</h3><p class="hint">Eigene Musik für die Startanimation, z. B. aus der Dateien-App. Sie bleibt nur auf diesem Gerät. Mit Musik startet die Animation nach einem Tipp, weil iPad und iPhone Ton erst nach einer Berührung abspielen.</p>'
      + '<p class="motion-state" id="musicState"></p><div class="motion-seg"><label class="music-pick">Musik wählen<input type="file" id="musicFile" accept="audio/*" hidden></label><button type="button" id="musicTest">Anhören</button><button type="button" id="musicRemove">Entfernen</button></div>'
      + '<label class="hint">Lautstärke<input type="range" id="musicVolume" min="0" max="1" step="0.05"></label>';
    grid.prepend(panel);
    panel.querySelectorAll('[data-motion]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.motion)));
    panel.querySelectorAll('[data-quality]').forEach(b => b.addEventListener('click', () => setQuality(b.dataset.quality)));
    el('introToggle').addEventListener('change', (e) => write(INTRO_KEY, e.target.checked ? '1' : '0'));
    let preview = null;
    const musicState = async () => { const has = await window.JarvisIntroMusic.get(); el('musicState').textContent = has ? 'Gewählt: ' + (window.JarvisIntroMusic.name() || 'eigene Musik') : 'Keine Startmusik gewählt.'; el('musicTest').hidden = el('musicRemove').hidden = !has; };
    el('musicVolume').value = window.JarvisIntroMusic.volume();
    el('musicVolume').addEventListener('input', (e) => { window.JarvisIntroMusic.setVolume(e.target.value); if (preview) preview.volume = Number(e.target.value); });
    el('musicFile').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { await window.JarvisIntroMusic.save(f); toast('Startmusik gespeichert.'); } catch (err) { toast(err.message || 'Musik konnte nicht gespeichert werden.'); }
      e.target.value = ''; musicState();
    });
    el('musicTest').addEventListener('click', async () => {
      if (preview) { preview.pause(); preview = null; el('musicTest').textContent = 'Anhören'; return; }
      const b = await window.JarvisIntroMusic.get(); if (!b) return;
      preview = new Audio(URL.createObjectURL(b)); preview.volume = window.JarvisIntroMusic.volume();
      preview.onended = () => { preview = null; el('musicTest').textContent = 'Anhören'; };
      preview.play().then(() => { el('musicTest').textContent = 'Stopp'; }).catch(() => toast('Abspielen nicht möglich.'));
    });
    el('musicRemove').addEventListener('click', async () => { if (preview) { preview.pause(); preview = null; } await window.JarvisIntroMusic.remove(); toast('Startmusik entfernt.'); musicState(); });
    musicState();
    // Der alte Schalter „Hologramm-Animationen aktiv“ wird durch diese Einstellung ersetzt.
    el('animationsEnabled')?.closest('label')?.setAttribute('hidden', '');
    renderMotionPanel();
  }

  // --- Gemeinsame Helfer ----------------------------------------------------------------------
  function fitCanvas(canvas, w, h, maxDpr = 2) {
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }
  // Wertrauschen (glatt, deterministisch) für Topografie und ORB
  const perm = new Uint8Array(512);
  (function seed() { const p = Array.from({ length: 256 }, (_, i) => i); let s = 1337; for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) perm[i] = p[i & 255]; })();
  const fade = (t) => t * t * (3 - 2 * t);
  function noise3(x, y, z) {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    const fx = fade(x - X), fy = fade(y - Y), fz = fade(z - Z);
    const h = (i, j, k) => perm[(perm[(perm[(X + i) & 255] + Y + j) & 255] + Z + k) & 255] / 255;
    const l = (a, b, t) => a + (b - a) * t;
    return l(l(l(h(0, 0, 0), h(1, 0, 0), fx), l(h(0, 1, 0), h(1, 1, 0), fx), fy), l(l(h(0, 0, 1), h(1, 0, 1), fx), l(h(0, 1, 1), h(1, 1, 1), fx), fy), fz);
  }

  // --- Topografie-Hintergrund ---------------------------------------------------------------------
  (function topo() {
    const canvas = document.createElement('canvas');
    canvas.id = 'topoCanvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);
    let ctx, w = 0, h = 0, raf = 0, frame = 0, t = Math.random() * 50;
    const CELL = 26, LEVELS = [0.22, 0.3, 0.38, 0.46, 0.54, 0.62, 0.7, 0.78];
    function resize() { w = innerWidth; h = innerHeight; ctx = fitCanvas(canvas, w, h, lite() ? 1 : 1.5); draw(); }
    function field(x, y) { return noise3(x * 0.0042, y * 0.0042, t) * 0.7 + noise3(x * 0.011, y * 0.011, t * 1.7 + 9) * 0.3; }
    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      const cols = Math.ceil(w / CELL) + 1, rows = Math.ceil(h / CELL) + 1;
      const v = new Float32Array(cols * rows);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) v[j * cols + i] = field(i * CELL, j * CELL);
      // feines Kartengitter
      ctx.strokeStyle = 'rgba(255,179,71,0.035)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x += CELL * 4) { ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, h); }
      for (let y = 0; y < h; y += CELL * 4) { ctx.moveTo(0, y + .5); ctx.lineTo(w, y + .5); }
      ctx.stroke();
      // Höhenlinien (Marching Squares)
      LEVELS.forEach((lv, n) => {
        ctx.beginPath();
        for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
          const a = v[j * cols + i], b = v[j * cols + i + 1], c = v[(j + 1) * cols + i + 1], d = v[(j + 1) * cols + i];
          const idx = (a > lv ? 8 : 0) | (b > lv ? 4 : 0) | (c > lv ? 2 : 0) | (d > lv ? 1 : 0);
          if (idx === 0 || idx === 15) continue;
          const x = i * CELL, y = j * CELL;
          const top = [x + CELL * (lv - a) / (b - a), y], right = [x + CELL, y + CELL * (lv - b) / (c - b)];
          const bottom = [x + CELL * (lv - d) / (c - d), y + CELL], left = [x, y + CELL * (lv - a) / (d - a)];
          const seg = (p, q) => { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); };
          switch (idx) {
            case 1: case 14: seg(left, bottom); break;
            case 2: case 13: seg(bottom, right); break;
            case 3: case 12: seg(left, right); break;
            case 4: case 11: seg(top, right); break;
            case 5: seg(left, top); seg(bottom, right); break;
            case 6: case 9: seg(top, bottom); break;
            case 7: case 8: seg(left, top); break;
            case 10: seg(left, bottom); seg(top, right); break;
          }
        }
        const major = n % 3 === 1;
        ctx.strokeStyle = major ? 'rgba(255,170,60,0.13)' : 'rgba(255,170,60,0.06)';
        ctx.lineWidth = major ? 1.1 : 0.8;
        ctx.stroke();
      });
    }
    let lastDraw = 0;
    function loop(now) {
      // Hoch: ~20 Bilder/s. Leicht: 4 Bilder/s – die Linien wandern langsam, das reicht für den Eindruck.
      const every = lite() ? 250 : 50;
      if (!covered() && now - lastDraw >= every) { t += 0.0022 * (now - lastDraw) / 50; lastDraw = now; draw(); }
      raf = requestAnimationFrame(loop);
    }
    function sync(on) { cancelAnimationFrame(raf); lastDraw = performance.now(); if (on && !document.hidden) raf = requestAnimationFrame(loop); else draw(); }
    window.JarvisQuality.onChange(() => resize());
    resize();
    addEventListener('resize', resize, { passive: true });
    document.addEventListener('visibilitychange', () => sync(allowed()));
    window.JarvisMotion.onChange(sync);
    sync(allowed());
  })();

  // --- Partikel-ORB -------------------------------------------------------------------------------
  (function orb() {
    const stage = document.querySelector('#nexusOne .n1-core-stage');
    const app = el('nexusOne');
    if (!stage || !app) return;
    const canvas = document.createElement('canvas');
    canvas.id = 'orbCanvas';
    canvas.setAttribute('aria-hidden', 'true');
    stage.prepend(canvas);
    const N_HIGH = Math.min(2200, Math.max(1100, Math.round((innerWidth * innerHeight) / 600))), N_LITE = 650;
    const pts = [];
    const N = N_HIGH;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = golden * i;
      pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r, s: Math.random(), ph: Math.random() * Math.PI * 2 });
    }
    let ctx, w = 0, h = 0, raf = 0, rot = 0, tilt = 0.35, last = performance.now(), energy = 0, flash = 0, lastCore = 'idle';
    const STYLE = {
      idle: { amp: 0.035, speed: 0.12, hue: [255, 179, 71] },
      listening: { amp: 0.11, speed: 0.35, hue: [255, 200, 110] },
      processing: { amp: 0.07, speed: 0.9, hue: [255, 150, 50] },
      speaking: { amp: 0.16, speed: 0.3, hue: [255, 190, 90] },
      success: { amp: 0.06, speed: 0.25, hue: [130, 240, 180] },
      warning: { amp: 0.06, speed: 0.2, hue: [255, 140, 40] },
      error: { amp: 0.09, speed: 0.15, hue: [255, 70, 50] },
      offline: { amp: 0.015, speed: 0.04, hue: [150, 135, 115] }
    };
    function resize() { const r = canvas.getBoundingClientRect(); w = Math.max(1, r.width); h = Math.max(1, r.height); ctx = fitCanvas(canvas, w, h, lite() ? 1.25 : 2); }
    const BUCKETS = 8, bx = Array.from({ length: BUCKETS * 2 }, () => []);
    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const core = app.dataset.core || 'idle';
      if (core !== lastCore) { if (core === 'success' || core === 'error') flash = 1; lastCore = core; }
      const st = STYLE[core] || STYLE.idle;
      const speaking = core === 'speaking' || document.body.classList.contains('jarvis-speaking');
      const target = speaking ? 0.55 + 0.45 * Math.abs(Math.sin(now / 140) * Math.sin(now / 390)) : core === 'listening' ? 0.5 + 0.3 * Math.sin(now / 200) : 0;
      energy += (target - energy) * Math.min(1, dt * 8);
      flash = Math.max(0, flash - dt * 1.4);
      rot += dt * st.speed * (core === 'processing' ? 2.2 : 1);
      draw(now / 1000, st, energy, core);
    }
    function draw(t, st, en, core) {
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.3;
      const [cr, cg, cb] = st.hue;
      // Kernleuchten
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.7);
      glow.addColorStop(0, 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (0.16 + en * 0.2 + flash * 0.25) + ')');
      glow.addColorStop(0.45, 'rgba(' + cr + ',' + Math.round(cg * 0.6) + ',' + Math.round(cb * 0.4) + ',0.05)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
      // Orbitalringe
      ctx.save(); ctx.translate(cx, cy);
      for (let k = 0; k < 3; k++) {
        ctx.save();
        ctx.rotate(rot * (k % 2 ? -0.6 : 0.8) + k * 1.1);
        ctx.scale(1, 0.28 + k * 0.08);
        ctx.beginPath(); ctx.arc(0, 0, R * (1.32 + k * 0.14), 0, Math.PI * 2);
        ctx.strokeStyle = k === 1 ? 'rgba(255,68,51,' + (0.25 + en * 0.3) + ')' : 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (0.22 + en * 0.25) + ')';
        ctx.setLineDash(k === 2 ? [2, 7] : []); ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
      // Partikel – nach Helligkeit in wenige Gruppen sortiert, damit pro Bild nur ~16 Farbwechsel nötig sind.
      const light = lite();
      if (!light) ctx.globalCompositeOperation = 'lighter';
      const cosR = Math.cos(rot), sinR = Math.sin(rot), cosT = Math.cos(tilt), sinT = Math.sin(tilt);
      const amp = st.amp + en * 0.12;
      const count = light ? N_LITE : pts.length, stride = pts.length / count;
      for (const b of bx) b.length = 0;
      for (let k = 0; k < count; k++) {
        const p = pts[Math.floor(k * stride)];
        // Verformung der Kugeloberfläche; im leichten Modus mit günstigen Sinuswellen statt 3D-Rauschen
        const n = light
          ? (Math.sin(p.x * 3.1 + t * 0.9) * Math.sin(p.y * 2.7 + t * 0.7) * Math.sin(p.z * 2.3 + t * 1.1)) * 0.5
          : noise3(p.x * 1.6 + t * 0.5, p.y * 1.6 + t * 0.35, p.z * 1.6 + t * 0.6) - 0.5;
        const swirl = core === 'processing' ? Math.sin(p.y * 6 + t * 4) * 0.05 : 0;
        const rr = 1 + n * amp * 2.4 + swirl + flash * 0.08 * Math.sin(p.ph + t * 9);
        const x = p.x * rr, y = p.y * rr, z = p.z * rr;
        const x1 = x * cosR - z * sinR, z1 = x * sinR + z * cosR;
        const y2 = y * cosT - z1 * sinT, z2 = y * sinT + z1 * cosT;
        const persp = 2.6 / (2.6 - z2);
        const depth = (z2 + 1) / 2;
        const tw = 0.6 + 0.4 * Math.sin(p.ph + t * (1.5 + p.s * 2));
        const a = Math.min(1, (0.18 + depth * 0.9) * tw);
        const size = (0.7 + depth * 1.9 + p.s * 0.7) * (1 + en * 0.3) * (light ? 1.25 : 1);
        const hot = depth > 0.82 && p.s > 0.7 ? 1 : 0;
        bx[hot * BUCKETS + Math.min(BUCKETS - 1, Math.floor(a * BUCKETS))].push(cx + x1 * R * persp - size / 2, cy + y2 * R * persp - size / 2, size);
      }
      for (let g = 0; g < bx.length; g++) {
        const list = bx[g];
        if (!list.length) continue;
        const hot = g >= BUCKETS, a = ((g % BUCKETS) + 0.5) / BUCKETS;
        ctx.fillStyle = hot ? 'rgba(255,244,220,' + a + ')' : 'rgba(' + cr + ',' + cg + ',' + cb + ',' + a + ')';
        ctx.beginPath();
        for (let i = 0; i < list.length; i += 3) ctx.rect(list[i], list[i + 1], list[i + 2], list[i + 2]);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      // Zielmarken um die Kugel
      ctx.strokeStyle = 'rgba(255,179,71,0.35)'; ctx.lineWidth = 1;
      const m = R * 1.62;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.beginPath(); ctx.moveTo(cx + sx * m, cy + sy * (m - 12)); ctx.lineTo(cx + sx * m, cy + sy * m); ctx.lineTo(cx + sx * (m - 12), cy + sy * m); ctx.stroke();
      }
    }
    // Leicht: 30 Bilder/s. Automatisch: misst die Bildzeiten und schaltet bei Ruckeln auf „Leicht“.
    let lastDrawn = 0, samples = 0, slow = 0;
    function loop(now) {
      raf = requestAnimationFrame(loop);
      if (covered()) return;
      const gap = now - lastDrawn;
      if (lite() && gap < 30) return;
      if (lastDrawn && gap < 200) { samples++; if (gap > (lite() ? 45 : 24)) slow++; }
      if (samples >= 120) { if (slow / samples > 0.35) window.JarvisQuality.reportSlow(); samples = slow = 0; }
      lastDrawn = now;
      frame(now);
    }
    function sync(on) { cancelAnimationFrame(raf); last = performance.now(); lastDrawn = 0; if (on && !document.hidden) raf = requestAnimationFrame(loop); else frame(performance.now()); }
    window.JarvisQuality.onChange(() => resize());
    resize();
    addEventListener('resize', () => { resize(); if (!allowed()) frame(performance.now()); }, { passive: true });
    document.addEventListener('visibilitychange', () => sync(allowed()));
    new MutationObserver(() => { if (!allowed()) frame(performance.now()); }).observe(app, { attributes: true, attributeFilter: ['data-core'] });
    window.JarvisMotion.onChange(sync);
    sync(allowed());
  })();

  // --- Startanimation: Weltkarte → Deutschland → Miltitz ------------------------------------------
  // --- Startmusik: eigene Datei, nur auf diesem Gerät gespeichert (IndexedDB), nie im öffentlichen Projekt ---
  const media = (() => {
    const open = () => new Promise((res, rej) => { const r = indexedDB.open('jarvis-media', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('files', mode); const out = fn(t.objectStore('files')); t.oncomplete = () => res(out?.result); t.onerror = () => rej(t.error); }); };
    return {
      get: () => tx('readonly', s => s.get('intro')).catch(() => null),
      put: (blob) => tx('readwrite', s => s.put(blob, 'intro')),
      del: () => tx('readwrite', s => s.delete('intro'))
    };
  })();
  const MUSIC_VOL_KEY = 'jarvis_intro_music_volume_v1';
  window.JarvisIntroMusic = {
    async save(file) {
      if (!file || !/^audio\//.test(file.type || 'audio/')) throw new Error('Bitte eine Audiodatei wählen (z. B. MP3 oder M4A).');
      if (file.size > 25 * 1024 * 1024) throw new Error('Die Datei ist größer als 25 MB.');
      await media.put(new Blob([await file.arrayBuffer()], { type: file.type || 'audio/mpeg' }));
      write('jarvis_intro_music_name_v1', file.name.slice(0, 80));
    },
    async remove() { await media.del(); write('jarvis_intro_music_name_v1', ''); },
    get: () => media.get(),
    name: () => read('jarvis_intro_music_name_v1', ''),
    volume: () => Math.max(0, Math.min(1, Number(read(MUSIC_VOL_KEY, '0.8')) || 0.8)),
    setVolume: (v) => write(MUSIC_VOL_KEY, String(v))
  };

  (function intro() {
    const screen = el('bootSequence');
    if (!screen) { document.body.classList.add('intro-done'); return; }
    const canvas = el('introCanvas');
    let done = false, raf = 0, geo = null, start = 0, ctx, w = 0, h = 0;
    const timers = [];
    function finish() {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf); timers.forEach(clearTimeout);
      fadeMusic(2500);
      screen.classList.add('boot-hidden');
      document.body.classList.add('intro-done');
      setTimeout(() => screen.remove(), 950);
      if (window.JarvisMotion.systemReduced() && mode() === 'system' && read('jarvis_motion_hint_v1', '') !== 'shown') {
        write('jarvis_motion_hint_v1', 'shown');
        setTimeout(() => { const t = el('n1Toast'); if (t) { t.textContent = 'Animationen sind aus, weil auf diesem Gerät „Bewegung reduzieren“ an ist. Einschalten: Einstellungen → Design → Animationen → Immer an.'; t.style.display = 'block'; setTimeout(() => { t.style.display = 'none'; }, 7000); } }, 1200);
      }
    }
    let music = null;
    function fadeMusic(ms) {
      if (!music) return;
      const a = music, from = a.volume, t0 = performance.now();
      const step = () => { const k = Math.min(1, (performance.now() - t0) / ms); a.volume = from * (1 - k); if (k < 1) requestAnimationFrame(step); else { a.pause(); URL.revokeObjectURL(a.src); } };
      requestAnimationFrame(step);
      music = null;
    }
    el('bootSkip')?.addEventListener('click', finish, { once: true });
    timers.push(setTimeout(finish, 22000)); // Sicherheitsnetz
    if (read(INTRO_KEY, '1') === '0') { finish(); return; }

    const motionBtn = el('introMotion');
    if (!allowed() && window.JarvisMotion.systemReduced() && motionBtn) {
      motionBtn.hidden = false;
      motionBtn.addEventListener('click', () => { setMode('on'); motionBtn.hidden = true; timers.forEach(clearTimeout); timers.length = 0; timers.push(setTimeout(finish, 22000)); run(); });
    }

    const D = Math.PI / 180;
    function project(lon, lat, lon0, lat0, k, cx, cy) {
      const l = lon * D, p = lat * D, l0 = lon0 * D, p0 = lat0 * D;
      const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l - l0);
      if (cosc < 0) return null;
      return [cx + k * Math.cos(p) * Math.sin(l - l0), cy - k * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l - l0))];
    }
    function strokeLines(lines, view, color, width, alpha) {
      if (alpha <= 0.01) return;
      ctx.beginPath();
      for (const line of lines) {
        let pen = false;
        for (let i = 0; i < line.length; i += 2) {
          const q = project(line[i], line[i + 1], view.lon, view.lat, view.k, view.cx, view.cy);
          if (!q || q[0] < -200 || q[0] > w + 200 || q[1] < -200 || q[1] > h + 200) { pen = false; continue; }
          if (pen) ctx.lineTo(q[0], q[1]); else { ctx.moveTo(q[0], q[1]); pen = true; }
        }
      }
      ctx.globalAlpha = alpha * 0.35; ctx.strokeStyle = color; ctx.lineWidth = width * 3.5; ctx.stroke();
      ctx.globalAlpha = alpha; ctx.lineWidth = width; ctx.stroke();
      ctx.globalAlpha = 1;
    }
    function graticule(view, step, alpha) {
      if (alpha <= 0.01) return;
      const lines = [];
      for (let lon = -180; lon < 180; lon += step) { const l = []; for (let lat = -80; lat <= 80; lat += 2) l.push(lon, lat); lines.push(l); }
      for (let lat = -80; lat <= 80; lat += step) { const l = []; for (let lon = -180; lon <= 180; lon += 2) l.push(lon, lat); lines.push(l); }
      ctx.beginPath();
      for (const line of lines) {
        let pen = false;
        for (let i = 0; i < line.length; i += 2) {
          const q = project(line[i], line[i + 1], view.lon, view.lat, view.k, view.cx, view.cy);
          if (!q) { pen = false; continue; }
          if (pen) ctx.lineTo(q[0], q[1]); else { ctx.moveTo(q[0], q[1]); pen = true; }
        }
      }
      ctx.globalAlpha = alpha; ctx.strokeStyle = 'rgba(255,179,71,0.5)'; ctx.lineWidth = 0.6; ctx.stroke(); ctx.globalAlpha = 1;
    }
    const ease = (x) => x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x);
    const lerp = (a, b, t) => a + (b - a) * t;
    const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;
    // Ruhige Kamerafahrt in Etappen mit Haltepunkten. Zoom = Vielfaches des Globusradius.
    // [Startzeit ms, Länge, Breite, Zoom]  – zwischen zwei Punkten wird weich übergeblendet.
    const KEYS = [
      [0, -25, 22, 1], [1200, -25, 22, 1],          // Erde ruht kurz
      [4200, 10, 49, 1.15],                          // langsame Drehung nach Europa
      [6200, 10.4, 51.1, 3.4], [7600, 10.4, 51.1, 3.4],   // Deutschland, Halt
      [9800, 13.9, 51.15, 16], [11200, 13.9, 51.15, 16],  // Sachsen / Oberlausitz, Halt
      [13600, HOME.lon, HOME.lat, 190], [16500, HOME.lon, HOME.lat, 205] // Miltitz, Zielerfassung
    ];
    const TOTAL = 17000;
    const CAPTIONS = [
      [600, 3600, 'ERDE', 'Verbinde mit dem Satellitennetz'],
      [5600, 8600, 'DEUTSCHLAND', ''],
      [9900, 12600, 'SACHSEN · OBERLAUSITZ', ''],
      [13900, 99999, 'MILTITZ', 'Gemeinde Nebelschütz · Ziel erfasst']
    ];
    function camera(ms) {
      let i = 0;
      while (i < KEYS.length - 2 && ms >= KEYS[i + 1][0]) i++;
      const a = KEYS[i], b = KEYS[i + 1];
      const t = ease(clamp01((ms - a[0]) / Math.max(1, b[0] - a[0])));
      // Zoom logarithmisch blenden, sonst wirkt das Heranfliegen am Ende zu schnell.
      return { lon: lerp(a[1], b[1], t), lat: lerp(a[2], b[2], t), z: Math.exp(lerp(Math.log(a[3]), Math.log(b[3]), t)) };
    }
    // Ruhige, einfarbige Punktkarte (kein Funkeln, keine Überblendung)
    function dots(arr, stride, view, step, alpha, color, highlight) {
      if (!arr || alpha <= 0.01) return;
      const size = Math.max(1, Math.min(4.2, step * view.k * 0.4));
      for (const flag of [0, 1]) {
        if (flag && !highlight) break;
        ctx.beginPath();
        for (let i = 0; i < arr.length; i += stride) {
          if (highlight && (arr[i + 2] === 1) !== Boolean(flag)) continue;
          const q = project(arr[i], arr[i + 1], view.lon, view.lat, view.k, view.cx, view.cy);
          if (!q || q[0] < -6 || q[0] > w + 6 || q[1] < -6 || q[1] > h + 6) continue;
          ctx.rect(q[0] - size / 2, q[1] - size / 2, size, size);
        }
        ctx.fillStyle = flag ? highlight : color;
        ctx.globalAlpha = alpha * (flag ? 1 : highlight ? 0.45 : 1);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    function label(text, x, y, opts = {}) {
      ctx.font = (opts.weight || 700) + ' ' + (opts.size || 13) + 'px Rajdhani, sans-serif';
      const tw = ctx.measureText(text).width, padX = 7, hh = (opts.size || 13) + 8;
      const left = opts.align === 'left' ? x - tw - padX * 2 - 10 : x + 10;
      ctx.fillStyle = 'rgba(6,5,4,0.78)';
      ctx.fillRect(left, y - hh / 2, tw + padX * 2, hh);
      ctx.fillStyle = opts.color || '#ffffff';
      ctx.fillText(text, left + padX, y + (opts.size || 13) * 0.36);
      return [left, y - hh / 2, left + tw + padX * 2, y + hh / 2];
    }
    function render(ms) {
      const cx = w / 2, cy = h * 0.5;
      const R = Math.min(w, h) * 0.36;
      const cam = camera(ms);
      const view = { lon: cam.lon, lat: cam.lat, k: R * cam.z, cx, cy };
      const z = cam.z;
      ctx.clearRect(0, 0, w, h);
      // Globus mit sanfter Atmosphäre, blendet beim Heranfliegen aus
      const globeA = clamp01(1 - (z - 1.2) / 3);
      if (globeA > 0) {
        const g = ctx.createRadialGradient(cx, cy, view.k * 0.92, cx, cy, view.k * 1.14);
        g.addColorStop(0, 'rgba(255,160,60,0)'); g.addColorStop(0.5, 'rgba(255,160,60,' + 0.14 * globeA + ')'); g.addColorStop(1, 'rgba(255,160,60,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, view.k * 1.14, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(16,12,8,' + 0.9 * globeA + ')'; ctx.beginPath(); ctx.arc(cx, cy, view.k, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,179,71,' + 0.35 * globeA + ')'; ctx.lineWidth = 1; ctx.stroke();
      }
      graticule(view, z < 3 ? 20 : 5, 0.1 * clamp01(1 - (z - 8) / 10));
      if (geo) {
        const worldA = clamp01(1 - (z - 4) / 6), regionA = clamp01((z - 2.2) / 2) * clamp01(1 - (z - 60) / 60), localA = clamp01((z - 30) / 40);
        const deA = clamp01((z - 1.8) / 1.6);
        dots(geo.dots.world, 2, view, 1.8 * D, 0.55 * worldA, 'rgba(200,175,140,1)');
        dots(geo.dots.region, 3, view, 0.32 * D, 0.8 * regionA, 'rgba(150,130,105,1)', 'rgba(255,190,100,1)');
        dots(geo.dots.local, 3, view, 0.03 * D, 0.35 * localA * clamp01(1 - (z - 150) / 50), 'rgba(150,130,105,1)', 'rgba(230,175,100,1)');
        dots(geo.dots.near, 3, view, 0.011 * D, 0.5 * clamp01((z - 140) / 50), 'rgba(210,165,100,1)');
        strokeLines(geo.lines.world, view, '#d9b98a', 0.6, 0.22 * worldA);
        strokeLines(geo.lines.water || [], view, '#6fb9cc', 1.1, 0.45 * clamp01((z - 10) / 12));
        // Deutschland: ruhige, durchgezogene Goldlinie (kein Lauflicht)
        strokeLines(geo.lines.de, view, '#ffc069', 1.4, 0.9 * deA * clamp01(1 - (z - 120) / 80));
      }
      const taken = [];
      const homePt = project(HOME.lon, HOME.lat, view.lon, view.lat, view.k, cx, cy);
      if (homePt && ms > 9000) taken.push([homePt[0] - 70, homePt[1] - 70, homePt[0] + 70, homePt[1] + 70]); // Platz für den Zielrahmen
      const free = (r) => !taken.some(o => r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1]);
      // Wenige, gut lesbare Orte
      for (const t of TOWNS) {
        const a = t.tier === 1 ? clamp01((z - 3) / 2) * clamp01(1 - (z - 12) / 6)
          : t.tier === 2 ? clamp01((z - 22) / 10) * clamp01(1 - (z - 150) / 30)
          : clamp01((z - 150) / 40);
        if (a <= 0.02) continue;
        if (t.tier === 1 && !['BERLIN', 'DRESDEN', 'LEIPZIG', 'PRAG'].includes(t.name)) continue;
        if (t.tier === 2 && !['BAUTZEN', 'GÖRLITZ', 'HOYERSWERDA', 'COTTBUS'].includes(t.name)) continue;
        if (t.tier === 3 && !['KAMENZ', 'BISCHOFSWERDA', 'WITTICHENAU', 'PULSNITZ'].includes(t.name)) continue;
        const q = project(t.lon, t.lat, view.lon, view.lat, view.k, cx, cy);
        if (!q || q[0] < 20 || q[0] > w - 20 || q[1] < 60 || q[1] > h - 60) continue;
        const km = distKm(HOME, t);
        const text = t.tier === 3 ? t.name + '  ' + (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km' : t.name;
        ctx.font = '700 12px Rajdhani, sans-serif';
        const tw = ctx.measureText(text).width + 24;
        const r = [q[0] + 10, q[1] - 11, q[0] + 10 + tw, q[1] + 11], l = [q[0] - 10 - tw, q[1] - 11, q[0] - 10, q[1] + 11];
        const side = free(r) ? 'r' : free(l) ? 'l' : null;
        if (!side) continue;
        ctx.globalAlpha = a;
        ctx.fillStyle = '#ffd08a'; ctx.beginPath(); ctx.arc(q[0], q[1], 3, 0, Math.PI * 2); ctx.fill();
        taken.push(label(text, q[0], q[1], { size: 12, align: side === 'l' ? 'left' : 'right', color: '#f4ece0' }));
        ctx.globalAlpha = 1;
      }
      // Zielerfassung Miltitz
      const home = project(HOME.lon, HOME.lat, view.lon, view.lat, view.k, cx, cy);
      if (home && ms > 9000) {
        const mark = clamp01((ms - 9000) / 800);
        ctx.globalAlpha = mark;
        for (let r = 0; r < 2; r++) {
          const pulse = ((ms / 2200) + r / 2) % 1;
          ctx.strokeStyle = 'rgba(255,90,60,' + (0.55 * (1 - pulse)) + ')'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(home[0], home[1], 6 + pulse * Math.min(w, h) * 0.12, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.fillStyle = '#ff5a3c'; ctx.save(); ctx.translate(home[0], home[1]); ctx.rotate(Math.PI / 4); ctx.fillRect(-4.5, -4.5, 9, 9); ctx.restore();
        ctx.globalAlpha = 1;
        const lock = ease((ms - 14200) / 1400);
        if (lock > 0) {
          const size = lerp(Math.min(w, h) * 0.4, 44, lock);
          ctx.strokeStyle = 'rgba(255,200,120,' + (0.3 + 0.7 * lock) + ')'; ctx.lineWidth = 1.6;
          for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            ctx.beginPath();
            ctx.moveTo(home[0] + sx * size, home[1] + sy * (size - 14)); ctx.lineTo(home[0] + sx * size, home[1] + sy * size); ctx.lineTo(home[0] + sx * (size - 14), home[1] + sy * size);
            ctx.stroke();
          }
          if (z > 120) {
            const pxPerKm = view.k / 6371, rr = 5 * pxPerKm;
            ctx.globalAlpha = lock * 0.8; ctx.setLineDash([3, 6]); ctx.strokeStyle = 'rgba(255,200,120,0.45)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(home[0], home[1], rr, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
            ctx.font = '700 11px Rajdhani, sans-serif'; ctx.fillStyle = 'rgba(255,220,170,0.85)'; ctx.fillText('5 KM', home[0] + rr * 0.7071 + 4, home[1] - rr * 0.7071 - 2);
            ctx.globalAlpha = 1;
          }
        }
      }
      // HUD und große Bildunterschrift
      const st = ms < 5600 ? ['ORBIT', 'SATELLITENLINK …'] : ms < 9900 ? ['DEUTSCHLAND', 'ANFLUG …'] : ms < 13900 ? ['OBERLAUSITZ', 'ZIEL WIRD GESUCHT …'] : ['ZIEL', 'STANDORT BESTÄTIGT'];
      el('introStage').textContent = st[0];
      el('bootStatus').textContent = st[1];
      el('introCoords').textContent = 'LAT ' + view.lat.toFixed(3) + ' · LON ' + view.lon.toFixed(3);
      el('introZoom').textContent = (z < 10 ? z.toFixed(1) : Math.round(z)) + '×';
      el('bootPercent').textContent = String(Math.min(100, Math.round(ms / TOTAL * 100))).padStart(2, '0') + '%';
      const cap = CAPTIONS.find(c => ms >= c[0] && ms < c[1]);
      const capEl = el('introCaption');
      if (capEl) {
        const key = cap ? cap[2] : '';
        if (capEl.dataset.key !== key) {
          capEl.dataset.key = key;
          capEl.classList.remove('is-on');
          if (cap) { el('introCapMain').textContent = cap[2]; el('introCapSub').textContent = cap[3]; requestAnimationFrame(() => capEl.classList.add('is-on')); }
        }
      }
      const target = el('introTarget');
      const name = ((typeof data !== 'undefined' && data?.profile?.name) || '').trim();
      target.textContent = ms > 15400 ? 'Willkommen zurück' + (name ? ', ' + name : '') + '.' : '';
    }
    function tick(now) {
      if (!start) start = now;
      const ms = now - start;
      render(ms);
      if (ms >= TOTAL) { finish(); return; }
      raf = requestAnimationFrame(tick);
    }
    function resize() { w = innerWidth; h = innerHeight; ctx = fitCanvas(canvas, w, h, 2); }
    // Mit Startmusik: erst ein Tipp (iPad/iPhone spielen Ton nur nach einer Berührung ab), dann Musik und Flug zusammen.
    async function begin() {
      const blob = await window.JarvisIntroMusic.get();
      if (done) return;
      // Startknopf, wenn Musik gewählt ist oder JARVIS mit offenem Mikrofon starten soll (ein Tipp gibt beides frei).
      const voice = (typeof data === 'undefined' || data?.profile?.handsFree !== false) && typeof apiBase === 'function' && apiBase() && typeof hasCredentials === 'function' && hasCredentials();
      if (!blob && !voice) { run(); return; }
      el('introGate').querySelector('small').textContent = blob && voice ? 'Tippen – Musik & Mikrofon' : blob ? 'Tippen – mit Musik' : 'Tippen – JARVIS hört zu';
      const gate = el('introGate');
      timers.forEach(clearTimeout); timers.length = 0; // auf den Tipp warten
      gate.hidden = false;
      gate.addEventListener('click', () => {
        gate.hidden = true;
        if (voice) window.JarvisSpeech?.handsFreeStart();
        if (blob) {
          music = new Audio(URL.createObjectURL(blob));
          music.volume = window.JarvisIntroMusic.volume();
          music.play().catch(() => { music = null; });
        }
        timers.push(setTimeout(finish, 22000));
        run();
      }, { once: true });
    }
    function run() {
      cancelAnimationFrame(raf); start = 0;
      if (allowed()) raf = requestAnimationFrame(tick);
      else { render(16000); timers.push(setTimeout(finish, 2600)); }
    }
    resize();
    addEventListener('resize', () => { if (!done) { resize(); if (!allowed()) render(16000); } }, { passive: true });
    fetch('assets/geo/geo.json').then(r => r.ok ? r.json() : null).then(data => { geo = data; if (!allowed() && !done) render(16000); }).catch(() => { geo = null; });
    begin();
  })();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountMotionPanel); else mountMotionPanel();
})();
