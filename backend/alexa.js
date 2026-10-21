// JARVIS über Alexa: eigener Alexa-Skill nur für dich („Alexa, frag mein Jarvis …“).
// Der Skill ruft /api/alexa/<Schlüssel> auf. Der Schlüssel steht nur in deiner Alexa-Skill-Konfiguration (gehasht gespeichert);
// zusätzlich müssen Skill-ID und Zeitstempel passen. Alexa wartet nur ~8 Sekunden: Dauert es länger, kommt die Antwort als Push.
import { json, clip, readJsonBody, sha256Hex, sameSecret, audit } from "./http.js";
import { authenticate, actorOf } from "./auth.js";
import { notifyAll } from "./push.js";
import { checkBudget } from "./usage.js";

const KEY_SETTING = "alexa_key_hash", SKILL_SETTING = "alexa_skill_id";
const SOFT_DEADLINE_MS = 6500;

const speech = (text, end = true, reprompt) => ({
  version: "1.0",
  response: {
    outputSpeech: { type: "PlainText", text: clip(String(text).replace(/[*_#`>|]/g, "").replace(/\s+/g, " ").trim(), 7000) },
    ...(reprompt ? { reprompt: { outputSpeech: { type: "PlainText", text: reprompt } } } : {}),
    shouldEndSession: end
  }
});

export async function handleAlexaApi(request, env, headers, url, ctx, runAgent) {
  if (!url.pathname.startsWith("/api/alexa")) return null;
  if (!env.DB) return json({ error: "storage_not_configured" }, 503, headers);
  const m = url.pathname.match(/^\/api\/alexa\/(jva_[0-9a-f]{48})$/);
  // Einrichtung aus der App (normale Anmeldung)
  if (!m) {
    const auth = await authenticate(request, env, headers);
    if (auth.response) return auth.response;
    const actor = actorOf(auth.principal);
    if (url.pathname === "/api/alexa/setup" && request.method === "GET") {
      const k = await env.DB.prepare("SELECT updated_at FROM user_settings WHERE key = ?").bind(KEY_SETTING).first();
      const s = await env.DB.prepare("SELECT value FROM user_settings WHERE key = ?").bind(SKILL_SETTING).first();
      return json({ keyCreatedAt: k?.updated_at || null, skillId: s?.value || "" }, 200, headers);
    }
    if (url.pathname === "/api/alexa/setup" && request.method === "POST") {
      const body = await readJsonBody(request, 2000);
      if (body.error) return json({ error: body.error }, body.status, headers);
      const skillId = String(body.value.skillId || "").trim();
      if (!/^amzn1\.ask\.skill\.[0-9a-f-]{20,60}$/.test(skillId)) return json({ error: "invalid_skill_id" }, 400, headers);
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      const key = "jva_" + [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
      const now = new Date().toISOString();
      for (const [k, v] of [[KEY_SETTING, await sha256Hex(key)], [SKILL_SETTING, skillId]]) await env.DB.prepare("INSERT INTO user_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(k, v, now).run();
      await audit(env.DB, actor, "alexa.setup");
      return json({ endpoint: url.origin + "/api/alexa/" + key }, 201, headers);
    }
    if (url.pathname === "/api/alexa/setup" && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM user_settings WHERE key IN (?, ?)").bind(KEY_SETTING, SKILL_SETTING).run();
      await audit(env.DB, actor, "alexa.removed");
      return json({ removed: true }, 200, headers);
    }
    return json({ error: "not_found" }, 404, headers);
  }
  // Aufruf durch Alexa
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, headers);
  const stored = await env.DB.prepare("SELECT value FROM user_settings WHERE key = ?").bind(KEY_SETTING).first();
  if (!stored || !(await sameSecret(await sha256Hex(m[1]), stored.value))) return json({ error: "unauthorized" }, 401, headers);
  const body = await readJsonBody(request, 20000);
  if (body.error) return json({ error: body.error }, body.status, headers);
  const req = body.value;
  const skill = await env.DB.prepare("SELECT value FROM user_settings WHERE key = ?").bind(SKILL_SETTING).first();
  const appId = req?.context?.System?.application?.applicationId || req?.session?.application?.applicationId;
  if (!skill || appId !== skill.value) return json({ error: "wrong_skill" }, 403, headers);
  const ts = Date.parse(req?.request?.timestamp || "");
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 150000) return json({ error: "stale_request" }, 400, headers);
  const type = req.request?.type;
  if (type === "LaunchRequest") return json(speech("Hier ist Jarvis. Was kann ich für dich tun?", false, "Frag mich zum Beispiel, was heute ansteht."), 200, headers);
  if (type === "SessionEndedRequest") return json({ version: "1.0", response: {} }, 200, headers);
  if (type !== "IntentRequest") return json(speech("Das habe ich nicht verstanden."), 200, headers);
  const intent = req.request.intent?.name;
  if (intent === "AMAZON.StopIntent" || intent === "AMAZON.CancelIntent" || intent === "AMAZON.NoIntent") return json(speech("Alles klar. Bis später."), 200, headers);
  if (intent === "AMAZON.HelpIntent") return json(speech("Sag zum Beispiel: Was steht heute an? Oder: Erinnere mich morgen um sieben an Mathe. Vorschläge bestätigst du in der Jarvis-App.", false, "Was möchtest du wissen?"), 200, headers);
  // Alexa schneidet das Trägerwort ab („was steht heute an“ → „steht heute an“); je Fragewort gibt es einen Intent.
  const lead = { WasIntent: "Was", WannIntent: "Wann", WieIntent: "Wie", WerIntent: "Wer", WoIntent: "Wo", WarumIntent: "Warum", ErinnereIntent: "Erinnere mich", SchreibIntent: "Schreib", MerkIntent: "Merk dir" }[intent] || "";
  const question = clip(((lead ? lead + " " : "") + String(req.request.intent?.slots?.frage?.value || "")).trim(), 500);
  if (!question) return json(speech("Was möchtest du wissen?", false, "Frag mich einfach."), 200, headers);
  const budget = await checkBudget(env, "chat");
  if (!budget.ok) return json(speech(budget.error === "monthly_budget_reached" ? "Mein Monatsbudget ist aufgebraucht. Ab dem Ersten bin ich wieder da." : "Mein Tageslimit ist erreicht."), 200, headers);
  const work = runAgent({ messages: [{ role: "user", content: question }], timezone: "Europe/Berlin", voice: true, profile: {} }, env, { fast: true, maxRounds: 4 });
  const timeout = new Promise(res => setTimeout(() => res(null), SOFT_DEADLINE_MS));
  const result = await Promise.race([work, timeout]);
  if (result) {
    const extra = result.proposals?.length ? " Den Vorschlag bestätigst du in der Jarvis-App." : "";
    return json(speech(result.error ? "Das hat gerade nicht geklappt." : result.reply + extra), 200, headers);
  }
  // Zu langsam für Alexa: weiterarbeiten und die Antwort als Push schicken.
  ctx?.waitUntil?.(work.then(r => r?.reply && notifyAll(env, { title: "JARVIS · Antwort für Alexa", body: clip(r.reply, 220), url: "./", tag: "jarvis-alexa" })).catch(() => null));
  return json(speech("Das dauert einen Moment. Ich schicke dir die Antwort gleich aufs Handy."), 200, headers);
}
