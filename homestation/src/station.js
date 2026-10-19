// Der Takt der Home-Station: Lebenszeichen (jede Minute), Aufträge abholen (alle 30 s), Postfächer abrufen (alle 5 min).
import { syncAccount, sendReply, describeError, PROVIDERS } from "./mail.js";
import { unprotect } from "./secret.js";

export const VERSION = "1.0.0";

export function createStation({ store, backend, log = () => {}, mailDeps = {}, timers = { setTimeout, clearTimeout } }) {
  const status = new Map(); // accountId -> { ok, error, lastSync, lastStored }
  let pollSeconds = 30, syncMinutes = 5, running = false, syncing = false, handles = [], lastHeartbeat = null, lastBackendError = null;

  const accounts = () => store.config.accounts.filter(a => a.enabled !== false && PROVIDERS[a.provider]);
  const passwordOf = (a) => unprotect(a.password);
  const stateOf = (id) => (store.state[id] ||= {});

  function accountReport() {
    return store.config.accounts.map(a => {
      const s = status.get(a.id) || {};
      return { id: a.id, label: a.label, provider: a.provider, address: a.address, ok: s.ok !== false, error: s.error || "", lastSync: s.lastSync || null };
    });
  }

  async function heartbeat() {
    if (!backend.paired()) return null;
    try {
      const r = await backend.call("/api/station/heartbeat", { method: "POST", body: { version: VERSION, accounts: accountReport() } });
      if (!r.ok) { lastBackendError = r.body.error || "heartbeat_failed"; log("Lebenszeichen abgelehnt: " + lastBackendError); return null; }
      lastHeartbeat = new Date().toISOString(); lastBackendError = null;
      pollSeconds = Math.min(300, Math.max(10, Number(r.body.pollSeconds) || 30));
      syncMinutes = Math.min(60, Math.max(1, Number(r.body.syncMinutes) || 5));
      if (r.body.jobsPending) await runJobs();
      return r.body;
    } catch (e) { lastBackendError = e.code || "backend_unreachable"; log("Backend nicht erreichbar (" + lastBackendError + ")"); return null; }
  }

  async function runJobs() {
    if (!backend.paired()) return 0;
    let r;
    try { r = await backend.call("/api/station/jobs"); } catch (e) { lastBackendError = e.code || "backend_unreachable"; return 0; }
    if (!r.ok) return 0;
    let done = 0;
    for (const job of r.body.jobs || []) {
      const account = store.config.accounts.find(a => a.id === job.payload?.account);
      let result;
      if (!account) result = { ok: false, error: "Postfach auf der Home-Station nicht mehr vorhanden." };
      else {
        try {
          const sent = await sendReply({ account, password: await passwordOf(account), job, ...mailDeps });
          result = { ok: true, messageId: sent.messageId };
          log("Antwort an " + job.payload.to + " gesendet" + (sent.savedToSent ? "" : " (nicht unter „Gesendet“ abgelegt)") + ".");
        } catch (e) {
          result = { ok: false, error: describeError(e) };
          log("Senden an " + job.payload?.to + " fehlgeschlagen: " + result.error);
        }
      }
      // Das Ergebnis wird mehrfach versucht zu melden, damit die App nicht fälschlich „wird gesendet“ zeigt.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const rr = await backend.call("/api/station/jobs/" + encodeURIComponent(job.id) + "/result", { method: "POST", body: result });
          if (rr.ok || rr.status === 404) break;
        } catch { /* erneut versuchen */ }
        await new Promise(res => timers.setTimeout(res, 2000 * (attempt + 1)));
      }
      done++;
    }
    return done;
  }

  async function syncAll({ only } = {}) {
    if (syncing || !backend.paired()) return [];
    syncing = true;
    const results = [];
    try {
      for (const account of accounts()) {
        if (only && account.id !== only) continue;
        const st = stateOf(account.id);
        try {
          const r = await syncAccount({
            account, password: await passwordOf(account), state: st, saveState: store.saveState, ...mailDeps,
            ingest: async (messages) => {
              const res = await backend.call("/api/mail/ingest?tz=Europe%2FBerlin", { method: "POST", body: { account: { id: account.id, label: account.label }, messages } });
              if (!res.ok) { const err = new Error(res.body.error || "ingest_failed"); err.backend = true; throw err; }
              return res.body;
            }
          });
          if (r.user && account.imapUser !== r.user) { account.imapUser = r.user; await store.saveConfig(); }
          status.set(account.id, { ok: true, lastSync: new Date().toISOString(), lastStored: r.stored });
          if (r.fetched) log(account.label + ": " + r.fetched + " neue Mail(s) abgeholt, " + r.stored + " eingestuft.");
          results.push({ id: account.id, ...r });
        } catch (e) {
          const error = e.backend ? "JARVIS-Backend: " + e.message : describeError(e);
          status.set(account.id, { ok: false, error, lastSync: status.get(account.id)?.lastSync || null });
          log(account.label + ": " + error);
          results.push({ id: account.id, error });
        }
      }
    } finally { syncing = false; }
    return results;
  }

  function loop(fn, everyMs) {
    let h;
    const tick = async () => {
      if (!running) return;
      try { await fn(); } catch (e) { log("Fehler: " + (e?.message || e)); }
      if (running) { h = timers.setTimeout(tick, everyMs()); handles.push(h); }
    };
    h = timers.setTimeout(tick, 1000); handles.push(h);
  }

  return {
    heartbeat, runJobs, syncAll, accountReport,
    info: () => ({ version: VERSION, running, lastHeartbeat, lastBackendError, pollSeconds, syncMinutes, syncing }),
    start() {
      if (running) return;
      running = true;
      loop(heartbeat, () => 60_000);
      loop(runJobs, () => pollSeconds * 1000);
      loop(syncAll, () => syncMinutes * 60_000);
    },
    stop() { running = false; handles.forEach(h => timers.clearTimeout(h)); handles = []; }
  };
}
