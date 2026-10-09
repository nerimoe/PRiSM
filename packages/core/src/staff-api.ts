/** Public response of GET /api/v1/shops/:shopCode/staff/me.
 * Keep this independent from the internal authentication principal.
 */
export type StaffMeView = {
  id: string;
  displayName: string;
  role: "owner" | "manager" | "viewer";
  canWrite: boolean;
};
