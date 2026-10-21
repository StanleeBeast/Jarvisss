// JARVIS Kontext: Apple-Kurzbefehle (Automationen) schicken JARVIS, was auf dem iPhone/iPad passiert –
// z. B. „angekommen zu Hause“, „Fokus Schlafen an“, Akkustand, Schritte heute, eine Notiz.
// Kurzbefehle können keine wechselnden Sitzungsschlüssel verwalten. Deshalb gibt es einen eigenen Kurzbefehl-Schlüssel,
// der NUR Kontext senden darf (sonst nichts), gehasht gespeichert, jederzeit neu erzeugbar oder widerrufbar.
import { json, clip, readJsonBody, sha256Hex, sameSecret, bearer, audit } from "./http.js";
import { authenticate, actorOf } from "./auth.js";

export const CONTEXT_TYPES = {
  location: { label: "Ort", values: /^.{1,60}$/ },      // „zuhause“, „schule“, „unterwegs“ …
  focus: { label: "Fokus", values: /^.{1,60}$/ },       // „Schlafen an“, „Nicht stören aus“ …
  battery: { label: "Akku", number: [0, 100] },
  charging: { label: "Lädt", bool: true },
  steps: { label: "Schritte heute", number: [0, 200000] },
  sleep: { label: "Schlaf (Stunden)", number: [0, 24] },
  device: { label: "Gerät", values: /^.{1,40}$/ },
  note: { label: "Notiz", values: /^[\s\S]{1,500}$/ }
};
const KEY_SETTING = "context_key_hash";

function cleanValue(type, value) {
  const def = CONTEXT_TYPES[type];
  if (!def) return { error: "unknown_context_type" };
  if (def.number) {
    const n = Number(String(value).replace(",", ".").replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(n) || n < def.number[0] || n > def.number[1]) return { error: "invalid_context_value" };
    return { value: Math.round(n * 10) / 10 };
  }
  if (def.bool) return { value: /^(1|true|ja|yes|an|on)$/i.test(String(value).trim()) };
  const s = clip(String(value ?? ""), 500).replace(/[\u0000-\u001f]/g, " ").trim();
  if (!def.values.test(s)) return { error: "invalid_context_value" };
  return { value: s };
}

export async function getContext(db, nowMs = Date.now()) {
  const rows = (await db.prepare("SELECT * FROM context_state").all()).results || [];
  return rows.map(r => ({ type: r.type, label: CONTEXT_TYPES[r.type]?.label || r.type, value: JSON.parse(r.value), device: r.device, updatedAt: r.updated_at, minutesAgo: Math.round((nowMs - Date.parse(r.updated_at)) / 60000) }));
}
// Kurzfassung für den Systemprompt; ältere Angaben werden als alt gekennzeichnet oder weggelassen.
export function contextSummary(items) {
  const fresh = items.filter(i => i.minutesAgo < 24 * 60);
  if (!fresh.length) return "";
  const age = (m) => m < 2 ? "gerade eben" : m < 60 ? "vor " + m + " Min." : "vor " + Math.round(m / 60) + " Std.";
  return fresh.map(i => i.label + ": " + (typeof i.value === "boolean" ? (i.value ? "ja" : "nein") : i.value) + (i.type === "battery" ? " %" : "") + " (" + age(i.minutesAgo) + (i.device ? ", " + i.device : "") + ")").join("; ");
}

export async function handleContextApi(request, env, headers, url) {
  if (!url.pathname.startsWith("/api/context")) return null;
  if (!env.DB) return json({ error: "storage_not_configured" }, 503, headers);
  try {
    // Eingang vom Kurzbefehl: nur mit dem Kurzbefehl-Schlüssel (oder einer normalen Sitzung).
    if (url.pathname === "/api/context" && request.method === "POST") {
      const token = bearer(request);
      const stored = await env.DB.prepare("SELECT value FROM user_settings WHERE key = ?").bind(KEY_SETTING).first();
      let actor = null;
      if (token && stored && await sameSecret(await sha256Hex(token), stored.value)) actor = "shortcut";
      else {
        const auth = await authenticate(request, env, headers);
        if (auth.response) return auth.response;
        actor = actorOf(auth.principal);
      }
      const body = await readJsonBody(request, 4000);
      if (body.error) return json({ error: body.error }, body.status, headers);
      const list = Array.isArray(body.value.items) ? body.value.items : [{ type: body.value.type, value: body.value.value }];
      const device = clip(String(body.value.device || ""), 40);
      const now = new Date().toISOString();
      const saved = [];
      for (const item of list.slice(0, 8)) {
        const type = String(item?.type || "").toLowerCase();
        const c = cleanValue(type, item?.value);
        if (c.error) return json({ error: c.error, type }, 400, headers);
        await env.DB.prepare("INSERT INTO context_state (type, value, device, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(type) DO UPDATE SET value = excluded.value, device = excluded.device, updated_at = excluded.updated_at").bind(type, JSON.stringify(c.value), device, now).run();
        saved.push(type);
      }
      return json({ saved }, 200, headers);
    }
    const auth = await authenticate(request, env, headers);
    if (auth.response) return auth.response;
    const actor = actorOf(auth.principal);
    if (url.pathname === "/api/context" && request.method === "GET") {
      const key = await env.DB.prepare("SELECT updated_at FROM user_settings WHERE key = ?").bind(KEY_SETTING).first();
      return json({ items: await getContext(env.DB), keyCreatedAt: key?.updated_at || null }, 200, headers);
    }
    if (url.pathname === "/api/context/key" && request.method === "POST") {
      // Neuer Kurzbefehl-Schlüssel – wird genau einmal angezeigt; der alte wird damit ungültig.
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      const key = "jvc_" + [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
      await env.DB.prepare("INSERT INTO user_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(KEY_SETTING, await sha256Hex(key), new Date().toISOString()).run();
      await audit(env.DB, actor, "context.key_created");
      return json({ key }, 201, headers);
    }
    if (url.pathname === "/api/context/key" && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM user_settings WHERE key = ?").bind(KEY_SETTING).run();
      await audit(env.DB, actor, "context.key_revoked");
      return json({ revoked: true }, 200, headers);
    }
    if (url.pathname === "/api/context" && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM context_state").run();
      return json({ deleted: true }, 200, headers);
    }
    return json({ error: "not_found" }, 404, headers);
  } catch {
    return json({ error: "context_storage_unavailable", message: "Migration 0012 anwenden (Deploy-Workflow erneut ausführen)." }, 503, headers);
  }
}
