export function passkeyErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError" || error.name === "AbortError") return null;
    if (error.name === "InvalidStateError") return "这个 Passkey 已经添加过了";
    if (error.name === "SecurityError") return "当前环境无法使用 Passkey";
    return error.message;
  }
  return "Passkey 操作失败";
}
