// J.A.R.V.I.S.S. – Cloudflare Worker
// Verantwortlich für: Authentifizierung, KI-Orchestrierung (begrenzte Agentenschleife),
// kontrollierte Werkzeuge, Nachrichten, Sprachausgabe, Aufgaben (D1) und Systemstatus.
// Alle geheimen Schlüssel liegen ausschließlich als Worker-Secrets vor.

// Module: http.js (Helfer), auth.js (Gerätesitzungen), tasks.js, memories.js, news.js,
// agent.js (Werkzeuge und Agentenschleife), usage.js (Tageslimits).

import { json, clip, readJsonBody } from "./http.js";
import { authenticate, handleAuthApi, authStatus } from "./auth.js";
import { handleMemoriesApi } from "./memories.js";
import { handleTasksApi } from "./tasks.js";
import { getNews } from "./news.js";
import { handleChat, handleToolsApi, availableTools, DEFAULT_MODEL } from "./agent.js";
import { checkBudget, addUsage, handleUsageApi, getUsage, limits } from "./usage.js";
import { handlePushApi } from "./push.js";
import { handleAutomationApi, runScheduler, schedulerStatus } from "./scheduler.js";
import { handleStudyApi } from "./study.js";
import { handleMessagesApi } from "./messages.js";
import { handlePlannerApi } from "./planner.js";
import { handleCalendarApi, calendarStatus } from "./calendar.js";

const TTS_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];
const DEFAULT_TTS_VOICE = "coral";

// ---------------------------------------------------------------------------
// HTTP-Grundlagen
// ---------------------------------------------------------------------------

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "https://stanleebeast.github.io")
    .split(",").map(value => value.trim()).filter(Boolean);
}
function corsHeaders(origin, env) {
  const headers = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
  if (origin && allowedOrigins(env).includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}
function isTimeout(error) {
  return error?.name === "TimeoutError" || error?.name === "AbortError";
}

// ---------------------------------------------------------------------------
// Systemstatus: meldet nur, was hier tatsächlich geprüft wurde.
// ---------------------------------------------------------------------------

async function storageStatus(env) {
  if (!env.DB) return { state: "not_configured", detail: "Keine D1-Datenbank als DB gebunden." };
  try {
    const row = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").first();
    if (!row) return { state: "migration_missing", detail: "Datenbank erreichbar, Tabelle tasks fehlt. Migration anwenden." };
    return { state: "connected", detail: "Datenbank erreichbar, Tabelle tasks vorhanden.", verified: true };
  } catch {
    return { state: "error", detail: "Datenbankabfrage fehlgeschlagen." };
  }
}
async function plannerStatus(env) {
  if (!env.DB) return { state: "not_configured", detail: "Der Tagesplaner benötigt D1." };
  try {
    await env.DB.prepare("SELECT COUNT(*) AS n FROM day_plans").first();
    return { state: "available", detail: "Tagesplan aus Aufgaben, festen Zeiten, Routinen und Pausen. Ohne Kalenderzugriff.", verified: true };
  } catch {
    return { state: "migration_missing", detail: "Tabelle für den Tagesplaner fehlt. Migration 0007 anwenden (Deploy-Workflow erneut ausführen)." };
  }
}
async function studyStatus(env) {
  if (!env.DB) return { state: "not_configured", detail: "Der Lernassistent benötigt D1." };
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM study_sets").first();
    return { state: "available", detail: (row?.n ?? 0) + " Lernset(s). PDF-Import im Browser, Handschrift wird über Seitenbilder von der KI gelesen.", verified: true };
  } catch {
    return { state: "migration_missing", detail: "Tabellen für den Lernassistenten fehlen. Migration 0005 anwenden (Deploy-Workflow erneut ausführen)." };
  }
}
async function costStatus(env) {
  if (!env.DB) return { state: "not_configured", detail: "Ohne D1 werden KI-Aufrufe nicht gezählt und es gibt kein Tageslimit im Worker. Setze ein Budget beim KI-Anbieter." };
  try {
    const u = await getUsage(env.DB), max = limits(env);
    return { state: "available", detail: "Heute: " + u.chatRequests + "/" + max.chatRequests + " KI-Anfragen, " + (u.promptTokens + u.completionTokens) + "/" + max.tokens + " Tokens, " + u.ttsChars + "/" + max.ttsChars + " Zeichen Sprachausgabe.", verified: true };
  } catch {
    return { state: "migration_missing", detail: "Tabelle usage_daily fehlt. Migration 0003 anwenden (Deploy-Workflow erneut ausführen)." };
  }
}
async function systemStatus(env, principal) {
  const storage = await storageStatus(env);
  const access = await authStatus(env, principal);
  const hasModelKey = Boolean(env.OPENAI_API_KEY);
  return {
    checkedAt: new Date().toISOString(),
    components: {
      backend: { state: "available", detail: "Worker antwortet.", verified: true },
      auth: access.auth,
      devices: access.devices,
      ai: hasModelKey
        ? { state: "configured", detail: "API-Schlüssel hinterlegt. Ob das Modell antwortet, zeigt erst eine echte Anfrage.", model: env.OPENAI_MODEL || DEFAULT_MODEL, verified: false }
        : { state: "not_configured", detail: "OPENAI_API_KEY fehlt." },
      tts: hasModelKey
        ? { state: "configured", detail: "Neuronale Stimme über /api/tts; Systemstimme als Rückfall.", verified: false }
        : { state: "not_configured", detail: "Ohne API-Schlüssel nur Systemstimme des Geräts." },
      news: { state: "configured", detail: "Google-News-RSS, kein Schlüssel nötig. Erreichbarkeit zeigt erst ein Abruf.", verified: false },
      storage,
      tasks: storage.state === "connected"
        ? { state: "available", detail: "Aufgaben-API nutzbar.", verified: true }
        : { state: storage.state, detail: "Aufgaben-API benötigt die D1-Datenbank." },
      tools: { state: "available", detail: availableTools(env).map(t => t.name).join(", "), verified: true },
      costs: await costStatus(env),
      ...(await schedulerStatus(env)),
      study: await studyStatus(env),
      planner: await plannerStatus(env),
      calendar: await calendarStatus(env),
      memory: access.devices.state === "available"
        ? { state: "available", detail: "Gedächtnis wird in D1 gespeichert und zwischen deinen Geräten synchronisiert.", verified: true }
        : { state: access.devices.state, detail: "Ohne D1 (inkl. Migration 0002) bleibt das Gedächtnis lokal im Browser." },
      sync: access.devices.state === "available"
        ? { state: "available", detail: "Aufgaben und Gedächtnis: geräteübergreifend. Profil, Stimme und Design: weiterhin nur lokal.", verified: true }
        : { state: "not_available", detail: "Profil, Gedächtnis und Design liegen nur lokal im Browser." },
      messaging: { state: "manual_only", detail: "Kein Zugriff auf WhatsApp oder E-Mail. Ausgewählte Chats importierst du selbst (Chat exportieren oder einfügen); Antworten sind Entwürfe, die du selbst sendest." }
    }
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleTts(request, env, headers) {
  const auth = await authenticate(request, env, headers, { needsModel: true });
  if (auth.response) return auth.response;
  const body = await readJsonBody(request, 12_000);
  if (body.error) return json({ error: body.error }, body.status, headers);
  const input = clip(body.value.text, 4000).trim();
  if (!input) return json({ error: "text_required" }, 400, headers);
  const voice = TTS_VOICES.includes(body.value.voice) ? body.value.voice : DEFAULT_TTS_VOICE;
  const budget = await checkBudget(env, "tts", input.length);
  if (!budget.ok) return json({ error: budget.error, usage: budget.usage, limits: budget.limits }, 429, headers);
  try {
    const upstream = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice,
        input,
        instructions: "Sprich auf Deutsch. Klinge warm, ruhig, natürlich und souverän, wie ein hochwertiger persönlicher KI-Assistent. Nutze natürliche Pausen und klare Aussprache. Nicht übertrieben dramatisch, nicht monoton, nicht übermäßig langsam."
      }),
      signal: AbortSignal.timeout(40000)
    });
    if (!upstream.ok) return json({ error: upstream.status === 429 ? "tts_rate_limited" : "tts_request_failed", status: upstream.status }, 502, headers);
    await addUsage(env, { ttsRequests: 1, ttsChars: input.length });
    const audioHeaders = new Headers(headers);
    audioHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "audio/mpeg");
    audioHeaders.set("Cache-Control", "no-store");
    return new Response(upstream.body, { status: 200, headers: audioHeaders });
  } catch (error) {
    return json({ error: isTimeout(error) ? "tts_timeout" : "tts_unreachable" }, 502, headers);
  }
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin, env);
    if (origin && !allowedOrigins(env).includes(origin)) return json({ error: "origin_not_allowed" }, 403, headers);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", service: "jarvisss-ai-proxy", configured: Boolean(env.OPENAI_API_KEY && env.JARVIS_ACCESS_TOKEN) }, 200, headers);
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      const auth = await authenticate(request, env, headers);
      if (auth.response) return auth.response;
      return json(await systemStatus(env, auth.principal), 200, headers);
    }
    const authResponse = await handleAuthApi(request, env, headers, url);
    if (authResponse) return authResponse;
    const taskResponse = await handleTasksApi(request, env, headers, url);
    if (taskResponse) return taskResponse;
    const memoryResponse = await handleMemoriesApi(request, env, headers, url);
    if (memoryResponse) return memoryResponse;
    const usageResponse = await handleUsageApi(request, env, headers, url);
    if (usageResponse) return usageResponse;
    const toolsResponse = await handleToolsApi(request, env, headers, url);
    if (toolsResponse) return toolsResponse;
    const pushResponse = await handlePushApi(request, env, headers, url);
    if (pushResponse) return pushResponse;
    const automationResponse = await handleAutomationApi(request, env, headers, url);
    if (automationResponse) return automationResponse;
    const studyResponse = await handleStudyApi(request, env, headers, url);
    if (studyResponse) return studyResponse;
    const messagesResponse = await handleMessagesApi(request, env, headers, url);
    if (messagesResponse) return messagesResponse;
    const calendarResponse = await handleCalendarApi(request, env, headers, url);
    if (calendarResponse) return calendarResponse;
    const plannerResponse = await handlePlannerApi(request, env, headers, url);
    if (plannerResponse) return plannerResponse;
    if (request.method === "GET" && url.pathname === "/api/news") {
      const auth = await authenticate(request, env, headers);
      if (auth.response) return auth.response;
      try {
        const result = await getNews(url.searchParams.get("section") || "local");
        return json(result, result.error ? 400 : 200, headers);
      } catch {
        return json({ error: "news_source_unavailable" }, 502, headers);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/tts") return handleTts(request, env, headers);
    if (request.method === "POST" && (url.pathname === "/api/chat" || url.pathname === "/")) return handleChat(request, env, headers);
    return json({ error: "not_found" }, 404, headers);
  },

  // Cloudflare Cron (wrangler.toml → [triggers]): Erinnerungen, Morgenbriefing, geplante Benachrichtigungen.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduler(env).catch(() => null));
  }
};
