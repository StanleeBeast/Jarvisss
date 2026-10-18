// Einstellungen der Home-Station: %APPDATA%\JarvisStation\config.json (Postfächer, Backend, Geräteschlüssel)
// und state.json (bis zu welcher Mail schon abgeholt wurde). Passwörter und Schlüssel sind mit secret.js geschützt.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(env = process.env) {
  if (env.JARVIS_STATION_DIR) return env.JARVIS_STATION_DIR;
  return env.APPDATA ? join(env.APPDATA, "JarvisStation") : join(homedir(), ".jarvis-station");
}

const defaults = () => ({ backend: "", deviceName: "Home-Station (Laptop)", session: null, accounts: [] });

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}
// Erst in eine Hilfsdatei schreiben, dann umbenennen: ein Absturz hinterlässt nie eine halbe Datei.
async function writeJson(file, value) {
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
}

export async function openStore(dir = dataDir()) {
  await mkdir(dir, { recursive: true });
  const configFile = join(dir, "config.json"), stateFile = join(dir, "state.json");
  const config = { ...defaults(), ...(await readJson(configFile, {})) };
  const state = await readJson(stateFile, {});
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));
  return {
    dir,
    config,
    state,
    saveConfig: () => serial(() => writeJson(configFile, config)),
    saveState: () => serial(() => writeJson(stateFile, state))
  };
}
