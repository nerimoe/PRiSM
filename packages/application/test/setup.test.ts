import { describe, expect, it } from "bun:test";
import { PrismDomainError, type AssetDefinition, type StaffUser, type AdminSession, type ApiToken } from "@prism/core";
import { createSetupService } from "../src/setup";

describe("createSetupService", () => {
  it("installs a store once with owner login, base assets, settings, and generated API tokens", async () => {
    const store = createMemorySetupStore();
    const service = createSetupService({
      system: store.system,
      assetDefinitions: store.assetDefinitions,
      id: createSequentialId(),
      now: () => new Date("2026-06-08T10:00:00.000Z"),
      hashPassword: async (password) => ({ hash: `hash:${password}`, salt: "salt-1" }),
      verifyPassword: async (password, user) => user.passwordHash === `hash:${password}`,
      createSecret: (label) => ({
        token: `${label}-plain`,
        tokenHash: `${label}-hash`,
        tokenPrefix: label,
      }),
      sessionDurationMs: 86_400_000,
    });

    await expect(service.getSetupStatus()).resolves.toEqual({
      installed: false,
    });

    const installed = await service.install({
      storeName: "音游窝",
      timeZone: "Asia/Tokyo",
      owner: {
        username: "owner",
        displayName: "店主",
        password: "correct horse battery staple",
      },
      coinCooldownMs: 60_000,
    });

    expect(installed.staffUser).toMatchObject({
      username: "owner",
      displayName: "店主",
      role: "owner",
      status: "active",
    });
    expect(installed.apiTokens).toEqual([
      {
        id: "id-2",
        label: "机器人/店内入口 API",
        role: "integration",
        token: "integration-plain",
        tokenPrefix: "integration",
        createdAt: new Date("2026-06-08T10:00:00.000Z"),
      },
      {
        id: "id-3",
        label: "机器软件接入 API",
        role: "machine",
        token: "machine-plain",
        tokenPrefix: "machine",
        createdAt: new Date("2026-06-08T10:00:00.000Z"),
      },
    ]);
    expect(store.assetDefinitions.saved).toEqual([
      {
        type: "currency",
        code: "paid",
        name: "余额",
        stackable: true,
        metadata: { system: true, displayUnit: "JPY" },
      },
      {
        type: "currency",
        code: "free",
        name: "赠送余额",
        stackable: true,
        metadata: { system: true, displayUnit: "JPY" },
      },
    ]);
    await expect(store.system.getAppSetting("store.profile")).resolves.toEqual({
      name: "音游窝",
      timeZone: "Asia/Tokyo",
    });
    await expect(store.system.getAppSetting("venue.operations")).resolves.toEqual({
      coinCooldownMs: 60_000,
    });
    await expect(service.getSetupStatus()).resolves.toEqual({
      installed: true,
    });
    await expect(service.install({
      storeName: "Duplicate",
      timeZone: "Asia/Tokyo",
      owner: {
        username: "owner2",
        displayName: "Owner 2",
        password: "password",
      },
      coinCooldownMs: 60_000,
    })).rejects.toMatchObject({
      code: "PRISM_ALREADY_INSTALLED",
    });
  });

  it("lets onboarding customize base asset display names and unit without changing stable asset codes", async () => {
    const store = createMemorySetupStore();
    const service = createSetupService({
      system: store.system,
      assetDefinitions: store.assetDefinitions,
      id: createSequentialId(),
      now: () => new Date("2026-06-08T10:00:00.000Z"),
      hashPassword: async (password) => ({ hash: `hash:${password}`, salt: "salt-1" }),
      verifyPassword: async (password, user) => user.passwordHash === `hash:${password}`,
      createSecret: (label) => ({
        token: `${label}-plain`,
        tokenHash: `${label}-hash`,
        tokenPrefix: label,
      }),
      sessionDurationMs: 86_400_000,
    });

    await service.install({
      storeName: "信用制店铺",
      timeZone: "Asia/Tokyo",
      owner: {
        username: "owner",
        displayName: "店主",
        password: "password",
      },
      coinCooldownMs: 45_000,
      baseAssets: {
        paid: {
          name: "游戏点数",
          displayUnit: "点",
        },
        free: {
          name: "活动点数",
          displayUnit: "点",
        },
      },
    });

    expect(store.assetDefinitions.saved).toEqual([
      {
        type: "currency",
        code: "paid",
        name: "游戏点数",
        stackable: true,
        metadata: { system: true, displayUnit: "点" },
      },
      {
        type: "currency",
        code: "free",
        name: "活动点数",
        stackable: true,
        metadata: { system: true, displayUnit: "点" },
      },
    ]);
  });

  it("logs in active staff users by creating an admin session", async () => {
    const store = createMemorySetupStore();
    const service = createSetupService({
      system: store.system,
      assetDefinitions: store.assetDefinitions,
      id: createSequentialId(),
      now: () => new Date("2026-06-08T10:00:00.000Z"),
      hashPassword: async (password) => ({ hash: `hash:${password}`, salt: "salt-1" }),
      verifyPassword: async (password, user) => user.passwordHash === `hash:${password}`,
      createSecret: (label) => ({
        token: `${label}-plain`,
        tokenHash: `${label}-hash`,
        tokenPrefix: label,
      }),
      sessionDurationMs: 3_600_000,
    });

    await store.system.saveStaffUser({
      id: "staff-1",
      username: "owner",
      displayName: "店主",
      passwordHash: "hash:password",
      passwordSalt: "salt",
      role: "owner",
      status: "active",
      createdAt: new Date("2026-06-08T09:00:00.000Z"),
      updatedAt: new Date("2026-06-08T09:00:00.000Z"),
    });

    const login = await service.login({
      username: "owner",
      password: "password",
    });

    expect(login).toMatchObject({
      token: "admin-session-plain",
      staff: {
        id: "staff-1",
        username: "owner",
        displayName: "店主",
        role: "owner",
      },
    });
    expect(store.sessions).toEqual([
      {
        id: "id-1",
        staffUserId: "staff-1",
        tokenHash: "admin-session-hash",
        expiresAt: new Date("2026-06-08T11:00:00.000Z"),
        createdAt: new Date("2026-06-08T10:00:00.000Z"),
        lastUsedAt: new Date("2026-06-08T10:00:00.000Z"),
      },
    ]);

    await expect(service.login({ username: "owner", password: "wrong" })).rejects.toBeInstanceOf(PrismDomainError);
    await expect(service.login({ username: "owner", password: "wrong" })).rejects.toMatchObject({
      code: "ADMIN_LOGIN_FAILED",
    });
  });
});

function createSequentialId() {
  let next = 0;
  return () => `id-${++next}`;
}

function createMemorySetupStore() {
  const staffUsers = new Map<string, StaffUser>();
  const apiTokens = new Map<string, ApiToken>();
  const settings = new Map<string, unknown>();
  const sessions: AdminSession[] = [];
  const assetDefinitions = {
    saved: [] as AssetDefinition[],
    async save(definition: AssetDefinition) {
      this.saved.push(definition);
    },
    async findByCode(type: string, code: string) {
      return this.saved.find((definition) => definition.type === type && definition.code === code) ?? null;
    },
    async listAll() {
      return [...this.saved];
    },
  };

  return {
    sessions,
    assetDefinitions,
    system: {
      async hasOwnerStaffUser() {
        return [...staffUsers.values()].some((user) => user.role === "owner" && user.status === "active");
      },
      async saveStaffUser(user: StaffUser) {
        staffUsers.set(user.id, user);
      },
      async listStaffUsers() {
        return [...staffUsers.values()];
      },
      async findStaffUserByUsername(username: string) {
        return [...staffUsers.values()].find((user) => user.username === username) ?? null;
      },
      async findStaffUserById(staffUserId: string) {
        return staffUsers.get(staffUserId) ?? null;
      },
      async saveAdminSession(session: AdminSession) {
        sessions.push(session);
      },
      async findAdminSessionByTokenHash(tokenHash: string) {
        return sessions.find((session) => session.tokenHash === tokenHash) ?? null;
      },
      async revokeAdminSession(sessionId: string) {
        const index = sessions.findIndex((session) => session.id === sessionId);
        if (index >= 0) sessions.splice(index, 1);
      },
      async saveApiToken(token: ApiToken) {
        apiTokens.set(token.id, token);
      },
      async listApiTokens() {
        return [...apiTokens.values()];
      },
      async findActiveApiTokenByHash(tokenHash: string) {
        return [...apiTokens.values()].find((token) => token.tokenHash === tokenHash && token.status === "active") ?? null;
      },
      async updateApiTokenLastUsed(tokenId: string, usedAt: Date) {
        const token = apiTokens.get(tokenId);
        if (token) token.lastUsedAt = usedAt;
      },
      async revokeApiToken(tokenId: string, revokedAt: Date) {
        const token = apiTokens.get(tokenId);
        if (token) {
          token.status = "revoked";
          token.revokedAt = revokedAt;
        }
      },
      async setAppSetting(key: string, value: unknown) {
        settings.set(key, value);
      },
      async getAppSetting<T = unknown>(key: string): Promise<T | null> {
        return (settings.get(key) as T | undefined) ?? null;
      },
      async listAppSettings() {
        return [...settings.entries()].map(([key, value]) => ({
          key,
          value,
          updatedAt: new Date("2026-06-08T10:00:00.000Z"),
        }));
      },
    },
  };
}
