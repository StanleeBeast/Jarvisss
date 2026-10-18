import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";
import { parseIcs, expandEvents, normalizeCalendarUrl, eventsOnDay } from "./calendar.js";

const origin = "https://stanleebeast.github.io";
const ADMIN = "test-admin-token";
const makeEnv = (extra = {}) => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: ADMIN, ALLOWED_ORIGINS: origin, DB: createD1(), ...extra });
async function call(env, path, { method = "GET", body } = {}) {
  const headers = { Origin: origin, Authorization: "Bearer " + ADMIN };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request("https://jarvisss-ai.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, body: await res.json() };
}
const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple Inc.//iCloud//DE",
  "BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "DTSTART:19810329T020000", "END:DAYLIGHT", "END:VTIMEZONE",
  "BEGIN:VEVENT", "UID:zahnarzt", "SUMMARY:Zahnarzt\\, Kontrolle", "LOCATION:Kamenz", "DTSTART;TZID=Europe/Berlin:20261020T143000", "DTEND;TZID=Europe/Berlin:20261020T151500",
  "BEGIN:VALARM", "TRIGGER:-PT15M", "SUMMARY:Erinnerung soll nicht der Titel sein", "END:VALARM", "END:VEVENT",
  "BEGIN:VEVENT", "UID:training", "SUMMARY:Training", "DTSTART;TZID=Europe/Berlin:20261013T180000", "DTEND;TZID=Europe/Berlin:20261013T193000",
  "RRULE:FREQ=WEEKLY;BYDAY=TU,TH", "EXDATE;TZID=Europe/Berlin:20261022T180000", "END:VEVENT",
  "BEGIN:VEVENT", "UID:training", "RECURRENCE-ID;TZID=Europe/Berlin:20261027T180000", "SUMMARY:Training (verschoben)", "DTSTART;TZID=Europe/Berlin:20261027T170000", "DTEND;TZID=Europe/Berlin:20261027T183000", "END:VEVENT",
  "BEGIN:VEVENT", "UID:geb", "SUMMARY:Geburtstag Oma", "DTSTART;VALUE=DATE:20261021", "DTEND;VALUE=DATE:20261022", "RRULE:FREQ=YEARLY", "END:VEVENT",
  "BEGIN:VEVENT", "UID:utc", "SUMMARY:Online-Meeting", "DTSTART:20261021T080000Z", "DURATION:PT45M", "END:VEVENT",
  "BEGIN:VEVENT", "UID:abgesagt", "SUMMARY:Abgesagt", "STATUS:CANCELLED", "DTSTART:20261021T100000Z", "END:VEVENT",
  "BEGIN:VEVENT", "UID:lang", "SUMMARY:Ein sehr langer Titel, der", " umgebrochen wurde", "DTSTART:20261023T090000Z", "DTEND:20261023T100000Z", "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n");
const FROM = Date.parse("2026-10-16T00:00:00Z"), TO = Date.parse("2026-11-05T00:00:00Z");
const expand = () => expandEvents(parseIcs(ICS).events, FROM, TO);

test("ICS: local times with TZID, UTC, all-day, folding, escaping, alarms and cancelled events", () => {
  const all = expand();
  const zahn = all.find(e => e.uid === "zahnarzt");
  assert.equal(zahn.title, "Zahnarzt, Kontrolle");
  assert.equal(zahn.location, "Kamenz");
  assert.equal(zahn.start, "2026-10-20T12:30:00.000Z", "14:30 Berlin (summer time) = 12:30 UTC");
  assert.equal(zahn.end, "2026-10-20T13:15:00.000Z");
  const meet = all.find(e => e.uid === "utc");
  assert.equal(meet.end, "2026-10-21T08:45:00.000Z", "DURATION");
  const geb = all.find(e => e.uid === "geb");
  assert.equal(geb.allDay, true);
  assert.equal(geb.date, "2026-10-21");
  assert.ok(!all.some(e => e.title === "Abgesagt"));
  assert.equal(all.find(e => e.uid === "lang").title, "Ein sehr langer Titel, derumgebrochen wurde");
  assert.equal(parseIcs("kein Kalender").error, "not_a_calendar");
});

test("ICS: weekly series with BYDAY, EXDATE, moved single instance and DST change", () => {
  const training = expand().filter(e => e.uid === "training");
  const starts = training.map(e => e.start);
  // Di 20.10. und Do 22.10. (ausgenommen), Di 27.10. verschoben, Do 29.10. nach Zeitumstellung (18:00 MEZ = 17:00 UTC)
  assert.ok(starts.includes("2026-10-20T16:00:00.000Z"));
  assert.ok(!starts.includes("2026-10-22T16:00:00.000Z"), "EXDATE removed");
  assert.ok(!starts.includes("2026-10-27T17:00:00.000Z"), "original instance replaced by the moved one");
  const moved = training.find(e => e.title === "Training (verschoben)");
  assert.equal(moved.start, "2026-10-27T16:00:00.000Z", "17:00 local after DST end = 16:00 UTC");
  assert.ok(starts.includes("2026-10-29T17:00:00.000Z"), "18:00 local in winter time");
  assert.ok(training.every(e => e.start >= "2026-10-16"), "only inside the window");
});

test("ICS: monthly and daily rules with COUNT and UNTIL", () => {
  const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:m", "SUMMARY:Monatlich", "DTSTART:20260131T100000Z", "RRULE:FREQ=MONTHLY;COUNT=12", "END:VEVENT",
    "BEGIN:VEVENT", "UID:d", "SUMMARY:Täglich", "DTSTART;TZID=Europe/Berlin:20261017T070000", "RRULE:FREQ=DAILY;UNTIL=20261019T235959Z", "END:VEVENT", "END:VCALENDAR"].join("\n");
  const ev = expandEvents(parseIcs(ics).events, FROM, TO);
  const monthly = ev.filter(e => e.uid === "m").map(e => e.start.slice(0, 10));
  assert.deepEqual(monthly, ["2026-10-31"], "31st only in months that have it");
  assert.equal(ev.filter(e => e.uid === "d").length, 3);
});

test("only subscription links from known calendar services are accepted", () => {
  assert.equal(normalizeCalendarUrl("webcal://p42-caldav.icloud.com/published/2/abc").url, "https://p42-caldav.icloud.com/published/2/abc");
  assert.ok(normalizeCalendarUrl("https://calendar.google.com/calendar/ical/x/basic.ics").url);
  for (const bad of ["http://p42-caldav.icloud.com/x", "https://evil.example/x.ics", "https://169.254.169.254/", "https://user:pw@p1-caldav.icloud.com/x", "javascript:alert(1)", ""]) {
    assert.ok(normalizeCalendarUrl(bad).error, bad);
  }
});

async function withIcs(fn, { status = 200, body = ICS, finalUrl } = {}) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const res = new Response(body, { status });
    if (finalUrl) Object.defineProperty(res, "url", { value: finalUrl });
    return res;
  };
  try { return { result: await fn(), seen }; } finally { globalThis.fetch = original; }
}

test("API: connect tests the link first, stores it masked, caches events, disconnect removes everything", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "/api/calendar/settings")).body.configured, false);
  assert.equal((await call(env, "/api/status")).body.components.calendar.state, "not_configured");
  assert.equal((await call(env, "/api/calendar/settings", { method: "PUT", body: { url: "https://evil.example/a.ics" } })).body.error, "calendar_host_not_allowed");
  const broken = await withIcs(() => call(env, "/api/calendar/settings", { method: "PUT", body: { url: "webcal://p42-caldav.icloud.com/published/2/geheim123" } }), { body: "<html>" });
  assert.equal(broken.result.body.error, "not_a_calendar");
  assert.equal((await call(env, "/api/calendar/settings")).body.configured, false, "nothing stored after a failed test");
  const ok = await withIcs(() => call(env, "/api/calendar/settings", { method: "PUT", body: { url: "webcal://p42-caldav.icloud.com/published/2/geheim123" } }));
  assert.equal(ok.result.body.saved, true);
  assert.ok(ok.seen[0].startsWith("https://p42-caldav.icloud.com/"));
  const settings = await call(env, "/api/calendar/settings");
  assert.equal(settings.body.configured, true);
  assert.ok(!JSON.stringify(settings.body).includes("geheim123"), "link is never sent back in full");
  // Zweiter Abruf innerhalb von 15 Minuten kommt aus dem Zwischenspeicher
  const cached = await withIcs(() => call(env, "/api/calendar/events?days=62"));
  assert.equal(cached.seen.length, 0);
  assert.equal(cached.result.body.cached, true);
  // Umleitung auf fremde Adresse wird abgelehnt, alte Termine bleiben sichtbar
  const redirected = await withIcs(() => call(env, "/api/calendar/events?refresh=1&days=62"), { finalUrl: "https://evil.example/x" });
  assert.equal(redirected.result.body.error, "calendar_host_not_allowed");
  assert.equal(redirected.result.body.stale, true);
  assert.equal((await call(env, "/api/status")).body.components.calendar.state, "error");
  const audit = env.DB.raw.prepare("SELECT action, target FROM audit_log WHERE action LIKE 'calendar.%'").all();
  assert.equal(audit[0].action, "calendar.connect");
  assert.ok(!audit[0].target.includes("geheim123"));
  assert.equal((await call(env, "/api/calendar/settings", { method: "DELETE" })).body.deleted, true);
  assert.equal((await call(env, "/api/calendar/settings")).body.configured, false);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM calendar_cache").get().n, 0);
  const anon = await worker.fetch(new Request("https://jarvisss-ai.test/api/calendar/events", { headers: { Origin: origin } }), env);
  assert.equal(anon.status, 401);
});

test("day plan uses calendar events as fixed blocks and all-day events as hints", async () => {
  const env = makeEnv();
  await withIcs(() => call(env, "/api/calendar/settings", { method: "PUT", body: { url: "https://p42-caldav.icloud.com/published/2/x" } }));
  // Zeitfenster und Tag so wählen, dass sie im Abrufzeitraum liegen: die Termine sind fest im Oktober 2026,
  // der Test prüft die Zuordnung direkt über eventsOnDay und den Planer.
  const events = expand();
  const day = eventsOnDay(events, "2026-10-21", "Europe/Berlin");
  assert.deepEqual(day.map(e => e.uid).sort(), ["geb", "utc"]);
  const { buildDayPlan } = await import("./planner.js");
  const plan = buildDayPlan({ date: "2026-10-21", timezone: "Europe/Berlin", prefs: { wake: "07:00", sleep: "22:00", focusMinutes: 90, breakMinutes: 15, minFreeMinutes: 60, taskMinutes: { high: 45, normal: 30, low: 20 }, fixed: [] }, calendar: { events: day }, nowMs: Date.parse("2026-10-20T20:00:00Z") });
  const meet = plan.blocks.find(b => b.kind === "calendar");
  assert.equal(meet.title, "Online-Meeting");
  assert.equal(meet.startTime, "10:00", "08:00 UTC = 10:00 Berlin");
  assert.equal(meet.fixed, true);
  assert.deepEqual(plan.allDay, [{ title: "Geburtstag Oma", location: "" }]);
  assert.equal(plan.calendar, "read_only");
});

test("agent can read calendar events but never change them", async () => {
  const env = makeEnv();
  const step = (name, args) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
  const answer = { choices: [{ message: { role: "assistant", content: "Ok." } }] };
  const script = [step("get_calendar_events", { days: 7 }), answer];
  let i = 0; const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("api.openai.com")) { seen.push(JSON.parse(options.body)); return new Response(JSON.stringify(script[Math.min(i++, 1)])); }
    return new Response(ICS);
  };
  try {
    const r = await call(env, "/api/chat", { method: "POST", body: { messages: [{ role: "user", content: "Was steht im Kalender?" }], timezone: "Europe/Berlin" } });
    assert.equal(r.status, 200);
    const out = JSON.parse(seen[1].messages.at(-1).content);
    assert.equal(out.configured, false, "without a connected calendar the tool says so");
    const tools = seen[0].tools.map(t => t.function.name);
    assert.ok(tools.includes("get_calendar_events"));
    assert.ok(!tools.some(n => /calendar/.test(n) && n !== "get_calendar_events"), "no writing calendar tool exists");
    assert.match(seen[0].messages[0].content, /nur lesend/);
  } finally { globalThis.fetch = original; }
});
