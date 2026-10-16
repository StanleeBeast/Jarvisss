import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";

const env = {
  OPENAI_API_KEY: "test-openai-key",
  JARVIS_ACCESS_TOKEN: "test-jarvis-token",
  ALLOWED_ORIGINS: "https://stanleebeast.github.io",
  OPENAI_MODEL: "gpt-4.1-mini"
};
const origin = "https://stanleebeast.github.io";
function req(path, { method = "GET", token, body, requestOrigin = origin } = {}) {
  const headers = {};
  if (requestOrigin) headers.Origin = requestOrigin;
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request("https://jarvisss-ai.test" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
}
async function json(response) { return { status: response.status, body: await response.json() }; }

test("health endpoint exposes status but no secret values", async () => {
  const result = await json(await worker.fetch(req("/health"), env));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { status: "ok", service: "jarvisss-ai-proxy", configured: true });
});

test("chat endpoint rejects missing and incorrect bearer tokens", async () => {
  const noToken = await json(await worker.fetch(req("/api/chat", { method: "POST", body: { mode: "healthcheck" } }), env));
  assert.equal(noToken.status, 401);
  assert.equal(noToken.body.error, "unauthorized");
  const wrongToken = await json(await worker.fetch(req("/api/chat", { method: "POST", token: "wrong", body: { mode: "healthcheck" } }), env));
  assert.equal(wrongToken.status, 401);
});

test("chat endpoint rejects unapproved browser origins", async () => {
  const response = await worker.fetch(req("/api/chat", { method: "POST", token: env.JARVIS_ACCESS_TOKEN, body: { mode: "healthcheck" }, requestOrigin: "https://evil.example" }), env);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("authenticated healthcheck does not call the model provider", async () => {
  const result = await json(await worker.fetch(req("/api/chat", { method: "POST", token: env.JARVIS_ACCESS_TOKEN, body: { mode: "healthcheck" } }), env));
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, "Verbindungstest erfolgreich.");
  assert.equal(result.body.model, "gpt-4.1-mini");
});

test("missing server secrets fail closed", async () => {
  const result = await json(await worker.fetch(req("/api/chat", { method: "POST", token: "anything", body: { mode: "healthcheck" } }), {}));
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "backend_not_configured");
});

test("unknown routes return 404", async () => {
  const result = await json(await worker.fetch(req("/not-a-route"), env));
  assert.equal(result.status, 404);
});

test("invalid JSON is rejected", async () => {
  const response = await worker.fetch(new Request("https://jarvisss-ai.test/api/chat", {
    method: "POST",
    headers: { Origin: origin, Authorization: "Bearer " + env.JARVIS_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: "{not json"
  }), env);
  const result = await json(response);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "invalid_json");
});

test("model response is passed back without exposing the API key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer " + env.OPENAI_API_KEY);
    return new Response(JSON.stringify({ model: "gpt-4.1-mini", choices: [{ message: { content: "  Hallo!  " } }] }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const result = await json(await worker.fetch(req("/api/chat", { method: "POST", token: env.JARVIS_ACCESS_TOKEN, body: { messages: [{ role: "user", content: "Hallo" }] } }), env));
    assert.equal(result.status, 200);
    assert.equal(result.body.reply, "Hallo!");
    assert.equal(result.body.model, "gpt-4.1-mini");
    assert.equal(JSON.stringify(result.body).includes(env.OPENAI_API_KEY), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Agentenschleife und Werkzeuge ---------------------------------------
import { createD1 } from "./test-support/d1.js";

function mockModel(responses, seen = []) {
  let i = 0;
  return async (url, options) => {
    if (url !== "https://api.openai.com/v1/chat/completions") throw new Error("unexpected fetch " + url);
    const body = JSON.parse(options.body);
    seen.push(body);
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next instanceof Response) return next;
    return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}
async function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = original; }
}
const chatBody = { messages: [{ role: "user", content: "Welche Aufgaben habe ich?" }], timezone: "Europe/Berlin" };
const toolCall = (id, name, args = {}) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

test("agent answers every tool call and reads tasks only through the read tool", async () => {
  const DB = createD1();
  await worker.fetch(req("/api/tasks", { method: "POST", token: env.JARVIS_ACCESS_TOKEN, body: { title: "Sporteinheit" } }), { ...env, DB });
  const seen = [];
  const fake = mockModel([
    { choices: [{ message: { role: "assistant", content: null, tool_calls: [toolCall("a", "list_tasks", { status: "open" }), toolCall("b", "get_current_time")] } }] },
    { model: "gpt-4.1-mini", choices: [{ message: { role: "assistant", content: "Du hast eine offene Aufgabe: Sporteinheit." } }] }
  ], seen);
  const result = await withFetch(fake, async () => json(await worker.fetch(req("/api/chat", { method: "POST", token: env.JARVIS_ACCESS_TOKEN, body: chatBody }), { ...env, DB })));
  assert.equal(result.status, 200);
  assert.match(result.body.reply, /Sporteinheit/);
  assert.deepEqual(result.body.toolLog, [{ tool: "list_tasks", ok: true }, { tool: "get_current_time", ok: true }]);
  const toolMessages = seen[1].messages.filter(m => m.role === "tool");
  assert.deepEqual(toolMessages.map(m => m.tool_call_id), ["a", "b"]);
  assert.match(toolMessages[0].content, /Sporteinheit/);
  assert.ok(seen[0].tools.some(t => t.function.name === "list_tasks"));
});

test("list_tasks is not offered and is refused when no database is bound", async () => {
  const seen = [];
  const fake = mockModel([
    { choices: [{ message: { role: "assistant", content: null, tool_calls: [toolCall("a", "list_tasks", { status: "open" })] } }] },
    { choices: [{ message: { role: "assistant", content: "Der Aufgabenspeicher ist nicht verbunden." } }] }
  ], seen);
  const result = await withFetch(fake, async () => json(await worker.fetch(req("/api/chat", { method: "POST", token: env.JARVIS_ACCESS_TOKEN, body: chatBody }), env)));
  assert.equal(result.status, 200);
  assert.equal(seen[0].tools.some(t => t.function.name === "list_tasks"), false);
  assert.deepEqual(result.body.toolLog, [{ tool: "list_tasks", ok: false }]);
  assert.match(seen[1].messages.at(-1).content, /tool_not_allowed/);
});

test("agent stops after the step limit instead of looping forever", async () => {
  let calls = 0;
  const loop = { choices: [{ message: { role: "assistant", content: null, tool_calls: [toolCall("x", "get_current_time")] } }] };
  const fake = async (url, options) => { calls++; return mockModel([loop])(url, options); };
  const result = await withFetch(fake, async () => json(await worker.fetch(req("/api/chat", { method: "POST", token: env.JARVIS_ACCESS_TOKEN, body: chatBody }), env)));
  assert.equal(result.status, 502);
  assert.equal(result.body.error, "agent_step_limit");
  assert.equal(calls, 4);
});

test("invalid tool arguments are reported to the model, not executed", async () => {
  const seen = [];
  const fake = mockModel([
    { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "get_news", arguments: "{kaputt" } }] } }] },
    { choices: [{ message: { role: "assistant", content: "Fehler erkannt." } }] }
  ], seen);
  const result = await withFetch(fake, async () => json(await worker.fetch(req("/api/chat", { method: "POST", token: env.JARVIS_ACCESS_TOKEN, body: chatBody }), env)));
  assert.equal(result.status, 200);
  assert.match(seen[1].messages.at(-1).content, /invalid_tool_arguments/);
});

test("model rate limit is surfaced as an error", async () => {
  const fake = mockModel([new Response("{}", { status: 429 })]);
  const result = await withFetch(fake, async () => json(await worker.fetch(req("/api/chat", { method: "POST", token: env.JARVIS_ACCESS_TOKEN, body: chatBody }), env)));
  assert.equal(result.status, 502);
  assert.equal(result.body.error, "model_rate_limited");
});

test("unreachable model provider is reported", async () => {
  const fake = async () => { throw new TypeError("network down"); };
  const result = await withFetch(fake, async () => json(await worker.fetch(req("/api/chat", { method: "POST", token: env.JARVIS_ACCESS_TOKEN, body: chatBody }), env)));
  assert.equal(result.status, 502);
  assert.equal(result.body.error, "model_unreachable");
});

test("chat without messages is rejected", async () => {
  const result = await json(await worker.fetch(req("/api/chat", { method: "POST", token: env.JARVIS_ACCESS_TOKEN, body: { messages: [] } }), env));
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "messages_required");
});

test("oversized chat payload is rejected", async () => {
  const big = { messages: [{ role: "user", content: "x".repeat(60_000) }] };
  const result = await json(await worker.fetch(req("/api/chat", { method: "POST", token: env.JARVIS_ACCESS_TOKEN, body: big }), env));
  assert.equal(result.status, 413);
});

test("tts only forwards allow-listed voices", async () => {
  const voices = [];
  const fake = async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/audio/speech");
    voices.push(JSON.parse(options.body).voice);
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  };
  await withFetch(fake, async () => {
    const ok = await worker.fetch(req("/api/tts", { method: "POST", token: env.JARVIS_ACCESS_TOKEN, body: { text: "Hallo", voice: "onyx" } }), env);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("Content-Type"), "audio/mpeg");
    await worker.fetch(req("/api/tts", { method: "POST", token: env.JARVIS_ACCESS_TOKEN, body: { text: "Hallo", voice: "../../etc" } }), env);
  });
  assert.deepEqual(voices, ["onyx", "coral"]);
  const empty = await json(await worker.fetch(req("/api/tts", { method: "POST", token: env.JARVIS_ACCESS_TOKEN, body: { text: "  " } }), env));
  assert.equal(empty.body.error, "text_required");
});
