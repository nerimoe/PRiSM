export type PlatformDeploymentSteps = {
  preflight(): Promise<void>;
  /**
   * Wait for this run's turn (`deploy-queue.ts`). "superseded": a newer commit
   * is waiting, deploying or deployed, and this run changes nothing.
   */
  queue?(): Promise<"deploy" | "superseded">;
  /** Tell the shops' bots; never fails the deployment. "ahead" also waits the notice time. */
  announce?(stage: "ahead" | "done"): Promise<void>;
  /** Give the turn up: as the newest deployed release, or as nothing. */
  release?(deployed: boolean): Promise<void>;
  deploy(phase: "maintenance" | "verify" | "live"): Promise<void>;
  control(action: "begin" | "convert" | "check" | "resume" | "block"): Promise<void>;
  checkpoint(): Promise<void>;
  migrate(): Promise<void>;
  health(): Promise<void>;
};

/** Name the failing step so the CI log shows where the rollout stopped. */
async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Deployment step "${label}" failed: ${detail}`, { cause: error });
  }
}

/** What a notice or the queue's bookkeeping failing costs: a line in the log, not the deployment. */
async function quietly(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.warn(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** No finally/resume: a failed migration or rollout must leave the database fenced. */
export async function deployPlatform(steps: PlatformDeploymentSteps): Promise<"deployed" | "superseded"> {
  await step("preflight", () => steps.preflight());
  if (steps.queue && (await step("queue", () => steps.queue!())) === "superseded") return "superseded";
  let maintenanceInstalled = false;
  try {
    if (steps.announce) await quietly("Maintenance notice", () => steps.announce!("ahead"));
    await step("deploy maintenance", () => steps.deploy("maintenance"));
    maintenanceInstalled = true;
    await step("control begin", () => steps.control("begin"));
    await step("checkpoint", () => steps.checkpoint());
    await step("migrate", () => steps.migrate());
    await step("deploy verify", () => steps.deploy("verify"));
    await step("control convert", () => steps.control("convert"));
    await step("control check", () => steps.control("check"));
    await step("deploy live", () => steps.deploy("live"));
    await step("control resume", () => steps.control("resume"));
    await step("health", () => steps.health());
  } catch (error) {
    let blocked: unknown = null;
    if (maintenanceInstalled) {
      try { await steps.control("block"); }
      catch (failure) { blocked = failure; }
    }
    // The turn passes on either way: the next run is what repairs a failed one.
    if (steps.release) await quietly("Deploy queue release", () => steps.release!(false));
    if (blocked) {
      // Both reasons in the message itself: a log may not print an error's cause.
      const why = (value: unknown) => (value instanceof Error ? value.message : String(value));
      throw new Error(
        `${why(error)}\nThen unable to confirm maintenance (${why(blocked)}). Check the target Worker before retrying.`,
        { cause: error },
      );
    }
    throw error;
  }
  if (steps.announce) await quietly("Maintenance notice", () => steps.announce!("done"));
  if (steps.release) await quietly("Deploy queue release", () => steps.release!(true));
  return "deployed";
}
