import { createSqlRepositories, type SqlExecutor, type SqlRepositories, type SqlStatement, type SqlValue } from "@prism/storage-sql";

export type D1Repositories = SqlRepositories;

export type D1Result<T> = {
  results: T[];
};

export type D1BoundStatementLike = {
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
};

export type D1PreparedStatementLike = {
  bind(...values: SqlValue[]): D1BoundStatementLike;
};

export type D1DatabaseLike = {
  prepare(sql: string): D1PreparedStatementLike;
  batch(statements: readonly D1BoundStatementLike[]): Promise<unknown>;
};

export type CreateD1RepositoriesInput = {
  db: D1DatabaseLike;
  id: () => string;
  now: () => Date;
};

export function createD1Repositories(input: CreateD1RepositoriesInput): D1Repositories {
  return createSqlRepositories({
    executor: createD1Executor(input.db),
    id: input.id,
    now: input.now,
  });
}

export function createD1Executor(db: D1DatabaseLike): SqlExecutor {
  return {
    async first<T>(sql: string, params: readonly SqlValue[] = []) {
      return db.prepare(sql).bind(...params).first<T>();
    },

    async all<T>(sql: string, params: readonly SqlValue[] = []) {
      const result = await db.prepare(sql).bind(...params).all<T>();
      return result.results;
    },

    async run(sql: string, params: readonly SqlValue[] = []) {
      await db.prepare(sql).bind(...params).run();
    },

    async batch(statements: readonly SqlStatement[]) {
      if (statements.length === 0) return;
      await db.batch(statements.map((statement) =>
        db.prepare(statement.sql).bind(...(statement.params ?? [])),
      ));
    },
  };
}

export type { SqlValue };
