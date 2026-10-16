import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";
import { REFRESH_GRACE_MS } from "./auth.js";

const origin = "https://stanleebeast.github.io";
const ADMIN = "test-admin-token";
const makeEnv = (extra = {}) => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: ADMIN, ALLOWED_ORIGINS: origin, DB: createD1(), ...extra });

async function call(env, path, { method = "GET", token, body } = {}) {
  const headers = { Origin: origin };
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await worker.fetch(new Request("https://jarvisss-ai.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: response.status, body: await response.json() };
}
const login = (env, name = "iPad") => call(env, "/api/auth/login", { method: "POST", token: ADMIN, body: { deviceName: name } });

test("admin token can be exchanged for a device session that works on the API", async () => {
  const env = makeEnv();
  const session = await login(env);
  assert.equal(session.status, 201);
  assert.match(session.body.accessToken, /^jv1\./);
  assert.ok(session.body.refreshToken.length >= 40);
  assert.equal(session.body.device.name, "iPad");
  const tasks = await call(env, "/api/tasks", { token: session.body.accessToken });
  assert.equal(tasks.status, 200);
  const who = await call(env, "/api/auth/session", { token: session.body.accessToken });
  assert.equal(who.body.principal, "device");
  // Nur der Hash des Geräteschlüssels liegt in der Datenbank.
  const row = env.DB.raw.prepare("SELECT refresh_hash FROM devices").get();
  assert.notEqual(row.refresh_hash, session.body.refreshToken);
  assert.match(row.refresh_hash, /^[0-9a-f]{64}$/);
});

test("device sessions cannot create further sessions via login", async () => {
  const env = makeEnv();
  const session = await login(env);
  const result = await call(env, "/api/auth/login", { method: "POST", token: session.body.accessToken, body: {} });
  assert.equal(result.status, 403);
});

test("tampered or expired access tokens are rejected", async () => {
  const env = makeEnv();
  const { body } = await login(env);
  const parts = body.accessToken.split(".");
  const forged = parts[0] + "." + btoa(JSON.stringify({ d: body.device.id, exp: Date.now() + 9e9 })).replace(/=+$/, "") + "." + parts[2];
  assert.equal((await call(env, "/api/tasks", { token: forged })).status, 401);
  const otherKey = await login(makeEnv({ JARVIS_ACCESS_TOKEN: "different-admin" }));
  assert.equal((await call(env, "/api/tasks", { token: otherKey.body.accessToken })).body.error, "unauthorized");

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 16 * 60_000;
    const expired = await call(env, "/api/tasks", { token: body.accessToken });
    assert.equal(expired.status, 401);
    assert.equal(expired.body.error, "token_expired");
  } finally { Date.now = realNow; }
});

test("refresh rotates the device key; reusing an old key later revokes the device", async () => {
  const env = makeEnv();
  const first = await login(env);
  const second = await call(env, "/api/auth/refresh", { method: "POST", body: { refreshToken: first.body.refreshToken } });
  assert.equal(second.status, 200);
  assert.notEqual(second.body.refreshToken, first.body.refreshToken);
  assert.equal((await call(env, "/api/tasks", { token: second.body.accessToken })).status, 200);

  const soon = await call(env, "/api/auth/refresh", { method: "POST", body: { refreshToken: first.body.refreshToken } });
  assert.equal(soon.status, 409, "within the grace period a parallel tab gets a retry hint, not a lockout");
  assert.equal(soon.body.error, "refresh_superseded");

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + REFRESH_GRACE_MS + 5_000;
    const reuse = await call(env, "/api/auth/refresh", { method: "POST", body: { refreshToken: first.body.refreshToken } });
    assert.equal(reuse.status, 401);
    assert.equal(reuse.body.error, "device_revoked");
  } finally { Date.now = realNow; }
  const after = await call(env, "/api/tasks", { token: second.body.accessToken });
  assert.equal(after.body.error, "device_revoked");
});

test("unknown refresh tokens are rejected", async () => {
  const result = await call(makeEnv(), "/api/auth/refresh", { method: "POST", body: { refreshToken: "x".repeat(43) } });
  assert.equal(result.status, 401);
});

test("pairing code connects a second device exactly once", async () => {
  const env = makeEnv();
  const ipad = await login(env);
  const started = await call(env, "/api/auth/pair/start", { method: "POST", token: ipad.body.accessToken });
  assert.equal(started.status, 201);
  assert.match(started.body.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const iphone = await call(env, "/api/auth/pair/complete", { method: "POST", body: { code: started.body.code.toLowerCase().replace("-", " "), deviceName: "iPhone" } });
  assert.equal(iphone.status, 201);
  assert.equal(iphone.body.device.name, "iPhone");
  const again = await call(env, "/api/auth/pair/complete", { method: "POST", body: { code: started.body.code, deviceName: "Fremd" } });
  assert.equal(again.status, 400);
  const devices = await call(env, "/api/auth/devices", { token: iphone.body.accessToken });
  assert.deepEqual(devices.body.devices.map(d => d.name).sort(), ["iPad", "iPhone"]);
  assert.equal(devices.body.devices.find(d => d.name === "iPhone").current, true);
  assert.equal(JSON.stringify(devices.body).includes("refresh"), false, "no key material in device list");
});

test("pairing codes are invalidated after too many wrong guesses and after expiry", async () => {
  const env = makeEnv();
  const started = await call(env, "/api/auth/pair/start", { method: "POST", token: ADMIN });
  for (let i = 0; i < 5; i++) {
    const wrong = await call(env, "/api/auth/pair/complete", { method: "POST", body: { code: "AAAA-AAAA", deviceName: "x" } });
    assert.equal(wrong.body.error, "invalid_pairing_code");
  }
  const late = await call(env, "/api/auth/pair/complete", { method: "POST", body: { code: started.body.code, deviceName: "x" } });
  assert.equal(late.status, 400, "the real code must be dead after 5 failed attempts");

  const fresh = await call(env, "/api/auth/pair/start", { method: "POST", token: ADMIN });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 11 * 60_000;
    const expired = await call(env, "/api/auth/pair/complete", { method: "POST", body: { code: fresh.body.code, deviceName: "x" } });
    assert.equal(expired.status, 400);
  } finally { Date.now = realNow; }
});

test("revoking a device takes effect immediately; logout revokes the own device", async () => {
  const env = makeEnv();
  const ipad = await login(env, "iPad");
  const iphone = await login(env, "iPhone");
  const revoked = await call(env, "/api/auth/devices/" + iphone.body.device.id + "/revoke", { method: "POST", token: ipad.body.accessToken });
  assert.equal(revoked.status, 200);
  assert.equal((await call(env, "/api/tasks", { token: iphone.body.accessToken })).body.error, "device_revoked");
  assert.equal((await call(env, "/api/auth/refresh", { method: "POST", body: { refreshToken: iphone.body.refreshToken } })).body.error, "device_revoked");
  const twice = await call(env, "/api/auth/devices/" + iphone.body.device.id + "/revoke", { method: "POST", token: ipad.body.accessToken });
  assert.equal(twice.status, 404);

  const out = await call(env, "/api/auth/logout", { method: "POST", token: ipad.body.accessToken });
  assert.equal(out.status, 200);
  assert.equal((await call(env, "/api/tasks", { token: ipad.body.accessToken })).status, 401);
  // Der Admin-Schlüssel bleibt als Notfallzugang nutzbar.
  assert.equal((await call(env, "/api/tasks", { token: ADMIN })).status, 200);
});

test("sessions need D1; admin token keeps working without it", async () => {
  const env = makeEnv({ DB: undefined });
  const result = await login(env);
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "storage_not_configured");
  assert.equal((await call(env, "/api/status", { token: ADMIN })).status, 200);
});

test("audit log records actions without contents", async () => {
  const env = makeEnv();
  const ipad = await login(env);
  await call(env, "/api/tasks", { method: "POST", token: ipad.body.accessToken, body: { title: "Geheimes Projekt" } });
  await call(env, "/api/memories", { method: "POST", token: ipad.body.accessToken, body: { text: "Private Notiz" } });
  const log = await call(env, "/api/auth/audit", { token: ipad.body.accessToken });
  const actions = log.body.entries.map(e => e.action);
  assert.ok(actions.includes("device_login") && actions.includes("task_created") && actions.includes("memory_created"));
  assert.equal(JSON.stringify(log.body).includes("Geheimes"), false);
  assert.equal(JSON.stringify(log.body).includes("Private"), false);
});

test("memories: create, read back on another device, edit, delete with confirmation", async () => {
  const env = makeEnv();
  const ipad = await login(env, "iPad");
  const iphone = await login(env, "iPhone");
  const created = await call(env, "/api/memories", { method: "POST", token: ipad.body.accessToken, body: { text: "  Ich mag kurze Briefings ", kind: "style" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.saved, true);
  const onPhone = await call(env, "/api/memories", { token: iphone.body.accessToken });
  assert.deepEqual(onPhone.body.memories.map(m => [m.text, m.kind]), [["Ich mag kurze Briefings", "style"]]);

  const edited = await call(env, "/api/memories/" + created.body.memory.id, { method: "PATCH", token: iphone.body.accessToken, body: { text: "Briefings maximal 2 Minuten" } });
  assert.equal(edited.body.memory.text, "Briefings maximal 2 Minuten");
  assert.equal(edited.body.memory.kind, "style");

  for (const [body, error] of [[{ text: "" }, "invalid_memory_text"], [{ text: "x", kind: "secret" }, "invalid_memory_kind"], [{ text: "x", owner: 1 }, "unsupported_memory_field"]]) {
    assert.equal((await call(env, "/api/memories", { method: "POST", token: ADMIN, body })).body.error, error);
  }
  assert.equal((await call(env, "/api/memories", { method: "DELETE", token: ADMIN })).body.error, "confirmation_required");
  const deleted = await call(env, "/api/memories/" + created.body.memory.id, { method: "DELETE", token: ipad.body.accessToken });
  assert.equal(deleted.body.deleted, true);
  assert.equal((await call(env, "/api/memories", { token: ipad.body.accessToken })).body.memories.length, 0);
  assert.equal((await call(env, "/api/memories/" + created.body.memory.id, { method: "DELETE", token: ADMIN })).status, 404);

  await call(env, "/api/memories", { method: "POST", token: ADMIN, body: { text: "a" } });
  await call(env, "/api/memories", { method: "POST", token: ADMIN, body: { text: "b" } });
  const cleared = await call(env, "/api/memories?all=confirm", { method: "DELETE", token: ADMIN });
  assert.equal(cleared.body.count, 2);
});

test("memories without database or auth fail closed", async () => {
  assert.equal((await call(makeEnv({ DB: undefined }), "/api/memories", { token: ADMIN })).body.error, "storage_not_configured");
  assert.equal((await call(makeEnv(), "/api/memories")).status, 401);
});

test("status endpoint reports device sessions and memory sync truthfully", async () => {
  const env = makeEnv();
  const ipad = await login(env);
  const status = await call(env, "/api/status", { token: ipad.body.accessToken });
  assert.equal(status.body.components.devices.state, "available");
  assert.match(status.body.components.auth.detail, /Gerätesitzung/);
  assert.equal(status.body.components.memory.state, "available");
  const noDb = await call(makeEnv({ DB: undefined }), "/api/status", { token: ADMIN });
  assert.equal(noDb.body.components.devices.state, "not_configured");
  assert.equal(noDb.body.components.sync.state, "not_available");
});
