// JARVIS Gedächtnis in D1: nur ausdrücklich gespeicherte Einträge, jederzeit anzeigbar, korrigierbar, löschbar.
import { json, readJsonBody, audit } from "./http.js";
import { authenticate, actorOf } from "./auth.js";

export const MEMORY_KINDS = ["preference", "fact", "style", "routine", "project"];

function memoryFromRow(row) {
  return { id: row.id, kind: row.kind, text: row.text, createdAt: row.created_at, updatedAt: row.updated_at };
}
function validateMemory(input, partial = false) {
  const allowed = new Set(["text", "kind"]);
  if (Object.keys(input).some(key => !allowed.has(key))) return { error: "unsupported_memory_field" };
  const out = {};
  if (Object.hasOwn(input, "text") || !partial) {
    if (typeof input.text !== "string" || !input.text.trim() || input.text.trim().length > 500) return { error: "invalid_memory_text" };
    out.text = input.text.trim();
  }
  if (Object.hasOwn(input, "kind")) {
    if (!MEMORY_KINDS.includes(input.kind)) return { error: "invalid_memory_kind" };
    out.kind = input.kind;
  } else if (!partial) out.kind = "preference";
  return { value: out };
}

export async function listMemories(db, limit = 200) {
  const result = await db.prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?").bind(limit).all();
  return (result.results || []).map(memoryFromRow);
}

export async function handleMemoriesApi(request, env, headers, url) {
  const match = url.pathname.match(/^\/api\/memories(?:\/([A-Za-z0-9-]{1,80}))?\/?$/);
  if (!match) return null;
  const id = match[1] || null;
  if (!["GET", "POST", "PATCH", "DELETE"].includes(request.method)) return json({ error: "method_not_allowed" }, 405, headers);
  const auth = await authenticate(request, env, headers);
  if (auth.response) return auth.response;
  const actor = actorOf(auth.principal);
  if (!env.DB) return json({ error: "storage_not_configured", message: "Das synchronisierte Gedächtnis benötigt die D1-Datenbank. Es wurde nichts gespeichert." }, 503, headers);

  try {
    if (request.method === "GET" && !id) {
      return json({ memories: await listMemories(env.DB) }, 200, headers);
    }
    if (request.method === "POST" && !id) {
      const body = await readJsonBody(request, 4_000);
      if (body.error) return json({ error: body.error }, body.status, headers);
      const checked = validateMemory(body.value);
      if (checked.error) return json({ error: checked.error }, 400, headers);
      const now = new Date().toISOString();
      const memoryId = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO memories (id, kind, text, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(memoryId, checked.value.kind, checked.value.text, now, now, actor).run();
      const saved = await env.DB.prepare("SELECT * FROM memories WHERE id = ?").bind(memoryId).first();
      if (!saved) return json({ error: "memory_save_unconfirmed" }, 500, headers);
      await audit(env.DB, actor, "memory_created", memoryId);
      return json({ memory: memoryFromRow(saved), saved: true }, 201, headers);
    }
    if (request.method === "PATCH" && id) {
      const body = await readJsonBody(request, 4_000);
      if (body.error) return json({ error: body.error }, body.status, headers);
      const checked = validateMemory(body.value, true);
      if (checked.error) return json({ error: checked.error }, 400, headers);
      const current = await env.DB.prepare("SELECT * FROM memories WHERE id = ?").bind(id).first();
      if (!current) return json({ error: "memory_not_found" }, 404, headers);
      const now = new Date().toISOString();
      await env.DB.prepare("UPDATE memories SET text = ?, kind = ?, updated_at = ? WHERE id = ?")
        .bind(checked.value.text ?? current.text, checked.value.kind ?? current.kind, now, id).run();
      const saved = await env.DB.prepare("SELECT * FROM memories WHERE id = ?").bind(id).first();
      if (!saved) return json({ error: "memory_update_unconfirmed" }, 500, headers);
      await audit(env.DB, actor, "memory_updated", id);
      return json({ memory: memoryFromRow(saved), saved: true }, 200, headers);
    }
    if (request.method === "DELETE") {
      // Kategorie D: Die App fragt vorher ausdrücklich nach. Löschen von allem nur mit ?all=confirm.
      if (!id && url.searchParams.get("all") !== "confirm") return json({ error: "confirmation_required" }, 400, headers);
      const result = id
        ? await env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(id).run()
        : await env.DB.prepare("DELETE FROM memories").run();
      if (id && !result?.meta?.changes) return json({ error: "memory_not_found" }, 404, headers);
      const left = id ? await env.DB.prepare("SELECT id FROM memories WHERE id = ?").bind(id).first() : null;
      if (left) return json({ error: "memory_delete_unconfirmed" }, 500, headers);
      await audit(env.DB, actor, id ? "memory_deleted" : "memories_cleared", id);
      return json({ deleted: true, count: result?.meta?.changes ?? 0 }, 200, headers);
    }
    return json({ error: "method_not_allowed" }, 405, headers);
  } catch {
    return json({ error: "memory_storage_unavailable" }, 503, headers);
  }
}
