-- pgTAP: round-3 security review fixes (migrations 18-22).
--   demo_users registry / register_demo_user / purge_expired_demo_users / reset_demo
--   H1 auth.users guard, H2 demo link binding, M1 token reuse, M2 least privilege, M3 KB limits + demo readonly,
--   L4 per-phone booking limit via check_rate_limit.
-- Run: npx supabase test db   (needs the seeded local db: demo tenants d0000000-... and fixed demo users)
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

create function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.act_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;
create function pg_temp.act_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'anon', true);
end $$;
create function pg_temp.exec(p_sql text) returns text language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'OK:' || n;
exception when others then return 'ERR:' || sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare r text;
begin
  execute p_sql into r;
  return coalesce(r, 'NULL');
exception when others then return 'ERR:' || sqlstate || ':' || sqlerrm;
end $$;
grant execute on all functions in schema pg_temp to public;

-- ---------- fixtures (postgres) ----------
-- seeded demo tenants: clinic d0000000-...-001 (owner a0..01), salon d0000000-...-002
insert into auth.users (id, aud, role, email) values
  ('c0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'r3-v1@test.local'),
  ('c0000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'r3-v2@test.local'),
  ('c0000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'r3-v3@test.local'),
  ('c0000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'r3-v4@test.local'),
  ('c0000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'r3-plain-owner@test.local'),
  ('c0000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'r3-plain-rec@test.local'),
  ('c0000000-0000-4000-8000-000000000007', 'authenticated', 'authenticated', 'r3-plain-prov@test.local');
insert into public.tenants (id, slug, name_ar, name_en, kind, is_demo) values
  ('c1000000-0000-4000-8000-000000000003', 'r3-demo3', 'س', 'R3 Demo 3', 'clinic', true),
  ('c1000000-0000-4000-8000-00000000000a', 'r3-plain', 'س', 'R3 Plain', 'clinic', false);
insert into public.memberships (user_id, tenant_id, role) values
  ('c0000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-00000000000a', 'owner'),
  ('c0000000-0000-4000-8000-000000000006', 'c1000000-0000-4000-8000-00000000000a', 'receptionist'),
  ('c0000000-0000-4000-8000-000000000007', 'c1000000-0000-4000-8000-00000000000a', 'provider');
insert into public.providers (id, tenant_id, user_id, name_ar, name_en) values
  ('c2000000-0000-4000-8000-0000000000a1', 'c1000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-000000000007', 'م', 'PP');
insert into public.services (id, tenant_id, name_ar, name_en, duration_min, buffer_min, price) values
  ('c3000000-0000-4000-8000-0000000000a1', 'c1000000-0000-4000-8000-00000000000a', 'خ', 'PS', 30, 0, 10);
insert into public.provider_services (tenant_id, provider_id, service_id) values
  ('c1000000-0000-4000-8000-00000000000a', 'c2000000-0000-4000-8000-0000000000a1', 'c3000000-0000-4000-8000-0000000000a1');
insert into public.customers (id, tenant_id, full_name, phone, email) values
  ('c4000000-0000-4000-8000-0000000000a1', 'c1000000-0000-4000-8000-00000000000a', 'Plain C', '0566000001', 'pc@example.com');
insert into public.appointments (id, tenant_id, provider_id, service_id, customer_id, starts_at, ends_at, status, price) values
  ('c5000000-0000-4000-8000-0000000000a1', 'c1000000-0000-4000-8000-00000000000a', 'c2000000-0000-4000-8000-0000000000a1',
   'c3000000-0000-4000-8000-0000000000a1', 'c4000000-0000-4000-8000-0000000000a1', now() + interval '10 days', now() + interval '10 days 30 min', 'confirmed', 10);

-- ===================== 1. demo_users registry: privileges =====================
select is((select relforcerowsecurity from pg_class where oid = 'public.demo_users'::regclass), true, 'demo_users has forced RLS');
select is((select count(*)::int from information_schema.role_table_grants where table_name = 'demo_users' and table_schema = 'public' and grantee in ('anon','authenticated','PUBLIC')), 0, 'demo_users: no grants for anon/authenticated/public');
select is((select count(*)::int from information_schema.role_table_grants where table_name = 'demo_config' and table_schema = 'public' and grantee in ('anon','authenticated','PUBLIC')), 0, 'demo_config: no grants for anon/authenticated/public');
select pg_temp.act('c0000000-0000-4000-8000-000000000005');
select is(pg_temp.exec($$select * from public.demo_users$$), 'ERR:42501:permission denied for table demo_users', 'authenticated cannot read demo_users');
select is(pg_temp.exec($$select public.register_demo_user('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'owner')$$), 'ERR:42501:permission denied for function register_demo_user', 'authenticated cannot call register_demo_user');
select is(pg_temp.exec($$select public.purge_expired_demo_users()$$), 'ERR:42501:permission denied for function purge_expired_demo_users', 'authenticated cannot call purge_expired_demo_users');
reset role; select pg_temp.act_anon();
select is(pg_temp.exec($$select public.register_demo_user('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'owner')$$), 'ERR:42501:permission denied for function register_demo_user', 'anon cannot call register_demo_user');
select is(pg_temp.exec($$select * from public.demo_users$$), 'ERR:42501:permission denied for table demo_users', 'anon cannot read demo_users');
reset role;

-- ===================== 2. register_demo_user =====================
select pg_temp.act_service();
select is(pg_temp.exec($$select public.register_demo_user('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'owner')$$), 'OK:1', 'service_role registers a visitor (clinic owner)');
select is((select role from public.memberships where user_id = 'c0000000-0000-4000-8000-000000000001' and tenant_id = 'd0000000-0000-4000-8000-000000000001'), 'owner', 'registration created the membership');
select is((select expires_at > now() + interval '23 hours' and expires_at < now() + interval '25 hours' from public.demo_users where user_id = 'c0000000-0000-4000-8000-000000000001'), true, 'expires_at defaults to ~24h');
select is(pg_temp.exec($$select public.register_demo_user('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'owner')$$), 'ERR:P0001:already_registered', 'double registration refused');
select is(pg_temp.exec($$select public.register_demo_user('c0000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-00000000000a', 'owner')$$), 'ERR:P0001:not_demo', 'non-demo tenant refused');
select is(pg_temp.exec($$select public.register_demo_user('c0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'provider')$$), 'ERR:P0001:invalid_role', 'provider role refused');
select is(pg_temp.exec($$select public.register_demo_user('c0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'admin')$$), 'ERR:P0001:invalid_role', 'unknown role refused');
select is(pg_temp.exec($$select public.register_demo_user('a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'owner')$$), 'ERR:P0001:protected_user', 'fixed seeded users cannot be registered (and so never purged)');
select is(pg_temp.exec($$select public.register_demo_user('c0000000-0000-4000-8000-0000000000ff', 'd0000000-0000-4000-8000-000000000001', 'owner')$$), 'ERR:23503:user_not_found', 'unknown auth user refused');
select is(pg_temp.exec($$select public.register_demo_user('c0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', 'receptionist')$$), 'OK:1', 'receptionist in the salon registers');
reset role;

-- visitor sees only the demo tenant and still cannot manage memberships (freeze trigger)
select pg_temp.act('c0000000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.tenants), 1, 'visitor sees exactly its demo tenant');
select is(pg_temp.exec($$insert into public.memberships (user_id, tenant_id, role) values ('c0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001', 'owner')$$), 'ERR:42501:demo_readonly', 'visitor owner cannot create memberships (freeze still active)');
select is(pg_temp.exec($$delete from public.demo_users$$), 'ERR:42501:permission denied for table demo_users', 'visitor cannot touch the registry');
reset role;

-- caps: 149 more clinic users -> the 150th (V1 is the 1st) ... fill to 150, next refused
insert into auth.users (id, aud, role, email)
select ('c9000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'authenticated', 'authenticated', 'r3-bulk-' || i || '@test.local'
  from generate_series(1, 300) i;
insert into public.demo_users (user_id, tenant_id, role)
select ('c9000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'd0000000-0000-4000-8000-000000000001', 'owner'
  from generate_series(1, 148) i;          -- clinic now 149
select pg_temp.act_service();
select is(pg_temp.exec($$select public.register_demo_user('c0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001', 'owner')$$), 'OK:1', 'the 150th clinic visitor is accepted');
select is(pg_temp.exec($$select public.register_demo_user('c0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000001', 'owner')$$), 'ERR:54000:demo_tenant_users_limit', 'per-tenant cap (150) enforced');
reset role;
insert into public.demo_users (user_id, tenant_id, role)
select ('c9000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'd0000000-0000-4000-8000-000000000002', 'owner'
  from generate_series(149, 296) i;        -- salon: V2 + 148 = 149; total 150 + 149 = 299
select pg_temp.act_service();
select is(pg_temp.exec($$select public.register_demo_user('c0000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000003', 'owner')$$), 'OK:1', 'the 300th visitor overall is accepted (third demo tenant)');
select is(pg_temp.exec($$select public.register_demo_user('c9000000-0000-4000-8000-000000000300', 'c1000000-0000-4000-8000-000000000003', 'owner')$$), 'ERR:54000:demo_users_limit', 'global cap (300) enforced');
reset role;
delete from public.demo_users where user_id::text like 'c9000000-%';
delete from auth.users where id::text like 'c9000000-%';

-- ===================== 3. purge_expired_demo_users =====================
insert into auth.identities (id, user_id, provider_id, provider, identity_data)
  values (gen_random_uuid(), 'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'email', '{"sub":"x"}');
insert into auth.sessions (id, user_id) values ('c6000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001');
insert into auth.refresh_tokens (token, user_id, session_id) values ('r3-refresh-1', 'c0000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001');
update public.demo_users set expires_at = now() - interval '1 minute' where user_id = 'c0000000-0000-4000-8000-000000000001';
-- orphans: flagged + old + unregistered (purged), flagged + fresh (kept), unflagged old unregistered (kept)
insert into auth.users (id, aud, role, email, raw_app_meta_data, created_at) values
  ('c0000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'r3-orph-old@test.local', '{"demo_visitor": true}', now() - interval '2 hours'),
  ('c0000000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'r3-orph-new@test.local', '{"demo_visitor": true}', now()),
  ('c0000000-0000-4000-8000-0000000000a3', 'authenticated', 'authenticated', 'r3-plain-old@test.local', '{}', now() - interval '2 hours');
select pg_temp.act('c0000000-0000-4000-8000-000000000005');
select is(pg_temp.exec($$select public.purge_expired_demo_users()$$), 'ERR:42501:permission denied for function purge_expired_demo_users', 'authenticated cannot purge');
reset role; select pg_temp.act_service();
select is(public.purge_expired_demo_users(), 2, 'purge deletes 1 expired visitor + 1 old flagged orphan');
reset role;
select is((select count(*)::int from auth.users where id = 'c0000000-0000-4000-8000-000000000001'), 0, 'expired visitor removed from auth.users');
select is((select count(*)::int from public.memberships where user_id = 'c0000000-0000-4000-8000-000000000001'), 0, 'its membership is gone');
select is((select count(*)::int from public.demo_users where user_id = 'c0000000-0000-4000-8000-000000000001'), 0, 'its registry row is gone');
select is((select count(*)::int from auth.identities where user_id = 'c0000000-0000-4000-8000-000000000001')
        + (select count(*)::int from auth.sessions where user_id = 'c0000000-0000-4000-8000-000000000001')
        + (select count(*)::int from auth.refresh_tokens where user_id = 'c0000000-0000-4000-8000-000000000001'), 0, 'identities, sessions and refresh tokens cascaded');
select is((select count(*)::int from auth.users where id = 'c0000000-0000-4000-8000-0000000000a1'), 0, 'old flagged unregistered user purged');
select is((select count(*)::int from auth.users where id in ('c0000000-0000-4000-8000-0000000000a2', 'c0000000-0000-4000-8000-0000000000a3')), 2, 'fresh flagged and unflagged users are kept');
select is((select count(*)::int from auth.users where id::text like 'a0000000-0000-4000-8000-00000000000%'), 6, 'the six fixed demo users are untouched by the purge');
select is((select count(*)::int from public.demo_users where user_id = 'c0000000-0000-4000-8000-000000000002'), 1, 'unexpired visitors survive');
select is((select count(*)::int from cron.job where jobname = 'dawrak_purge_demo_users' and schedule = '*/15 * * * *'), 1, 'pg_cron job runs every 15 minutes');

-- ===================== 4. reset_demo: visitors + fixed logins =====================
select pg_temp.act_service();
select is(pg_temp.exec($$select public.reset_demo()$$), 'OK:1', 'reset_demo runs with visitors present');
reset role;
select is((select count(*)::int from public.demo_users), 0, 'reset_demo emptied the registry');
select is((select count(*)::int from auth.users where id in ('c0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000003','c0000000-0000-4000-8000-000000000004')), 0, 'reset_demo deleted every visitor auth user');
select is((select count(*)::int from auth.users where id = 'c0000000-0000-4000-8000-0000000000a2'), 0, 'reset_demo deleted flagged visitors even when unregistered');
select is((select count(*)::int from public.memberships where tenant_id in ('d0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002')), 6, 'only the six fixed memberships remain after the re-seed');
-- local seed opted in (demo_config) -> the known password still works
select is((select encrypted_password = extensions.crypt('Demo#2026', encrypted_password) from auth.users where id = 'a0000000-0000-4000-8000-000000000001'), true, 'local: demo_config allows the fixed password after reset_demo');
delete from public.demo_config where key = 'allow_fixed_demo_login';
select pg_temp.act_service();
select lives_ok($$select public.reset_demo()$$, 'reset_demo without the local opt-in');
reset role;
select is((select count(*)::int from auth.users where id::text ~ '^a0000000-0000-4000-8000-00000000000[1-6]$'
            and encrypted_password = extensions.crypt('Demo#2026', encrypted_password)), 0, 'hosted behaviour: no fixed demo user keeps the known password');
select is((select count(distinct encrypted_password)::int from auth.users where id::text ~ '^a0000000-0000-4000-8000-00000000000[1-6]$'), 6, 'each fixed user got its own random password');
select is((select count(*)::int from public.memberships where tenant_id = 'd0000000-0000-4000-8000-000000000001'), 3, 'memberships of the fixed users still exist');

-- ===================== 5. H1: auth.users guard =====================
-- reset_demo deleted the visitors above: recreate two for the remaining sections
insert into auth.users (id, aud, role, email) values
  ('c0000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'r3-v3b@test.local'),
  ('c0000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'r3-v4b@test.local');
select is((select count(*)::int from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'dawrak_auth_users_guard' and not tgisinternal), 1, 'H1: guard trigger is installed on auth.users');
-- postgres cannot SET ROLE supabase_auth_admin here, so the trigger function is exercised on a look-alike temp
-- table as a non-privileged role (GoTrue is "any role other than postgres/supabase_admin/service_role").
-- The real GoTrue path is replayed by scripts/replay-round3-exploits.mjs.
create temp table fu (id uuid primary key, email text, phone text, encrypted_password text, last_sign_in_at timestamptz, email_change text, email_change_token_new text);
grant all on fu to public;
insert into fu (id, email, phone, encrypted_password) values
  ('a0000000-0000-4000-8000-000000000001', 'f@x', null, 'h'), ('a0000000-0000-4000-8000-000000000003', 'g@x', null, 'h'),
  ('c0000000-0000-4000-8000-000000000004', 'v@x', null, 'h');
create trigger fu_guard before update or delete on fu for each row execute function public.trg_auth_users_guard();
select pg_temp.act('c0000000-0000-4000-8000-000000000005');   -- any non-postgres role stands in for supabase_auth_admin
select is(pg_temp.exec($$update fu set encrypted_password = 'x' where id = 'a0000000-0000-4000-8000-000000000001'$$), 'ERR:42501:demo_user_protected', 'H1: a non-admin role cannot change a fixed demo user password');
select is(pg_temp.exec($$update fu set email = 'evil@example.com' where id = 'a0000000-0000-4000-8000-000000000001'$$), 'ERR:42501:demo_user_protected', 'H1: ... nor the e-mail');
select is(pg_temp.exec($$update fu set phone = '+966500000000' where id = 'a0000000-0000-4000-8000-000000000001'$$), 'ERR:42501:demo_user_protected', 'H1: ... nor the phone');
select is(pg_temp.exec($$delete from fu where id = 'a0000000-0000-4000-8000-000000000003'$$), 'ERR:42501:demo_user_protected', 'H1: ... nor delete a fixed demo user');
select is(pg_temp.exec($$update fu set last_sign_in_at = now() where id = 'a0000000-0000-4000-8000-000000000001'$$), 'OK:1', 'H1: ordinary bookkeeping columns (last_sign_in_at) are not blocked');
select is(pg_temp.exec($$update fu set encrypted_password = 'mine' where id = 'c0000000-0000-4000-8000-000000000004'$$), 'OK:1', 'H1: a per-visitor user may change its own password (choice: only the shared fixed users are guarded)');
reset role;
select pg_temp.act_service();
select is(pg_temp.exec($$update fu set encrypted_password = 'svc' where id = 'a0000000-0000-4000-8000-000000000001'$$), 'OK:1', 'H1: service_role is exempt');
reset role;
select is(pg_temp.exec($$update auth.users set encrypted_password = extensions.crypt('Demo#2026', extensions.gen_salt('bf')) where id = 'a0000000-0000-4000-8000-000000000001'$$), 'OK:1', 'H1: postgres (reset_demo / migrations) can still change fixed users on the real table');
insert into public.demo_users (user_id, tenant_id, role) values ('c0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000001', 'owner');

-- ===================== 6. H2 + M1: link binding and token reuse =====================
-- seeded clinic: provider f1..01, service e1..01
insert into public.customers (id, tenant_id, full_name, phone, email) values
  ('c4000000-0000-4000-8000-0000000000b1', 'd0000000-0000-4000-8000-000000000001', 'Visitor A', '0511111111', 'a@example.com'),
  ('c4000000-0000-4000-8000-0000000000b2', 'd0000000-0000-4000-8000-000000000001', 'Visitor B', '0522222222', 'b@example.com');
insert into public.appointments (id, tenant_id, provider_id, service_id, customer_id, starts_at, ends_at, status, price, created_at) values
  ('c5000000-0000-4000-8000-0000000000b1', 'd0000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000b1', now() + interval '30 days', now() + interval '30 days 30 min', 'confirmed', 150, now() - interval '2 hours'),
  ('c5000000-0000-4000-8000-0000000000b2', 'd0000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000b2', now() + interval '31 days', now() + interval '31 days 30 min', 'confirmed', 150, now() - interval '2 hours'),
  -- B also booked with A's phone later (existing customer): B gets an appointment on A's customer
  ('c5000000-0000-4000-8000-0000000000b3', 'd0000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000b1', now() + interval '32 days', now() + interval '32 days 30 min', 'confirmed', 150, now() - interval '1 hour');
insert into public.demo_appointment_sessions (appointment_id, tenant_id, session_hash) values
  ('c5000000-0000-4000-8000-0000000000b1', 'd0000000-0000-4000-8000-000000000001', repeat('a', 64)),
  ('c5000000-0000-4000-8000-0000000000b2', 'd0000000-0000-4000-8000-000000000001', repeat('b', 64)),
  ('c5000000-0000-4000-8000-0000000000b3', 'd0000000-0000-4000-8000-000000000001', repeat('b', 64));
select pg_temp.act_service();
select is((select count(*)::int from public.customer_issue_link('d0000000-0000-4000-8000-000000000001', '0511111111', null, repeat('a', 64))), 1, 'H2: visitor A gets their own link');
select is((select count(*)::int from public.customer_issue_link('d0000000-0000-4000-8000-000000000001', '0511111111', null, repeat('b', 64))), 0, 'H2: visitor B cannot obtain visitor A''s link by phone (even with an appointment on A''s customer)');
select is((select count(*)::int from public.customer_issue_link('d0000000-0000-4000-8000-000000000001', null, 'A@example.com', repeat('b', 64))), 0, 'H2: ... nor by e-mail');
select is((select count(*)::int from public.customer_issue_link('d0000000-0000-4000-8000-000000000001', '0511111111', null, null)), 0, 'H2: demo tenant without a session hash never issues (fail closed)');
select is((select count(*)::int from public.customer_issue_link('d0000000-0000-4000-8000-000000000001', '0511111111', null)), 0, 'H2: the old 3-argument call shape no longer issues in demo');
select is((select count(*)::int from public.customer_issue_link('d0000000-0000-4000-8000-000000000001', '0522222222', null, repeat('b', 64))), 1, 'H2: visitor B gets their own link');
select is((select count(*)::int from public.customer_issue_link('d0000000-0000-4000-8000-000000000001', '0533333333', null, repeat('b', 64))), 0, 'H2: unknown contact returns the same empty result');
select is((select count(*)::int from public.customer_issue_link('d0000000-0000-4000-8000-000000000001', '0500001001', null, repeat('b', 64))), 0, 'H2: seeded demo customers (no session) cannot be claimed');
select is((select count(*)::int from public.customer_issue_link('c1000000-0000-4000-8000-00000000000a', '0566000001', null, null)), 1, 'H2: non-demo tenants are unaffected by the binding');
-- M1: reuse / rotation
create temp table t3 (n int, tok text);
insert into t3 select 1, link_token from public.customer_issue_link('d0000000-0000-4000-8000-000000000001', '0511111111', null, repeat('a', 64));
insert into t3 select 2, link_token from public.customer_issue_link('d0000000-0000-4000-8000-000000000001', '0511111111', null, repeat('a', 64));
select is((select count(distinct tok)::int from t3), 1, 'M1: a valid token is reused, not rotated per request');
select is((select count(*)::int from public.customer_portal_get((select tok from t3 limit 1))), 1, 'M1: the reused token still works');
reset role;
update public.customers set access_token_expires_at = now() + interval '1 day' where id = 'c4000000-0000-4000-8000-0000000000b1';
select pg_temp.act_service();
insert into t3 select 3, link_token from public.customer_issue_link('d0000000-0000-4000-8000-000000000001', '0511111111', null, repeat('a', 64));
select is((select count(distinct tok)::int from t3), 1, 'M1: reuse while it still has a day left');
select is((select access_token_expires_at > now() + interval '29 days' from public.customers where id = 'c4000000-0000-4000-8000-0000000000b1'), true, 'M1: expiry slides to ~30 days');
insert into t3 select 4, link_token from public.customer_issue_link('d0000000-0000-4000-8000-000000000001', '0511111111', null, repeat('a', 64), true);
select is((select count(distinct tok)::int from t3), 2, 'M1: p_force rotates the token');
select is((select count(*)::int from public.customer_portal_get((select tok from t3 where n = 1))), 0, 'M1: the forced rotation invalidated the old token');
reset role;
update public.customers set access_token_expires_at = now() - interval '1 minute' where id = 'c4000000-0000-4000-8000-0000000000b1';
select pg_temp.act_service();
insert into t3 select 5, link_token from public.customer_issue_link('d0000000-0000-4000-8000-000000000001', '0511111111', null, repeat('a', 64));
select is((select count(distinct tok)::int from t3), 3, 'M1: an expired token is replaced');
select is((select access_token_expires_at > now() + interval '29 days' from public.customers where id = 'c4000000-0000-4000-8000-0000000000b1'), true, 'M1: ... with a fresh 30 day expiry');
-- issue_customer_magic_link: same semantics
create temp table t4 (n int, tok text);
insert into t4 select 1, public.issue_customer_magic_link('c1000000-0000-4000-8000-00000000000a', '0566000001');
insert into t4 select 2, public.issue_customer_magic_link('c1000000-0000-4000-8000-00000000000a', '0566000001');
insert into t4 select 3, public.issue_customer_magic_link('c1000000-0000-4000-8000-00000000000a', '0566000001', true);
select is((select count(distinct tok)::int from t4 where n <= 2), 1, 'M1: issue_customer_magic_link reuses a valid token');
select is((select count(distinct tok)::int from t4), 2, 'M1: issue_customer_magic_link rotates with p_force');
select is(public.issue_customer_magic_link('c1000000-0000-4000-8000-00000000000a', '0500999999'), null, 'M1: unknown phone still gives null');
reset role;

-- ===================== 7. M2: least privilege on customers / appointments =====================
select pg_temp.act('c0000000-0000-4000-8000-000000000005');   -- owner (non-demo tenant)
select is(pg_temp.exec($$delete from public.appointments where id = 'c5000000-0000-4000-8000-0000000000a1'$$), 'ERR:42501:permission denied for table appointments', 'M2 owner: cannot delete appointments');
select is(pg_temp.exec($$delete from public.customers where id = 'c4000000-0000-4000-8000-0000000000a1'$$), 'ERR:42501:permission denied for table customers', 'M2 owner: cannot delete customers');
select is(pg_temp.exec($$update public.customers set full_name = 'x' where id = 'c4000000-0000-4000-8000-0000000000a1'$$), 'ERR:42501:permission denied for table customers', 'M2 owner: cannot update customers');
select is(pg_temp.exec($$insert into public.customers (tenant_id, full_name, phone) values ('c1000000-0000-4000-8000-00000000000a', 'n', '0566000009')$$), 'ERR:42501:permission denied for table customers', 'M2 owner: cannot insert customers');
select is(pg_temp.exec($$update public.appointments set status = 'completed' where id = 'c5000000-0000-4000-8000-0000000000a1'$$), 'OK:1', 'M2 owner: status updates on appointments still work');
select is((select count(*)::int from public.customers where id = 'c4000000-0000-4000-8000-0000000000a1'), 1, 'M2 owner: can still read customers');
reset role; select pg_temp.act('c0000000-0000-4000-8000-000000000006');   -- receptionist
select is(pg_temp.exec($$delete from public.appointments where id = 'c5000000-0000-4000-8000-0000000000a1'$$), 'ERR:42501:permission denied for table appointments', 'M2 receptionist: cannot delete appointments');
select is(pg_temp.exec($$delete from public.customers where id = 'c4000000-0000-4000-8000-0000000000a1'$$), 'ERR:42501:permission denied for table customers', 'M2 receptionist: cannot delete customers');
select is(pg_temp.exec($$update public.customers set email = 'x@y.z' where id = 'c4000000-0000-4000-8000-0000000000a1'$$), 'ERR:42501:permission denied for table customers', 'M2 receptionist: cannot update customers');
select is(pg_temp.exec($$select public.staff_update_appointment('c5000000-0000-4000-8000-0000000000a1', null, null, null, 'cancelled', 'by reception')$$), 'OK:1', 'M2 receptionist: staff_update_appointment still works');
reset role; select pg_temp.act('c0000000-0000-4000-8000-000000000007');   -- provider
select is(pg_temp.exec($$delete from public.appointments where id = 'c5000000-0000-4000-8000-0000000000a1'$$), 'ERR:42501:permission denied for table appointments', 'M2 provider: cannot delete appointments');
select is(pg_temp.exec($$delete from public.customers where id = 'c4000000-0000-4000-8000-0000000000a1'$$), 'ERR:42501:permission denied for table customers', 'M2 provider: cannot delete customers');
select is(pg_temp.exec($$insert into public.customers (tenant_id, full_name, phone) values ('c1000000-0000-4000-8000-00000000000a', 'n', '0566000008')$$), 'ERR:42501:permission denied for table customers', 'M2 provider: cannot insert customers');
reset role; select pg_temp.act_anon();
select is(pg_temp.exec($$delete from public.appointments$$), 'ERR:42501:permission denied for table appointments', 'M2 anon: no appointments access');
select is(pg_temp.exec($$delete from public.customers$$), 'ERR:42501:permission denied for table customers', 'M2 anon: no customers access');
reset role; select pg_temp.act('a0000000-0000-4000-8000-000000000001');   -- seeded demo owner
select is(pg_temp.exec($$delete from public.appointments where tenant_id = 'd0000000-0000-4000-8000-000000000001'$$), 'ERR:42501:permission denied for table appointments', 'M2 demo staff: cannot delete appointments (exploit i)');
select is(pg_temp.exec($$delete from public.customers where tenant_id = 'd0000000-0000-4000-8000-000000000001'$$), 'ERR:42501:permission denied for table customers', 'M2 demo staff: cannot delete customers (exploit i)');
reset role;

-- ===================== 8. M3a: KB size limits =====================
select is((select count(*)::int from pg_constraint where conname in ('kb_documents_content_len','kb_documents_title_len','kb_chunks_content_len') and convalidated), 3, 'M3a: the three size checks exist and are validated');
select pg_temp.act('c0000000-0000-4000-8000-000000000005');
select is(pg_temp.exec($$insert into public.kb_documents (tenant_id, title, source_type, content) values ('c1000000-0000-4000-8000-00000000000a', 't', 'text', repeat('x', 200001))$$), 'ERR:23514:new row for relation "kb_documents" violates check constraint "kb_documents_content_len"', 'M3a: 200001-char document refused');
select is(pg_temp.exec($$insert into public.kb_documents (tenant_id, title, source_type, content) values ('c1000000-0000-4000-8000-00000000000a', repeat('t', 201), 'text', 'x')$$), 'ERR:23514:new row for relation "kb_documents" violates check constraint "kb_documents_title_len"', 'M3a: 201-char title refused');
select is(pg_temp.exec($$insert into public.kb_documents (id, tenant_id, title, source_type, content) values ('c7000000-0000-4000-8000-0000000000a1', 'c1000000-0000-4000-8000-00000000000a', repeat('t', 200), 'text', repeat('x', 200000))$$), 'OK:1', 'M3a: boundary document (200 / 200000) accepted');
select is(pg_temp.exec($$insert into public.kb_chunks (tenant_id, document_id, content) values ('c1000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-0000000000a1', repeat('x', 4001))$$), 'ERR:23514:new row for relation "kb_chunks" violates check constraint "kb_chunks_content_len"', 'M3a: 4001-char chunk refused');
select is(pg_temp.exec($$insert into public.kb_chunks (tenant_id, document_id, content) values ('c1000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-0000000000a1', repeat('x', 4000))$$), 'OK:1', 'M3a: 4000-char chunk accepted');
reset role;
select pg_temp.act_service();
select is(pg_temp.exec($$insert into public.kb_documents (tenant_id, title, source_type, content) values ('c1000000-0000-4000-8000-00000000000a', 't', 'text', repeat('x', 30000000))$$), 'ERR:23514:new row for relation "kb_documents" violates check constraint "kb_documents_content_len"', 'M3a: a 30M-char document is refused even for service_role (exploit iii)');
reset role;

-- ===================== 9. M3b: demo catalogue / KB read-only =====================
-- A (seeded demo owner, no created_by on seeded rows) and V (a per-visitor owner)
insert into public.demo_users (user_id, tenant_id, role) values ('c0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001', 'owner');
insert into public.memberships (user_id, tenant_id, role) values ('c0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001', 'owner'),
  ('c0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000001', 'owner');
select pg_temp.act('c0000000-0000-4000-8000-000000000003');   -- visitor V3
select is(pg_temp.exec($$update public.services set name_en = 'pwned' where id = 'e1000000-0000-4000-8000-000000000001'$$), 'ERR:42501:demo_readonly', 'M3b: visitor cannot rename a seeded service (exploit ii)');
select is(pg_temp.exec($$update public.providers set name_en = 'pwned' where id = 'f1000000-0000-4000-8000-000000000001'$$), 'ERR:42501:demo_readonly', 'M3b: visitor cannot rename a seeded provider (exploit ii)');
select is(pg_temp.exec($$update public.providers set is_active = false where tenant_id = 'd0000000-0000-4000-8000-000000000001'$$), 'ERR:42501:demo_readonly', 'M3b: ... nor deactivate providers');
select is(pg_temp.exec($$delete from public.services where id = 'e1000000-0000-4000-8000-000000000002'$$), 'ERR:42501:permission denied for table services', 'M3b: services/providers DELETE is not granted at all (migration 13); the trigger is a second wall');
select is(pg_temp.exec($$delete from public.providers where id = 'f1000000-0000-4000-8000-000000000002'$$), 'ERR:42501:permission denied for table providers', 'M3b: ... same for providers');
select is(pg_temp.exec($$delete from public.provider_services where tenant_id = 'd0000000-0000-4000-8000-000000000001'$$), 'ERR:42501:demo_readonly', 'M3b: ... nor provider_services');
select is(pg_temp.exec($$delete from public.working_hours where tenant_id = 'd0000000-0000-4000-8000-000000000001'$$), 'ERR:42501:demo_readonly', 'M3b: ... nor working_hours');
select is(pg_temp.exec($$delete from public.time_off where tenant_id = 'd0000000-0000-4000-8000-000000000001'$$), 'ERR:42501:demo_readonly', 'M3b: ... nor time_off');
select is(pg_temp.exec($$delete from public.kb_documents where id = 'ab000000-0000-4000-8000-000000000001'$$), 'ERR:42501:demo_readonly', 'M3b: ... nor the seeded KB document');
select is(pg_temp.exec($$delete from public.kb_chunks where tenant_id = 'd0000000-0000-4000-8000-000000000001'$$), 'ERR:42501:demo_readonly', 'M3b: ... nor seeded KB chunks');
-- own rows are fine
select is(pg_temp.exec($$insert into public.services (tenant_id, name_ar, name_en, duration_min, buffer_min, price) values ('d0000000-0000-4000-8000-000000000001', 'خ', 'Mine', 30, 0, 10)$$), 'OK:1', 'M3b: visitor can still add a service');
select is(pg_temp.exec($$update public.services set name_en = 'Mine v2' where name_en = 'Mine'$$), 'OK:1', 'M3b: ... and edit it');
select is(pg_temp.exec($$insert into public.kb_documents (id, tenant_id, title, source_type, content) values ('c7000000-0000-4000-8000-0000000000d1', 'd0000000-0000-4000-8000-000000000001', 'My FAQ', 'faq', 'hello')$$), 'OK:1', 'M3b: visitor can add a FAQ document');
select is(pg_temp.exec($$insert into public.kb_chunks (tenant_id, document_id, content) values ('d0000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-0000000000d1', 'chunk')$$), 'OK:1', 'M3b: ... and its chunk');
select is(pg_temp.exec($$update public.kb_chunks set embedding = null where tenant_id = 'd0000000-0000-4000-8000-000000000001'$$), 'OK:4', 'M3b: embeddings can still be (re)written on any chunk (indexing step), 3 seeded + 1 own');
reset role;
select pg_temp.act('c0000000-0000-4000-8000-000000000004');   -- another visitor V4
select is(pg_temp.exec($$update public.services set name_en = 'stolen' where name_en = 'Mine v2'$$), 'ERR:42501:demo_readonly', 'M3b: another visitor cannot edit V3''s service');
select is(pg_temp.exec($$delete from public.kb_documents where id = 'c7000000-0000-4000-8000-0000000000d1'$$), 'ERR:42501:demo_readonly', 'M3b: ... nor delete V3''s document');
reset role;
select pg_temp.act('c0000000-0000-4000-8000-000000000003');
select is(pg_temp.exec($$delete from public.kb_chunks where document_id = 'c7000000-0000-4000-8000-0000000000d1'$$), 'OK:1', 'M3b: visitor can delete chunks of their own document');
select is(pg_temp.exec($$delete from public.kb_documents where id = 'c7000000-0000-4000-8000-0000000000d1'$$), 'OK:1', 'M3b: ... and the document');
-- appointments keep working in demo: status change + reschedule via staff_update_appointment
reset role;
select pg_temp.act('c0000000-0000-4000-8000-000000000003');
select is(pg_temp.exec($$select public.staff_update_appointment('c5000000-0000-4000-8000-0000000000b2', null, null, null, 'cancelled', 'demo cancel')$$), 'OK:1', 'M3b: demo status change through staff_update_appointment works');
select is(pg_temp.exec($$update public.appointments set status = 'confirmed' where id = 'c5000000-0000-4000-8000-0000000000b2'$$), 'OK:1', 'M3b: demo direct status update works too');
reset role;
-- exemptions
select pg_temp.act_service();
select is(pg_temp.exec($$update public.services set name_en = 'Check-up & Exam' where id = 'e1000000-0000-4000-8000-000000000001'$$), 'OK:1', 'M3b: service_role is exempt');
reset role;
select is(pg_temp.exec($$select public.reset_demo()$$), 'OK:1', 'M3b: reset_demo (definer) is exempt and still works');
-- non-demo tenant unaffected
select pg_temp.act('c0000000-0000-4000-8000-000000000005');
select is(pg_temp.exec($$update public.services set name_en = 'renamed' where id = 'c3000000-0000-4000-8000-0000000000a1'$$), 'OK:1', 'M3b: non-demo tenants keep full catalogue editing');
select is(pg_temp.exec($$delete from public.kb_documents where id = 'c7000000-0000-4000-8000-0000000000a1'$$), 'OK:1', 'M3b: non-demo owner can delete KB documents');
reset role;

-- ===================== 10. L4: per-phone daily booking limit reuses check_rate_limit =====================
select pg_temp.act_service();
select is((select array_agg(public.check_rate_limit('book-phone:c1000000-0000-4000-8000-00000000000a:' || repeat('9', 64), 3, interval '1 day') order by g) from generate_series(1, 5) g),
          array[true, true, true, false, false], 'L4: check_rate_limit counts bookings per tenant+phone-hash per day (allowed 3, then refused)');
select is(public.check_rate_limit('book-phone:c1000000-0000-4000-8000-00000000000a:' || repeat('8', 64), 3, interval '1 day'), true, 'L4: another phone hash has its own counter');
reset role;

select * from finish();
rollback;
