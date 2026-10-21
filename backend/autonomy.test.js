import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";
import { runAutonomy, validateAutonomy } from "./autonomy.js";

const origin = "https://stanleebeast.github.io";
const makeEnv = () => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: "t", ALLOWED_ORIGINS: origin, DB: createD1() });
const call = (env, path, method = "GET", body) => worker.fetch(new Request("https://w.test" + path, { method, headers: { Origin: origin, Authorization: "Bearer t", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env).then(async r => ({ status: r.status, body: await r.json() }));
const AT = (iso) => Date.parse(iso);
const task = (env, title, dueIso) => env.DB.raw.prepare("INSERT INTO tasks (id, title, details, status, priority, due_at, created_at, updated_at) VALUES (?, ?, '', 'open', 'normal', ?, ?, ?)").run(crypto.randomUUID(), title, dueIso, dueIso, dueIso);

test("overdue tasks: one note per day in the afternoon, none in quiet hours", async () => {
  const env = makeEnv();
  task(env, "Mathe abgeben", "2026-10-19T08:00:00Z");
  const r1 = await runAutonomy(env, { nowMs: AT("2026-10-19T14:40:00Z") }); // 16:40 Berlin
  assert.equal(r1.overdue, 1);
  const r2 = await runAutonomy(env, { nowMs: AT("2026-10-19T14:45:00Z") });
  assert.equal(r2.overdue, 0, "only once per day");
  const r3 = await runAutonomy(env, { nowMs: AT("2026-10-19T09:00:00Z") }); // 11:00, before the set time
  assert.equal(r3.overdue, 0);
  const log = await call(env, "/api/autonomy");
  assert.equal(log.body.entries[0].title, "1 Aufgabe ist überfällig");
  assert.equal(log.body.entries[0].detail, "Mathe abgeben");
});

test("important unanswered mail is flagged once", async () => {
  const env = makeEnv();
  const old = "2026-10-19T05:00:00Z";
  env.DB.raw.prepare("INSERT INTO mail_messages (id, account, account_label, uid, from_name, from_addr, subject, received_at, importance, category, needs_reply, suspicious, status, analyzed_at, updated_at) VALUES ('m1', 'g', 'Gmail', '1', 'Frau Lehmann', 'l@s.de', 'Facharbeit', ?, 5, 'schule', 1, 0, 'new', ?, ?)").run(old, old, old);
  assert.equal((await runAutonomy(env, { nowMs: AT("2026-10-19T10:00:00Z") })).mailWatch, 1);
  assert.equal((await runAutonomy(env, { nowMs: AT("2026-10-19T10:05:00Z") })).mailWatch, 0);
});

test("morning day prep runs once, stores proposals, respects the budget", async () => {
  const env = makeEnv();
  let calls = 0;
  const prepareDay = async () => { calls++; return { reply: "Guten Morgen! 8 Grad, um 14 Uhr Sport.", proposals: [{ id: "p1", type: "create_task", payload: { title: "Sporttasche packen" } }] }; };
  const r = await runAutonomy(env, { nowMs: AT("2026-10-20T04:35:00Z"), prepareDay }); // 06:35 Berlin
  assert.equal(r.dayPrep.proposals, 1);
  await runAutonomy(env, { nowMs: AT("2026-10-20T04:40:00Z"), prepareDay });
  assert.equal(calls, 1, "once per day");
  const e = (await call(env, "/api/autonomy")).body.entries.find(x => x.kind === "day_prep");
  assert.equal(e.title, "Dein Tag ist vorbereitet");
  assert.equal(e.proposals[0].payload.title, "Sporttasche packen");
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 0, "nothing executed, only proposed");
  // Sparmodus: keine KI-Vorbereitung
  const env2 = makeEnv();
  env2.DB.raw.prepare("INSERT INTO usage_daily (day, cost_micros) VALUES (?, ?)").run(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date()), 4_500_000);
  let calls2 = 0;
  await runAutonomy(env2, { nowMs: AT("2026-10-20T04:35:00Z"), prepareDay: async () => { calls2++; return {}; } });
  assert.equal(calls2, 0);
});

test("settings are validated and saved; autonomy can be switched off", async () => {
  assert.equal(validateAutonomy({ dayPrep: { time: "25:00" } }).error, "invalid_time");
  const env = makeEnv();
  const saved = await call(env, "/api/autonomy/settings", "PUT", { overdue: { enabled: false }, dayPrep: { time: "07:15", days: [1, 2, 3, 4, 5] } });
  assert.equal(saved.body.saved, true);
  assert.equal(saved.body.settings.dayPrep.time, "07:15");
  task(env, "x", "2026-10-19T08:00:00Z");
  assert.equal((await runAutonomy(env, { nowMs: AT("2026-10-19T14:40:00Z") })).overdue, 0);
  const anon = await worker.fetch(new Request("https://w.test/api/autonomy", { headers: { Origin: origin } }), env);
  assert.equal(anon.status, 401);
});
