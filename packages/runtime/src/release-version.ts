import type { ServiceVersionInfo } from "@prism/server-hono";

declare const PRISM_BACKEND_VERSION: string | undefined;
declare const PRISM_BACKEND_REVISION: string | undefined;

export const backendVersionInfo: ServiceVersionInfo = {
  version: typeof PRISM_BACKEND_VERSION === "string" ? PRISM_BACKEND_VERSION : "dev",
  revision: typeof PRISM_BACKEND_REVISION === "string" ? PRISM_BACKEND_REVISION : "unknown",
};
