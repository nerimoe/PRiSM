/** Workers Builds previews must never enter the live maintenance/migration flow. */
export function assertDeploymentBranch(env: Record<string, string | undefined>): void {
  if (env.WORKERS_CI !== "1") return;
  const branch = env.WORKERS_CI_BRANCH?.trim();
  const productionBranch = env.PRISM_DEPLOY_BRANCH?.trim() || "main";
  if (!branch || branch !== productionBranch) {
    throw new Error(`Refusing live deployment from Workers Builds branch ${branch || "<missing>"}; expected ${productionBranch}. Use the preview command for PR branches.`);
  }
}
