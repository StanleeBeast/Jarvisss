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
