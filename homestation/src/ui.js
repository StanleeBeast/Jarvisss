// Einrichtungsseite der Home-Station: nur auf diesem Laptop erreichbar (http://127.0.0.1:7777).
// Schutz gegen fremde Webseiten: Host-Prüfung (gegen DNS-Rebinding), Origin-Prüfung und JSON-Pflicht für Änderungen.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { PROVIDERS, isAddress, testAccount, describeError } from "./mail.js";
import { protect, protectionOf } from "./secret.js";
import { normalizeBackend } from "./backend.js";

const PAIR_ERRORS = { invalid_pairing_code: "Kopplungscode falsch, abgelaufen oder schon benutzt. In der JARVIS-App unter „Geräte“ einen neuen erzeugen.", backend_missing: "Zuerst die Backend-Adresse speichern.", backend_unreachable: "Backend nicht erreichbar." };

export function createUi({ store, backend, station, logs, port = 7777, mailDeps = {} }) {
  const allowedHosts = new Set(["127.0.0.1:" + port, "localhost:" + port]);
  const allowedOrigins = new Set(["http://127.0.0.1:" + port, "http://localhost:" + port]);

  function send(res, status, body, type = "application/json; charset=utf-8") {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }
  async function readBody(req) {
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 20_000) throw new Error("too_large"); }
    return raw ? JSON.parse(raw) : {};
  }
  function state() {
    return {
      version: station.info().version,
      backend: store.config.backend,
      deviceName: store.config.deviceName,
      paired: backend.paired(),
      pairedAt: store.config.session?.pairedAt || null,
      protection: store.config.session?.refresh ? protectionOf(store.config.session.refresh) : (store.config.accounts[0] ? protectionOf(store.config.accounts[0].password) : null),
      station: station.info(),
      accounts: station.accountReport(),
      providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.label])),
      log: logs.slice(-40)
    };
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1:" + port);
    if (!allowedHosts.has(req.headers.host || "")) return send(res, 403, { error: "forbidden_host" });
    if (req.method !== "GET") {
      if (!allowedOrigins.has(req.headers.origin || "")) return send(res, 403, { error: "forbidden_origin" });
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "json_required" });
    }
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, PAGE, "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, state());
    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: "invalid_json" }); }

    if (req.method === "POST" && url.pathname === "/api/backend") {
      const origin = normalizeBackend(body.url);
      if (!origin) return send(res, 400, { error: "Bitte die https-Adresse deines JARVIS-Workers eintragen (z. B. https://…workers.dev)." });
      const h = await backend.health(origin);
      if (!h.ok) return send(res, 400, { error: h.error === "not_jarvis_backend" ? "Unter dieser Adresse antwortet kein JARVIS-Backend." : "Backend nicht erreichbar. Adresse und Internet prüfen." });
      if (store.config.backend !== origin && backend.paired()) await backend.unpair();
      store.config.backend = origin;
      await store.saveConfig();
      return send(res, 200, state());
    }
    if (req.method === "POST" && url.pathname === "/api/pair") {
      const name = String(body.deviceName || store.config.deviceName).trim().slice(0, 60) || "Home-Station (Laptop)";
      try {
        store.config.deviceName = name;
        await backend.pair(String(body.code || ""), name);
        await station.heartbeat();
        return send(res, 200, state());
      } catch (e) { return send(res, 400, { error: PAIR_ERRORS[e.code] || "Kopplung fehlgeschlagen (" + (e.code || e.message) + ")." }); }
    }
    if (req.method === "POST" && url.pathname === "/api/unpair") {
      await backend.unpair();
      return send(res, 200, state());
    }
    if (req.method === "POST" && url.pathname === "/api/accounts") {
      const provider = body.provider, address = String(body.address || "").trim().toLowerCase(), password = String(body.password || "").replace(/\s+/g, "");
      if (!PROVIDERS[provider]) return send(res, 400, { error: "Bitte Anbieter wählen." });
      if (!isAddress(address)) return send(res, 400, { error: "Bitte eine gültige Mailadresse eintragen." });
      if (password.length < 8) return send(res, 400, { error: "Bitte das app-spezifische Passwort eintragen (nicht dein normales Passwort)." });
      if (store.config.accounts.some(a => a.address === address)) return send(res, 409, { error: "Dieses Postfach ist schon eingerichtet." });
      const account = { id: provider + "-" + randomUUID().slice(0, 8), provider, address, label: String(body.label || "").trim().slice(0, 40) || PROVIDERS[provider].label, displayName: String(body.displayName || "").trim().slice(0, 60), enabled: true };
      try {
        const t = await testAccount(account, password, mailDeps);
        account.imapUser = t.imapUser;
      } catch (e) { return send(res, 400, { error: "Test fehlgeschlagen: " + describeError(e) }); }
      account.password = await protect(password);
      store.config.accounts.push(account);
      await store.saveConfig();
      station.syncAll({ only: account.id }).then(() => station.heartbeat()).catch(() => null);
      return send(res, 201, state());
    }
    const m = url.pathname.match(/^\/api\/accounts\/([a-z]+-[0-9a-f]{8})(\/sync)?$/);
    if (m) {
      const account = store.config.accounts.find(a => a.id === m[1]);
      if (!account) return send(res, 404, { error: "Postfach nicht gefunden." });
      if (req.method === "POST" && m[2]) { await station.syncAll({ only: account.id }); await station.heartbeat(); return send(res, 200, state()); }
      if (req.method === "DELETE" && !m[2]) {
        store.config.accounts = store.config.accounts.filter(a => a.id !== account.id);
        delete store.state[account.id];
        await store.saveConfig(); await store.saveState();
        await station.heartbeat();
        return send(res, 200, state());
      }
    }
    if (req.method === "POST" && url.pathname === "/api/sync") { await station.syncAll(); await station.heartbeat(); return send(res, 200, state()); }
    return send(res, 404, { error: "not_found" });
  }

  const server = createServer((req, res) => { handle(req, res).catch(() => send(res, 500, { error: "Interner Fehler der Home-Station." })); });
  return {
    server,
    listen: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server.address().port)); }),
    close: () => new Promise(resolve => server.close(() => resolve()))
  };
}

const PAGE = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JARVIS Home-Station</title>
<style>
:root{--bg:#0d0b0a;--panel:#17130f;--line:#3a2a1a;--gold:#ffb347;--ember:#ff7a2f;--red:#ff4433;--ok:#6fe39a;--text:#f3e6d6;--muted:#a8957f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 "Segoe UI",system-ui,sans-serif}
main{max-width:820px;margin:0 auto;padding:24px 16px 60px}h1{font-size:22px;letter-spacing:.12em;color:var(--gold);margin:0 0 4px}
h2{font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);margin:0 0 10px}
.sub{color:var(--muted);margin:0 0 20px}.panel{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--ember);padding:16px;margin:0 0 16px;clip-path:polygon(0 0,calc(100% - 14px) 0,100% 14px,100% 100%,0 100%)}
label{display:block;margin:8px 0;color:var(--muted);font-size:13px}input,select{width:100%;margin-top:4px;padding:9px 10px;background:#0f0c0a;border:1px solid var(--line);color:var(--text);font:inherit;border-radius:4px}
button{background:linear-gradient(90deg,var(--ember),var(--gold));color:#1a0f05;border:0;padding:9px 16px;font-weight:700;letter-spacing:.06em;cursor:pointer;border-radius:3px;margin:6px 6px 0 0}
button.ghost{background:transparent;color:var(--gold);border:1px solid var(--line)}button.danger{background:transparent;color:var(--red);border:1px solid #5a2620}
button:disabled{opacity:.5;cursor:wait}.row{display:flex;gap:12px;flex-wrap:wrap}.row>*{flex:1 1 220px}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;border:1px solid var(--line)}.ok{color:var(--ok);border-color:#2c5a3b}.bad{color:var(--red);border-color:#5a2620}.warn{color:var(--gold)}
.acc{border-top:1px solid var(--line);padding:10px 0}.hint{color:var(--muted);font-size:13px}.msg{min-height:20px;margin-top:8px;font-size:14px}
pre{white-space:pre-wrap;background:#0f0c0a;border:1px solid var(--line);padding:10px;font-size:12px;max-height:260px;overflow:auto;color:var(--muted)}
ol{padding-left:20px;margin:6px 0}a{color:var(--gold)}
</style></head><body><main>
<h1>J.A.R.V.I.S.S. · HOME-STATION</h1>
<p class="sub">Läuft auf diesem Laptop, holt deine Mails ab und sendet nur Antworten, die du in der JARVIS-App bestätigt hast. Passwörter bleiben auf diesem Laptop.</p>

<section class="panel"><h2>1 · Backend</h2>
<p class="hint">Die Adresse deines JARVIS-Workers – dieselbe wie in der App unter Einstellungen → Stimme &amp; KI (ohne <code>/api/chat</code> ist auch okay).</p>
<label>Backend-Adresse<input id="backend" type="url" placeholder="https://dein-worker.workers.dev"></label>
<button id="saveBackend">Speichern &amp; prüfen</button><div class="msg" id="backendMsg"></div></section>

<section class="panel"><h2>2 · Mit JARVIS koppeln</h2>
<div id="pairedBox"></div>
<div id="pairForm"><ol class="hint"><li>JARVIS-App öffnen → <b>Geräte</b> → <b>Gerät koppeln</b>.</li><li>Den 8-stelligen Code hier eintragen (10 Minuten gültig).</li></ol>
<div class="row"><label>Kopplungscode<input id="code" autocomplete="off" placeholder="ABCD-EFGH"></label><label>Name dieser Station<input id="deviceName"></label></div>
<button id="pair">Koppeln</button></div><div class="msg" id="pairMsg"></div></section>

<section class="panel"><h2>3 · Postfächer</h2>
<div id="accounts"></div>
<details id="addBox"><summary style="cursor:pointer;color:var(--gold);margin-top:8px">+ Postfach hinzufügen</summary>
<div class="row"><label>Anbieter<select id="provider"><option value="gmail">Gmail</option><option value="icloud">iCloud Mail (Apple Mail)</option></select></label><label>Mailadresse<input id="address" type="email" autocomplete="off"></label></div>
<div class="row"><label>App-spezifisches Passwort<input id="password" type="password" autocomplete="off" placeholder="nicht dein normales Passwort"></label><label>Bezeichnung (optional)<input id="label" placeholder="z. B. Privat"></label></div>
<label>Absendername für Antworten (optional)<input id="displayName" placeholder="z. B. Stanley Müller"></label>
<p class="hint" id="providerHint"></p>
<button id="addAccount">Testen &amp; speichern</button></details><div class="msg" id="accMsg"></div></section>

<section class="panel"><h2>Status</h2><div id="status" class="hint"></div><button class="ghost" id="syncNow">Jetzt abrufen</button><pre id="log"></pre></section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const HINT = {
  gmail: 'Gmail: Unter myaccount.google.com → Sicherheit die Bestätigung in zwei Schritten einschalten, dann unter „App-Passwörter“ ein Passwort für „JARVIS“ erzeugen (16 Zeichen). IMAP ist bei Gmail automatisch aktiv.',
  icloud: 'iCloud: Unter account.apple.com → Anmeldung und Sicherheit → „App-spezifische Passwörter“ ein Passwort für „JARVIS“ erzeugen. Mailadresse: deine @icloud.com- (oder @me.com-) Adresse.'
};
async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Fehler ' + res.status);
  return data;
}
function busy(btn, on) { btn.disabled = on; }
function render(s) {
  if (document.activeElement !== $('backend')) $('backend').value = s.backend || '';
  if (document.activeElement !== $('deviceName')) $('deviceName').value = s.deviceName || '';
  $('pairForm').hidden = s.paired;
  $('pairedBox').innerHTML = s.paired ? '<span class="pill ok">Gekoppelt</span> <span class="hint">seit ' + new Date(s.pairedAt).toLocaleString('de-DE') + '</span><br><button class="danger" id="unpair">Kopplung trennen</button>' : '<span class="pill warn">Noch nicht gekoppelt</span>';
  if (s.paired) $('unpair').onclick = async () => { if (!confirm('Kopplung wirklich trennen? JARVIS bekommt dann keine Mails mehr.')) return; render(await api('/api/unpair', 'POST', {})); };
  $('accounts').innerHTML = s.accounts.length ? '' : '<p class="hint">Noch kein Postfach eingerichtet.</p>';
  for (const a of s.accounts) {
    const d = document.createElement('div'); d.className = 'acc';
    const pill = a.lastSync ? (a.ok ? '<span class="pill ok">OK</span>' : '<span class="pill bad">Fehler</span>') : (a.ok ? '<span class="pill warn">wartet</span>' : '<span class="pill bad">Fehler</span>');
    d.innerHTML = '<b></b> <span class="hint"></span> ' + pill + '<div class="hint err"></div>';
    d.querySelector('b').textContent = a.label; d.querySelector('span').textContent = a.address + (a.lastSync ? ' · zuletzt ' + new Date(a.lastSync).toLocaleTimeString('de-DE') : '');
    d.querySelector('.err').textContent = a.error || '';
    const sync = document.createElement('button'); sync.className = 'ghost'; sync.textContent = 'Abrufen';
    sync.onclick = async () => { busy(sync, true); try { render(await api('/api/accounts/' + a.id + '/sync', 'POST', {})); } catch (e) { $('accMsg').textContent = e.message; } busy(sync, false); };
    const del = document.createElement('button'); del.className = 'danger'; del.textContent = 'Entfernen';
    del.onclick = async () => { if (!confirm(a.address + ' von der Home-Station entfernen? Das Passwort wird hier gelöscht.')) return; render(await api('/api/accounts/' + a.id, 'DELETE', {})); };
    d.append(document.createElement('br'), sync, del); $('accounts').append(d);
  }
  const st = s.station;
  $('status').innerHTML = '';
  const lines = ['Version ' + s.version, s.paired ? (st.lastHeartbeat ? 'Letztes Lebenszeichen an JARVIS: ' + new Date(st.lastHeartbeat).toLocaleTimeString('de-DE') : 'Noch kein Lebenszeichen gesendet.') : 'Nicht gekoppelt.', st.lastBackendError ? 'Backend-Fehler: ' + st.lastBackendError : '', 'Abruf alle ' + st.syncMinutes + ' min, Aufträge alle ' + st.pollSeconds + ' s.', s.protection === 'dpapi' ? 'Passwörter: mit Windows (DPAPI) verschlüsselt.' : s.protection === 'plain' ? 'Hinweis: Passwörter liegen unverschlüsselt im Benutzerprofil (Windows-Verschlüsselung nicht verfügbar).' : ''];
  for (const l of lines.filter(Boolean)) { const p = document.createElement('div'); p.textContent = l; $('status').append(p); }
  $('log').textContent = s.log.join('\\n') || '–';
}
$('provider').onchange = () => { $('providerHint').textContent = HINT[$('provider').value]; };
$('provider').onchange();
$('saveBackend').onclick = async (e) => { busy(e.target, true); $('backendMsg').textContent = 'Prüfe …'; try { render(await api('/api/backend', 'POST', { url: $('backend').value })); $('backendMsg').textContent = 'Backend erreichbar und gespeichert.'; } catch (err) { $('backendMsg').textContent = err.message; } busy(e.target, false); };
$('pair').onclick = async (e) => { busy(e.target, true); $('pairMsg').textContent = 'Kopple …'; try { render(await api('/api/pair', 'POST', { code: $('code').value, deviceName: $('deviceName').value })); $('pairMsg').textContent = 'Gekoppelt. In der App unter „Mails“ erscheint die Station gleich als online.'; $('code').value = ''; } catch (err) { $('pairMsg').textContent = err.message; } busy(e.target, false); };
$('addAccount').onclick = async (e) => { busy(e.target, true); $('accMsg').textContent = 'Teste Anmeldung bei IMAP und SMTP …'; try { render(await api('/api/accounts', 'POST', { provider: $('provider').value, address: $('address').value, password: $('password').value, label: $('label').value, displayName: $('displayName').value })); $('accMsg').textContent = 'Postfach gespeichert. Der erste Abruf holt die Mails der letzten 3 Tage (höchstens 30).'; $('password').value = ''; $('addBox').open = false; } catch (err) { $('accMsg').textContent = err.message; } busy(e.target, false); };
$('syncNow').onclick = async (e) => { busy(e.target, true); try { render(await api('/api/sync', 'POST', {})); } catch (err) { $('accMsg').textContent = err.message; } busy(e.target, false); };
async function refresh() { try { render(await api('/api/state')); } catch {} }
refresh(); setInterval(refresh, 5000);
</script></body></html>`;
