import { describe, expect, it } from "bun:test";
import { resolveStaffAccess } from "./staff-access";

describe("merchant staff/me compatibility", () => {
  it("shows owner-only shop settings and enables report quick archive", () => {
    expect(resolveStaffAccess({ role: "owner", canWrite: true }))
      .toEqual({ owner: true, canWrite: true });
    expect(resolveStaffAccess({ role: "staff", staffRole: "owner" }))
      .toEqual({ owner: true, canWrite: true });
  });

  it("allows manager quick archive but not shop settings", () => {
    expect(resolveStaffAccess({ role: "manager", canWrite: true }))
      .toEqual({ owner: false, canWrite: true });
    expect(resolveStaffAccess({ role: "staff", staffRole: "manager" }))
      .toEqual({ owner: false, canWrite: true });
  });

  it("hides both actions for read-only staff and unknown roles", () => {
    for (const staff of [
      { role: "viewer", canWrite: false },
      { role: "staff", staffRole: "viewer" },
      { role: "staff" },
      { role: "admin", canWrite: true },
      {},
      { role: "owner", canWrite: false },
    ]) {
      const { owner, canWrite } = resolveStaffAccess(staff);
      expect(canWrite).toBe(false);
      if (staff.role !== "owner") expect(owner).toBe(false);
    }
  });

  it("prioritizes the shop role over the internal principal discriminator", () => {
    expect(resolveStaffAccess({ role: "staff", staffRole: "viewer", canWrite: true }))
      .toEqual({ owner: false, canWrite: false });
    expect(resolveStaffAccess({ role: "owner", staffRole: "viewer" }))
      .toEqual({ owner: false, canWrite: false });
  });
});
