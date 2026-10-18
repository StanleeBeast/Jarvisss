// JARVIS Home-Station – Startpunkt. Läuft auf dem alten Windows-Laptop dauerhaft (start.bat).
import { appendFile, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openStore } from "./config.js";
import { createBackend } from "./backend.js";
import { createStation, VERSION } from "./station.js";
import { createUi } from "./ui.js";

const PORT = Number(process.env.JARVIS_STATION_PORT) || 7777;

async function main() {
  const store = await openStore();
  const logs = [];
  const logFile = join(store.dir, "station.log");
  const log = (line) => {
    const entry = new Date().toLocaleString("de-DE") + "  " + line;
    logs.push(entry); if (logs.length > 200) logs.shift();
    console.log(entry);
    (async () => {
      try { if ((await stat(logFile)).size > 1_000_000) await rename(logFile, logFile + ".1"); } catch { /* noch keine Datei */ }
      await appendFile(logFile, entry + "\n").catch(() => null);
    })();
  };
  const backend = createBackend(store, { version: VERSION });
  const station = createStation({ store, backend, log });
  const ui = createUi({ store, backend, station, logs, port: PORT });
  try { await ui.listen(); } catch (e) {
    console.error(e?.code === "EADDRINUSE" ? "Die Home-Station läuft bereits (Port " + PORT + " ist belegt). Dieses Fenster kann geschlossen werden." : "Start fehlgeschlagen: " + e.message);
    process.exitCode = e?.code === "EADDRINUSE" ? 3 : 1; // 3 = läuft schon, start.bat startet dann nicht neu
    return;
  }
  const url = "http://127.0.0.1:" + PORT;
  log("JARVIS Home-Station " + VERSION + " gestartet. Einrichtung: " + url + " · Daten: " + store.dir);
  station.start();
  const ready = backend.paired() && store.config.accounts.length;
  if (!ready && process.platform === "win32" && !process.env.JARVIS_STATION_NO_BROWSER) {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
  const shutdown = () => { log("Home-Station wird beendet."); station.stop(); ui.close().finally(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (e) => log("Unerwarteter Fehler: " + (e?.message || e)));
}

main();
