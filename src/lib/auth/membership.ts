import type { Role } from "./roles";

export type TenantInfo = {
  id: string;
  name_ar: string;
  name_en: string | null;
  kind: "clinic" | "salon";
  timezone: string;
  currency: string;
  is_demo: boolean;
};

export type MembershipInfo = { tenant: TenantInfo; role: Role };

/** Pure: picks the active membership. A cookie value is only a hint and must match a real row. */
export function pickMembership(
  memberships: MembershipInfo[],
  preferredTenantId: string | undefined,
): MembershipInfo | null {
  if (memberships.length === 0) return null;
  return memberships.find((m) => m.tenant.id === preferredTenantId) ?? memberships[0];
}
