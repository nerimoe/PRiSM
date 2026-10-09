#!/usr/bin/env node
"use strict";

const ts = require("typescript");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const historical = "packages/server/test/fixtures/pre-merge-views.ts.txt";
const current = "packages/server/src/routes/shops/views.ts";

function getFunctionBodies(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const result = new Map();
  for (const statement of sf.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
    if (!(statement.modifiers || []).some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const body = printer.printNode(ts.EmitHint.Unspecified, statement.body, sf)
      .replace(/\r\n/g, "\n").trim();
    result.set(statement.name.text, body);
  }
  return result;
}

function compare(original, updated) {
  const changed = [];
  for (const [name, expected] of original) {
    const actual = updated.get(name);
    if (actual === undefined) changed.push(`${name}: public serializer removed`);
    else if (actual !== expected) changed.push(`${name}: serializer implementation changed`);
  }
  return changed;
}

// A test of the checker itself: it must detect missing and changed serializers.
assert.deepEqual(compare(new Map([["x", "return { role: role };"]]),
  new Map([["x", "return { role: staffRole };"]])),
  ["x: serializer implementation changed"]);
assert.deepEqual(compare(new Map([["x", "body"]]), new Map()), ["x: public serializer removed"]);

const baseline = getFunctionBodies(historical, fs.readFileSync(path.join(root, historical), "utf8"));
const live = getFunctionBodies(current, fs.readFileSync(path.join(root, current), "utf8"));
assert(baseline.size >= 31, "Historical serializer fixture is unexpectedly incomplete");
const differences = compare(baseline, live);
if (differences.length) {
  console.error("Historic API response view parity broken:\n" + differences.join("\n"));
  console.error("Compare against commit 7fd7e7c. If intentionally changing public API,");
  console.error("document the migration and add consumer contract tests before editing the baseline.");
  process.exitCode = 1;
} else {
  console.log(`Pre-merge API view parity passed: ${baseline.size} serializers unchanged`);
}
