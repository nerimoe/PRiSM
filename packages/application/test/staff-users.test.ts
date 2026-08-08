import { describe, expect, it } from "bun:test";
import type { ApiToken, StaffUser, SystemRepository } from "@prism/core";
import { createStaffUserService } from "../src/staff-users";

describe("createStaffUserService", () => {
  it("lets an owner list, create, update, and disable staff users without exposing password hashes", async () => {
    const store = createMemorySystemRepository();
    await store.saveStaffUser(createStaffUser({
      id: "owner-1",
      username: "owner",
      displayName: "店主",
      role: "owner",
    }));

    const service = createStaffUserService({
      system: store,
      id: createSequentialId(),
      now: () => new Date("2026-06-08T10:00:00.000Z"),
      hashPassword: async (password) => ({ hash: `hash:${password}`, salt: "salt-1" }),
    });

    const created = await service.createStaffUser({
      username: " Manager ",
      displayName: "值班店员",
      password: "temporary-password",
      role: "manager",
    });

    expect(created).toEqual({
      id: "id-1",
      username: "manager",
      displayName: "值班店员",
      role: "manager",
      status: "active",
      createdAt: new Date("2026-06-08T10:00:00.000Z"),
      updatedAt: new Date("2026-06-08T10:00:00.000Z"),
    });
    expect(await store.findStaffUserByUsername("manager")).toMatchObject({
      passwordHash: "hash:temporary-password",
      passwordSalt: "salt-1",
    });

    await expect(service.listStaffUsers()).resolves.toEqual([
      {
        id: "owner-1",
        username: "owner",
        displayName: "店主",
        role: "owner",
        status: "active",
        createdAt: new Date("2026-06-08T09:00:00.000Z"),
        updatedAt: new Date("2026-06-08T09:00:00.000Z"),
      },
      created,
    ]);

    await expect(service.updateStaffUser({
      staffUserId: "id-1",
      displayName: "资深店员",
      role: "viewer",
      status: "disabled",
    })).resolves.toMatchObject({
      id: "id-1",
      displayName: "资深店员",
      role: "viewer",
      status: "disabled",
      updatedAt: new Date("2026-06-08T10:00:00.000Z"),
    });

    await expect(service.resetStaffUserPassword({
      staffUserId: "id-1",
      password: "next-password",
    })).resolves.toMatchObject({
      id: "id-1",
      username: "manager",
      updatedAt: new Date("2026-06-08T10:00:00.000Z"),
    });
    expect(await store.findStaffUserById("id-1")).toMatchObject({
      passwordHash: "hash:next-password",
      passwordSalt: "salt-1",
    });
  });

  it("rejects duplicate usernames, missing staff users, and disabling the last active owner", async () => {
    const store = createMemorySystemRepository();
    await store.saveStaffUser(createStaffUser({
      id: "owner-1",
      username: "owner",
      displayName: "店主",
      role: "owner",
    }));
    const service = createStaffUserService({
      system: store,
      id: createSequentialId(),
      now: () => new Date("2026-06-08T10:00:00.000Z"),
      hashPassword: async (password) => ({ hash: `hash:${password}`, salt: "salt-1" }),
    });

    await expect(service.createStaffUser({
      username: "OWNER",
      displayName: "重复店主",
      password: "password",
      role: "manager",
    })).rejects.toMatchObject({
      code: "STAFF_USERNAME_ALREADY_EXISTS",
    });
    await expect(service.updateStaffUser({
      staffUserId: "missing",
      displayName: "Nobody",
      role: "viewer",
      status: "active",
    })).rejects.toMatchObject({
      code: "STAFF_USER_NOT_FOUND",
    });
    await expect(service.updateStaffUser({
      staffUserId: "owner-1",
      displayName: "店主",
      role: "owner",
      status: "disabled",
    })).rejects.toMatchObject({
      code: "STAFF_LAST_OWNER_REQUIRED",
    });
  });
});

function createSequentialId() {
  let next = 0;
  return () => `id-${++next}`;
}

function createStaffUser(input: {
  id: string;
  username: string;
  displayName: string;
  role: StaffUser["role"];
  status?: StaffUser["status"];
}): StaffUser {
  return {
    id: input.id,
    username: input.username,
    displayName: input.displayName,
    passwordHash: "hash:password",
    passwordSalt: "salt",
    role: input.role,
    status: input.status ?? "active",
    createdAt: new Date("2026-06-08T09:00:00.000Z"),
    updatedAt: new Date("2026-06-08T09:00:00.000Z"),
  };
}

function createMemorySystemRepository(): SystemRepository {
  const staffUsers = new Map<string, StaffUser>();
  const apiTokens = new Map<string, ApiToken>();
  return {
    async hasOwnerStaffUser() {
      return [...staffUsers.values()].some((user) => user.role === "owner" && user.status === "active");
    },
    async saveStaffUser(user) {
      staffUsers.set(user.id, { ...user });
    },
    async listStaffUsers() {
      return [...staffUsers.values()].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    },
    async findStaffUserByUsername(username) {
      return [...staffUsers.values()].find((user) => user.username === username) ?? null;
    },
    async findStaffUserById(staffUserId) {
      return staffUsers.get(staffUserId) ?? null;
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
      return [...apiTokens.values()];
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
