import type { Context } from "hono";
import type { Principal, PrismAppDependencies } from "./types";

export async function authenticate(
  authorization: string | undefined,
  playerId: string | undefined,
  dependencies: PrismAppDependencies,
): Promise<Principal | null> {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;

  const adminSession = await dependencies.adminAuth?.authenticateAdminSession(token);
  if (adminSession) {
    return {
      role: "staff",
      staffId: adminSession.staffId,
      staffRole: adminSession.role,
      displayName: adminSession.displayName,
    };
  }

  const apiToken = await dependencies.apiTokenAuth?.authenticateApiToken(token);
  if (apiToken) {
    return {
      role: apiToken.role,
    };
  }

  const playerSession = await dependencies.playerSessionAuth?.authenticatePlayerSession(token);
  if (playerSession) {
    return {
      role: "player_session",
      playerId: playerSession.playerId,
    };
  }

  return null;
}

export function forbidden(context: Context, message: string): Response {
  return context.json(
    {
      error: {
        code: "FORBIDDEN",
        message,
      },
    },
    403,
  );
}
