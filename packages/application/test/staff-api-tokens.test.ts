import { describe, expect, it } from "bun:test";
import { PrismDomainError, type ApiToken, type SystemRepository } from "@prism/core";
import { createStaffApiTokenService } from "../src/staff-api-tokens";

describe("createStaffApiTokenService", () => {
  it("lists token metadata, creates one-time visible API tokens, and revokes tokens", async () => {
    const store = createMemorySystemRepository();
    await store.saveApiToken({
      id: "token-1",
      label: "机器人/店内入口 API",
      role: "integration",
      tokenPrefix: "integration",
      tokenHash: "secret-hash",
      status: "active",
      createdAt: new Date("2026-06-08T09:00:00.000Z"),
      lastUsedAt: new Date("2026-06-08T09:30:00.000Z"),
      revokedAt: null,
    });
    const service = createStaffApiTokenService({
      system: store,
      id: createSequentialId(),
      now: () => new Date("2026-06-08T10:00:00.000Z"),
      createSecret: (role) => ({
        token: `${role}-plain`,
        tokenPrefix: role,
        tokenHash: `${role}-hash`,
      }),
    });

    await expect(service.listApiTokens()).resolves.toEqual([
      {
        id: "token-1",
        label: "机器人/店内入口 API",
        role: "integration",
        tokenPrefix: "integration",
        status: "active",
        createdAt: new Date("2026-06-08T09:00:00.000Z"),
        lastUsedAt: new Date("2026-06-08T09:30:00.000Z"),
        revokedAt: null,
      },
    ]);

    const created = await service.createApiToken({
      label: "机器软件接入",
      role: "machine",
    });
    expect(created).toEqual({
      id: "id-1",
      label: "机器软件接入",
      role: "machine",
      token: "machine-plain",
      tokenPrefix: "machine",
      status: "active",
      createdAt: new Date("2026-06-08T10:00:00.000Z"),
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(await store.findActiveApiTokenByHash("machine-hash")).toMatchObject({
      id: "id-1",
      role: "machine",
      status: "active",
    });

    await expect(service.revokeApiToken({ tokenId: "id-1" })).resolves.toMatchObject({
      id: "id-1",
      status: "revoked",
      revokedAt: new Date("2026-06-08T10:00:00.000Z"),
    });
    await expect(store.findActiveApiTokenByHash("machine-hash")).resolves.toBeNull();
    await expect(service.revokeApiToken({ tokenId: "missing" })).rejects.toMatchObject({
      code: "API_TOKEN_NOT_FOUND",
    });
  });

  it("rejects generated and player API token roles", async () => {
    const service = createStaffApiTokenService({
      system: createMemorySystemRepository(),
      id: createSequentialId(),
      now: () => new Date("2026-06-08T10:00:00.000Z"),
      createSecret: (role) => ({
        token: `${role}-plain`,
        tokenPrefix: role,
        tokenHash: `${role}-hash`,
      }),
    });

    for (const role of ["bot", "agent", "player"]) {
      await expect(service.createApiToken({
        label: "旧角色",
        role: role as never,
      })).rejects.toMatchObject({
        code: "API_TOKEN_ROLE_NOT_SUPPORTED",
      });
    }
  });
});

function createSequentialId() {
  let next = 0;
  return () => `id-${++next}`;
}

function createMemorySystemRepository(): SystemRepository {
  const apiTokens = new Map<string, ApiToken>();
  return {
    async hasOwnerStaffUser() {
      return false;
    },
    async saveStaffUser() {},
    async listStaffUsers() {
      return [];
    },
    async findStaffUserByUsername() {
      return null;
    },
    async findStaffUserById() {
      return null;
    },
    async saveAdminSession() {},
    async findAdminSessionByTokenHash() {
      return null;
    },
    async revokeAdminSession() {},
    async saveApiToken(token) {
      apiTokens.set(token.id, { ...token });
    },
    async listApiTokens() {
      return [...apiTokens.values()].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    },
    async findActiveApiTokenByHash(tokenHash) {
      return [...apiTokens.values()].find((token) => token.tokenHash === tokenHash && token.status === "active") ?? null;
    },
    async updateApiTokenLastUsed(tokenId, usedAt) {
      const token = apiTokens.get(tokenId);
      if (token) apiTokens.set(tokenId, { ...token, lastUsedAt: usedAt });
    },
    async revokeApiToken(tokenId, revokedAt) {
      const token = apiTokens.get(tokenId);
      if (token) apiTokens.set(tokenId, { ...token, status: "revoked", revokedAt });
    },
    async setAppSetting() {},
    async getAppSetting() {
      return null;
    },
    async listAppSettings() {
      return [];
    },
  };
}
