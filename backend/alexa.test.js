import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";

const origin = "https://stanleebeast.github.io";
const SKILL = "amzn1.ask.skill.12345678-aaaa-bbbb-cccc-1234567890ab";
const makeEnv = () => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: "t", ALLOWED_ORIGINS: origin, OPENAI_MODEL: "gpt-4.1-mini", DB: createD1() });
const app = (env, path, method = "GET", body) => worker.fetch(new Request("https://w.test" + path, { method, headers: { Origin: origin, Authorization: "Bearer t", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env).then(async r => ({ status: r.status, body: await r.json() }));
const alexa = (env, endpoint, request, { skill = SKILL } = {}) => worker.fetch(new Request(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: "1.0", session: { application: { applicationId: skill } }, context: { System: { application: { applicationId: skill } } }, request: { timestamp: new Date().toISOString(), ...request } }) }), env, { waitUntil() {} }).then(async r => ({ status: r.status, body: await r.json() }));
async function withFetch(handler, fn) { const o = globalThis.fetch; globalThis.fetch = handler; try { return await fn(); } finally { globalThis.fetch = o; } }
const ask = (q) => ({ type: "IntentRequest", intent: { name: "FrageIntent", slots: { frage: { name: "frage", value: q } } } });

test("setup gives a secret endpoint; wrong key or skill is rejected", async () => {
  const env = makeEnv();
  assert.equal((await app(env, "/api/alexa/setup", "POST", { skillId: "falsch" })).body.error, "invalid_skill_id");
  const { endpoint } = (await app(env, "/api/alexa/setup", "POST", { skillId: SKILL })).body;
  assert.match(endpoint, /^https:\/\/w\.test\/api\/alexa\/jva_[0-9a-f]{48}$/);
  const launch = await alexa(env, endpoint, { type: "LaunchRequest" });
  assert.match(launch.body.response.outputSpeech.text, /Hier ist Jarvis/);
  assert.equal(launch.body.response.shouldEndSession, false);
  assert.equal((await alexa(env, endpoint.replace(/.$/, "0"), { type: "LaunchRequest" })).status, 401);
  assert.equal((await alexa(env, endpoint, { type: "LaunchRequest" }, { skill: "amzn1.ask.skill.00000000-0000-0000-0000-000000000000" })).status, 403);
  const old = await worker.fetch(new Request(endpoint, { method: "POST", body: JSON.stringify({ context: { System: { application: { applicationId: SKILL } } }, request: { type: "LaunchRequest", timestamp: "2020-01-01T00:00:00Z" } }) }), env);
  assert.equal(old.status, 400, "replayed old requests are refused");
});

test("questions are answered by the fast model in spoken form", async () => {
  const env = makeEnv();
  const { endpoint } = (await app(env, "/api/alexa/setup", "POST", { skillId: SKILL })).body;
  let seen;
  const r = await withFetch(async (u, o) => { seen = JSON.parse(o.body); return Response.json({ choices: [{ message: { role: "assistant", content: "Heute: um **14 Uhr** Sport." } }] }); }, () => alexa(env, endpoint, ask("was steht heute an")));
  assert.equal(r.body.response.outputSpeech.text, "Heute: um 14 Uhr Sport.");
  assert.equal(seen.model, "gpt-4.1-mini", "fast model for Alexa's time limit");
  assert.match(seen.messages[0].content, /Gesprochenes Gespräch/);
  assert.match((await alexa(env, endpoint, { type: "IntentRequest", intent: { name: "AMAZON.StopIntent" } })).body.response.outputSpeech.text, /Bis später/);
});

test("the question word Alexa strips is put back", async () => {
  const env = makeEnv();
  const { endpoint } = (await app(env, "/api/alexa/setup", "POST", { skillId: SKILL })).body;
  let q;
  await withFetch(async (u, o) => { q = JSON.parse(o.body).messages.at(-1).content; return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }); }, () => alexa(env, endpoint, { type: "IntentRequest", intent: { name: "WasIntent", slots: { frage: { name: "frage", value: "steht heute an" } } } }));
  assert.equal(q, "Was steht heute an");
});
