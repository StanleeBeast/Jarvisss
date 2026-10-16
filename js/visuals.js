// JARVIS Visuals: Animations-Schalter, Topografie-Hintergrund, Partikel-ORB und Startanimation
// (Weltkarte → Deutschland → Miltitz). Alles läuft lokal im Browser (Canvas), ohne externe Abrufe.
// Kartendaten: Natural Earth über world-atlas (gemeinfrei), vorbereitet in assets/geo/geo.json.
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  const HOME = { lat: 51.255, lon: 14.18, name: 'MILTITZ · NEBELSCHÜTZ' };
  const TOWNS = [
    { name: 'KAMENZ', lat: 51.268, lon: 14.094 },
    { name: 'BAUTZEN', lat: 51.181, lon: 14.424 },
    { name: 'DRESDEN', lat: 51.050, lon: 13.737 },
    { name: 'HOYERSWERDA', lat: 51.438, lon: 14.235 },
    { name: 'BISCHOFSWERDA', lat: 51.127, lon: 14.180 }
  ];

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

  // Bedienelement im Bereich „Design“
  function renderMotionPanel() {
    const box = el('motionPanel');
    if (!box) return;
    box.querySelectorAll('[data-motion]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.motion === mode())));
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
      + '<label class="hint"><input type="checkbox" id="introToggle" style="width:auto;margin-right:8px">Startanimation (Weltkarte → Miltitz) beim Öffnen zeigen</label>';
    grid.prepend(panel);
    panel.querySelectorAll('[data-motion]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.motion)));
    el('introToggle').addEventListener('change', (e) => write(INTRO_KEY, e.target.checked ? '1' : '0'));
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
    function resize() { w = innerWidth; h = innerHeight; ctx = fitCanvas(canvas, w, h, 1.5); draw(); }
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
    function loop() {
      frame++;
      if (frame % 3 === 0) { t += 0.0022; draw(); } // ~20 Bilder pro Sekunde reichen und sparen Akku
      raf = requestAnimationFrame(loop);
    }
    function sync(on) { cancelAnimationFrame(raf); if (on && !document.hidden) raf = requestAnimationFrame(loop); else draw(); }
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
    const N = Math.min(2200, Math.max(1100, Math.round((innerWidth * innerHeight) / 600)));
    const pts = [];
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
    function resize() { const r = canvas.getBoundingClientRect(); w = Math.max(1, r.width); h = Math.max(1, r.height); ctx = fitCanvas(canvas, w, h, 2); }
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
      // Partikel
      ctx.globalCompositeOperation = 'lighter';
      const cosR = Math.cos(rot), sinR = Math.sin(rot), cosT = Math.cos(tilt), sinT = Math.sin(tilt);
      const amp = st.amp + en * 0.12;
      for (const p of pts) {
        // Verformung: Rauschen auf der Kugeloberfläche, beim Sprechen stärker
        const n = noise3(p.x * 1.6 + t * 0.5, p.y * 1.6 + t * 0.35, p.z * 1.6 + t * 0.6) - 0.5;
        const swirl = core === 'processing' ? Math.sin(p.y * 6 + t * 4) * 0.05 : 0;
        const rr = 1 + n * amp * 2.4 + swirl + flash * 0.08 * Math.sin(p.ph + t * 9);
        let x = p.x * rr, y = p.y * rr, z = p.z * rr;
        const x1 = x * cosR - z * sinR, z1 = x * sinR + z * cosR;
        const y2 = y * cosT - z1 * sinT, z2 = y * sinT + z1 * cosT;
        const persp = 2.6 / (2.6 - z2);
        const sx = cx + x1 * R * persp, sy = cy + y2 * R * persp;
        const depth = (z2 + 1) / 2;
        const tw = 0.6 + 0.4 * Math.sin(p.ph + t * (1.5 + p.s * 2));
        const a = Math.min(1, (0.18 + depth * 0.9) * tw);
        const size = (0.7 + depth * 1.9 + p.s * 0.7) * (1 + en * 0.3);
        const hot = depth > 0.82 && p.s > 0.7;
        ctx.fillStyle = hot ? 'rgba(255,244,220,' + a + ')' : 'rgba(' + cr + ',' + cg + ',' + cb + ',' + a + ')';
        ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
      }
      ctx.globalCompositeOperation = 'source-over';
      // Zielmarken um die Kugel
      ctx.strokeStyle = 'rgba(255,179,71,0.35)'; ctx.lineWidth = 1;
      const m = R * 1.62;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.beginPath(); ctx.moveTo(cx + sx * m, cy + sy * (m - 12)); ctx.lineTo(cx + sx * m, cy + sy * m); ctx.lineTo(cx + sx * (m - 12), cy + sy * m); ctx.stroke();
      }
    }
    function loop(now) { frame(now); raf = requestAnimationFrame(loop); }
    function sync(on) { cancelAnimationFrame(raf); last = performance.now(); if (on && !document.hidden) raf = requestAnimationFrame(loop); else frame(performance.now()); }
    resize();
    addEventListener('resize', () => { resize(); if (!allowed()) frame(performance.now()); }, { passive: true });
    document.addEventListener('visibilitychange', () => sync(allowed()));
    new MutationObserver(() => { if (!allowed()) frame(performance.now()); }).observe(app, { attributes: true, attributeFilter: ['data-core'] });
    window.JarvisMotion.onChange(sync);
    sync(allowed());
  })();

  // --- Startanimation: Weltkarte → Deutschland → Miltitz ------------------------------------------
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
      screen.classList.add('boot-hidden');
      document.body.classList.add('intro-done');
      setTimeout(() => screen.remove(), 950);
      if (window.JarvisMotion.systemReduced() && mode() === 'system' && read('jarvis_motion_hint_v1', '') !== 'shown') {
        write('jarvis_motion_hint_v1', 'shown');
        setTimeout(() => { const t = el('n1Toast'); if (t) { t.textContent = 'Animationen sind aus, weil auf diesem Gerät „Bewegung reduzieren“ an ist. Einschalten: Einstellungen → Design → Animationen → Immer an.'; t.style.display = 'block'; setTimeout(() => { t.style.display = 'none'; }, 7000); } }, 1200);
      }
    }
    el('bootSkip')?.addEventListener('click', finish, { once: true });
    timers.push(setTimeout(finish, 14000)); // Sicherheitsnetz
    if (read(INTRO_KEY, '1') === '0') { finish(); return; }

    const motionBtn = el('introMotion');
    if (!allowed() && window.JarvisMotion.systemReduced() && motionBtn) {
      motionBtn.hidden = false;
      motionBtn.addEventListener('click', () => { setMode('on'); motionBtn.hidden = true; timers.forEach(clearTimeout); timers.length = 0; timers.push(setTimeout(finish, 14000)); run(); });
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
    const TOTAL = 7600;
    function render(ms) {
      const cx = w / 2, cy = h * 0.54;
      const R = Math.min(w, h) * 0.34;
      const kEnd = w / (0.9 * D); // am Ende ca. 0,9 Längengrade (~60 km) über die Breite
      const tRot = ease((ms - 200) / 2600), tZoom = ease((ms - 2300) / 3000);
      const view = {
        lon: lerp(-35, HOME.lon, tRot), lat: lerp(18, HOME.lat, tRot),
        k: R * Math.pow(kEnd / R, tZoom), cx, cy
      };
      const z = view.k / R;
      ctx.clearRect(0, 0, w, h);
      // Globus-Scheibe und Atmosphäre
      const globeAlpha = Math.max(0, 1 - Math.log(z) / Math.log(6));
      if (globeAlpha > 0) {
        const g = ctx.createRadialGradient(cx, cy, view.k * 0.7, cx, cy, view.k * 1.12);
        g.addColorStop(0, 'rgba(255,150,40,0)'); g.addColorStop(0.85, 'rgba(255,150,40,' + 0.18 * globeAlpha + ')'); g.addColorStop(1, 'rgba(255,150,40,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, view.k * 1.12, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(20,14,8,' + 0.85 * globeAlpha + ')'; ctx.beginPath(); ctx.arc(cx, cy, view.k, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,179,71,' + 0.5 * globeAlpha + ')'; ctx.lineWidth = 1; ctx.stroke();
      }
      graticule(view, z < 4 ? 15 : z < 40 ? 5 : 1, z < 4 ? 0.25 : 0.15);
      const intro = Math.min(1, ms / 600);
      if (geo) {
        strokeLines(geo.world, view, '#ffb347', 0.9, intro * Math.max(0, 1 - (z - 4) / 6));
        strokeLines(geo.region, view, '#ffc062', 1.1, Math.min(1, Math.max(0, (z - 3) / 4)) * Math.max(0.25, 1 - (z - 60) / 120));
        strokeLines(geo.local, view, '#ffd38a', 1.6, Math.min(1, Math.max(0, (z - 25) / 30)));
      }
      // Städte in der Nähe
      const townAlpha = Math.min(1, Math.max(0, (z - 120) / 80));
      if (townAlpha > 0) {
        ctx.font = '700 11px Rajdhani, sans-serif';
        for (const t of TOWNS) {
          const q = project(t.lon, t.lat, view.lon, view.lat, view.k, cx, cy);
          if (!q) continue;
          ctx.globalAlpha = townAlpha * 0.85;
          ctx.fillStyle = '#ffb347'; ctx.fillRect(q[0] - 2, q[1] - 2, 4, 4);
          ctx.fillStyle = 'rgba(255,220,170,0.85)'; ctx.fillText(t.name, q[0] + 7, q[1] + 4);
        }
        ctx.globalAlpha = 1;
      }
      // Zielerfassung auf Miltitz
      const home = project(HOME.lon, HOME.lat, view.lon, view.lat, view.k, cx, cy);
      const lock = ease((ms - 4600) / 1300);
      if (home && ms > 2600) {
        const pulse = (ms / 900) % 1;
        ctx.strokeStyle = 'rgba(255,68,51,' + (0.7 * (1 - pulse)) + ')'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(home[0], home[1], 6 + pulse * 26, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#ff4433'; ctx.save(); ctx.translate(home[0], home[1]); ctx.rotate(Math.PI / 4); ctx.fillRect(-4, -4, 8, 8); ctx.restore();
        if (lock > 0) {
          const size = lerp(Math.max(w, h) * 0.5, 46, lock);
          ctx.strokeStyle = 'rgba(255,179,71,' + (0.4 + 0.6 * lock) + ')'; ctx.lineWidth = 1.4;
          for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            ctx.beginPath();
            ctx.moveTo(home[0] + sx * size, home[1] + sy * (size - 14)); ctx.lineTo(home[0] + sx * size, home[1] + sy * size); ctx.lineTo(home[0] + sx * (size - 14), home[1] + sy * size);
            ctx.stroke();
          }
          ctx.globalAlpha = lock;
          ctx.beginPath(); ctx.moveTo(home[0] - size - 30, home[1]); ctx.lineTo(home[0] - 10, home[1]); ctx.moveTo(home[0] + 10, home[1]); ctx.lineTo(home[0] + size + 30, home[1]);
          ctx.moveTo(home[0], home[1] - size - 30); ctx.lineTo(home[0], home[1] - 10); ctx.moveTo(home[0], home[1] + 10); ctx.lineTo(home[0], home[1] + size + 30); ctx.stroke();
          ctx.font = '700 13px Rajdhani, sans-serif'; ctx.fillStyle = '#fff1d8';
          ctx.fillText(HOME.name, home[0] + size + 10, home[1] - size + 4);
          ctx.font = '600 11px Rajdhani, sans-serif'; ctx.fillStyle = 'rgba(255,179,71,0.9)';
          ctx.fillText(HOME.lat.toFixed(3) + '°N  ' + HOME.lon.toFixed(3) + '°E', home[0] + size + 10, home[1] - size + 20);
          ctx.globalAlpha = 1;
        }
      }
      // HUD-Texte
      const stages = [[0, 'ORBIT', 'VERBINDE SATELLITENLINK …'], [2300, 'EUROPA', 'ANFLUG EUROPA …'], [3600, 'DEUTSCHLAND', 'ANFLUG SACHSEN …'], [4600, 'OBERLAUSITZ', 'ZIEL WIRD ERFASST …'], [5900, 'ZIEL', 'STANDORT BESTÄTIGT · WILLKOMMEN ZURÜCK']];
      const s = stages.filter(x => ms >= x[0]).pop();
      el('introStage').textContent = s[1];
      el('bootStatus').textContent = s[2];
      el('introCoords').textContent = 'LAT ' + view.lat.toFixed(4) + ' · LON ' + view.lon.toFixed(4);
      el('introZoom').textContent = (z < 10 ? z.toFixed(1) : Math.round(z)) + '×';
      el('bootPercent').textContent = String(Math.min(100, Math.round(ms / TOTAL * 100))).padStart(2, '0') + '%';
      const target = el('introTarget');
      const label = 'ZIEL: ' + HOME.name;
      target.textContent = ms > 5000 ? label.slice(0, Math.min(label.length, Math.floor((ms - 5000) / 35))) : '';
    }
    function tick(now) {
      if (!start) start = now;
      const ms = now - start;
      render(ms);
      if (ms >= TOTAL) { finish(); return; }
      raf = requestAnimationFrame(tick);
    }
    function resize() { w = innerWidth; h = innerHeight; ctx = fitCanvas(canvas, w, h, 2); }
    function run() {
      cancelAnimationFrame(raf); start = 0;
      if (allowed()) raf = requestAnimationFrame(tick);
      else { render(6600); timers.push(setTimeout(finish, 2600)); }
    }
    resize();
    addEventListener('resize', () => { if (!done) { resize(); if (!allowed()) render(6600); } }, { passive: true });
    fetch('assets/geo/geo.json').then(r => r.ok ? r.json() : null).then(data => { geo = data; if (!allowed() && !done) render(6600); }).catch(() => { geo = null; });
    run();
  })();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountMotionPanel); else mountMotionPanel();
})();
