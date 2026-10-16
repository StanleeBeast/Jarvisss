// Tests für das Lesen von WhatsApp-Exporten und die Pseudonymisierung (läuft auf dem Gerät).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deflateRawSync } from "node:zlib";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = { TextDecoder, Blob, Response, DecompressionStream, Date, Map, Number, String, Object, RegExp, Uint8Array, DataView, Error };
vm.createContext(ctx);
vm.runInContext(readFileSync(join(root, "js/whatsapp-parse.js"), "utf8"), ctx);
const W = ctx.JarvisWhatsApp;
const plain = (v) => JSON.parse(JSON.stringify(v)); // Werte aus der VM in dieses Realm kopieren

const IOS = "‎[14.10.26, 18:02:11] Fußball-Gruppe: ‎Nachrichten und Anrufe sind Ende-zu-Ende-verschlüsselt.\n"
  + "[14.10.26, 18:03:40] Mama: Kannst du morgen um 17 Uhr Oma vom Arzt abholen?\n"
  + "[14.10.26, 18:05:02] Stanley: Mal sehen\n"
  + "[15.10.26, 09:12:00] Max Mustermann: Hey Stanley, Max hier.\nRuf mich an: +49 151 2345 6789 oder max@example.org\n"
  + "[15.10.26, 09:13:00] Max Mustermann: ‎Bild weggelassen\n";
const ANDROID = "16.10.26, 07:45 - Lisa: Denk an den Jugendclub heute 18:00!\n16.10.26, 07:46 - Stanley: Klar";

test("iPhone export: timestamps, multi-line messages, system and media lines skipped", () => {
  const r = W.parseChat(IOS);
  assert.equal(r.format, "whatsapp");
  assert.equal(r.messages.length, 3);
  assert.deepEqual(plain(r.messages.map(m => m.sender)), ["Mama", "Stanley", "Max Mustermann"]);
  assert.match(r.messages[2].text, /\nRuf mich an/);
  assert.equal(r.skipped, 2);
  const at = new Date(r.messages[0].at);
  assert.equal(at.getDate(), 14); assert.equal(at.getHours(), 18); assert.equal(at.getMinutes(), 3);
});

test("Android export and pasted lines are understood", () => {
  const a = W.parseChat(ANDROID);
  assert.deepEqual(plain(a.messages.map(m => m.sender)), ["Lisa", "Stanley"]);
  const p = W.parseChat("Lisa: Hast du Zeit?\nIch: Ja, ab 16 Uhr");
  assert.equal(p.format, "lines");
  assert.equal(p.messages.length, 2);
  assert.equal(W.parseChat("Einfach ein Absatz ohne Namen").messages[0].sender, "Unbekannt");
});

test("pseudonymisation replaces names in senders, texts and rules and masks contact data", () => {
  const { messages } = W.parseChat(IOS + ANDROID);
  const r = W.pseudonymize(messages, "Stanley", "Nachrichten von Mama sind immer wichtig, Lisa auch.");
  assert.deepEqual(plain([...new Set(plain(r.messages).map(m => m.sender))]), ["Person A", "Ich", "Person B", "Person C"]);
  const max = r.messages.find(m => m.sender === "Person B").text;
  assert.doesNotMatch(max, /Max|\+49|example\.org/);
  assert.match(max, /Person B hier/);
  assert.match(max, /\[Telefonnummer\]/);
  assert.match(max, /\[E-Mail\]/);
  assert.equal(r.rules, "Nachrichten von Person A sind immer wichtig, Person C auch.");
  assert.equal(r.mapping["Person A"], "Mama");
  assert.equal(W.restoreNames("Person A bittet um Abholung", r.mapping), "Mama bittet um Abholung");
  const all = JSON.stringify(r.messages) + r.rules;
  for (const name of ["Mama", "Max", "Mustermann", "Lisa"]) assert.ok(!all.includes(name), name + " must not leave the device");
});

test("only recent messages are kept", () => {
  const now = new Date(2026, 9, 16, 12, 0).getTime();
  const { messages } = W.parseChat(IOS + ANDROID);
  assert.equal(W.filterRecent(messages, 1, 400, now).length, 2);
  assert.equal(W.filterRecent(messages, 0, 2, now).length, 2, "max count applies");
});

function zip(name, content, deflate) {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name), raw = enc.encode(content);
  const data = deflate ? deflateRawSync(raw) : raw;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(deflate ? 8 : 0, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = 30 + nameBytes.length + data.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + nameBytes.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  const buf = Buffer.concat([local, nameBytes, data, central, nameBytes, eocd]);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
}

test("WhatsApp .zip export (stored and deflated) is unpacked on the device", async () => {
  for (const deflate of [false, true]) {
    const text = await W.readZip(zip("_chat.txt", IOS, deflate));
    assert.equal(W.parseChat(text).messages.length, 3, "deflate=" + deflate);
  }
  await assert.rejects(W.readZip(new ArrayBuffer(10)), /not_a_zip/);
  await assert.rejects(W.readZip(zip("foto.jpg", "x", false)), /no_chat_in_zip/);
});
