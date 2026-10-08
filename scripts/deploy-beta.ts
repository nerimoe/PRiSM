import { fileURLToPath } from "node:url";
import { assertDeploymentBranch } from "./deployment-branch";

assertDeploymentBranch(process.env);
const root = fileURLToPath(new URL("..", import.meta.url));
for (const args of [
  ["run", "build:web"],
  ["run", "scripts/generate-wrangler-config.ts", "--platform"],
  ["run", "scripts/deploy-platform.ts"],
]) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const status = await child.exited;
  if (status !== 0) process.exit(status);
}
