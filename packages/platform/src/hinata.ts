import { encryptE2EE } from "./e2ee";

export type HinataResult = {
  ok: boolean;
  status: number;
  error?: string;
};

export function normalizeHinataUrl(targetUrl: string): string {
  let url = targetUrl.trim();
  if (/^wss:\/\//i.test(url)) {
    url = "https://" + url.slice(6);
  } else if (/^ws:\/\//i.test(url)) {
    url = "http://" + url.slice(5);
  }
  return url.replace(/\/+$/, "");
}

export async function sendHinataCard(
  targetUrl: string,
  accessCode: string,
  password?: string | null,
  operationId?: string,
): Promise<HinataResult> {
  return sendHinata(
    targetUrl,
    { type: "aime", value: accessCode },
    {
      action: "SET_CARD",
      body: { type: "aime", value: accessCode, disposable: true },
    },
    password,
    operationId,
  );
}

export async function sendHinataCoin(
  targetUrl: string,
  key: number,
  password?: string | null,
  operationId?: string,
) {
  // hinata-aimeio-rs rejects plaintext key presses, even without a configured password.
  if (!password || !Number.isInteger(key) || key < 1 || key > 65535)
    return { ok: false, status: 400, error: "投币需要有效按键码和连接密码" };
  const body = { key, count: 1 };
  return sendHinata(
    `${normalizeHinataUrl(targetUrl)}/event`,
    { action: "KEY_PRESS", body },
    { action: "KEY_PRESS", body },
    password,
    operationId,
  );
}

async function sendHinata(
  targetUrl: string,
  plain: object,
  message: { action: string; body: object },
  password?: string | null,
  operationId?: string,
): Promise<HinataResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), 10_000);
  try {
    const normalizedUrl = normalizeHinataUrl(targetUrl);
    const payload = password
      ? await encryptE2EE({
          password,
          messageId: operationId,
          expiresAt: Date.now() + 30000,
          message,
        })
      : plain;

    const response = await fetch(normalizedUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (response.ok) return { ok: true, status: response.status };
    if (response.status === 404) {
      return { ok: false, status: 404, error: "机台未在线或连接地址不正确" };
    }
    const errorText = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      error: `机台响应异常 (${response.status}${errorText ? `: ${errorText.slice(0, 80)}` : ""})`,
    };
  } catch (error) {
    const isTimeout = controller.signal.aborted;
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    console.error("sendHinataCard error:", detail, error);
    return {
      ok: false,
      status: 0,
      error: isTimeout ? "机台响应超时" : `机台通信失败 (${detail})`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
