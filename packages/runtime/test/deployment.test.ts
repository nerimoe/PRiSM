import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { sqliteSchema } from "@prism/storage-sql";
import { readdirSync } from "node:fs";

const projectRoot = new URL("../../../", import.meta.url);

async function readProjectFile(path: string): Promise<string> {
  return Bun.file(new URL(path, projectRoot)).text();
}

describe("deployment artifacts", () => {
  it("documents both local SQLite and Cloudflare D1 deployment paths", async () => {
    const deployment = await readProjectFile("docs/deployment.md");

    expect(deployment).toContain("bun run dev:local");
    expect(deployment).toContain("PRISM_SQLITE_PATH");
    expect(deployment).toContain("OOBE");
    expect(deployment).not.toContain("wrangler secret put PRISM_PLAYER_TOKEN");
    expect(deployment).not.toContain("wrangler secret put PRISM_STAFF_TOKEN");
    expect(deployment).not.toContain("wrangler secret put PRISM_STAFF_TOKENS");
    expect(deployment).not.toContain("wrangler secret put PRISM_INTEGRATION_TOKEN");
    expect(deployment).not.toContain("wrangler secret put PRISM_MACHINE_TOKEN");
    expect(deployment).toContain("bun run db:create:d1");
    expect(deployment).toContain("bun run db:migrate:local");
    expect(deployment).toContain("bun run db:migrate:remote");
    expect(deployment).toContain("bun run deploy:worker");
    expect(deployment).toContain("PRISM_D1_DATABASE_ID");
    expect(deployment).toContain("Cloudflare Workers Builds");
    expect(deployment).toContain("migrations/0001_initial.sql");
    expect(deployment).toContain("migrations/0012_canonical_device_targets.sql");
    expect(deployment).toContain("migrations/0013_player_checkouts.sql");
    expect(await readProjectFile("docs/migration-from-prism-neo.md")).toContain("bun run migration:import-json --input");
  });

  it("keeps store-facing documentation aligned with the current Staff Web wording and pricing lifecycle", async () => {
    const docs = {
      readme: await readProjectFile("README.md"),
      deployment: await readProjectFile("docs/deployment.md"),
      integrationsAndMachines: await readProjectFile("docs/integrations-and-machines.md"),
      roadmap: await readProjectFile("docs/roadmap.md"),
      checklist: await readProjectFile("docs/deployment.md"), // checklist was merged into deployment.md
      architecture: await readProjectFile("docs/architecture.md"),
      api: await readProjectFile("docs/api.md"),
    };
    const combined = Object.values(docs).join("\n");

    expect(docs.integrationsAndMachines).toContain("Integration player actions");
    expect(docs.integrationsAndMachines).toContain("机器软件接入");
    expect(docs.deployment).toContain("「接入凭证」");
    expect(docs.readme).toContain("weekday/specific-date/date-range rule forms");
    expect(docs.roadmap).toContain("date-range");
    expect(docs.roadmap).toContain("在可视化编辑器中删除错误的草稿规则");
    expect(docs.checklist).toContain("pricing archive/restore");
    expect(docs.architecture).toContain("已保存的时间规则也按归档处理");
    expect(docs.architecture).toContain("未保存的草稿时间规则才会物理移除");
    expect(docs.api).toContain("未保存的草稿规则可以直接移除");
    expect(docs.api).toContain("已保存规则会写回 `status: \"archived\"`");

    expect(combined).not.toContain("Staff Web 「接口凭证」");
    expect(combined).not.toContain("limited-event");
    expect(combined).not.toContain("rule-level archive/restore");
    expect(combined).not.toContain("archive/restore rule actions");
    expect(combined).not.toContain("Web shell");
    expect(combined).not.toContain("Priority time pricing also supports rule-level archive status");
    expect(combined).not.toContain("Individual `time.priority` rules may also carry `status: \"archived\"`");
    expect(combined).not.toContain("archiving a time rule is a lifecycle change");
  });

  it("exposes deployment scripts from the root package", async () => {
    const packageJson = JSON.parse(await readProjectFile("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts).toMatchObject({
      "dev:local": "bun run packages/runtime/src/serve.ts",
      "wrangler:config": "bun run scripts/generate-wrangler-config.ts",
      "dev:worker": "bun run scripts/generate-wrangler-config.ts --local && wrangler dev --config wrangler.generated.jsonc",
      "deploy:worker": "bun run scripts/generate-wrangler-config.ts && wrangler d1 migrations apply DB --config wrangler.generated.jsonc --remote && bun run scripts/release.ts deploy-worker",
      "prism-dashboard:build": "bun run scripts/release.ts build-dashboard",
      "version:bump": "bun run scripts/release.ts bump",
      "db:create:d1": "wrangler d1 create prism",
      "db:migrate:local": "bun run scripts/generate-wrangler-config.ts --local && wrangler d1 migrations apply DB --config wrangler.generated.jsonc --local",
      "db:migrate:remote": "bun run scripts/generate-wrangler-config.ts && wrangler d1 migrations apply DB --config wrangler.generated.jsonc --remote",
      "migration:import-json": "bun run packages/migration/src/cli.ts import-json",
    });
  });

  it("keeps public deployment files free of account-specific Cloudflare identifiers", async () => {
    const wrangler = JSON.parse(await readProjectFile("wrangler.jsonc")) as {
      d1_databases: Array<{ binding: string; database_name: string; database_id: string }>;
    };
    const envExample = await readProjectFile(".env.example");
    const gitignore = await readProjectFile(".gitignore");
    const generator = await readProjectFile("scripts/generate-wrangler-config.ts");

    expect(wrangler.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "prism",
        database_id: "replace-with-your-d1-database-id",
      },
    ]);
    expect(envExample).toContain("PRISM_D1_DATABASE_ID=");
    expect(envExample).toContain("PRISM_D1_PREVIEW_DATABASE_ID=");
    expect(gitignore).toContain("/wrangler.generated.jsonc");
    expect(gitignore).toContain("exports/");
    expect(gitignore).toContain("/mmw_prism.sql");
    expect(generator).toContain(".wrangler/deploy/config.json");
    expect(generator).toContain("PRISM_D1_DATABASE_ID");
  });

  it("keeps the D1 migrations aligned with the executable SQLite schema", async () => {
    const schemaDb = new Database(":memory:");
    const migrationDb = new Database(":memory:");
    schemaDb.run("PRAGMA foreign_keys = ON");
    migrationDb.run("PRAGMA foreign_keys = ON");

    for (const statement of sqliteSchema) {
      schemaDb.run(statement);
    }

    for (const fileName of readdirSync(new URL("migrations", projectRoot)).filter((name) => name.endsWith(".sql")).sort()) {
      const migrationSql = await readProjectFile(`migrations/${fileName}`);
      for (const statement of migrationSql.split(";").map((item) => item.trim()).filter(Boolean)) {
        migrationDb.run(statement);
      }
    }

    const tableNames = schemaDb
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);

    expect(
      migrationDb
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name),
    ).toEqual(tableNames);

    for (const tableName of tableNames) {
      const columns = (db: Database) =>
        db
          .query<{ name: string; type: string }, [string]>("SELECT name, type FROM pragma_table_info(?)")
          .all(tableName)
          .sort((a, b) => a.name.localeCompare(b.name));
      expect(columns(migrationDb)).toEqual(columns(schemaDb));
    }
  });
});
