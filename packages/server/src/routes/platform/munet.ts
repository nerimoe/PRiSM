import { z } from "zod";

const authOrigin = "https://auth.mumur.net:550";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().default(3600),
  refresh_token: z.string().min(1).optional(),
});
const cardSchema = z.object({
  luid: z.string().regex(/^\d{20}$/),
  remark: z.string().nullish(),
});
const profileSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1),
  preferred_username: z.string().min(1),
});
const cardsSchema = cardSchema.array();

export type MunetCard = z.infer<typeof cardSchema>;
export type MunetTokens = {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
};

export class MunetAuthorizationExpiredError extends Error {}

export function munetAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(`${authOrigin}/connect/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile cards",
    state,
  }).toString();
  return url.toString();
}

export async function finishMunetAuth(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ subject: string; name: string; username: string; cards: MunetCard[]; tokens: MunetTokens }> {
  const tokenResponse = await fetch(`${authOrigin}/connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  });
  if (!tokenResponse.ok) throw new Error("MuNET 授权失败");
  const token = tokenSchema.parse(await tokenResponse.json());
  if (!token.refresh_token) throw new Error("MuNET 未返回长期授权凭据");
  const accessToken = token.access_token;

  const profileResponse = await fetch(`${authOrigin}/connect/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!profileResponse.ok) throw new Error("无法读取 MuNET 账号");
  const profile = profileSchema.parse(await profileResponse.json());

  return {
    subject: profile.sub,
    name: profile.name,
    username: profile.preferred_username,
    cards: await fetchMunetCards(accessToken),
    tokens: {
      accessToken,
      expiresIn: token.expires_in,
      refreshToken: token.refresh_token,
    },
  };
}

export async function refreshMunetTokens(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string }> {
  const response = await fetch(`${authOrigin}/connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
    }),
  });
  if (response.status === 400 || response.status === 401) {
    throw new MunetAuthorizationExpiredError("MuNET 授权已过期");
  }
  if (!response.ok) throw new Error("MuNET 暂时无法刷新授权");
  const token = tokenSchema.parse(await response.json());
  return {
    accessToken: token.access_token,
    expiresIn: token.expires_in,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
  };
}

export async function fetchMunetCards(accessToken: string): Promise<MunetCard[]> {
  const response = await fetch(`${authOrigin}/connect/cards`, {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 401) throw new MunetAuthorizationExpiredError("MuNET Access Token 已过期");
  if (!response.ok) throw new Error("无法读取 MuNET 卡片");
  return cardsSchema.parse(await response.json());
}
