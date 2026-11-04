/**
 * The local (standby) deployment: the platform on this machine instead of
 * Cloudflare. See docs/local-deployment.md.
 *
 *   bun run local:upgrade    back up, apply migrations and data conversions, verify (server stopped)
 *   bun run local:start      serve on PORT (default 8787), with the built web app
 *   bun run local:backup     consistent copy of the database files, safe while serving
 *   bun run local:restore <backup.sqlite>   put a backup back (server stopped)
 *
 * PRISM_SQLITE_PATH picks the database (default ./data/prism.sqlite); the
 * Worker's vars and secrets come from the environment (an .env file works).
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { envFromProcess, startLocalRuntime } from "../packages/server/src/local/runtime";
import { backupLocalDatabase, restoreLocalDatabase, upgradeLocalDatabase } from "../packages/server/src/local/upgrade";

const root = fileURLToPath(new URL("..", import.meta.url));
const databasePath = resolve(process.env.PRISM_SQLITE_PATH ?? resolve(root, "data/prism.sqlite"));
mkdirSync(dirname(databasePath), { recursive: true });
const [command, ...args] = Bun.argv.slice(2);

async function revision() {
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(child.stdout).text()).trim();
  return /^[0-9a-f]{40}$/.test(out) ? out : undefined;
}

switch (command) {
  case "upgrade": {
    const result = await upgradeLocalDatabase({ databasePath });
    console.log(result.backup ? `Backup: ${result.backup}` : "New database; no backup taken");
    console.log(result.applied.length ? `Applied ${result.applied.length} migrations: ${result.applied.join(", ")}` : "Schema already current");
    console.log("Data conversions and checks passed:", JSON.stringify(result.conversions));
    break;
  }
  case "start": {
    const port = Number.parseInt(process.env.PORT ?? "8787", 10);
    const runtime = startLocalRuntime({
      databasePath,
      port,
      hostname: process.env.HOST,
      assetsDir: resolve(root, "packages/prism-web/dist"),
      env: { ...envFromProcess(), PRISM_DEPLOY_REVISION: process.env.PRISM_DEPLOY_REVISION ?? await revision() },
    });
    console.log(`PRiSM local deployment on http://${process.env.HOST ?? "localhost"}:${runtime.server.port} (${databasePath})`);
    const shutdown = async (signal: string) => {
      console.log(`${signal}: stopping`);
      await runtime.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    break;
  }
  case "backup": {
    for (const path of backupLocalDatabase(databasePath, "manual", args[0])) console.log(`Backup: ${path}`);
    break;
  }
  case "restore": {
    if (!args[0]) throw new Error("Usage: bun run local:restore <backup.sqlite>");
    restoreLocalDatabase(databasePath, resolve(args[0]));
    console.log(`Restored ${args[0]} to ${databasePath}`);
    break;
  }
  default:
    console.error("Usage: bun run scripts/local.ts <upgrade|start|backup|restore>");
    process.exit(1);
}
