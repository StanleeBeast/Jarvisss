import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";
import { safeUrl, viewWebsite } from "./browser.js";

const origin = "https://stanleebeast.github.io";
const makeEnv = (extra = {}) => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: "t", ALLOWED_ORIGINS: origin, OPENAI_MODEL: "gpt-4.1-mini", DB: createD1(), BROWSER_TOKEN: "cf_browser", CF_ACCOUNT_ID: "acc123", ...extra });
async function withFetch(handler, fn) { const o = globalThis.fetch; globalThis.fetch = handler; try { return await fn(); } finally { globalThis.fetch = o; } }
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const cloudflare = (calls, { shotStatus = 200 } = {}) => async (u, o) => {
  calls.push({ url: String(u), body: JSON.parse(o.body), auth: o.headers.Authorization });
  if (String(u).endsWith("/browser-rendering/screenshot")) return shotStatus === 200 ? new Response(JPEG, { headers: { "Content-Type": "image/jpeg" } }) : new Response("{}", { status: shotStatus });
  if (String(u).endsWith("/browser-rendering/markdown")) return shotStatus === 429 ? new Response("{}", { status: 429 }) : Response.json({ success: true, result: "# Domain kaufen\nKlicke oben rechts auf **Domain suchen**." });
  throw new Error("unexpected " + u);
};

test("only public web addresses are opened", () => {
  assert.equal(safeUrl("ionos.de").href, "https://ionos.de/");
  assert.equal(safeUrl("https://www.ihk.de/gruendung").hostname, "www.ihk.de");
  for (const bad of ["http://localhost:8787", "http://127.0.0.1", "http://192.168.0.1/admin", "http://10.0.0.5", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.de", "http://intranet", "http://[::1]/", "https://example.de:8443", "http://router.local"]) assert.equal(safeUrl(bad), null, bad);
});

test("a website is opened: screenshot for the user, text for the AI", async () => {
  const calls = [];
  const r = await withFetch(cloudflare(calls), () => viewWebsite(makeEnv(), { url: "ionos.de/domains", device: "phone" }));
  assert.match(r.image, /^data:image\/jpeg;base64,/);
  assert.equal(r.title, "Domain kaufen");
  assert.match(r.text, /Domain suchen/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/acc123/browser-rendering/screenshot");
  assert.equal(calls[0].auth, "Bearer cf_browser");
  assert.deepEqual(calls[0].body.viewport, { width: 390, height: 844 });
  assert.equal(calls[0].body.url, "https://ionos.de/domains");
});

test("honest errors: not set up, daily limit, bad address", async () => {
  assert.equal((await viewWebsite(makeEnv({ BROWSER_TOKEN: undefined }), { url: "ionos.de" })).error, "browser_not_configured");
  assert.equal((await viewWebsite(makeEnv(), { url: "http://localhost" })).error, "invalid_url");
  assert.equal((await withFetch(cloudflare([], { shotStatus: 429 }), () => viewWebsite(makeEnv(), { url: "ionos.de" }))).error, "browser_limit_reached");
});

test("the agent opens the page, the app gets the screenshot live, the model gets the text", async () => {
  const env = makeEnv(), calls = [];
  let round = 0, toolOutput = null, offered = [];
  const handler = async (u, o) => {
    if (String(u).includes("browser-rendering")) return cloudflare(calls)(u, o);
    const b = JSON.parse(o.body);
    offered = b.tools.map(t => t.function.name);
    round++;
    const sse = (c) => new Response(c.map(x => "data: " + JSON.stringify(x) + "\n\n").join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    if (round === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "v1", function: { name: "view_website", arguments: JSON.stringify({ url: "https://www.ionos.de/domains", device: "phone" }) } }] } }] }]);
    toolOutput = JSON.parse(b.messages.at(-1).content);
    return sse([{ choices: [{ delta: { content: "Tippe oben rechts auf Domain suchen." } }] }]);
  };
  const text = await withFetch(handler, async () => (await worker.fetch(new Request("https://w.test/api/chat", { method: "POST", headers: { Origin: origin, Authorization: "Bearer t", "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Zeig mir, wie ich bei IONOS eine Domain kaufe" }], stream: true }) }), env)).text());
  const ev = text.split("\n\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)));
  assert.ok(offered.includes("view_website"));
  assert.equal(ev.find(e => e.type === "tool").label, "Öffne die Website: ionos.de");
  const img = ev.find(e => e.type === "image");
  assert.match(img.src, /^data:image\/jpeg;base64,/);
  assert.equal(img.host, "ionos.de");
  assert.equal(toolOutput.screenshotShown, true);
  assert.equal("image" in toolOutput, false, "the model does not get the image bytes");
  assert.match(toolOutput.text, /Domain suchen/);
  assert.equal(ev.at(-1).reply, "Tippe oben rechts auf Domain suchen.");
  // Ohne Schlüssel wird das Werkzeug gar nicht angeboten
  await withFetch(async (u, o) => { offered = JSON.parse(o.body).tools.map(t => t.function.name); return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }); }, () => worker.fetch(new Request("https://w.test/api/chat", { method: "POST", headers: { Origin: origin, Authorization: "Bearer t", "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Hallo" }] }) }), makeEnv({ BROWSER_TOKEN: undefined })));
  assert.equal(offered.includes("view_website"), false);
});
