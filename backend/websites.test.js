import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { createD1 } from "./test-support/d1.js";
import { slugify, sanitizeHtml, impressumHtml, cleanBrief } from "./websites.js";

const origin = "https://stanleebeast.github.io";
const makeEnv = (extra = {}) => ({ OPENAI_API_KEY: "k", JARVIS_ACCESS_TOKEN: "t", ALLOWED_ORIGINS: origin, OPENAI_MODEL: "gpt-4.1-mini", DB: createD1(), ...extra });
const call = (env, path, method = "GET", body) => worker.fetch(new Request("https://w.test" + path, { method, headers: { Origin: origin, Authorization: "Bearer t", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env).then(async r => ({ status: r.status, body: await r.json() }));
async function withFetch(handler, fn) { const o = globalThis.fetch; globalThis.fetch = handler; try { return await fn(); } finally { globalThis.fetch = o; } }
const PAGE = (title, extra = "") => "<!doctype html><html lang=\"de\"><head><title>" + title + "</title>" + extra + "</head><body><h1>" + title + "</h1><a href=\"impressum.html\">Impressum</a></body></html>";
const designer = (title, extra) => async (u, o) => {
  const b = JSON.parse(o.body);
  assert.equal(b.response_format.json_schema.name, "website");
  return Response.json({ model: "gpt-5-mini", usage: { prompt_tokens: 2000, completion_tokens: 6000 }, choices: [{ message: { content: JSON.stringify({ html: PAGE(title, extra), theme: { primary: "#c0392b", background: "#fffaf5", text: "#222222" } }) } }] });
};
const brief = { name: "Friseur Schmidt", kind: "Friseur", city: "Kamenz", description: "Damen- und Herrenschnitte, Färben, Termine nach Absprache.", style: "warm", contact: { owner: "Anna Schmidt", phone: "03578 123456" } };

test("names become safe folder names; briefs are cleaned", () => {
  assert.equal(slugify("Bäckerei Müller & Söhne"), "baeckerei-mueller-soehne");
  assert.equal(slugify("!!!"), "website");
  assert.equal(cleanBrief({ name: "X", contact: { email: "kein-mail", phone: "1" } }).contact.email, undefined);
});

test("generated pages may not load anything from other servers", () => {
  const h = sanitizeHtml(PAGE("A", "<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=Inter\"><script src=\"https://tracker.example/t.js\"></script><style>@import url('https://fonts.googleapis.com/x');</style><iframe src=\"https://maps.google.com\"></iframe>"));
  assert.ok(h);
  assert.equal(/googleapis|tracker\.example|<iframe/.test(h), false);
  assert.equal(sanitizeHtml("<p>kein Dokument</p>"), null);
});

test("legal pages come from templates with visible placeholders for missing details", () => {
  const html = impressumHtml(cleanBrief(brief), { primary: "#c0392b" });
  assert.match(html, /Anna Schmidt/);
  assert.match(html, /\[BITTE ERGÄNZEN: Straße und Hausnummer\]/);
  assert.match(html, /§ 5 DDG/);
  assert.equal(impressumHtml(cleanBrief({ ...brief, name: "<script>x</script>" })).includes("<script>x"), false, "escaped");
});

test("create, view, change, undo, fill in details and delete a website draft", async () => {
  const env = makeEnv();
  const created = await withFetch(designer("Friseur Schmidt"), () => call(env, "/api/websites", "POST", brief));
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.missing, ["street", "zip_city", "email"]);
  const id = created.body.website.id;
  const one = await call(env, "/api/websites/" + id);
  assert.deepEqual(Object.keys(one.body.website.files).sort(), ["datenschutz.html", "impressum.html", "index.html"]);
  assert.match(one.body.website.files["datenschutz.html"], /Cloudflare/);
  const changed = await withFetch(designer("Friseur Schmidt – jetzt in Blau"), () => call(env, "/api/websites/" + id + "/revise", "POST", { instructions: "Mach es blau" }));
  assert.equal(changed.body.website.version, 2);
  assert.match((await call(env, "/api/websites/" + id)).body.website.files["index.html"], /jetzt in Blau/);
  assert.equal((await call(env, "/api/websites/" + id + "/undo", "POST", {})).body.saved, true);
  assert.doesNotMatch((await call(env, "/api/websites/" + id)).body.website.files["index.html"], /jetzt in Blau/);
  const filled = await call(env, "/api/websites/" + id + "/business", "PUT", { contact: { street: "Markt 1", zip_city: "01917 Kamenz", email: "info@friseur-schmidt.de" } });
  assert.deepEqual(filled.body.missing, []);
  assert.match((await call(env, "/api/websites/" + id)).body.website.files["impressum.html"], /Markt 1/);
  assert.equal((await call(env, "/api/websites/" + id, "DELETE", {})).body.error, "confirmation_required");
  assert.equal((await call(env, "/api/websites/" + id, "DELETE", { confirm: true })).body.deleted, true);
  assert.equal((await call(env, "/api/websites")).body.websites.length, 0);
});

test("publishing needs confirmation, complete legal details (or explicit OK), and goes through GitHub", async () => {
  const env = makeEnv({ GITHUB_TOKEN_JARVIS: "ghp_test" });
  const id = (await withFetch(designer("Friseur Schmidt"), () => call(env, "/api/websites", "POST", brief))).body.website.id;
  assert.equal((await call(env, "/api/websites/" + id + "/publish", "POST", {})).body.error, "confirmation_required");
  assert.equal((await call(env, "/api/websites/" + id + "/publish", "POST", { confirm: true })).body.error, "legal_details_missing");
  const seen = [];
  const github = async (u, o = {}) => {
    const path = String(u).replace("https://api.github.com/repos/StanleeBeast/Jarvisss", ""), method = o.method || "GET";
    seen.push(method + " " + path + (o.body && /dispatches|trees/.test(path) ? " " + o.body : ""));
    if (path === "/git/ref/heads/jarvis-sites") return Response.json({ message: "Not Found" }, { status: 404 });
    if (path === "/git/ref/heads/main") return Response.json({ object: { sha: "main1" } });
    if (path === "/git/refs" && method === "POST") return Response.json({ object: { sha: "main1" } }, { status: 201 });
    if (path === "/git/blobs") return Response.json({ sha: "blob" + seen.length }, { status: 201 });
    if (path === "/git/commits/main1") return Response.json({ tree: { sha: "tree0" } });
    if (path === "/git/trees") return Response.json({ sha: "tree1" }, { status: 201 });
    if (path === "/git/commits" && method === "POST") return Response.json({ sha: "c1" }, { status: 201 });
    if (path === "/git/refs/heads/jarvis-sites" && method === "PATCH") return Response.json({ object: { sha: "c1" } });
    if (path.endsWith("/dispatches")) return new Response(null, { status: 204 });
    if (path.startsWith("/actions/workflows/publish-site.yml/runs")) return Response.json({ workflow_runs: [{ display_title: "Website friseur-schmidt veröffentlichen", status: "completed", conclusion: "success", html_url: "https://github.com/run/1" }] });
    throw new Error("unexpected " + method + " " + path);
  };
  const r = await withFetch(github, () => call(env, "/api/websites/" + id + "/publish", "POST", { confirm: true, allowPlaceholders: true }));
  assert.equal(r.status, 202);
  assert.equal(r.body.url, "https://jarvis-friseur-schmidt.pages.dev");
  assert.ok(seen.some(s => s.startsWith("POST /git/refs")), "branch created");
  assert.equal(seen.filter(s => s.startsWith("POST /git/blobs")).length, 3);
  assert.ok(seen.some(s => s.includes("sites/friseur-schmidt/impressum.html")));
  assert.ok(seen.some(s => s.includes("/dispatches") && s.includes("\"project\":\"jarvis-friseur-schmidt\"")));
  const st = await withFetch(github, () => call(env, "/api/websites/" + id + "/publish-status"));
  assert.equal(st.body.state, "live");
  assert.equal((await call(env, "/api/websites")).body.websites[0].status, "live");
});

test("the agent builds a draft and the answer carries a link to it", async () => {
  const env = makeEnv();
  let round = 0;
  const handler = async (u, o) => {
    const b = JSON.parse(o.body);
    if (b.response_format?.json_schema?.name === "website") return designer("Friseur Schmidt")(u, o);
    round++;
    if (round === 1) return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "w1", type: "function", function: { name: "build_website", arguments: JSON.stringify({ ...brief, contact: { owner: "", street: "", zip_city: "", phone: "", email: "", opening_hours: "" } }) } }] } }] });
    return Response.json({ choices: [{ message: { role: "assistant", content: "Der Entwurf ist fertig." } }] });
  };
  const r = await withFetch(handler, () => call(env, "/api/chat", "POST", { messages: [{ role: "user", content: "Bau eine Website für Friseur Schmidt" }] }));
  assert.equal(r.body.reply, "Der Entwurf ist fertig.");
  assert.equal(r.body.websites[0].name, "Friseur Schmidt");
  assert.equal(r.body.websites[0].slug, "friseur-schmidt");
});
