import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";

const origin = "https://stanleebeast.github.io";
const makeEnv = () => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: "t", ALLOWED_ORIGINS: origin, OPENAI_MODEL: "gpt-4.1-mini", DB: createD1() });
const call = (env, path, { method = "GET", body, token = "t", noOrigin = false } = {}) => worker.fetch(new Request("https://w.test" + path, { method, headers: { ...(noOrigin ? {} : { Origin: origin }), ...(token ? { Authorization: "Bearer " + token } : {}), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env).then(async r => ({ status: r.status, body: await r.json() }));

test("shortcut key can only send context; it is shown once and revocable", async () => {
  const env = makeEnv();
  const k = (await call(env, "/api/context/key", { method: "POST" })).body.key;
  assert.match(k, /^jvc_[0-9a-f]{48}$/);
  assert.equal(JSON.stringify(env.DB.raw.prepare("SELECT value FROM user_settings WHERE key = 'context_key_hash'").get()).includes(k), false, "only the hash is stored");
  // Kurzbefehle senden ohne Origin
  const sent = await call(env, "/api/context", { method: "POST", body: { items: [{ type: "location", value: "zuhause" }, { type: "battery", value: "23 %" }, { type: "charging", value: "Nein" }], device: "iPhone" }, token: k, noOrigin: true });
  assert.deepEqual(sent.body.saved, ["location", "battery", "charging"]);
  // Der Schlüssel taugt für nichts anderes
  assert.equal((await call(env, "/api/tasks", { token: k, noOrigin: true })).status, 401);
  assert.equal((await call(env, "/api/context", { token: k, noOrigin: true })).status, 401, "cannot even read the context");
  const items = (await call(env, "/api/context")).body.items;
  assert.deepEqual(items.map(i => [i.type, i.value]).sort(), [["battery", 23], ["charging", false], ["location", "zuhause"]]);
  assert.equal((await call(env, "/api/context", { method: "POST", body: { type: "battery", value: "200" }, token: k, noOrigin: true })).body.error, "invalid_context_value");
  assert.equal((await call(env, "/api/context", { method: "POST", body: { type: "passwort", value: "x" }, token: k, noOrigin: true })).body.error, "unknown_context_type");
  await call(env, "/api/context/key", { method: "DELETE" });
  assert.equal((await call(env, "/api/context", { method: "POST", body: { type: "focus", value: "Schlafen" }, token: k, noOrigin: true })).status, 401, "revoked key no longer works");
});

test("the agent sees the fresh device context as data", async () => {
  const env = makeEnv();
  const k = (await call(env, "/api/context/key", { method: "POST" })).body.key;
  await call(env, "/api/context", { method: "POST", body: { items: [{ type: "focus", value: "Schlafen an" }, { type: "location", value: "zuhause" }] }, token: k, noOrigin: true });
  let sys = "";
  const o = globalThis.fetch;
  globalThis.fetch = async (u, opt) => { sys = JSON.parse(opt.body).messages[0].content; return Response.json({ choices: [{ message: { role: "assistant", content: "Gute Nacht." } }] }); };
  try { await call(env, "/api/chat", { method: "POST", body: { messages: [{ role: "user", content: "Hi" }], timezone: "Europe/Berlin" } }); } finally { globalThis.fetch = o; }
  assert.match(sys, /Fokus: Schlafen an \(gerade eben\)/);
  assert.match(sys, /Ort: zuhause/);
});

test("a wrong shortcut key gets a readable 401 after the body was read", async () => {
  const env = makeEnv();
  await call(env, "/api/context/key", { method: "POST" });
  const req = new Request("https://w.test/api/context", { method: "POST", headers: { Authorization: "Bearer jvc_falsch", "Content-Type": "application/json" }, body: JSON.stringify({ type: "focus", value: "Nicht stören an" }) });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 401);
  assert.equal(req.bodyUsed, true, "iOS shows 'connection lost' if the body is left unread");
});

test("field names typed with a trailing space or capital letter still work", async () => {
  const env = makeEnv();
  const k = (await call(env, "/api/context/key", { method: "POST" })).body.key;
  const r = await call(env, "/api/context", { method: "POST", body: { "Type ": "focus", " value": "Nicht stören an " }, token: k, noOrigin: true });
  assert.deepEqual(r.body.saved, ["focus"]);
  assert.equal((await call(env, "/api/context")).body.items[0].value, "Nicht stören an");
});
