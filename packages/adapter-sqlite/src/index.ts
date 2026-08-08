import type { Database } from "bun:sqlite";
import { createSqlRepositories, type SqlExecutor, type SqlRepositories, type SqlStatement, type SqlValue } from "@prism/storage-sql";

export type SqliteRepositories = SqlRepositories;

export type CreateSqliteRepositoriesInput = {
  db: Database;
  id: () => string;
  now: () => Date;
};

export function createSqliteRepositories(input: CreateSqliteRepositoriesInput): SqliteRepositories {
  return createSqlRepositories({
    executor: createBunSqliteExecutor(input.db),
    id: input.id,
    now: input.now,
  });
}

export function createBunSqliteExecutor(db: Database): SqlExecutor {
  return {
    async first<T>(sql: string, params: readonly SqlValue[] = []) {
      return (db.query(sql).get(...toMutableParams(params)) as T | null) ?? null;
    },

    async all<T>(sql: string, params: readonly SqlValue[] = []) {
      return db.query(sql).all(...toMutableParams(params)) as T[];
    },

    async run(sql: string, params: readonly SqlValue[] = []) {
      try {
        db.run(sql, toMutableParams(params));
      } catch (error) {
        console.error("SQL Run Error:", error);
        console.error("SQL query:", sql);
        console.error("SQL params:", params);
        throw error;
      }
    },

    async batch(statements: readonly SqlStatement[]) {
      if (statements.length === 0) return;
      db.run("BEGIN");
      try {
        for (const statement of statements) {
          db.run(statement.sql, toMutableParams(statement.params ?? []));
        }
        db.run("COMMIT");
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {}
        throw error;
      }
    },
  };
}

function toMutableParams(params: readonly SqlValue[]): SqlValue[] {
  return [...params];
}
