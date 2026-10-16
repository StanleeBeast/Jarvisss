import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1, brokenD1 } from "./test-support/d1.js";

const origin = "https://stanleebeast.github.io";
const baseEnv = {
  OPENAI_API_KEY: "test-openai-key",
  JARVIS_ACCESS_TOKEN: "test-jarvis-token",
  ALLOWED_ORIGINS: origin
};
function req(path, { method = "GET", token = baseEnv.JARVIS_ACCESS_TOKEN, body, raw } = {}) {
  const headers = { Origin: origin };
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined || raw !== undefined) headers["Content-Type"] = "application/json";
  return new Request("https://jarvisss-ai.test" + path, {
    method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body)
  });
}
async function call(env, path, options) {
  const response = await worker.fetch(req(path, options), env);
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test("tasks API requires authentication", async () => {
  const env = { ...baseEnv, DB: createD1() };
  const result = await call(env, "/api/tasks", { token: null });
  assert.equal(result.status, 401);
  assert.equal(result.body.error, "unauthorized");
});

test("tasks API reports missing storage instead of pretending to save", async () => {
  const result = await call(baseEnv, "/api/tasks", { method: "POST", body: { title: "Test" } });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "storage_not_configured");
});

test("created task is persisted and returned on a fresh read", async () => {
  const env = { ...baseEnv, DB: createD1() };
  const created = await call(env, "/api/tasks", { method: "POST", body: { title: "  Lernzettel Herz-Kreislauf  ", details: "10 Quizfragen", dueAt: "2026-10-17T16:30:00.000Z", priority: "high" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.saved, true);
  assert.equal(created.body.task.title, "Lernzettel Herz-Kreislauf");
  assert.equal(created.body.task.status, "open");
  assert.equal(created.body.task.dueAt, "2026-10-17T16:30:00.000Z");

  const listed = await call(env, "/api/tasks?status=open");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.tasks.length, 1);
  assert.equal(listed.body.tasks[0].id, created.body.task.id);
});

test("invalid task input is rejected", async () => {
  const env = { ...baseEnv, DB: createD1() };
  const cases = [
    [{ title: "" }, "invalid_task_title"],
    [{ details: "ohne Titel" }, "task_title_required"],
    [{ title: "x".repeat(181) }, "invalid_task_title"],
    [{ title: "Ok", priority: "urgent" }, "invalid_task_priority"],
    [{ title: "Ok", dueAt: "morgen irgendwann" }, "invalid_due_at"],
    [{ title: "Ok", owner: "someone" }, "unsupported_task_field"],
    [{ title: "Ok", status: "done" }, "new_task_must_be_open"]
  ];
  for (const [body, error] of cases) {
    const result = await call(env, "/api/tasks", { method: "POST", body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.error, error);
  }
  const badJson = await call(env, "/api/tasks", { method: "POST", raw: "{kaputt" });
  assert.equal(badJson.body.error, "invalid_json");
  const badFilter = await call(env, "/api/tasks?status=everything");
  assert.equal(badFilter.body.error, "invalid_task_status_filter");
  const empty = await call(env, "/api/tasks?status=all");
  assert.equal(empty.body.tasks.length, 0);
});

test("completing a task sets completedAt and reopening clears it", async () => {
  const env = { ...baseEnv, DB: createD1() };
  const created = await call(env, "/api/tasks", { method: "POST", body: { title: "Jugendclub vorbereiten" } });
  const id = created.body.task.id;
  const done = await call(env, "/api/tasks/" + id, { method: "PATCH", body: { status: "done" } });
  assert.equal(done.status, 200);
  assert.equal(done.body.task.status, "done");
  assert.ok(done.body.task.completedAt);
  const open = await call(env, "/api/tasks?status=open");
  assert.equal(open.body.tasks.length, 0);
  const reopened = await call(env, "/api/tasks/" + id, { method: "PATCH", body: { status: "open" } });
  assert.equal(reopened.body.task.completedAt, null);
});

test("patching an unknown task returns 404", async () => {
  const env = { ...baseEnv, DB: createD1() };
  const result = await call(env, "/api/tasks/does-not-exist", { method: "PATCH", body: { status: "done" } });
  assert.equal(result.status, 404);
  assert.equal(result.body.error, "task_not_found");
});

test("tasks are ordered by priority and due date", async () => {
  const env = { ...baseEnv, DB: createD1() };
  await call(env, "/api/tasks", { method: "POST", body: { title: "Niedrig", priority: "low" } });
  await call(env, "/api/tasks", { method: "POST", body: { title: "Hoch später", priority: "high", dueAt: "2026-10-20T10:00:00Z" } });
  await call(env, "/api/tasks", { method: "POST", body: { title: "Hoch früher", priority: "high", dueAt: "2026-10-18T10:00:00Z" } });
  const listed = await call(env, "/api/tasks");
  assert.deepEqual(listed.body.tasks.map(t => t.title), ["Hoch früher", "Hoch später", "Niedrig"]);
});

test("database failure is reported, not hidden", async () => {
  const env = { ...baseEnv, DB: brokenD1() };
  const result = await call(env, "/api/tasks");
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "task_storage_unavailable");
});

test("unsupported methods on tasks return 405", async () => {
  const env = { ...baseEnv, DB: createD1() };
  const result = await call(env, "/api/tasks", { method: "DELETE" });
  assert.equal(result.status, 405);
});

test("CORS preflight allows PATCH for task updates", async () => {
  const response = await worker.fetch(new Request("https://jarvisss-ai.test/api/tasks/abc", {
    method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "PATCH" }
  }), baseEnv);
  assert.equal(response.status, 204);
  assert.match(response.headers.get("Access-Control-Allow-Methods"), /PATCH/);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
});

test("status endpoint reports storage states truthfully", async () => {
  const none = await call(baseEnv, "/api/status");
  assert.equal(none.status, 200);
  assert.equal(none.body.components.storage.state, "not_configured");
  assert.equal(none.body.components.ai.verified, false);
  assert.equal(none.body.components.calendar.state, "not_available");

  const unmigrated = await call({ ...baseEnv, DB: createD1({ migrate: false }) }, "/api/status");
  assert.equal(unmigrated.body.components.storage.state, "migration_missing");

  const ready = await call({ ...baseEnv, DB: createD1() }, "/api/status");
  assert.equal(ready.body.components.storage.state, "connected");
  assert.equal(ready.body.components.tasks.state, "available");
  assert.match(ready.body.components.tools.detail, /list_tasks/);

  const broken = await call({ ...baseEnv, DB: brokenD1() }, "/api/status");
  assert.equal(broken.body.components.storage.state, "error");

  const anon = await call(baseEnv, "/api/status", { token: null });
  assert.equal(anon.status, 401);
  assert.equal(JSON.stringify(ready.body).includes(baseEnv.OPENAI_API_KEY), false);
});
