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

/**
 * The whole catalogue (services, providers, provider-service links, hours, time off) of a demo business is read-only
 * for visitors: the database also refuses inserts there (demo_catalog_no_insert). Knowledge documents stay
 * owner-based (isLockedInDemo): a visitor can add their own, visible only to them.
 */
export function isCatalogLockedInDemo(session: { tenant: { is_demo: boolean } }): boolean {
  return session.tenant.is_demo;
}
