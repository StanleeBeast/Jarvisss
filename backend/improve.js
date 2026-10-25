// JARVIS verbessert sich selbst – mit Erlaubnis.
// Ablauf: Wunsch im Gespräch → Vorschlag → du bestätigst → GitHub-Issue (Label „jarvis-wunsch“) →
// GitHub Action mit Claude Code baut die Änderung als Pull Request → Schutzprüfung → du tippst „Freigeben“ → Merge.
// Geschützte Dateien (Anmeldung, Sicherheit, Abläufe, Kostengrenze) darf eine Selbstverbesserung nie ändern.
// Kosten entstehen bei Anthropic (eigener Schlüssel, ANTHROPIC_API_KEY als GitHub-Secret), nicht bei OpenAI.
import { json, clip, readJsonBody, audit } from "./http.js";
import { authenticate, actorOf } from "./auth.js";

export const LABEL = "jarvis-wunsch";
export const PROTECTED = [/^\.github\//, /^backend\/(auth|http|usage|improve)\.js$/, /^backend\/migrations\/00(0\d|1[0-2])_/, /^backend\/wrangler\.toml$/, /^homestation\/src\/(secret|backend)\.js$/, /^backend\/test-support\//];
const isProtected = (file) => PROTECTED.some(r => r.test(file));
const repo = (env) => (env.GITHUB_REPO || "StanleeBeast/Jarvisss").replace(/[^A-Za-z0-9_.\/-]/g, "");
const REQUIRED_CHECKS = ["protected-files", "test-worker"];
const monthlyMax = (env) => { const n = Number(env.MAX_IMPROVEMENTS_PER_MONTH); return Number.isFinite(n) && n >= 0 ? n : 3; };

async function gh(env, path, { method = "GET", body } = {}) {
  const res = await fetch("https://api.github.com/repos/" + repo(env) + path, {
    method,
    headers: { "Authorization": "Bearer " + env.GITHUB_TOKEN_JARVIS, "Accept": "application/vnd.github+json", "User-Agent": "JARVIS-Worker", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
const linkedIssue = (pr) => Number(((pr.body || "") + " " + (pr.title || "") + " " + (pr.head?.ref || "")).match(/(?:#|issue[-_/])(\d+)/i)?.[1]) || null;

export function improvementStatus(env) {
  return env.GITHUB_TOKEN_JARVIS
    ? { state: "configured", detail: "Selbstverbesserung über GitHub eingerichtet (höchstens " + monthlyMax(env) + " pro Monat). Ob Claude Code läuft, zeigt der erste Wunsch.", verified: false }
    : { state: "not_configured", detail: "Selbstverbesserung aus: GitHub-Secret JARVIS_GITHUB_TOKEN (und ANTHROPIC_API_KEY für die GitHub Action) fehlt." };
}

export async function handleImprovementsApi(request, env, headers, url) {
  if (!url.pathname.startsWith("/api/improvements")) return null;
  const auth = await authenticate(request, env, headers);
  if (auth.response) return auth.response;
  const actor = actorOf(auth.principal);
  if (!env.GITHUB_TOKEN_JARVIS) return json({ error: "improvements_not_configured", message: "Für Selbstverbesserung fehlen die GitHub-Secrets JARVIS_GITHUB_TOKEN und ANTHROPIC_API_KEY." }, 503, headers);
  try {
    if (url.pathname === "/api/improvements" && request.method === "GET") {
      const [issues, pulls] = await Promise.all([gh(env, "/issues?labels=" + LABEL + "&state=all&per_page=20"), gh(env, "/pulls?state=all&per_page=40&sort=created&direction=desc")]);
      if (!issues.ok) return json({ error: issues.status === 401 ? "github_token_invalid" : "github_unavailable" }, 502, headers);
      const prs = (pulls.ok ? pulls.data : []).filter(p => !p.pull_request);
      const list = (issues.data || []).filter(i => !i.pull_request).map(i => {
        const pr = (pulls.ok ? pulls.data : []).find(p => linkedIssue(p) === i.number);
        const state = pr ? (pr.merged_at ? "live" : pr.state === "closed" ? "rejected" : "ready") : i.state === "closed" ? "closed" : "working";
        return { issue: i.number, title: i.title, createdAt: i.created_at, state, issueUrl: i.html_url, pr: pr ? { number: pr.number, url: pr.html_url, title: pr.title, body: clip(pr.body || "", 1500), mergedAt: pr.merged_at } : null };
      });
      const month = new Date().toISOString().slice(0, 7);
      return json({ improvements: list, usedThisMonth: list.filter(x => x.createdAt.startsWith(month)).length, maxPerMonth: monthlyMax(env) }, 200, headers);
    }
    if (url.pathname === "/api/improvements" && request.method === "POST") {
      const body = await readJsonBody(request, 6000);
      if (body.error) return json({ error: body.error }, body.status, headers);
      if (body.value.confirm !== true) return json({ error: "confirmation_required" }, 400, headers);
      const title = clip(String(body.value.title || ""), 120).trim(), description = clip(String(body.value.description || ""), 3000).trim();
      if (title.length < 4 || description.length < 10) return json({ error: "improvement_too_vague" }, 400, headers);
      const month = new Date().toISOString().slice(0, 7);
      const recent = await gh(env, "/issues?labels=" + LABEL + "&state=all&per_page=50&since=" + month + "-01T00:00:00Z");
      const used = (recent.data || []).filter(i => !i.pull_request && String(i.created_at).startsWith(month)).length;
      if (used >= monthlyMax(env)) return json({ error: "improvement_limit_reached", max: monthlyMax(env) }, 429, headers);
      const issue = await gh(env, "/issues", { method: "POST", body: { title: "JARVIS-Wunsch: " + title, labels: [LABEL], body: "Wunsch des Nutzers, bestätigt in der JARVIS-App.\n\n" + description + "\n\n---\nRegeln: siehe .github/workflows/jarvis-improve.yml. Geschützte Dateien werden nicht geändert." } });
      if (!issue.ok) return json({ error: issue.status === 401 || issue.status === 403 ? "github_token_invalid" : "github_unavailable" }, 502, headers);
      await audit(env.DB, actor, "improvement.requested", String(issue.data.number));
      return json({ saved: true, issue: issue.data.number, url: issue.data.html_url }, 201, headers);
    }
    const m = url.pathname.match(/^\/api\/improvements\/(\d{1,7})\/(merge|close)$/);
    if (m && request.method === "POST") {
      const body = await readJsonBody(request, 1000);
      if (body.error) return json({ error: body.error }, body.status, headers);
      if (body.value.confirm !== true) return json({ error: "confirmation_required" }, 400, headers);
      const n = m[1];
      if (m[2] === "close") {
        const r = await gh(env, "/pulls/" + n, { method: "PATCH", body: { state: "closed" } });
        if (r.ok) await audit(env.DB, actor, "improvement.rejected", n);
        return r.ok ? json({ closed: true }, 200, headers) : json({ error: "github_unavailable" }, 502, headers);
      }
      // Freigeben: nur ohne geschützte Dateien und mit grünen Prüfungen.
      const pr = await gh(env, "/pulls/" + n);
      if (!pr.ok) return json({ error: "pr_not_found" }, 404, headers);
      if (!linkedIssue(pr.data)) return json({ error: "not_a_jarvis_improvement" }, 409, headers);
      const files = await gh(env, "/pulls/" + n + "/files?per_page=100");
      const names = (files.data || []).map(f => f.filename);
      const blocked = names.filter(isProtected);
      if (blocked.length) return json({ error: "protected_files_changed", files: blocked }, 409, headers);
      const checks = await gh(env, "/commits/" + pr.data.head.sha + "/check-runs");
      const runs = checks.data?.check_runs || [];
      if (runs.some(c => c.status !== "completed")) return json({ error: "checks_running" }, 409, headers);
      // Ohne die Pflichtprüfungen (Schutzregeln + Worker-Tests) wird nie freigegeben – auch nicht, wenn gar keine liefen.
      if (REQUIRED_CHECKS.some(name => !runs.some(c => c.name === name))) return json({ error: "checks_missing", required: REQUIRED_CHECKS }, 409, headers);
      if (runs.some(c => !["success", "skipped", "neutral"].includes(c.conclusion))) return json({ error: "checks_failed" }, 409, headers);
      const merged = await gh(env, "/pulls/" + n + "/merge", { method: "PUT", body: { merge_method: "squash", sha: pr.data.head.sha } });
      if (!merged.ok) return json({ error: merged.status === 405 ? "not_mergeable" : "github_unavailable" }, 502, headers);
      await audit(env.DB, actor, "improvement.merged", n);
      // Backend geändert → Worker neu ausrollen (Website kommt über GitHub Pages von selbst).
      let deployed = false;
      if (names.some(f => f.startsWith("backend/"))) {
        const d = await gh(env, "/actions/workflows/deploy-worker.yml/dispatches", { method: "POST", body: { ref: "main" } });
        deployed = d.ok || d.status === 204;
      }
      return json({ merged: true, workerDeployStarted: deployed }, 200, headers);
    }
    return json({ error: "not_found" }, 404, headers);
  } catch {
    return json({ error: "github_unavailable" }, 502, headers);
  }
}
