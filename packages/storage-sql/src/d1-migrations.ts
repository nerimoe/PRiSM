/** Split D1 migration SQL without cutting quoted values or BEGIN/END trigger bodies. */
export function splitD1MigrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let depth = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    if (char === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      current += "\n";
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index += 1;
      current += " ";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      current += char;
      while (++index < sql.length) {
        current += sql[index];
        if (sql[index] !== char) continue;
        if (sql[index + 1] === char) { current += sql[++index]; continue; }
        break;
      }
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let word = char;
      while (index + 1 < sql.length && /[A-Za-z0-9_]/.test(sql[index + 1]!)) word += sql[++index];
      if (word.toUpperCase() === "BEGIN") depth += 1;
      if (word.toUpperCase() === "END") depth = Math.max(0, depth - 1);
      current += word;
      continue;
    }
    if (char === ";" && depth === 0) {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}
