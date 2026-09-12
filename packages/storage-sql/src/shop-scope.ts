import type { SqlExecutor } from "./repositories";

/** Used only with server-resolved shop IDs; values remain SQL parameters. */
export function sqlShop(executor: Pick<SqlExecutor, "shopId">): string {
  const shopId = executor.shopId ?? "legacy";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(shopId)) throw new Error("Invalid shop ID");
  return `'${shopId}'`;
}

/** Adds the scope to internally generated placeholder groups, never user SQL. */
export function shopValues(executor: SqlExecutor, groups: string): string {
  return groups.replaceAll("(", `(${sqlShop(executor)}, `);
}
