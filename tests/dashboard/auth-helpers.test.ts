import { describe, expect, it } from "vitest";
import { pathInfo } from "@/lib/auth/paths";
import {
  allowedStatusTargets,
  canReschedule,
  canSeeRevenue,
  navFor,
  safeNextPath,
} from "@/lib/auth/roles";
import { pickMembership, type MembershipInfo } from "@/lib/auth/membership";
import { isDemoPersona } from "@/lib/auth/demo";
import { mapStaffError } from "@/lib/dashboard/errors";

describe("role navigation and permissions", () => {
  it("hides revenue from everyone except the owner", () => {
    expect(navFor("owner").map((i) => i.key)).toEqual([
      "overview",
      "calendar",
      "customers",
      "services",
      "providers",
      "knowledge",
      "conversations",
      "revenue",
      "settings",
    ]);
    expect(navFor("receptionist").map((i) => i.key)).toEqual([
      "overview",
      "calendar",
      "customers",
      "services",
      "providers",
      "conversations",
    ]);
    expect(navFor("provider").map((i) => i.key)).toEqual(["overview", "calendar", "customers", "providers"]);
    expect(canSeeRevenue("owner")).toBe(true);
    expect(canSeeRevenue("receptionist")).toBe(false);
    expect(canSeeRevenue("provider")).toBe(false);
  });

  it("lets only staff reschedule", () => {
    expect(canReschedule("owner")).toBe(true);
    expect(canReschedule("receptionist")).toBe(true);
    expect(canReschedule("provider")).toBe(false);
  });

  it("limits providers to completed / no_show on appointments that are theirs to close", () => {
    expect(allowedStatusTargets("provider", "confirmed").sort()).toEqual(["completed", "no_show"]);
    expect(allowedStatusTargets("provider", "completed")).toEqual(["no_show"]);
    expect(allowedStatusTargets("provider", "pending_payment")).toEqual([]);
    expect(allowedStatusTargets("provider", "cancelled")).toEqual([]);
    expect(allowedStatusTargets("receptionist", "confirmed")).not.toContain("confirmed");
    expect(allowedStatusTargets("owner", "confirmed")).toContain("cancelled");
  });
});

describe("safeNextPath", () => {
  it("keeps dashboard paths with a query string", () => {
    expect(safeNextPath("/dashboard/calendar?view=week&date=2026-11-15")).toBe(
      "/dashboard/calendar?view=week&date=2026-11-15",
    );
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
  });
  it("rejects anything that could leave the app", () => {
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/dashboard//evil.example",
      "/dashboard/../login",
      "/login",
      "javascript:alert(1)",
      "",
      null,
      undefined,
    ]) {
      expect(safeNextPath(bad as string | null | undefined)).toBe("/dashboard");
    }
  });
});

describe("pathInfo", () => {
  it("classifies protected and session paths", () => {
    expect(pathInfo("/ar/dashboard")).toMatchObject({ locale: "ar", path: "/dashboard", protectedRoute: true });
    expect(pathInfo("/en/dashboard/calendar")).toMatchObject({ locale: "en", protectedRoute: true });
    expect(pathInfo("/en/login")).toMatchObject({ protectedRoute: false, needsSession: true });
    expect(pathInfo("/en/demo")).toMatchObject({ protectedRoute: false, needsSession: true });
    expect(pathInfo("/ar/c/demo-clinic")).toMatchObject({ needsSession: false });
    expect(pathInfo("/ar")).toMatchObject({ needsSession: false });
    expect(pathInfo("/dashboard").locale).toBeNull();
    expect(pathInfo("/ar/dashboardx").protectedRoute).toBe(false);
  });
});

describe("pickMembership", () => {
  const m = (id: string, role: "owner" | "provider"): MembershipInfo => ({
    role,
    tenant: {
      id,
      name_ar: id,
      name_en: id,
      kind: "clinic",
      timezone: "Asia/Riyadh",
      currency: "SAR",
      is_demo: false,
    },
  });
  it("defaults to the first membership and ignores a cookie that is not theirs", () => {
    const list = [m("a", "owner"), m("b", "provider")];
    expect(pickMembership(list, undefined)?.tenant.id).toBe("a");
    expect(pickMembership(list, "b")?.tenant.id).toBe("b");
    expect(pickMembership(list, "someone-elses-tenant")?.tenant.id).toBe("a");
    expect(pickMembership([], "a")).toBeNull();
  });
});

describe("demo personas", () => {
  it("only accepts the known personas (no provider persona: it cannot be per-visitor)", () => {
    expect(isDemoPersona("salon-owner")).toBe(true);
    expect(isDemoPersona("admin")).toBe(false);
    expect(isDemoPersona("clinic-doctor")).toBe(false);
    expect(isDemoPersona(null)).toBe(false);
  });
});

describe("mapStaffError", () => {
  it("maps database errors to friendly codes", () => {
    expect(mapStaffError({ code: "23P01", message: "slot_taken" })).toBe("slot_taken");
    expect(mapStaffError({ message: "slot_taken" })).toBe("slot_taken");
    expect(mapStaffError({ code: "42501", message: "forbidden" })).toBe("forbidden");
    expect(mapStaffError({ message: "permission denied for table" })).toBe("forbidden");
    expect(mapStaffError({ message: "appointment_not_found" })).toBe("not_found");
    expect(mapStaffError({ message: "invalid_status" })).toBe("invalid");
    expect(mapStaffError({ message: "boom" })).toBe("generic");
    expect(mapStaffError(null)).toBe("generic");
  });
});
