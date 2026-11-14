import { beforeEach } from "vitest";
import { resetCatalogCache } from "@/lib/agent/catalog";

// A fixed test secret for the chat confirmation tokens (never a real key) and a fresh catalog cache per test.
process.env.CHAT_CONFIRM_SECRET = "vitest-only-confirmation-secret-0123456789";
beforeEach(() => resetCatalogCache());
