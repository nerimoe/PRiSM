import { createD1Executor, type D1DatabaseLike } from "@prism/adapter-d1";
import { migrateLegacyPricingToUtc } from "@prism/storage-sql";

const migrations = new WeakMap<object, Promise<unknown>>();

export function ensureD1UtcPricing(
  db: D1DatabaseLike,
  now = new Date(),
): Promise<unknown> {
  const existing = migrations.get(db);
  if (existing) return existing;
  const migration = migrateLegacyPricingToUtc({
    executor: createD1Executor(db),
    now,
    id: () => crypto.randomUUID(),
  }).catch((error) => {
    migrations.delete(db);
    throw error;
  });
  migrations.set(db, migration);
  return migration;
}
