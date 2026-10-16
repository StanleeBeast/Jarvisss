// JARVIS WhatsApp-Export lesen – läuft vollständig auf dem Gerät.
// Unterstützt: „Chat exportieren“ (ohne Medien) als .txt oder .zip im iPhone- und Android-Format, sowie eingefügten Text.
// Pseudonymisierung: Namen anderer Personen werden vor dem Senden durch „Person A/B/…“ ersetzt, Telefonnummern und
// E-Mail-Adressen maskiert. Die Zuordnung bleibt auf dem Gerät.
(function (root) {
  'use strict';
  const IOS = /^\[(\d{1,2})\.(\d{1,2})\.(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s+([^:]{1,60}?):\s?([\s\S]*)$/;
  const ANDROID = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+-\s+([^:]{1,60}?):\s?([\s\S]*)$/;
  const MEDIA = /(Medien ausgeschlossen|weggelassen|<Media omitted>|image omitted|video omitted|audio omitted|sticker omitted|Diese Nachricht wurde gelöscht|This message was deleted)/i;
  const SYSTEM = /(Ende-zu-Ende-verschlüsselt|end-to-end encrypted|hat die Gruppe|hat dich hinzugefügt|ist beigetreten|hat die Gruppenbeschreibung|changed the group|joined using)/i;
  const clean = (s) => String(s).replace(/[‎‏‪-‮]/g, '').replace(/[  ]/g, ' ');

  function parseChat(input) {
    const lines = clean(input).replace(/\r\n?/g, '\n').split('\n');
    const messages = [];
    let skipped = 0, current = null;
    const push = () => {
      if (!current) return;
      const text = current.text.trim();
      if (!text || MEDIA.test(text) || SYSTEM.test(text)) skipped++;
      else messages.push({ ...current, text });
      current = null;
    };
    for (const line of lines) {
      const m = IOS.exec(line) || ANDROID.exec(line);
      if (m) {
        push();
        const [, d, mo, y, h, mi, sec, sender, text] = m;
        const year = y.length === 2 ? 2000 + Number(y) : Number(y);
        const at = new Date(year, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec || 0));
        current = { at: Number.isNaN(at.valueOf()) ? null : at.toISOString(), sender: sender.trim(), text };
      } else if (current) current.text += '\n' + line;
      else if (line.trim()) skipped++;
    }
    push();
    if (messages.length) return { messages, skipped, format: 'whatsapp' };
    // Eingefügter Text ohne Zeitstempel: „Name: Text“ pro Zeile, sonst alles als eine Nachricht.
    const simple = lines.map(l => /^([^:]{1,40}):\s+(.+)$/.exec(l.trim())).filter(Boolean);
    if (simple.length) return { messages: simple.map(([, sender, text]) => ({ at: null, sender: sender.trim(), text: text.trim() })), skipped: 0, format: 'lines' };
    const text = clean(input).trim();
    return { messages: text ? [{ at: null, sender: 'Unbekannt', text }] : [], skipped: 0, format: 'plain' };
  }

  function filterRecent(messages, days, max = 400, now = Date.now()) {
    const from = days ? now - days * 86_400_000 : -Infinity;
    const kept = messages.filter(m => !m.at || Date.parse(m.at) >= from);
    return kept.slice(-max);
  }

  const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = (i) => 'Person ' + (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(65 + Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));
  function maskContacts(text) {
    return text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[E-Mail]').replace(/\+?\d[\d\s/()-]{7,}\d/g, '[Telefonnummer]');
  }
  function pseudonymize(messages, ownName, rules = '') {
    const own = (ownName || '').trim().toLowerCase();
    const map = new Map(), reverse = {};
    let n = 0;
    for (const m of messages) {
      const key = m.sender.trim();
      if (map.has(key)) continue;
      if (own && key.toLowerCase() === own) { map.set(key, 'Ich'); continue; }
      const pseudo = label(n++);
      map.set(key, pseudo);
      reverse[pseudo] = key;
    }
    // Volle Namen und Vornamen (ab 3 Zeichen) auch im Text und in den Regeln ersetzen, längste zuerst.
    const names = [];
    for (const [real, pseudo] of map) {
      if (pseudo === 'Ich') continue;
      names.push([real, pseudo]);
      const first = real.split(/\s+/)[0];
      if (first && first !== real && first.length >= 3 && !/^\+?\d/.test(first)) names.push([first, pseudo]);
    }
    names.sort((a, b) => b[0].length - a[0].length);
    const replaceNames = (text) => names.reduce((t, [real, pseudo]) => t.replace(new RegExp('(^|[^\\p{L}])' + escapeRx(real) + '(?=$|[^\\p{L}])', 'giu'), '$1' + pseudo), text);
    return {
      messages: messages.map(m => ({ ...m, sender: map.get(m.sender.trim()), text: maskContacts(replaceNames(m.text)) })),
      rules: replaceNames(rules),
      mapping: reverse
    };
  }
  function restoreNames(text, mapping) {
    if (!mapping) return text;
    return Object.keys(mapping).sort((a, b) => b.length - a.length).reduce((t, pseudo) => t.split(pseudo).join(mapping[pseudo]), String(text));
  }

  async function readZip(buffer) {
    const dv = new DataView(buffer);
    let eocd = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65_557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not_a_zip');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let i = 0; i < count && dv.getUint32(p, true) === 0x02014b50; i++) {
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
      entries.push({ method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), local: dv.getUint32(p + 42, true), name: new TextDecoder().decode(new Uint8Array(buffer, p + 46, nameLen)) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    const entry = entries.find(e => /(^|\/)_chat\.txt$/i.test(e.name)) || entries.find(e => /\.txt$/i.test(e.name));
    if (!entry) throw new Error('no_chat_in_zip');
    const start = entry.local + 30 + dv.getUint16(entry.local + 26, true) + dv.getUint16(entry.local + 28, true);
    const data = new Uint8Array(buffer, start, entry.size);
    if (entry.method === 0) return new TextDecoder().decode(data);
    if (entry.method !== 8) throw new Error('unsupported_zip');
    if (typeof DecompressionStream === 'undefined') throw new Error('zip_not_supported');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }

  root.JarvisWhatsApp = { parseChat, filterRecent, pseudonymize, restoreNames, readZip, maskContacts };
})(typeof window !== 'undefined' ? window : globalThis);
