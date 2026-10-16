// JARVIS Nutzungszähler und Tageslimits (Kostenkontrolle).
// Gezählt wird pro Kalendertag in Europe/Berlin. Ohne D1 wird nicht gezählt; das meldet der Systemstatus ehrlich.
import { json } from "./http.js";
import { authenticate } from "./auth.js";

export const DEFAULT_LIMITS = { chatRequests: 300, tokens: 400_000, ttsChars: 150_000 };

export function limits(env) {
  const read = (value, fallback) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    chatRequests: read(env.DAILY_MAX_CHAT_REQUESTS, DEFAULT_LIMITS.chatRequests),
    tokens: read(env.DAILY_MAX_TOKENS, DEFAULT_LIMITS.tokens),
    ttsChars: read(env.DAILY_MAX_TTS_CHARS, DEFAULT_LIMITS.ttsChars)
  };
}

export function usageDay(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}

const EMPTY = { chatRequests: 0, promptTokens: 0, completionTokens: 0, ttsRequests: 0, ttsChars: 0 };

export async function getUsage(db, day = usageDay()) {
  const row = await db.prepare("SELECT * FROM usage_daily WHERE day = ?").bind(day).first();
  if (!row) return { ...EMPTY };
  return {
    chatRequests: row.chat_requests, promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens,
    ttsRequests: row.tts_requests, ttsChars: row.tts_chars
  };
}

// kind: "chat" | "tts". Liefert { ok } oder { ok: false, error, usage, limits }.
export async function checkBudget(env, kind, extra = 0) {
  if (!env.DB) return { ok: true, tracked: false };
  let usage;
  try { usage = await getUsage(env.DB); } catch { return { ok: true, tracked: false }; }
  const max = limits(env);
  const over = kind === "tts"
    ? usage.ttsChars + extra > max.ttsChars
    : usage.chatRequests >= max.chatRequests || usage.promptTokens + usage.completionTokens >= max.tokens;
  return over ? { ok: false, error: "daily_limit_reached", usage, limits: max } : { ok: true, tracked: true, usage, limits: max };
}

export async function addUsage(env, delta) {
  if (!env.DB) return;
  const d = { ...EMPTY, ...delta };
  try {
    await env.DB.prepare(
      "INSERT INTO usage_daily (day, chat_requests, prompt_tokens, completion_tokens, tts_requests, tts_chars) VALUES (?, ?, ?, ?, ?, ?) "
      + "ON CONFLICT(day) DO UPDATE SET chat_requests = chat_requests + excluded.chat_requests, prompt_tokens = prompt_tokens + excluded.prompt_tokens, "
      + "completion_tokens = completion_tokens + excluded.completion_tokens, tts_requests = tts_requests + excluded.tts_requests, tts_chars = tts_chars + excluded.tts_chars"
    ).bind(usageDay(), d.chatRequests, d.promptTokens, d.completionTokens, d.ttsRequests, d.ttsChars).run();
  } catch {
    // Zählfehler dürfen die Antwort nicht verhindern; der Status zeigt dann „nicht gezählt“.
  }
}

export async function handleUsageApi(request, env, headers, url) {
  if (url.pathname !== "/api/usage") return null;
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, headers);
  const auth = await authenticate(request, env, headers);
  if (auth.response) return auth.response;
  if (!env.DB) return json({ tracked: false, limits: limits(env), message: "Ohne D1 wird die Nutzung nicht gezählt. Setze Limits zusätzlich beim KI-Anbieter." }, 200, headers);
  try {
    return json({ tracked: true, day: usageDay(), usage: await getUsage(env.DB), limits: limits(env), model: env.OPENAI_MODEL || "gpt-4.1-mini" }, 200, headers);
  } catch {
    return json({ tracked: false, limits: limits(env), error: "usage_storage_unavailable", message: "Tabelle usage_daily fehlt. Migration 0003 anwenden." }, 200, headers);
  }
}
