// Postfächer: neue Mails per IMAP lesen (ohne sie als gelesen zu markieren) und bestätigte Antworten per SMTP senden.
// Zugangsdaten: app-spezifische Passwörter (Gmail: App-Passwort mit 2-Faktor; iCloud: app-spezifisches Passwort).
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";

export const PROVIDERS = {
  gmail: {
    label: "Gmail",
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    savesSent: true, // Gmail legt per SMTP gesendete Mails selbst unter „Gesendet“ ab
    users: (address) => [address]
  },
  icloud: {
    label: "iCloud Mail",
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false, requireTLS: true },
    savesSent: false,
    // Apple: IMAP-Benutzername ist meist der Teil vor dem @, manchmal die ganze Adresse.
    users: (address) => [address.split("@")[0], address]
  }
};

const FIRST_SYNC_DAYS = 3, FIRST_SYNC_MAX = 30, RUN_MAX = 60, BATCH = 10, MAX_TEXT = 4000, MAX_SOURCE = 256 * 1024;
export const isAddress = (v) => typeof v === "string" && /^[^\s@<>()",;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(v);

export function defaultImapFactory(account, password, user) {
  const p = PROVIDERS[account.provider];
  return new ImapFlow({ ...p.imap, auth: { user, pass: password }, logger: false, emitLogs: false, socketTimeout: 60_000 });
}
export function defaultTransportFactory(account, password) {
  const p = PROVIDERS[account.provider];
  return nodemailer.createTransport({ ...p.smtp, auth: { user: account.address, pass: password }, connectionTimeout: 20_000, socketTimeout: 60_000 });
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}
export function cleanText(text) {
  return String(text || "")
    .split("\n")
    .filter(line => !/^\s*>/.test(line)) // zitierte ältere Nachrichten weglassen
    .join("\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT);
}

export async function toIngest(msg) {
  const parsed = msg.source ? await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true }) : {};
  const from = parsed.from?.value?.[0] || msg.envelope?.from?.[0] || {};
  const date = parsed.date || msg.envelope?.date || msg.internalDate || new Date();
  return {
    uid: msg.uid,
    messageId: parsed.messageId || msg.envelope?.messageId || "",
    fromName: from.name || "",
    fromAddr: from.address || "",
    to: (parsed.to?.text || "").slice(0, 300),
    subject: parsed.subject || msg.envelope?.subject || "(ohne Betreff)",
    date: new Date(date).toISOString(),
    text: cleanText(parsed.text || stripHtml(parsed.html))
  };
}

// Meldet sich am Postfach an. Bei iCloud werden beide üblichen Benutzernamen probiert; der passende wird gemerkt.
export async function connectImap(account, password, imapFactory = defaultImapFactory) {
  const p = PROVIDERS[account.provider];
  if (!p) throw new Error("unknown_provider");
  const candidates = account.imapUser ? [account.imapUser] : p.users(account.address);
  let lastError;
  for (const user of candidates) {
    const client = imapFactory(account, password, user);
    try {
      await client.connect();
      return { client, user };
    } catch (e) {
      lastError = e;
      try { client.close?.(); } catch { /* ignorieren */ }
    }
  }
  throw lastError || new Error("imap_login_failed");
}

export function describeError(e) {
  const text = String(e?.responseText || e?.response || e?.message || e || "");
  if (e?.authenticationFailed || /auth|credential|password|535|534|invalid login/i.test(text)) return "Anmeldung abgelehnt – Adresse oder app-spezifisches Passwort prüfen.";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket|timeout/i.test(text)) return "Mailserver nicht erreichbar – Internet/WLAN prüfen.";
  return text.slice(0, 160) || "Unbekannter Fehler";
}

// Holt neue Mails aus dem Posteingang und gibt sie stapelweise an den Worker.
// Der Stand (lastUid) rückt erst vor, wenn der Worker den Stapel angenommen hat – nichts geht verloren.
export async function syncAccount({ account, password, state, saveState, ingest, imapFactory = defaultImapFactory, now = Date.now() }) {
  const { client, user } = await connectImap(account, password, imapFactory);
  let fetched = 0, stored = 0;
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uidValidity = String(client.mailbox?.uidValidity ?? "");
      const known = state.uidValidity === uidValidity ? Number(state.lastUid) || 0 : 0;
      let uids = known
        ? await client.search({ uid: (known + 1) + ":*" }, { uid: true })
        : await client.search({ since: new Date(now - FIRST_SYNC_DAYS * 86400000) }, { uid: true });
      uids = [...new Set((uids || []).map(Number))].filter(u => u > known).sort((a, b) => a - b);
      if (!known) uids = uids.slice(-FIRST_SYNC_MAX);
      uids = uids.slice(0, RUN_MAX);
      if (!known && !uids.length) {
        // Erster Lauf ohne neue Mails: ab der aktuell höchsten UID weiterzählen.
        state.uidValidity = uidValidity;
        state.lastUid = Math.max(0, Number(client.mailbox?.uidNext || 1) - 1);
        await saveState();
      }
      let cursor = known;
      for (let i = 0; i < uids.length; i += BATCH) {
        const chunk = uids.slice(i, i + BATCH);
        const messages = [];
        for await (const msg of client.fetch(chunk.join(","), { uid: true, envelope: true, internalDate: true, source: { start: 0, maxLength: MAX_SOURCE } }, { uid: true })) {
          try { messages.push(await toIngest(msg)); } catch { messages.push({ uid: msg.uid, subject: msg.envelope?.subject || "(nicht lesbar)", fromAddr: msg.envelope?.from?.[0]?.address || "", date: new Date().toISOString(), text: "" }); }
        }
        fetched += messages.length;
        const result = await ingest(messages);
        stored += result.stored || 0;
        cursor = Math.max(cursor, ...chunk);
        state.uidValidity = uidValidity;
        state.lastUid = cursor;
        await saveState();
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => null);
  }
  return { fetched, stored, user };
}

// Prüft IMAP- und SMTP-Anmeldung, bevor ein Postfach gespeichert wird.
export async function testAccount(account, password, { imapFactory = defaultImapFactory, transportFactory = defaultTransportFactory } = {}) {
  const { client, user } = await connectImap(account, password, imapFactory);
  await client.logout().catch(() => null);
  const transport = transportFactory(account, password);
  try { await transport.verify(); } finally { transport.close?.(); }
  return { imapUser: user };
}

// Sendet eine vom Nutzer bestätigte Antwort. Bei iCloud wird die Mail zusätzlich unter „Gesendet“ abgelegt.
export async function sendReply({ account, password, job, transportFactory = defaultTransportFactory, imapFactory = defaultImapFactory }) {
  const p = job.payload || {};
  if (job.type !== "send_reply") throw new Error("unknown_job_type");
  if (!isAddress(p.to)) throw new Error("invalid_recipient");
  const text = String(p.text || "").trim();
  if (!text) throw new Error("empty_text");
  const mail = {
    from: account.displayName ? { name: account.displayName, address: account.address } : account.address,
    to: p.toName ? { name: p.toName, address: p.to } : p.to,
    subject: String(p.subject || "").slice(0, 300) || "Re:",
    text,
    inReplyTo: p.inReplyTo || undefined,
    references: p.inReplyTo || undefined
  };
  const raw = await new MailComposer(mail).compile().build();
  const transport = transportFactory(account, password);
  let info;
  try { info = await transport.sendMail({ envelope: { from: account.address, to: [p.to] }, raw }); }
  finally { transport.close?.(); }
  let savedToSent = PROVIDERS[account.provider]?.savesSent || false;
  if (!savedToSent) {
    try {
      const { client } = await connectImap(account, password, imapFactory);
      try {
        const boxes = await client.list();
        const sent = boxes.find(b => b.specialUse === "\\Sent") || boxes.find(b => /^(sent|sent messages|gesendet)/i.test(b.name));
        if (sent) { await client.append(sent.path, raw, ["\\Seen"]); savedToSent = true; }
      } finally { await client.logout().catch(() => null); }
    } catch { /* Versand war erfolgreich; nur die Ablage unter „Gesendet“ fehlt */ }
  }
  const messageId = (raw.toString("utf8").match(/^Message-ID:\s*(<[^>]+>)/im) || [])[1] || info?.messageId || null;
  return { messageId, savedToSent };
}
