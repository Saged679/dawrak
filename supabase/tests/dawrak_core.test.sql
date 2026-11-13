-- pgTAP tests. Run with:  npx supabase test db
-- Self-contained: builds two throw-away tenants (test-a / test-b) inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ---------- helpers ----------
-- Monday of next week 'hh:mm' in Asia/Riyadh (Monday = weekday 1)
create function pg_temp.mon(p_t time, p_days int default 0) returns timestamptz language sql as $$
  select (((date_trunc('week', now() at time zone 'Asia/Riyadh') + interval '1 week')::date + p_days + p_t) at time zone 'Asia/Riyadh')
$$;
create function pg_temp.mon_date(p_days int default 0) returns date language sql as $$
  select ((date_trunc('week', now() at time zone 'Asia/Riyadh') + interval '1 week')::date + p_days)
$$;
create function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
-- rows affected by a DML statement, executed with the caller's role (so RLS applies)
create function pg_temp.affected(p_sql text) returns int language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
create function pg_temp.act_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'anon', true);
end $$;

create function pg_temp.act_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;

-- new functions are private by default (L1), so the helpers need an explicit grant
grant execute on all functions in schema pg_temp to public;

-- ---------- fixtures (as postgres, RLS bypassed) ----------
insert into auth.users (id, aud, role, email) values
  ('aa000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner-a@test.local'),
  ('aa000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'rec-a@test.local'),
  ('aa000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'prov-a1@test.local'),
  ('aa000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'owner-b@test.local');

insert into public.tenants (id, slug, name_ar, name_en, kind) values
  ('11111111-0000-4000-8000-00000000000a', 'test-a', 'أ', 'Tenant A', 'clinic'),
  ('11111111-0000-4000-8000-00000000000b', 'test-b', 'ب', 'Tenant B', 'salon');

insert into public.memberships (user_id, tenant_id, role) values
  ('aa000000-0000-4000-8000-000000000001', '11111111-0000-4000-8000-00000000000a', 'owner'),
  ('aa000000-0000-4000-8000-000000000002', '11111111-0000-4000-8000-00000000000a', 'receptionist'),
  ('aa000000-0000-4000-8000-000000000003', '11111111-0000-4000-8000-00000000000a', 'provider'),
  ('aa000000-0000-4000-8000-000000000004', '11111111-0000-4000-8000-00000000000b', 'owner');

insert into public.providers (id, tenant_id, user_id, name_ar, name_en) values
  ('22222222-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-00000000000a', 'aa000000-0000-4000-8000-000000000003', 'مقدم 1', 'A1'),
  ('22222222-0000-4000-8000-0000000000a2', '11111111-0000-4000-8000-00000000000a', null, 'مقدم 2', 'A2'),
  ('22222222-0000-4000-8000-0000000000b1', '11111111-0000-4000-8000-00000000000b', null, 'مقدم ب', 'B1');

insert into public.services (id, tenant_id, name_ar, name_en, duration_min, buffer_min, price) values
  ('33333333-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-00000000000a', 'خدمة', 'Svc A', 60, 0, 100),
  ('33333333-0000-4000-8000-0000000000b1', '11111111-0000-4000-8000-00000000000b', 'خدمة', 'Svc B', 60, 0, 100);

insert into public.provider_services (tenant_id, provider_id, service_id) values
  ('11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a1', '33333333-0000-4000-8000-0000000000a1'),
  ('11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a2', '33333333-0000-4000-8000-0000000000a1'),
  ('11111111-0000-4000-8000-00000000000b', '22222222-0000-4000-8000-0000000000b1', '33333333-0000-4000-8000-0000000000b1');

-- Monday 09:00-12:00 for A1, A2, B1
insert into public.working_hours (tenant_id, provider_id, weekday, start_time, end_time) values
  ('11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a1', 1, '09:00', '12:00'),
  ('11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a2', 1, '09:00', '12:00'),
  ('11111111-0000-4000-8000-00000000000b', '22222222-0000-4000-8000-0000000000b1', 1, '09:00', '12:00');

-- A2 is off 09:00-10:00 on that Monday
insert into public.time_off (tenant_id, provider_id, starts_at, ends_at) values
  ('11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a2', pg_temp.mon('09:00'), pg_temp.mon('10:00'));

insert into public.customers (id, tenant_id, full_name, phone, access_token) values
  ('44444444-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-00000000000a', 'عميل 1', '0500000001', repeat('a', 48)),
  ('44444444-0000-4000-8000-0000000000a2', '11111111-0000-4000-8000-00000000000a', 'عميل 2', '0500000002', repeat('b', 48)),
  ('44444444-0000-4000-8000-0000000000b1', '11111111-0000-4000-8000-00000000000b', 'عميل ب', '0500000003', repeat('c', 48));

insert into public.appointments (id, tenant_id, provider_id, service_id, customer_id, starts_at, ends_at, status) values
  ('55555555-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a1',
   '33333333-0000-4000-8000-0000000000a1', '44444444-0000-4000-8000-0000000000a1', pg_temp.mon('10:00'), pg_temp.mon('11:00'), 'confirmed'),
  ('55555555-0000-4000-8000-0000000000a2', '11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a2',
   '33333333-0000-4000-8000-0000000000a1', '44444444-0000-4000-8000-0000000000a2', pg_temp.mon('11:00'), pg_temp.mon('12:00'), 'confirmed'),
  ('55555555-0000-4000-8000-0000000000b1', '11111111-0000-4000-8000-00000000000b', '22222222-0000-4000-8000-0000000000b1',
   '33333333-0000-4000-8000-0000000000b1', '44444444-0000-4000-8000-0000000000b1', pg_temp.mon('10:00'), pg_temp.mon('11:00'), 'confirmed');

insert into public.payments (tenant_id, appointment_id, amount, status) values
  ('11111111-0000-4000-8000-00000000000a', '55555555-0000-4000-8000-0000000000a1', 100, 'paid'),
  ('11111111-0000-4000-8000-00000000000b', '55555555-0000-4000-8000-0000000000b1', 100, 'paid');

insert into public.conversations (id, tenant_id, channel) values
  ('66666666-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-00000000000a', 'web'),
  ('66666666-0000-4000-8000-0000000000b1', '11111111-0000-4000-8000-00000000000b', 'web');
insert into public.messages (tenant_id, conversation_id, role, content) values
  ('11111111-0000-4000-8000-00000000000a', '66666666-0000-4000-8000-0000000000a1', 'user', 'مرحبا'),
  ('11111111-0000-4000-8000-00000000000b', '66666666-0000-4000-8000-0000000000b1', 'user', 'مرحبا');

-- ===================== 1. get_available_slots excludes taken slots =====================
select is((select count(*)::int from public.get_available_slots(
             '11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a1',
             '33333333-0000-4000-8000-0000000000a1', pg_temp.mon_date(), pg_temp.mon_date(), 60)),
          2, 'A1 Monday: 3 hourly slots minus the booked 10:00 = 2');
select ok(not exists (select 1 from public.get_available_slots(
             '11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a1',
             '33333333-0000-4000-8000-0000000000a1', pg_temp.mon_date(), pg_temp.mon_date(), 60)
             where slot_start = pg_temp.mon('10:00')),
          'the taken 10:00 slot is not offered');
select results_eq($$select slot_start from public.get_available_slots(
             '11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a1',
             '33333333-0000-4000-8000-0000000000a1', pg_temp.mon_date(), pg_temp.mon_date(), 60) order by 1$$,
          $$select s from (values (pg_temp.mon('09:00')), (pg_temp.mon('11:00'))) v(s)$$,
          'remaining slots are 09:00 and 11:00');
select results_eq($$select slot_start from public.get_available_slots(
             '11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a2',
             '33333333-0000-4000-8000-0000000000a1', pg_temp.mon_date(), pg_temp.mon_date(), 60)$$,
          $$select pg_temp.mon('10:00')$$,
          'A2: time off blocks 09:00, appointment blocks 11:00, only 10:00 left');
select is((select count(*)::int from public.get_available_slots(
             '11111111-0000-4000-8000-00000000000a', null,
             '33333333-0000-4000-8000-0000000000a1', pg_temp.mon_date(), pg_temp.mon_date(), 60)),
          3, 'provider = null returns slots of all providers offering the service');
select is((select count(*)::int from public.get_available_slots(
             '11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a1',
             '33333333-0000-4000-8000-0000000000a1', pg_temp.mon_date(1), pg_temp.mon_date(1), 60)),
          0, 'no working hours on Tuesday = no slots');
select is((select count(*)::int from public.get_available_slots(
             '11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000b1',
             '33333333-0000-4000-8000-0000000000b1', pg_temp.mon_date(), pg_temp.mon_date(), 60)),
          0, 'tenant A cannot be asked for tenant B provider/service slots');

-- ===================== 2. double booking is rejected by the constraint =====================
select throws_ok($$insert into public.appointments (tenant_id, provider_id, service_id, customer_id, starts_at, ends_at, status)
  values ('11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a1', '33333333-0000-4000-8000-0000000000a1',
          '44444444-0000-4000-8000-0000000000a2', pg_temp.mon('10:30'), pg_temp.mon('11:30'), 'confirmed')$$,
  '23P01', null, 'overlapping appointment for the same provider is rejected (exclusion constraint)');
select throws_ok($$insert into public.appointments (tenant_id, provider_id, service_id, customer_id, starts_at, ends_at, status)
  values ('11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a1', '33333333-0000-4000-8000-0000000000a1',
          '44444444-0000-4000-8000-0000000000a2', pg_temp.mon('10:00'), pg_temp.mon('11:00'), 'pending_payment')$$,
  '23P01', null, 'exact same time is rejected even as pending_payment');
select lives_ok($$insert into public.appointments (tenant_id, provider_id, service_id, customer_id, starts_at, ends_at, status)
  values ('11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a2', '33333333-0000-4000-8000-0000000000a1',
          '44444444-0000-4000-8000-0000000000a1', pg_temp.mon('10:00'), pg_temp.mon('11:00'), 'confirmed')$$,
  'same time with a different provider is fine (also back-to-back with 11:00 is fine: ranges are [) )');
select lives_ok($$insert into public.appointments (tenant_id, provider_id, service_id, customer_id, starts_at, ends_at, status)
  values ('11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a1', '33333333-0000-4000-8000-0000000000a1',
          '44444444-0000-4000-8000-0000000000a1', pg_temp.mon('10:00'), pg_temp.mon('11:00'), 'cancelled')$$,
  'a cancelled appointment does not hold the slot');
select throws_ok($$insert into public.appointments (tenant_id, provider_id, service_id, customer_id, starts_at, ends_at, status)
  values ('11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a1', '33333333-0000-4000-8000-0000000000b1',
          '44444444-0000-4000-8000-0000000000a2', pg_temp.mon('09:00'), pg_temp.mon('10:00'), 'confirmed')$$,
  '23503', null, 'composite FK: tenant A appointment cannot reference tenant B service');

-- ===================== 3. tenant isolation (authenticated) =====================
reset role;
select pg_temp.act('aa000000-0000-4000-8000-000000000001'); -- owner A
select is((select count(*)::int from public.tenants), 1, 'owner A sees exactly one tenant');
select is((select count(*)::int from public.appointments where tenant_id = '11111111-0000-4000-8000-00000000000b'), 0, 'owner A reads 0 appointments of B');
select is((select count(*)::int from public.customers   where tenant_id = '11111111-0000-4000-8000-00000000000b'), 0, 'owner A reads 0 customers of B');
select is((select count(*)::int from public.payments    where tenant_id = '11111111-0000-4000-8000-00000000000b'), 0, 'owner A reads 0 payments of B');
select is((select count(*)::int from public.messages    where tenant_id = '11111111-0000-4000-8000-00000000000b'), 0, 'owner A reads 0 messages of B');
select cmp_ok((select count(*)::int from public.appointments where tenant_id = '11111111-0000-4000-8000-00000000000a'), '>', 0, 'owner A reads own appointments');
select is((select count(*)::int from public.payments), 1, 'owner A reads own payments');
select is(pg_temp.affected($q$update public.services set price = 1 where tenant_id = '11111111-0000-4000-8000-00000000000b'$q$),
          0, 'owner A cannot update B services (0 rows)');
-- round 3 (M2): DELETE on appointments is no longer granted to authenticated at all (was: RLS hid B's rows, 0 rows)
select throws_ok($q$delete from public.appointments where tenant_id = '11111111-0000-4000-8000-00000000000b'$q$,
          '42501', null, 'owner A cannot delete B appointments (no DELETE privilege since round 3)');
select throws_ok($$insert into public.customers (tenant_id, full_name, phone) values ('11111111-0000-4000-8000-00000000000b', 'x', '0599999999')$$,
  '42501', null, 'owner A cannot insert a customer into B');
select throws_ok($$insert into public.memberships (user_id, tenant_id, role) values ('aa000000-0000-4000-8000-000000000001', '11111111-0000-4000-8000-00000000000b', 'owner')$$,
  '42501', null, 'owner A cannot grant themselves membership in B');

reset role;
select pg_temp.act('aa000000-0000-4000-8000-000000000004'); -- owner B
select is((select count(*)::int from public.appointments where tenant_id = '11111111-0000-4000-8000-00000000000a'), 0, 'owner B reads 0 appointments of A');
select is((select count(*)::int from public.appointments), 1, 'owner B sees only their own appointment');

-- ===================== 4. receptionist: no payments, no tenant settings =====================
reset role;
select pg_temp.act('aa000000-0000-4000-8000-000000000002'); -- receptionist A
select cmp_ok((select count(*)::int from public.appointments), '>', 0, 'receptionist reads appointments');
select is((select count(*)::int from public.payments), 0, 'receptionist cannot read payments');
select is(pg_temp.affected($q$update public.tenants set name_en = 'hacked'$q$), 0, 'receptionist cannot change tenant settings');
select throws_ok($$insert into public.payments (tenant_id, appointment_id, amount) values ('11111111-0000-4000-8000-00000000000a', '55555555-0000-4000-8000-0000000000a1', 1)$$,
  '42501', null, 'receptionist cannot write payments');

-- ===================== 5. provider: own appointments only, no payments =====================
reset role;
select pg_temp.act('aa000000-0000-4000-8000-000000000003'); -- provider A1
select cmp_ok((select count(*)::int from public.appointments), '>', 0, 'provider sees own appointments');
select is((select count(*)::int from public.appointments where provider_id <> '22222222-0000-4000-8000-0000000000a1'), 0, 'provider sees no other provider''s appointments');
select is((select count(*)::int from public.customers where id = '44444444-0000-4000-8000-0000000000a2'), 0, 'provider cannot see customers who are not on their appointments');
select is((select count(*)::int from public.customers where id = '44444444-0000-4000-8000-0000000000a1'), 1, 'provider sees customers on their own appointments');
select is((select count(*)::int from public.payments), 0, 'provider cannot read payments');
select throws_ok($$insert into public.payments (tenant_id, appointment_id, amount) values ('11111111-0000-4000-8000-00000000000a', '55555555-0000-4000-8000-0000000000a1', 1)$$,
  '42501', null, 'provider cannot write payments');
select is((select count(*)::int from public.conversations), 0, 'provider cannot read conversations');
select is(pg_temp.affected($q$update public.appointments set notes = 'x' where provider_id = '22222222-0000-4000-8000-0000000000a2'$q$),
          0, 'provider cannot update another provider''s appointment');
select is(pg_temp.affected($q$update public.appointments set status = 'completed' where id = '55555555-0000-4000-8000-0000000000a1'$q$),
          1, 'provider can update their own appointment status');

-- ===================== 6. anon: functions only, never tables =====================
reset role;
select pg_temp.act_anon();
select throws_ok($$select * from public.appointments$$, '42501', null, 'anon cannot read appointments');
select throws_ok($$select * from public.customers$$, '42501', null, 'anon cannot read customers');
select throws_ok($$select * from public.tenants$$, '42501', null, 'anon cannot read tenants table');
select throws_ok($$select public.check_rate_limit('x', 1, interval '1 minute')$$, '42501', null, 'anon cannot call check_rate_limit');
select throws_ok($$select public.reset_demo()$$, '42501', null, 'anon cannot call reset_demo');
select is((select count(*)::int from public.public_get_tenant('test-a')), 1, 'anon can load a public tenant page via function');
select is((select count(*)::int from public.public_list_services('11111111-0000-4000-8000-00000000000a')), 1, 'anon lists services of A via function');
-- customer_* / create_public_booking / get_available_slots are service-role only (security review H1)
select throws_ok($$select * from public.customer_get_appointments(repeat('a', 48))$$, '42501', null, 'anon cannot call customer_get_appointments');
select throws_ok($$select public.create_public_booking('11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a1',
          '33333333-0000-4000-8000-0000000000a1', pg_temp.mon('09:00'), 'x y', '0500000097')$$, '42501', null, 'anon cannot call create_public_booking');
reset role;
select pg_temp.act_service();
select is((select count(*)::int from public.customer_get_appointments(repeat('a', 48)) where id in ('55555555-0000-4000-8000-0000000000a2','55555555-0000-4000-8000-0000000000b1')), 0, 'token never returns other customers'' appointments');
select is((select count(*)::int from public.customer_get_appointments(repeat('a', 48))), 3, 'token returns that customer''s 3 appointments');
select is((select count(*)::int from public.customer_get_appointments(repeat('z', 48))), 0, 'wrong token returns nothing');
select is((public.create_public_booking('11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a1',
          '33333333-0000-4000-8000-0000000000a1', pg_temp.mon('09:00'), 'عميل جديد', '0500000099')->>'status'),
          'confirmed', 'service role can book a free slot (no deposit tenant -> confirmed)');
select throws_ok($$select public.create_public_booking('11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a1',
          '33333333-0000-4000-8000-0000000000a1', pg_temp.mon('09:00'), 'عميل آخر', '0500000098')$$,
          '23P01', 'slot_taken', 'booking the same slot again fails with slot_taken');
select throws_ok($$select public.create_public_booking('11111111-0000-4000-8000-00000000000a', '22222222-0000-4000-8000-0000000000a1',
          '33333333-0000-4000-8000-0000000000a1', pg_temp.mon('13:00'), 'عميل آخر', '0500000098')$$,
          '23P01', 'slot_taken', 'booking outside working hours is rejected');

reset role;
-- ===================== 7. rate limit (service role / postgres) =====================
reset role;
select is(public.check_rate_limit('t:ip:1', 2, interval '1 minute'), true, 'rate limit hit 1 allowed');
select is(public.check_rate_limit('t:ip:1', 2, interval '1 minute'), true, 'rate limit hit 2 allowed');
select is(public.check_rate_limit('t:ip:1', 2, interval '1 minute'), false, 'rate limit hit 3 blocked');

select * from finish();
rollback;
