export type PlatformDeploymentSteps = {
  preflight(): Promise<void>;
  deploy(phase: "maintenance" | "verify" | "live"): Promise<void>;
  control(action: "begin" | "convert" | "check" | "resume" | "block"): Promise<void>;
  checkpoint(): Promise<void>;
  migrate(): Promise<void>;
  health(): Promise<void>;
};

/** No finally/resume: a failed migration or rollout must leave the database fenced. */
export async function deployPlatform(steps: PlatformDeploymentSteps): Promise<void> {
  await steps.preflight();
  let maintenanceInstalled = false;
  try {
    await steps.deploy("maintenance");
    maintenanceInstalled = true;
    await steps.control("begin");
    await steps.checkpoint();
    await steps.migrate();
    await steps.deploy("verify");
    await steps.control("convert");
    await steps.control("check");
    await steps.deploy("live");
    await steps.control("resume");
    await steps.health();
  } catch (error) {
    if (maintenanceInstalled) {
      try { await steps.control("block"); }
      catch { throw new Error("Deployment failed; unable to confirm maintenance. Check the target Worker before retrying.", { cause: error }); }
    }
    throw error;
  }
}
