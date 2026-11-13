import { describe, expect, it, vi } from "vitest";
import { createDemoVisitor, newVisitorCredentials } from "@/lib/demo/visitor";
import { purgeExpiredDemoUsers } from "@/lib/demo/purge";
import { DEMO_CLINIC_ID } from "@/lib/auth/demo";

const UID = "11111111-2222-4333-8444-555555555555";

function fakeAdmin(o: { create?: unknown; register?: { code?: string; message: string } | null } = {}) {
  const createUser = vi.fn(async (a: Record<string, unknown>) => (o.create as object) ?? { data: { user: { id: UID } }, error: null, _a: a });
  const deleteUser = vi.fn(async () => ({ error: null }));
  const rpc = vi.fn(async (_fn: string, args: Record<string, unknown>) => ({ error: o.register ?? null, data: args }));
  return { admin: { auth: { admin: { createUser, deleteUser } }, rpc } as never, createUser, deleteUser, rpc };
}

const okSignIn = async () => ({ error: null });
const noop = async () => {};

describe("createDemoVisitor (H1)", () => {
  it("creates a flagged, confirmed user with random e-mail/password, signs in, then registers the persona's tenant+role", async () => {
    const f = fakeAdmin();
    let used: { email: string; password: string } | null = null;
    const res = await createDemoVisitor("clinic-reception", {
      admin: f.admin,
      signInWithPassword: async (email, password) => ((used = { email, password }), { error: null }),
      signOutLocal: noop,
    });
    expect(res).toEqual({ ok: true, userId: UID });
    const arg = f.createUser.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({ email_confirm: true, app_metadata: { demo_visitor: true } });
    expect(String(arg.email)).toMatch(/^v-[0-9a-f]{24}@demo\.dawrak\.invalid$/);
    expect(String(arg.password).length).toBeGreaterThanOrEqual(43); // 32 random bytes, base64url
    expect(used).toEqual({ email: arg.email, password: arg.password });
    expect(f.rpc).toHaveBeenCalledWith("register_demo_user", { p_user_id: UID, p_tenant_id: DEMO_CLINIC_ID, p_role: "receptionist" });
    expect(f.deleteUser).not.toHaveBeenCalled();
  });

  it("never reuses credentials between visitors", () => {
    const a = newVisitorCredentials();
    const b = newVisitorCredentials();
    expect(a.email).not.toBe(b.email);
    expect(a.password).not.toBe(b.password);
  });

  it("deletes the created user and clears the session when sign-in fails", async () => {
    const f = fakeAdmin();
    const out = vi.fn();
    const res = await createDemoVisitor("salon-owner", {
      admin: f.admin,
      signInWithPassword: async () => ({ error: { status: 400, message: "bad" } }),
      signOutLocal: async () => void out(),
    });
    expect(res).toEqual({ ok: false, failure: "signin" });
    expect(f.deleteUser).toHaveBeenCalledWith(UID);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(out).toHaveBeenCalled();
  });

  it("maps demo_users_limit to 'busy' and cleans up; any other register error is a plain failure and cleans up", async () => {
    for (const [err, want] of [
      [{ code: "54000", message: "demo_users_limit" }, "busy"],
      [{ message: "demo_tenant_users_limit" }, "busy"],
      [{ code: "P0001", message: "invalid_role" }, "signin"],
    ] as const) {
      const f = fakeAdmin({ register: err });
      const res = await createDemoVisitor("clinic-owner", { admin: f.admin, signInWithPassword: okSignIn, signOutLocal: noop });
      expect(res).toEqual({ ok: false, failure: want });
      expect(f.deleteUser).toHaveBeenCalledWith(UID);
    }
  });

  it("does not try to delete anything when the Admin API refused to create the user", async () => {
    const f = fakeAdmin({ create: { data: { user: null }, error: { status: 422, message: "email invalid" } } });
    const res = await createDemoVisitor("clinic-owner", { admin: f.admin, signInWithPassword: okSignIn, signOutLocal: noop });
    expect(res).toEqual({ ok: false, failure: "signin" });
    expect(f.deleteUser).not.toHaveBeenCalled();
  });

  it("refuses to proceed (and never deletes) if GoTrue hands back a fixed seeded user id", async () => {
    const f = fakeAdmin({ create: { data: { user: { id: "a0000000-0000-4000-8000-000000000001" } }, error: null } });
    const res = await createDemoVisitor("clinic-owner", { admin: f.admin, signInWithPassword: okSignIn, signOutLocal: noop });
    expect(res.ok).toBe(false);
    expect(f.deleteUser).not.toHaveBeenCalled();
  });
});

describe("purgeExpiredDemoUsers (backup purge)", () => {
  function purgeDb(ids: string[], del: (id: string) => { error: { status?: number; message?: string } | null }) {
    const deleted: string[] = [];
    const registryDeleted: string[] = [];
    const q: Record<string, unknown> = {};
    for (const m of ["select", "lt", "order", "limit"]) q[m] = () => q;
    q.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: ids.map((user_id) => ({ user_id })), error: null }).then(r);
    q.delete = () => ({ eq: async (_c: string, id: string) => (registryDeleted.push(id), { error: null }) });
    const db = {
      rpc: async () => ({ error: { code: "42501" } }), // SQL purge not permitted
      from: () => q,
      auth: { admin: { deleteUser: async (id: string) => (deleted.push(id), del(id)) } },
    };
    return { db: db as never, deleted, registryDeleted };
  }

  it("deletes the expired ids through the Admin API even when the SQL purge is not permitted, skipping fixed users", async () => {
    const f = purgeDb([UID, "a0000000-0000-4000-8000-000000000003"], () => ({ error: null }));
    expect(await purgeExpiredDemoUsers(f.db)).toEqual({ deleted: 1, failed: 0 });
    expect(f.deleted).toEqual([UID]);
  });

  it("is idempotent: an already-deleted user (404) counts as done, other errors are counted and do not stop the run", async () => {
    const f = purgeDb([UID, "11111111-2222-4333-8444-555555555556"], (id) =>
      id === UID ? { error: { status: 404, message: "User not found" } } : { error: { status: 500, message: "boom" } },
    );
    expect(await purgeExpiredDemoUsers(f.db)).toEqual({ deleted: 1, failed: 1 });
    expect(f.registryDeleted).toEqual([UID]);
  });
});
