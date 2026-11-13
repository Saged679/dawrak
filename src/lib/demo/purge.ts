import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

const FIXED_USER = /^a0000000-0000-4000-8000-00000000000[0-9]$/;

/**
 * Backup for the pg_cron job: deletes expired demo visitors through the Auth Admin API, using the ids
 * in demo_users. Idempotent (an already-deleted user is not an error). The six fixed seeded users are
 * never touched. Also tries the SQL function first; if the hosted project does not allow SQL deletion
 * from auth.users, that call fails and the API path still works.
 */
export async function purgeExpiredDemoUsers(
  admin: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<{ deleted: number; failed: number }> {
  const sql = await admin.rpc("purge_expired_demo_users");
  if (sql.error) console.error("demo_purge_sql_unavailable", sql.error.code ?? "unknown");

  const { data, error } = await admin
    .from("demo_users")
    .select("user_id")
    .lt("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: true })
    .limit(opts.limit ?? 100);
  if (error) {
    console.error("demo_purge_list_error", error.code ?? "unknown");
    return { deleted: 0, failed: 0 };
  }
  let deleted = 0;
  let failed = 0;
  for (const row of (data ?? []) as { user_id: string }[]) {
    if (FIXED_USER.test(row.user_id)) continue;
    const { error: delError } = await admin.auth.admin.deleteUser(row.user_id);
    if (!delError || delError.status === 404 || /not.?found/i.test(delError.message ?? "")) {
      deleted++;
      // the registry row cascades with auth.users; drop it explicitly if the user was already gone
      await admin.from("demo_users").delete().eq("user_id", row.user_id);
    } else {
      failed++;
      console.error("demo_purge_delete_error", delError.status ?? "unknown");
    }
  }
  return { deleted, failed };
}
