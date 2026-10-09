#!/usr/bin/env node
"use strict";

/**
 * Guard against exposing internal authentication principals in public JSON.
 * Keep the check independent of route mocks: analyze actual server TS source.
 * Run in CI with: node scripts/check-public-api-dtos.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const sourceRoot = path.resolve(__dirname, "../packages/server/src");

function analyze(source, file = "sample.ts") {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const principals = new Set(["principal", "authPrincipal", "authenticatedPrincipal"]);

  // Identify aliases including "p = await staffPrincipal(...)" used by legacy routes.
  function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = node.initializer.getText(sf);
      if (/\b(?:staffPrincipal|requireStandaloneStaff)\s*\(/.test(initializer)) {
        principals.add(node.name.text);
      }
    }
    ts.forEachChild(node, collect);
  }
  collect(sf);

  const violations = [];
  function violation(node, reason) {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push(`${file}:${line + 1} ${reason}`);
  }
  function isPrincipal(expr) {
    return ts.isIdentifier(expr) && principals.has(expr.text);
  }
  function inspectValue(expr) {
    if (isPrincipal(expr)) {
      violation(expr, "internal principal returned directly in JSON");
      return;
    }
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) ||
        ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)) {
      inspectValue(expr.expression);
      return;
    }
    if (ts.isPropertyAccessExpression(expr)) {
      if (isPrincipal(expr.expression) && expr.name.text === "role") {
        violation(expr, "principal.role is an internal auth discriminator, not an API role");
      }
      return;
    }
    if (ts.isObjectLiteralExpression(expr)) {
      for (const p of expr.properties) {
        if (ts.isSpreadAssignment(p)) inspectValue(p.expression);
        else if (ts.isPropertyAssignment(p)) {
          const key = p.name.getText(sf).replace(/^["']|["']$/g, "");
          if (key === "staff" && ts.isObjectLiteralExpression(p.initializer)) {
            for (const property of p.initializer.properties) {
              if (!ts.isPropertyAssignment(property)) continue;
              const name = property.name.getText(sf).replace(/^["']|["']$/g, "");
              if (["staffRole", "principalRole", "staffId"].includes(name)) {
                violation(property, `internal ${name} must not appear inside public staff DTO`);
              }
              if (name === "role" && ts.isStringLiteral(property.initializer) &&
                  property.initializer.text === "staff") {
                violation(property, 'public staff.role must be a shop role, never "staff"');
              }
            }
          }
          inspectValue(p.initializer);
        }
        else if (ts.isShorthandPropertyAssignment(p) && principals.has(p.name.text)) {
          violation(p, "internal principal serialized using shorthand property");
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(expr)) {
      for (const element of expr.elements) inspectValue(element);
      return;
    }
    if (ts.isConditionalExpression(expr)) {
      inspectValue(expr.whenTrue);
      inspectValue(expr.whenFalse);
    }
  }

  function findJson(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "json" && node.arguments.length) {
      // Only outgoing context.json(...), not JSON.parse or internal JSON.stringify.
      const context = node.expression.expression;
      if (ts.isIdentifier(context) && ["c", "ctx", "context"].includes(context.text)) {
        inspectValue(node.arguments[0]);
      }
    }
    ts.forEachChild(node, findJson);
  }
  findJson(sf);
  return violations;
}

function files(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap(entry => {
    const resolved = path.join(dir, entry.name);
    return entry.isDirectory() ? files(resolved)
      : entry.isFile() && entry.name.endsWith(".ts") ? [resolved] : [];
  });
}

// Self-test the checker so a future refactor cannot silently weaken its logic.
for (const [snippet, mustFail] of [
  ['const principal = await staffPrincipal(c, shop); return c.json({staff: principal});', true],
  ['const p = await requireStandaloneStaff(c); return c.json({staff: p});', true],
  ['return c.json({...principal});', true],
  ['return c.json(principal);', true],
  ['return c.json({staff: {role: principal.role}});', true],
  ['return c.json({staff: {role: "staff", staffRole: principal.staffRole}});', true],
  ['return c.json({staff: {id: "i", displayName: "n", role: "owner", canWrite: true}});', false],
  ['return c.json({ staff: await staffMeView(c, shop, principal) });', false],
  ['return c.json({staff: {id: principal.staffId, role: principal.staffRole}});', false],
]) {
  assert.equal(analyze(snippet).length > 0, mustFail, `DTO guard test failed: ${snippet}`);
}

const sourceFiles = files(sourceRoot);
const violations = sourceFiles.flatMap(file => analyze(fs.readFileSync(file, "utf8"), path.relative(process.cwd(), file)));
if (violations.length) {
  console.error("Internal auth data leaked through JSON responses:\n" + violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Public DTO boundary check passed: ${sourceFiles.length} server TS files; no raw auth principals serialized`);
}
