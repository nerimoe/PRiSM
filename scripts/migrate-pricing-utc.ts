import { Database } from "bun:sqlite";
import { createBunSqliteExecutor } from "../packages/adapter-sqlite/src";
import { migrateLegacyPricingToUtc } from "../packages/storage-sql/src";
import { initializeSqliteSchema } from "../packages/server/src";

const path = Bun.argv[2] ?? process.env.PRISM_SQLITE_PATH;
if (!path || !(await Bun.file(path).exists())) throw new Error("Usage: bun run scripts/migrate-pricing-utc.ts <existing SQLite file>");
const db = new Database(path);
try {
  initializeSqliteSchema(db);
  console.log(await migrateLegacyPricingToUtc({ executor: createBunSqliteExecutor(db), now: new Date(), id: () => crypto.randomUUID() }));
} finally {
  db.close();
}
