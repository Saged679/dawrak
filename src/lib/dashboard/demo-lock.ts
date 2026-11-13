/**
 * Demo businesses are read-mostly (DB triggers, migration 22): a signed-in demo visitor cannot update or delete
 * the seeded services, providers, hours, time off or knowledge rows, only rows they created themselves
 * (created_by = their user id). This mirrors that rule so the UI can show a banner and disable controls; the
 * database stays the real gate.
 */
export function isLockedInDemo(
  session: { tenant: { is_demo: boolean }; userId: string },
  createdBy: string | null | undefined,
): boolean {
  return session.tenant.is_demo && (!createdBy || createdBy !== session.userId);
}
