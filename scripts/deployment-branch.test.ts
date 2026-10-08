import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDeploymentBranch } from "./deployment-branch";

const source = new URL("../", import.meta.url);

test("Workers Builds only permits the configured production branch", () => {
  for (const env of [ {}, { WORKERS_CI: "0" }, { WORKERS_CI: "1", WORKERS_CI_BRANCH: "main" },
    { WORKERS_CI: "1", WORKERS_CI_BRANCH: "release", PRISM_DEPLOY_BRANCH: "release" } ]) {
    expect(() => assertDeploymentBranch(env)).not.toThrow();
  }
  for (const branch of [undefined, "", " ", "fix/insufficient-balance-message", "main-preview"]) {
    expect(() => assertDeploymentBranch({ WORKERS_CI: "1", WORKERS_CI_BRANCH: branch })).toThrow("Refusing live deployment");
  }
  expect(() => assertDeploymentBranch({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "main", PRISM_DEPLOY_BRANCH: "release" })).toThrow("expected release");
});

test("the real deploy:beta entry rejects PR builds before any child command and retains production sequencing", async () => {
  const root = mkdtempSync(join(tmpdir(), "prism-deploy-branch-"));
  try {
    mkdirSync(join(root, "scripts"));
    for (const path of ["scripts/deploy-beta.ts", "scripts/deployment-branch.ts"]) copyFileSync(new URL(path, source), join(root, path));
    const scripts = (await Bun.file(new URL("package.json", source)).json()).scripts;
    await Bun.write(join(root, "package.json"), JSON.stringify({ scripts: { "deploy:beta": scripts["deploy:beta"], "build:web": "bun run scripts/record.ts build" } }));
    const recorder = `
      const root = new URL("../", import.meta.url);
      const file = Bun.file(new URL("calls.json", root));
      const calls = await file.exists() ? await file.json() : [];
      calls.push(Bun.argv[2] ?? import.meta.url.split("/").at(-1));
      await Bun.write(new URL("calls.json", root), JSON.stringify(calls));
      if (process.env.TEST_BUILD_FAILURE === "1" && Bun.argv[2] === "build") process.exit(2);
    `;
    for (const path of ["record.ts", "generate-wrangler-config.ts", "deploy-platform.ts"]) await Bun.write(join(root, "scripts", path), recorder);
    const run = (branch?: string, extra: Record<string, string> = {}) => Bun.spawnSync([process.execPath, "run", "deploy:beta"], {
      cwd: root, env: { PATH: process.env.PATH!, WORKERS_CI: "1", ...(branch ? { WORKERS_CI_BRANCH: branch } : {}), ...extra }, stdout: "pipe", stderr: "pipe",
    });
    for (const branch of [undefined, "fix/insufficient-balance-message"]) {
      const rejected = run(branch);
      expect(rejected.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(rejected.stderr)).toContain("Refusing live deployment");
      expect(await Bun.file(join(root, "calls.json")).exists()).toBe(false);
    }
    expect(run("main").exitCode).toBe(0);
    expect(await Bun.file(join(root, "calls.json")).json()).toEqual(["build", "--platform", "deploy-platform.ts"]);
    rmSync(join(root, "calls.json"));
    expect(run("main", { TEST_BUILD_FAILURE: "1" }).exitCode).not.toBe(0);
    expect(await Bun.file(join(root, "calls.json")).json()).toEqual(["build"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("direct platform deployment also rejects a PR branch before loading generated configuration", () => {
  const result = Bun.spawnSync([process.execPath, "run", "scripts/deploy-platform.ts"], {
    cwd: source.pathname, env: { PATH: process.env.PATH!, WORKERS_CI: "1", WORKERS_CI_BRANCH: "fix/preview" }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("Refusing live deployment");
});
