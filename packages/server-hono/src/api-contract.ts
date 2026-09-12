/** JSON transport shared by PRiSM Web, native clients and integrations. */
export type ApiError = { code: string; message: string; details?: unknown };
export type ApiResponse<T> = { data: T } | { error: ApiError };

export function apiErrorCode(status: number): string {
  return ({ 400: "INVALID_REQUEST", 401: "AUTHENTICATION_REQUIRED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 410: "EXPIRED", 422: "VALIDATION_FAILED", 429: "RATE_LIMITED" } as Record<number, string>)[status] ?? "INTERNAL_ERROR";
}

export async function wrapApiResponse(response: Response): Promise<Response> {
  if (response.status === 204 || response.status === 304) return response;
  const json = response.headers.get("content-type")?.includes("application/json");
  if (response.ok && !json) return response;
  const payload: unknown = json ? await response.json() : null;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  let body: ApiResponse<unknown>;
  if (response.ok) {
    body = { data: payload };
  } else {
    const error = payload && typeof payload === "object" && "error" in payload ? payload.error : null;
    const structured = error && typeof error === "object" ? error as Partial<ApiError> : null;
    body = { error: {
      code: typeof structured?.code === "string" ? structured.code : apiErrorCode(response.status),
      message: typeof structured?.message === "string" ? structured.message : typeof error === "string" ? error : response.statusText || "Request failed",
      ...(structured?.details !== undefined ? { details: structured.details } : {}),
    } };
  }
  return Response.json(body, { status: response.status, headers });
}

/** Temporary compatibility for clients deployed before the v1 cutover. */
export async function unwrapLegacyResponse(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("deprecation", "true");
  headers.delete("content-length");
  if (!headers.get("content-type")?.includes("application/json")) return new Response(response.body, { status: response.status, headers });
  const body = await response.json() as ApiResponse<unknown>;
  return Response.json("data" in body ? body.data : body, { status: response.status, headers });
}
