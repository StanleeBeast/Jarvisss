// JARVIS Tagesplaner: baut aus Aufgaben, festen Blöcken, Routinen und Pausen einen Tagesplan.
//
// - Der Plan wird bei jedem Abruf neu und ohne KI berechnet (nachvollziehbar, kostenlos, testbar).
// - Gespeichert werden nur deine Vorlieben (user_settings 'planner_prefs') und die Änderungen für einen
//   Tag (day_plans.overrides), z. B. „Sport fällt heute aus“ oder „mehr Freizeit“.
// - Änderungen schlägt der Agent nur vor (propose_plan_change); gespeichert wird erst nach deiner Bestätigung.
// - Ein Kalender ist nicht verbunden. Termine kennt JARVIS nur als Aufgaben mit Uhrzeit oder feste Blöcke.
import { json, clip, readJsonBody, audit } from "./http.js";
import { authenticate, actorOf } from "./auth.js";
import { listTasks } from "./tasks.js";
import { getRoutines, localParts } from "./scheduler.js";
import { safeTimezone, localToUtc } from "./time.js";

export const BLOCK_KINDS = ["school", "work", "sport", "routine", "other"];
export const DEFAULT_PREFS = {
  wake: "07:00",
  sleep: "22:30",
  focusMinutes: 90,
  breakMinutes: 15,
  minFreeMinutes: 60,
  taskMinutes: { high: 45, normal: 30, low: 20 },
  fixed: []
};
const MAX_FIXED = 20, MAX_ADDED = 10, MAX_SKIP = 20, MAX_EXTRA_FREE = 360;
const GAP_MIN = 10; // kleinere Lücken werden nicht als eigener Block angezeigt

export const toMinutes = (hhmm) => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export const toHHMM = (min) => String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
const weekdayOf = (date) => { const d = new Date(date + "T12:00:00Z").getUTCDay(); return d === 0 ? 7 : d; };
const intIn = (v, min, max, fallback) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n >= min && n <= max ? n : fallback; };
const blockId = (title, start) => (String(title).toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "block") + "-" + start.replace(":", "");

// --- Validierung ----------------------------------------------------------------------------------

function validBlock(input, { needsDays }) {
  if (!input || typeof input !== "object") return null;
  const title = clip(input.title, 80).trim();
  const start = toMinutes(input.start), end = toMinutes(input.end);
  if (!title || start === null || end === null || end <= start) return null;
  const kind = BLOCK_KINDS.includes(input.kind) ? input.kind : "other";
  const block = { title, start: input.start, end: input.end, kind };
  if (needsDays) {
    const days = Array.isArray(input.days) ? [...new Set(input.days.map(Number))].filter(d => d >= 1 && d <= 7).sort() : [];
    if (!days.length) return null;
    block.days = days;
  }
  return block;
}
export function validatePrefs(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "invalid_prefs" };
  const wake = toMinutes(input.wake ?? DEFAULT_PREFS.wake), sleep = toMinutes(input.sleep ?? DEFAULT_PREFS.sleep);
  if (wake === null || sleep === null || sleep - wake < 120) return { error: "invalid_day_window" };
  const fixedIn = Array.isArray(input.fixed) ? input.fixed : [];
  if (fixedIn.length > MAX_FIXED) return { error: "too_many_blocks" };
  const fixed = [];
  for (const f of fixedIn) {
    const b = validBlock(f, { needsDays: true });
    if (!b) return { error: "invalid_block" };
    fixed.push(b);
  }
  const tm = input.taskMinutes && typeof input.taskMinutes === "object" ? input.taskMinutes : {};
  return {
    prefs: {
      wake: toHHMM(wake), sleep: toHHMM(sleep),
      focusMinutes: intIn(input.focusMinutes, 25, 240, DEFAULT_PREFS.focusMinutes),
      breakMinutes: intIn(input.breakMinutes, 0, 60, DEFAULT_PREFS.breakMinutes),
      minFreeMinutes: intIn(input.minFreeMinutes, 0, 600, DEFAULT_PREFS.minFreeMinutes),
      taskMinutes: { high: intIn(tm.high, 5, 240, 45), normal: intIn(tm.normal, 5, 240, 30), low: intIn(tm.low, 5, 240, 20) },
      fixed
    }
  };
}
export function validateOverrides(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "invalid_overrides" };
  const skip = Array.isArray(input.skip) ? [...new Set(input.skip.map(s => clip(s, 60)).filter(s => /^[a-z0-9äöüß-]{1,60}$/.test(s)))] : [];
  if (skip.length > MAX_SKIP) return { error: "too_many_changes" };
  const addedIn = Array.isArray(input.added) ? input.added : [];
  if (addedIn.length > MAX_ADDED) return { error: "too_many_changes" };
  const added = [];
  for (const a of addedIn) {
    const b = validBlock(a, { needsDays: false });
    if (!b) return { error: "invalid_block" };
    added.push(b);
  }
  return { overrides: { skip, added, extraFreeMinutes: intIn(input.extraFreeMinutes, 0, MAX_EXTRA_FREE, 0), note: clip(input.note, 200).trim() } };
}

// --- Planung (reine Funktion) ---------------------------------------------------------------------

function freeIntervals(from, to, busy) {
  const sorted = busy.filter(b => b.end > from && b.start < to).sort((a, b) => a.start - b.start);
  const out = [];
  let cursor = from;
  for (const b of sorted) {
    if (b.start > cursor) out.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < to) out.push({ start: cursor, end: to });
  return out;
}

// Baut den Plan für einen Tag. Alle Zeiten sind Minuten seit Mitternacht in der Zeitzone des Nutzers.
export function buildDayPlan({ date, timezone, prefs = DEFAULT_PREFS, overrides = {}, tasks = [], routines = {}, nowMs = Date.now() }) {
  const tz = safeTimezone(timezone);
  const today = localParts(nowMs, tz);
  const weekday = weekdayOf(date);
  const wake = toMinutes(prefs.wake), sleep = toMinutes(prefs.sleep);
  const isToday = date === today.day, isPast = date < today.day;
  const from = isToday ? Math.min(sleep, Math.max(wake, Math.ceil(today.minutes / 5) * 5)) : wake;
  const skip = new Set(overrides.skip || []);
  const blocks = [], skipped = [], notes = [];
  const iso = (min) => localToUtc(date + "T" + toHHMM(Math.min(min, 23 * 60 + 59)), tz);
  const push = (b) => blocks.push({ ...b, startTime: toHHMM(b.start), endTime: toHHMM(b.end), startAt: iso(b.start), endAt: iso(b.end) });

  // 1. Feste Blöcke aus den Vorlieben (Schule, Arbeit, Sport …) und für heute hinzugefügte.
  for (const f of prefs.fixed || []) {
    if (!f.days.includes(weekday)) continue;
    const id = blockId(f.title, f.start);
    const b = { id, kind: f.kind, title: f.title, start: toMinutes(f.start), end: toMinutes(f.end), fixed: true, source: "prefs" };
    if (skip.has(id)) { skipped.push({ id, title: f.title, startTime: f.start, endTime: f.end }); continue; }
    push(b);
  }
  for (const a of overrides.added || []) push({ id: blockId(a.title, a.start), kind: a.kind, title: a.title, start: toMinutes(a.start), end: toMinutes(a.end), fixed: true, source: "today" });

  // 2. Morgenbriefing als Routine-Markierung.
  const mb = routines.morning_briefing;
  if (mb?.enabled && mb.config?.days?.includes(weekday) && toMinutes(mb.config.time) !== null) {
    const s = toMinutes(mb.config.time);
    const id = "briefing-" + mb.config.time.replace(":", "");
    if (skip.has(id)) skipped.push({ id, title: "Morgenbriefing", startTime: mb.config.time, endTime: toHHMM(s + 10) });
    else push({ id, kind: "routine", title: "Morgenbriefing", start: s, end: s + 10, fixed: true, source: "routine" });
  }

  // 3. Aufgaben mit Uhrzeit an diesem Tag sind feste Termine.
  const dayStart = localToUtc(date + "T00:00", tz), dayEnd = localToUtc(nextDate(date) + "T00:00", tz);
  const minutesFor = (t) => prefs.taskMinutes?.[t.priority] || 30;
  const flexible = [];
  for (const t of tasks) {
    if (t.status !== "open") continue;
    if (t.dueAt && t.dueAt >= dayStart && t.dueAt < dayEnd) {
      const s = localParts(Date.parse(t.dueAt), tz).minutes;
      const id = "task-" + t.id;
      if (skip.has(id)) { skipped.push({ id, title: t.title, startTime: toHHMM(s), endTime: toHHMM(s + minutesFor(t)) }); continue; }
      push({ id, kind: "task", title: t.title, start: s, end: Math.min(s + minutesFor(t), 24 * 60 - 1), fixed: true, source: "task", taskId: t.id, priority: t.priority, due: true });
    } else if (!t.dueAt || t.dueAt < dayStart) {
      if (!isPast) flexible.push({ ...t, overdue: Boolean(t.dueAt) });
    }
  }

  // 4. Flexible Aufgaben in freie Zeit einplanen: überfällige zuerst, dann nach Priorität.
  const rank = { high: 0, normal: 1, low: 2 };
  flexible.sort((a, b) => (b.overdue - a.overdue) || (rank[a.priority] - rank[b.priority]) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const reservedFree = (prefs.minFreeMinutes || 0) + (overrides.extraFreeMinutes || 0);
  const busy = blocks.map(b => ({ start: b.start, end: b.end }));
  let free = freeIntervals(from, sleep, busy);
  // Freizeit am Abend freihalten: von hinten abziehen.
  let toReserve = reservedFree;
  const reservedBlocks = [];
  for (let i = free.length - 1; i >= 0 && toReserve > 0; i--) {
    const take = Math.min(toReserve, free[i].end - free[i].start);
    if (take <= 0) continue;
    reservedBlocks.push({ start: free[i].end - take, end: free[i].end });
    free[i] = { start: free[i].start, end: free[i].end - take };
    toReserve -= take;
  }
  if (toReserve > 0) notes.push("Die gewünschte Freizeit passt heute nicht ganz in den Tag (es fehlen " + toReserve + " Minuten).");
  const unscheduled = [];
  // Jede Lücke merkt sich, wie lange an ihrem Anfang schon am Stück gearbeitet wird.
  for (const slot of free) slot.run = 0;
  for (const t of flexible) {
    const need = minutesFor(t);
    let placed = false;
    for (const slot of free) {
      const needsBreak = prefs.breakMinutes > 0 && slot.run > 0 && slot.run + need > prefs.focusMinutes;
      const start = slot.start + (needsBreak ? prefs.breakMinutes : 0);
      if (slot.end - start < need) continue;
      if (needsBreak) push({ id: "pause-" + toHHMM(slot.start).replace(":", ""), kind: "break", title: "Pause", start: slot.start, end: start, fixed: false, source: "planner" });
      push({ id: "task-" + t.id, kind: "task", title: t.title, start, end: start + need, fixed: false, source: "task", taskId: t.id, priority: t.priority, overdue: t.overdue });
      slot.start = start + need;
      slot.run = (needsBreak ? 0 : slot.run) + need;
      placed = true;
      break;
    }
    if (!placed) unscheduled.push({ id: t.id, title: t.title, priority: t.priority, minutes: need });
  }
  // 5. Verbleibende Lücken und reservierte Zeit als Freizeit zeigen.
  for (const slot of [...free, ...reservedBlocks]) {
    if (slot.end - slot.start >= GAP_MIN) push({ id: "frei-" + toHHMM(slot.start).replace(":", ""), kind: "free", title: "Freizeit", start: slot.start, end: slot.end, fixed: false, source: "planner" });
  }
  blocks.sort((a, b) => a.start - b.start || a.end - b.end);
  // Überschneidungen fester Blöcke ehrlich melden.
  const fixedBlocks = blocks.filter(b => b.fixed);
  for (let i = 1; i < fixedBlocks.length; i++) if (fixedBlocks[i].start < fixedBlocks[i - 1].end) notes.push("„" + fixedBlocks[i - 1].title + "“ und „" + fixedBlocks[i].title + "“ überschneiden sich.");
  if (isPast) notes.push("Dieser Tag liegt in der Vergangenheit; offene Aufgaben werden nicht mehr eingeplant.");
  if (!prefs.fixed?.length) notes.push("Noch keine festen Zeiten (Schule, Arbeit, Sport) eingetragen. Das geht unter „Tagesplan → Mein Rhythmus“.");

  const sum = (kind) => blocks.filter(b => b.kind === kind).reduce((n, b) => n + (b.end - b.start), 0);
  const stats = { taskMinutes: sum("task"), fixedMinutes: blocks.filter(b => b.fixed && b.kind !== "task").reduce((n, b) => n + (b.end - b.start), 0), breakMinutes: sum("break"), freeMinutes: sum("free"), plannedTasks: blocks.filter(b => b.kind === "task").length, unscheduledTasks: unscheduled.length };
  const nowMin = isToday ? today.minutes : null;
  const current = nowMin === null ? null : blocks.find(b => b.start <= nowMin && b.end > nowMin) || null;
  const next = nowMin === null ? null : blocks.find(b => b.start > nowMin && b.kind !== "free") || null;
  return {
    date, timezone: tz, weekday, isToday, window: { start: prefs.wake, end: prefs.sleep, from: toHHMM(from) },
    nowTime: nowMin === null ? null : toHHMM(nowMin),
    blocks, skipped, unscheduled, stats, notes,
    current: current && { id: current.id, title: current.title, kind: current.kind, endTime: current.endTime },
    next: next && { id: next.id, title: next.title, kind: next.kind, startTime: next.startTime },
    overrides: { skip: [...skip], added: overrides.added || [], extraFreeMinutes: overrides.extraFreeMinutes || 0, note: overrides.note || "" },
    calendar: "not_connected"
  };
}
function nextDate(date) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// --- Speicher -------------------------------------------------------------------------------------

export async function getPrefs(db) {
  const row = await db.prepare("SELECT value, updated_at FROM user_settings WHERE key = 'planner_prefs'").first();
  if (!row) return { prefs: DEFAULT_PREFS, updatedAt: null, configured: false };
  try {
    const checked = validatePrefs(JSON.parse(row.value));
    return { prefs: checked.prefs || DEFAULT_PREFS, updatedAt: row.updated_at, configured: true };
  } catch { return { prefs: DEFAULT_PREFS, updatedAt: null, configured: false }; }
}
export async function getOverrides(db, date) {
  const row = await db.prepare("SELECT overrides, updated_at FROM day_plans WHERE date = ?").bind(date).first();
  if (!row) return {};
  try { return validateOverrides(JSON.parse(row.overrides)).overrides || {}; } catch { return {}; }
}
export async function loadDayPlan(env, date, timezone, nowMs = Date.now()) {
  const db = env.DB;
  const [{ prefs }, overrides, tasks, routines] = await Promise.all([
    getPrefs(db), getOverrides(db, date), listTasks(db, "open", 100), getRoutines(db).catch(() => ({}))
  ]);
  return buildDayPlan({ date, timezone, prefs, overrides, tasks, routines, nowMs });
}
export function todayIn(timezone, nowMs = Date.now()) {
  return localParts(nowMs, safeTimezone(timezone)).day;
}

// --- API ------------------------------------------------------------------------------------------

export async function handlePlannerApi(request, env, headers, url) {
  if (!url.pathname.startsWith("/api/planner/")) return null;
  const auth = await authenticate(request, env, headers);
  if (auth.response) return auth.response;
  if (!env.DB) return json({ error: "storage_not_configured" }, 503, headers);
  const p = url.pathname.slice("/api/planner".length);
  try {
    if (p === "/prefs" && request.method === "GET") return json(await getPrefs(env.DB), 200, headers);
    if (p === "/prefs" && request.method === "PUT") {
      const body = await readJsonBody(request, 16_000);
      if (body.error) return json({ error: body.error }, body.status, headers);
      const checked = validatePrefs(body.value);
      if (checked.error) return json({ error: checked.error }, 400, headers);
      const now = new Date(Date.now()).toISOString();
      await env.DB.prepare("INSERT INTO user_settings (key, value, updated_at) VALUES ('planner_prefs', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(JSON.stringify(checked.prefs), now).run();
      await audit(env.DB, actorOf(auth.principal), "planner.prefs", null);
      return json({ prefs: checked.prefs, saved: true }, 200, headers);
    }
    if (p === "/day" && request.method === "GET") {
      const timezone = safeTimezone(url.searchParams.get("tz"));
      const date = url.searchParams.get("date") || todayIn(timezone);
      if (!isDate(date)) return json({ error: "invalid_date" }, 400, headers);
      return json({ plan: await loadDayPlan(env, date, timezone) }, 200, headers);
    }
    const m = /^\/day\/(\d{4}-\d{2}-\d{2})\/overrides$/.exec(p);
    if (m && isDate(m[1])) {
      const date = m[1];
      if (request.method === "PUT") {
        const body = await readJsonBody(request, 16_000);
        if (body.error) return json({ error: body.error }, body.status, headers);
        const checked = validateOverrides(body.value);
        if (checked.error) return json({ error: checked.error }, 400, headers);
        const now = new Date(Date.now()).toISOString();
        await env.DB.prepare("INSERT INTO day_plans (date, overrides, updated_at) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET overrides = excluded.overrides, updated_at = excluded.updated_at").bind(date, JSON.stringify(checked.overrides), now).run();
        await audit(env.DB, actorOf(auth.principal), "planner.overrides", date);
        return json({ date, overrides: checked.overrides, saved: true }, 200, headers);
      }
      if (request.method === "DELETE") {
        const res = await env.DB.prepare("DELETE FROM day_plans WHERE date = ?").bind(date).run();
        await audit(env.DB, actorOf(auth.principal), "planner.reset", date);
        return json({ date, deleted: Boolean(res.meta?.changes) }, 200, headers);
      }
    }
    return json({ error: "not_found" }, 404, headers);
  } catch {
    return json({ error: "planner_storage_unavailable", message: "Tagesplaner-Tabelle fehlt vermutlich. Migration 0007 anwenden (Deploy-Workflow erneut ausführen)." }, 503, headers);
  }
}
