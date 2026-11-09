import { expect, test } from "bun:test";
import { deployWorker, deploymentCommand, isTransientTriggerFailure, TransientTriggerError } from "./deploy-worker";
import { deployPlatform, type PlatformDeploymentSteps } from "./deploy-platform-flow";

const malformed = "Some triggers failed to deploy for prism-link-beta:\n  - Received a malformed response from the API";

test("only a malformed response during triggers is classified for recovery", () => {
  expect(isTransientTriggerFailure(malformed)).toBe(true);
  for (const error of ["Received a malformed response from the API", "Some triggers failed to deploy: permission denied", "SyntaxError", "Authentication error"]) {
    expect(isTransientTriggerFailure(error)).toBe(false);
  }
});

test("a partially deployed Worker retries triggers without uploading again", async () => {
  const calls: boolean[] = [], waits: number[] = [];
  await deployWorker(async triggersOnly => {
    calls.push(triggersOnly);
    if (calls.length < 3) throw new TransientTriggerError("malformed");
  }, async ms => { waits.push(ms); });
  expect(calls).toEqual([false, true, true]);
  expect(waits).toEqual([10_000, 20_000]);
});

test("persistent trigger errors stop after two retries", async () => {
  let attempts = 0;
  await expect(deployWorker(async () => {
    attempts++;
    throw new TransientTriggerError("still malformed");
  }, async () => {})).rejects.toThrow("still malformed");
  expect(attempts).toBe(3);
});

test("upload, permission and configuration failures are not retried", async () => {
  for (const failOnTriggers of [false, true]) {
    const calls: boolean[] = [];
    await expect(deployWorker(async triggersOnly => {
      calls.push(triggersOnly);
      if (failOnTriggers && !triggersOnly) throw new TransientTriggerError("malformed");
      throw new Error("permission denied");
    }, async () => {})).rejects.toThrow("permission denied");
    expect(calls).toEqual(failOnTriggers ? [false, true] : [false]);
  }
});

test("each phase is confirmed after trigger recovery before migration or resume", async () => {
  const calls: string[] = [];
  const steps: PlatformDeploymentSteps = {
    async preflight() {},
    async deploy(phase) {
      await deployWorker(async triggersOnly => {
        calls.push(`${phase}:${triggersOnly ? "triggers" : "upload"}`);
        if (!triggersOnly) throw new TransientTriggerError("malformed");
      }, async () => {});
      calls.push(`${phase}:probe`);
    },
    async control(action) { calls.push(action); },
    async checkpoint() { calls.push("checkpoint"); },
    async migrate() { calls.push("migrate"); },
    async health() { calls.push("health"); },
  };
  await deployPlatform(steps);
  expect(calls).toEqual([
    "maintenance:upload", "maintenance:triggers", "maintenance:probe", "begin", "checkpoint", "migrate",
    "verify:upload", "verify:triggers", "verify:probe", "convert", "check",
    "live:upload", "live:triggers", "live:probe", "resume", "health",
  ]);
});

test("persistent trigger failure cannot advance to migration or resume", async () => {
  for (const failedPhase of ["maintenance", "verify", "live"]) {
    const controls: string[] = [];
    const steps: PlatformDeploymentSteps = {
      async preflight() {},
      async deploy(phase) {
        await deployWorker(async () => {
          if (phase === failedPhase) throw new TransientTriggerError("API still unavailable");
        }, async () => {});
      },
      async control(action) { controls.push(action); },
      async checkpoint() {},
      async migrate() { controls.push("migrate"); },
      async health() {},
    };
    await expect(deployPlatform(steps)).rejects.toThrow(`deploy ${failedPhase}`);
    expect(controls).not.toContain("resume");
    if (failedPhase === "maintenance") expect(controls).toEqual([]);
    else expect(controls.at(-1)).toBe("block");
  }
});

test("the real subprocess preserves captured stdout and classifies trigger stderr", async () => {
  expect(await deploymentCommand([process.execPath, "-e", 'process.stdout.write("bookmark")'], true)).toBe("bookmark");
  await expect(deploymentCommand([process.execPath, "-e", `process.stderr.write(${JSON.stringify(malformed)}); process.exit(1)`]))
    .rejects.toBeInstanceOf(TransientTriggerError);
  // The same API text outside the trigger stage must not turn an upload failure into success.
  let failure: unknown;
  try {
    await deploymentCommand([process.execPath, "-e", 'process.stderr.write("Received a malformed response from the API"); process.exit(1)']);
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(TransientTriggerError);
});
