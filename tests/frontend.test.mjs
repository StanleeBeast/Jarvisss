// Statische Prüfungen des Frontends. Ersetzen keinen Test auf einem echten iPad.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const jsFiles = readdirSync(join(root, "js")).filter(f => f.endsWith(".js"));
const modules = Object.fromEntries(jsFiles.map(f => [f, readFileSync(join(root, "js", f), "utf8")]));
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const allCode = [html, ...Object.values(modules)].join("\n");

function declaredIds() {
  const ids = [];
  for (const source of [html, ...Object.values(modules)]) {
    for (const m of source.matchAll(/\sid="([^"]+)"/g)) ids.push(m[1]);
    for (const m of source.matchAll(/\.id\s*=\s*'([^']+)'/g)) ids.push(m[1]);
  }
  return ids;
}

test("all scripts are syntactically valid", () => {
  assert.ok(inlineScripts.length >= 1);
  inlineScripts.forEach((code, i) => assert.doesNotThrow(() => new vm.Script(code, { filename: "inline-" + i + ".js" })));
  for (const [name, code] of Object.entries(modules)) assert.doesNotThrow(() => new vm.Script(code, { filename: name }), name);
});

test("static element ids in index.html are unique", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dupes)], []);
});

test("every element referenced by id is declared somewhere", () => {
  const declared = new Set(declaredIds());
  const referenced = new Set();
  for (const m of allCode.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) referenced.add(m[1]);
  for (const m of allCode.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)) referenced.add(m[1]);
  for (const m of allCode.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) referenced.add(m[1]);
  for (const m of allCode.matchAll(/\bel\('([A-Za-z0-9_-]+)'\)/g)) referenced.add(m[1]);
  const missing = [...referenced].filter(id => !declared.has(id) && !["n1Tools"].includes(id));
  assert.deepEqual(missing, []);
});

test("modules referenced by index.html exist and are cached by the service worker", () => {
  const sw = readFileSync(join(root, "sw.js"), "utf8");
  const assets = JSON.parse(sw.match(/const ASSETS=(\[[^\]]+\])/)[1].replace(/'/g, '"'));
  for (const asset of assets) assert.ok(existsSync(join(root, asset === "./" ? "index.html" : asset)), asset);
  for (const m of html.matchAll(/<script src="([^"]+)"/g)) {
    assert.ok(existsSync(join(root, m[1])), m[1]);
    assert.ok(assets.includes("./" + m[1]), m[1] + " missing from service worker cache");
  }
});

test("manifest is valid and its icons exist", () => {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.display, "standalone");
  for (const icon of manifest.icons) assert.ok(existsSync(join(root, icon.src)), icon.src);
});

test("no secrets or API keys are embedded in the public frontend", () => {
  assert.doesNotMatch(allCode, /sk-[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(allCode, /api\.openai\.com/);
});

test("design presets do not contain duplicate options", () => {
  const select = html.match(/<select id="designPreset">([\s\S]*?)<\/select>/)[1];
  const values = [...select.matchAll(/value="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(values).size, values.length);
});
