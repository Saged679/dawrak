import "server-only";
import { getServiceClient } from "@/lib/db/client";
import { selectMailProvider, type MailEnv } from "./select";
import type { MailProvider } from "./types";
import type { OutboxWriter } from "./outbox";

export const supabaseOutboxWriter: OutboxWriter = async (a) => {
  const { error } = await getServiceClient().rpc("demo_outbox_add", {
    p_tenant_id: a.tenantId,
    p_session_hash: a.sessionHash,
    p_kind: a.kind,
    p_to: a.to,
    p_subject: a.subject,
    p_body: a.text,
  });
  if (error) throw error;
};

/** Provider for a tenant, from the process environment (see selectMailProvider). */
export function mailProviderFor(tenant: { is_demo: boolean }): MailProvider {
  return selectMailProvider(tenant, process.env as MailEnv, { outboxWriter: supabaseOutboxWriter });
}
