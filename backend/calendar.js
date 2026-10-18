// JARVIS Kalender (Zwischenlösung ohne native App): liest einen freigegebenen Kalender-Abo-Link (ICS).
//
// - Nur lesen. JARVIS kann keine Termine anlegen, ändern oder löschen.
// - Erlaubt sind nur Abo-Links von iCloud, Google Kalender und Outlook (https, Größen- und Zeitlimit),
//   damit der Worker keine beliebigen Adressen abruft.
// - Der Link ist wie ein Passwort: Wer ihn hat, kann den Kalender lesen. Er liegt nur in D1 und wird
//   der App nur gekürzt angezeigt.
// - Abgerufene Termine werden 15 Minuten zwischengespeichert.
import { json, clip, readJsonBody, audit } from "./http.js";
import { authenticate, actorOf } from "./auth.js";
import { safeTimezone, localToUtc } from "./time.js";

const ALLOWED_HOSTS = [/^p\d+-caldav\.icloud\.com$/, /^(www\.)?icloud\.com$/, /^calendar\.google\.com$/, /^outlook\.(office365|live)\.com$/];
const MAX_ICS_BYTES = 3_000_000;
const CACHE_MS = 15 * 60_000;
const WINDOW_PAST_DAYS = 1, WINDOW_FUTURE_DAYS = 62, MAX_INSTANCES = 1500;
const WINDOWS_TZ = { "W. Europe Standard Time": "Europe/Berlin", "Central Europe Standard Time": "Europe/Prague", "Romance Standard Time": "Europe/Paris", "GMT Standard Time": "Europe/London", "UTC": "UTC" };

// --- Abo-Link prüfen ------------------------------------------------------------------------------

export function normalizeCalendarUrl(input) {
  let raw = clip(input, 2000).trim();
  if (!raw) return { error: "calendar_url_required" };
  raw = raw.replace(/^webcals?:\/\//i, "https://");
  let url;
  try { url = new URL(raw); } catch { return { error: "invalid_calendar_url" }; }
  if (url.protocol !== "https:") return { error: "invalid_calendar_url" };
  if (!ALLOWED_HOSTS.some(rx => rx.test(url.hostname))) return { error: "calendar_host_not_allowed" };
  if (url.username || url.password || url.port) return { error: "invalid_calendar_url" };
  return { url: url.toString() };
}
export function maskUrl(url) {
  try { const u = new URL(url); return u.hostname + "/…" + u.pathname.slice(-6); } catch { return "…"; }
}

// --- ICS lesen ------------------------------------------------------------------------------------

function unfold(text) { return String(text).replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, ""); }
function unescapeText(v) { return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1"); }
function parseLine(line) {
  const i = line.indexOf(":");
  if (i < 0) return null;
  const head = line.slice(0, i), value = line.slice(i + 1);
  const [name, ...params] = head.split(";");
  const p = {};
  for (const x of params) { const [k, v] = x.split("="); if (k) p[k.toUpperCase()] = (v || "").replace(/^"|"$/g, ""); }
  return { name: name.toUpperCase(), params: p, value };
}
// Wandelt einen ICS-Zeitwert in { iso, allDay, date } um. Ganztägige Termine behalten ihr Datum.
export function parseIcsTime(value, params, fallbackTz) {
  const v = String(value || "").trim();
  if (params?.VALUE === "DATE" || /^\d{8}$/.test(v)) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { allDay: true, date: m[1] + "-" + m[2] + "-" + m[3] };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  if (m[7]) return { allDay: false, iso: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))).toISOString() };
  const tz = safeTimezone(WINDOWS_TZ[params?.TZID] || params?.TZID || fallbackTz);
  const iso = localToUtc(m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5], tz);
  return iso ? { allDay: false, iso, tz } : null;
}
export function parseIcs(text, fallbackTz = "Europe/Berlin") {
  const lines = unfold(text).split("\n");
  if (!lines.some(l => l.trim() === "BEGIN:VCALENDAR")) return { error: "not_a_calendar" };
  const events = [];
  let cur = null, depth = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === "BEGIN:VEVENT") { cur = { exdates: [] }; depth = 0; continue; }
    if (!cur) continue;
    if (line.startsWith("BEGIN:")) { depth++; continue; }   // z. B. VALARM ignorieren
    if (line.startsWith("END:") && line !== "END:VEVENT") { depth--; continue; }
    if (line === "END:VEVENT") { if (cur.start && cur.status !== "CANCELLED") events.push(cur); cur = null; continue; }
    if (depth > 0) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "SUMMARY") cur.title = clip(unescapeText(p.value), 200).trim();
    else if (p.name === "LOCATION") cur.location = clip(unescapeText(p.value), 200).trim();
    else if (p.name === "UID") cur.uid = clip(p.value, 300);
    else if (p.name === "STATUS") cur.status = p.value.toUpperCase();
    else if (p.name === "DTSTART") cur.start = parseIcsTime(p.value, p.params, fallbackTz);
    else if (p.name === "DTEND") cur.end = parseIcsTime(p.value, p.params, fallbackTz);
    else if (p.name === "DURATION") cur.duration = p.value;
    else if (p.name === "RRULE") cur.rrule = p.value;
    else if (p.name === "RECURRENCE-ID") cur.recurrenceId = parseIcsTime(p.value, p.params, fallbackTz);
    else if (p.name === "EXDATE") for (const v of p.value.split(",")) { const t = parseIcsTime(v, p.params, fallbackTz); if (t) cur.exdates.push(t.iso || t.date); }
  }
  return { events };
}

function durationMs(ev) {
  if (ev.end && ev.start) {
    if (ev.start.allDay) return Date.parse(ev.end.date + "T00:00:00Z") - Date.parse(ev.start.date + "T00:00:00Z");
    if (ev.end.iso) return Date.parse(ev.end.iso) - Date.parse(ev.start.iso);
  }
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(ev.duration || "");
  if (m) return (((+m[1] || 0) * 7 + (+m[2] || 0)) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0)) * 1000;
  return ev.start.allDay ? 86400000 : 3600000;
}
const DAYS = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };
// Lokale Bestandteile eines Zeitpunkts in einer Zeitzone (für Wiederholungen in Ortszeit, sommerzeitfest).
function localOf(iso, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}
const pad = (n) => String(n).padStart(2, "0");

// Erzeugt die einzelnen Termine im Zeitfenster. Unterstützt FREQ=DAILY/WEEKLY/MONTHLY/YEARLY mit INTERVAL,
// COUNT, UNTIL und BYDAY (wöchentlich), EXDATE und geänderte Einzeltermine (RECURRENCE-ID).
export function expandEvents(events, fromMs, toMs, fallbackTz = "Europe/Berlin") {
  const out = [];
  const overrides = new Map();
  for (const ev of events) if (ev.recurrenceId && ev.uid) overrides.set(ev.uid + "|" + (ev.recurrenceId.iso || ev.recurrenceId.date), ev);
  const emit = (ev, startMs, allDayDate) => {
    const dur = durationMs(ev);
    if (startMs + dur < fromMs || startMs > toMs) return;
    out.push({
      uid: ev.uid || null, title: ev.title || "(ohne Titel)", location: ev.location || "",
      allDay: Boolean(ev.start.allDay), date: allDayDate || null,
      start: new Date(startMs).toISOString(), end: new Date(startMs + dur).toISOString()
    });
  };
  for (const ev of events) {
    if (ev.recurrenceId) continue; // Einzeländerungen werden unten bei ihrer Serie eingesetzt
    const evTz = ev.start.tz || safeTimezone(fallbackTz);
    const baseMs = ev.start.allDay ? Date.parse(localToUtc(ev.start.date + "T00:00", evTz)) : Date.parse(ev.start.iso);
    if (!ev.rrule) {
      emit(ev, baseMs, ev.start.allDay ? ev.start.date : null);
      continue;
    }
    const r = Object.fromEntries(ev.rrule.split(";").map(x => x.split("=")).map(([k, v]) => [k.toUpperCase(), v]));
    const freq = r.FREQ, interval = Math.max(1, parseInt(r.INTERVAL || "1", 10));
    const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
    const until = r.UNTIL ? (parseIcsTime(r.UNTIL, {}, fallbackTz) || {}) : null;
    const untilMs = until ? (until.iso ? Date.parse(until.iso) : Date.parse(until.date + "T23:59:59Z")) : Infinity;
    const tz = evTz;
    const l = ev.start.allDay ? { y: +ev.start.date.slice(0, 4), mo: +ev.start.date.slice(5, 7), d: +ev.start.date.slice(8, 10), h: 0, mi: 0 } : localOf(ev.start.iso, tz);
    const byday = (r.BYDAY || "").split(",").map(s => DAYS[s.replace(/^[+-]?\d+/, "")]).filter(v => v !== undefined);
    let n = 0, guard = 0;
    const instanceAt = (y, mo, d) => {
      const date = y + "-" + pad(mo) + "-" + pad(d);
      const ms = ev.start.allDay ? Date.parse(localToUtc(date + "T00:00", tz)) : Date.parse(localToUtc(date + "T" + pad(l.h) + ":" + pad(l.mi), tz));
      return { ms, date };
    };
    const consider = (y, mo, d) => {
      if (new Date(Date.UTC(y, mo - 1, d)).getUTCMonth() !== mo - 1) return true; // z. B. 31. in kurzen Monaten auslassen
      const { ms, date } = instanceAt(y, mo, d);
      if (!Number.isFinite(ms) || ms < baseMs - 1000) return true;
      if (ms > untilMs || n >= count) return false;
      n++;
      const key = ev.allDay || ev.start.allDay ? date : new Date(ms).toISOString();
      if (ev.exdates.includes(key) || ev.exdates.includes(new Date(ms).toISOString())) return true;
      const ov = ev.uid && overrides.get(ev.uid + "|" + key);
      if (ov) { const oms = ov.start.allDay ? Date.parse(localToUtc(ov.start.date + "T00:00", tz)) : Date.parse(ov.start.iso); emit(ov, oms, ov.start.allDay ? ov.start.date : null); }
      else emit(ev, ms, ev.start.allDay ? date : null);
      return ms <= toMs && out.length < MAX_INSTANCES;
    };
    const cursor = new Date(Date.UTC(l.y, l.mo - 1, l.d));
    while (guard++ < 5000) {
      const y = cursor.getUTCFullYear(), mo = cursor.getUTCMonth() + 1, d = cursor.getUTCDate();
      if (freq === "DAILY") { if (!consider(y, mo, d)) break; cursor.setUTCDate(cursor.getUTCDate() + interval); }
      else if (freq === "WEEKLY") {
        const days = byday.length ? byday : [cursor.getUTCDay()];
        const weekStart = new Date(cursor); weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7)); // Montag
        let stop = false;
        for (const wd of [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))) {
          const day = new Date(weekStart); day.setUTCDate(day.getUTCDate() + ((wd + 6) % 7));
          if (!consider(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate())) { stop = true; break; }
        }
        if (stop) break;
        cursor.setTime(weekStart.getTime()); cursor.setUTCDate(cursor.getUTCDate() + 7 * interval);
      } else if (freq === "MONTHLY") { if (!consider(y, mo, l.d)) break; cursor.setUTCDate(1); cursor.setUTCMonth(cursor.getUTCMonth() + interval); }
      else if (freq === "YEARLY") { if (!consider(y, l.mo, l.d)) break; cursor.setUTCFullYear(cursor.getUTCFullYear() + interval); }
      else { emit(ev, baseMs, ev.start.allDay ? ev.start.date : null); break; }
      if (Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate()) > toMs + 86400000) break;
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start)).slice(0, MAX_INSTANCES);
}

// --- Speicher und Abruf ---------------------------------------------------------------------------

async function getSetting(db, key) {
  const row = await db.prepare("SELECT value, updated_at FROM user_settings WHERE key = ?").bind(key).first();
  return row ? { value: row.value, updatedAt: row.updated_at } : null;
}
export async function calendarConfigured(db) {
  try { return Boolean(await getSetting(db, "calendar_url")); } catch { return false; }
}
async function fetchIcs(url) {
  const res = await fetch(url, { headers: { Accept: "text/calendar" }, redirect: "follow", signal: AbortSignal.timeout(12000) });
  if (!res.ok) return { error: res.status === 404 ? "calendar_not_found" : "calendar_unreachable" };
  const final = new URL(res.url || url);
  if (!ALLOWED_HOSTS.some(rx => rx.test(final.hostname))) return { error: "calendar_host_not_allowed" };
  const text = await res.text();
  if (text.length > MAX_ICS_BYTES) return { error: "calendar_too_large" };
  return { text };
}
// Liefert die Termine im Zeitfenster; ruft den Kalender höchstens alle 15 Minuten neu ab.
export async function getCalendarEvents(env, { force = false, timezone = "Europe/Berlin", now = Date.now() } = {}) {
  const db = env.DB;
  const setting = await getSetting(db, "calendar_url");
  if (!setting) return { configured: false, events: [] };
  const cache = await db.prepare("SELECT fetched_at, events, error FROM calendar_cache WHERE id = 'main'").first();
  if (!force && cache && now - Date.parse(cache.fetched_at) < CACHE_MS && !cache.error) {
    return { configured: true, fetchedAt: cache.fetched_at, events: JSON.parse(cache.events), cached: true };
  }
  const fetched = await fetchIcs(setting.value).catch(() => ({ error: "calendar_unreachable" }));
  const fetchedAt = new Date(now).toISOString();
  if (fetched.error) {
    await db.prepare("INSERT INTO calendar_cache (id, fetched_at, events, error) VALUES ('main', ?, COALESCE((SELECT events FROM calendar_cache WHERE id = 'main'), '[]'), ?) ON CONFLICT(id) DO UPDATE SET error = excluded.error").bind(fetchedAt, fetched.error).run();
    const stale = cache ? JSON.parse(cache.events) : [];
    return { configured: true, error: fetched.error, events: stale, stale: Boolean(cache), fetchedAt: cache?.fetched_at || null };
  }
  const parsed = parseIcs(fetched.text, timezone);
  if (parsed.error) return { configured: true, error: parsed.error, events: [] };
  const events = expandEvents(parsed.events, now - WINDOW_PAST_DAYS * 86400000, now + WINDOW_FUTURE_DAYS * 86400000, timezone);
  await db.prepare("INSERT INTO calendar_cache (id, fetched_at, events, error) VALUES ('main', ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, events = excluded.events, error = NULL").bind(fetchedAt, JSON.stringify(events)).run();
  return { configured: true, fetchedAt, events };
}
// Termine eines lokalen Tages (YYYY-MM-DD) – für Tagesplan, Briefing und Agent.
export function eventsOnDay(events, date, tz) {
  const start = Date.parse(localToUtc(date + "T00:00", tz));
  const next = new Date(date + "T12:00:00Z"); next.setUTCDate(next.getUTCDate() + 1);
  const end = Date.parse(localToUtc(next.toISOString().slice(0, 10) + "T00:00", tz));
  return events.filter(e => Date.parse(e.start) < end && Date.parse(e.end) > start);
}

export async function calendarStatus(env) {
  if (!env.DB) return { state: "not_available", detail: "Kein Kalenderzugriff ohne D1." };
  try {
    const setting = await getSetting(env.DB, "calendar_url");
    if (!setting) return { state: "not_configured", detail: "Nur lesend über einen freigegebenen Kalender-Abo-Link (Tagesplan → Kalender verbinden). Direkter Zugriff braucht eine native App." };
    const cache = await env.DB.prepare("SELECT fetched_at, error, events FROM calendar_cache WHERE id = 'main'").first();
    if (cache?.error) return { state: "error", detail: "Abo-Link verbunden, letzter Abruf fehlgeschlagen (" + cache.error + ")." };
    if (cache) return { state: "read_only", detail: "Abo-Link verbunden (nur lesen). " + JSON.parse(cache.events).length + " Termine im Zeitfenster, Stand " + cache.fetched_at + ".", verified: true };
    return { state: "read_only", detail: "Abo-Link gespeichert, noch nicht abgerufen." };
  } catch { return { state: "migration_missing", detail: "Kalender-Tabelle fehlt. Migration 0008 anwenden (Deploy-Workflow erneut ausführen)." }; }
}

// --- API ------------------------------------------------------------------------------------------

export async function handleCalendarApi(request, env, headers, url) {
  if (!url.pathname.startsWith("/api/calendar")) return null;
  const auth = await authenticate(request, env, headers);
  if (auth.response) return auth.response;
  if (!env.DB) return json({ error: "storage_not_configured" }, 503, headers);
  const p = url.pathname.slice("/api/calendar".length) || "/";
  const tz = safeTimezone(url.searchParams.get("tz"));
  try {
    if (p === "/settings" && request.method === "GET") {
      const s = await getSetting(env.DB, "calendar_url");
      return json({ configured: Boolean(s), source: s ? maskUrl(s.value) : null, updatedAt: s?.updatedAt || null }, 200, headers);
    }
    if (p === "/settings" && request.method === "PUT") {
      const body = await readJsonBody(request, 4_000);
      if (body.error) return json({ error: body.error }, body.status, headers);
      const checked = normalizeCalendarUrl(body.value.url);
      if (checked.error) return json({ error: checked.error }, 400, headers);
      // Erst testen, dann speichern: Ein Link, der keinen Kalender liefert, wird nicht übernommen.
      const fetched = await fetchIcs(checked.url).catch(() => ({ error: "calendar_unreachable" }));
      if (fetched.error) return json({ error: fetched.error }, 400, headers);
      const parsed = parseIcs(fetched.text, tz);
      if (parsed.error) return json({ error: parsed.error }, 400, headers);
      const now = new Date(Date.now()).toISOString();
      await env.DB.prepare("INSERT INTO user_settings (key, value, updated_at) VALUES ('calendar_url', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(checked.url, now).run();
      await env.DB.prepare("DELETE FROM calendar_cache").run();
      await audit(env.DB, actorOf(auth.principal), "calendar.connect", maskUrl(checked.url));
      const result = await getCalendarEvents(env, { force: true, timezone: tz });
      return json({ saved: true, source: maskUrl(checked.url), events: result.events.length }, 200, headers);
    }
    if (p === "/settings" && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM user_settings WHERE key = 'calendar_url'").run();
      await env.DB.prepare("DELETE FROM calendar_cache").run();
      await audit(env.DB, actorOf(auth.principal), "calendar.disconnect", null);
      return json({ deleted: true }, 200, headers);
    }
    if (p === "/events" && request.method === "GET") {
      const result = await getCalendarEvents(env, { force: url.searchParams.get("refresh") === "1", timezone: tz });
      const days = Math.min(62, Math.max(1, parseInt(url.searchParams.get("days") || "14", 10) || 14));
      const until = Date.now() + days * 86400000;
      return json({ ...result, events: result.events.filter(e => Date.parse(e.start) < until && Date.parse(e.end) > Date.now() - 86400000) }, 200, headers);
    }
    return json({ error: "not_found" }, 404, headers);
  } catch {
    return json({ error: "calendar_storage_unavailable", message: "Kalender-Tabelle fehlt vermutlich. Migration 0008 anwenden (Deploy-Workflow erneut ausführen)." }, 503, headers);
  }
}
