import type {
  DeviceActionExecutionInput,
  DeviceActionExecutionResult,
  DeviceActionExecutor,
  TTLockConnectionConfig,
  TTLockDeviceConfig,
} from "@prism/application";

export type TTLockFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type TTLockExecutorInput = {
  connection: TTLockConnectionConfig;
  devices: readonly TTLockDeviceConfig[];
  fetch?: TTLockFetch;
  now?: () => Date;
  onConnectionUpdated?: (connection: TTLockConnectionConfig) => Promise<void> | void;
};

export type TTLockOpenState = {
  state: number;
};

export function createTTLockExecutor(input: TTLockExecutorInput): DeviceActionExecutor {
  const fetcher = input.fetch ?? ((url: string | URL | Request, init?: RequestInit) => fetch(url, init));
  const client = new TTLockClient({
    connection: input.connection,
    fetcher,
    now: input.now,
    onConnectionUpdated: input.onConnectionUpdated,
  });
  const devicesById = new Map(input.devices.map((device) => [device.id, device]));

  return {
    async execute(executionInput): Promise<DeviceActionExecutionResult> {
      const command = executionInput.command;
      if (command.executorKind !== "ttlock" || command.targetKind !== "facility" || !command.deviceId) {
        return failed(`TTLock cannot execute ${command.type}.`);
      }
      if (command.type !== "door.open") {
        return failed(`TTLock cannot execute ${command.type}.`);
      }

      const device = devicesById.get(command.deviceId);
      if (!device) return failed("TTLock 门锁配置不存在。");

      try {
        const response = await client.unlock(device.lockId);
        return toExecutionResult(response, "开门");
      } catch (error) {
        return failed(error instanceof Error ? error.message : "TTLock request failed.");
      }
    },
  };
}

export function resolveTTLockDeviceRef(
  deviceRef: string,
  devices: readonly TTLockDeviceConfig[],
): TTLockDeviceConfig | null {
  const target = deviceRef.trim().toLowerCase();
  if (!target) return null;
  return devices.find((device) => {
    if (device.name.trim().toLowerCase() === target) return true;
    return device.aliases.some((alias) => alias.trim().toLowerCase() === target);
  }) ?? null;
}

export async function queryTTLockDeviceState(
  client: TTLockClient,
  device: TTLockDeviceConfig,
): Promise<TTLockOpenState> {
  return client.queryOpenState(device.lockId);
}

export class TTLockClient {
  private readonly connection: TTLockConnectionConfig;
  private readonly fetcher: TTLockFetch;
  private readonly now: () => Date;
  private readonly onConnectionUpdated?: (connection: TTLockConnectionConfig) => Promise<void> | void;

  constructor(input: {
    connection: TTLockConnectionConfig;
    fetcher?: TTLockFetch;
    now?: () => Date;
    onConnectionUpdated?: (connection: TTLockConnectionConfig) => Promise<void> | void;
  }) {
    this.connection = { ...input.connection };
    this.fetcher = input.fetcher ?? ((url: string | URL | Request, init?: RequestInit) => fetch(url, init));
    this.now = input.now ?? (() => new Date());
    this.onConnectionUpdated = input.onConnectionUpdated;
  }

  async unlock(lockId: number): Promise<Record<string, unknown>> {
    return this.requestWithTokenRetry("/v3/lock/unlock", { lockId });
  }

  async lock(lockId: number): Promise<Record<string, unknown>> {
    return this.requestWithTokenRetry("/v3/lock/lock", { lockId });
  }

  async queryOpenState(lockId: number): Promise<TTLockOpenState> {
    const response = await this.requestWithTokenRetry("/v3/lock/queryOpenState", { lockId });
    const state = response.state;
    if (typeof state !== "number" || !Number.isInteger(state)) {
      throw new Error("TTLock 返回了无效的门锁状态。");
    }
    return { state };
  }

  async addTemporaryPassword(
    lockId: number,
    password: string,
    name: string,
    startDate = this.now().getTime(),
    endDate = startDate + 180_000,
  ): Promise<{ keyboardPwdId: number }> {
    const response = await this.requestWithTokenRetry("/v3/keyboardPwd/add", {
      lockId,
      keyboardPwd: password,
      keyboardPwdName: name,
      keyboardPwdType: 3,
      startDate,
      endDate,
      addType: 2,
    });
    const keyboardPwdId = response.keyboardPwdId;
    if (typeof keyboardPwdId !== "number") {
      throw new Error("TTLock 未返回临时密码 ID。");
    }
    return { keyboardPwdId };
  }

  async createRandomTemporaryPassword(lockId: number, name: string): Promise<{ password: string; id: number }> {
    const random = crypto.getRandomValues(new Uint32Array(1))[0] % 100_000_000;
    const password = String(random).padStart(8, "0");
    const result = await this.addTemporaryPassword(lockId, password, name);
    return { password, id: result.keyboardPwdId };
  }

  private async requestWithTokenRetry(
    endpoint: string,
    params: Record<string, string | number>,
  ): Promise<Record<string, unknown>> {
    await this.refreshIfNeeded();
    let response = await this.request(endpoint, params);
    if (isTokenError(response)) {
      await this.renewToken();
      response = await this.request(endpoint, params);
    }
    assertTTLockSuccess(response);
    return response;
  }

  private async request(
    endpoint: string,
    params: Record<string, string | number>,
  ): Promise<Record<string, unknown>> {
    if (!this.connection.clientId || !this.connection.accessToken) {
      throw new Error("TTLock 未配置有效的 clientId 或 access token。");
    }

    const body = new URLSearchParams({
      clientId: this.connection.clientId,
      accessToken: this.connection.accessToken,
      date: String(this.now().getTime()),
      ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
    });
    const response = await this.fetcher(`${this.connection.baseUrl.replace(/\/+$/, "")}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const raw = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`TTLock 返回了无效响应（HTTP ${response.status}）。`);
    }
    if (!response.ok) {
      throw new Error(`TTLock 请求失败（HTTP ${response.status}）。`);
    }
    if (!isRecord(json)) throw new Error("TTLock 返回了无效响应。");
    return json;
  }

  private async refreshIfNeeded(): Promise<void> {
    const expiresAt = this.connection.accessTokenExpiresAt;
    if (this.connection.accessToken && (expiresAt == null || expiresAt > this.now().getTime() + 30_000)) return;
    await this.renewToken();
  }

  private async renewToken(): Promise<void> {
    let tokenResponse: Record<string, unknown> | null = null;
    if (this.connection.refreshToken) {
      tokenResponse = await requestToken(this.fetcher, this.connection.baseUrl, {
        client_id: this.connection.clientId,
        client_secret: this.connection.clientSecret,
        grant_type: "refresh_token",
        refresh_token: this.connection.refreshToken,
      });
    }
    if (!tokenResponse || !isTokenResponseUsable(tokenResponse)) {
      if (!this.connection.clientSecret || !this.connection.appAccount || !this.connection.appPwd) {
        throw new Error("TTLock access token 已失效，且没有可用的 refresh token 或账号密码。");
      }
      tokenResponse = await requestToken(this.fetcher, this.connection.baseUrl, {
        client_id: this.connection.clientId,
        client_secret: this.connection.clientSecret,
        username: this.connection.appAccount,
        password: md5(this.connection.appPwd),
      });
    }
    assertTTLockSuccess(tokenResponse);
    const accessToken = stringValue(tokenResponse.access_token);
    if (!accessToken) throw new Error("TTLock 未返回 access token。");
    const expiresIn = numberValue(tokenResponse.expires_in);
    const nextConnection: TTLockConnectionConfig = {
      ...this.connection,
      accessToken,
      refreshToken: stringValue(tokenResponse.refresh_token) || this.connection.refreshToken,
      accessTokenExpiresAt: expiresIn ? this.now().getTime() + expiresIn * 1000 : null,
    };
    Object.assign(this.connection, nextConnection);
    await this.onConnectionUpdated?.({ ...nextConnection });
  }
}

async function requestToken(
  fetcher: TTLockFetch,
  baseUrl: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetcher(`${baseUrl.replace(/\/+$/, "")}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const raw = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`TTLock 认证返回了无效响应（HTTP ${response.status}）。`);
  }
  if (!isRecord(json)) throw new Error("TTLock 认证返回了无效响应。");
  return json;
}

function toExecutionResult(response: Record<string, unknown>, action: string): DeviceActionExecutionResult {
  return isSuccessful(response)
    ? { status: "success" }
    : failed(`TTLock ${action}失败${formatApiError(response)}`);
}

function assertTTLockSuccess(response: Record<string, unknown>): void {
  if (!isSuccessful(response)) throw new Error(`TTLock 请求失败${formatApiError(response)}`);
}

function isSuccessful(response: Record<string, unknown>): boolean {
  const code = response.errcode;
  return code === undefined || code === 0 || code === "0";
}

function isTokenError(response: Record<string, unknown>): boolean {
  return response.errcode === 10003 || response.errcode === 10004 || response.errcode === 10011;
}

function isTokenResponseUsable(response: Record<string, unknown>): boolean {
  return isSuccessful(response) && Boolean(stringValue(response.access_token));
}

function formatApiError(response: Record<string, unknown>): string {
  const code = response.errcode;
  const message = stringValue(response.errmsg) || stringValue(response.description);
  return `${code !== undefined ? `（${String(code)}）` : ""}${message ? `：${message}` : ""}`;
}

function failed(message: string): DeviceActionExecutionResult {
  return { status: "failed", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function md5(value: string): string {
  const data = new TextEncoder().encode(value);
  const bitLength = data.length * 8;
  const blockLength = (((data.length + 9 + 63) >> 6) << 4);
  const words = new Uint32Array(blockLength);
  for (let index = 0; index < data.length; index++) {
    words[index >> 2] |= data[index] << ((index & 3) * 8);
  }
  words[data.length >> 2] |= 0x80 << ((data.length & 3) * 8);
  words[blockLength - 2] = bitLength >>> 0;
  words[blockLength - 1] = Math.floor(bitLength / 0x1_0000_0000);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const shift = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x1_0000_0000));

  for (let offset = 0; offset < blockLength; offset += 16) {
    let aa = a;
    let bb = b;
    let cc = c;
    let dd = d;
    for (let index = 0; index < 64; index++) {
      let f: number;
      let g: number;
      if (index < 16) {
        f = (bb & cc) | (~bb & dd);
        g = index;
      } else if (index < 32) {
        f = (dd & bb) | (~dd & cc);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = bb ^ cc ^ dd;
        g = (3 * index + 5) % 16;
      } else {
        f = cc ^ (bb | ~dd);
        g = (7 * index) % 16;
      }
      const next = (aa + f + constants[index] + words[offset + g]) >>> 0;
      const amount = shift[(index >> 4) * 4 + (index % 4)];
      const rotated = ((next << amount) | (next >>> (32 - amount))) >>> 0;
      aa = dd;
      dd = cc;
      cc = bb;
      bb = (bb + rotated) >>> 0;
    }
    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }

  return [a, b, c, d].map((word) =>
    [0, 8, 16, 24].map((shiftValue) => ((word >>> shiftValue) & 0xff).toString(16).padStart(2, "0")).join(""),
  ).join("");
}
