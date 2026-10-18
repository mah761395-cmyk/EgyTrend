import crypto from "crypto";
import type { DriftedObject } from "./db-migration-state";

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function migrationChecksum(sql: string): string {
  return crypto.createHash("sha256").update(sql).digest("hex").slice(0, 32);
}

/**
 * Objects a reviewed migration file creates.
 *
 * This is deliberately a lexical scan of the reviewed SQL (not a SQL parser):
 * it exists to *report* why a database is behind. It never decides what SQL to
 * execute — that is always the reviewed file itself.
 */
export function plannedObjects(sql: string): DriftedObject[] {
  const found: DriftedObject[] = [];
  const seen = new Set<string>();
  const push = (kind: DriftedObject["kind"], object: string) => {
    const name = object.replace(/"/g, "").trim();
    if (!name || name.includes("(")) return;
    const key = `${kind}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ kind, object: name });
  };

  for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+"?([A-Za-z0-9_]+)"?/g)) push("table", match[1]);
  for (const match of sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+"?([A-Za-z0-9_]+)"?/g)) push("index", match[1]);

  for (const statement of sql.split(";")) {
    const table = statement.match(/ALTER\s+TABLE\s+(?:IF EXISTS\s+)?"?([A-Za-z0-9_]+)"?/i);
    if (!table) continue;
    for (const column of statement.matchAll(/ADD COLUMN IF NOT EXISTS\s+"?([A-Za-z0-9_]+)"?/gi)) {
      push("column", `${table[1]}.${column[1]}`);
    }
  }
  return found;
}
