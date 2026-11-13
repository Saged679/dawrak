// Concurrency check for create_public_booking: two truly concurrent bookings for the same
// provider + slot must give exactly one success and one slot_taken (SQLSTATE 23P01), never a
// deadlock (40P01) or a 5xx. Runs against the LOCAL stack using the service key from .env.local
// (the key is never printed). Cleans up everything it creates.
//   node scripts/race-test.mjs [rounds=30]
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
if (!/127\.0\.0\.1:553|localhost:553/.test(url ?? "")) {
  console.error("refusing to run: NEXT_PUBLIC_SUPABASE_URL is not the local 553xx stack");
  process.exit(2);
}
const db = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const ROUNDS = Number(process.argv[2] ?? 30);
const run = Math.random().toString(36).slice(2, 8);
const must = (r, what) => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

const tenant = must(
  await db.from("tenants").insert({ slug: `race-${run}`, name_ar: "س", name_en: "Race", kind: "clinic" }).select("id").single(),
  "tenant",
);
let exitCode = 0;
try {
  const prov = must(await db.from("providers").insert({ tenant_id: tenant.id, name_ar: "م", name_en: "P" }).select("id").single(), "provider");
  const svc = must(
    await db.from("services").insert({ tenant_id: tenant.id, name_ar: "خ", name_en: "S", duration_min: 30, buffer_min: 0, price: 10 }).select("id").single(),
    "service",
  );
  must(await db.from("provider_services").insert({ tenant_id: tenant.id, provider_id: prov.id, service_id: svc.id }), "provider_services");
  must(
    await db.from("working_hours").insert(
      [0, 1, 2, 3, 4, 5, 6].map((w) => ({ tenant_id: tenant.id, provider_id: prov.id, weekday: w, start_time: "06:00", end_time: "23:00" })),
    ),
    "working_hours",
  );

  // a slot in the tenant's timezone (Asia/Riyadh = UTC+3, no DST), day offset 1..60 days ahead
  const slot = (dayOffset, hour) => {
    const d = new Date(Date.now() + dayOffset * 86400000);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour - 3, 0, 0)).toISOString();
  };
  const book = (startsAt, phone, name) =>
    db.rpc("create_public_booking", {
      p_tenant_id: tenant.id, p_provider_id: prov.id, p_service_id: svc.id, p_starts_at: startsAt,
      p_full_name: name, p_phone: phone, p_email: null, p_source: "web", p_locale: "en",
    });

  const tally = {};
  const bump = (variant, key) => ((tally[variant] ??= {})[key] = (tally[variant][key] ?? 0) + 1);
  let bad = 0;
  for (const variant of ["different-phones", "same-phone"]) {
    for (let i = 0; i < ROUNDS; i++) {
      const startsAt = slot(1 + i, variant === "same-phone" ? 14 : 10);
      const base = 500000000 + (variant === "same-phone" ? 1000 : 0) + i * 2;
      const pA = `+9665${String(base).padStart(8, "0")}`;
      const pB = variant === "same-phone" ? pA : `+9665${String(base + 1).padStart(8, "0")}`;
      const [a, b] = await Promise.all([book(startsAt, pA, "Racer A"), book(startsAt, pB, "Racer B")]);
      const results = [a, b];
      const ok = results.filter((r) => !r.error).length;
      const taken = results.filter((r) => r.error && (r.error.code === "23P01" || /slot_taken/.test(r.error.message))).length;
      const other = results.filter((r) => r.error && !(r.error.code === "23P01" || /slot_taken/.test(r.error.message)));
      for (const o of other) bump(variant, `other:${o.error.code ?? o.status}`);
      if (ok === 1 && taken === 1) bump(variant, "one_win_one_slot_taken");
      else { bump(variant, "BAD"); bad++; }
    }
  }
  console.log(`rounds per variant: ${ROUNDS}`);
  console.log(JSON.stringify(tally, null, 2));
  console.log(bad === 0 ? "PASS: every round = exactly one success + one slot_taken" : `FAIL: ${bad} bad rounds`);
  if (bad) exitCode = 1;
} finally {
  const r = await db.from("tenants").delete().eq("id", tenant.id);
  if (r.error) console.error("cleanup failed:", r.error.message);
}
process.exit(exitCode);
