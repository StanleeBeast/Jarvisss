// JARVIS Zeitplaner: läuft per Cloudflare Cron alle 5 Minuten (siehe wrangler.toml).
//
// Regeln gegen Doppel- und Fehlausführungen:
// - Jede Ausführung wird vor dem Senden in D1 „beansprucht“ (UPDATE … WHERE noch nicht erledigt).
//   Läuft der Cron doppelt oder überlappend, sendet nur der erste.
// - Verpasste Zeitpunkte werden nur in einem Zeitfenster nachgeholt (Briefing 3 h, Erinnerungen 6 h,
//   geplante Benachrichtigungen 2 h). Ältere werden nicht nachträglich verschickt.
// - Uhrzeiten sind lokale Zeiten der Zeitzone des Nutzers; Sommer-/Winterzeit wird über Intl berechnet.
// Ein Cron im Worker ersetzt keinen hörbaren Wecker auf dem Gerät.
import { json, clip, readJsonBody, audit } from "./http.js";
import { authenticate, actorOf } from "./auth.js";
import { notifyAll } from "./push.js";
import { getNews } from "./news.js";
import { listTasks } from "./tasks.js";
import { calendarConfigured, getCalendarEvents, eventsOnDay } from "./calendar.js";

const DEFAULT_TZ = "Europe/Berlin";
const DEFAULTS = {
  morning_briefing: { enabled: false, config: { time: "06:20", days: [1, 2, 3, 4, 5], include: { weather: true, tasks: true, news: true } } },
  task_reminders: { enabled: false, config: { hideContent: false } },
  arrival: { enabled: false, config: { delayMinutes: 20 } }
};
const WINDOWS = { briefingMinutes: 180, reminderHours: 6, scheduledHours: 2 };
const WEATHER = { 0: "klar", 1: "überwiegend klar", 2: "teilweise bewölkt", 3: "bedeckt", 45: "Nebel", 48: "Nebel", 51: "Nieselregen", 53: "Nieselregen", 55: "Nieselregen", 61: "leichter Regen", 63: "Regen", 65: "starker Regen", 71: "Schnee", 73: "Schnee", 75: "starker Schnee", 80: "Schauer", 81: "Schauer", 82: "heftige Schauer", 95: "Gewitter" };

export function safeTz(value) {
  const tz = clip(value, 100) || DEFAULT_TZ;
  try { new Intl.DateTimeFormat("de-DE", { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
}
export function localParts(nowMs, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" })
    .formatToParts(new Date(nowMs)).map(p => [p.type, p.value]));
  const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  return { day: parts.year + "-" + parts.month + "-" + parts.day, weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
const toMinutes = (hhmm) => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

// --- Routinen -------------------------------------------------------------------------------------

function validateRoutine(kind, input) {
  const config = input?.config && typeof input.config === "object" && !Array.isArray(input.config) ? input.config : {};
  if (kind === "morning_briefing") {
    if (toMinutes(config.time) === null) return { error: "invalid_time" };
    const days = Array.isArray(config.days) ? [...new Set(config.days.map(Number))].filter(d => d >= 1 && d <= 7).sort() : [];
    if (!days.length) return { error: "invalid_days" };
    const inc = config.include || {};
    return { config: { time: config.time, days, include: { weather: inc.weather !== false, tasks: inc.tasks !== false, news: inc.news !== false } } };
  }
  if (kind === "task_reminders") return { config: { hideContent: Boolean(config.hideContent) } };
  if (kind === "arrival") {
    const delay = Number.parseInt(config.delayMinutes, 10);
    if (!Number.isFinite(delay) || delay < 0 || delay > 240) return { error: "invalid_delay" };
    return { config: { delayMinutes: delay } };
  }
  return { error: "unknown_routine" };
}
export async function getRoutines(db) {
  const rows = (await db.prepare("SELECT * FROM routines").all()).results || [];
  const out = {};
  for (const [kind, def] of Object.entries(DEFAULTS)) {
    const row = rows.find(r => r.kind === kind);
    out[kind] = row
      ? { enabled: Boolean(row.enabled), config: { ...def.config, ...JSON.parse(row.config || "{}") }, timezone: row.timezone, lastRunDay: row.last_run_day || null, updatedAt: row.updated_at }
      : { ...def, timezone: DEFAULT_TZ, lastRunDay: null, updatedAt: null };
  }
  return out;
}

// --- Briefing (ohne KI, aus echten Daten) ---------------------------------------------------------

async function weatherSummary(env, tz) {
  const lat = Number(env.WEATHER_LAT) || 51.255, lon = Number(env.WEATHER_LON) || 14.18;
  try {
    const res = await fetch("https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon + "&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1&timezone=" + encodeURIComponent(tz), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { error: "weather_source_unavailable" };
    const d = await res.json();
    return { location: clip(env.WEATHER_NAME, 80) || "Miltitz bei Nebelschütz", nowC: d.current?.temperature_2m, condition: WEATHER[d.current?.weather_code] || "unbekannt", minC: d.daily?.temperature_2m_min?.[0], maxC: d.daily?.temperature_2m_max?.[0], rainPercent: d.daily?.precipitation_probability_max?.[0], source: "Open-Meteo" };
  } catch { return { error: "weather_source_unavailable" }; }
}
export async function buildBriefing(env, { include = { weather: true, tasks: true, news: true }, timezone = DEFAULT_TZ, now = Date.now() } = {}) {
  const tz = safeTz(timezone);
  const today = localParts(now, tz).day;
  const content = { createdAt: new Date(now).toISOString(), timezone: tz, day: today };
  if (include.weather) content.weather = await weatherSummary(env, tz);
  if (include.tasks && env.DB) {
    try {
      const open = await listTasks(env.DB, "open", 100);
      content.tasks = {
        open: open.length,
        overdue: open.filter(t => t.dueAt && Date.parse(t.dueAt) < now).slice(0, 10).map(t => ({ title: t.title, dueAt: t.dueAt, priority: t.priority })),
        dueToday: open.filter(t => t.dueAt && Date.parse(t.dueAt) >= now && localParts(Date.parse(t.dueAt), tz).day === today).slice(0, 10).map(t => ({ title: t.title, dueAt: t.dueAt, priority: t.priority })),
        highPriority: open.filter(t => t.priority === "high" && !t.dueAt).slice(0, 5).map(t => ({ title: t.title }))
      };
    } catch { content.tasks = { error: "task_storage_unavailable" }; }
  }
  if (include.tasks && env.DB && await calendarConfigured(env.DB)) {
    try {
      const res = await getCalendarEvents(env, { timezone: tz, now });
      content.calendar = { events: eventsOnDay(res.events, today, tz).slice(0, 10).map(e => ({ title: e.title, allDay: e.allDay, start: e.start, end: e.end, location: e.location || "" })), error: res.error || null };
    } catch { content.calendar = { error: "calendar_unavailable" }; }
  }
  if (include.news) {
    content.news = [];
    for (const section of ["local", "saxony", "germany", "world"]) {
      try {
        const res = await getNews(section);
        for (const item of (res.items || []).slice(0, 2)) content.news.push({ section, title: item.title, source: item.source, published: item.published, link: item.link });
      } catch { content.news.push({ section, error: "news_source_unavailable" }); }
    }
  }
  const id = crypto.randomUUID();
  if (env.DB) await env.DB.prepare("INSERT INTO briefings (id, created_at, content) VALUES (?, ?, ?)").bind(id, content.createdAt, JSON.stringify(content)).run();
  await env.DB?.prepare("DELETE FROM briefings WHERE created_at < ?").bind(new Date(now - 30 * 86400000).toISOString()).run();
  return { id, content };
}
function briefingTeaser(content) {
  const parts = [];
  if (content.weather && !content.weather.error) parts.push(Math.round(content.weather.minC) + "–" + Math.round(content.weather.maxC) + " °C, " + content.weather.condition);
  if (content.calendar && !content.calendar.error && content.calendar.events.length) parts.push(content.calendar.events.length + (content.calendar.events.length === 1 ? " Termin" : " Termine"));
  if (content.tasks && !content.tasks.error) parts.push(content.tasks.dueToday.length + " heute fällig" + (content.tasks.overdue.length ? ", " + content.tasks.overdue.length + " überfällig" : ""));
  return parts.join(" · ") || "Tippe, um es zu öffnen.";
}

// --- Geplante Benachrichtigungen ------------------------------------------------------------------

export async function scheduleNotification(db, { sendAt, title, body, url = "./", kind = "custom" }, now = Date.now()) {
  const at = Date.parse(sendAt);
  if (!Number.isFinite(at) || at < now - 60_000 || at > now + 7 * 86400000) return { error: "invalid_send_at" };
  const t = clip(title, 80).trim(), b = clip(body, 240).trim();
  if (!t || !b) return { error: "invalid_notification_text" };
  if (typeof url !== "string" || !/^\.\/[\w?=&%.\-/]*$/.test(url)) return { error: "invalid_notification_url" };
  const pending = await db.prepare("SELECT COUNT(*) AS n FROM scheduled_notifications WHERE status = 'pending'").first();
  if ((pending?.n || 0) >= 50) return { error: "too_many_pending" };
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO scheduled_notifications (id, send_at, title, body, url, kind, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')")
    .bind(id, new Date(at).toISOString(), t, b, url, clip(kind, 30) || "custom", new Date(now).toISOString()).run();
  const saved = await db.prepare("SELECT * FROM scheduled_notifications WHERE id = ?").bind(id).first();
  return saved ? { notification: { id, sendAt: saved.send_at, title: t, body: b, url, kind: saved.kind, status: saved.status } } : { error: "notification_save_unconfirmed" };
}

// --- Cron-Lauf ------------------------------------------------------------------------------------

export async function runScheduler(env, now = Date.now()) {
  const report = { at: new Date(now).toISOString(), scheduled: 0, reminders: 0, briefing: null, missed: 0 };
  if (!env.DB) return report;
  const nowIso = new Date(now).toISOString();
  await env.DB.prepare("INSERT INTO server_keys (name, value, created_at) VALUES ('last_cron_at', ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").bind(nowIso, nowIso).run();

  // 1) Geplante Einzel-Benachrichtigungen
  const due = (await env.DB.prepare("SELECT * FROM scheduled_notifications WHERE status = 'pending' AND send_at <= ? ORDER BY send_at LIMIT 20").bind(nowIso).all()).results || [];
  for (const n of due) {
    if (Date.parse(n.send_at) < now - WINDOWS.scheduledHours * 3600000) {
      await env.DB.prepare("UPDATE scheduled_notifications SET status = 'missed' WHERE id = ? AND status = 'pending'").bind(n.id).run();
      report.missed++;
      continue;
    }
    const claim = await env.DB.prepare("UPDATE scheduled_notifications SET sent_at = ? WHERE id = ? AND status = 'pending' AND sent_at IS NULL").bind(nowIso, n.id).run();
    if (!claim?.meta?.changes) continue;
    const result = await notifyAll(env, { title: n.title, body: n.body, url: n.url, tag: "jarvis-" + n.kind });
    await env.DB.prepare("UPDATE scheduled_notifications SET status = ? WHERE id = ?").bind(result.sent ? "sent" : "failed", n.id).run();
    if (result.sent) report.scheduled++;
  }

  const routines = await getRoutines(env.DB);

  // 2) Erinnerungen für fällige Aufgaben
  if (routines.task_reminders.enabled) {
    const from = new Date(now - WINDOWS.reminderHours * 3600000).toISOString();
    const tasks = (await env.DB.prepare("SELECT id, title FROM tasks WHERE status = 'open' AND reminder_sent_at IS NULL AND due_at IS NOT NULL AND due_at <= ? AND due_at >= ? ORDER BY due_at LIMIT 20").bind(nowIso, from).all()).results || [];
    for (const t of tasks) {
      const claim = await env.DB.prepare("UPDATE tasks SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL").bind(nowIso, t.id).run();
      if (!claim?.meta?.changes) continue;
      const hide = routines.task_reminders.config.hideContent;
      const result = await notifyAll(env, { title: "JARVIS · Erinnerung", body: hide ? "Eine Aufgabe ist jetzt fällig." : t.title, url: "./?task=" + encodeURIComponent(t.id), tag: "jarvis-task-" + t.id }, { urgency: "high" });
      if (result.sent) report.reminders++;
    }
  }

  // 3) Morgenbriefing
  const mb = routines.morning_briefing;
  if (mb.enabled) {
    const tz = safeTz(mb.timezone);
    const local = localParts(now, tz);
    const target = toMinutes(mb.config.time);
    const since = local.minutes - target;
    if (mb.config.days.includes(local.weekday) && target !== null && since >= 0 && since <= WINDOWS.briefingMinutes && mb.lastRunDay !== local.day) {
      const claim = await env.DB.prepare("UPDATE routines SET last_run_day = ? WHERE kind = 'morning_briefing' AND (last_run_day IS NULL OR last_run_day != ?)").bind(local.day, local.day).run();
      if (claim?.meta?.changes) {
        const { id, content } = await buildBriefing(env, { include: mb.config.include, timezone: tz, now });
        const result = await notifyAll(env, { title: "Guten Morgen. Dein Briefing ist bereit.", body: briefingTeaser(content), url: "./?briefing=" + id, tag: "jarvis-briefing" }, { urgency: "high", ttl: 3 * 3600 });
        report.briefing = { id, sent: result.sent };
      }
    }
  }
  return report;
}

export async function schedulerStatus(env) {
  if (!env.DB) return { push: { state: "not_configured", detail: "Benachrichtigungen benötigen D1." }, scheduler: { state: "not_configured", detail: "Zeitpläne benötigen D1." } };
  try {
    const subs = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(last_success_at) AS last FROM push_subscriptions").first();
    const cron = await env.DB.prepare("SELECT value FROM server_keys WHERE name = 'last_cron_at'").first();
    const routines = await getRoutines(env.DB);
    const active = Object.entries(routines).filter(([, r]) => r.enabled).map(([k]) => ({ morning_briefing: "Morgenbriefing " + routines.morning_briefing.config.time, task_reminders: "Aufgaben-Erinnerungen", arrival: "Ankunft zu Hause" }[k]));
    const cronAge = cron ? Date.now() - Date.parse(cron.value) : null;
    return {
      push: subs.n
        ? { state: "available", detail: subs.n + " Gerät(e) für Benachrichtigungen angemeldet." + (subs.last ? " Zuletzt zugestellt an den Push-Dienst: " + subs.last + "." : " Noch keine Zustellung bestätigt."), verified: Boolean(subs.last) }
        : { state: "not_configured", detail: "Noch kein Gerät hat Benachrichtigungen erlaubt (Einstellungen → Automatisierungen)." },
      scheduler: !cron
        ? { state: "not_configured", detail: "Der Zeitplaner ist noch nie gelaufen. Nach dem Deployment startet er automatisch alle 5 Minuten." }
        : cronAge > 20 * 60000
          ? { state: "error", detail: "Letzter Lauf vor " + Math.round(cronAge / 60000) + " Minuten – Cron-Trigger prüfen." }
          : { state: "available", detail: "Läuft alle 5 Minuten, zuletzt " + cron.value + ". Aktiv: " + (active.join(", ") || "keine Routine eingeschaltet") + ".", verified: true }
    };
  } catch {
    return { push: { state: "migration_missing", detail: "Tabellen für Automatisierungen fehlen. Migration 0004 anwenden." }, scheduler: { state: "migration_missing", detail: "Migration 0004 fehlt." } };
  }
}

// --- API ------------------------------------------------------------------------------------------

export async function handleAutomationApi(request, env, headers, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/routines") && !p.startsWith("/api/notifications") && !p.startsWith("/api/briefings") && p !== "/api/arrival") return null;
  const auth = await authenticate(request, env, headers);
  if (auth.response) return auth.response;
  if (!env.DB) return json({ error: "storage_not_configured", message: "Automatisierungen benötigen die D1-Datenbank." }, 503, headers);
  const actor = actorOf(auth.principal);
  try {
    if (p === "/api/routines" && request.method === "GET") return json({ routines: await getRoutines(env.DB) }, 200, headers);
    const routineMatch = p.match(/^\/api\/routines\/(morning_briefing|task_reminders|arrival)$/);
    if (routineMatch && request.method === "PUT") {
      const kind = routineMatch[1];
      const body = await readJsonBody(request, 4_000);
      if (body.error) return json({ error: body.error }, body.status, headers);
      const checked = validateRoutine(kind, body.value);
      if (checked.error) return json({ error: checked.error }, 400, headers);
      const tz = safeTz(body.value.timezone);
      const nowIso = new Date().toISOString();
      await env.DB.prepare("INSERT INTO routines (kind, enabled, config, timezone, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, timezone = excluded.timezone, updated_at = excluded.updated_at")
        .bind(kind, body.value.enabled ? 1 : 0, JSON.stringify(checked.config), tz, nowIso).run();
      await audit(env.DB, actor, "routine_updated", kind);
      const routines = await getRoutines(env.DB);
      return json({ routine: routines[kind], saved: true }, 200, headers);
    }
    if (p === "/api/notifications" && request.method === "GET") {
      const rows = (await env.DB.prepare("SELECT * FROM scheduled_notifications WHERE status = 'pending' ORDER BY send_at LIMIT 50").all()).results || [];
      return json({ notifications: rows.map(n => ({ id: n.id, sendAt: n.send_at, title: n.title, body: n.body, kind: n.kind, status: n.status })) }, 200, headers);
    }
    if (p === "/api/notifications" && request.method === "POST") {
      const body = await readJsonBody(request, 4_000);
      if (body.error) return json({ error: body.error }, body.status, headers);
      const v = body.value;
      const sendAt = v.delayMinutes != null ? new Date(Date.now() + Number(v.delayMinutes) * 60000).toISOString() : v.sendAt;
      const result = await scheduleNotification(env.DB, { sendAt, title: v.title, body: v.body, url: v.url || "./", kind: v.kind });
      if (result.error) return json({ error: result.error }, 400, headers);
      await audit(env.DB, actor, "notification_scheduled", result.notification.id);
      return json({ ...result, saved: true }, 201, headers);
    }
    const cancelMatch = p.match(/^\/api\/notifications\/([A-Za-z0-9-]{1,80})\/cancel$/);
    if (cancelMatch && request.method === "POST") {
      const res = await env.DB.prepare("UPDATE scheduled_notifications SET status = 'cancelled' WHERE id = ? AND status = 'pending'").bind(cancelMatch[1]).run();
      if (!res?.meta?.changes) return json({ error: "notification_not_found" }, 404, headers);
      return json({ cancelled: true }, 200, headers);
    }
    if (p === "/api/arrival" && request.method === "POST") {
      // Wird vom Kurzbefehl „Ankunft zu Hause“ (über die geöffnete Web-App) ausgelöst.
      const routines = await getRoutines(env.DB);
      if (!routines.arrival.enabled) return json({ scheduled: false, reason: "routine_disabled" }, 200, headers);
      const open = await env.DB.prepare("SELECT id, send_at FROM scheduled_notifications WHERE kind = 'arrival' AND status = 'pending'").first();
      if (open) return json({ scheduled: false, reason: "already_scheduled", sendAt: open.send_at }, 200, headers);
      const delay = routines.arrival.config.delayMinutes;
      const result = await scheduleNotification(env.DB, { sendAt: new Date(Date.now() + delay * 60000).toISOString(), title: "JARVIS", body: "Bereit für deinen Überblick? Ich habe Aufgaben, Wetter und Nachrichten zusammengestellt.", url: "./?briefing=new", kind: "arrival" });
      if (result.error) return json({ error: result.error }, 400, headers);
      return json({ scheduled: true, delayMinutes: delay, sendAt: result.notification.sendAt }, 201, headers);
    }
    if (p === "/api/briefings" && request.method === "POST") {
      const routines = await getRoutines(env.DB);
      const body = await readJsonBody(request, 2_000);
      const tz = safeTz(body.value?.timezone || routines.morning_briefing.timezone);
      const { id, content } = await buildBriefing(env, { include: routines.morning_briefing.config.include, timezone: tz });
      return json({ id, briefing: content }, 201, headers);
    }
    const briefingMatch = p.match(/^\/api\/briefings\/(latest|[A-Za-z0-9-]{1,80})$/);
    if (briefingMatch && request.method === "GET") {
      const row = briefingMatch[1] === "latest"
        ? await env.DB.prepare("SELECT * FROM briefings ORDER BY created_at DESC LIMIT 1").first()
        : await env.DB.prepare("SELECT * FROM briefings WHERE id = ?").bind(briefingMatch[1]).first();
      if (!row) return json({ error: "briefing_not_found" }, 404, headers);
      return json({ id: row.id, briefing: JSON.parse(row.content) }, 200, headers);
    }
    return json({ error: "not_found" }, 404, headers);
  } catch {
    return json({ error: "automation_storage_unavailable" }, 503, headers);
  }
}
