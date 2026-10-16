import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";
import { localToUtc, safeTimezone } from "./agent.js";

const origin = "https://stanleebeast.github.io";
const ADMIN = "test-admin-token";
const makeEnv = (extra = {}) => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: ADMIN, ALLOWED_ORIGINS: origin, DB: createD1(), ...extra });

async function call(env, path, { method = "GET", body } = {}) {
  const headers = { Origin: origin, Authorization: "Bearer " + ADMIN };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await worker.fetch(new Request("https://jarvisss-ai.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const type = response.headers.get("Content-Type") || "";
  return { status: response.status, body: type.includes("json") ? await response.json() : null };
}
const toolCall = (id, name, args = {}) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const step = (...calls) => ({ usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [{ message: { role: "assistant", content: null, tool_calls: calls } }] });
const answer = (text) => ({ model: "gpt-4.1-mini", usage: { prompt_tokens: 150, completion_tokens: 30 }, choices: [{ message: { role: "assistant", content: text } }] });

async function chat(env, script, text = "Erinnere mich morgen früh um 6 ans Lernen") {
  const seen = [];
  let i = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://api.openai.com/v1/chat/completions")) {
      seen.push(JSON.parse(options.body));
      const next = script[Math.min(i++, script.length - 1)];
      return next instanceof Response ? next : new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(url).startsWith("https://api.open-meteo.com/")) {
      return new Response(JSON.stringify({ current: { temperature_2m: 11.4, apparent_temperature: 9.8, weather_code: 61, wind_speed_10m: 14 }, daily: { temperature_2m_min: [6], temperature_2m_max: [13], precipitation_probability_max: [80], sunset: ["2026-10-16T18:12"] } }), { status: 200 });
    }
    throw new Error("unexpected fetch " + url);
  };
  try {
    const result = await call(env, "/api/chat", { method: "POST", body: { messages: [{ role: "user", content: text }], timezone: "Europe/Berlin" } });
    return { ...result, seen };
  } finally { globalThis.fetch = original; }
}
const toolOutputs = (seen) => seen.flatMap(b => b.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content)));

test("local times convert to UTC correctly across the end of daylight saving time", () => {
  assert.equal(localToUtc("2026-10-24T06:00", "Europe/Berlin"), "2026-10-24T04:00:00.000Z");
  assert.equal(localToUtc("2026-10-25T06:00", "Europe/Berlin"), "2026-10-25T05:00:00.000Z");
  assert.equal(localToUtc("2026-03-29T12:00", "Europe/Berlin"), "2026-03-29T10:00:00.000Z");
  assert.equal(localToUtc("2026-07-01T18:30", "America/New_York"), "2026-07-01T22:30:00.000Z");
  for (const bad of ["morgen", "2026-13-01T06:00", "2026-10-24 06:00", "2026-10-24T25:00", ""]) assert.equal(localToUtc(bad, "Europe/Berlin"), null, bad);
  assert.equal(safeTimezone("Mars/Olympus"), "Europe/Berlin");
});

test("propose_task returns a proposal for the app and saves nothing", async () => {
  const env = makeEnv();
  const result = await chat(env, [step(toolCall("a", "propose_task", { title: "Lernen", due_local: "2026-10-25T06:00", priority: "high" })), answer("Vorschlag liegt bereit.")]);
  assert.equal(result.status, 200);
  assert.equal(result.body.proposals.length, 1);
  const p = result.body.proposals[0];
  assert.equal(p.type, "create_task");
  assert.deepEqual(p.payload, { title: "Lernen", details: "", dueAt: "2026-10-25T05:00:00.000Z", priority: "high" });
  assert.match(p.dueText, /Sonntag, 25\.10\.2026, 06:00/);
  assert.match(toolOutputs(result.seen)[0].due_confirmed_as, /Sonntag/);
  assert.equal(toolOutputs(result.seen)[0].status, "awaiting_user_confirmation");
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 0, "nothing may be stored before confirmation");
});

test("invalid proposals are reported back to the model instead of being offered", async () => {
  const env = makeEnv();
  const result = await chat(env, [step(toolCall("a", "propose_task", { title: "Lernen", due_local: "morgen um 6" }), toolCall("b", "propose_task", { title: "" })), answer("Bitte präzisieren.")]);
  assert.equal(result.body.proposals.length, 0);
  assert.deepEqual(toolOutputs(result.seen).map(o => o.error), ["invalid_due_local", "invalid_task_title"]);
  assert.deepEqual(result.body.toolLog.map(t => t.ok), [false, false]);
});

test("propose_task_update needs an existing task and shows its title", async () => {
  const env = makeEnv();
  const created = await call(env, "/api/tasks", { method: "POST", body: { title: "Jugendclub Getränke" } });
  const id = created.body.task.id;
  const result = await chat(env, [
    step(toolCall("a", "propose_task_update", { task_id: "nope", status: "done" }), toolCall("b", "propose_task_update", { task_id: id, due_local: "2026-10-17T15:00", priority: "high" })),
    answer("Verschiebung vorgeschlagen.")
  ], "Verschiebe Jugendclub auf morgen 15 Uhr");
  assert.equal(toolOutputs(result.seen)[0].error, "task_not_found");
  assert.equal(result.body.proposals.length, 1);
  assert.deepEqual(result.body.proposals[0].target, { id, title: "Jugendclub Getränke" });
  assert.deepEqual(result.body.proposals[0].payload, { priority: "high", dueAt: "2026-10-17T13:00:00.000Z" });
  const row = env.DB.raw.prepare("SELECT priority, due_at FROM tasks WHERE id = ?").get(id);
  assert.deepEqual({ ...row }, { priority: "normal", due_at: null }, "task must be unchanged until the user confirms");
});

test("propose_memory proposes but does not store", async () => {
  const env = makeEnv();
  const result = await chat(env, [step(toolCall("a", "propose_memory", { text: "Briefings höchstens zwei Minuten", kind: "style" })), answer("Soll ich mir das merken?")], "Merk dir, dass Briefings kurz sein sollen");
  assert.deepEqual(result.body.proposals[0].payload, { text: "Briefings höchstens zwei Minuten", kind: "style" });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM memories").get().n, 0);
});

test("without D1 only drafts are offered, never proposals", async () => {
  const env = makeEnv({ DB: undefined });
  const result = await chat(env, [step(toolCall("a", "propose_task", { title: "x" })), answer("Nur Entwurf möglich.")]);
  const offered = result.seen[0].tools.map(t => t.function.name);
  assert.ok(offered.includes("draft_task"));
  assert.ok(!offered.some(n => n.startsWith("propose_") || n === "list_tasks"));
  assert.equal(toolOutputs(result.seen)[0].error, "tool_not_allowed");
  assert.match(result.seen[0].messages[0].content, /kein Aufgabenspeicher/);
});

test("system prompt carries the current local time and honest reminder limits", async () => {
  const result = await chat(makeEnv(), [answer("Ok.")], "Hallo");
  const prompt = result.seen[0].messages[0].content;
  assert.match(prompt, /Zeitzone Europe\/Berlin/);
  assert.match(prompt, /hörbaren Wecker/);
  assert.match(prompt, /NIEMALS, es sei bereits gespeichert/);
});

test("weather tool returns real-looking structured data with source", async () => {
  const result = await chat(makeEnv(), [step(toolCall("a", "get_weather")), answer("Regnerisch.")], "Wie wird das Wetter?");
  const out = toolOutputs(result.seen)[0];
  assert.equal(out.source, "Open-Meteo");
  assert.equal(out.now.condition, "leichter Regen");
  assert.equal(out.today.rainProbabilityPercent, 80);
});

test("usage is counted per day and the daily chat limit blocks further model calls", async () => {
  const env = makeEnv({ DAILY_MAX_CHAT_REQUESTS: "1" });
  const first = await chat(env, [step(toolCall("a", "get_current_time")), answer("Es ist spät.")], "Wie spät?");
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.usage, { promptTokens: 250, completionTokens: 50 });
  const usage = await call(env, "/api/usage");
  assert.equal(usage.body.tracked, true);
  assert.equal(usage.body.usage.chatRequests, 1);
  assert.equal(usage.body.usage.promptTokens + usage.body.usage.completionTokens, 300);
  const second = await chat(env, [answer("darf nicht kommen")], "Noch was");
  assert.equal(second.status, 429);
  assert.equal(second.body.error, "daily_limit_reached");
  assert.equal(second.seen.length, 0, "the model must not be called once the limit is reached");
});

test("daily TTS character limit is enforced", async () => {
  const env = makeEnv({ DAILY_MAX_TTS_CHARS: "3" });
  const result = await call(env, "/api/tts", { method: "POST", body: { text: "Hallo" } });
  assert.equal(result.status, 429);
  assert.equal(result.body.error, "daily_limit_reached");
});

test("tool catalog exposes categories and confirmation rules", async () => {
  const withDb = await call(makeEnv(), "/api/tools");
  const byName = Object.fromEntries(withDb.body.tools.map(t => [t.name, t]));
  assert.equal(byName.get_news.category, "A");
  assert.equal(byName.propose_task.category, "B");
  assert.equal(byName.propose_task.requiresConfirmation, true);
  assert.equal(byName.propose_task.available, true);
  assert.equal(byName.draft_task.available, false);
  const noDb = await call(makeEnv({ DB: undefined }), "/api/tools");
  assert.equal(noDb.body.tools.find(t => t.name === "propose_task").available, false);
  const status = await call(makeEnv(), "/api/status");
  assert.equal(status.body.components.costs.state, "available");
  assert.equal((await call(makeEnv({ DB: undefined }), "/api/status")).body.components.costs.state, "not_configured");
});
