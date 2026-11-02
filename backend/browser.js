// JARVIS zeigt Websites: Cloudflare Browser Rendering öffnet die Seite in einem echten Browser,
// macht einen Screenshot (für den Nutzer) und liest den Text (für die KI, damit sie Schritt für Schritt erklären kann).
// JARVIS klickt nicht selbst, meldet sich nirgends an und gibt nichts ein – er zeigt und erklärt.
// Kostenlos: 10 Minuten Browser-Zeit pro Tag im Workers-Free-Tarif. Eigener Schlüssel nur mit „Browser Rendering“-Recht.
import { clip } from "./http.js";

const DEVICES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
export const browserConfigured = (env) => Boolean(env.BROWSER_TOKEN && env.CF_ACCOUNT_ID);

// Nur öffentliche Webadressen – keine internen Netze, keine Zugangsdaten in der Adresse.
export function safeUrl(raw) {
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(String(raw || "").trim()) ? String(raw).trim() : "https://" + String(raw || "").trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h.includes(".") || /^(localhost|.*\.local|.*\.internal|.*\.lan)$/.test(h)) return null;
  if (/^(0|10|127)\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || h.includes(":")) return null;
  if (u.port && !["80", "443"].includes(u.port)) return null;
  return u;
}

function api(env, path, body, signal) {
  return fetch("https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(env.CF_ACCOUNT_ID) + "/browser-rendering/" + path, {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.BROWSER_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
}
const failure = (status) => status === 429 ? "browser_limit_reached" : status === 401 || status === 403 ? "browser_token_invalid" : "browser_unavailable";

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function viewWebsite(env, { url, device }) {
  if (!browserConfigured(env)) return { error: "browser_not_configured" };
  const u = safeUrl(url);
  if (!u) return { error: "invalid_url" };
  const view = DEVICES[device] || DEVICES.phone;
  const signal = AbortSignal.timeout(40000);
  const goto = { waitUntil: "networkidle2", timeout: 25000 };
  const [shot, md] = await Promise.allSettled([
    api(env, "screenshot", { url: u.href, viewport: view, gotoOptions: goto, screenshotOptions: { type: "jpeg", quality: 60 } }, signal),
    api(env, "markdown", { url: u.href, gotoOptions: goto }, signal)
  ]);
  let image = null, text = "", error = null;
  if (shot.status === "fulfilled" && shot.value.ok && /^image\//.test(shot.value.headers.get("Content-Type") || "")) {
    const buf = await shot.value.arrayBuffer();
    if (buf.byteLength && buf.byteLength < 1_500_000) image = "data:" + (shot.value.headers.get("Content-Type").split(";")[0]) + ";base64," + toBase64(buf);
  } else if (shot.status === "fulfilled") error = failure(shot.value.status);
  if (md.status === "fulfilled" && md.value.ok) {
    const data = await md.value.json().catch(() => ({}));
    if (typeof data.result === "string") text = data.result;
  } else if (!error && md.status === "fulfilled") error = failure(md.value.status);
  if (!image && !text) return { error: error || "browser_unavailable" };
  const title = (text.match(/^#\s+(.+)$/m) || [])[1] || u.hostname;
  return { url: u.href, host: u.hostname.replace(/^www\./, ""), device: DEVICES[device] ? device : "phone", title: clip(title, 120), image, text: clip(text, 6000) };
}
