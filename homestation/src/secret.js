// Schutz für Passwörter und den Geräteschlüssel auf dem Laptop.
// Unter Windows: DPAPI über PowerShell (ConvertFrom-SecureString) – nur dein Windows-Benutzer kann es wieder lesen.
// Anderswo (oder wenn PowerShell scheitert): nur Base64, die Datei liegt dann ungeschützt im Benutzerprofil.
import { spawn } from "node:child_process";

const ENCRYPT = "$b=[Console]::In.ReadToEnd().Trim();$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b));ConvertTo-SecureString -String $s -AsPlainText -Force | ConvertFrom-SecureString";
const DECRYPT = "$e=[Console]::In.ReadToEnd().Trim();$ss=ConvertTo-SecureString $e;$p=[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss));[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p))";

function powershell(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("powershell_timeout")); }, 20_000);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => { clearTimeout(timer); code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error(err.trim() || "powershell_failed")); });
    child.stdin.end(input);
  });
}

export async function protect(plain, platform = process.platform) {
  const b64 = Buffer.from(String(plain), "utf8").toString("base64");
  if (platform === "win32") {
    try { return "dpapi:" + await powershell(ENCRYPT, b64); } catch { /* Rückfall unten */ }
  }
  return "plain:" + b64;
}

export async function unprotect(value) {
  if (typeof value !== "string") return "";
  if (value.startsWith("plain:")) return Buffer.from(value.slice(6), "base64").toString("utf8");
  if (value.startsWith("dpapi:")) return Buffer.from(await powershell(DECRYPT, value.slice(6)), "base64").toString("utf8");
  return "";
}

export const protectionOf = (value) => typeof value === "string" && value.startsWith("dpapi:") ? "dpapi" : "plain";
