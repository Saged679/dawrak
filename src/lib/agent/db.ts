import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { AgentDb } from "./types";

/** Service-role client. Server only: it bypasses RLS, so every query must filter by tenant. */
export function createAgentDb(): AgentDb {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service role is not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
