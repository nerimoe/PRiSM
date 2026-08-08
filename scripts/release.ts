import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const dashboardPath = fileURLToPath(new URL("../packages/prism-dashboard", import.meta.url));
const dashboardPubspecPath = fileURLToPath(new URL("../packages/prism-dashboard/pubspec.yaml", import.meta.url));
const wranglerConfigPath = fileURLToPath(new URL("../wrangler.generated.jsonc", import.meta.url));
const [command, argument] = Bun.argv.slice(2);

const packageJson = await Bun.file(packagePath).json() as { version?: string } & Record<string, unknown>;
const version = requireSemver(packageJson.version);

if (command === "bump") {
  const nextVersion = bumpSemver(version, argument);
  const pubspec = await Bun.file(dashboardPubspecPath).text();
  const match = pubspec.match(/^version:\s*([0-9]+\.[0-9]+\.[0-9]+)(?:\+([0-9]+))?\s*$/m);
  if (!match) throw new Error("packages/prism-dashboard/pubspec.yaml has no valid version field");
  const nextBuild = Number(match[2] ?? "0") + 1;
  packageJson.version = nextVersion;
  await Bun.write(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  await Bun.write(dashboardPubspecPath, pubspec.replace(match[0], `version: ${nextVersion}+${nextBuild}`));
  console.log(`Release version bumped to ${nextVersion} (Dashboard build ${nextBuild}).`);
} else if (command === "deploy-worker") {
  await run([
    "wrangler",
    "deploy",
    "--config",
    wranglerConfigPath,
    "--define",
    `PRISM_BACKEND_VERSION:${JSON.stringify(version)}`,
    "--define",
    `PRISM_BACKEND_REVISION:${JSON.stringify(await revision(root))}`,
  ], root);
} else if (command === "build-dashboard") {
  await run([
    "flutter",
    "build",
    "web",
    "--no-pub",
    `--dart-define=PRISM_DASHBOARD_VERSION=${version}`,
    `--dart-define=PRISM_DASHBOARD_REVISION=${await revision(dashboardPath)}`,
  ], dashboardPath);
} else {
  throw new Error("Usage: bun run scripts/release.ts <bump patch|minor|major|deploy-worker|build-dashboard>");
}

function requireSemver(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error("package.json version must be a stable SemVer value such as 1.0.0");
  }
  return value;
}

function bumpSemver(current: string, kind: string | undefined): string {
  if (kind !== "patch" && kind !== "minor" && kind !== "major") {
    throw new Error("Version bump must be patch, minor, or major.");
  }
  let [major, minor, patch] = current.split(".").map(Number);
  if (kind === "major") [major, minor, patch] = [major + 1, 0, 0];
  if (kind === "minor") [minor, patch] = [minor + 1, 0];
  if (kind === "patch") patch += 1;
  return `${major}.${minor}.${patch}`;
}

async function revision(cwd: string): Promise<string> {
  const child = Bun.spawn(["git", "rev-parse", "--short=12", "HEAD"], { cwd, stdout: "pipe", stderr: "inherit" });
  const value = (await new Response(child.stdout).text()).trim();
  if (await child.exited !== 0 || !value) throw new Error(`Cannot resolve Git revision in ${cwd}`);
  return value;
}

async function run(args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(args, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${args[0]} exited with code ${exitCode}`);
}
