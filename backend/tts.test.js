import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";

const origin = "https://stanleebeast.github.io";
const ADMIN = "test-admin-token";
const base = { JARVIS_ACCESS_TOKEN: ADMIN, ALLOWED_ORIGINS: origin };
const req = (path, body) => new Request("https://jarvisss-ai.test" + path, { method: body ? "POST" : "GET", headers: { Origin: origin, Authorization: "Bearer " + ADMIN, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
async function withFetch(handler, fn) {
  const seen = []; const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => { seen.push({ url: String(url), options }); return handler(String(url), options); };
  try { return { result: await fn(), seen }; } finally { globalThis.fetch = original; }
}
const mp3 = () => new Response(new Uint8Array([73, 68, 51]), { headers: { "Content-Type": "audio/mpeg" } });

test("ElevenLabs speaks when its key is set; voice id and quality mode are passed, key stays server-side", async () => {
  const env = { ...base, ELEVENLABS_API_KEY: "el-secret", OPENAI_API_KEY: "oa" };
  const { result, seen } = await withFetch(() => mp3(), () => worker.fetch(req("/api/tts", { text: "Guten Tag", voice: "el:AbCdEfGhIj1234567890", mode: "quality" }), env));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("X-Jarvis-Tts"), "elevenlabs");
  assert.match(seen[0].url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/AbCdEfGhIj1234567890\?/);
  assert.equal(seen[0].options.headers["xi-api-key"], "el-secret");
  const body = JSON.parse(seen[0].options.body);
  assert.equal(body.model_id, "eleven_multilingual_v2");
  assert.equal(body.text, "Guten Tag");
  const fast = await withFetch(() => mp3(), () => worker.fetch(req("/api/tts", { text: "Hallo", voice: "el:AbCdEfGhIj1234567890", mode: "fast" }), env));
  const fb = JSON.parse(fast.seen[0].options.body);
  assert.equal(fb.model_id, "eleven_flash_v2_5");
  assert.equal(fb.language_code, "de");
});

test("invalid ElevenLabs voice ids fall back to the default voice, never into the URL path", async () => {
  const env = { ...base, ELEVENLABS_API_KEY: "k" };
  const { seen } = await withFetch(() => mp3(), () => worker.fetch(req("/api/tts", { text: "Hallo", voice: "el:../../v1/user" }), env));
  assert.match(seen[0].url, /text-to-speech\/pNInz6obpgDQGcFmaJgB\?/);
  const custom = await withFetch(() => mp3(), () => worker.fetch(req("/api/tts", { text: "Hallo" }), { ...env, ELEVENLABS_VOICE_ID: "ZyXwVuTsRq0987654321" }));
  assert.match(custom.seen[0].url, /ZyXwVuTsRq0987654321/);
});

test("if ElevenLabs fails, OpenAI speaks and the response says so honestly", async () => {
  const env = { ...base, ELEVENLABS_API_KEY: "k", OPENAI_API_KEY: "oa" };
  const { result, seen } = await withFetch((url) => url.includes("elevenlabs") ? new Response("quota", { status: 401 }) : mp3(), () => worker.fetch(req("/api/tts", { text: "Hallo" }), env));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("X-Jarvis-Tts"), "openai-fallback");
  assert.equal(seen.length, 2);
  assert.match(seen[1].url, /api\.openai\.com\/v1\/audio\/speech/);
  const onlyEleven = await withFetch(() => new Response("x", { status: 401 }), () => worker.fetch(req("/api/tts", { text: "Hallo" }), { ...base, ELEVENLABS_API_KEY: "k" }));
  assert.equal((await onlyEleven.result.json()).error, "tts_key_invalid");
  // Ohne ElevenLabs-Schlüssel bleibt alles wie bisher (OpenAI)
  const plain = await withFetch(() => mp3(), () => worker.fetch(req("/api/tts", { text: "Hallo", voice: "onyx" }), { ...base, OPENAI_API_KEY: "oa" }));
  assert.equal(plain.result.headers.get("X-Jarvis-Tts"), "openai");
  assert.equal(JSON.parse(plain.seen[0].options.body).voice, "onyx");
});

test("voice list comes from the ElevenLabs account, sanitized, without the key", async () => {
  const env = { ...base, ELEVENLABS_API_KEY: "el-secret", OPENAI_API_KEY: "oa" };
  const payload = { voices: [
    { voice_id: "AbCdEfGhIj1234567890", name: "Adam", category: "premade", labels: { gender: "male", accent: "american" }, preview_url: "https://storage.googleapis.com/eleven-public-prod/a.mp3" },
    { voice_id: "bad id!", name: "Kaputt" },
    { voice_id: "QwErTyUiOp1234567890", name: "Meine Stimme", category: "cloned", preview_url: "javascript:alert(1)" }
  ] };
  const { result, seen } = await withFetch(() => Response.json(payload), async () => (await worker.fetch(req("/api/tts/voices"), env)).json());
  assert.equal(seen[0].options.headers["xi-api-key"], "el-secret");
  assert.equal(result.elevenlabs, true);
  const eleven = result.voices.filter(v => v.provider === "elevenlabs");
  assert.deepEqual(eleven.map(v => v.id), ["el:AbCdEfGhIj1234567890", "el:QwErTyUiOp1234567890"]);
  assert.equal(eleven[1].preview, null, "unsafe preview URL dropped");
  assert.ok(result.voices.some(v => v.provider === "openai"));
  assert.ok(!JSON.stringify(result).includes("el-secret"));
  const none = await (await worker.fetch(req("/api/tts/voices"), { ...base, OPENAI_API_KEY: "oa" })).json();
  assert.equal(none.elevenlabs, false);
  const status = await (await worker.fetch(req("/api/status"), env)).json();
  assert.equal(status.components.tts.provider, "elevenlabs");
});
