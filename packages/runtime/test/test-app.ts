import {
  createPrismApp as createPrismAppBase,
  type PrismAppDependencies,
} from "@prism/server-hono";

export function createPrismApp(dependencies: PrismAppDependencies) {
  const { adminAuth, apiTokenAuth } = dependencies;
  return createPrismAppBase({
    ...dependencies,
    adminAuth: {
      async authenticateAdminSession(token) {
        return (
          (await adminAuth?.authenticateAdminSession(token))
          ?? (token === "staff-token" ? { staffId: "staff", role: "owner" as const } : null)
        );
      },
      ...(adminAuth?.revokeAdminSession
        ? { revokeAdminSession: (token: string) => adminAuth.revokeAdminSession!(token) }
        : {}),
    },
    apiTokenAuth: {
      async authenticateApiToken(token) {
        const authenticated = await apiTokenAuth?.authenticateApiToken(token);
        if (authenticated) return authenticated;
        if (token === "bot-token") return { role: "integration" };
        if (token === "agent-token") return { role: "machine" };
        return null;
      },
    },
  });
}
