import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
globalThis.document ??= { getElementById: () => null };
await import("../js/stream.js");
const sse = (events, split = 7) => {
  const text = events.map(e => "data: " + JSON.stringify(e) + "\n\n").join("") + ": ping\n\n";
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < text.length; i += split) c.enqueue(enc.encode(text.slice(i, i + split))); c.close(); } }));
};

test("live answer: deltas, reset, tool, sources and done are read across chunk borders", async () => {
  const said = [];
  window.JarvisSpeech = { streamStart() {}, streamPush: (t) => said.push(t), streamReset: () => said.push("|reset|"), streamEnd: (t) => said.push("|end:" + t), streamCancel: () => said.push("|cancel|") };
  const r = await window.JarvisStream.read(sse([
    { type: "delta", text: "Moment. " }, { type: "reset" }, { type: "tool", label: "Suche im Internet: DAX" },
    { type: "sources", sources: [{ url: "https://a.de/x", title: "A" }, { url: "https://a.de/x", title: "doppelt" }] },
    { type: "delta", text: "Der DAX " }, { type: "delta", text: "steigt." }, { type: "done", reply: "Der DAX steigt." }
  ]));
  assert.equal(r.type, "done");
  assert.equal(r.reply, "Der DAX steigt.");
  assert.deepEqual(window.JarvisStream.sources(), [{ url: "https://a.de/x", title: "A" }]);
  assert.deepEqual(said, ["Moment. ", "|reset|", "Der DAX ", "steigt.", "|end:Der DAX steigt."]);
});

test("a stream without done ends as an honest error and stops live speech", async () => {
  const said = [];
  window.JarvisSpeech = { streamStart() {}, streamPush: (t) => said.push(t), streamCancel: () => said.push("|cancel|") };
  const r = await window.JarvisStream.read(sse([{ type: "delta", text: "Halb" }]));
  assert.deepEqual(r, { type: "error", error: "stream_interrupted" });
  assert.equal(said.at(-1), "|cancel|");
  const e = await window.JarvisStream.read(sse([{ type: "error", error: "model_timeout" }]));
  assert.equal(e.error, "model_timeout");
});
