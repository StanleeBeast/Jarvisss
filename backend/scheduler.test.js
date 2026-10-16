import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";
import { runScheduler, localParts } from "./scheduler.js";
import { b64url } from "./push.js";

const origin = "https://stanleebeast.github.io";
const ADMIN = "test-admin-token";
const makeEnv = (extra = {}) => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: ADMIN, ALLOWED_ORIGINS: origin, DB: createD1(), ...extra });
async function call(env, path, { method = "GET", body } = {}) {
  const headers = { Origin: origin, Authorization: "Bearer " + ADMIN };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request("https://jarvisss-ai.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, body: await res.json() };
}
async function addSubscription(env) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  env.DB.raw.prepare("INSERT INTO push_subscriptions (id, label, endpoint, p256dh, auth, created_at, failures) VALUES ('s1', 'iPad', 'https://web.push.apple.com/abc', ?, ?, ?, 0)")
    .run(b64url(pub), b64url(crypto.getRandomValues(new Uint8Array(16))), new Date().toISOString());
}
// Simuliert Push-Dienst, Wetter und Nachrichten und zählt die zugestellten Pushs.
async function withServices(fn) {
  const pushes = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u.startsWith("https://web.push.apple.com/")) { pushes.push(options); return new Response("", { status: 201 }); }
    if (u.startsWith("https://api.open-meteo.com/")) return new Response(JSON.stringify({ current: { temperature_2m: 8, weather_code: 3 }, daily: { temperature_2m_min: [4], temperature_2m_max: [12], precipitation_probability_max: [20] } }));
    if (u.startsWith("https://news.google.com/")) return new Response("<rss><item><title>Meldung</title><link>https://example.org/a</link><pubDate>Mon, 19 Oct 2026 05:00:00 GMT</pubDate><source>Quelle</source></item></rss>");
    throw new Error("unexpected fetch " + u);
  };
  try { return await fn(pushes); } finally { globalThis.fetch = original; }
}
const MON_0625_CEST = Date.parse("2026-10-19T04:25:00Z"); // Montag 06:25 Sommerzeit
const enableBriefing = (env, extra = {}) => call(env, "/api/routines/morning_briefing", { method: "PUT", body: { enabled: true, timezone: "Europe/Berlin", config: { time: "06:20", days: [1, 2, 3, 4, 5], ...extra } } });

test("local time parts respect daylight saving time", () => {
  assert.deepEqual(localParts(Date.parse("2026-10-24T04:20:00Z"), "Europe/Berlin"), { day: "2026-10-24", weekday: 6, minutes: 6 * 60 + 20 });
  assert.deepEqual(localParts(Date.parse("2026-10-26T05:20:00Z"), "Europe/Berlin"), { day: "2026-10-26", weekday: 1, minutes: 6 * 60 + 20 });
});

test("routines have safe defaults and reject invalid configuration", async () => {
  const env = makeEnv();
  const defaults = await call(env, "/api/routines");
  assert.equal(defaults.body.routines.morning_briefing.enabled, false);
  assert.equal(defaults.body.routines.morning_briefing.config.time, "06:20");
  assert.equal((await call(env, "/api/routines/morning_briefing", { method: "PUT", body: { enabled: true, config: { time: "25:00", days: [1] } } })).body.error, "invalid_time");
  assert.equal((await call(env, "/api/routines/morning_briefing", { method: "PUT", body: { enabled: true, config: { time: "06:00", days: [] } } })).body.error, "invalid_days");
  assert.equal((await call(env, "/api/routines/arrival", { method: "PUT", body: { enabled: true, config: { delayMinutes: 999 } } })).body.error, "invalid_delay");
  const saved = await enableBriefing(env);
  assert.equal(saved.body.saved, true);
  assert.deepEqual(saved.body.routine.config.days, [1, 2, 3, 4, 5]);
});

test("morning briefing is sent once at the configured local time and not twice", async () => {
  const env = makeEnv();
  await addSubscription(env);
  await enableBriefing(env);
  await withServices(async (pushes) => {
    const early = await runScheduler(env, Date.parse("2026-10-19T04:10:00Z")); // 06:10 lokal
    assert.equal(early.briefing, null);
    const first = await runScheduler(env, MON_0625_CEST);
    assert.equal(first.briefing.sent, 1);
    const [a, b] = await Promise.all([runScheduler(env, MON_0625_CEST + 5 * 60000), runScheduler(env, MON_0625_CEST + 5 * 60000)]);
    assert.equal(a.briefing, null); assert.equal(b.briefing, null);
    assert.equal(pushes.length, 1, "exactly one push per day, even with overlapping cron runs");
  });
  const latest = await call(env, "/api/briefings/latest");
  assert.equal(latest.body.briefing.weather.condition, "bedeckt");
  assert.equal(latest.body.briefing.news.length, 4);
});

test("briefing respects weekdays, a missed window and the switch to winter time", async () => {
  const env = makeEnv();
  await addSubscription(env);
  await enableBriefing(env);
  await withServices(async (pushes) => {
    assert.equal((await runScheduler(env, Date.parse("2026-10-24T04:25:00Z"))).briefing, null, "Saturday is not configured");
    assert.equal((await runScheduler(env, Date.parse("2026-10-20T08:00:00Z"))).briefing, null, "10:00 local is outside the 3h window");
    assert.equal((await runScheduler(env, Date.parse("2026-10-26T04:25:00Z"))).briefing, null, "05:25 CET is before 06:20");
    assert.equal((await runScheduler(env, Date.parse("2026-10-26T05:25:00Z"))).briefing.sent, 1, "06:25 CET after the clock change");
    assert.equal(pushes.length, 1);
  });
});

test("task reminders fire once for due tasks, never for old, future or done ones", async () => {
  const env = makeEnv();
  await addSubscription(env);
  const now = Date.parse("2026-10-19T10:00:00Z");
  const mk = async (title, dueAt) => (await call(env, "/api/tasks", { method: "POST", body: { title, dueAt } })).body.task.id;
  await mk("Jetzt fällig", new Date(now - 10 * 60000).toISOString());
  await mk("Uralt", new Date(now - 7 * 3600000).toISOString());
  await mk("Zukunft", new Date(now + 3600000).toISOString());
  const doneId = await mk("Erledigt", new Date(now - 5 * 60000).toISOString());
  await call(env, "/api/tasks/" + doneId, { method: "PATCH", body: { status: "done" } });
  await withServices(async (pushes) => {
    assert.equal((await runScheduler(env, now)).reminders, 0, "routine disabled by default");
    await call(env, "/api/routines/task_reminders", { method: "PUT", body: { enabled: true, config: { hideContent: false } } });
    assert.equal((await runScheduler(env, now)).reminders, 1);
    assert.equal((await runScheduler(env, now + 5 * 60000)).reminders, 0, "no repeat");
    assert.equal(pushes.length, 1);
  });
});

test("scheduled notifications: sent once, old ones marked missed, cancel works", async () => {
  const env = makeEnv();
  await addSubscription(env);
  const created = await call(env, "/api/notifications", { method: "POST", body: { delayMinutes: 0, title: "JARVIS", body: "Pause vorbei" } });
  assert.equal(created.status, 201);
  assert.equal((await call(env, "/api/notifications", { method: "POST", body: { sendAt: "2030-01-01T00:00:00Z", title: "x", body: "y" } })).body.error, "invalid_send_at");
  assert.equal((await call(env, "/api/notifications", { method: "POST", body: { delayMinutes: 5, title: "x", body: "y", url: "https://evil.example" } })).body.error, "invalid_notification_url");
  env.DB.raw.prepare("INSERT INTO scheduled_notifications (id, send_at, title, body, created_at) VALUES ('old', ?, 'x', 'y', ?)").run(new Date(Date.now() - 3 * 3600000).toISOString(), new Date().toISOString());
  const later = await call(env, "/api/notifications", { method: "POST", body: { delayMinutes: 60, title: "JARVIS", body: "später" } });
  await withServices(async (pushes) => {
    const report = await runScheduler(env, Date.now() + 1000);
    assert.equal(report.scheduled, 1);
    assert.equal(report.missed, 1);
    assert.equal((await runScheduler(env, Date.now() + 2000)).scheduled, 0);
    assert.equal(pushes.length, 1);
  });
  assert.equal((await call(env, "/api/notifications/" + later.body.notification.id + "/cancel", { method: "POST", body: {} })).body.cancelled, true);
  assert.equal((await call(env, "/api/notifications")).body.notifications.length, 0);
});

test("arrival routine schedules one delayed overview and respects being disabled", async () => {
  const env = makeEnv();
  assert.deepEqual((await call(env, "/api/arrival", { method: "POST", body: {} })).body, { scheduled: false, reason: "routine_disabled" });
  await call(env, "/api/routines/arrival", { method: "PUT", body: { enabled: true, config: { delayMinutes: 20 } } });
  const first = await call(env, "/api/arrival", { method: "POST", body: {} });
  assert.equal(first.body.scheduled, true);
  assert.ok(Math.abs(Date.parse(first.body.sendAt) - Date.now() - 20 * 60000) < 5000);
  const second = await call(env, "/api/arrival", { method: "POST", body: {} });
  assert.equal(second.body.reason, "already_scheduled");
});

test("status reports push and scheduler honestly", async () => {
  const env = makeEnv();
  let status = (await call(env, "/api/status")).body.components;
  assert.equal(status.push.state, "not_configured");
  assert.equal(status.scheduler.state, "not_configured");
  await addSubscription(env);
  await withServices(() => runScheduler(env, Date.now()));
  status = (await call(env, "/api/status")).body.components;
  assert.equal(status.push.state, "available");
  assert.equal(status.scheduler.state, "available");
  const noDb = (await call(makeEnv({ DB: undefined }), "/api/status")).body.components;
  assert.equal(noDb.scheduler.state, "not_configured");
});

test("the worker exposes a scheduled handler for the cron trigger", async () => {
  assert.equal(typeof worker.scheduled, "function");
  let waited = null;
  await worker.scheduled({}, makeEnv(), { waitUntil: (p) => { waited = p; } });
  await waited;
  assert.ok(waited instanceof Promise);
});
