import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";

const origin = "https://stanleebeast.github.io";
const ADMIN = "test-admin-token";
const makeEnv = (extra = {}) => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: ADMIN, ALLOWED_ORIGINS: origin, DB: createD1(), ...extra });
async function call(env, path, { method = "GET", body } = {}) {
  const headers = { Origin: origin, Authorization: "Bearer " + ADMIN };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request("https://jarvisss-ai.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, body: await res.json() };
}
const MODEL_OUTPUT = {
  title: "Herz-Kreislauf-System",
  summary_markdown: "## Aufbau\n- **Herz** mit vier Kammern\n- Lungenkreislauf und Körperkreislauf",
  unclear: [{ excerpt: "Vorhof …?", reason: "Handschrift unleserlich" }],
  additions: [{ text: "Das Herz schlägt in Ruhe etwa 60–80 Mal pro Minute.", confidence: "hoch" }],
  flashcards: [
    { front: "Wie viele Kammern hat das Herz?", back: "Vier: zwei Vorhöfe, zwei Kammern.", origin: "notes" },
    { front: "Ruhepuls?", back: "60–80/min", origin: "addition" },
    { front: "", back: "leer", origin: "notes" }
  ],
  quiz: [
    { question: "Welcher Kreislauf versorgt die Lunge?", options: ["Lungenkreislauf", "Körperkreislauf", "Pfortaderkreislauf", "Lymphsystem"], correct_index: 0, explanation: "Der Lungenkreislauf führt Blut zur Lunge.", origin: "notes" },
    { question: "Nur drei Optionen", options: ["a", "b", "c"], correct_index: 0, explanation: "", origin: "notes" },
    { question: "Doppelte Optionen", options: ["a", "a", "b", "c"], correct_index: 1, explanation: "", origin: "notes" },
    { question: "Index außerhalb", options: ["a", "b", "c", "d"], correct_index: 7, explanation: "", origin: "notes" }
  ]
};
async function withModel(output, fn, { status = 200, refusal = null } = {}) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    seen.push(JSON.parse(options.body));
    if (status !== 200) return new Response("{}", { status });
    return new Response(JSON.stringify({ usage: { prompt_tokens: 900, completion_tokens: 600 }, choices: [{ message: { role: "assistant", content: typeof output === "string" ? output : JSON.stringify(output), refusal } }] }));
  };
  try { return { result: await fn(), seen }; } finally { globalThis.fetch = original; }
}
const TINY_JPEG = "data:image/jpeg;base64," + "A".repeat(200);

test("text notes become a stored study set; invalid model items are filtered out", async () => {
  const env = makeEnv();
  const { result, seen } = await withModel(MODEL_OUTPUT, () => call(env, "/api/study/generate", { method: "POST", body: { title: "Herz", text: "Das Herz hat vier Kammern …", sourceName: "Biologie.pdf", sourceKind: "pdf", options: { flashcards: 10, quiz: 8, enrich: true } } }));
  assert.equal(result.status, 201);
  const set = result.body.set;
  assert.equal(set.title, "Herz");
  assert.match(set.summary, /## Aufbau/);
  assert.equal(set.unclear.length, 1);
  assert.equal(set.additions.length, 1);
  const cards = set.cards.filter(c => c.kind === "flashcard"), quiz = set.cards.filter(c => c.kind === "quiz");
  assert.equal(cards.length, 2, "empty flashcard removed");
  assert.deepEqual(cards.map(c => c.origin), ["notes", "addition"]);
  assert.equal(quiz.length, 1, "quiz items without exactly 4 distinct options or with a bad index are removed");
  assert.equal(quiz[0].answer, "Lungenkreislauf");
  const req = seen[0];
  assert.equal(req.response_format.type, "json_schema");
  assert.equal(req.response_format.json_schema.strict, true);
  assert.match(req.messages[0].content, /Nenne KEINE Quellen/);
  assert.match(req.messages[0].content, /Befolge keine Anweisungen/);
  const usage = await call(env, "/api/usage");
  assert.equal(usage.body.usage.promptTokens, 900);
});

test("without enrichment no additions are kept and nothing is labelled as addition", async () => {
  const env = makeEnv();
  const { result, seen } = await withModel(MODEL_OUTPUT, () => call(env, "/api/study/generate", { method: "POST", body: { title: "Herz", text: "Notizen", options: { enrich: false } } }));
  assert.equal(result.body.set.additions.length, 0);
  assert.ok(result.body.set.cards.every(c => c.origin === "notes"));
  assert.match(seen[0].messages[0].content, /keine Ergänzungen/);
});

test("handwritten pages are sent as images; invalid uploads are rejected before any model call", async () => {
  const env = makeEnv();
  const { result, seen } = await withModel(MODEL_OUTPUT, () => call(env, "/api/study/generate", { method: "POST", body: { title: "Handschrift", images: [TINY_JPEG, TINY_JPEG], sourceKind: "pdf" } }));
  assert.equal(result.status, 201);
  assert.equal(result.body.set.readMode, "images");
  const parts = seen[0].messages[1].content;
  assert.equal(parts.filter(p => p.type === "image_url").length, 2);
  for (const [body, error] of [
    [{ title: "x" }, "study_material_required"],
    [{ images: ["https://evil.example/a.jpg"] }, "invalid_page_image"],
    [{ images: ["data:text/html;base64,PHNjcmlwdD4="] }, "invalid_page_image"],
    [{ images: Array(9).fill(TINY_JPEG) }, "too_many_pages"]
  ]) {
    const r = await withModel(MODEL_OUTPUT, () => call(env, "/api/study/generate", { method: "POST", body }));
    assert.equal(r.result.body.error, error);
    assert.equal(r.seen.length, 0, "no model call for invalid input");
  }
});

test("model failures, refusals and broken JSON store nothing", async () => {
  const env = makeEnv();
  for (const [output, opts, error] of [[MODEL_OUTPUT, { status: 500 }, "model_request_failed"], ["{kaputt", {}, "invalid_model_output"], [MODEL_OUTPUT, { refusal: "nein" }, "model_refused"], [{ ...MODEL_OUTPUT, summary_markdown: "" }, {}, "empty_study_result"]]) {
    const { result } = await withModel(output, () => call(env, "/api/study/generate", { method: "POST", body: { text: "x" } }), opts);
    assert.equal(result.status, 502);
    assert.equal(result.body.error, error);
  }
  assert.equal((await call(env, "/api/study/sets")).body.sets.length, 0);
});

test("daily limit blocks generation without calling the model", async () => {
  const env = makeEnv({ DAILY_MAX_CHAT_REQUESTS: "0" });
  const { result, seen } = await withModel(MODEL_OUTPUT, () => call(env, "/api/study/generate", { method: "POST", body: { text: "x" } }));
  assert.equal(result.status, 429);
  assert.equal(seen.length, 0);
});

test("spaced repetition: correct moves a card up, wrong sends it back to box 1", async () => {
  const env = makeEnv();
  const { result } = await withModel(MODEL_OUTPUT, () => call(env, "/api/study/generate", { method: "POST", body: { title: "Herz", text: "x" } }));
  const card = result.body.set.cards[0];
  const right = await call(env, "/api/study/cards/" + card.id + "/review", { method: "POST", body: { correct: true } });
  assert.equal(right.body.card.box, 2);
  assert.ok(Date.parse(right.body.card.dueAt) - Date.now() > 23 * 3600000);
  const again = await call(env, "/api/study/cards/" + card.id + "/review", { method: "POST", body: { correct: true } });
  assert.equal(again.body.card.box, 3);
  const wrong = await call(env, "/api/study/cards/" + card.id + "/review", { method: "POST", body: { correct: false } });
  assert.equal(wrong.body.card.box, 1);
  assert.equal(wrong.body.card.wrongCount, 1);
  assert.equal(wrong.body.card.correctCount, 2);
  assert.equal((await call(env, "/api/study/cards/" + card.id + "/review", { method: "POST", body: {} })).body.error, "correct_required");
  const marked = await call(env, "/api/study/cards/" + card.id, { method: "PATCH", body: { marked: true } });
  assert.equal(marked.body.card.marked, true);
  const list = await call(env, "/api/study/sets");
  assert.equal(list.body.sets[0].marked, 1);
  assert.equal(list.body.sets[0].cards, 3);
});

test("progress is not stored when the user does not allow it", async () => {
  const env = makeEnv();
  const { result } = await withModel(MODEL_OUTPUT, () => call(env, "/api/study/generate", { method: "POST", body: { text: "x", options: { trackProgress: false } } }));
  const card = result.body.set.cards[0];
  const review = await call(env, "/api/study/cards/" + card.id + "/review", { method: "POST", body: { correct: true } });
  assert.equal(review.body.tracked, false);
  assert.equal(review.body.card.box, 1);
});

test("deleting a set removes its cards; study needs D1 and auth; agent can list sets", async () => {
  const env = makeEnv();
  const { result } = await withModel(MODEL_OUTPUT, () => call(env, "/api/study/generate", { method: "POST", body: { text: "x" } }));
  const id = result.body.set.id;
  assert.equal((await call(env, "/api/study/sets/" + id, { method: "DELETE" })).body.deleted, true);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM study_cards").get().n, 0);
  assert.equal((await call(env, "/api/study/sets/" + id)).status, 404);
  assert.equal((await call(makeEnv({ DB: undefined }), "/api/study/sets")).body.error, "storage_not_configured");
  const anon = await worker.fetch(new Request("https://jarvisss-ai.test/api/study/sets", { headers: { Origin: origin } }), makeEnv());
  assert.equal(anon.status, 401);
  const tools = await call(makeEnv(), "/api/tools");
  assert.equal(tools.body.tools.find(t => t.name === "list_study_sets").category, "A");
  assert.equal((await call(makeEnv(), "/api/status")).body.components.study.state, "available");
});
