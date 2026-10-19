import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";

const origin = "https://stanleebeast.github.io";
const env = () => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: "t", ALLOWED_ORIGINS: origin, DB: createD1() });
const post = (e, body, type = "audio/mp4") => worker.fetch(new Request("https://w.test/api/stt", { method: "POST", headers: { Origin: origin, Authorization: "Bearer t", "Content-Type": type }, body }), e);

test("speech is transcribed by the model, nothing stored", async () => {
  const e = env();
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, opts) => { seen = { url, form: opts.body }; return Response.json({ text: " Wie wird das Wetter morgen? " }); };
  try {
    const res = await post(e, new Uint8Array(5000));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "Wie wird das Wetter morgen?" });
    assert.equal(seen.url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(seen.form.get("language"), "de");
    assert.equal(seen.form.get("file").name, "sprache.m4a");
  } finally { globalThis.fetch = original; }
});

test("rejects wrong types and huge files; tiny clips are empty; errors honest", async () => {
  const e = env();
  assert.equal((await post(e, "x", "text/plain")).status, 415);
  assert.equal((await post(e, new Uint8Array(9 * 1024 * 1024))).status, 413);
  assert.deepEqual(await (await post(e, new Uint8Array(100))).json(), { text: "", empty: true });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429 });
  try { assert.equal((await (await post(e, new Uint8Array(5000), "audio/webm;codecs=opus")).json()).error, "model_quota_exhausted"); }
  finally { globalThis.fetch = original; }
});
