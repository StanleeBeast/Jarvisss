import test from "node:test";
import assert from "node:assert/strict";
import { getNews, rssItems, NEWS_SOURCES } from "./news.js";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const rss = (items) => "<?xml version=\"1.0\"?><rss version=\"2.0\"><channel>" + items.map(([t, d, extra = ""]) => "<item><title><![CDATA[" + t + "]]></title><link>https://example.org/" + encodeURIComponent(t) + "</link><pubDate>" + new Date(d).toUTCString() + "</pubDate>" + extra + "</item>").join("") + "</channel></rss>";

test("parses RSS and Atom, strips markup", () => {
  const items = rssItems(rss([["Erste &amp; <b>zweite</b>", NOW]]));
  assert.equal(items[0].title, "Erste & zweite");
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom-Meldung</title><link href="https://example.org/a"/><updated>2026-10-19T10:00:00Z</updated></entry></feed>';
  assert.equal(rssItems(atom)[0].link, "https://example.org/a");
});

test("merges sources, survives failures and consent redirects, dedupes and sorts", async () => {
  const fetcher = async (url, opts) => {
    if (url.includes("tagesschau")) return new Response(rss([["Bundestag beschließt Gesetz", NOW - 3600e3], ["Alte Meldung", NOW - 5 * 86400e3]]));
    if (url.includes("deutschlandfunk")) return new Response("<html>Bitte Cookies akzeptieren</html>");
    if (url.includes("news.google.com")) { assert.match(opts.headers.Cookie, /CONSENT/); return new Response(rss([["Bundestag beschließt Gesetz - tagesschau.de", NOW - 3500e3], ["Neueste Meldung", NOW - 600e3]])); }
    throw new Error("unexpected " + url);
  };
  const r = await getNews("germany", { fetcher, now: NOW });
  assert.deepEqual(r.items.map(i => i.title), ["Neueste Meldung", "Bundestag beschließt Gesetz"]);
  assert.deepEqual(r.sources.map(s => s.ok), [true, false, true]);
  assert.match(r.sources[1].error, /kein Feed/);
});

test("local section keeps only regional stories from the Saxony feed", async () => {
  const fetcher = async (url) => {
    if (url.includes("/bautzen/")) return new Response("nope", { status: 404 });
    if (url.includes("mdr.de")) return new Response(rss([["Leipzig: Straßenbahn fällt aus", NOW - 3600e3], ["Kamenz: Neue Kita eröffnet", NOW - 7200e3]]));
    return new Response(rss([["Nebelschütz feiert Kirmes", NOW - 86400e3]]));
  };
  const r = await getNews("local", { fetcher, now: NOW });
  assert.deepEqual(r.items.map(i => i.title), ["Kamenz: Neue Kita eröffnet", "Nebelschütz feiert Kirmes"]);
});

test("all sources down → honest error; unknown section rejected", async () => {
  const r = await getNews("world", { fetcher: async () => { throw new Error("timeout"); }, now: NOW });
  assert.equal(r.error, "news_source_unavailable");
  assert.equal(r.sources.length, NEWS_SOURCES.world.length);
  assert.equal((await getNews("mars")).error, "invalid_news_section");
});
