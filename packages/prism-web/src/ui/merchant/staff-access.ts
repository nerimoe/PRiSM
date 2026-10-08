/** Merchant navigation capabilities come from shop staff roles, not the
 * internal authenticated-principal discriminator ("staff").
 * The server supports both the historic role/canWrite DTO and the
 * post-consolidation staffRole DTO while old clients are still in use.
 */
export type StaffMe = {
  role?: string;
  staffRole?: string;
  canWrite?: boolean;
};

export function resolveStaffAccess(staff: StaffMe): {
  owner: boolean;
  canWrite: boolean;
} {
  const role = staff.staffRole === "owner" ||
    staff.staffRole === "manager" ||
    staff.staffRole === "viewer"
    ? staff.staffRole
    : staff.role;

  const owner = role === "owner";
  // A mismatched/unknown role must never grant access just because a capability
  // flag is true. The server checks the same permissions on every mutation.
  const canWrite = (owner || role === "manager") && staff.canWrite !== false;
  return { owner, canWrite };
}
