import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../../..");

test("backend layering keeps SQL out of domain, application, transport, and runtime code", () => {
  for (const packageName of ["core", "application", "server-hono", "runtime"]) {
    for (const filePath of listTypeScriptFiles(resolve(projectRoot, "packages", packageName, "src"))) {
      const source = readFileSync(filePath, "utf8");
      expect(source).not.toMatch(/\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i);
    }
  }
});

test("inner backend packages never depend on the Hono transport package", () => {
  for (const packageName of ["core", "application", "storage-sql"]) {
    const packageDir = resolve(projectRoot, "packages", packageName);
    const files = [
      resolve(packageDir, "package.json"),
      ...listTypeScriptFiles(resolve(packageDir, "src")),
    ];
    for (const filePath of files) {
      expect(readFileSync(filePath, "utf8")).not.toContain("@prism/server-hono");
    }
  }
});

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const filePath = resolve(directory, name);
    return statSync(filePath).isDirectory()
      ? listTypeScriptFiles(filePath)
      : name.endsWith(".ts") ? [filePath] : [];
  });
}
