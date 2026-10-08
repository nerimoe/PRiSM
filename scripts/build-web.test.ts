import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = new URL("../", import.meta.url);

test("Workers Builds prepares platform bindings before the existing Web build command", async () => {
  const root = mkdtempSync(join(tmpdir(), "prism-workers-build-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "packages/prism-web"), { recursive: true });
    for (const path of ["scripts/build-web.ts", "scripts/generate-wrangler-config.ts", "wrangler.jsonc"]) {
      copyFileSync(new URL(path, source), join(root, path));
    }
    const scripts = (await Bun.file(new URL("package.json", source)).json()).scripts;
    await Bun.write(join(root, "package.json"), JSON.stringify({ scripts: { "build:web": scripts["build:web"] } }));
    await Bun.write(join(root, "packages/prism-web/package.json"), JSON.stringify({ scripts: { build: "bun run verify.ts" } }));
    await Bun.write(join(root, "packages/prism-web/verify.ts"), `
      if (process.env.WORKERS_CI === "1") {
        const config = await Bun.file("../../wrangler.generated.jsonc").json();
        if (config.main !== "packages/server/src/worker.ts" || !config.assets || !config.durable_objects || !config.ratelimits) throw new Error("Wrong Worker configuration");
        const redirect = await Bun.file("../../.wrangler/deploy/config.json").json();
        if (redirect.configPath !== "../../wrangler.generated.jsonc") throw new Error("Missing upload redirect");
      }
      await Bun.write("../../built", "ok");
    `);
    const variables = {
      PATH: process.env.PATH!, WORKERS_CI: "1", WRANGLER_CI_OVERRIDE_NAME: "prism-link-beta",
      D1_DATABASE_ID: "11111111-1111-1111-1111-111111111111", CLOUDFLARE_ACCOUNT_ID: "1".repeat(32),
      APP_ORIGIN: "https://test.example", MUNET_CLIENT_ID: "test", APPLE_TEAM_ID: "TESTTEAM",
    };
    const run = (env: Record<string, string>) => Bun.spawnSync([process.execPath, "run", "build:web"], {
      cwd: root, env, stdout: "pipe", stderr: "pipe",
    });
    const result = run(variables);
    expect(new TextDecoder().decode(result.stderr)).not.toContain("error:");
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(join(root, "built")).exists()).toBe(true);
    const config = await Bun.file(join(root, "wrangler.generated.jsonc")).json();
    expect(config.name).toBe("prism-link-beta");
    expect(config.d1_databases[0].database_id).toBe(variables.D1_DATABASE_ID);
    for (const databaseId of ["", "replace-with-your-d1-database-id", "00000000-0000-0000-0000-000000000000"]) {
      rmSync(join(root, "built"));
      const failure = run({ ...variables, D1_DATABASE_ID: databaseId });
      expect(failure.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(failure.stderr)).toContain("D1_DATABASE_ID");
      expect(await Bun.file(join(root, "built")).exists()).toBe(false);
      await Bun.write(join(root, "built"), "reset");
    }
    rmSync(join(root, "wrangler.generated.jsonc"));
    expect(run({ PATH: process.env.PATH!, WORKERS_CI: "0" }).exitCode).toBe(0);
    expect(await Bun.file(join(root, "wrangler.generated.jsonc")).exists()).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
