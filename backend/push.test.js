import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";
import { encryptPayload, vapidKeys, vapidAuthorization, allowedEndpoint, b64url, fromB64url, notifyAll } from "./push.js";

const enc = new TextEncoder();
const origin = "https://stanleebeast.github.io";
const ADMIN = "test-admin-token";
const makeEnv = (extra = {}) => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: ADMIN, ALLOWED_ORIGINS: origin, DB: createD1(), ...extra });
async function call(env, path, { method = "GET", body } = {}) {
  const headers = { Origin: origin, Authorization: "Bearer " + ADMIN };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request("https://jarvisss-ai.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, body: await res.json() };
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
const concat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

// Ein „Browser“: eigenes Schlüsselpaar wie bei PushManager.subscribe().
async function fakeBrowser() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, publicRaw, auth, subscription: { endpoint: "https://web.push.apple.com/QGuQyavXutnMH8", p256dh: b64url(publicRaw), auth: b64url(auth) } };
}
// Unabhängige Entschlüsselung nach RFC 8291 – so würde es der Browser tun.
async function decrypt(browser, body) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, browser.pair.privateKey, 256));
  const prkKey = await hmac(browser.auth, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), browser.publicRaw, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, cipher));
  assert.equal(plain.at(-1), 2, "last record delimiter");
  return { rs, idlen, text: new TextDecoder().decode(plain.slice(0, -1)) };
}

test("push payload encryption follows RFC 8291 and decrypts on the browser side", async () => {
  const browser = await fakeBrowser();
  const message = JSON.stringify({ title: "JARVIS", body: "Dein Briefing ist bereit – äöü ✓" });
  const body = await encryptPayload(browser.subscription, message);
  const out = await decrypt(browser, body);
  assert.equal(out.rs, 4096);
  assert.equal(out.idlen, 65);
  assert.equal(out.text, message);
  const again = await encryptPayload(browser.subscription, message);
  assert.notDeepEqual(again.slice(0, 16), body.slice(0, 16), "fresh salt per message");
});

test("VAPID keys are generated once, stored server-side and sign a valid ES256 JWT", async () => {
  const env = makeEnv();
  const keys = await vapidKeys(env);
  const again = await vapidKeys(env);
  assert.equal(keys.publicKey, again.publicKey, "stable across calls");
  assert.equal(fromB64url(keys.publicKey).length, 65);
  const header = await vapidAuthorization(keys, "https://web.push.apple.com/abc", "https://stanleebeast.github.io/Jarvisss/");
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(m);
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(m[2])));
  assert.equal(claims.aud, "https://web.push.apple.com");
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 24 * 3600 + 1);
  assert.ok(claims.sub);
  const pub = await crypto.subtle.importKey("raw", fromB64url(m[4]), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromB64url(m[3]), enc.encode(m[1] + "." + m[2])));
});

test("only real push services are accepted as endpoints", () => {
  for (const ok of ["https://web.push.apple.com/x", "https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://wns2-par02p.notify.windows.com/w/?token=x"]) assert.ok(allowedEndpoint(ok), ok);
  for (const bad of ["http://web.push.apple.com/x", "https://evil.example/x", "https://web.push.apple.com.evil.example/x", "https://169.254.169.254/latest", "notaurl"]) assert.equal(allowedEndpoint(bad), false, bad);
});

test("subscribe validates input, test push sends encrypted request and expired subscriptions are removed", async () => {
  const env = makeEnv();
  const browser = await fakeBrowser();
  const bad = await call(env, "/api/push/subscribe", { method: "POST", body: { subscription: { endpoint: "https://evil.example/x", keys: { p256dh: browser.subscription.p256dh, auth: browser.subscription.auth } } } });
  assert.equal(bad.body.error, "endpoint_not_allowed");
  const badKeys = await call(env, "/api/push/subscribe", { method: "POST", body: { subscription: { endpoint: browser.subscription.endpoint, keys: { p256dh: "AAAA", auth: "BBBB" } } } });
  assert.equal(badKeys.body.error, "invalid_subscription_keys");
  const ok = await call(env, "/api/push/subscribe", { method: "POST", body: { label: "iPad", subscription: { endpoint: browser.subscription.endpoint, keys: { p256dh: browser.subscription.p256dh, auth: browser.subscription.auth } } } });
  assert.equal(ok.status, 201);
  const key = await call(env, "/api/push/public-key");
  assert.equal(fromB64url(key.body.publicKey).length, 65);

  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => { sent.push({ url, options }); return new Response("", { status: 201 }); };
  try {
    const result = await call(env, "/api/push/test", { method: "POST", body: {} });
    assert.deepEqual(result.body, { sent: 1, failed: 0, subscriptions: 1 });
  } finally { globalThis.fetch = original; }
  assert.equal(sent[0].url, browser.subscription.endpoint);
  assert.equal(sent[0].options.headers["Content-Encoding"], "aes128gcm");
  assert.match(sent[0].options.headers.Authorization, /^vapid t=.+, k=/);
  const payload = JSON.parse((await decrypt(browser, new Uint8Array(sent[0].options.body))).text);
  assert.match(payload.body, /Testbenachrichtigung/);

  globalThis.fetch = async () => new Response("", { status: 410 });
  try { assert.deepEqual(await notifyAll(env, { title: "x", body: "y" }), { sent: 0, failed: 1, subscriptions: 1 }); } finally { globalThis.fetch = original; }
  assert.equal((await call(env, "/api/push/subscriptions")).body.subscriptions.length, 0, "410 Gone removes the subscription");
});

test("push needs D1 and authentication", async () => {
  assert.equal((await call(makeEnv({ DB: undefined }), "/api/push/public-key")).body.error, "storage_not_configured");
  const res = await worker.fetch(new Request("https://jarvisss-ai.test/api/push/public-key", { headers: { Origin: origin } }), makeEnv());
  assert.equal(res.status, 401);
});
