import { expect, test } from "bun:test";
import { deployPlatform, type PlatformDeploymentSteps } from "./deploy-platform-flow";

function fixture(fail?: string) {
  const calls: string[] = [];
  async function step(name: string) { calls.push(name); if (name === fail) throw new Error(name); }
  const steps: PlatformDeploymentSteps = {
    preflight: () => step("preflight"), deploy: phase => step(`deploy:${phase}`),
    control: action => step(action), checkpoint: () => step("checkpoint"),
    migrate: () => step("migrate"), health: () => step("health"),
  };
  return { calls, steps };
}

test("deployment fences old writers and checkpoints before migrations; only verified new code resumes traffic", async () => {
  const { calls, steps } = fixture();
  await deployPlatform(steps);
  expect(calls).toEqual(["preflight", "deploy:maintenance", "begin", "checkpoint", "migrate", "deploy:verify", "convert", "check", "deploy:live", "resume", "health"]);
});

for (const failure of ["checkpoint", "migrate", "deploy:verify", "convert", "check", "deploy:live", "resume", "health"]) {
  test(`${failure} failure blocks traffic and never proceeds to later deployment steps`, async () => {
    const { calls, steps } = fixture(failure);
    await expect(deployPlatform(steps)).rejects.toThrow(failure);
    expect(calls.at(-1)).toBe("block");
    if (!["resume", "health"].includes(failure)) expect(calls).not.toContain("resume");
  });
}

test("preflight failure does not interrupt the current service", async () => {
  const { calls, steps } = fixture("preflight");
  await expect(deployPlatform(steps)).rejects.toThrow("preflight");
  expect(calls).toEqual(["preflight"]);
});

test("an unconfirmed emergency block is reported instead of claiming maintenance is active", async () => {
  const { calls, steps } = fixture("health");
  const original = steps.control;
  steps.control = async action => { if (action === "block") throw new Error("network down"); await original(action); };
  await expect(deployPlatform(steps)).rejects.toThrow("unable to confirm maintenance");
  expect(calls).toContain("resume");
});
