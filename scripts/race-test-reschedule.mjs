// Concurrency check: create_public_booking vs customer_reschedule_appointment (and reschedule vs
// reschedule) targeting the same provider + slot. Exactly one must succeed, the other must get
// slot_taken (23P01); never a deadlock (40P01) or other error. LOCAL stack only; cleans up after itself.
//   node scripts/race-test-reschedule.mjs [rounds=20]
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
if (!/127\.0\.0\.1:553|localhost:553/.test(url ?? "")) { console.error("refusing: not the local 553xx stack"); process.exit(2); }
const db = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const ROUNDS = Number(process.argv[2] ?? 20);
const run = Math.random().toString(36).slice(2, 8);
const must = (r, w) => { if (r.error) throw new Error(`${w}: ${r.error.message}`); return r.data; };
const isTaken = (e) => e && (e.code === "23P01" || /slot_taken/.test(e.message));

const tenant = must(await db.from("tenants").insert({ slug: `race2-${run}`, name_ar: "س", name_en: "Race2", kind: "clinic" }).select("id").single(), "tenant");
let exitCode = 0;
try {
  const prov = must(await db.from("providers").insert({ tenant_id: tenant.id, name_ar: "م", name_en: "P" }).select("id").single(), "provider");
  const svc = must(await db.from("services").insert({ tenant_id: tenant.id, name_ar: "خ", name_en: "S", duration_min: 30, buffer_min: 0, price: 10 }).select("id").single(), "service");
  must(await db.from("provider_services").insert({ tenant_id: tenant.id, provider_id: prov.id, service_id: svc.id }), "ps");
  must(await db.from("working_hours").insert([0,1,2,3,4,5,6].map((w) => ({ tenant_id: tenant.id, provider_id: prov.id, weekday: w, start_time: "06:00", end_time: "23:00" }))), "wh");
  const slot = (d, h) => { const x = new Date(Date.now() + d * 86400000); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate(), h - 3)).toISOString(); };
  let n = 0;
  const book = (startsAt) => db.rpc("create_public_booking", {
    p_tenant_id: tenant.id, p_provider_id: prov.id, p_service_id: svc.id, p_starts_at: startsAt,
    p_full_name: "Racer", p_phone: `+9665${String(600000000 + ++n).padStart(8, "0")}`, p_email: null, p_source: "web", p_locale: "en" });
  const resched = (b, to) => db.rpc("customer_reschedule_appointment", { p_token: b.customer_token, p_appointment_id: b.appointment_id ?? b.id, p_new_starts_at: to });

  const tally = {}; let bad = 0;
  const bump = (v, k) => ((tally[v] ??= {})[k] = (tally[v][k] ?? 0) + 1);
  const judge = (v, rs) => {
    const ok = rs.filter((r) => !r.error).length, taken = rs.filter((r) => isTaken(r.error)).length;
    for (const r of rs) if (r.error && !isTaken(r.error)) bump(v, `other:${r.error.code}:${r.error.message.slice(0, 40)}`);
    if (ok === 1 && taken === 1) bump(v, "one_win_one_slot_taken"); else { bump(v, "BAD"); bad++; }
  };
  for (let i = 0; i < ROUNDS; i++) {
    const A = must(await book(slot(1 + i, 8)), "seed A");
    if (i === 0) console.log("booking result keys:", Object.keys(A).join(","));
    const B = must(await book(slot(1 + i, 9)), "seed B");
    const target = slot(1 + i, 12);
    judge("create-vs-reschedule", await Promise.all([book(target), resched(A, target)]));
    const target2 = slot(1 + i, 15);
    judge("reschedule-vs-reschedule", await Promise.all([resched(A, target2), resched(B, target2)]));
  }
  console.log(`rounds: ${ROUNDS}`); console.log(JSON.stringify(tally, null, 2));
  console.log(bad === 0 ? "PASS" : `FAIL: ${bad} bad rounds`); if (bad) exitCode = 1;
} finally {
  const r = await db.from("tenants").delete().eq("id", tenant.id);
  if (r.error) console.error("cleanup failed:", r.error.message);
}
process.exit(exitCode);
