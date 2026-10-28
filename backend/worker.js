// J.A.R.V.I.S.S. – Cloudflare Worker
// Verantwortlich für: Authentifizierung, KI-Orchestrierung (begrenzte Agentenschleife),
// kontrollierte Werkzeuge, Nachrichten, Sprachausgabe, Aufgaben (D1) und Systemstatus.
// Alle geheimen Schlüssel liegen ausschließlich als Worker-Secrets vor.

// Module: http.js (Helfer), auth.js (Gerätesitzungen), tasks.js, memories.js, news.js,
// agent.js (Werkzeuge und Agentenschleife), usage.js (Tageslimits).

import { json, clip, readJsonBody, modelError } from "./http.js";
import { authenticate, handleAuthApi, authStatus } from "./auth.js";
import { handleMemoriesApi } from "./memories.js";
import { handleTasksApi } from "./tasks.js";
import { getNews } from "./news.js";
import { handleChat, handleToolsApi, availableTools, DEFAULT_MODEL, runAgent } from "./agent.js";
import { handleAutonomyApi, runAutonomy } from "./autonomy.js";
import { handleWebsitesApi } from "./websites.js";
import { handleContextApi } from "./context.js";
import { handleImprovementsApi, improvementStatus } from "./improve.js";
import { handleAlexaApi } from "./alexa.js";
import { checkBudget, addUsage, handleUsageApi, getUsage, limits, budgetState, EXTRA_COST } from "./usage.js";
import { handlePushApi } from "./push.js";
import { handleAutomationApi, runScheduler, schedulerStatus } from "./scheduler.js";
import { handleStudyApi } from "./study.js";
import { handleMessagesApi } from "./messages.js";
import { handlePlannerApi } from "./planner.js";
import { handleCalendarApi, calendarStatus } from "./calendar.js";
import { handleMailApi, stationStatus } from "./mail.js";

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
    const u = await getUsage(env.DB), max = limits(env), b = await budgetState(env);
    const month = "Monat: ca. " + b.spentUsd.toFixed(2) + " $ von " + b.limitUsd.toFixed(2) + " $" + (b.level === "saving" ? " – Sparmodus (günstigeres Modell, keine Websuche)" : b.level === "exhausted" ? " – Grenze erreicht, KI pausiert bis Monatsende" : "") + ". ";
    return { state: b.level === "exhausted" ? "warning" : "available", detail: month + "Heute: " + u.chatRequests + "/" + max.chatRequests + " KI-Anfragen, " + (u.promptTokens + u.completionTokens) + "/" + max.tokens + " Tokens, " + u.ttsChars + "/" + max.ttsChars + " Zeichen Sprachausgabe.", verified: true };
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
      tts: env.ELEVENLABS_API_KEY
        ? { state: "configured", detail: "ElevenLabs-Stimme über /api/tts" + (hasModelKey ? "; OpenAI springt ein, wenn ElevenLabs nicht antwortet" : "") + "; Systemstimme als letzter Rückfall. Ob die Stimme klingt, zeigt erst „Stimme testen“.", provider: "elevenlabs", verified: false }
        : hasModelKey
          ? { state: "configured", detail: "OpenAI-Stimme über /api/tts; Systemstimme als Rückfall. ElevenLabs: Secret ELEVENLABS_API_KEY fehlt.", provider: "openai", verified: false }
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
      mail: await stationStatus(env),
      improvements: improvementStatus(env),
      messaging: { state: "manual_only", detail: "Kein Zugriff auf WhatsApp. Ausgewählte Chats importierst du selbst (Chat exportieren oder einfügen); Antworten sind Entwürfe, die du selbst sendest. E-Mail: siehe Home-Station." }
    }
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// Sprachausgabe: ElevenLabs, wenn ELEVENLABS_API_KEY gesetzt ist (Stimme frei wählbar), sonst OpenAI.
// Scheitert ElevenLabs (z. B. Kontingent aufgebraucht), springt OpenAI ein – die Antwort sagt ehrlich, wer gesprochen hat.
const ELEVEN_MODELS = { quality: "eleven_multilingual_v2", fast: "eleven_flash_v2_5" };
const ELEVEN_DEFAULT_VOICE = "pNInz6obpgDQGcFmaJgB"; // ElevenLabs-Bibliotheksstimme „Adam“ (ruhig, tief), änderbar in der App
const ELEVEN_VOICE_ID = /^[A-Za-z0-9]{10,40}$/;
function audioResponse(upstream, headers, provider) {
  const audioHeaders = new Headers(headers);
  audioHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "audio/mpeg");
  audioHeaders.set("Cache-Control", "no-store");
  audioHeaders.set("X-Jarvis-Tts", provider);
  audioHeaders.set("Access-Control-Expose-Headers", "X-Jarvis-Tts");
  return new Response(upstream.body, { status: 200, headers: audioHeaders });
}
async function elevenSpeech(env, input, voiceId, mode) {
  const model = ELEVEN_MODELS[mode] || ELEVEN_MODELS.quality;
  const body = { text: input, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true } };
  if (model === ELEVEN_MODELS.fast) body.language_code = "de";
  return fetch("https://api.elevenlabs.io/v1/text-to-speech/" + voiceId + "?output_format=mp3_44100_128", {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
}
async function openaiSpeech(env, input, voice) {
  return fetch("https://api.openai.com/v1/audio/speech", {
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
}
async function handleTts(request, env, headers) {
  const auth = await authenticate(request, env, headers, { needsModel: !env.ELEVENLABS_API_KEY });
  if (auth.response) return auth.response;
  const body = await readJsonBody(request, 12_000);
  if (body.error) return json({ error: body.error }, body.status, headers);
  const input = clip(body.value.text, 4000).trim();
  if (!input) return json({ error: "text_required" }, 400, headers);
  const requested = typeof body.value.voice === "string" ? body.value.voice : "";
  const budget = await checkBudget(env, "tts", input.length);
  if (!budget.ok) return json({ error: budget.error, usage: budget.usage, limits: budget.limits }, 429, headers);
  const wantsEleven = env.ELEVENLABS_API_KEY && !TTS_VOICES.includes(requested);
  try {
    if (wantsEleven) {
      const voiceId = requested.startsWith("el:") && ELEVEN_VOICE_ID.test(requested.slice(3)) ? requested.slice(3) : (ELEVEN_VOICE_ID.test(env.ELEVENLABS_VOICE_ID || "") ? env.ELEVENLABS_VOICE_ID : ELEVEN_DEFAULT_VOICE);
      const upstream = await elevenSpeech(env, input, voiceId, body.value.mode).catch(() => null);
      if (upstream?.ok) {
        await addUsage(env, { ttsRequests: 1, ttsChars: input.length });
        return audioResponse(upstream, headers, "elevenlabs");
      }
      if (!env.OPENAI_API_KEY) return json({ error: upstream?.status === 401 ? "tts_key_invalid" : upstream?.status === 429 ? "tts_rate_limited" : "tts_request_failed" }, 502, headers);
    }
    const voice = TTS_VOICES.includes(requested) ? requested : DEFAULT_TTS_VOICE;
    if ((await budgetState(env)).level === "exhausted") return json({ error: "monthly_budget_reached" }, 429, headers); // Gerät spricht dann mit der Systemstimme
    const upstream = await openaiSpeech(env, input, voice);
    if (!upstream.ok) return json({ error: upstream.status === 429 ? "tts_rate_limited" : "tts_request_failed", status: upstream.status }, 502, headers);
    await addUsage(env, { ttsRequests: 1, ttsChars: input.length, costUsd: input.length * EXTRA_COST.openaiTtsPerChar });
    return audioResponse(upstream, headers, wantsEleven ? "openai-fallback" : "openai");
  } catch (error) {
    return json({ error: isTimeout(error) ? "tts_timeout" : "tts_unreachable" }, 502, headers);
  }
}
// Liste der ElevenLabs-Stimmen des Kontos (Name, Merkmale, Hörprobe). Der Schlüssel verlässt den Worker nie.
async function handleTtsVoices(request, env, headers) {
  const auth = await authenticate(request, env, headers);
  if (auth.response) return auth.response;
  const openai = TTS_VOICES.map(v => ({ id: v, name: v[0].toUpperCase() + v.slice(1), provider: "openai" }));
  if (!env.ELEVENLABS_API_KEY) return json({ provider: env.OPENAI_API_KEY ? "openai" : "none", elevenlabs: false, voices: openai }, 200, headers);
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": env.ELEVENLABS_API_KEY }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return json({ provider: "elevenlabs", elevenlabs: true, error: res.status === 401 ? "tts_key_invalid" : "tts_request_failed", voices: openai }, 200, headers);
    const data = await res.json();
    const eleven = (Array.isArray(data.voices) ? data.voices : []).filter(v => ELEVEN_VOICE_ID.test(v.voice_id || "")).slice(0, 100).map(v => ({
      id: "el:" + v.voice_id, name: clip(v.name, 60), provider: "elevenlabs", category: clip(v.category, 30),
      labels: v.labels && typeof v.labels === "object" ? Object.fromEntries(Object.entries(v.labels).slice(0, 6).map(([k, x]) => [clip(k, 20), clip(x, 30)])) : {},
      preview: /^https:\/\/[a-z0-9.-]+\.(elevenlabs\.io|googleapis\.com|amazonaws\.com)\//.test(v.preview_url || "") ? v.preview_url : null
    }));
    return json({ provider: "elevenlabs", elevenlabs: true, defaultVoice: "el:" + (ELEVEN_VOICE_ID.test(env.ELEVENLABS_VOICE_ID || "") ? env.ELEVENLABS_VOICE_ID : ELEVEN_DEFAULT_VOICE), voices: [...eleven, ...openai] }, 200, headers);
  } catch {
    return json({ provider: "elevenlabs", elevenlabs: true, error: "tts_unreachable", voices: openai }, 200, headers);
  }
}
// Spracheingabe: Aufnahme vom Gerät → OpenAI-Transkription. Zuverlässiger als die Browser-Spracherkennung,
// die in iPad-Home-Bildschirm-Apps oft nicht startet oder abbricht. Audio wird nicht gespeichert.
const STT_TYPES = /^audio\/(mp4|m4a|x-m4a|aac|webm|ogg|mpeg|mp3|wav|x-wav)(;.*)?$/i;
const STT_MAX_BYTES = 8 * 1024 * 1024;
async function handleStt(request, env, headers) {
  const auth = await authenticate(request, env, headers, { needsModel: true });
  if (auth.response) return auth.response;
  const type = (request.headers.get("Content-Type") || "").trim();
  if (!STT_TYPES.test(type)) return json({ error: "invalid_audio_type" }, 415, headers);
  if (Number(request.headers.get("Content-Length") || 0) > STT_MAX_BYTES) return json({ error: "audio_too_large" }, 413, headers);
  const audio = await request.arrayBuffer();
  if (audio.byteLength > STT_MAX_BYTES) return json({ error: "audio_too_large" }, 413, headers);
  if (audio.byteLength < 800) return json({ text: "", empty: true }, 200, headers);
  const budget = await checkBudget(env, "chat");
  if (!budget.ok) return json({ error: budget.error }, 429, headers);
  const ext = /webm/i.test(type) ? "webm" : /ogg/i.test(type) ? "ogg" : /wav/i.test(type) ? "wav" : /mpeg|mp3/i.test(type) ? "mp3" : "m4a";
  const form = new FormData();
  form.append("file", new Blob([audio], { type: type.split(";")[0] }), "sprache." + ext);
  form.append("model", env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe");
  form.append("language", "de");
  form.append("prompt", "Gespräch mit dem persönlichen Assistenten JARVIS. Orte: Miltitz, Nebelschütz, Kamenz, Bautzen. Begriffe: Tagesplan, Briefing, Aufgabe, Erinnerung, Mail.");
  try {
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { "Authorization": "Bearer " + env.OPENAI_API_KEY }, body: form, signal: AbortSignal.timeout(30000) });
    if (!res.ok) return json({ error: await modelError(res) }, 502, headers);
    const data = await res.json();
    await addUsage(env, { chatRequests: 1, costUsd: EXTRA_COST.stt });
    return json({ text: clip(String(data.text || ""), 2000).trim() }, 200, headers);
  } catch (error) {
    return json({ error: isTimeout(error) ? "model_timeout" : "model_unreachable" }, 502, headers);
  }
}
// KI-Tagesvorbereitung für die Autonomie (morgens, einmal am Tag). Vorschläge werden nur gespeichert, nicht ausgeführt.
export const DAY_PREP_PROMPT = "Bereite meinen Tag vor. Nutze get_briefing und get_day_plan. Antworte als gesprochenes Morgenbriefing in höchstens 120 Wörtern: Begrüßung, Wetter, was heute ansteht, wichtige Mails, eine Schlagzeile aus der Region. Wenn sinnvoll, schlage höchstens 3 Dinge vor (z. B. eine Aufgabe mit Uhrzeit oder eine Planänderung) – nur als Vorschlag.";
async function prepareDay(env, timezone) {
  const result = await runAgent({ messages: [{ role: "user", content: DAY_PREP_PROMPT }], timezone, profile: { autoMemory: false }, voice: true }, env);
  return result.error ? { error: result.error } : { reply: result.reply, proposals: result.proposals || [] };
}
export { prepareDay };
export default {
  async fetch(request, env, ctx) {
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
    const mailResponse = await handleMailApi(request, env, headers, url);
    if (mailResponse) return mailResponse;
    const alexaResponse = await handleAlexaApi(request, env, headers, url, ctx, runAgent);
    if (alexaResponse) return alexaResponse;
    const improveResponse = await handleImprovementsApi(request, env, headers, url);
    if (improveResponse) return improveResponse;
    const contextResponse = await handleContextApi(request, env, headers, url);
    if (contextResponse) return contextResponse;
    const autonomyResponse = await handleAutonomyApi(request, env, headers, url);
    if (autonomyResponse) return autonomyResponse;
    const websitesResponse = await handleWebsitesApi(request, env, headers, url);
    if (websitesResponse) return websitesResponse;
    if (request.method === "GET" && url.pathname === "/api/news") {
      const auth = await authenticate(request, env, headers);
      if (auth.response) return auth.response;
      try {
        const result = await getNews(url.searchParams.get("section") || "local");
        return json(result, result.error === "invalid_news_section" ? 400 : 200, headers);
      } catch {
        return json({ error: "news_source_unavailable" }, 502, headers);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/stt") return handleStt(request, env, headers);
    if (request.method === "POST" && url.pathname === "/api/tts") return handleTts(request, env, headers);
    if (request.method === "GET" && url.pathname === "/api/tts/voices") return handleTtsVoices(request, env, headers);
    if (request.method === "POST" && (url.pathname === "/api/chat" || url.pathname === "/")) return handleChat(request, env, headers);
    return json({ error: "not_found" }, 404, headers);
  },

  // Cloudflare Cron (wrangler.toml → [triggers]): Erinnerungen, Morgenbriefing, geplante Benachrichtigungen.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduler(env).catch(() => null).then(() => runAutonomy(env, { prepareDay }).catch(() => null)));
  }
};
