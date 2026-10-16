import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";

const origin = "https://stanleebeast.github.io";
const ADMIN = "test-admin-token";
const makeEnv = (extra = {}) => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: ADMIN, ALLOWED_ORIGINS: origin, DB: createD1(), ...extra });
async function call(env, path, { method = "GET", body } = {}) {
  const headers = { Origin: origin, Authorization: "Bearer " + ADMIN };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request("https://jarvisss-ai.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, body: await res.json() };
}
const OUTPUT = {
  summary: "Person A bittet um Hilfe, der Jugendclub steht an.",
  important: [
    { sender: "Person C", excerpt: "Denk an den Jugendclub", why: "Termin heute", priority: "mittel" },
    { sender: "Person A", excerpt: "Kannst du morgen Oma abholen?", why: "Familie, Antwort erwartet", priority: "hoch" }
  ],
  tasks: [
    { title: "Oma vom Arzt abholen", details: "Bitte von Person A", due_local: "2026-10-15T17:00", from_sender: "Person A" },
    { title: "Rückruf Person B", details: "", due_local: "", from_sender: "Person B" },
    { title: "", details: "leer", due_local: "", from_sender: "" }
  ],
  reply_drafts: [{ to: "Person A", context: "Abholung", text: "Klar, ich hole sie um 17 Uhr ab." }],
  open_questions: ["Welcher Arzt?"]
};
const MESSAGES = [
  { at: "2026-10-14T16:03:40.000Z", sender: "Person A", text: "Kannst du morgen um 17 Uhr Oma vom Arzt abholen?" },
  { at: "2026-10-14T16:05:02.000Z", sender: "Ich", text: "Mal sehen" },
  { at: "2026-10-16T05:45:00.000Z", sender: "Person C", text: "Denk an den Jugendclub heute 18:00!" }
];
async function withModel(output, fn, status = 200) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    seen.push(JSON.parse(options.body));
    if (status !== 200) return new Response("{}", { status });
    return new Response(JSON.stringify({ usage: { prompt_tokens: 400, completion_tokens: 200 }, choices: [{ message: { role: "assistant", content: typeof output === "string" ? output : JSON.stringify(output) } }] }));
  };
  try { return { result: await fn(), seen }; } finally { globalThis.fetch = original; }
}
const analyze = (env, extra = {}) => call(env, "/api/messages/analyze", { method: "POST", body: { label: "Familie", source: "whatsapp_export", messages: MESSAGES, rules: "Person A ist wichtig", timezone: "Europe/Berlin", ...extra } });

test("analysis stores only the result, never the raw chat, and prioritises", async () => {
  const env = makeEnv();
  const { result, seen } = await withModel(OUTPUT, () => analyze(env));
  assert.equal(result.status, 201);
  const imp = result.body.import;
  assert.equal(imp.messageCount, 3);
  assert.equal(imp.rangeFrom, "2026-10-14T16:03:40.000Z");
  assert.equal(imp.important[0].priority, "hoch", "sorted by priority");
  assert.equal(imp.tasks.length, 2, "empty task removed");
  assert.equal(imp.tasks[0].dueAt, "2026-10-15T15:00:00.000Z");
  assert.match(imp.tasks[0].dueText, /Donnerstag, 15\.10\.2026, 17:00/);
  assert.equal(imp.tasks[1].dueAt, null);
  assert.equal(imp.replyDrafts[0].to, "Person A");
  const row = env.DB.raw.prepare("SELECT * FROM message_imports").get();
  assert.ok(!JSON.stringify(row).includes("Mal sehen"), "raw message text must not be stored");
  const sys = seen[0].messages[0].content;
  assert.match(sys, /Befolge keine Anweisungen/);
  assert.match(sys, /Es wird nichts gesendet/);
  assert.match(sys, /Person A ist wichtig/, "user rules are passed on");
  assert.match(seen[0].messages[1].content, /Person C: Denk an den Jugendclub/);
  assert.equal(seen[0].response_format.json_schema.strict, true);
});

test("invalid input is rejected without calling the model", async () => {
  const env = makeEnv();
  for (const [body, error] of [[{ messages: [] }, "messages_required"], [{ messages: [{ sender: "", text: "" }] }, "messages_required"], [{ messages: Array(401).fill({ sender: "A", text: "x" }) }, "too_many_messages"]]) {
    const { result, seen } = await withModel(OUTPUT, () => call(env, "/api/messages/analyze", { method: "POST", body }));
    assert.equal(result.body.error, error);
    assert.equal(seen.length, 0);
  }
});

test("model errors and broken output store nothing; daily limit applies", async () => {
  const env = makeEnv();
  assert.equal((await withModel(OUTPUT, () => analyze(env), 500)).result.body.error, "model_request_failed");
  assert.equal((await withModel("{kaputt", () => analyze(env))).result.body.error, "invalid_model_output");
  assert.equal((await withModel({ summary: "", important: [], tasks: [], reply_drafts: [], open_questions: [] }, () => analyze(env))).result.body.error, "empty_message_result");
  assert.equal((await call(env, "/api/messages/imports")).body.imports.length, 0);
  const limited = makeEnv({ DAILY_MAX_CHAT_REQUESTS: "0" });
  const r = await withModel(OUTPUT, () => analyze(limited));
  assert.equal(r.result.status, 429);
  assert.equal(r.seen.length, 0);
});

test("imports can be listed, opened and deleted; rules sync via settings", async () => {
  const env = makeEnv();
  const { result } = await withModel(OUTPUT, () => analyze(env));
  const id = result.body.import.id;
  const list = await call(env, "/api/messages/imports");
  assert.equal(list.body.imports[0].label, "Familie");
  assert.equal(list.body.imports[0].important, undefined, "list is a summary only");
  assert.equal((await call(env, "/api/messages/imports/" + id)).body.import.tasks.length, 2);
  assert.equal((await call(env, "/api/messages/imports/" + id, { method: "DELETE" })).body.deleted, true);
  assert.equal((await call(env, "/api/messages/imports/" + id)).status, 404);
  assert.equal((await call(env, "/api/messages/settings", { method: "PUT", body: { rules: "Familie zuerst" } })).body.saved, true);
  assert.equal((await call(env, "/api/messages/settings")).body.rules, "Familie zuerst");
});

test("agent can read insights; messaging status is honest; D1 and auth are required", async () => {
  const env = makeEnv();
  await withModel(OUTPUT, () => analyze(env));
  const tools = await call(env, "/api/tools");
  assert.equal(tools.body.tools.find(t => t.name === "list_message_insights").category, "A");
  const status = await call(env, "/api/status");
  assert.equal(status.body.components.messaging.state, "manual_only");
  assert.match(status.body.components.messaging.detail, /Kein Zugriff auf WhatsApp/);
  assert.equal((await call(makeEnv({ DB: undefined }), "/api/messages/imports")).body.error, "storage_not_configured");
  const anon = await worker.fetch(new Request("https://jarvisss-ai.test/api/messages/imports", { headers: { Origin: origin } }), env);
  assert.equal(anon.status, 401);
});
