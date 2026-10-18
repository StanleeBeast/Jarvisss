// Verbindung zum JARVIS-Worker. Die Station ist ein gekoppeltes Gerät: kurzlebiger Zugangsschlüssel (15 min)
// und ein Geräteschlüssel, der bei jeder Erneuerung wechselt. Der neue Geräteschlüssel wird gespeichert,
// bevor er benutzt wird.
import { protect, unprotect } from "./secret.js";

export function normalizeBackend(input) {
  let u;
  try { u = new URL(String(input || "").trim()); } catch { return null; }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null;
  return u.origin;
}

export class BackendError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

export function createBackend(store, { fetchImpl = globalThis.fetch, version = "1.0.0" } = {}) {
  let access = null, accessExp = 0, refreshing = null;

  async function raw(path, { method = "GET", body, token } = {}) {
    const base = normalizeBackend(store.config.backend);
    if (!base) throw new BackendError("backend_missing", 0);
    const headers = { "User-Agent": "JarvisHomeStation/" + version };
    if (token) headers.Authorization = "Bearer " + token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetchImpl(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    } catch (e) {
      throw new BackendError(e?.name === "TimeoutError" ? "backend_timeout" : "backend_unreachable", 0);
    }
    let data = {};
    try { data = await res.json(); } catch { /* leere Antwort */ }
    return { status: res.status, ok: res.ok, body: data };
  }

  async function adopt(session) {
    // Zuerst sichern, dann benutzen: geht der neue Schlüssel verloren, müsste die Station neu gekoppelt werden.
    store.config.session = { deviceId: session.device?.id || store.config.session?.deviceId || null, deviceName: session.device?.name || store.config.deviceName, refresh: await protect(session.refreshToken), pairedAt: store.config.session?.pairedAt || new Date().toISOString() };
    await store.saveConfig();
    access = session.accessToken;
    accessExp = Date.parse(session.accessExpiresAt) || Date.now() + 10 * 60_000;
  }

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      if (!store.config.session?.refresh) throw new BackendError("not_paired", 401);
      const token = await unprotect(store.config.session.refresh);
      const r = await raw("/api/auth/refresh", { method: "POST", body: { refreshToken: token } });
      if (r.ok) return adopt(r.body);
      if (r.status === 401) {
        // Gerät wurde in der App abgemeldet oder der Schlüssel ist abgelaufen: neu koppeln.
        store.config.session = null;
        await store.saveConfig();
        throw new BackendError(r.body.error || "unauthorized", 401);
      }
      throw new BackendError(r.body.error || "refresh_failed", r.status);
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function call(path, opts = {}) {
    if (!access || Date.now() > accessExp - 60_000) await refresh();
    let r = await raw(path, { ...opts, token: access });
    if (r.status === 401) {
      access = null;
      await refresh();
      r = await raw(path, { ...opts, token: access });
    }
    return r;
  }

  return {
    raw,
    call,
    paired: () => Boolean(store.config.session?.refresh),
    async health(base) {
      const origin = normalizeBackend(base);
      if (!origin) return { ok: false, error: "invalid_url" };
      try {
        const res = await fetchImpl(origin + "/health", { signal: AbortSignal.timeout(15_000) });
        const body = await res.json().catch(() => ({}));
        return res.ok && body.service === "jarvisss-ai-proxy" ? { ok: true, origin } : { ok: false, error: "not_jarvis_backend" };
      } catch { return { ok: false, error: "backend_unreachable" }; }
    },
    async pair(code, deviceName) {
      const r = await raw("/api/auth/pair/complete", { method: "POST", body: { code, deviceName } });
      if (!r.ok) throw new BackendError(r.body.error || "pairing_failed", r.status);
      await adopt(r.body);
      return r.body.device;
    },
    async unpair() {
      try { if (this.paired()) await call("/api/auth/logout", { method: "POST", body: {} }); } catch { /* lokal trotzdem trennen */ }
      access = null; accessExp = 0;
      store.config.session = null;
      await store.saveConfig();
    }
  };
}
