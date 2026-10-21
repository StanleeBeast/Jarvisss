// JARVIS Autonomie: was JARVIS von selbst tut (Cron alle 5 Minuten), mit Protokoll und Push.
//
// Ohne KI-Kosten (Regeln): Termin beginnt bald · überfällige Aufgaben am Nachmittag · wichtige Mail seit Stunden
// unbeantwortet · Vorschau auf morgen am Abend.
// Mit KI (kostet ca. 1–2 Cent, nur solange die Monatsgrenze nicht im Sparmodus ist): Tagesvorbereitung am Morgen.
// JARVIS ändert dabei nichts selbst – Vorschläge (Aufgaben, Planänderungen) warten im Protokoll auf Bestätigung.
import { json, clip, readJsonBody, audit } from "./http.js";
import { authenticate, actorOf } from "./auth.js";
import { notifyAll } from "./push.js";
import { calendarConfigured, getCalendarEvents } from "./calendar.js";
import { budgetState } from "./usage.js";

const DEFAULT_TZ = "Europe/Berlin";
export const AUTONOMY_DEFAULTS = {
  eventSoon: { enabled: true, minutes: 30 },
  overdue: { enabled: true, time: "16:30" },
  mailWatch: { enabled: true, hours: 3 },
  eveningPreview: { enabled: true, time: "20:00" },
  dayPrep: { enabled: true, time: "06:30", days: [1, 2, 3, 4, 5, 6, 7] },
  quiet: { from: "22:00", to: "06:30" }
};
const hhmm = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v || "");
const toMin = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
function local(nowMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date(nowMs)).map(x => [x.type, x.value]));
  return { day: p.year + "-" + p.month + "-" + p.day, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday] };
}
const fmtTime = (iso, tz) => new Date(iso).toLocaleTimeString("de-DE", { timeZone: tz, hour: "2-digit", minute: "2-digit" });

export function validateAutonomy(input, current = AUTONOMY_DEFAULTS) {
  const out = JSON.parse(JSON.stringify(current));
  const v = input && typeof input === "object" ? input : {};
  for (const key of Object.keys(AUTONOMY_DEFAULTS)) {
    if (!v[key] || typeof v[key] !== "object") continue;
    const src = v[key], dst = out[key];
    if (typeof src.enabled === "boolean" && "enabled" in dst) dst.enabled = src.enabled;
    for (const f of ["time", "from", "to"]) if (f in dst && src[f] !== undefined) { if (!hhmm(src[f])) return { error: "invalid_time" }; dst[f] = src[f]; }
    if ("minutes" in dst && src.minutes !== undefined) { const n = Number(src.minutes); if (!(n >= 5 && n <= 180)) return { error: "invalid_minutes" }; dst.minutes = Math.round(n); }
    if ("hours" in dst && src.hours !== undefined) { const n = Number(src.hours); if (!(n >= 1 && n <= 48)) return { error: "invalid_hours" }; dst.hours = Math.round(n); }
    if ("days" in dst && src.days !== undefined) { const d = Array.isArray(src.days) ? [...new Set(src.days.map(Number))].filter(x => x >= 1 && x <= 7).sort() : []; if (!d.length) return { error: "invalid_days" }; dst.days = d; }
  }
  return { value: out };
}
export async function getAutonomy(db) {
  const row = await db.prepare("SELECT value FROM user_settings WHERE key = 'autonomy'").first().catch(() => null);
  if (!row) return JSON.parse(JSON.stringify(AUTONOMY_DEFAULTS));
  const checked = validateAutonomy(JSON.parse(row.value || "{}"));
  return checked.value || JSON.parse(JSON.stringify(AUTONOMY_DEFAULTS));
}
function inQuiet(cfg, minutes) {
  const a = toMin(cfg.quiet.from), b = toMin(cfg.quiet.to);
  return a > b ? minutes >= a || minutes < b : minutes >= a && minutes < b;
}

// Eintrag anlegen – genau einmal pro (kind, ref). Liefert die id oder null, wenn es ihn schon gibt.
async function record(env, { kind, ref, title, detail = "", proposals = [], push = null, nowMs }) {
  const id = crypto.randomUUID();
  const r = await env.DB.prepare("INSERT OR IGNORE INTO autonomy_log (id, at, kind, ref, title, detail, proposals) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, new Date(nowMs).toISOString(), kind, clip(ref, 200), clip(title, 160), clip(detail, 4000), JSON.stringify(proposals).slice(0, 20000)).run();
  if (!r?.meta?.changes) return null;
  if (push) {
    const res = await notifyAll(env, { title: push.title, body: push.body, url: "./?autonomy=" + id, tag: "jarvis-auto-" + kind }, { urgency: push.urgent ? "high" : "normal" }).catch(() => ({ sent: 0 }));
    if (res.sent) await env.DB.prepare("UPDATE autonomy_log SET pushed = 1 WHERE id = ?").bind(id).run();
  }
  return id;
}

// Die KI-Tagesvorbereitung wird von außen übergeben (Agent), damit dieses Modul ohne Zyklus testbar bleibt.
export async function runAutonomy(env, { nowMs = Date.now(), timezone = DEFAULT_TZ, prepareDay = null } = {}) {
  const report = { eventSoon: 0, overdue: 0, mailWatch: 0, eveningPreview: 0, dayPrep: null };
  if (!env.DB) return report;
  let cfg;
  try { cfg = await getAutonomy(env.DB); } catch { return report; }
  const tz = timezone, l = local(nowMs, tz), quiet = inQuiet(cfg, l.minutes);
  const safe = async (fn) => { try { await fn(); } catch { /* ein Fehler darf die anderen nicht stoppen */ } };

  // 1) Termin beginnt bald (nur mit verbundenem Kalender)
  if (cfg.eventSoon.enabled && !quiet) await safe(async () => {
    if (!(await calendarConfigured(env.DB))) return;
    const { events } = await getCalendarEvents(env, { timezone: tz, now: nowMs });
    for (const e of events || []) {
      if (e.allDay) continue;
      const until = (Date.parse(e.start) - nowMs) / 60000;
      if (until > 0 && until <= cfg.eventSoon.minutes) {
        const id = await record(env, { kind: "event_soon", ref: (e.uid || e.title) + "@" + e.start, title: "Gleich: " + e.title, detail: "Beginnt um " + fmtTime(e.start, tz) + (e.location ? " · " + e.location : ""), nowMs,
          push: { title: "JARVIS · In " + Math.round(until) + " Minuten", body: e.title + " um " + fmtTime(e.start, tz) + (e.location ? " · " + e.location : ""), urgent: true } });
        if (id) report.eventSoon++;
      }
    }
  });
  // 2) Überfällige Aufgaben – einmal am Tag zur eingestellten Zeit
  if (cfg.overdue.enabled && !quiet && l.minutes >= toMin(cfg.overdue.time) && l.minutes < toMin(cfg.overdue.time) + 180) await safe(async () => {
    const rows = (await env.DB.prepare("SELECT title FROM tasks WHERE status = 'open' AND due_at IS NOT NULL AND due_at < ? ORDER BY due_at LIMIT 10").bind(new Date(nowMs).toISOString()).all()).results || [];
    if (!rows.length) return;
    const id = await record(env, { kind: "overdue", ref: l.day, title: rows.length + (rows.length === 1 ? " Aufgabe ist überfällig" : " Aufgaben sind überfällig"), detail: rows.map(r => r.title).join(" · "), nowMs,
      push: { title: "JARVIS · Noch offen", body: rows.slice(0, 3).map(r => r.title).join(", ") + (rows.length > 3 ? " …" : "") } });
    if (id) report.overdue++;
  });
  // 3) Wichtige Mail seit Stunden unbeantwortet (Home-Station)
  if (cfg.mailWatch.enabled && !quiet) await safe(async () => {
    const before = new Date(nowMs - cfg.mailWatch.hours * 3600000).toISOString();
    const rows = (await env.DB.prepare("SELECT id, from_name, from_addr, subject FROM mail_messages WHERE status IN ('new','read') AND importance >= 5 AND needs_reply = 1 AND suspicious = 0 AND received_at < ? ORDER BY received_at DESC LIMIT 3").bind(before).all()).results || [];
    for (const m of rows) {
      const id = await record(env, { kind: "mail_watch", ref: m.id, title: "Noch unbeantwortet: " + m.subject, detail: "Von " + (m.from_name || m.from_addr) + ". Antwortentwurf liegt im Bereich Mails bereit.", nowMs,
        push: { title: "JARVIS · Wichtige Mail wartet", body: (m.from_name || m.from_addr) + ": " + m.subject } });
      if (id) report.mailWatch++;
    }
  });
  // 4) Abendvorschau auf morgen
  if (cfg.eveningPreview.enabled && l.minutes >= toMin(cfg.eveningPreview.time) && l.minutes < toMin(cfg.eveningPreview.time) + 120) await safe(async () => {
    const tomorrow = local(nowMs + 86400000, tz).day;
    const parts = [];
    if (await calendarConfigured(env.DB)) {
      const { events } = await getCalendarEvents(env, { timezone: tz, now: nowMs });
      const t = (events || []).filter(e => (e.allDay ? e.date : local(Date.parse(e.start), tz).day) === tomorrow).slice(0, 4);
      if (t.length) parts.push("Termine: " + t.map(e => (e.allDay ? "ganztägig " : fmtTime(e.start, tz) + " ") + e.title).join(", "));
    }
    const due = ((await env.DB.prepare("SELECT title, due_at FROM tasks WHERE status = 'open' AND due_at IS NOT NULL ORDER BY due_at LIMIT 30").all()).results || []).filter(t => local(Date.parse(t.due_at), tz).day === tomorrow);
    if (due.length) parts.push("Fällig: " + due.map(t => t.title).join(", "));
    if (!parts.length) return;
    const id = await record(env, { kind: "evening_preview", ref: l.day, title: "Morgen", detail: parts.join(" · "), nowMs, push: { title: "JARVIS · Morgen steht an", body: parts.join(" · ").slice(0, 180) } });
    if (id) report.eveningPreview++;
  });
  // 5) KI-Tagesvorbereitung am Morgen
  if (cfg.dayPrep.enabled && prepareDay && cfg.dayPrep.days.includes(l.weekday) && l.minutes >= toMin(cfg.dayPrep.time) && l.minutes < toMin(cfg.dayPrep.time) + 120) await safe(async () => {
    const exists = await env.DB.prepare("SELECT 1 FROM autonomy_log WHERE kind = 'day_prep' AND ref = ?").bind(l.day).first();
    if (exists) return;
    const budget = await budgetState(env);
    if (budget.level !== "ok") { await record(env, { kind: "day_prep", ref: l.day, title: "Tagesvorbereitung ausgelassen", detail: "Die Monatsgrenze ist fast erreicht – JARVIS spart heute die KI-Vorbereitung.", nowMs }); return; }
    // Platz vor dem langsamen KI-Aufruf beanspruchen, damit ein zweiter Cron nicht doppelt vorbereitet.
    const id = crypto.randomUUID();
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO autonomy_log (id, at, kind, ref, title) VALUES (?, ?, 'day_prep', ?, 'Tag wird vorbereitet …')").bind(id, new Date(nowMs).toISOString(), l.day).run();
    if (!claim?.meta?.changes) return;
    const result = await prepareDay(env, tz);
    if (!result?.reply) { await env.DB.prepare("UPDATE autonomy_log SET title = 'Tagesvorbereitung fehlgeschlagen', detail = ? WHERE id = ?").bind(clip(result?.error || "unbekannt", 200), id).run(); return; }
    await env.DB.prepare("UPDATE autonomy_log SET title = 'Dein Tag ist vorbereitet', detail = ?, proposals = ? WHERE id = ?").bind(clip(result.reply, 4000), JSON.stringify(result.proposals || []).slice(0, 20000), id).run();
    const res = await notifyAll(env, { title: "Guten Morgen. Dein Tag ist vorbereitet.", body: clip(result.reply, 170) + ((result.proposals || []).length ? " · " + result.proposals.length + " Vorschlag/Vorschläge" : ""), url: "./?autonomy=" + id, tag: "jarvis-auto-day" }, { urgency: "high", ttl: 3 * 3600 }).catch(() => ({ sent: 0 }));
    if (res.sent) await env.DB.prepare("UPDATE autonomy_log SET pushed = 1 WHERE id = ?").bind(id).run();
    report.dayPrep = { id, proposals: (result.proposals || []).length };
  });
  // Protokoll kurz halten
  await env.DB.prepare("DELETE FROM autonomy_log WHERE at < ?").bind(new Date(nowMs - 30 * 86400000).toISOString()).run().catch(() => null);
  return report;
}

export async function handleAutonomyApi(request, env, headers, url) {
  if (!url.pathname.startsWith("/api/autonomy")) return null;
  const auth = await authenticate(request, env, headers);
  if (auth.response) return auth.response;
  if (!env.DB) return json({ error: "storage_not_configured" }, 503, headers);
  const actor = actorOf(auth.principal);
  try {
    if (url.pathname === "/api/autonomy" && request.method === "GET") {
      const rows = (await env.DB.prepare("SELECT * FROM autonomy_log ORDER BY at DESC LIMIT 60").all()).results || [];
      return json({ settings: await getAutonomy(env.DB), budget: await budgetState(env), entries: rows.map(r => ({ id: r.id, at: r.at, kind: r.kind, title: r.title, detail: r.detail, proposals: JSON.parse(r.proposals || "[]"), pushed: Boolean(r.pushed), seen: Boolean(r.seen) })) }, 200, headers);
    }
    if (url.pathname === "/api/autonomy/settings" && request.method === "PUT") {
      const body = await readJsonBody(request, 4000);
      if (body.error) return json({ error: body.error }, body.status, headers);
      const checked = validateAutonomy(body.value, await getAutonomy(env.DB));
      if (checked.error) return json({ error: checked.error }, 400, headers);
      await env.DB.prepare("INSERT INTO user_settings (key, value, updated_at) VALUES ('autonomy', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(JSON.stringify(checked.value), new Date().toISOString()).run();
      await audit(env.DB, actor, "autonomy.settings");
      return json({ settings: checked.value, saved: true }, 200, headers);
    }
    const m = url.pathname.match(/^\/api\/autonomy\/([A-Za-z0-9-]{1,80})\/seen$/);
    if (m && request.method === "POST") {
      await env.DB.prepare("UPDATE autonomy_log SET seen = 1 WHERE id = ?").bind(m[1]).run();
      return json({ saved: true }, 200, headers);
    }
    return json({ error: "not_found" }, 404, headers);
  } catch {
    return json({ error: "autonomy_storage_unavailable", message: "Migration 0011 anwenden (Deploy-Workflow erneut ausführen)." }, 503, headers);
  }
}
