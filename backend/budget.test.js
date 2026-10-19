import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";
import { tokenCost, usageDay } from "./usage.js";

const origin = "https://stanleebeast.github.io";
const makeEnv = (extra = {}) => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: "t", ALLOWED_ORIGINS: origin, OPENAI_MODEL: "gpt-4.1-mini", DB: createD1(), ...extra });
const call = (env, path, body) => worker.fetch(new Request("https://w.test" + path, { method: body ? "POST" : "GET", headers: { Origin: origin, Authorization: "Bearer t", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env).then(async r => ({ status: r.status, body: await r.json() }));
const spend = (env, usd, day = usageDay()) => env.DB.raw.prepare("INSERT INTO usage_daily (day, cost_micros) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET cost_micros = cost_micros + excluded.cost_micros").run(day, Math.round(usd * 1e6));
async function withFetch(handler, fn) { const o = globalThis.fetch; globalThis.fetch = handler; try { return await fn(); } finally { globalThis.fetch = o; } }
const say = (t) => ({ usage: { prompt_tokens: 2000, completion_tokens: 500 }, choices: [{ message: { role: "assistant", content: t } }] });
const chatBody = { messages: [{ role: "user", content: "Hi" }], timezone: "Europe/Berlin" };

test("costs are estimated per model and summed per month", async () => {
  assert.equal(tokenCost("gpt-5-mini", 1e6, 0), 0.25);
  assert.equal(tokenCost("gpt-4.1-mini-2025", 0, 1e6), 1.6);
  assert.equal(tokenCost("unbekannt", 1e6, 0), 2);
  const env = makeEnv();
  spend(env, 1.2, "2020-01-15"); // anderer Monat zählt nicht
  await withFetch(async () => Response.json(say("Hallo")), () => call(env, "/api/chat", chatBody));
  const u = await call(env, "/api/usage");
  assert.equal(u.body.budget.limitUsd, 5);
  assert.ok(u.body.budget.spentUsd > 0 && u.body.budget.spentUsd < 0.01, String(u.body.budget.spentUsd));
  assert.equal(u.body.budget.level, "ok");
});

test("from 80 % JARVIS saves: cheaper model, no web search", async () => {
  const env = makeEnv();
  spend(env, 4.1);
  let seen;
  const r = await withFetch(async (url, o) => { seen = JSON.parse(o.body); return Response.json(say("Spare.")); }, () => call(env, "/api/chat", chatBody));
  assert.equal(r.body.reply, "Spare.");
  assert.equal(seen.model, "gpt-4.1-mini");
  assert.equal(seen.tools.some(t => t.function.name === "web_search"), false);
  assert.equal(r.body.budget.level, "saving");
  const status = await call(env, "/api/status");
  assert.match(status.body.components.costs.detail, /Sparmodus/);
});

test("at the monthly limit no paid OpenAI calls happen", async () => {
  const env = makeEnv({ MONTHLY_BUDGET_USD: "5" });
  spend(env, 5.01);
  let calls = 0;
  await withFetch(async () => { calls++; return Response.json(say("x")); }, async () => {
    const r = await call(env, "/api/chat", chatBody);
    assert.equal(r.status, 429);
    assert.equal(r.body.error, "monthly_budget_reached");
    const tts = await call(env, "/api/tts", { text: "Hallo" });
    assert.equal(tts.body.error, "monthly_budget_reached");
  });
  assert.equal(calls, 0);
  const status = await call(env, "/api/status");
  assert.equal(status.body.components.costs.state, "warning");
});
