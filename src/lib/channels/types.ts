import type { runAgent } from "@/lib/agent/run-agent";
import type { AgentMessage, Locale } from "@/lib/agent/types";

export type AgentStream = Awaited<ReturnType<typeof runAgent>>;

/** How a channel identifies the business. The route resolves it to a tenant id server-side. */
export type TenantRef = { slug: string } | { id: string };

/** Channel-neutral inbound message: everything the agent core needs. */
export type InboundMessage = {
  channel: "web" | "whatsapp";
  tenant: TenantRef;
  /** Web: client-held session id. */
  conversationId?: string;
  /** WhatsApp: sender phone number (E.164). */
  externalId?: string;
  message: AgentMessage;
  locale: Locale;
};

/** Thrown by adapters for client errors; the route turns it into clear error JSON. */
export class ChannelError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/**
 * A channel maps its raw transport (HTTP request, webhook payload...) to an InboundMessage and
 * maps the streamed reply of the agent back to its own transport. Nothing channel-specific may
 * leak into src/lib/agent.
 */
export interface ChannelAdapter<TRaw, TOut> {
  readonly channel: InboundMessage["channel"];
  /** Cheap request checks that must run BEFORE any rate limit is counted (same-site, content type). Throws ChannelError. */
  precheck?(raw: TRaw): void;
  parseInbound(raw: TRaw): Promise<InboundMessage>;
  respond(result: AgentStream, ctx: { conversationId: string }): TOut | Promise<TOut>;
}
