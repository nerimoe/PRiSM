import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";

// `wrangler d1 migrations apply --remote` posts each migration to the D1 /query
// endpoint, which splits multi-statement SQL server-side. That splitter tracks
// `CREATE TRIGGER` bodies by BEGIN/END depth but does not understand the END that
// closes a CASE expression, so a CASE inside a trigger body makes it cut the
// trigger short; SQLite then rejects the fragment with
// `incomplete input: SQLITE_ERROR [code: 7500]`.
//
// The same SQL applies cleanly through local sqlite3, the client-side splitter and
// `d1 execute --file` (which uses /import), so nothing else catches this before a
// deploy. These guards exist because the failure is remote-only.
function splitLikeD1(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let depth = 0;
  let token = "";
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    if (char === "'" || char === '"' || char === "`") {
      current += char;
      index += 1;
      while (index < sql.length) {
        current += sql[index];
        if (sql[index] === char && sql[index + 1] !== char) break;
        index += 1;
      }
      continue;
    }
    if (char === ";") {
      if (depth === 0) {
        statements.push(current.trim());
        current = "";
      } else {
        current += char;
      }
      continue;
    }
    current += char;
    token += char;
    const keyword = /(?:^|[^A-Za-z_])(BEGIN|END)(?![A-Za-z_])/.exec(token);
    if (keyword) {
      depth = keyword[1] === "BEGIN" ? depth + 1 : Math.max(0, depth - 1);
      token = "";
    }
    if (token.length > 16) token = token.slice(-16);
  }
  if (current.trim()) statements.push(current.trim());
  return statements.filter(statement => statement.length > 0);
}

const migrationDir = resolve(import.meta.dir, "../../../migrations");
const migrationFiles = readdirSync(migrationDir).filter(name => name.endsWith(".sql")).sort();

describe("D1 remote migration compatibility", () => {
  it("applies every migration when statements are split the way the D1 /query endpoint does", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    const broken: string[] = [];
    try {
      for (const fileName of migrationFiles) {
        for (const statement of splitLikeD1(readFileSync(resolve(migrationDir, fileName), "utf8"))) {
          try {
            db.run(statement);
          } catch (error) {
            const message = String(error);
            // A trigger cut short by the splitter reaches SQLite unbalanced.
            if (message.includes("incomplete input")) {
              broken.push(`${fileName}: ${statement.slice(0, 90).replace(/\s+/g, " ")}...`);
            }
          }
        }
      }
    } finally {
      db.close();
    }
    expect(broken).toEqual([]);
  });

  it("avoids CASE expressions inside trigger bodies", () => {
    const offenders: string[] = [];
    for (const fileName of migrationFiles) {
      const statements = splitLikeD1(readFileSync(resolve(migrationDir, fileName), "utf8"));
      for (const statement of statements) {
        // END closing a CASE is what desynchronises the remote splitter.
        if (/^CREATE\s+TRIGGER/i.test(statement) && /\bCASE\b/.test(statement)) {
          offenders.push(fileName);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("opens trigger bodies with an uppercase BEGIN", () => {
    const offenders: string[] = [];
    for (const fileName of migrationFiles) {
      const sql = readFileSync(resolve(migrationDir, fileName), "utf8");
      for (const match of sql.matchAll(/CREATE\s+TRIGGER[\s\S]*?\n\s*(begin|Begin)\b/g)) {
        offenders.push(`${fileName}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
