import type {
  DeviceCommand,
  DeviceCommandActor,
  DeviceCommandType,
  DeviceEventVia,
  DeviceReferenceTarget,
} from "@prism/core";

/**
 * A device action requested by the Bot, staff or the integration API.
 *
 * Implemented by the server's device catalog, which owns the hardware and the
 * event log; this package only describes the port. The response keeps the
 * `DeviceCommand` shape the Bot and the frozen staff views already depend on.
 */
export type RequestDeviceActionInput = {
  actor: DeviceCommandActor;
  target: DeviceReferenceTarget;
  type: DeviceCommandType;
  payload?: Record<string, unknown>;
  /** Where the request came into the platform, such as the bot it was said to. */
  via?: DeviceEventVia;
};

export type DeviceActionService = {
  requestDeviceAction(input: RequestDeviceActionInput): Promise<DeviceCommand>;
};
