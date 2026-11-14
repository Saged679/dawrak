import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentState as AgentStateLike } from "./state";

/** Only the parts of supabase-js the agent needs (easy to fake in tests). */
export type AgentDb = Pick<SupabaseClient, "rpc" | "from">;

export type Locale = "ar" | "en";

/** A user message in channel-neutral form. */
export type AgentMessage =
  | { type: "text"; text: string }
  | {
      type: "audio";
      data: Uint8Array | string /* base64 */;
      /** full media type without parameters, e.g. audio/wav (Gemini takes it as the inlineData mimeType) */
      mediaType: string;
      /** from the WAV header; null when the container cannot be measured */
      durationSeconds?: number | null;
    };

export type TenantInfo = {
  id: string;
  name_ar: string;
  name_en: string;
  kind: "clinic" | "salon";
  timezone: string;
  currency: string;
};

/**
 * Server-side context handed to every tool. `tenantId` comes from the server (resolved from the
 * channel), NEVER from model arguments. Tool input schemas are strict and contain no tenant field.
 */
export type ToolContext = {
  db: AgentDb;
  tenantId: string;
  conversationId: string;
  timezone: string;
  locale: Locale;
  /** Embeds a search query (768 dims). Injected so tests never hit Gemini. */
  embedQuery: (text: string) => Promise<number[]>;
  /** Channel hook run after a booking succeeds: attaches the demo session, queues the confirmation mail. */
  afterBooking?: AfterBooking;
  /**
   * What the SERVER knows about the visitor in this conversation (never supplied by the model): the number of
   * visitor messages (including the current one), their typed texts (voice notes excluded: audio cannot
   * ground text values) and the current request's message. The confirmation protocol and the grounding of
   * name/phone/email are checked against this.
   */
  visitor: VisitorContext;
  /** Remembered state (last availability, pending confirmation); optional, best-effort. */
  state?: { readonly current: AgentStateLike; patch(p: AgentStateLike): Promise<boolean | void> };
  /** HMAC key for confirmation tokens; default: derived from the server secret (see confirm.ts). */
  confirmKey?: Buffer;
  /** Clock (ms), injectable for tests. */
  now?: () => number;
};

export type VisitorContext = {
  userMessageCount: number;
  texts: string[];
  latest: { type: "text"; text: string } | { type: "audio" };
};

/** What a successful create_booking hands to the channel layer (server side only, never to the model). */
export type BookingEvent = {
  appointmentId: string;
  /** Set only when this call created the customer (the database never returns a token otherwise). */
  customerToken: string | null;
  email: string | null;
};

/**
 * Whether a confirmation email was queued. `demo_mailbox`: saved in the visitor's demo mailbox (nothing
 * leaves the system). `queued`: handed to the mail provider. `not_sent`: no email applies or it failed.
 */
export type BookingMailOutcome = "queued" | "demo_mailbox" | "not_sent";

export type AfterBooking = (b: BookingEvent) => Promise<BookingMailOutcome>;
