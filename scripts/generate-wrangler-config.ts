import { mkdir } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const outputPath = fileURLToPath(new URL("../wrangler.generated.jsonc", import.meta.url));
const redirectPath = fileURLToPath(new URL("../.wrangler/deploy/config.json", import.meta.url));
const localOnly = Bun.argv.includes("--local");
const platform = Bun.argv.includes("--platform");

const workerName = readOptional("PRISM_WORKER_NAME") ?? "prism-api";
const databaseName = readOptional("PRISM_D1_DATABASE_NAME") ?? "prism";
const databaseId = readOptional("PRISM_D1_DATABASE_ID") ?? (localOnly ? "00000000-0000-0000-0000-000000000000" : undefined);
const previewDatabaseId = readOptional("PRISM_D1_PREVIEW_DATABASE_ID");

if (!databaseId) {
  throw new Error(
    "PRISM_D1_DATABASE_ID is required. Set it in .env locally or in Cloudflare Workers Builds variables.",
  );
}

validateWorkerName(workerName);
validateDatabaseId("PRISM_D1_DATABASE_ID", databaseId);
if (previewDatabaseId) validateDatabaseId("PRISM_D1_PREVIEW_DATABASE_ID", previewDatabaseId);

const databaseBinding: Record<string, string> = {
  binding: "DB",
  database_name: databaseName,
  database_id: databaseId,
};
if (previewDatabaseId) databaseBinding.preview_database_id = previewDatabaseId;

const config: Record<string, unknown> = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: workerName,
  main: "packages/runtime/src/worker.ts",
  compatibility_date: "2026-06-07",
  d1_databases: [databaseBinding],
  vars: {},
  observability: {
    enabled: true,
  },
};

if (platform) {
  const template = await Bun.file(new URL("../wrangler.platform.jsonc", import.meta.url)).json();
  const required = (name: string, localDefault: string): string => {
    const value = readOptional(name) ?? (localOnly ? localDefault : undefined);
    if (!value) throw new Error(`${name} is required in Cloudflare Workers Builds variables.`);
    return value;
  };
  const accountId = required("PRISM_ACCOUNT_ID", "00000000000000000000000000000000");
  const kvId = required("PRISM_KV_RATE_LIMIT_ID", "00000000000000000000000000000000");
  for (const [name, value] of [["PRISM_ACCOUNT_ID", accountId], ["PRISM_KV_RATE_LIMIT_ID", kvId]]) {
    if (!/^[0-9a-f]{32}$/i.test(value!)) throw new Error(`${name} must be a 32-character hexadecimal ID.`);
  }
  const appOrigin = required("PRISM_APP_ORIGIN", "http://localhost:8787");
  const parsedOrigin = new URL(appOrigin);
  if (parsedOrigin.origin !== appOrigin || !["http:", "https:"].includes(parsedOrigin.protocol)) {
    throw new Error("PRISM_APP_ORIGIN must be an HTTP(S) origin without a trailing slash.");
  }
  const route = readOptional("PRISM_ROUTE_PATTERN");
  Object.assign(config, template, {
    name: workerName,
    ...(!localOnly ? { account_id: accountId } : {}),
    d1_databases: [{ ...databaseBinding, migrations_dir: "migrations" }],
    kv_namespaces: [{ binding: "RATE_LIMIT", id: kvId }],
    workers_dev: !route,
    preview_urls: false,
    routes: route ? [{ pattern: route.replace(/\/\*$/, ""), custom_domain: true }] : [],
    vars: {
      APP_ORIGIN: appOrigin,
      MUNET_CLIENT_ID: required("PRISM_MUNET_CLIENT_ID", "local-munet-client"),
      APPLE_TEAM_ID: required("PRISM_APPLE_TEAM_ID", "LOCALTEAM"),
      ANDROID_CERT_FINGERPRINTS: readOptional("PRISM_ANDROID_CERT_FINGERPRINTS") ?? "",
      EXTRA_ALLOWED_ORIGINS: readOptional("PRISM_EXTRA_ALLOWED_ORIGINS") ?? "",
    },
  });
}

await Bun.write(outputPath, `${JSON.stringify(config, null, 2)}\n`);
await mkdir(dirname(redirectPath), { recursive: true });
await Bun.write(redirectPath, '{"configPath":"../../wrangler.generated.jsonc"}\n');

console.log(`Generated ${relative(projectRoot, outputPath)} for Worker ${workerName}.`);

function readOptional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function validateWorkerName(value: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,253}[a-z0-9])?$/.test(value)) {
    throw new Error("PRISM_WORKER_NAME must contain only lowercase letters, digits, and interior dashes.");
  }
}

function validateDatabaseId(name: string, value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a D1 database UUID.`);
  }
}
