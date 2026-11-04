import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { convertPlatformData, utcWriteGuards, verifyPlatformData } from "../deployment-gate.js";
import { applyMigrations, createD1DatabaseFromSqlite, defaultMigrationsDir, migrationFiles, openLocalDatabase } from "./database.js";

/**
 * Releases for the local deployment, done while the server is stopped instead
 * of through `deploy:beta`'s maintenance phases: back up, migrate, convert,
 * verify. A failure leaves the backup to restore; nothing was serving.
 */
export type UpgradeResult = { backup: string | null; applied: string[]; conversions: unknown };

export function objectsPathFor(databasePath: string): string {
  return databasePath === ":memory:" ? ":memory:" : databasePath.replace(/(\.sqlite3?|\.db)?$/, ".objects.sqlite");
}

export function pendingMigrations(db: Database, dir = defaultMigrationsDir): string[] {
  const ledger = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='d1_migrations'").get();
  const done = new Set(ledger?.n
    ? db.query<{ name: string }, []>("SELECT name FROM d1_migrations").all().map((row) => row.name)
    : []);
  return migrationFiles(dir).filter((name) => !done.has(name));
}

/** A consistent copy of a live database (`VACUUM INTO`), next to it under `backups/`. */
export function backupLocalDatabase(databasePath: string, label = "manual", directory?: string): string[] {
  const folder = directory ?? resolve(dirname(databasePath), "backups");
  mkdirSync(folder, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const written: string[] = [];
  for (const path of [databasePath, objectsPathFor(databasePath)]) {
    if (!existsSync(path)) continue;
    const target = resolve(folder, `${basename(path).replace(/\.sqlite$/, "")}-${stamp}-${label}.sqlite`);
    const db = openLocalDatabase(path);
    try {
      db.run("VACUUM INTO ?", [target]);
    } finally {
      db.close();
    }
    written.push(target);
  }
  return written;
}

export async function upgradeLocalDatabase(input: {
  databasePath: string;
  migrationsDir?: string;
  backupDir?: string;
}): Promise<UpgradeResult> {
  assertStopped(input.databasePath);
  const existed = existsSync(input.databasePath);
  const backup = existed ? backupLocalDatabase(input.databasePath, "before-upgrade", input.backupDir)[0] ?? null : null;
  const db = openLocalDatabase(input.databasePath);
  try {
    const applied = applyMigrations(db, input.migrationsDir);
    const d1 = createD1DatabaseFromSqlite(db);
    const conversions = await convertPlatformData(d1);
    for (const sql of utcWriteGuards) db.run(sql);
    await verifyPlatformData(d1);
    return { backup, applied, conversions };
  } finally {
    db.close();
  }
}

/** Put a backup back in place of the database (and its objects file, when one was taken). */
export function restoreLocalDatabase(databasePath: string, backupPath: string): void {
  assertStopped(databasePath);
  if (!existsSync(backupPath)) throw new Error(`No backup at ${backupPath}`);
  const objectsBackup = backupPath.replace(/^(.*?)-(\d{4}-\d{2}-\d{2}T)/, (_, name, rest) => `${name}.objects-${rest}`);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(databasePath + suffix, { force: true });
  writeFileSync(databasePath, readFileSync(backupPath));
  const objectsPath = objectsPathFor(databasePath);
  if (existsSync(objectsBackup)) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(objectsPath + suffix, { force: true });
    writeFileSync(objectsPath, readFileSync(objectsBackup));
  }
}

/** The running server holds `<database>.pid`; upgrades and restores refuse while it is alive. */
export function pidPathFor(databasePath: string) {
  return `${databasePath}.pid`;
}

export function assertStopped(databasePath: string): void {
  if (databasePath === ":memory:") return;
  const pidPath = pidPathFor(databasePath);
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (pid && isAlive(pid)) {
    throw new Error(`The local server (pid ${pid}) is using ${databasePath}; stop it first`);
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
