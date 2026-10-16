// JARVIS Nachrichten über Google-News-RSS: echte Schlagzeilen mit Quelle und Zeit.

// ---------------------------------------------------------------------------
// Nachrichten (Google News RSS)
// ---------------------------------------------------------------------------

function xmlDecode(value) {
  return String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}
export function rssItems(xml, limit = 5) {
  const items = [];
  const blocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks.slice(0, limit)) {
    const field = (name) => {
      const m = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i"));
      return m ? xmlDecode(m[1].trim()) : "";
    };
    const title = field("title"), link = field("link"), published = field("pubDate");
    const source = field("source") || "Google News";
    if (title && /^https?:\/\//i.test(link)) items.push({ title, link, published, source });
  }
  return items;
}
export const NEWS_QUERIES = {
  local: '(Miltitz OR Nebelschütz OR Kamenz OR Bautzen) (Nachrichten OR Gemeinde OR Polizei OR Verkehr OR Baustelle)',
  saxony: 'Sachsen Nachrichten Politik Gesellschaft',
  germany: 'Deutschland Politik Gesellschaft Nachrichten',
  world: 'Welt Nachrichten internationale Politik Wissenschaft'
};
export async function getNews(section) {
  const query = NEWS_QUERIES[section];
  if (!query) return { error: "invalid_news_section" };
  const rss = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=de&gl=DE&ceid=DE:de";
  const response = await fetch(rss, { headers: { "Accept": "application/rss+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error("news_upstream_" + response.status);
  return { section, items: rssItems(await response.text(), 5), fetchedAt: new Date().toISOString() };
}

