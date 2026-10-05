import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const status = await child.exited;
  if (status !== 0) process.exit(status);
}

// Workers Builds' default upload command follows the generated config redirect.
// Validate deployment variables before building assets or uploading a template.
if (process.env.WORKERS_CI === "1") {
  await run(["run", "scripts/generate-wrangler-config.ts", "--platform"]);
}
await run(["run", "--cwd", "packages/prism-web", "build"]);
