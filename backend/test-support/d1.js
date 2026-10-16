// Minimaler Cloudflare-D1-Ersatz für Tests auf Basis von node:sqlite.
// Wendet die echten Migrationen an, damit Schema und CHECK-Regeln mitgetestet werden.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params), success: true }; }
  async first() { return this.db.prepare(this.sql).get(...this.params) ?? null; }
  async run() { const info = this.db.prepare(this.sql).run(...this.params); return { success: true, meta: { changes: info.changes } }; }
}

export function createD1({ migrate = true } = {}) {
  const db = new DatabaseSync(":memory:");
  if (migrate) {
    for (const file of readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }
  }
  return { prepare: sql => new Statement(db, sql), raw: db };
}

export function brokenD1() {
  return { prepare: () => { throw new Error("D1 offline"); } };
}
