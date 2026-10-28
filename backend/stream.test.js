import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";

const origin = "https://stanleebeast.github.io";
const makeEnv = () => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: "t", ALLOWED_ORIGINS: origin, OPENAI_MODEL: "gpt-4.1-mini", DB: createD1() });
const sse = (chunks) => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode("data: " + JSON.stringify(x) + "\n\n")); c.enqueue(e.encode("data: [DONE]\n\n")); c.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
async function withFetch(handler, fn) { const o = globalThis.fetch; globalThis.fetch = handler; try { return await fn(); } finally { globalThis.fetch = o; } }
async function events(res) {
  const text = await res.text();
  return text.split("\n\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)));
}
const chat = (env, extra = {}) => worker.fetch(new Request("https://w.test/api/chat", { method: "POST", headers: { Origin: origin, Authorization: "Bearer t", "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Was ist los?" }], timezone: "Europe/Berlin", stream: true, ...extra }) }), env);

test("streamed chat sends the answer word by word, then done with the full reply", async () => {
  const env = makeEnv();
  let body;
  const res = await withFetch(async (u, o) => { body = JSON.parse(o.body); return sse([{ model: "gpt-5-mini", choices: [{ delta: { role: "assistant", content: "Guten " } }] }, { choices: [{ delta: { content: "Abend." } }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } }]); }, async () => { const r = await chat(env); return { r, ev: await events(r) }; });
  assert.equal(body.stream, true);
  assert.equal(res.r.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
  assert.equal(res.r.headers.get("Access-Control-Allow-Origin"), origin);
  assert.deepEqual(res.ev.filter(e => e.type === "delta").map(e => e.text), ["Guten ", "Abend."]);
  const done = res.ev.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.reply, "Guten Abend.");
  assert.equal(done.usage.completionTokens, 3);
});

test("tool rounds are announced live, with sources, and pre-tool text is reset", async () => {
  const env = makeEnv();
  let round = 0;
  const handler = async (u, o) => {
    if (String(u).includes("/v1/responses")) return Response.json({ output: [{ content: [{ type: "output_text", text: "Der DAX steigt.", annotations: [{ type: "url_citation", url: "https://www.tagesschau.de/wirtschaft", title: "tagesschau" }] }] }], usage: {} });
    round++;
    if (round === 1) return sse([{ choices: [{ delta: { content: "Ich schaue nach." } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: "{\"query\":" } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"DAX heute\"}" } }] } }] }]);
    return sse([{ choices: [{ delta: { content: "Der DAX steigt laut tagesschau." } }] }]);
  };
  const ev = await withFetch(handler, async () => events(await chat(env)));
  const types = ev.map(e => e.type);
  assert.deepEqual(types.slice(0, 3), ["delta", "reset", "tool"]);
  assert.equal(ev[2].label, "Suche im Internet: DAX heute");
  assert.equal(ev.find(e => e.type === "sources").sources[0].url, "https://www.tagesschau.de/wirtschaft");
  assert.equal(ev.at(-1).reply, "Der DAX steigt laut tagesschau.");
});

test("model errors arrive as an error event; without stream the old JSON answer stays", async () => {
  const env = makeEnv();
  const ev = await withFetch(async () => new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429 }), async () => events(await chat(env)));
  assert.equal(ev.at(-1).type, "error");
  assert.equal(ev.at(-1).error, "model_quota_exhausted");
  const plain = await withFetch(async () => Response.json({ choices: [{ message: { role: "assistant", content: "Hallo." } }] }), async () => (await chat(env, { stream: false })).json());
  assert.equal(plain.reply, "Hallo.");
});
