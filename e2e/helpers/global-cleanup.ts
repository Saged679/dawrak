import { SERVICE_KEY, SUPABASE_URL, adminFetch, hasLocalDb, rest } from "./tenant";

/**
 * Every click on /demo creates a temporary visitor (cap: 150 per demo business), and a test run clicks it a
 * lot. Setup and teardown delete all visitors (and the conversations the chat specs created) through the Admin API, the same way the hosted backup purge does.
 * Local stack only: it is skipped unless the Supabase URL is the 553xx stack.
 */
export default async function cleanupDemoVisitors() {
  if (!hasLocalDb() || !/^https?:\/\/(127\.0\.0\.1|localhost):553\d\d/.test(SUPABASE_URL ?? "") || !SERVICE_KEY) return;
  try {
    const rows = (await rest("demo_users?select=user_id&limit=1000")) as { user_id: string }[];
    for (let i = 0; i < rows.length; i += 10) {
      await Promise.all(rows.slice(i, i + 10).map((r) => adminFetch(`/admin/users/${r.user_id}`, { method: "DELETE" })));
    }
  } catch {
    // best effort
  }
  // Chat specs create conversations (a few per run). The conversations dashboard page lists only the newest
  // ones, so after enough runs the SEEDED conversation (cc000000-...) that knowledge.spec opens fell off the
  // list. Remove every conversation that is not part of the seed (messages cascade).
  try {
    const convs = (await rest("conversations?select=id&limit=1000")) as { id: string }[];
    const extra = convs.map((c) => c.id).filter((id) => !id.startsWith("cc000000-0000-4000-8000-"));
    for (let i = 0; i < extra.length; i += 50) {
      await rest(`conversations?id=in.(${extra.slice(i, i + 50).join(",")})`, { method: "DELETE" });
    }
  } catch {
    // best effort
  }
}
