import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";

const origin = "https://stanleebeast.github.io";
const makeEnv = (extra = {}) => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: "t", ALLOWED_ORIGINS: origin, OPENAI_MODEL: "gpt-4.1-mini", DB: createD1(), ...extra });
const chat = (env, text, extra = {}) => worker.fetch(new Request("https://w.test/api/chat", { method: "POST", headers: { Origin: origin, Authorization: "Bearer t", "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: text }], timezone: "Europe/Berlin", ...extra }) }), env).then(async r => ({ status: r.status, body: await r.json() }));
const tc = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const step = (...calls) => ({ usage: {}, choices: [{ message: { role: "assistant", content: null, tool_calls: calls } }] });
const say = (t) => ({ usage: {}, choices: [{ message: { role: "assistant", content: t } }] });
async function withFetch(handler, fn) { const o = globalThis.fetch; globalThis.fetch = handler; try { return await fn(); } finally { globalThis.fetch = o; } }

test("agent uses the reasoning model with proper parameters", async () => {
  const seen = [];
  const r = await withFetch(async (url, o) => { seen.push(JSON.parse(o.body)); return Response.json(say("Hallo!")); }, () => chat(makeEnv(), "Hi"));
  assert.equal(r.body.reply, "Hallo!");
  assert.equal(seen[0].model, "gpt-5-mini");
  assert.equal(seen[0].temperature, undefined);
  assert.equal(seen[0].reasoning_effort, "low");
  assert.ok(seen[0].max_completion_tokens > 0);
});

test("falls back to the proven model when the reasoning model is not available", async () => {
  const models = [];
  const r = await withFetch(async (url, o) => {
    const b = JSON.parse(o.body); models.push(b.model);
    if (b.model === "gpt-5-mini") return new Response(JSON.stringify({ error: { code: "model_not_found" } }), { status: 404 });
    assert.equal(b.temperature, 0.4);
    return Response.json(say("Rückfall klappt."));
  }, () => chat(makeEnv(), "Hi"));
  assert.equal(r.body.reply, "Rückfall klappt.");
  assert.deepEqual(models, ["gpt-5-mini", "gpt-4.1-mini"]);
});

test("web search returns an answer with sources", async () => {
  let i = 0, toolOut;
  const r = await withFetch(async (url, o) => {
    if (String(url).endsWith("/v1/responses")) {
      const b = JSON.parse(o.body);
      assert.equal(b.tools[0].type, "web_search");
      return Response.json({ usage: { input_tokens: 100, output_tokens: 50 }, output: [{ type: "message", content: [{ type: "output_text", text: "Das Freibad Kamenz hat bis 19 Uhr geöffnet.", annotations: [{ type: "url_citation", url: "https://kamenz.de/freibad", title: "Stadt Kamenz" }] }] }] });
    }
    const b = JSON.parse(o.body);
    const tool = b.messages.find(m => m.role === "tool");
    if (tool) toolOut = JSON.parse(tool.content);
    return Response.json(i++ === 0 ? step(tc("s", "web_search", { query: "Freibad Kamenz Öffnungszeiten" })) : say("Bis 19 Uhr, laut Stadt Kamenz."));
  }, () => chat(makeEnv(), "Wie lange hat das Freibad in Kamenz offen?"));
  assert.equal(r.body.reply, "Bis 19 Uhr, laut Stadt Kamenz.");
  assert.match(toolOut.answer, /19 Uhr/);
  assert.deepEqual(toolOut.sources, [{ title: "Stadt Kamenz", url: "https://kamenz.de/freibad" }]);
});

test("remember stores what the user says, skips duplicates and secrets, respects the switch", async () => {
  const env = makeEnv();
  const script = [step(tc("a", "remember", { text: "Geht in die 10. Klasse der Oberschule Kamenz", kind: "fact" }), tc("b", "remember", { text: "Mein Passwort ist 1234", kind: "fact" })), say("Gemerkt.")];
  let i = 0, outs = [];
  const r = await withFetch(async (url, o) => { const b = JSON.parse(o.body); outs = b.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content)); return Response.json(script[Math.min(i++, 2)]); }, () => chat(env, "Ich bin in der 10. Klasse in Kamenz"));
  assert.equal(r.body.memoriesChanged, true);
  assert.equal(outs[0].saved, true);
  assert.equal(outs[1].error, "sensitive_not_stored");
  const rows = env.DB.raw.prepare("SELECT text, created_by FROM memories").all();
  assert.deepEqual(rows.map(x => [x.text, x.created_by]), [["Geht in die 10. Klasse der Oberschule Kamenz", "jarvis"]]);
  // Gedächtnis aus der Datenbank fließt in die nächste Anfrage ein
  let sys = "";
  await withFetch(async (url, o) => { sys = JSON.parse(o.body).messages[0].content; return Response.json(say("Ok")); }, () => chat(env, "Was weißt du über mich?"));
  assert.match(sys, /10\. Klasse der Oberschule Kamenz/);
  // Automatisches Merken aus
  i = 0;
  await withFetch(async (url, o) => { const b = JSON.parse(o.body); outs = b.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content)); return Response.json(i++ === 0 ? step(tc("c", "remember", { text: "Mag Pizza", kind: "preference" })) : say("ok")); }, () => chat(env, "Ich mag Pizza", { profile: { autoMemory: false } }));
  assert.equal(outs[0].error, "auto_memory_off");
});
