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
  const message = await deployPlatform(steps).then(() => "", (error: Error) => error.message);
  expect(message).toContain("unable to confirm maintenance (network down)");
  // The step that failed is named in the message itself, not only in its cause.
  expect(message.startsWith('Deployment step "health" failed')).toBe(true);
  expect(calls).toContain("resume");
});

function queued(turn: "deploy" | "superseded", fail?: string, announceFails = false) {
  const { calls, steps } = fixture(fail);
  steps.queue = async () => { calls.push("queue"); return turn; };
  steps.announce = async (stage) => { calls.push(`announce:${stage}`); if (announceFails) throw new Error("bots unreachable"); };
  steps.release = async (deployed) => { calls.push(`release:${deployed}`); };
  return { calls, steps };
}

test("a run takes its turn, warns the shops before maintenance, says it is over after health, then gives the turn up", async () => {
  const { calls, steps } = queued("deploy");
  expect(await deployPlatform(steps)).toBe("deployed");
  expect(calls).toEqual([
    "preflight", "queue", "announce:ahead", "deploy:maintenance", "begin", "checkpoint", "migrate",
    "deploy:verify", "convert", "check", "deploy:live", "resume", "health", "announce:done", "release:true",
  ]);
});

test("a run a newer commit supersedes changes nothing", async () => {
  const { calls, steps } = queued("superseded");
  expect(await deployPlatform(steps)).toBe("superseded");
  expect(calls).toEqual(["preflight", "queue"]);
});

test("a notice that cannot be sent does not stop the deployment", async () => {
  const { calls, steps } = queued("deploy", undefined, true);
  expect(await deployPlatform(steps)).toBe("deployed");
  expect(calls.at(-1)).toBe("release:true");
});

test("a failed run fences, gives its turn up as nothing, and tells no one it is over", async () => {
  const { calls, steps } = queued("deploy", "migrate");
  await expect(deployPlatform(steps)).rejects.toThrow('Deployment step "migrate" failed');
  expect(calls.slice(-3)).toEqual(["migrate", "block", "release:false"]);
  expect(calls).not.toContain("announce:done");
});
