// JARVIS Web Push (RFC 8030/8291/8292) ohne Fremddienste – nur WebCrypto im Worker.
// iPad/iPhone: funktioniert ab iOS/iPadOS 16.4 für Web-Apps, die über Safari zum Home-Bildschirm hinzugefügt wurden.
import { json, clip, readJsonBody, audit } from "./http.js";
import { authenticate, actorOf } from "./auth.js";

const enc = new TextEncoder();
export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64url = (text) => Uint8Array.from(atob(String(text).replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// Nur echte Push-Dienste der Browserhersteller – verhindert, dass der Worker beliebige Adressen aufruft.
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
export function allowedEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && PUSH_HOSTS.some(rx => rx.test(url.hostname));
  } catch { return false; }
}

// --- VAPID-Schlüssel ------------------------------------------------------------------------------
// Bevorzugt aus dem Worker-Secret VAPID_PRIVATE_JWK; sonst einmalig erzeugt und in D1 (server_keys) abgelegt.
export async function vapidKeys(env) {
  let jwk = null;
  if (env.VAPID_PRIVATE_JWK) { try { jwk = JSON.parse(env.VAPID_PRIVATE_JWK); } catch { jwk = null; } }
  if (!jwk && env.DB) {
    const row = await env.DB.prepare("SELECT value FROM server_keys WHERE name = 'vapid_private_jwk'").first();
    if (row) jwk = JSON.parse(row.value);
    else {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
      await env.DB.prepare("INSERT OR IGNORE INTO server_keys (name, value, created_at) VALUES ('vapid_private_jwk', ?, ?)").bind(JSON.stringify(jwk), new Date().toISOString()).run();
      const stored = await env.DB.prepare("SELECT value FROM server_keys WHERE name = 'vapid_private_jwk'").first();
      jwk = JSON.parse(stored.value);
    }
  }
  if (!jwk) return null;
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const publicRaw = concat(new Uint8Array([4]), fromB64url(jwk.x), fromB64url(jwk.y));
  return { privateKey, publicRaw, publicKey: b64url(publicRaw) };
}
export async function vapidAuthorization(keys, endpoint, subject, now = Date.now()) {
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, enc.encode(header + "." + claims));
  return "vapid t=" + header + "." + claims + "." + b64url(signature) + ", k=" + keys.publicKey;
}

// --- Verschlüsselung nach RFC 8291 (aes128gcm) ----------------------------------------------------
export async function encryptPayload(subscription, plaintext) {
  const uaPublic = fromB64url(subscription.p256dh);
  const authSecret = fromB64url(subscription.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("invalid_subscription_keys");
  const asPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asPair.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPair.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prkKey = await hmac(authSecret, ecdhSecret);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = concat(enc.encode(plaintext), new Uint8Array([2]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// --- Versand --------------------------------------------------------------------------------------
// Ergebnis pro Abo: { ok, status, gone }. „ok“ heißt: der Push-Dienst hat die Nachricht angenommen.
export async function sendPush(env, subscription, message, { ttl = 3600, urgency = "normal" } = {}) {
  if (!allowedEndpoint(subscription.endpoint)) return { ok: false, status: 0, error: "endpoint_not_allowed" };
  const keys = await vapidKeys(env);
  if (!keys) return { ok: false, status: 0, error: "push_not_configured" };
  const body = await encryptPayload(subscription, JSON.stringify(message).slice(0, 3000));
  try {
    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        "Authorization": await vapidAuthorization(keys, subscription.endpoint, env.VAPID_SUBJECT || "https://stanleebeast.github.io/Jarvisss/"),
        "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": String(ttl), "Urgency": urgency
      },
      body,
      signal: AbortSignal.timeout(10000)
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch {
    return { ok: false, status: 0, error: "push_service_unreachable" };
  }
}

// Schickt an alle Abos; entfernt Abos, die der Push-Dienst als erloschen meldet.
export async function notifyAll(env, message, options) {
  if (!env.DB) return { sent: 0, failed: 0, subscriptions: 0 };
  const rows = (await env.DB.prepare("SELECT * FROM push_subscriptions").all()).results || [];
  let sent = 0, failed = 0;
  for (const row of rows) {
    const result = await sendPush(env, row, message, options);
    const now = new Date().toISOString();
    if (result.ok) { sent++; await env.DB.prepare("UPDATE push_subscriptions SET last_success_at = ?, failures = 0 WHERE id = ?").bind(now, row.id).run(); }
    else if (result.gone || row.failures >= 9) { failed++; await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(row.id).run(); }
    else { failed++; await env.DB.prepare("UPDATE push_subscriptions SET failures = failures + 1, last_error = ? WHERE id = ?").bind(String(result.status || result.error), row.id).run(); }
  }
  return { sent, failed, subscriptions: rows.length };
}

export async function handlePushApi(request, env, headers, url) {
  if (!url.pathname.startsWith("/api/push/")) return null;
  const auth = await authenticate(request, env, headers);
  if (auth.response) return auth.response;
  if (!env.DB) return json({ error: "storage_not_configured", message: "Benachrichtigungen benötigen die D1-Datenbank." }, 503, headers);
  const path = url.pathname.slice("/api/push".length);
  const actor = actorOf(auth.principal);
  try {
    if (request.method === "GET" && path === "/public-key") {
      const keys = await vapidKeys(env);
      return json({ publicKey: keys.publicKey }, 200, headers);
    }
    if (request.method === "GET" && path === "/subscriptions") {
      const rows = (await env.DB.prepare("SELECT id, device_id, label, created_at, last_success_at, failures FROM push_subscriptions ORDER BY created_at DESC").all()).results || [];
      return json({ subscriptions: rows.map(r => ({ id: r.id, label: r.label, createdAt: r.created_at, lastSuccessAt: r.last_success_at, failures: r.failures, current: Boolean(auth.principal.deviceId && r.device_id === auth.principal.deviceId) })) }, 200, headers);
    }
    if (request.method === "POST" && path === "/subscribe") {
      const body = await readJsonBody(request, 4_000);
      if (body.error) return json({ error: body.error }, body.status, headers);
      const sub = body.value.subscription || {};
      const endpoint = clip(sub.endpoint, 1000), p256dh = clip(sub.keys?.p256dh, 200), authKey = clip(sub.keys?.auth, 100);
      if (!allowedEndpoint(endpoint)) return json({ error: "endpoint_not_allowed" }, 400, headers);
      try { if (fromB64url(p256dh).length !== 65 || fromB64url(authKey).length < 16) throw new Error(); } catch { return json({ error: "invalid_subscription_keys" }, 400, headers); }
      const id = crypto.randomUUID();
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
      await env.DB.prepare("INSERT INTO push_subscriptions (id, device_id, label, endpoint, p256dh, auth, created_at, failures) VALUES (?, ?, ?, ?, ?, ?, ?, 0)")
        .bind(id, auth.principal.deviceId, clip(body.value.label, 60) || auth.principal.deviceName || "Gerät", endpoint, p256dh, authKey, new Date().toISOString()).run();
      const saved = await env.DB.prepare("SELECT id FROM push_subscriptions WHERE id = ?").bind(id).first();
      if (!saved) return json({ error: "subscription_save_unconfirmed" }, 500, headers);
      await audit(env.DB, actor, "push_subscribed", id);
      return json({ saved: true, id }, 201, headers);
    }
    if (request.method === "POST" && path === "/unsubscribe") {
      const body = await readJsonBody(request, 2_000);
      if (body.error) return json({ error: body.error }, body.status, headers);
      const result = await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? OR id = ?").bind(clip(body.value.endpoint, 1000), clip(body.value.id, 80)).run();
      await audit(env.DB, actor, "push_unsubscribed");
      return json({ removed: result?.meta?.changes || 0 }, 200, headers);
    }
    if (request.method === "POST" && path === "/test") {
      const result = await notifyAll(env, { title: "JARVIS", body: "Testbenachrichtigung: Die Verbindung zu diesem Gerät funktioniert.", url: "./" }, { ttl: 300, urgency: "high" });
      return json(result, result.subscriptions ? 200 : 404, headers);
    }
    return json({ error: "not_found" }, 404, headers);
  } catch {
    return json({ error: "push_storage_unavailable" }, 503, headers);
  }
}
