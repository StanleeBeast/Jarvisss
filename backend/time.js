// JARVIS Zeit-Hilfen: lokale Zeiten der Nutzer-Zeitzone sicher nach UTC umrechnen (inkl. Sommerzeit).
import { clip } from "./http.js";

export const DEFAULT_TIMEZONE = "Europe/Berlin";

export function safeTimezone(value) {
  const tz = clip(value, 100) || DEFAULT_TIMEZONE;
  try { new Intl.DateTimeFormat("de-DE", { timeZone: tz }); return tz; } catch { return DEFAULT_TIMEZONE; }
}
function tzOffsetMs(utcMs, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find(p => p.type === type).value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs;
}
// Wandelt eine lokale Zeit „YYYY-MM-DDTHH:MM“ in der Zeitzone des Nutzers in UTC um – inklusive Sommerzeit.
export function localToUtc(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || "").trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let utc = naive - tzOffsetMs(naive, tz);
  const corrected = naive - tzOffsetMs(utc, tz);
  if (corrected !== utc) utc = corrected;
  const check = new Date(utc);
  if (Number.isNaN(check.valueOf())) return null;
  return check.toISOString();
}
export function formatLocal(iso, tz) {
  return new Date(iso).toLocaleString("de-DE", { timeZone: tz, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

