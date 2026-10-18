// Ende-zu-Ende im Prozess: echte Home-Station-Logik gegen den echten Worker (D1 über node:sqlite),
// Postfach und SMTP sind Attrappen. Kein Netzwerkzugriff.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import worker from "../../backend/worker.js";
import { createD1 } from "../../backend/test-support/d1.js";
import { openStore } from "../src/config.js";
import { createBackend, normalizeBackend } from "../src/backend.js";
import { createStation } from "../src/station.js";
import { createUi } from "../src/ui.js";
import { protect, unprotect } from "../src/secret.js";
import { cleanText, isAddress } from "../src/mail.js";

const ORIGIN = "https://stanleebeast.github.io";
const ADMIN = "test-admin-token";
const BASE = "https://jarvisss-ai.test";

function rawMail({ from = "Frau Lehmann <lehmann@schule.de>", subject = "Facharbeit", id = "<m1@schule.de>", body = "Bitte bis morgen abgeben.\n> alte zitierte Zeile", date = new Date().toUTCString() } = {}) {
  return Buffer.from(["From: " + from, "To: ich@icloud.com", "Subject: " + subject, "Message-ID: " + id, "Date: " + date, "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n"));
}
// Attrappe eines IMAP-Postfachs mit derselben Oberfläche wie ImapFlow.
function fakeMailbox({ uidValidity = 7, messages = [], password = "app-pass-1234", acceptUser = null } = {}) {
  const box = { uidValidity, messages, appended: [], logins: [], fetches: [] };
  box.factory = (_account, pass, user) => ({
    mailbox: null,
    async connect() {
      box.logins.push(user);
      if (pass !== password || (acceptUser && user !== acceptUser)) { const e = new Error("Invalid credentials"); e.authenticationFailed = true; throw e; }
      this.mailbox = { uidValidity: box.uidValidity, uidNext: Math.max(0, ...box.messages.map(m => m.uid)) + 1 };
    },
    async getMailboxLock() { return { release() {} }; },
    async search(q) {
      if (q.uid) { const from = Number(q.uid.split(":")[0]); const hits = box.messages.filter(m => m.uid >= from).map(m => m.uid); return hits.length ? hits : [Math.max(...box.messages.map(m => m.uid))]; }
      return box.messages.filter(m => m.date >= q.since).map(m => m.uid);
    },
    async *fetch(range) {
      const uids = range.split(",").map(Number);
      box.fetches.push(uids);
      for (const m of box.messages.filter(x => uids.includes(x.uid))) yield { uid: m.uid, envelope: {}, source: m.source };
    },
    async list() { return [{ path: "INBOX", name: "INBOX" }, { path: "Sent Messages", name: "Sent Messages", specialUse: "\\Sent" }]; },
    async append(path, raw, flags) { box.appended.push({ path, raw: raw.toString(), flags }); },
    async logout() {},
    close() {}
  });
  return box;
}
function fakeSmtp() {
  const smtp = { sent: [], verified: 0, fail: null };
  smtp.factory = () => ({
    async verify() { smtp.verified++; return true; },
    async sendMail(m) { if (smtp.fail) throw smtp.fail; smtp.sent.push({ envelope: m.envelope, raw: m.raw.toString() }); return { messageId: "<x@y>" }; },
    close() {}
  });
  return smtp;
}
// Der Worker sieht nur Anfragen ohne Origin (wie von Node aus); OpenAI wird über globalThis.fetch simuliert.
function setup(extra = {}) {
  const env = { OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: ADMIN, ALLOWED_ORIGINS: ORIGIN, DB: createD1(), ...extra };
  const stationFetch = async (url, init = {}) => worker.fetch(new Request(url, init), env);
  return { env, stationFetch };
}
async function app(env, path, { method = "GET", body } = {}) {
  const headers = { Origin: ORIGIN, Authorization: "Bearer " + ADMIN };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, body: await res.json() };
}
function withModel(fn, { fail = false } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith("https://api.openai.com/"), "only the model is called: " + url);
    const req = JSON.parse(init.body);
    calls.push(req);
    if (fail) return new Response("{}", { status: 500 });
    const n = (req.messages[1].content.match(/### Mail /g) || []).length;
    const mails = Array.from({ length: n }, (_, i) => ({ index: i, importance: i === 0 ? 5 : 3, category: "schule", summary: "Zusammenfassung " + i, reason: "Test", needs_reply: i === 0, reply_draft: i === 0 ? "Mache ich." : "", suspicious: false }));
    return new Response(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 10 }, choices: [{ message: { content: JSON.stringify({ mails }) } }] }));
  };
  return Promise.resolve(fn()).then(r => ({ r, calls }), e => { throw e; }).finally(() => { globalThis.fetch = original; });
}
async function pairedStation({ env, stationFetch }, mailDeps = {}) {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-station-"));
  const store = await openStore(dir);
  store.config.backend = BASE + "/api/chat";
  const backend = createBackend(store, { fetchImpl: stationFetch });
  const code = (await app(env, "/api/auth/pair/start", { method: "POST", body: {} })).body.code;
  await backend.pair(code, "Home-Station (Laptop)");
  const logs = [];
  const station = createStation({ store, backend, log: (l) => logs.push(l), mailDeps, timers: { setTimeout: (fn) => setImmediate(fn), clearTimeout() {} } });
  return { dir, store, backend, station, logs };
}
const DAY = 86400000;
const realFetch = globalThis.fetch;

test("helpers: backend URL, secrets, text cleaning, address check", async () => {
  assert.equal(normalizeBackend("https://x.workers.dev/api/chat"), "https://x.workers.dev");
  assert.equal(normalizeBackend("http://x.workers.dev"), null);
  assert.equal(normalizeBackend("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
  const p = await protect("pässwort 123", "linux");
  assert.match(p, /^plain:/);
  assert.equal(await unprotect(p), "pässwort 123");
  assert.equal(cleanText("Hallo\n> zitiert\n\n\n\nTschüss   du"), "Hallo\n\nTschüss du");
  assert.ok(isAddress("a.b@icloud.com"));
  assert.ok(!isAddress("a@b"));
  assert.ok(!isAddress("x@y.de, z@evil.com"));
});

test("pairing, heartbeat and status; refresh key rotates and is saved", async () => {
  const ctx = setup();
  const { store, backend, station, dir } = await pairedStation(ctx);
  assert.ok(backend.paired());
  const saved = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
  assert.match(saved.session.refresh, /^(plain|dpapi):/);
  const before = saved.session.refresh;
  const hb = await station.heartbeat();
  assert.equal(hb.ok, true);
  const status = await app(ctx.env, "/api/status");
  assert.equal(status.body.components.mail.state, "connected");
  assert.match(status.body.components.mail.detail, /Home-Station \(Laptop\)/);
  // Zugangsschlüssel abgelaufen → die Station erneuert ihn selbst und speichert den neuen Geräteschlüssel.
  const later = Date.now() + 20 * 60_000;
  const realNow = Date.now;
  Date.now = () => later;
  try { assert.equal((await station.heartbeat()).ok, true); } finally { Date.now = realNow; }
  assert.notEqual(store.config.session.refresh, before);
  assert.notEqual(JSON.parse(await readFile(join(dir, "config.json"), "utf8")).session.refresh, before);
  // In der App abgemeldet → die Station merkt es und verlangt neu koppeln.
  const devices = (await app(ctx.env, "/api/auth/devices")).body.devices;
  await app(ctx.env, "/api/auth/devices/" + devices.find(d => d.name === "Home-Station (Laptop)").id + "/revoke", { method: "POST", body: {} });
  Date.now = () => later + 20 * 60_000;
  try { assert.equal(await station.heartbeat(), null); } finally { Date.now = realNow; }
  assert.equal(backend.paired(), false);
});

test("sync: first run takes the last 3 days, advances only after ingest, then only new mail", async () => {
  const ctx = setup();
  const now = Date.now();
  const messages = [
    { uid: 3, date: new Date(now - 10 * DAY), source: rawMail({ subject: "Alt", id: "<old@x>" }) },
    { uid: 8, date: new Date(now - DAY), source: rawMail({ subject: "Facharbeit", id: "<m8@x>" }) },
    { uid: 9, date: new Date(now - 3600_000), source: rawMail({ from: "Shop <news@shop.de>", subject: "Rabatt", id: "<m9@x>", body: "<b>50 %</b>" }) }
  ];
  const box = fakeMailbox({ messages, acceptUser: "ich" });
  const mailDeps = { imapFactory: box.factory };
  const { store, station } = await pairedStation(ctx, mailDeps);
  store.config.accounts.push({ id: "icloud-1a2b3c4d", provider: "icloud", address: "ich@icloud.com", label: "iCloud", password: await protect("app-pass-1234", "linux"), enabled: true });
  // KI-Fehler: nichts wird gespeichert, der Stand rückt nicht vor.
  await withModel(() => station.syncAll(), { fail: true });
  assert.equal(store.state["icloud-1a2b3c4d"].lastUid, undefined);
  assert.match(station.accountReport()[0].error, /JARVIS-Backend: model_request_failed/);
  const { calls } = await withModel(() => station.syncAll());
  assert.equal(calls.length, 1);
  assert.deepEqual(box.fetches.at(-1), [8, 9], "old mail not fetched");
  assert.equal(store.state["icloud-1a2b3c4d"].lastUid, 9);
  assert.equal(store.config.accounts[0].imapUser, "ich", "iCloud user name variant remembered");
  assert.deepEqual(box.logins.slice(0, 1), ["ich"]);
  const inbox = (await app(ctx.env, "/api/mail/inbox")).body.mails;
  assert.deepEqual(inbox.map(m => m.subject), ["Facharbeit", "Rabatt"]);
  assert.equal(inbox[0].snippet, "Bitte bis morgen abgeben.", "quoted lines removed");
  assert.equal(inbox[0].fromAddr, "lehmann@schule.de");
  // Nichts Neues → kein KI-Aufruf.
  const again = await withModel(() => station.syncAll());
  assert.equal(again.calls.length, 0);
  messages.push({ uid: 12, date: new Date(), source: rawMail({ subject: "Neu", id: "<m12@x>" }) });
  const third = await withModel(() => station.syncAll());
  assert.equal(third.calls.length, 1);
  assert.equal(store.state["icloud-1a2b3c4d"].lastUid, 12);
  // Neue UIDVALIDITY (Postfach neu aufgebaut) → wieder die letzten 3 Tage; Dubletten erkennt der Worker.
  box.uidValidity = 8;
  const fourth = await withModel(() => station.syncAll());
  assert.equal(fourth.calls.length, 0, "already known mails are not classified again");
  assert.equal(store.state["icloud-1a2b3c4d"].uidValidity, "8");
});

test("reply: sent only after confirmation in the app, threaded, stored in Sent; failures are reported", async () => {
  const ctx = setup();
  const box = fakeMailbox({ messages: [{ uid: 5, date: new Date(), source: rawMail() }] });
  const smtp = fakeSmtp();
  const mailDeps = { imapFactory: box.factory, transportFactory: smtp.factory };
  const { store, station } = await pairedStation(ctx, mailDeps);
  store.config.accounts.push({ id: "icloud-1a2b3c4d", provider: "icloud", address: "ich@icloud.com", label: "iCloud", displayName: "Stanley", password: await protect("app-pass-1234", "linux"), enabled: true });
  await withModel(() => station.syncAll());
  await station.heartbeat();
  assert.equal(await station.runJobs(), 0, "nothing to send without confirmation");
  const mail = (await app(ctx.env, "/api/mail/inbox")).body.mails[0];
  const q = await app(ctx.env, "/api/mail/" + mail.id + "/reply", { method: "POST", body: { text: "Mache ich, danke!", confirm: true } });
  assert.equal(q.status, 202);
  assert.equal(q.body.stationOnline, true);
  assert.equal(await station.runJobs(), 1);
  assert.equal(smtp.sent.length, 1);
  const sent = smtp.sent[0];
  assert.deepEqual(sent.envelope, { from: "ich@icloud.com", to: ["lehmann@schule.de"] });
  assert.match(sent.raw, /^In-Reply-To: <m1@schule.de>/m);
  assert.match(sent.raw, /^Subject: Re: Facharbeit/m);
  assert.match(sent.raw, /^From: Stanley <ich@icloud.com>/m);
  assert.match(sent.raw, /Mache ich, danke!/);
  assert.equal(box.appended[0].path, "Sent Messages");
  assert.equal((await app(ctx.env, "/api/mail/" + mail.id)).body.mail.status, "replied");
  // Fehlgeschlagener Versand wird ehrlich gemeldet.
  await app(ctx.env, "/api/mail/" + mail.id + "/status", { method: "POST", body: { status: "read" } });
  await app(ctx.env, "/api/mail/" + mail.id + "/reply", { method: "POST", body: { text: "Nochmal", confirm: true } });
  smtp.fail = Object.assign(new Error("535 5.7.8 Authentication failed"), { responseCode: 535 });
  await station.runJobs();
  assert.equal((await app(ctx.env, "/api/mail/" + mail.id)).body.mail.status, "send_failed");
  const job = ctx.env.DB.raw.prepare("SELECT result FROM station_jobs WHERE status = 'failed'").get();
  assert.match(JSON.parse(job.result).error, /Anmeldung abgelehnt/);
});

test("setup page: local only, no cross-site writes, never returns passwords", async () => {
  const ctx = setup();
  const box = fakeMailbox();
  const smtp = fakeSmtp();
  const mailDeps = { imapFactory: box.factory, transportFactory: smtp.factory };
  const { store, backend, station } = await pairedStation(ctx, mailDeps);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const ui = createUi({ store, backend, station, logs: [], port, mailDeps });
  await ui.listen();
  const url = "http://127.0.0.1:" + port;
  const post = (path, body, headers = {}) => realFetch(url + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: url, ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(url + "/")).status, 200);
    const rebound = await new Promise((resolve, reject) => httpRequest({ host: "127.0.0.1", port, path: "/api/state", headers: { Host: "evil.example:" + port } }, r => { r.resume(); resolve(r.statusCode); }).on("error", reject).end());
    assert.equal(rebound, 403, "DNS rebinding blocked");
    assert.equal((await post("/api/sync", {}, { Origin: "https://evil.example" })).status, 403, "cross-site POST blocked");
    assert.equal((await fetch(url + "/api/sync", { method: "POST", headers: { Origin: url, "Content-Type": "text/plain" }, body: "{}" })).status, 415);
    const wrong = await post("/api/accounts", { provider: "gmail", address: "ich@gmail.com", password: "falsch-falsch" });
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /Anmeldung abgelehnt/);
    assert.equal(store.config.accounts.length, 0, "failed test → nothing saved");
    const ok = await withModel(() => post("/api/accounts", { provider: "gmail", address: "Ich@Gmail.com", password: "app-pass-1234", label: "Privat" }));
    assert.equal(ok.r.status, 201);
    const state = await ok.r.json();
    assert.equal(state.accounts[0].address, "ich@gmail.com");
    assert.equal(JSON.stringify(state).includes("app-pass-1234"), false);
    assert.equal(smtp.verified, 1, "SMTP login tested");
    assert.equal(await unprotect(store.config.accounts[0].password), "app-pass-1234");
    assert.equal((await post("/api/accounts", { provider: "gmail", address: "ich@gmail.com", password: "app-pass-1234" })).status, 409);
    const del = await fetch(url + "/api/accounts/" + store.config.accounts[0].id, { method: "DELETE", headers: { Origin: url, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(del.status, 200);
    assert.equal(store.config.accounts.length, 0);
    const bad = await post("/api/backend", { url: "http://insecure.example" });
    assert.equal(bad.status, 400);
  } finally { await ui.close(); }
});
