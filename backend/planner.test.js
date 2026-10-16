import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";
import { buildDayPlan, validatePrefs, validateOverrides, DEFAULT_PREFS } from "./planner.js";

const origin = "https://stanleebeast.github.io";
const ADMIN = "test-admin-token";
const makeEnv = (extra = {}) => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: ADMIN, ALLOWED_ORIGINS: origin, DB: createD1(), ...extra });
async function call(env, path, { method = "GET", body } = {}) {
  const headers = { Origin: origin, Authorization: "Bearer " + ADMIN };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request("https://jarvisss-ai.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, body: await res.json() };
}

// Freitag, 16.10.2026 (Sommerzeit, UTC+2)
const DATE = "2026-10-16";
const PREFS = validatePrefs({
  wake: "07:00", sleep: "22:00", focusMinutes: 60, breakMinutes: 15, minFreeMinutes: 90,
  fixed: [
    { title: "Schule", start: "08:00", end: "15:00", days: [1, 2, 3, 4, 5], kind: "school" },
    { title: "Sport", start: "18:00", end: "19:00", days: [5], kind: "sport" },
    { title: "Fußball", start: "10:00", end: "12:00", days: [6], kind: "sport" }
  ]
}).prefs;
const task = (id, title, priority, dueAt = null, createdAt = "2026-10-01T00:00:00.000Z") => ({ id, title, priority, dueAt, status: "open", createdAt });
const TASKS = [
  task("t1", "Mathe-Hausaufgabe", "high"),
  task("t2", "Zimmer aufräumen", "low"),
  task("t3", "Oma vom Arzt abholen", "normal", "2026-10-16T15:00:00.000Z"),
  task("t4", "Bewerbung schicken", "normal", "2026-10-14T10:00:00.000Z"),
  task("t5", "Referat vorbereiten", "high"),
  { ...task("t6", "Schon erledigt", "high"), status: "done" },
  task("t7", "Nächste Woche", "high", "2026-10-20T10:00:00.000Z")
];
const at = (plan, title) => plan.blocks.find(b => b.title === title);

test("day plan: fixed blocks, timed tasks, overdue first, breaks, evening free time", () => {
  const plan = buildDayPlan({ date: DATE, timezone: "Europe/Berlin", prefs: PREFS, tasks: TASKS, nowMs: Date.parse("2026-10-16T04:00:00Z") });
  assert.equal(plan.isToday, true);
  assert.equal(plan.weekday, 5);
  assert.equal(plan.window.from, "07:00", "plan starts at wake time when it is earlier");
  assert.deepEqual([at(plan, "Schule").startTime, at(plan, "Schule").endTime], ["08:00", "15:00"]);
  assert.equal(at(plan, "Sport").startTime, "18:00");
  assert.equal(at(plan, "Fußball"), undefined, "Saturday block not on Friday");
  const oma = at(plan, "Oma vom Arzt abholen");
  assert.equal(oma.startTime, "17:00", "timed task at its local time (UTC+2)");
  assert.equal(oma.fixed, true);
  const flex = plan.blocks.filter(b => b.kind === "task" && !b.fixed).map(b => b.title);
  assert.deepEqual(flex, ["Bewerbung schicken", "Zimmer aufräumen", "Mathe-Hausaufgabe", "Referat vorbereiten"], "overdue first; a short task fills the gap before school");
  assert.ok(!plan.blocks.some(b => b.title === "Schon erledigt" || b.title === "Nächste Woche"));
  // 07:00–08:00: überfällige Aufgabe (30 min) und die kurze (20 min); die langen nach der Schule ab 15:00.
  assert.equal(at(plan, "Bewerbung schicken").startTime, "07:00");
  assert.equal(at(plan, "Mathe-Hausaufgabe").startTime, "15:00");
  assert.ok(plan.blocks.some(b => b.kind === "break"), "a break after the focus limit");
  // Abend: 90 Minuten Freizeit vor dem Schlafen bleiben frei.
  const last = plan.blocks.at(-1);
  assert.equal(last.kind, "free");
  assert.equal(last.endTime, "22:00");
  assert.ok(last.end - last.start >= 90);
  for (let i = 1; i < plan.blocks.length; i++) assert.ok(plan.blocks[i].start >= plan.blocks[i - 1].end, "no overlaps: " + plan.blocks[i].title);
  assert.equal(oma.startAt, "2026-10-16T15:00:00.000Z");
  assert.equal(plan.current, null, "06:00 is before wake time");
  assert.equal(plan.next.title, "Bewerbung schicken");
});

test("day plan: later in the day only plans from now, unscheduled tasks are reported", () => {
  const many = Array.from({ length: 12 }, (_, i) => task("m" + i, "Aufgabe " + i, "high"));
  const plan = buildDayPlan({ date: DATE, timezone: "Europe/Berlin", prefs: PREFS, tasks: many, nowMs: Date.parse("2026-10-16T16:03:00Z") });
  assert.equal(plan.window.from, "18:05", "rounded up to 5 minutes");
  assert.ok(plan.blocks.every(b => b.end <= 22 * 60));
  assert.ok(plan.blocks.filter(b => !b.fixed).every(b => b.start >= 19 * 60), "nothing planned into the sport block");
  assert.ok(plan.unscheduled.length > 0);
  assert.equal(plan.stats.unscheduledTasks, plan.unscheduled.length);
  assert.equal(plan.current.title, "Sport");
});

test("overrides: skipped block, extra free time, added block", () => {
  const base = buildDayPlan({ date: DATE, timezone: "Europe/Berlin", prefs: PREFS, tasks: TASKS, nowMs: Date.parse("2026-10-16T04:00:00Z") });
  const sport = at(base, "Sport");
  const overrides = validateOverrides({ skip: [sport.id], extraFreeMinutes: 60, added: [{ title: "Kino", start: "20:00", end: "21:30", kind: "other" }] }).overrides;
  const plan = buildDayPlan({ date: DATE, timezone: "Europe/Berlin", prefs: PREFS, overrides, tasks: TASKS, nowMs: Date.parse("2026-10-16T04:00:00Z") });
  assert.equal(at(plan, "Sport"), undefined);
  assert.equal(plan.skipped[0].title, "Sport");
  assert.equal(at(plan, "Kino").startTime, "20:00");
  assert.ok(plan.stats.freeMinutes >= 150 - 1, "at least 90 + 60 minutes free");
  assert.equal(plan.overrides.extraFreeMinutes, 60);
});

test("validation rejects broken preferences and overrides", () => {
  assert.equal(validatePrefs({ wake: "22:00", sleep: "23:00" }).error, "invalid_day_window");
  assert.equal(validatePrefs({ fixed: [{ title: "X", start: "10:00", end: "09:00", days: [1] }] }).error, "invalid_block");
  assert.equal(validatePrefs({ fixed: [{ title: "X", start: "09:00", end: "10:00", days: [] }] }).error, "invalid_block");
  assert.equal(validatePrefs([]).error, "invalid_prefs");
  assert.deepEqual(validatePrefs({}).prefs.fixed, []);
  assert.equal(validateOverrides({ added: [{ title: "", start: "10:00", end: "11:00" }] }).error, "invalid_block");
  assert.equal(validateOverrides({ extraFreeMinutes: 99999 }).overrides.extraFreeMinutes, 0);
  assert.deepEqual(validateOverrides({ skip: ["sport-1800", "<script>"] }).overrides.skip, ["sport-1800"]);
  const p = buildDayPlan({ date: "2026-10-01", timezone: "Europe/Berlin", prefs: DEFAULT_PREFS, tasks: TASKS, nowMs: Date.parse("2026-10-16T04:00:00Z") });
  assert.equal(p.blocks.filter(b => b.kind === "task").length, 0, "no tasks planned into the past");
  assert.ok(p.notes.some(n => /Vergangenheit/.test(n)));
});

test("API: preferences, day plan and confirmed overrides; storage and auth required", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "/api/planner/prefs")).body.configured, false);
  assert.equal((await call(env, "/api/planner/prefs", { method: "PUT", body: { wake: "09:00", sleep: "09:30" } })).body.error, "invalid_day_window");
  const saved = await call(env, "/api/planner/prefs", { method: "PUT", body: { wake: "07:00", sleep: "22:00", fixed: [{ title: "Sport", start: "18:00", end: "19:00", days: [1, 2, 3, 4, 5, 6, 7], kind: "sport" }] } });
  assert.equal(saved.body.saved, true);
  assert.equal((await call(env, "/api/planner/prefs")).body.prefs.fixed[0].title, "Sport");
  await call(env, "/api/tasks", { method: "POST", body: { title: "Lernen", priority: "high" } });
  const day = await call(env, "/api/planner/day?date=2030-01-07&tz=Europe/Berlin");
  assert.equal(day.status, 200);
  assert.ok(day.body.plan.blocks.some(b => b.title === "Lernen"));
  const sport = day.body.plan.blocks.find(b => b.title === "Sport");
  assert.equal((await call(env, "/api/planner/day/2030-01-07/overrides", { method: "PUT", body: { skip: [sport.id], extraFreeMinutes: 30 } })).body.saved, true);
  const after = await call(env, "/api/planner/day?date=2030-01-07&tz=Europe/Berlin");
  assert.equal(after.body.plan.blocks.find(b => b.title === "Sport"), undefined);
  assert.equal(after.body.plan.skipped[0].title, "Sport");
  assert.equal((await call(env, "/api/planner/day/2030-01-07/overrides", { method: "DELETE" })).body.deleted, true);
  assert.ok((await call(env, "/api/planner/day?date=2030-01-07")).body.plan.blocks.some(b => b.title === "Sport"));
  assert.equal((await call(env, "/api/planner/day?date=gestern")).body.error, "invalid_date");
  assert.equal((await call(env, "/api/planner/day/2030-01-07/overrides", { method: "PUT", body: { added: [{ title: "x", start: "25:00", end: "26:00" }] } })).body.error, "invalid_block");
  const audit = env.DB.raw.prepare("SELECT action FROM audit_log WHERE action LIKE 'planner.%'").all().map(r => r.action);
  assert.deepEqual(audit, ["planner.prefs", "planner.overrides", "planner.reset"]);
  assert.equal((await call(makeEnv({ DB: undefined }), "/api/planner/day")).body.error, "storage_not_configured");
  const anon = await worker.fetch(new Request("https://jarvisss-ai.test/api/planner/day", { headers: { Origin: origin } }), env);
  assert.equal(anon.status, 401);
  const status = await call(env, "/api/status");
  assert.equal(status.body.components.planner.state, "available");
});

// --- Agent ---------------------------------------------------------------------------------------
const toolCall = (id, name, args = {}) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const step = (...calls) => ({ usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [{ message: { role: "assistant", content: null, tool_calls: calls } }] });
const answer = (text) => ({ usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [{ message: { role: "assistant", content: text } }] });
async function chat(env, script, text) {
  const seen = [];
  let i = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    seen.push(JSON.parse(options.body));
    return new Response(JSON.stringify(script[Math.min(i++, script.length - 1)]), { status: 200 });
  };
  try { return { ...(await call(env, "/api/chat", { method: "POST", body: { messages: [{ role: "user", content: text }], timezone: "Europe/Berlin" } })), seen }; }
  finally { globalThis.fetch = original; }
}
const toolOutputs = (seen) => seen.flatMap(b => b.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content)));

test("agent: reads the plan and only proposes changes (nothing stored)", async () => {
  const env = makeEnv();
  await call(env, "/api/planner/prefs", { method: "PUT", body: { fixed: [{ title: "Sport", start: "18:00", end: "19:00", days: [1, 2, 3, 4, 5, 6, 7], kind: "sport" }] } });
  const r = await chat(env, [
    step(toolCall("a", "get_day_plan", { date_local: "2030-01-07" })),
    step(toolCall("b", "propose_plan_change", { date_local: "2030-01-07", skip_blocks: ["sport"], extra_free_minutes: 60 })),
    answer("Vorschlag liegt bereit.")
  ], "Sport fällt heute aus, ich brauche mehr Freizeit");
  assert.equal(r.status, 200);
  const outs = toolOutputs(r.seen);
  assert.ok(outs[0].blocks.some(b => b.title === "Sport"));
  assert.match(outs[0].hint, /Kein Kalender/);
  const p = r.body.proposals[0];
  assert.equal(p.type, "plan_change");
  assert.equal(p.date, "2030-01-07");
  assert.deepEqual(p.payload.skip, ["sport-1800"]);
  assert.equal(p.payload.extraFreeMinutes, 60);
  assert.deepEqual(p.changes.map(c => c.action), ["skip", "free"]);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM day_plans").get().n, 0, "nothing stored before confirmation");
  assert.match(r.seen[0].messages[0].content, /Sport fällt heute aus/);
  const bad = await chat(env, [step(toolCall("a", "propose_plan_change", { date_local: "2030-01-07", skip_blocks: ["Ballett"] })), answer("?")], "Ballett fällt aus");
  assert.equal(toolOutputs(bad.seen)[0].error, "block_not_found");
  assert.equal(bad.body.proposals.length, 0);
});
