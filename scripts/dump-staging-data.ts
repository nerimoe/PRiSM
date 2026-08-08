import { Database } from "bun:sqlite";

const db = new Database("prism-staging.sqlite");

const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];

let sql = "PRAGMA foreign_keys=OFF;\n\n";

for (const { name: tableName } of tables) {
  const rows = db.query(`SELECT * FROM "${tableName}"`).all() as Record<string, any>[];
  if (rows.length === 0) continue;

  sql += `-- Data for ${tableName}\n`;
  for (const row of rows) {
    const columns = Object.keys(row);
    const values = columns.map(col => {
      const val = row[col];
      if (val === null || val === undefined) return "NULL";
      if (typeof val === "number") return String(val);
      if (typeof val === "boolean") return val ? "1" : "0";
      const escaped = String(val).replace(/'/g, "''");
      return `'${escaped}'`;
    });

    sql += `INSERT INTO "${tableName}" (${columns.map(c => `"${c}"`).join(", ")}) VALUES (${values.join(", ")});\n`;
  }
  sql += "\n";
}

await Bun.write("exports/prism-next-data.sql", sql);
console.log("Staging data dumped successfully with explicit columns to exports/prism-next-data.sql!");
db.close();
