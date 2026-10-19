// Gemeinsame HTTP-Helfer für den JARVIS-Worker.

export function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

export function clip(value, max = 8_000) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Vergleich in konstanter Zeit über die Hashes beider Werte.
export async function sameSecret(a, b) {
  if (!a || !b) return false;
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

export function bearer(request) {
  const auth = request.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

export async function readJsonBody(request, maxBytes = 12_000) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > maxBytes) return { error: "request_too_large", status: 413 };
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > maxBytes) return { error: "request_too_large", status: 413 };
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "invalid_payload", status: 400 };
    return { value };
  } catch {
    return { error: "invalid_json", status: 400 };
  }
}

export async function audit(db, actor, action, target = null) {
  if (!db) return;
  try {
    await db.prepare("INSERT INTO audit_log (at, actor, action, target) VALUES (?, ?, ?, ?)")
      .bind(new Date().toISOString(), actor, action, target).run();
  } catch {
    // Das Protokoll darf die eigentliche Aktion nie verhindern.
  }
}

// Übersetzt eine fehlgeschlagene Antwort des KI-Anbieters in einen ehrlichen Fehlercode.
// 429 kann „zu viele Anfragen“ oder „Guthaben aufgebraucht“ (insufficient_quota) bedeuten – das ist ein großer Unterschied.
export async function modelError(res) {
  let code = "";
  try { code = String((await res.json())?.error?.code || ""); } catch { /* kein JSON */ }
  if (code === "insufficient_quota") return "model_quota_exhausted";
  if (res.status === 401) return "model_key_invalid";
  if (res.status === 429) return "model_rate_limited";
  return "model_request_failed";
}
