// JARVIS Authentifizierung: Gerätesitzungen statt eines gemeinsamen Dauertokens.
//
// - Admin-Schlüssel (JARVIS_ACCESS_TOKEN): nur für die Ersteinrichtung und als Notfallzugang.
// - Geräteschlüssel (refresh token): 30 Tage gültig, bei jeder Erneuerung rotiert, nur als Hash in D1.
//   Wird ein bereits ersetzter Schlüssel später erneut benutzt, wird das Gerät gesperrt (Diebstahlschutz).
// - Zugangsschlüssel (access token): 15 Minuten gültig, HMAC-signiert. Bei jeder Anfrage wird geprüft,
//   ob das Gerät noch aktiv ist – ein Widerruf wirkt dadurch sofort.
// - Kopplungscode: 8 Zeichen, 10 Minuten gültig, einmalig, höchstens 5 Fehlversuche.

import { json, clip, sha256Hex, sameSecret, bearer, readJsonBody, audit } from "./http.js";

export const ACCESS_TTL_MS = 15 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
export const PAIRING_TTL_MS = 10 * 60_000;
export const REFRESH_GRACE_MS = 60_000;
const MAX_PAIRING_ATTEMPTS = 5;
const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LAST_SEEN_RESOLUTION_MS = 5 * 60_000;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

function randomPairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map(b => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join("");
}
export function normalizePairingCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}
function deviceName(value) {
  const name = clip(value, 60).trim();
  return name || "Unbenanntes Gerät";
}

async function signingKey(env) {
  // Eigener Schlüssel möglich (SESSION_SIGNING_KEY); sonst vom Admin-Schlüssel abgeleitet.
  // Ein Wechsel des Admin-Schlüssels macht damit auch alle Zugangsschlüssel ungültig.
  const material = env.SESSION_SIGNING_KEY || "jarvis-session-v1:" + env.JARVIS_ACCESS_TOKEN;
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function issueAccessToken(env, deviceId, now = Date.now()) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ d: deviceId, exp: now + ACCESS_TTL_MS })));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env), new TextEncoder().encode(payload)));
  return { token: "jv1." + payload + "." + b64url(signature), expiresAt: new Date(now + ACCESS_TTL_MS).toISOString() };
}
async function verifyAccessToken(env, token) {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "jv1") return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await signingKey(env), fromB64url(parts[2]), new TextEncoder().encode(parts[1]));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
    if (typeof claims.d !== "string" || typeof claims.exp !== "number") return null;
    return claims;
  } catch {
    return null;
  }
}

// Prüft eine Anfrage. Ergebnis: { principal } oder { response } mit fertiger Fehlerantwort.
export async function authenticate(request, env, headers, { needsModel = false } = {}) {
  if (!env.JARVIS_ACCESS_TOKEN || (needsModel && !env.OPENAI_API_KEY)) {
    return { response: json({ error: "backend_not_configured" }, 503, headers) };
  }
  const token = bearer(request);
  if (!token) return { response: json({ error: "unauthorized" }, 401, headers) };
  if (token.startsWith("jv1.")) {
    const claims = await verifyAccessToken(env, token);
    if (!claims) return { response: json({ error: "unauthorized" }, 401, headers) };
    if (claims.exp <= Date.now()) return { response: json({ error: "token_expired" }, 401, headers) };
    if (!env.DB) return { response: json({ error: "storage_not_configured" }, 503, headers) };
    let device;
    try {
      device = await env.DB.prepare("SELECT id, name, revoked_at, expires_at, last_seen_at FROM devices WHERE id = ?").bind(claims.d).first();
    } catch {
      return { response: json({ error: "auth_storage_unavailable" }, 503, headers) };
    }
    if (!device || device.revoked_at) return { response: json({ error: "device_revoked" }, 401, headers) };
    if (Date.now() - Date.parse(device.last_seen_at) > LAST_SEEN_RESOLUTION_MS) {
      try { await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(new Date(Date.now()).toISOString(), device.id).run(); } catch { /* nicht kritisch */ }
    }
    return { principal: { type: "device", deviceId: device.id, deviceName: device.name } };
  }
  if (await sameSecret(token, env.JARVIS_ACCESS_TOKEN)) return { principal: { type: "admin", deviceId: null } };
  return { response: json({ error: "unauthorized" }, 401, headers) };
}
export const actorOf = (principal) => principal?.type === "device" ? "device:" + principal.deviceId : "admin";

async function createDevice(env, name, now = Date.now()) {
  const id = crypto.randomUUID();
  const refreshToken = randomToken();
  const iso = new Date(now).toISOString();
  await env.DB.prepare(
    "INSERT INTO devices (id, name, refresh_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, name, await sha256Hex(refreshToken), iso, iso, new Date(now + REFRESH_TTL_MS).toISOString()).run();
  const saved = await env.DB.prepare("SELECT id, name, created_at, expires_at FROM devices WHERE id = ?").bind(id).first();
  if (!saved) return null;
  const access = await issueAccessToken(env, id, now);
  return {
    device: { id: saved.id, name: saved.name, createdAt: saved.created_at },
    refreshToken,
    refreshExpiresAt: saved.expires_at,
    accessToken: access.token,
    accessExpiresAt: access.expiresAt
  };
}

async function refresh(env, refreshToken) {
  const now = Date.now();
  const hash = await sha256Hex(refreshToken);
  const current = await env.DB.prepare("SELECT * FROM devices WHERE refresh_hash = ?").bind(hash).first();
  if (!current) {
    const previous = await env.DB.prepare("SELECT * FROM devices WHERE previous_refresh_hash = ?").bind(hash).first();
    if (previous && !previous.revoked_at) {
      if (now - Date.parse(previous.rotated_at) <= REFRESH_GRACE_MS) return { error: "refresh_superseded", status: 409 };
      // Ein alter Schlüssel taucht wieder auf: mögliche Kopie. Gerät sicherheitshalber sperren.
      await env.DB.prepare("UPDATE devices SET revoked_at = ?, revoked_reason = 'refresh_reuse' WHERE id = ?").bind(new Date(now).toISOString(), previous.id).run();
      await audit(env.DB, "system", "device_revoked_reuse", previous.id);
      return { error: "device_revoked", status: 401 };
    }
    return { error: "unauthorized", status: 401 };
  }
  if (current.revoked_at) return { error: "device_revoked", status: 401 };
  if (Date.parse(current.expires_at) <= now) return { error: "device_expired", status: 401 };
  const next = randomToken();
  const iso = new Date(now).toISOString();
  const result = await env.DB.prepare(
    "UPDATE devices SET previous_refresh_hash = refresh_hash, refresh_hash = ?, rotated_at = ?, last_seen_at = ?, expires_at = ? WHERE id = ? AND refresh_hash = ?"
  ).bind(await sha256Hex(next), iso, iso, new Date(now + REFRESH_TTL_MS).toISOString(), current.id, hash).run();
  if (!result?.meta?.changes) return { error: "refresh_superseded", status: 409 };
  const access = await issueAccessToken(env, current.id, now);
  return {
    device: { id: current.id, name: current.name, createdAt: current.created_at },
    refreshToken: next,
    refreshExpiresAt: new Date(now + REFRESH_TTL_MS).toISOString(),
    accessToken: access.token,
    accessExpiresAt: access.expiresAt
  };
}

function deviceView(row, currentId) {
  return {
    id: row.id, name: row.name, createdAt: row.created_at, lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at, revokedAt: row.revoked_at || null, revokedReason: row.revoked_reason || null,
    current: row.id === currentId
  };
}

export async function handleAuthApi(request, env, headers, url) {
  if (!url.pathname.startsWith("/api/auth/")) return null;
  if (!env.JARVIS_ACCESS_TOKEN) return json({ error: "backend_not_configured" }, 503, headers);
  const path = url.pathname.slice("/api/auth".length).replace(/\/$/, "");
  const method = request.method;
  const needsDb = () => env.DB ? null : json({ error: "storage_not_configured", message: "Gerätesitzungen benötigen die D1-Datenbank. Bis dahin funktioniert der gemeinsame Zugangsschlüssel weiter." }, 503, headers);

  try {
    // Ohne Anmeldung erreichbar: Erneuerung und Abschluss einer Kopplung.
    if (method === "POST" && path === "/refresh") {
      const missing = needsDb(); if (missing) return missing;
      const body = await readJsonBody(request, 2_000);
      if (body.error) return json({ error: body.error }, body.status, headers);
      if (typeof body.value.refreshToken !== "string" || body.value.refreshToken.length < 20) return json({ error: "unauthorized" }, 401, headers);
      const result = await refresh(env, body.value.refreshToken);
      return result.error ? json({ error: result.error }, result.status, headers) : json(result, 200, headers);
    }
    if (method === "POST" && path === "/pair/complete") {
      const missing = needsDb(); if (missing) return missing;
      const body = await readJsonBody(request, 2_000);
      if (body.error) return json({ error: body.error }, body.status, headers);
      const code = normalizePairingCode(body.value.code);
      const nowIso = new Date(Date.now()).toISOString();
      await env.DB.prepare("DELETE FROM pairing_codes WHERE expires_at <= ? OR attempts >= ?").bind(nowIso, MAX_PAIRING_ATTEMPTS).run();
      const row = code.length === 8 ? await env.DB.prepare("SELECT * FROM pairing_codes WHERE code_hash = ?").bind(await sha256Hex(code)).first() : null;
      if (!row) {
        // Jeder Fehlversuch zählt gegen alle offenen Codes – Raten wird damit praktisch unmöglich.
        await env.DB.prepare("UPDATE pairing_codes SET attempts = attempts + 1").run();
        await audit(env.DB, "anonymous", "pairing_failed");
        return json({ error: "invalid_pairing_code" }, 400, headers);
      }
      const used = await env.DB.prepare("DELETE FROM pairing_codes WHERE code_hash = ?").bind(row.code_hash).run();
      if (!used?.meta?.changes) return json({ error: "invalid_pairing_code" }, 400, headers);
      const session = await createDevice(env, deviceName(body.value.deviceName));
      if (!session) return json({ error: "device_save_unconfirmed" }, 500, headers);
      await audit(env.DB, "device:" + session.device.id, "device_paired", row.created_by);
      return json(session, 201, headers);
    }

    const auth = await authenticate(request, env, headers);
    if (auth.response) return auth.response;
    const principal = auth.principal;

    if (method === "GET" && path === "/session") {
      return json({ principal: principal.type, device: principal.deviceId ? { id: principal.deviceId, name: principal.deviceName } : null, sessionsAvailable: Boolean(env.DB) }, 200, headers);
    }
    const missing = needsDb(); if (missing) return missing;

    if (method === "POST" && path === "/login") {
      // Erstes Gerät: der Admin-Schlüssel wird einmalig gegen eine eigene Gerätesitzung getauscht.
      if (principal.type !== "admin") return json({ error: "admin_token_required" }, 403, headers);
      const body = await readJsonBody(request, 2_000);
      if (body.error) return json({ error: body.error }, body.status, headers);
      const session = await createDevice(env, deviceName(body.value.deviceName));
      if (!session) return json({ error: "device_save_unconfirmed" }, 500, headers);
      await audit(env.DB, "admin", "device_login", session.device.id);
      return json(session, 201, headers);
    }
    if (method === "POST" && path === "/pair/start") {
      const code = randomPairingCode();
      const now = Date.now();
      // Es gibt immer höchstens einen offenen Kopplungscode.
      await env.DB.prepare("DELETE FROM pairing_codes").run();
      await env.DB.prepare("INSERT INTO pairing_codes (code_hash, created_by, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, 0)")
        .bind(await sha256Hex(code), actorOf(principal), new Date(now).toISOString(), new Date(now + PAIRING_TTL_MS).toISOString()).run();
      await audit(env.DB, actorOf(principal), "pairing_started");
      return json({ code: code.slice(0, 4) + "-" + code.slice(4), expiresAt: new Date(now + PAIRING_TTL_MS).toISOString() }, 201, headers);
    }
    if (method === "GET" && path === "/devices") {
      const result = await env.DB.prepare("SELECT * FROM devices ORDER BY revoked_at IS NOT NULL, last_seen_at DESC LIMIT 50").all();
      return json({ devices: (result.results || []).map(row => deviceView(row, principal.deviceId)) }, 200, headers);
    }
    const revokeMatch = path.match(/^\/devices\/([A-Za-z0-9-]{1,80})\/revoke$/);
    if (method === "POST" && (revokeMatch || path === "/logout")) {
      const id = revokeMatch ? revokeMatch[1] : principal.deviceId;
      if (!id) return json({ error: "no_device_session" }, 400, headers);
      const result = await env.DB.prepare("UPDATE devices SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(new Date(Date.now()).toISOString(), revokeMatch ? "revoked" : "logout", id).run();
      if (!result?.meta?.changes) return json({ error: "device_not_found" }, 404, headers);
      const check = await env.DB.prepare("SELECT revoked_at FROM devices WHERE id = ?").bind(id).first();
      if (!check?.revoked_at) return json({ error: "revoke_unconfirmed" }, 500, headers);
      await audit(env.DB, actorOf(principal), revokeMatch ? "device_revoked" : "device_logout", id);
      return json({ revoked: true, id }, 200, headers);
    }
    if (method === "GET" && path === "/audit") {
      const result = await env.DB.prepare("SELECT at, actor, action, target FROM audit_log ORDER BY id DESC LIMIT 50").all();
      return json({ entries: result.results || [] }, 200, headers);
    }
    return json({ error: "not_found" }, 404, headers);
  } catch {
    return json({ error: "auth_storage_unavailable" }, 503, headers);
  }
}

export async function authStatus(env, principal) {
  const base = principal?.type === "device"
    ? { state: "available", detail: "Eigene Gerätesitzung „" + principal.deviceName + "“ (15-Minuten-Schlüssel, widerrufbar).", verified: true }
    : { state: "available", detail: "Angemeldet mit dem gemeinsamen Admin-Schlüssel." + (env.DB ? " Empfehlung: Gerät unter „Geräte“ sicher anmelden." : " Gerätesitzungen benötigen D1."), verified: true };
  if (!env.DB) return { auth: base, devices: { state: "not_configured", detail: "Gerätesitzungen benötigen die D1-Datenbank." } };
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL").first();
    return { auth: base, devices: { state: "available", detail: (row?.n ?? 0) + " aktive Gerätesitzung(en).", verified: true } };
  } catch {
    return { auth: base, devices: { state: "migration_missing", detail: "Tabellen für Geräte fehlen. Migration 0002 anwenden (Deploy-Workflow erneut ausführen)." } };
  }
}
