import type {
  DeviceActionExecutionInput,
  DeviceActionExecutionResult,
  DeviceActionExecutor,
} from "@prism/application";

export type HomeAssistantDeviceConfig = {
  name: string;
  alias?: string[];
  id: string;
};

export type HomeAssistantExecutorInput = {
  baseUrl: string;
  accessToken: string;
  /** Device registry used only when executing an all-device command. */
  devices?: HomeAssistantDeviceConfig[];
  fetch?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

export function createHomeAssistantExecutor(input: HomeAssistantExecutorInput): DeviceActionExecutor {
  // Cloudflare Workers runtime functions require their native invocation context.
  // Wrapping the global fetch prevents later helpers from calling it as an
  // object method with the wrong `this` value.
  const fetcher = input.fetch ?? ((url: string | URL | Request, init?: RequestInit) => fetch(url, init));
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const devices = input.devices ?? [];

  return {
    async execute(executionInput: DeviceActionExecutionInput): Promise<DeviceActionExecutionResult> {
      const command = executionInput.command;
      if (command.executorKind !== "home_assistant" || command.targetKind !== "facility") {
        return {
          status: "failed",
          message: `Home Assistant cannot execute ${command.type}.`,
        };
      }

      if (command.deviceId === null) {
        return executeAllHomeAssistantDevices({
          executionInput,
          devices,
          fetcher,
          baseUrl,
          accessToken: input.accessToken,
        });
      }

      const request = toHomeAssistantServiceRequest(executionInput, command.deviceId);
      if (!request) {
        return {
          status: "failed",
          message: `Home Assistant cannot execute ${executionInput.command.type}.`,
        };
      }

      return callHomeAssistantService({
        baseUrl,
        accessToken: input.accessToken,
        fetcher,
        request,
      });
    },
  };
}

async function executeAllHomeAssistantDevices(input: {
  executionInput: DeviceActionExecutionInput;
  devices: HomeAssistantDeviceConfig[];
  fetcher: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  baseUrl: string;
  accessToken: string;
}): Promise<DeviceActionExecutionResult> {
  const command = input.executionInput.command;
  if (command.type !== "power.off" && command.type !== "power.on") {
    return {
      status: "failed",
      message: `Home Assistant cannot execute ${command.type} for all devices.`,
    };
  }

  const targetsByEntityId = new Map<string, { entityId: string; deviceLabel: string }>();
  for (const device of input.devices) {
    const entityId = device.id.trim();
    if (!entityId) continue;
    const normalizedEntityId = entityId.toLowerCase();
    if (!targetsByEntityId.has(normalizedEntityId)) {
      targetsByEntityId.set(normalizedEntityId, {
        entityId,
        deviceLabel: device.name.trim() || "设备",
      });
    }
  }
  const targets = [...targetsByEntityId.values()];
  if (targets.length === 0) {
    return {
      status: "failed",
      message: "没有配置任何 Home Assistant 设备，无法操作所有设备。",
    };
  }

  const results = await Promise.all(
    targets.map(async (target) => {
      const request = toHomeAssistantServiceRequest(input.executionInput, target.entityId);
      if (!request) {
        return {
          deviceLabel: target.deviceLabel,
          result: {
            status: "failed",
            message: `Home Assistant cannot execute ${command.type}.`,
          } satisfies DeviceActionExecutionResult,
        };
      }
      return {
        deviceLabel: target.deviceLabel,
        result: await callHomeAssistantService({
          baseUrl: input.baseUrl,
          accessToken: input.accessToken,
          fetcher: input.fetcher,
          request,
        }),
      };
    }),
  );
  const failures = results.filter(
    (item): item is { deviceLabel: string; result: { status: "failed"; message: string } } => item.result.status === "failed",
  );
  if (failures.length > 0) {
    return {
      status: "failed",
      message: `部分设备执行失败：${failures.map((item) => `${item.deviceLabel}: ${item.result.message}`).join("；")}`,
    };
  }
  return { status: "success" };
}

async function callHomeAssistantService(input: {
  baseUrl: string;
  accessToken: string;
  fetcher: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  request: {
    domain: string;
    service: string;
    body: Record<string, unknown>;
  };
}): Promise<DeviceActionExecutionResult> {
  const fetcher = input.fetcher;
  const response = await fetcher(
    `${input.baseUrl}/api/services/${encodeURIComponent(input.request.domain)}/${encodeURIComponent(input.request.service)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.request.body),
    },
  );

  if (response.ok) {
    return { status: "success" };
  }

  const text = await response.text();
  return {
    status: "failed",
    message: `Home Assistant service ${input.request.domain}.${input.request.service} failed with ${response.status}${text ? `: ${text}` : ""}.`,
  };
}

function toHomeAssistantServiceRequest(
  input: DeviceActionExecutionInput,
  entityId: string,
): {
  domain: string;
  service: string;
  body: Record<string, unknown>;
} | null {
  const command = input.command;
  if (command.executorKind !== "home_assistant" || command.targetKind !== "facility") return null;

  if (command.type === "power.on") {
    return {
      domain: homeAssistantDomain(entityId, "switch"),
      service: "turn_on",
      body: { entity_id: entityId },
    };
  }

  if (command.type === "power.off") {
    return {
      domain: homeAssistantDomain(entityId, "switch"),
      service: "turn_off",
      body: { entity_id: entityId },
    };
  }

  if (command.type === "door.open") {
    return {
      domain: homeAssistantDomain(entityId, "lock"),
      service: "unlock",
      body: { entity_id: entityId },
    };
  }

  if (command.type === "ac.set_temperature") {
    const temperature = command.payload?.temperature;
    return {
      domain: homeAssistantDomain(entityId, "climate"),
      service: "set_temperature",
      body: {
        entity_id: entityId,
        ...(typeof temperature === "number" ? { temperature } : {}),
      },
    };
  }

  return null;
}

function homeAssistantDomain(entityId: string, fallback: string): string {
  const [domain] = entityId.split(".");
  return domain || fallback;
}

export function resolveHomeAssistantDeviceRef(
  deviceRef: string,
  devices: HomeAssistantDeviceConfig[],
): HomeAssistantDeviceConfig | null {
  const target = deviceRef.trim().toLowerCase();
  if (!target) return null;
  for (const device of devices) {
    if (device.name?.trim().toLowerCase() === target) return device;
    const aliases = Array.isArray(device.alias) ? device.alias : [];
    if (aliases.some((alias) => alias?.trim().toLowerCase() === target)) return device;
  }
  return null;
}
