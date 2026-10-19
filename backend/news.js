// JARVIS Nachrichten: mehrere echte RSS-Quellen je Rubrik, parallel abgerufen, zusammengeführt und nach Zeit sortiert.
// Fällt eine Quelle aus (Sperre, Umleitung auf eine Cookie-Seite, Zeitüberschreitung), liefern die anderen weiter.
// Jede Meldung behält ihre echte Quelle und Veröffentlichungszeit.

const UA = "Mozilla/5.0 (compatible; JARVIS-News/1.0; +https://stanleebeast.github.io/Jarvisss/)";
const PER_SOURCE = 8, TIMEOUT_MS = 8000, CACHE_SECONDS = 600, MAX_AGE_DAYS = { local: 21, saxony: 4, germany: 2, world: 2 };

const google = (q) => "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=de&gl=DE&ceid=DE:de";
const LOCAL_TERMS = /miltitz|nebelsch[üu]tz|kamenz|bautzen|lausitz|elstra|crostwitz|panschwitz|r[äa]ckelwitz|ralbitz|hoyerswerda|bischofswerda|radeberg|pulsnitz/i;

// Quellen je Rubrik. „filter“ hält nur passende Meldungen (z. B. regionale aus einem Sachsen-Feed).
export const NEWS_SOURCES = {
  local: [
    { name: "MDR Sachsen (Region)", url: "https://www.mdr.de/nachrichten/sachsen/bautzen/index-rss.xml" },
    { name: "MDR Sachsen", url: "https://www.mdr.de/nachrichten/sachsen/index-rss.xml", filter: LOCAL_TERMS },
    { name: "Google News", url: google("Nebelschütz OR Miltitz OR Kamenz OR Bautzen OR Panschwitz-Kuckau OR Crostwitz"), google: true }
  ],
  saxony: [
    { name: "MDR Sachsen", url: "https://www.mdr.de/nachrichten/sachsen/index-rss.xml" },
    { name: "Google News", url: google("Sachsen"), google: true }
  ],
  germany: [
    { name: "tagesschau", url: "https://www.tagesschau.de/inland/index~rss2.xml" },
    { name: "Deutschlandfunk", url: "https://www.deutschlandfunk.de/nachrichten-100.rss" },
    { name: "Google News", url: "https://news.google.com/rss/headlines/section/geo/Deutschland?hl=de&gl=DE&ceid=DE:de", google: true }
  ],
  world: [
    { name: "tagesschau", url: "https://www.tagesschau.de/ausland/index~rss2.xml" },
    { name: "Deutsche Welle", url: "https://rss.dw.com/xml/rss-de-all" },
    { name: "Google News", url: "https://news.google.com/rss/headlines/section/topic/WORLD?hl=de&gl=DE&ceid=DE:de", google: true }
  ]
};
export const NEWS_QUERIES = Object.fromEntries(Object.keys(NEWS_SOURCES).map(k => [k, k])); // erlaubte Rubriken (Agent)

function xmlDecode(value) {
  return String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ").trim();
}
// Liest RSS 2.0 und Atom.
export function rssItems(xml, limit = PER_SOURCE, sourceName = "") {
  const items = [];
  const blocks = String(xml).match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  for (const block of blocks) {
    if (items.length >= limit) break;
    const field = (name) => {
      const m = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i"));
      return m ? xmlDecode(m[1]) : "";
    };
    const title = field("title");
    let link = field("link");
    if (!link) link = (block.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
    const published = field("pubDate") || field("dc:date") || field("published") || field("updated");
    const desc = field("description") || field("summary");
    const source = field("source") || sourceName || "Nachrichtenquelle";
    if (title && /^https?:\/\//i.test(link)) items.push({ title, link, published, source, summary: desc.slice(0, 240) });
  }
  return items;
}

async function fetchSource(src, fetcher) {
  const headers = { "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5", "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9" };
  // Google leitet Anfragen aus Rechenzentren in der EU sonst oft auf eine Einwilligungsseite um.
  if (src.google) headers.Cookie = "CONSENT=YES+cb; SOCS=CAI";
  const res = await fetcher(src.url, { headers, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS), cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(text)) throw new Error("kein Feed (Umleitung?)");
  let items = rssItems(text, 40, src.name);
  if (src.filter) items = items.filter(i => src.filter.test(i.title + " " + i.summary));
  return items.slice(0, PER_SOURCE);
}

const norm = (t) => t.toLowerCase().replace(/\s[-–|]\s[^-–|]{2,40}$/, "").replace(/[^a-zäöüß0-9 ]/g, "").replace(/\s+/g, " ").trim();

export async function getNews(section, { fetcher = fetch, now = Date.now(), limit = 6 } = {}) {
  const sources = NEWS_SOURCES[section];
  if (!sources) return { error: "invalid_news_section" };
  const results = await Promise.allSettled(sources.map(s => fetchSource(s, fetcher)));
  const status = sources.map((s, i) => ({ name: s.name, ok: results[i].status === "fulfilled", count: results[i].status === "fulfilled" ? results[i].value.length : 0, error: results[i].status === "rejected" ? String(results[i].reason?.message || "Fehler").slice(0, 80) : undefined }));
  const seen = new Set(), merged = [];
  const maxAge = (MAX_AGE_DAYS[section] || 3) * 86400000;
  for (const [i, r] of results.entries()) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value) {
      const key = norm(item.title);
      if (!key || seen.has(key)) continue;
      const t = Date.parse(item.published);
      if (Number.isFinite(t) && now - t > maxAge) continue;
      seen.add(key);
      merged.push({ ...item, published: Number.isFinite(t) ? new Date(t).toISOString() : "", rank: i });
    }
  }
  // Neueste zuerst; bei gleicher Zeit gewinnt die zuerst genannte (verlässlichere) Quelle.
  merged.sort((a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0) || a.rank - b.rank);
  const items = merged.slice(0, limit).map(({ rank, ...x }) => x);
  if (!items.length && status.every(s => !s.ok)) return { section, items: [], sources: status, error: "news_source_unavailable", fetchedAt: new Date(now).toISOString() };
  return { section, items, sources: status, fetchedAt: new Date(now).toISOString() };
}
