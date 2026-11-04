import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  D1BoundStatementLike,
  D1DatabaseLike,
  D1PreparedStatementLike,
  SqlValue,
} from "@prism/adapter-d1";
import { splitD1MigrationStatements } from "@prism/storage-sql";

/** The D1 migrations are the one schema; the local database is built from the same files. */
export const defaultMigrationsDir = fileURLToPath(new URL("../../../../migrations", import.meta.url));

/** The ledger Wrangler keeps, so a database moved between D1 and local agrees on what ran. */
const ledger =
  "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)";

/** Open a database file the way D1 behaves: foreign keys enforced, one writer, readers not blocked. */
export function openLocalDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  if (path !== ":memory:") db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  matchD1(db);
  return db;
}

/**
 * Settings D1 has that a local SQLite may not. The SQLite macOS ships turns
 * `legacy_alter_table` on, so renaming a table would leave other tables'
 * foreign keys naming the old one; the migrations rely on D1 rewriting them.
 */
export function matchD1(db: Database): void {
  db.run("PRAGMA legacy_alter_table = OFF");
  db.run("PRAGMA foreign_keys = ON");
}

/** Migration files in the order Wrangler and the deploy script apply them. */
export function migrationFiles(dir = defaultMigrationsDir): string[] {
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql"))
    .sort((a, b) => parseInt(a) - parseInt(b) || (a < b ? -1 : a > b ? 1 : 0));
  const invalid = files.find((name) => !/^\d+_[a-z0-9_-]+\.sql$/.test(name));
  if (invalid) throw new Error(`Unsupported migration filename: ${invalid}`);
  return files;
}

/**
 * Apply the migrations not yet in the ledger, each in its own transaction.
 *
 * Several migrations rebuild tables. SQLite ignores `PRAGMA foreign_keys`
 * inside a transaction, and dropping a referenced table with the keys on would
 * cascade into the rows that point at it, so the keys are off around each
 * migration and must check clean before it commits.
 */
export function applyMigrations(db: Database, dir = defaultMigrationsDir): string[] {
  matchD1(db);
  const tables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all().map((row) => row.name);
  if (tables.length && !tables.includes("d1_migrations")) {
    // Earlier `dev:local` built its own schema without the ledger; the migrations cannot start over it.
    throw new Error("This database has tables but no migration ledger (an old dev:local schema); move its data with a JSON backup into a new database");
  }
  db.run(ledger);
  const done = new Set(db.query<{ name: string }, []>("SELECT name FROM d1_migrations").all().map((row) => row.name));
  const applied: string[] = [];
  for (const name of migrationFiles(dir)) {
    if (done.has(name)) continue;
    const statements = splitD1MigrationStatements(readFileSync(resolve(dir, name), "utf8"))
      .filter((sql) => !/^PRAGMA\s+(?:foreign_keys|defer_foreign_keys)\b/i.test(sql));
    db.run("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => {
        for (const sql of statements) db.run(sql);
        const broken = db.query("PRAGMA foreign_key_check").all();
        if (broken.length) throw new Error(`Migration ${name} leaves ${broken.length} broken foreign keys`);
        db.run("INSERT INTO d1_migrations(name) VALUES (?)", [name]);
      })();
    } finally {
      db.run("PRAGMA foreign_keys = ON");
    }
    applied.push(name);
  }
  return applied;
}

export type SqliteD1PreparedStatement = D1PreparedStatementLike & D1BoundStatementLike;
export type SqliteD1Database = D1DatabaseLike & {
  prepare(sql: string): SqliteD1PreparedStatement;
};

type BatchResult = { results: unknown[]; success: true; meta: { changes: number } };
type LocalStatement = D1BoundStatementLike & { executeSync(): BatchResult };

/**
 * D1 over one Bun SQLite connection.
 *
 * A batch runs synchronously from BEGIN to COMMIT: the connection is shared by
 * every request, so yielding inside the transaction would let another
 * request's statements run in it, or let a second batch see the transaction
 * open and skip its own.
 */
export function createD1DatabaseFromSqlite(db: Database): SqliteD1Database {
  return {
    prepare(sql: string): SqliteD1PreparedStatement {
      const createStatement = (...values: SqlValue[]): LocalStatement => ({
        async first<T = unknown>() {
          return (db.query(sql).get(...values) as T | null) ?? null;
        },
        async all<T = unknown>() {
          return { results: db.query(sql).all(...values) as T[] };
        },
        async run() {
          const result = db.query(sql).run(...values);
          return { success: true, meta: { changes: result.changes } };
        },
        executeSync() {
          // Cloudflare D1 returns rows for SELECT/RETURNING statements inside a batch;
          // a plain .run() silently discards those rows and breaks shop-data exports.
          const returning = /\bRETURNING\b/i.test(sql);
          if (/^(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql.trim()) || returning) {
            const results = db.query(sql).all(...values) as unknown[];
            const changes = returning
              ? (db.query("SELECT changes() AS changes").get() as { changes: number } | null)?.changes ?? 0
              : 0;
            return { results, success: true, meta: { changes } };
          }
          const result = db.query(sql).run(...values);
          return { results: [], success: true, meta: { changes: result.changes } };
        },
      });
      return {
        ...createStatement(),
        bind(...values: SqlValue[]) {
          return createStatement(...values);
        },
      };
    },

    async batch(statements: readonly D1BoundStatementLike[]) {
      if (statements.length === 0) return [];
      for (const statement of statements) {
        if (typeof (statement as Partial<LocalStatement>).executeSync !== "function") {
          throw new Error("A local D1 batch only takes statements prepared on the same database");
        }
      }
      return db.transaction(() => statements.map((statement) => (statement as LocalStatement).executeSync()))();
    },
  };
}
