import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";

const origin = "https://stanleebeast.github.io";
const makeEnv = (extra = {}) => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: "t", ALLOWED_ORIGINS: origin, OPENAI_MODEL: "gpt-4.1-mini", DB: createD1(), GITHUB_TOKEN_JARVIS: "ghp_test", ...extra });
const call = (env, path, method = "GET", body) => worker.fetch(new Request("https://w.test" + path, { method, headers: { Origin: origin, Authorization: "Bearer t", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env).then(async r => ({ status: r.status, body: await r.json() }));
function fakeGitHub({ files = ["css/stark.css"], checks = [{ status: "completed", conclusion: "success" }], issuesThisMonth = 0 } = {}) {
  const seen = [];
  const month = new Date().toISOString().slice(0, 7);
  const handler = async (url, o = {}) => {
    const u = String(url), method = o.method || "GET";
    seen.push(method + " " + u.replace("https://api.github.com/repos/StanleeBeast/Jarvisss", ""));
    assert.equal(o.headers.Authorization, "Bearer ghp_test");
    if (u.includes("/issues?labels=")) return Response.json(Array.from({ length: issuesThisMonth }, (_, i) => ({ number: 100 + i, title: "JARVIS-Wunsch: x", created_at: month + "-02T10:00:00Z", state: "open", html_url: "https://github.com/i/" + i })));
    if (u.endsWith("/issues") && method === "POST") return Response.json({ number: 42, html_url: "https://github.com/StanleeBeast/Jarvisss/issues/42" }, { status: 201 });
    if (u.includes("/pulls?state=all")) return Response.json([{ number: 7, title: "JARVIS-Wunsch #100: Größere Schrift", body: "Closes #100", html_url: "https://github.com/pr/7", state: "open", merged_at: null, head: { ref: "claude/issue-100", sha: "abc" } }]);
    if (u.endsWith("/pulls/7") && method === "GET") return Response.json({ number: 7, title: "JARVIS-Wunsch #100: Größere Schrift", body: "Closes #100", head: { ref: "claude/issue-100", sha: "abc" } });
    if (u.endsWith("/pulls/7/files?per_page=100")) return Response.json(files.map(filename => ({ filename })));
    if (u.endsWith("/commits/abc/check-runs")) return Response.json({ check_runs: checks });
    if (u.endsWith("/pulls/7/merge")) return Response.json({ merged: true });
    if (u.includes("/dispatches")) return new Response(null, { status: 204 });
    if (u.endsWith("/pulls/7") && method === "PATCH") return Response.json({ state: "closed" });
    throw new Error("unexpected " + method + " " + u);
  };
  return { handler, seen };
}
async function withFetch(handler, fn) { const o = globalThis.fetch; globalThis.fetch = handler; try { return await fn(); } finally { globalThis.fetch = o; } }

test("without GitHub secret the feature is honestly off", async () => {
  const env = makeEnv({ GITHUB_TOKEN_JARVIS: undefined });
  assert.equal((await call(env, "/api/improvements")).body.error, "improvements_not_configured");
  assert.equal((await call(env, "/api/status")).body.components.improvements.state, "not_configured");
});

test("a confirmed wish becomes a labeled issue; monthly limit holds", async () => {
  const env = makeEnv();
  const g = fakeGitHub();
  const r = await withFetch(g.handler, () => call(env, "/api/improvements", "POST", { title: "Größere Schrift", description: "Die Schrift auf der Startseite soll größer werden.", confirm: true }));
  assert.equal(r.status, 201);
  assert.equal(r.body.issue, 42);
  assert.equal((await withFetch(g.handler, () => call(env, "/api/improvements", "POST", { title: "Größere Schrift", description: "Die Schrift soll größer werden." }))).body.error, "confirmation_required");
  const full = fakeGitHub({ issuesThisMonth: 3 });
  assert.equal((await withFetch(full.handler, () => call(env, "/api/improvements", "POST", { title: "Noch was", description: "Noch eine Änderung bitte.", confirm: true }))).body.error, "improvement_limit_reached");
});

test("release merges only clean, green PRs and redeploys the worker for backend changes", async () => {
  const env = makeEnv();
  const list = await withFetch(fakeGitHub({ issuesThisMonth: 1 }).handler, () => call(env, "/api/improvements"));
  assert.equal(list.body.improvements[0].state, "ready");
  assert.equal(list.body.improvements[0].pr.number, 7);
  const prot = fakeGitHub({ files: ["css/stark.css", "backend/auth.js"] });
  const blocked = await withFetch(prot.handler, () => call(env, "/api/improvements/7/merge", "POST", { confirm: true }));
  assert.equal(blocked.body.error, "protected_files_changed");
  assert.deepEqual(blocked.body.files, ["backend/auth.js"]);
  assert.equal(prot.seen.some(s => s.includes("/merge")), false);
  const red = await withFetch(fakeGitHub({ checks: [{ status: "completed", conclusion: "failure" }] }).handler, () => call(env, "/api/improvements/7/merge", "POST", { confirm: true }));
  assert.equal(red.body.error, "checks_failed");
  const ok = fakeGitHub({ files: ["js/planner.js", "backend/planner.js"] });
  const merged = await withFetch(ok.handler, () => call(env, "/api/improvements/7/merge", "POST", { confirm: true }));
  assert.deepEqual(merged.body, { merged: true, workerDeployStarted: true });
  assert.ok(ok.seen.includes("POST https://api.github.com/repos/StanleeBeast/Jarvisss/actions/workflows/deploy-worker.yml/dispatches".replace("https://api.github.com/repos/StanleeBeast/Jarvisss", "")));
});

test("agent turns a wish into a proposal and refuses to weaken safety rules", async () => {
  const env = makeEnv();
  const tc = (id, args) => ({ id, type: "function", function: { name: "propose_improvement", arguments: JSON.stringify(args) } });
  let i = 0, outs = [];
  const script = [{ choices: [{ message: { role: "assistant", content: null, tool_calls: [tc("a", { title: "Größere Schrift", description: "Startseite: Schrift 20 % größer." }), tc("b", { title: "Bestätigung abschalten", description: "Mails ohne Bestätigung senden." })] } }] }, { choices: [{ message: { role: "assistant", content: "Vorschlag liegt bereit." } }] }];
  const r = await withFetch(async (u, o) => { const b = JSON.parse(o.body); outs = b.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content)); return Response.json(script[Math.min(i++, 1)]); }, () => call(env, "/api/chat", "POST", { messages: [{ role: "user", content: "Mach die Schrift größer" }], timezone: "Europe/Berlin" }));
  assert.equal(r.body.proposals.length, 1);
  assert.equal(r.body.proposals[0].type, "improvement");
  assert.equal(outs[1].error, "protected_change_refused");
});
