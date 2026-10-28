import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";
import { trustOf, research } from "./research.js";
import { usageDay } from "./usage.js";

const origin = "https://stanleebeast.github.io";
const makeEnv = () => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: "t", ALLOWED_ORIGINS: origin, OPENAI_MODEL: "gpt-4.1-mini", DB: createD1() });
async function withFetch(handler, fn) { const o = globalThis.fetch; globalThis.fetch = handler; try { return await fn(); } finally { globalThis.fetch = o; } }

test("sources are rated: known serious ones green, scam signs red, the rest yellow", () => {
  assert.equal(trustOf({ url: "https://www.verbraucherzentrale.de/wissen/abzocke", title: "Abzocke erkennen" }).trust, "green");
  assert.equal(trustOf({ url: "https://www.ihk.de/gruendung", title: "Gründen" }).trust, "green");
  assert.equal(trustOf({ url: "https://www.existenzgruendungsportal.de/x", title: "Gewerbe anmelden" }).trust, "green");
  const scam = trustOf({ url: "https://reich-im-schlaf.info/start", title: "500 € am Tag ohne Vorkenntnisse – garantierter Gewinn" });
  assert.equal(scam.trust, "red");
  assert.ok(scam.reasons.includes("verspricht leichtes Geld"));
  assert.equal(trustOf({ url: "https://krypto-gewinn.xyz", title: "Krypto" }).reasons.includes("ungewöhnliche Domain-Endung"), true);
  assert.equal(trustOf({ url: "https://www.reddit.com/r/de", title: "Erfahrungen" }).trust, "yellow");
  assert.equal(trustOf({ url: "https://irgendein-blog.de/geld", title: "Nebenjob-Ideen" }).trust, "yellow");
  assert.equal(trustOf({ url: "javascript:alert(1)" }).trust, "red");
});

test("research runs the sub-questions in parallel, merges and ranks sources, and reports progress", async () => {
  const seen = [], events = [];
  const search = async (env, q) => {
    seen.push(q);
    if (/Betrug/.test(q)) return { answer: "Vorsicht bei Versprechen.", sources: [{ title: "1000 € am Tag mit Krypto-Signal", url: "https://signal-profit.top/x" }, { title: "Abzocke", url: "https://www.verbraucherzentrale.de/a" }] };
    return { answer: "Webdesign für lokale Firmen ist gefragt.", sources: [{ title: "Gründen", url: "https://www.ihk.de/g" }, { title: "Abzocke", url: "https://www.verbraucherzentrale.de/a" }, { title: "Blog", url: "https://blog.example.de/b" }] };
  };
  const r = await research({}, { question: "Websites für lokale Firmen als Nebenverdienst", aspects: ["Überblick", "Betrug und Risiken", "Überblick"] }, { search, emit: (e) => events.push(e) });
  assert.equal(seen.length, 2, "duplicate aspects are merged");
  assert.deepEqual(r.sources.map(s => s.trust), ["green", "green", "yellow", "red"]);
  assert.equal(new Set(r.sources.map(s => s.url)).size, 4, "no duplicate sources");
  assert.match(events.at(-1).label, /4 Quellen geprüft: 2 seriös, 1 unklar, 1 mit Warnzeichen/);
  assert.equal((await research({}, { question: "x", aspects: ["a"] }, { search: async () => ({ error: "search_timeout" }) })).error, "search_unavailable");
});

test("the agent offers deep_research, streams its progress and keeps it off in saving mode", async () => {
  const env = makeEnv();
  let round = 0, toolNames = [];
  const sse = (chunks) => new Response(chunks.map(c => "data: " + JSON.stringify(c) + "\n\n").join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  const handler = async (u, o) => {
    if (String(u).includes("/v1/responses")) return Response.json({ output: [{ content: [{ type: "output_text", text: "Kurzfassung.", annotations: [{ type: "url_citation", url: "https://www.ihk.de/gruendung", title: "IHK" }] }] }], usage: {} });
    const b = JSON.parse(o.body); toolNames = b.tools.map(t => t.function.name);
    round++;
    if (round === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "r1", function: { name: "deep_research", arguments: JSON.stringify({ question: "Online Geld verdienen", aspects: ["Überblick", "Betrug"] }) } }] } }] }]);
    return sse([{ choices: [{ delta: { content: "Fazit: Es gibt seriöse Wege." } }] }]);
  };
  const text = await withFetch(handler, async () => (await worker.fetch(new Request("https://w.test/api/chat", { method: "POST", headers: { Origin: origin, Authorization: "Bearer t", "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Wie kann ich online Geld verdienen?" }], stream: true }) }), env)).text());
  const ev = text.split("\n\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)));
  assert.ok(toolNames.includes("deep_research"));
  assert.ok(ev.some(e => e.type === "tool" && /Quellen geprüft/.test(e.label)));
  assert.equal(ev.find(e => e.type === "sources").sources[0].trust, "green");
  assert.equal(ev.at(-1).reply, "Fazit: Es gibt seriöse Wege.");
  // Sparmodus: keine teure Recherche
  env.DB.raw.prepare("INSERT INTO usage_daily (day, cost_micros) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET cost_micros = cost_micros + excluded.cost_micros").run(usageDay(), 4_500_000);
  await withFetch(async (u, o) => { toolNames = JSON.parse(o.body).tools.map(t => t.function.name); return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }); }, () => worker.fetch(new Request("https://w.test/api/chat", { method: "POST", headers: { Origin: origin, Authorization: "Bearer t", "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Hallo" }] }) }), env));
  assert.equal(toolNames.includes("deep_research"), false);
  assert.equal(toolNames.includes("web_search"), false);
});
