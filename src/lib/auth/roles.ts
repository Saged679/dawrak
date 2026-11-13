/** Pure role rules (no I/O) so they can be unit tested and shared by UI and server checks. */

export const ROLES = ["owner", "receptionist", "provider"] as const;
export type Role = (typeof ROLES)[number];

export const STATUSES = [
  "pending_payment",
  "confirmed",
  "completed",
  "no_show",
  "cancelled",
] as const;
export type AppointmentStatus = (typeof STATUSES)[number];

export type NavKey =
  | "overview"
  | "calendar"
  | "customers"
  | "services"
  | "providers"
  | "knowledge"
  | "conversations"
  | "revenue"
  | "settings";

export type NavItem = { key: NavKey; href: string; roles: readonly Role[] };

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "overview", href: "/dashboard", roles: ["owner", "receptionist", "provider"] },
  { key: "calendar", href: "/dashboard/calendar", roles: ["owner", "receptionist", "provider"] },
  // Customers: RLS limits a provider to customers on their own appointments.
  {
    key: "customers",
    href: "/dashboard/customers",
    roles: ["owner", "receptionist", "provider"],
  },
  { key: "services", href: "/dashboard/services", roles: ["owner", "receptionist"] },
  // A provider only gets their own schedule here (labelled "My schedule").
  {
    key: "providers",
    href: "/dashboard/providers",
    roles: ["owner", "receptionist", "provider"],
  },
  // Knowledge: owner only (RLS also limits writes to the owner). Conversations: staff, never providers.
  { key: "knowledge", href: "/dashboard/knowledge", roles: ["owner"] },
  { key: "conversations", href: "/dashboard/conversations", roles: ["owner", "receptionist"] },
  { key: "revenue", href: "/dashboard/revenue", roles: ["owner"] },
  { key: "settings", href: "/dashboard/settings", roles: ["owner"] },
];

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

export function navFor(role: Role): NavItem[] {
  return NAV_ITEMS.filter((i) => i.roles.includes(role));
}

export const canSeeRevenue = (role: Role) => role === "owner";
export const canReschedule = (role: Role) => role === "owner" || role === "receptionist";
/** Create / edit services, providers, working hours, time off. Stricter than RLS, which also lets receptionists write. */
export const canManageCatalog = (role: Role) => role === "owner";
export const canManageKnowledge = (role: Role) => role === "owner";
export const canViewConversations = (role: Role) => role === "owner" || role === "receptionist";
export const canEditSettings = (role: Role) => role === "owner";
export const canPickProvider = (role: Role) => role !== "provider";

/**
 * Statuses a role may move an appointment to. Mirrors the database (RLS and
 * staff_update_appointment): the database is the real gate, this only shapes the UI.
 */
export function allowedStatusTargets(role: Role, current: AppointmentStatus): AppointmentStatus[] {
  if (role === "provider") {
    if (current === "confirmed" || current === "completed" || current === "no_show") {
      return (["completed", "no_show"] as const).filter((s) => s !== current);
    }
    return [];
  }
  return STATUSES.filter((s) => s !== current);
}

/** Only same-app paths under /dashboard are accepted as a post-login target (no open redirect). */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/dashboard";
  if (raw.length > 200 || !/^\/dashboard(?:[\w\-/?=&.%]*)$/.test(raw)) return "/dashboard";
  if (raw.includes("//") || raw.includes("..")) return "/dashboard";
  return raw;
}
