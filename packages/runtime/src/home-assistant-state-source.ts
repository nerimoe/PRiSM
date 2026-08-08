import type { HomeAssistantStateSource } from "@prism/application";

export type HomeAssistantStateSourceInput = {
  fetch?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
};

export function createHomeAssistantStateSource(
  input: HomeAssistantStateSourceInput = {},
): HomeAssistantStateSource {
  const fetcher = input.fetch ?? ((url: string | URL | Request, init?: RequestInit) => fetch(url, init));
  const timeoutMs = input.timeoutMs ?? 2_000;

  return {
    async readState({ connection, device }) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const baseUrl = connection.url.replace(/\/+$/, "");
        const response = await fetcher(`${baseUrl}/api/states/${encodeURIComponent(device.id)}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${connection.token}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Home Assistant state request failed with ${response.status}.`);
        }
        const data = await response.json() as { state?: unknown };
        return typeof data.state === "string" ? data.state : "off";
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}
