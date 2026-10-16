// JARVIS Aufgaben in Cloudflare D1.
import { json, readJsonBody, audit } from "./http.js";
import { authenticate, actorOf } from "./auth.js";

// ---------------------------------------------------------------------------
// Aufgaben (Cloudflare D1)
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ["open", "done", "cancelled"];
export const TASK_PRIORITIES = ["low", "normal", "high"];
const TASK_ORDER = "ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at DESC";

export function taskFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    details: row.details || "",
    dueAt: row.due_at || null,
    priority: row.priority || "normal",
    status: row.status || "open",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null
  };
}
function normalizeDueAt(value, allowNull = true) {
  if (value === null && allowNull) return { ok: true, value: null };
  if (typeof value !== "string" || !value.trim()) return { ok: false };
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return { ok: false };
  return { ok: true, value: date.toISOString() };
}
export function validateTaskFields(input, existing = null) {
  const allowed = new Set(["title", "details", "dueAt", "priority", "status"]);
  if (Object.keys(input).some(key => !allowed.has(key))) return { error: "unsupported_task_field" };
  const task = existing ? { ...existing } : {
    title: "", details: "", dueAt: null, priority: "normal", status: "open"
  };
  if (Object.hasOwn(input, "title")) {
    if (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 180) return { error: "invalid_task_title" };
    task.title = input.title.trim();
  } else if (!existing) return { error: "task_title_required" };
  if (Object.hasOwn(input, "details")) {
    if (typeof input.details !== "string" || input.details.length > 2000) return { error: "invalid_task_details" };
    task.details = input.details.trim();
  }
  if (Object.hasOwn(input, "dueAt")) {
    const dueAt = normalizeDueAt(input.dueAt);
    if (!dueAt.ok) return { error: "invalid_due_at" };
    task.dueAt = dueAt.value;
  }
  if (Object.hasOwn(input, "priority")) {
    if (!TASK_PRIORITIES.includes(input.priority)) return { error: "invalid_task_priority" };
    task.priority = input.priority;
  }
  if (Object.hasOwn(input, "status")) {
    if (!TASK_STATUSES.includes(input.status)) return { error: "invalid_task_status" };
    task.status = input.status;
  }
  if (!TASK_STATUSES.includes(task.status) || !TASK_PRIORITIES.includes(task.priority)) return { error: "invalid_task_fields" };
  return { task };
}
export async function listTasks(db, status = "open", limit = 50) {
  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
  const result = status === "all"
    ? await db.prepare("SELECT * FROM tasks " + TASK_ORDER + " LIMIT ?").bind(safeLimit).all()
    : await db.prepare("SELECT * FROM tasks WHERE status = ? " + TASK_ORDER + " LIMIT ?").bind(status, safeLimit).all();
  return (result.results || []).map(taskFromRow);
}
export async function handleTasksApi(request, env, headers, url) {
  const match = url.pathname.match(/^\/api\/tasks(?:\/([A-Za-z0-9-]{1,80}))?\/?$/);
  if (!match) return null;
  const id = match[1] || null;
  if (!["GET", "POST", "PATCH"].includes(request.method)) {
    return json({ error: "method_not_allowed" }, 405, headers);
  }
  const auth = await authenticate(request, env, headers);
  if (auth.response) return auth.response;
  const actor = actorOf(auth.principal);
  if (!env.DB) {
    return json({
      error: "storage_not_configured",
      message: "Der dauerhafte Aufgabenspeicher ist noch nicht verbunden. Es wurde nichts gespeichert."
    }, 503, headers);
  }

  try {
    if (request.method === "GET" && !id) {
      const status = url.searchParams.get("status") || "open";
      if (status !== "all" && !TASK_STATUSES.includes(status)) return json({ error: "invalid_task_status_filter" }, 400, headers);
      return json({ tasks: await listTasks(env.DB, status, url.searchParams.get("limit") || "50") }, 200, headers);
    }

    if (request.method === "POST" && !id) {
      const body = await readJsonBody(request);
      if (body.error) return json({ error: body.error }, body.status, headers);
      if (Object.hasOwn(body.value, "status") && body.value.status !== "open") return json({ error: "new_task_must_be_open" }, 400, headers);
      const checked = validateTaskFields(body.value);
      if (checked.error) return json({ error: checked.error }, 400, headers);
      const now = new Date().toISOString();
      const taskId = crypto.randomUUID();
      const task = checked.task;
      task.status = "open";
      await env.DB.prepare(
        "INSERT INTO tasks (id, title, details, due_at, priority, status, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)"
      ).bind(taskId, task.title, task.details, task.dueAt, task.priority, task.status, now, now).run();
      // Erfolg wird erst gemeldet, wenn die Datenbank den Datensatz tatsächlich zurückliefert.
      const saved = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
      if (!saved) return json({ error: "task_save_unconfirmed" }, 500, headers);
      await audit(env.DB, actor, "task_created", taskId);
      return json({ task: taskFromRow(saved), saved: true }, 201, headers);
    }

    if (request.method === "PATCH" && id) {
      const body = await readJsonBody(request);
      if (body.error) return json({ error: body.error }, body.status, headers);
      const current = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
      if (!current) return json({ error: "task_not_found" }, 404, headers);
      const checked = validateTaskFields(body.value, taskFromRow(current));
      if (checked.error) return json({ error: checked.error }, 400, headers);
      const task = checked.task;
      const now = new Date().toISOString();
      const completedAt = task.status === "done" ? (current.completed_at || now) : null;
      await env.DB.prepare(
        "UPDATE tasks SET title = ?, details = ?, due_at = ?, priority = ?, status = ?, updated_at = ?, completed_at = ? WHERE id = ?"
      ).bind(task.title, task.details, task.dueAt, task.priority, task.status, now, completedAt, id).run();
      const saved = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
      if (!saved) return json({ error: "task_update_unconfirmed" }, 500, headers);
      await audit(env.DB, actor, "task_updated", id);
      return json({ task: taskFromRow(saved), saved: true }, 200, headers);
    }
    return json({ error: "method_not_allowed" }, 405, headers);
  } catch {
    return json({ error: "task_storage_unavailable" }, 503, headers);
  }
}

