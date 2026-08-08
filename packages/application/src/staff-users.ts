import {
  PrismDomainError,
  type StaffRole,
  type StaffUser,
  type StaffUserStatus,
  type SystemRepository,
} from "@prism/core";

export type StaffUserView = Omit<StaffUser, "passwordHash" | "passwordSalt">;

export type StaffCreateUserInput = {
  username: string;
  displayName: string;
  password: string;
  role: StaffRole;
};

export type StaffUpdateUserInput = {
  staffUserId: string;
  displayName: string;
  role: StaffRole;
  status: StaffUserStatus;
};

export type StaffResetUserPasswordInput = {
  staffUserId: string;
  password: string;
};

export type StaffUserServiceDependencies = {
  system: SystemRepository;
  id: () => string;
  now: () => Date;
  hashPassword(password: string): Promise<{ hash: string; salt: string }>;
};

export type StaffUserService = {
  listStaffUsers(): Promise<StaffUserView[]>;
  createStaffUser(input: StaffCreateUserInput): Promise<StaffUserView>;
  updateStaffUser(input: StaffUpdateUserInput): Promise<StaffUserView>;
  resetStaffUserPassword(input: StaffResetUserPasswordInput): Promise<StaffUserView>;
};

export function createStaffUserService(dependencies: StaffUserServiceDependencies): StaffUserService {
  return {
    async listStaffUsers() {
      return (await dependencies.system.listStaffUsers()).map(toView);
    },

    async createStaffUser(input) {
      const username = normalizeUsername(input.username);
      const displayName = normalizeDisplayName(input.displayName);
      if (await dependencies.system.findStaffUserByUsername(username)) {
        throw new PrismDomainError("Staff username already exists.", "STAFF_USERNAME_ALREADY_EXISTS");
      }

      const now = dependencies.now();
      const password = await dependencies.hashPassword(input.password);
      const staffUser: StaffUser = {
        id: dependencies.id(),
        username,
        displayName,
        passwordHash: password.hash,
        passwordSalt: password.salt,
        role: input.role,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      await dependencies.system.saveStaffUser(staffUser);
      return toView(staffUser);
    },

    async updateStaffUser(input) {
      const existing = await dependencies.system.findStaffUserById(input.staffUserId);
      if (!existing) {
        throw new PrismDomainError("Staff user not found.", "STAFF_USER_NOT_FOUND");
      }

      const updated: StaffUser = {
        ...existing,
        displayName: normalizeDisplayName(input.displayName),
        role: input.role,
        status: input.status,
        updatedAt: dependencies.now(),
      };
      await assertHasActiveOwnerAfterUpdate(dependencies.system, updated);
      await dependencies.system.saveStaffUser(updated);
      return toView(updated);
    },

    async resetStaffUserPassword(input) {
      const existing = await dependencies.system.findStaffUserById(input.staffUserId);
      if (!existing) {
        throw new PrismDomainError("Staff user not found.", "STAFF_USER_NOT_FOUND");
      }
      const password = await dependencies.hashPassword(input.password);
      const updated: StaffUser = {
        ...existing,
        passwordHash: password.hash,
        passwordSalt: password.salt,
        updatedAt: dependencies.now(),
      };
      await dependencies.system.saveStaffUser(updated);
      return toView(updated);
    },
  };
}

async function assertHasActiveOwnerAfterUpdate(system: SystemRepository, updated: StaffUser): Promise<void> {
  const users = await system.listStaffUsers();
  const hasActiveOwner = users.some((user) => {
    const candidate = user.id === updated.id ? updated : user;
    return candidate.role === "owner" && candidate.status === "active";
  });
  if (!hasActiveOwner) {
    throw new PrismDomainError("At least one active owner staff user is required.", "STAFF_LAST_OWNER_REQUIRED");
  }
}

function normalizeUsername(username: string): string {
  const normalized = username.trim().toLowerCase();
  if (!normalized) {
    throw new PrismDomainError("Staff username is required.", "STAFF_USERNAME_REQUIRED");
  }
  return normalized;
}

function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim();
  if (!normalized) {
    throw new PrismDomainError("Staff display name is required.", "STAFF_DISPLAY_NAME_REQUIRED");
  }
  return normalized;
}

function toView(staffUser: StaffUser): StaffUserView {
  const { passwordHash: _passwordHash, passwordSalt: _passwordSalt, ...view } = staffUser;
  return view;
}
