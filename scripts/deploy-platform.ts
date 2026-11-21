import { assertDeploymentBranch } from "./deployment-branch";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomToken, sha256 } from "../packages/server/src/crypto";
import { deploymentHealth, deploymentRequest } from "./deployment-control-client";
import { deploymentControlPath } from "../packages/server/src/deployment-gate";
import { deployPlatform, type PlatformDeploymentSteps } from "./deploy-platform-flow";
import { deployWorker, deploymentCommand as command, tailLines } from "./deploy-worker";
import { enterDeployQueue, type DeployTurn } from "./deploy-queue";
import { sendMaintenanceNotice } from "./deployment-control-client";

assertDeploymentBranch(process.env);

const root = fileURLToPath(new URL("..", import.meta.url));
const configPath = resolve(root, "wrangler.generated.jsonc");
const base = await Bun.file(configPath).json();
if (base.main !== "packages/server/src/worker.ts" || !base.vars?.APP_ORIGIN)
  throw new Error("Generate the platform configuration before running this script");
const origin = new URL(base.vars.APP_ORIGIN);
if (origin.protocol !== "https:" || origin.origin !== base.vars.APP_ORIGIN)
  throw new Error("A production HTTPS APP_ORIGIN is required");
const revision = (await command(["git", "rev-parse", "HEAD"], true)).trim();
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Cannot determine release revision");
const token = randomToken(48), tokenHash = await sha256(token);
const committedAt = Number((await command(["git", "log", "-1", "--format=%ct", "HEAD"], true)).trim()) * 1000;
if (!Number.isSafeInteger(committedAt) || committedAt <= 0) throw new Error("Cannot determine the release's commit time");
/**
 * Minutes the shops' bots are told ahead of the maintenance, and then waited.
 * 0 still tells them, as "about to start", and waits `NOTICE_FLOOR_MS` so the
 * message reaches the groups before the platform pauses.
 */
/** However soon the maintenance, the bots get this long to say so before the platform pauses. */
const NOTICE_FLOOR_MS = 30_000;
const noticeMinutes = minutesSetting("PRISM_MAINTENANCE_NOTICE_MINUTES", 0, 0, 15);
/** How long the bots are told the maintenance will take. */
const expectedMinutes = minutesSetting("PRISM_MAINTENANCE_EXPECTED_MINUTES", 3, 1, 60);

function minutesSetting(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number of minutes from ${min} to ${max}`);
  return value;
}

/** One statement on the target D1, through Wrangler, with its rows. */
async function sql(statement: string): Promise<Array<Record<string, unknown>>> {
  const output = await command(["wrangler", "d1", "execute", "DB", "--remote", "--config", configPath, "--json", "--command", statement], true);
  try {
    const answers = JSON.parse(output) as Array<{ results?: Array<Record<string, unknown>> }>;
    return answers.at(-1)?.results ?? [];
  } catch {
    throw new Error(`D1 did not answer JSON:\n${tailLines(output)}`);
  }
}
const files = (await readdir(resolve(root, "migrations"))).filter(name => name.endsWith(".sql"))
  .sort((a, b) => parseInt(a) - parseInt(b) || (a < b ? -1 : a > b ? 1 : 0));
if (files.some(name => !/^\d+_[a-z0-9_-]+\.sql$/.test(name))) throw new Error("Unsupported migration filename");
await mkdir(resolve(root, ".wrangler"), { recursive: true });
const folder = await mkdtemp(resolve(root, ".wrangler/platform-deploy-"));
const configs = new Map<string, string>();
for (const phase of ["maintenance", "verify", "live"] as const) {
  const config = {
    ...base,
    main: resolve(root, phase === "maintenance" ? "packages/server/src/maintenance-worker.ts" : "packages/server/src/worker.ts"),
    assets: { ...base.assets, binding: "ASSETS", directory: resolve(root, base.assets.directory), run_worker_first: phase === "live" ? [...base.assets.run_worker_first, deploymentControlPath] : true },
    d1_databases: base.d1_databases.map((db: Record<string, unknown>) => ({ ...db, migrations_dir: resolve(root, "migrations") })),
    vars: { ...base.vars, PRISM_DEPLOY_GUARD: "1", PRISM_DEPLOY_PHASE: phase, PRISM_DEPLOY_TOKEN_HASH: tokenHash, PRISM_DEPLOY_REVISION: revision, PRISM_WORKER_NAME: base.name },
  };
  const path = resolve(folder, `${phase}.json`);
  await Bun.write(path, JSON.stringify(config, null, 2));
  configs.set(phase, path);
}
const deploymentArgs = (phase: string) => ["wrangler", "deploy", "--config", configs.get(phase)!];

const controlOptions = { origin, token, revision, sleep: (milliseconds: number) => Bun.sleep(milliseconds) };
let activePhase: string | undefined;
const control = (body: Record<string, unknown>) => deploymentRequest(controlOptions, body, activePhase);

let turn: Extract<DeployTurn, { kind: "deploy" }> | null = null;
/** The live Worker accepts notices only from the run holding the turn; without one there is none to send. */
let skipNotices = false;
let beating: ReturnType<typeof setInterval> | null = null;
const steps: PlatformDeploymentSteps = {
  async preflight() {
    // Compile every phase before changing the live Worker or database.
    for (const phase of configs.keys()) await command([...deploymentArgs(phase), "--dry-run"]);
  },
  async queue() {
    let entered: DeployTurn;
    try {
      entered = await enterDeployQueue({ sql, revision, committedAt, noticeHash: tokenHash, sleep: (ms) => Bun.sleep(ms) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Gave up waiting")) throw error;
      // Without the queue (the API token may not write to D1) the deployment goes on as before: alone, unannounced.
      console.warn(`Deploy queue unavailable; deploying without taking turns or telling the shops:
${message}`);
      skipNotices = true;
      return "deploy";
    }
    if (entered.kind === "superseded") {
      console.log(`A newer commit (${entered.by.slice(0, 12)}) is deploying or deployed; ${revision.slice(0, 12)} steps aside and changes nothing.`);
      return "superseded";
    }
    turn = entered;
    // Keep the turn while the slow steps run; a run that stops saying so is taken for gone.
    beating = setInterval(() => { void turn?.heartbeat().catch((error) => console.warn(`Deploy queue heartbeat failed: ${error instanceof Error ? error.message : String(error)}`)); }, 30_000);
    console.log(`Deploy turn taken for ${revision.slice(0, 12)}.`);
    return "deploy";
  },
  async announce(stage) {
    if (skipNotices) return;
    const told = await sendMaintenanceNotice(
      { origin, token },
      stage === "ahead" ? { stage, minutes: noticeMinutes, expectedMinutes } : { stage },
    );
    if (told === null) {
      // The live release predates notices: nobody was told, so nobody is waited for.
      console.log("The live Worker does not take maintenance notices yet; going on without one.");
      return;
    }
    console.log(`Maintenance notice (${stage}) sent to ${told} shop(s).`);
    if (stage === "ahead") {
      const wait = Math.max(noticeMinutes * 60_000, NOTICE_FLOOR_MS);
      console.log(`Waiting ${Math.round(wait / 1000)} s before maintenance, as the shops were told.`);
      await Bun.sleep(wait);
    }
  },
  async release(deployed) {
    if (beating) clearInterval(beating);
    await turn?.finish(deployed);
  },
  async deploy(phase) {
    console.log(`Deploying ${phase} phase for ${base.name} (${revision.slice(0, 12)})`);
    await deployWorker(
      (triggersOnly) => command(triggersOnly
        ? ["wrangler", "triggers", "deploy", "--config", configs.get(phase)!]
        : deploymentArgs(phase)),
      controlOptions.sleep,
    );
    console.log(`Waiting for authenticated ${phase} phase at ${origin.origin}`);
    await deploymentRequest(controlOptions, { action: "probe" }, phase);
    activePhase = phase;
    console.log(`Confirmed ${phase} phase (${revision.slice(0, 12)})`);
  },
  async control(action) {
    await control({ action });
  },
  async checkpoint() {
    // Capture after fencing: no later business writes can be lost by restoring this bookmark.
    const output = await command(["wrangler", "d1", "time-travel", "info", "DB", "--config", configPath, "--json"], true);
    let data: { bookmark?: string };
    try {
      data = JSON.parse(output);
    } catch {
      throw new Error(`D1 time-travel info did not answer JSON:\n${tailLines(output)}`);
    }
    if (!data.bookmark) throw new Error("D1 recovery bookmark was not returned");
    await Bun.write(resolve(folder, "recovery.json"), JSON.stringify({ worker: base.name, databaseId: base.d1_databases[0].database_id, revision, ...data }, null, 2));
    console.log(`D1 recovery bookmark: ${data.bookmark} (retain this deployment log for recovery)`);
  },
  async migrate() {
    // Use the same ledger/names as Wrangler, but keep SQL and write-fence restoration
    // inside one D1 batch. Direct wrangler migrations apply would bypass this protection.
    for (const name of files) {
      await control({ action: "schema", name, sql: await Bun.file(resolve(root, "migrations", name)).text() });
      console.log(`Migration checked/applied: ${name}`);
    }
  },
  async health() {
    await deploymentHealth(controlOptions);
    console.log("Deployment verified; business requests resumed.");
  },
};
try {
  if (Bun.argv.includes("--dry-run")) await steps.preflight();
  else await deployPlatform(steps);
  if (beating) clearInterval(beating);
} catch (error) {
  if (beating) clearInterval(beating);
  // The last thing in the log: which step, why, and what state it left, above any stack.
  const recovery = resolve(folder, "recovery.json");
  console.error([
    "",
    "========== deploy:beta failed ==========",
    error instanceof Error ? error.message : String(error),
    activePhase ? `Last confirmed phase: ${activePhase}.` : "No phase was confirmed; the live Worker was not replaced.",
    (await Bun.file(recovery).exists()) ? `D1 recovery bookmark: ${recovery}` : "No D1 recovery bookmark was taken.",
    "========================================",
  ].join("\n"));
  process.exit(1);
}
