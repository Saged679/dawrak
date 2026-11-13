-- pgTAP: security review regression tests (C1, H1-H3, M1-M3, L1-L3). Run: npx supabase test db
-- Fixtures are throw-away (rolled back). Demo checks use the seeded demo tenants/users (seed.sql).
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ---------- helpers ----------
create function pg_temp.at(p_days int, p_t time) returns timestamptz language sql as $$
  select (((now() at time zone 'Asia/Riyadh')::date + p_days + p_t) at time zone 'Asia/Riyadh')
$$;
create function pg_temp.at_date(p_days int) returns date language sql as $$
  select ((now() at time zone 'Asia/Riyadh')::date + p_days)
$$;
create function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
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
-- first column of a single-row query as text; errors come back as 'ERR:<sqlstate>:<message>'
create function pg_temp.q(p_sql text) returns text language plpgsql as $$
declare r text;
begin
  execute p_sql into r;
  return coalesce(r, 'NULL');
exception when others then return 'ERR:' || sqlstate || ':' || sqlerrm;
end $$;
-- DML: 'OK:<rows>' or 'ERR:<sqlstate>:<message>'
create function pg_temp.exec(p_sql text) returns text language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'OK:' || n;
exception when others then return 'ERR:' || sqlstate || ':' || sqlerrm;
end $$;

create function pg_temp.lk(p_have text, p_pat text, p_desc text) returns text language sql as $f$
  select extensions.ok(p_have like p_pat, p_desc) || case when p_have like p_pat then '' else E'
# have: ' || p_have end
$f$;

-- new functions are private by default (L1), so the helpers need an explicit grant
grant execute on all functions in schema pg_temp to public;

create temp table ctok (t text);
grant all on ctok to public;

-- ---------- fixtures (postgres, RLS bypassed) ----------
insert into auth.users (id, aud, role, email) values
  ('7a000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'sec-owner@test.local'),
  ('7a000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'sec-rec@test.local'),
  ('7a000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'sec-prov@test.local'),
  ('7a000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'sec-owner-y@test.local');
insert into public.tenants (id, slug, name_ar, name_en, kind) values
  ('71111111-0000-4000-8000-00000000000a', 'sec-x', 'س', 'Sec X', 'clinic'),
  ('71111111-0000-4000-8000-00000000000b', 'sec-y', 'ص', 'Sec Y', 'clinic');
insert into public.memberships (user_id, tenant_id, role) values
  ('7a000000-0000-4000-8000-000000000001', '71111111-0000-4000-8000-00000000000a', 'owner'),
  ('7a000000-0000-4000-8000-000000000002', '71111111-0000-4000-8000-00000000000a', 'receptionist'),
  ('7a000000-0000-4000-8000-000000000003', '71111111-0000-4000-8000-00000000000a', 'provider'),
  ('7a000000-0000-4000-8000-000000000004', '71111111-0000-4000-8000-00000000000b', 'owner');
insert into public.providers (id, tenant_id, user_id, name_ar, name_en) values
  ('72222222-0000-4000-8000-0000000000a1', '71111111-0000-4000-8000-00000000000a', '7a000000-0000-4000-8000-000000000003', 'م1', 'P1'),
  ('72222222-0000-4000-8000-0000000000a2', '71111111-0000-4000-8000-00000000000a', null, 'م2', 'P2');
insert into public.services (id, tenant_id, name_ar, name_en, duration_min, buffer_min, price) values
  ('73333333-0000-4000-8000-0000000000a1', '71111111-0000-4000-8000-00000000000a', 'خ', 'Svc', 60, 0, 100);
insert into public.provider_services (tenant_id, provider_id, service_id)
select '71111111-0000-4000-8000-00000000000a', p, '73333333-0000-4000-8000-0000000000a1'
from unnest(array['72222222-0000-4000-8000-0000000000a1','72222222-0000-4000-8000-0000000000a2']::uuid[]) p;
-- every weekday 08:00-20:00 so tests do not depend on today's weekday
insert into public.working_hours (tenant_id, provider_id, weekday, start_time, end_time)
select '71111111-0000-4000-8000-00000000000a', p, d, '08:00', '20:00'
from unnest(array['72222222-0000-4000-8000-0000000000a1','72222222-0000-4000-8000-0000000000a2']::uuid[]) p, generate_series(0,6) d;

insert into public.customers (id, tenant_id, full_name, phone, email, access_token) values
  ('74444444-0000-4000-8000-0000000000c1', '71111111-0000-4000-8000-00000000000a', 'Victim', '0555000001', 'victim@x.com', repeat('v', 48)),
  ('74444444-0000-4000-8000-0000000000c2', '71111111-0000-4000-8000-00000000000a', 'Other',  '0555000009', null, repeat('w', 48)),
  ('74444444-0000-4000-8000-0000000000c3', '71111111-0000-4000-8000-00000000000a', 'Third',  '0555000008', null, repeat('u', 48));

insert into public.appointments (id, tenant_id, provider_id, service_id, customer_id, starts_at, ends_at, status, price, payment_expires_at) values
  -- provider-owned confirmed appointment (victim)
  ('75555555-0000-4000-8000-0000000000a1', '71111111-0000-4000-8000-00000000000a', '72222222-0000-4000-8000-0000000000a1', '73333333-0000-4000-8000-0000000000a1',
   '74444444-0000-4000-8000-0000000000c1', pg_temp.at(1,'09:00'), pg_temp.at(1,'10:00'), 'confirmed', 100, null),
  -- unpaid appointment of P1 (customer 2)
  ('75555555-0000-4000-8000-0000000000a2', '71111111-0000-4000-8000-00000000000a', '72222222-0000-4000-8000-0000000000a1', '73333333-0000-4000-8000-0000000000a1',
   '74444444-0000-4000-8000-0000000000c2', pg_temp.at(1,'11:00'), pg_temp.at(1,'12:00'), 'pending_payment', 100, now() + interval '10 minutes'),
  -- stale hold of P2 (payment window already over, never expired by a job)
  ('75555555-0000-4000-8000-0000000000a3', '71111111-0000-4000-8000-00000000000a', '72222222-0000-4000-8000-0000000000a2', '73333333-0000-4000-8000-0000000000a1',
   '74444444-0000-4000-8000-0000000000c2', pg_temp.at(5,'10:00'), pg_temp.at(5,'11:00'), 'pending_payment', 100, now() - interval '1 minute'),
  -- appointment staff will edit (P2, customer 2)
  ('75555555-0000-4000-8000-0000000000a4', '71111111-0000-4000-8000-00000000000a', '72222222-0000-4000-8000-0000000000a2', '73333333-0000-4000-8000-0000000000a1',
   '74444444-0000-4000-8000-0000000000c2', pg_temp.at(7,'10:00'), pg_temp.at(7,'11:00'), 'confirmed', 100, null),
  -- blocker on P1 at day 8 10:00 (customer 3), never touched by provider tests
  ('75555555-0000-4000-8000-0000000000a5', '71111111-0000-4000-8000-00000000000a', '72222222-0000-4000-8000-0000000000a1', '73333333-0000-4000-8000-0000000000a1',
   '74444444-0000-4000-8000-0000000000c3', pg_temp.at(8,'10:00'), pg_temp.at(8,'11:00'), 'confirmed', 100, null);

-- ===================== C1. no customer takeover through create_public_booking =====================
reset role; select pg_temp.act_service();
select is(pg_temp.q($$select coalesce(public.create_public_booking('71111111-0000-4000-8000-00000000000a','72222222-0000-4000-8000-0000000000a1',
          '73333333-0000-4000-8000-0000000000a1', pg_temp.at(2,'10:00'), 'Attacker', '0555000001', 'evil@x.com')->>'customer_token', 'NULL')$$),
  'NULL', 'C1: booking with an existing phone does NOT return the existing customer token');
reset role;
select is((select full_name || '|' || email || '|' || access_token from public.customers where id = '74444444-0000-4000-8000-0000000000c1'),
  'Victim|victim@x.com|' || repeat('v', 48), 'C1: existing customer name, email and token are untouched');
select is((select count(*)::int from public.appointments where customer_id = '74444444-0000-4000-8000-0000000000c1' and starts_at = pg_temp.at(2,'10:00')),
  1, 'C1: the booking for the existing customer still succeeds');
select pg_temp.act_service();
select is(pg_temp.exec($$insert into pg_temp.ctok select public.create_public_booking('71111111-0000-4000-8000-00000000000a','72222222-0000-4000-8000-0000000000a1',
          '73333333-0000-4000-8000-0000000000a1', pg_temp.at(2,'12:00'), 'Brand New', '0555000777')->>'customer_token'$$), 'OK:1', 'C1: new customer booking succeeds');
reset role;
select is((select t from pg_temp.ctok limit 1), (select access_token from public.customers where phone = '0555000777'),
  'C1: a newly created customer does get their token back (and it matches the row)');
truncate pg_temp.ctok;


-- ===================== H1. service-role-only functions, 90-day horizon, 3 booking cap =====================
select is((select count(*)::int from unnest(array[
    'public.create_public_booking(uuid,uuid,uuid,timestamptz,text,text,text,text,text)',
    'public.customer_get_appointments(text)', 'public.customer_cancel_appointment(text,uuid)',
    'public.customer_reschedule_appointment(text,uuid,timestamptz)', 'public.get_available_slots(uuid,uuid,uuid,date,date,int)',
    'public.issue_customer_magic_link(uuid,text,boolean)']) f
    where has_function_privilege('anon', to_regprocedure(f)::oid, 'execute') or has_function_privilege('authenticated', to_regprocedure(f)::oid, 'execute')),
  0, 'H1: anon and authenticated cannot execute any booking / customer / slots function');
select is((select count(*)::int from unnest(array[
    'public.create_public_booking(uuid,uuid,uuid,timestamptz,text,text,text,text,text)',
    'public.customer_get_appointments(text)', 'public.customer_cancel_appointment(text,uuid)',
    'public.customer_reschedule_appointment(text,uuid,timestamptz)', 'public.get_available_slots(uuid,uuid,uuid,date,date,int)',
    'public.issue_customer_magic_link(uuid,text,boolean)']) f
    where has_function_privilege('service_role', to_regprocedure(f)::oid, 'execute')),
  6, 'H1: service_role can execute all of them');
select pg_temp.act_anon();
select throws_ok($$select public.create_public_booking('71111111-0000-4000-8000-00000000000a','72222222-0000-4000-8000-0000000000a1',
          '73333333-0000-4000-8000-0000000000a1', now() + interval '3 days', 'Spam Bot', '0555111222')$$,
  '42501', null, 'H1: anon cannot call create_public_booking via rpc');
select throws_ok($$select * from public.get_available_slots('71111111-0000-4000-8000-00000000000a', null,
          '73333333-0000-4000-8000-0000000000a1', current_date, current_date + 1, 15)$$,
  '42501', null, 'H1: anon cannot call get_available_slots');
reset role; select pg_temp.act('7a000000-0000-4000-8000-000000000001');
select throws_ok($$select * from public.customer_get_appointments('x')$$, '42501', null, 'H1: authenticated cannot call customer_get_appointments');
select throws_ok($$select public.customer_cancel_appointment('x', gen_random_uuid())$$, '42501', null, 'H1: authenticated cannot call customer_cancel_appointment');
select throws_ok($$select public.customer_reschedule_appointment('x', gen_random_uuid(), now())$$, '42501', null, 'H1: authenticated cannot call customer_reschedule_appointment');
reset role; select pg_temp.act_service();
select throws_ok($$select public.create_public_booking('71111111-0000-4000-8000-00000000000a','72222222-0000-4000-8000-0000000000a1',
          '73333333-0000-4000-8000-0000000000a1', pg_temp.at(100,'10:00'), 'Far Away', '0555000010')$$,
  'P0001', 'too_far', 'H1: booking more than 90 days ahead is rejected (too_far)');
select throws_ok($$select public.customer_reschedule_appointment(repeat('v', 48), '75555555-0000-4000-8000-0000000000a1', pg_temp.at(100,'10:00'))$$,
  'P0001', 'too_far', 'H1: rescheduling more than 90 days ahead is rejected (too_far)');
select is(pg_temp.q($$select (public.create_public_booking('71111111-0000-4000-8000-00000000000a','72222222-0000-4000-8000-0000000000a1',
          '73333333-0000-4000-8000-0000000000a1', pg_temp.at(3,'10:00'), 'Hoarder', '0555000002')->>'status')$$), 'confirmed', 'H1: booking 1 of 3 allowed');
select is(pg_temp.q($$select (public.create_public_booking('71111111-0000-4000-8000-00000000000a','72222222-0000-4000-8000-0000000000a1',
          '73333333-0000-4000-8000-0000000000a1', pg_temp.at(4,'10:00'), 'Hoarder', '0555000002')->>'status')$$), 'confirmed', 'H1: booking 2 of 3 allowed');
select is(pg_temp.q($$select (public.create_public_booking('71111111-0000-4000-8000-00000000000a','72222222-0000-4000-8000-0000000000a1',
          '73333333-0000-4000-8000-0000000000a1', pg_temp.at(6,'10:00'), 'Hoarder', '0555000002')->>'status')$$), 'confirmed', 'H1: booking 3 of 3 allowed');
select throws_ok($$select public.create_public_booking('71111111-0000-4000-8000-00000000000a','72222222-0000-4000-8000-0000000000a1',
          '73333333-0000-4000-8000-0000000000a1', pg_temp.at(9,'10:00'), 'Hoarder', '0555000002')$$,
  'P0001', 'too_many_bookings', 'H1: 4th active future booking for the same phone is rejected (too_many_bookings)');
-- staff dashboard path
reset role; select pg_temp.act('7a000000-0000-4000-8000-000000000002');
select is(pg_temp.q($$select (count(*) > 0)::text from public.staff_get_available_slots('71111111-0000-4000-8000-00000000000a', null,
          '73333333-0000-4000-8000-0000000000a1', pg_temp.at_date(10), pg_temp.at_date(10), 60)$$),
  'true', 'H1: receptionist gets slots through staff_get_available_slots');
reset role; select pg_temp.act('7a000000-0000-4000-8000-000000000004');
select throws_ok($$select * from public.staff_get_available_slots('71111111-0000-4000-8000-00000000000a', null,
          '73333333-0000-4000-8000-0000000000a1', current_date, current_date + 1, 60)$$,
  '42501', 'forbidden', 'H1: owner of another tenant cannot use staff_get_available_slots');
reset role; select pg_temp.act('7a000000-0000-4000-8000-000000000003');
select throws_ok($$select * from public.staff_get_available_slots('71111111-0000-4000-8000-00000000000a', null,
          '73333333-0000-4000-8000-0000000000a1', current_date, current_date + 1, 60)$$,
  '42501', 'forbidden', 'H1: provider-role member cannot use staff_get_available_slots');
reset role; select pg_temp.act_anon();
select throws_ok($$select * from public.staff_get_available_slots('71111111-0000-4000-8000-00000000000a', null,
          '73333333-0000-4000-8000-0000000000a1', current_date, current_date + 1, 60)$$,
  '42501', null, 'H1: anon cannot use staff_get_available_slots');
reset role;

-- ===================== H2. owners edit settings only =====================
select pg_temp.act('a0000000-0000-4000-8000-000000000001'); -- seeded demo clinic owner
select pg_temp.lk(pg_temp.exec($$update public.tenants set is_demo = false where slug = 'demo-clinic'$$), 'ERR:42501%', 'H2: demo owner cannot flip is_demo');
select pg_temp.lk(pg_temp.exec($$update public.tenants set slug = 'hacked' where slug = 'demo-clinic'$$), 'ERR:42501%', 'H2: owner cannot change slug');
select pg_temp.lk(pg_temp.exec($$update public.tenants set kind = 'salon' where slug = 'demo-clinic'$$), 'ERR:42501%', 'H2: owner cannot change kind');
select is(pg_temp.exec($$update public.tenants set deposit_value = 60 where slug = 'demo-clinic'$$),
  'OK:1', 'H2: owner can still edit allowed settings columns');
reset role; select pg_temp.act('7a000000-0000-4000-8000-000000000001');
select pg_temp.lk(pg_temp.exec($$update public.tenants set is_demo = true where slug = 'sec-x'$$), 'ERR:42501%', 'H2: regular tenant owner cannot set is_demo either');
reset role;
-- defaced + partial demo data: flip is_demo on the clinic, drop the salon entirely, then reset as service role
update public.tenants set is_demo = false, name_en = 'DEFACED' where id = 'd0000000-0000-4000-8000-000000000001';
delete from public.tenants where id = 'd0000000-0000-4000-8000-000000000002';
select pg_temp.act_service();
select is(pg_temp.exec($$select public.reset_demo()$$), 'OK:1', 'H2: reset_demo() works as service_role on defaced/partial data');
reset role;
select is((select count(*)::int from public.tenants where is_demo and id in ('d0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002')),
  2, 'H2: after reset both demo tenants exist again and are is_demo');
select is((select name_en from public.tenants where id = 'd0000000-0000-4000-8000-000000000001'), 'Nabd Dental Clinic', 'H2: defaced demo name restored');
select cmp_ok((select count(*)::int from public.services where tenant_id = 'd0000000-0000-4000-8000-000000000002'), '>', 0, 'H2: demo salon data is back');
-- seed_demo itself heals partial data
delete from public.services where tenant_id = 'd0000000-0000-4000-8000-000000000001';
select pg_temp.act_service();
select is(pg_temp.exec($$select public.seed_demo()$$), 'OK:1', 'H2: seed_demo() runs on partial data as service_role');
reset role;
select cmp_ok((select count(*)::int from public.services where tenant_id = 'd0000000-0000-4000-8000-000000000001'), '>', 0, 'H2: seed_demo() did not return early on partial data');
select is((select count(*)::int from public.memberships where tenant_id = 'd0000000-0000-4000-8000-000000000001'), 3, 'H2: demo memberships are restored by reset');

-- ===================== H3. provider update limited to status/notes =====================
select pg_temp.act('7a000000-0000-4000-8000-000000000003'); -- provider P1
select pg_temp.lk(pg_temp.exec($$update public.appointments set customer_id = '74444444-0000-4000-8000-0000000000c2' where id = '75555555-0000-4000-8000-0000000000a1'$$),
  'ERR:42501%', 'H3: provider cannot reassign customer_id');
select pg_temp.lk(pg_temp.exec($$update public.appointments set price = 0 where id = '75555555-0000-4000-8000-0000000000a1'$$),
  'ERR:42501%', 'H3: provider cannot change price');
select pg_temp.lk(pg_temp.exec($$update public.appointments set starts_at = starts_at + interval '1 day' where id = '75555555-0000-4000-8000-0000000000a1'$$),
  'ERR:42501%', 'H3: provider cannot move starts_at');
select pg_temp.lk(pg_temp.exec($$update public.appointments set status = 'cancelled' where id = '75555555-0000-4000-8000-0000000000a1'$$),
  'ERR:42501%', 'H3: provider cannot set status outside completed/no_show (WITH CHECK)');
select is(pg_temp.exec($$update public.appointments set status = 'completed' where id = '75555555-0000-4000-8000-0000000000a2'$$),
  'OK:0', 'H3: provider cannot mark an unpaid (pending_payment) appointment completed');
select is(pg_temp.exec($$update public.appointments set status = 'completed', notes = 'done' where id = '75555555-0000-4000-8000-0000000000a1'$$),
  'OK:1', 'H3: provider can mark their own confirmed appointment completed with notes');
-- staff: no structural edits on the table, only status/notes; structural edits through the function
reset role; select pg_temp.act('7a000000-0000-4000-8000-000000000002'); -- receptionist
select pg_temp.lk(pg_temp.exec($$update public.appointments set starts_at = starts_at + interval '1 hour' where id = '75555555-0000-4000-8000-0000000000a4'$$),
  'ERR:42501%', 'H3: receptionist cannot patch starts_at directly');
select pg_temp.lk(pg_temp.exec($$update public.appointments set customer_id = '74444444-0000-4000-8000-0000000000c1' where id = '75555555-0000-4000-8000-0000000000a4'$$),
  'ERR:42501%', 'H3: receptionist cannot patch customer_id directly');
select is(pg_temp.exec($$update public.appointments set notes = 'call back' where id = '75555555-0000-4000-8000-0000000000a4'$$),
  'OK:1', 'H3: receptionist can still update notes on the table');
select is(pg_temp.q($$select (public.staff_update_appointment('75555555-0000-4000-8000-0000000000a4', pg_temp.at(7,'12:00'))->>'starts_at')::timestamptz = pg_temp.at(7,'12:00')$$),
  'true', 'H3: receptionist reschedules through staff_update_appointment');
select throws_ok($$select public.staff_update_appointment('75555555-0000-4000-8000-0000000000a4', pg_temp.at(8,'10:00'), '72222222-0000-4000-8000-0000000000a1')$$,
  '23P01', 'slot_taken', 'H3: staff_update_appointment refuses a taken slot');
select throws_ok($$select public.staff_update_appointment('75555555-0000-4000-8000-0000000000a4', null, null, null, 'bogus')$$,
  'P0001', 'invalid_status', 'H3: staff_update_appointment validates status');
select is(pg_temp.q($$select public.staff_update_appointment('75555555-0000-4000-8000-0000000000a4', null, null, null, 'cancelled')->>'status'$$),
  'cancelled', 'H3: staff cancels through staff_update_appointment');
reset role; select pg_temp.act('7a000000-0000-4000-8000-000000000003'); -- provider
select throws_ok($$select public.staff_update_appointment('75555555-0000-4000-8000-0000000000a4', pg_temp.at(7,'15:00'))$$,
  'P0001', 'appointment_not_found', 'H3: a provider cannot use staff_update_appointment');
reset role; select pg_temp.act('7a000000-0000-4000-8000-000000000004'); -- owner of tenant Y
select throws_ok($$select public.staff_update_appointment('75555555-0000-4000-8000-0000000000a4', pg_temp.at(7,'15:00'))$$,
  'P0001', 'appointment_not_found', 'H3: another tenant''s owner cannot use staff_update_appointment');
reset role; select pg_temp.act_anon();
select throws_ok($$select public.staff_update_appointment('75555555-0000-4000-8000-0000000000a4', pg_temp.at(7,'15:00'))$$,
  '42501', null, 'H3: anon cannot execute staff_update_appointment');
reset role;

-- ===================== M1. tokens hidden from staff, expiring, rotatable =====================
select pg_temp.act('7a000000-0000-4000-8000-000000000002'); -- receptionist
select pg_temp.lk(pg_temp.q($$select access_token from public.customers limit 1$$), 'ERR:42501%', 'M1: receptionist cannot read access_token');
select pg_temp.lk(pg_temp.q($$select count(*) from (select * from public.customers) c$$), 'ERR:42501%', 'M1: select * on customers is denied for staff (token column)');
select is(pg_temp.q($$select (count(*) >= 3)::text from (select id, full_name, phone, email from public.customers) c$$), 'true', 'M1: receptionist reads customers without the token');
-- round 3 (M2): customers are no longer writable by authenticated (contact data changes via service-role functions)
select pg_temp.lk(pg_temp.exec($$update public.customers set full_name = 'Renamed' where id = '74444444-0000-4000-8000-0000000000c3'$$), 'ERR:42501%', 'M2: staff can no longer edit customers directly');
select pg_temp.lk(pg_temp.exec($$update public.customers set access_token = 'known' where id = '74444444-0000-4000-8000-0000000000c3'$$), 'ERR:42501%', 'M1: staff cannot set a customer token');
select pg_temp.lk(pg_temp.exec($$insert into public.customers (tenant_id, full_name, phone, access_token) values ('71111111-0000-4000-8000-00000000000a','n','0599000000','known')$$),
  'ERR:42501%', 'M1: staff cannot insert a customer with a chosen token');
select pg_temp.lk(pg_temp.exec($$insert into public.customers (tenant_id, full_name, phone) values ('71111111-0000-4000-8000-00000000000a','Walk In','0599000001')$$),
  'ERR:42501%', 'M2: staff can no longer insert customers directly');
reset role; select pg_temp.act('7a000000-0000-4000-8000-000000000003'); -- provider
select pg_temp.lk(pg_temp.q($$select access_token from public.customers limit 1$$), 'ERR:42501%', 'M1: provider cannot read access_token');
select is(pg_temp.q($$select (count(*) >= 1)::text from (select id, full_name from public.customers) c$$), 'true', 'M1: provider still reads their customers');
reset role;
-- expiry
select is(pg_temp.exec($$update public.customers set access_token_expires_at = now() - interval '1 day' where id = '74444444-0000-4000-8000-0000000000c2'$$),
  'OK:1', 'M1: customers.access_token_expires_at exists');
select pg_temp.act_service();
select is(pg_temp.q($$select count(*)::text from public.customer_get_appointments(repeat('w', 48))$$), '0', 'M1: expired token returns no appointments');
select is(pg_temp.q($$select public.customer_cancel_appointment(repeat('w', 48), '75555555-0000-4000-8000-0000000000a2')::text$$), 'false', 'M1: expired token cannot cancel');
select throws_ok($$select public.customer_reschedule_appointment(repeat('w', 48), '75555555-0000-4000-8000-0000000000a2', pg_temp.at(12,'10:00'))$$,
  'P0001', 'appointment_not_found', 'M1: expired token cannot reschedule');
-- rotation
select is(pg_temp.exec($$insert into pg_temp.ctok select public.issue_customer_magic_link('71111111-0000-4000-8000-00000000000a', '0555000001', true)$$), 'OK:1', 'M1: issue_customer_magic_link returns a token (p_force rotates since round 3)');
select is(pg_temp.q($$select (count(*) > 0)::text from public.customer_get_appointments((select t from pg_temp.ctok limit 1))$$),
  'true', 'M1: the freshly issued token works');
select is(pg_temp.q($$select count(*)::text from public.customer_get_appointments(repeat('v', 48))$$), '0', 'M1: the previous token stops working after rotation');
select is(pg_temp.q($$select (access_token <> repeat('v', 48) and length(access_token) = 48 and access_token_expires_at > now() + interval '29 days')::text from public.customers where id = '74444444-0000-4000-8000-0000000000c1'$$),
  'true', 'M1: token rotated, 48 hex chars, expiry pushed ~30 days');
select is(pg_temp.q($$select public.issue_customer_magic_link('71111111-0000-4000-8000-00000000000a', '0500999999')$$), 'NULL', 'M1: unknown phone gives null');
reset role; select pg_temp.act_anon();
select throws_ok($$select public.issue_customer_magic_link('71111111-0000-4000-8000-00000000000a', '0555000001')$$, '42501', null, 'M1: anon cannot issue magic links');
reset role; select pg_temp.act('7a000000-0000-4000-8000-000000000001');
select throws_ok($$select public.issue_customer_magic_link('71111111-0000-4000-8000-00000000000a', '0555000001')$$, '42501', null, 'M1: authenticated (even owner) cannot issue magic links');
reset role;

-- ===================== M2. expired holds do not block slots =====================
select pg_temp.act_service();
select is(pg_temp.q($$select (public.create_public_booking('71111111-0000-4000-8000-00000000000a','72222222-0000-4000-8000-0000000000a2',
          '73333333-0000-4000-8000-0000000000a1', pg_temp.at(5,'10:00'), 'Late Comer', '0555000003')->>'status')$$),
  'confirmed', 'M2: a slot held by an expired pending_payment booking can be booked immediately');
reset role;
select is((select status from public.appointments where id = '75555555-0000-4000-8000-0000000000a3'), 'cancelled', 'M2: the stale hold got expired by the booking call');
select is((select count(*)::int from cron.job where jobname = 'dawrak_expire_pending' and command like '%expire_pending_bookings%'),
  1, 'M2: pg_cron job runs expire_pending_bookings() every minute');
select is((select schedule from cron.job where jobname = 'dawrak_expire_pending'), '* * * * *', 'M2: cron schedule is every minute');

-- ===================== M3. demo tenants: capped KB, frozen memberships =====================
select pg_temp.act('a0000000-0000-4000-8000-000000000001'); -- demo clinic owner
select pg_temp.lk(pg_temp.exec($$insert into public.memberships (user_id, tenant_id, role) values ('a0000000-0000-4000-8000-000000000004','d0000000-0000-4000-8000-000000000001','receptionist')$$),
  'ERR:42501:demo_readonly%', 'M3: demo owner cannot add memberships');
select pg_temp.lk(pg_temp.exec($$update public.memberships set role = 'provider' where user_id = 'a0000000-0000-4000-8000-000000000002'$$),
  'ERR:42501:demo_readonly%', 'M3: demo owner cannot change memberships');
select pg_temp.lk(pg_temp.exec($$delete from public.memberships where user_id = 'a0000000-0000-4000-8000-000000000002'$$),
  'ERR:42501:demo_readonly%', 'M3: demo owner cannot delete memberships');
select pg_temp.lk(pg_temp.exec($$insert into public.kb_chunks (tenant_id, document_id, chunk_index, content)
  select 'd0000000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-000000000001', g, 'spam' from generate_series(1, 250) g$$),
  'ERR:54000:demo_limit%', 'M3: demo tenant kb_chunks capped at 200 (bulk insert of 250 rejected)');
select pg_temp.lk(pg_temp.exec($$insert into public.kb_documents (tenant_id, title) select 'd0000000-0000-4000-8000-000000000001', 'spam ' || g from generate_series(1, 25) g$$),
  'ERR:54000:demo_limit%', 'M3: demo tenant kb_documents capped at 20');
select is(pg_temp.exec($$insert into public.kb_chunks (tenant_id, document_id, chunk_index, content)
  select 'd0000000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-000000000001', g, 'ok' from generate_series(10, 12) g$$),
  'OK:3', 'M3: a few KB chunks are still fine on the demo tenant');
reset role;
select pg_temp.act_service();
select is(pg_temp.exec($$update public.memberships set role = role where user_id = 'a0000000-0000-4000-8000-000000000002'$$), 'OK:1', 'M3: service_role can still touch demo memberships');
reset role;
select pg_temp.act('7a000000-0000-4000-8000-000000000001'); -- regular (non-demo) owner
select is(pg_temp.exec($$insert into public.kb_documents (id, tenant_id, title) values ('7b000000-0000-4000-8000-000000000001','71111111-0000-4000-8000-00000000000a','doc')$$), 'OK:1', 'M3: non-demo tenants are not capped (document)');
select is(pg_temp.exec($$insert into public.kb_chunks (tenant_id, document_id, chunk_index, content)
  select '71111111-0000-4000-8000-00000000000a', '7b000000-0000-4000-8000-000000000001', g, 'x' from generate_series(1, 250) g$$),
  'OK:250', 'M3: non-demo tenants are not capped (chunks)');
select is(pg_temp.exec($$insert into public.memberships (user_id, tenant_id, role) values ('7a000000-0000-4000-8000-000000000004','71111111-0000-4000-8000-00000000000a','receptionist')$$),
  'OK:1', 'M3: non-demo owners can still manage memberships');
reset role;

-- ===================== L1. functions are private by default =====================
create function public.zz_probe() returns int language sql as 'select 1';
select is(has_function_privilege('anon', 'public.zz_probe()', 'execute'), false, 'L1: a new function is not executable by anon');
select is(has_function_privilege('authenticated', 'public.zz_probe()', 'execute'), false, 'L1: a new function is not executable by authenticated');
select is(has_function_privilege('service_role', 'public.zz_probe()', 'execute'), true, 'L1: a new function is executable by service_role');

-- ===================== L2. SECURITY DEFINER functions pin search_path = '' =====================
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prosecdef and not coalesce(p.proconfig @> array['search_path=""'], false)),
  0, 'L2: every public SECURITY DEFINER function has search_path = ''''');
select lives_ok($$select count(*) from public.match_kb_chunks('d0000000-0000-4000-8000-000000000001', array_fill(0.1::real, array[768])::extensions.vector, 3)$$,
  'L2: pgvector function still works');
-- gen_random_bytes path was exercised by issue_customer_magic_link (M1); bookings/slots by C1/H1/M2.

-- ===================== L3. authenticated has no truncate / trigger / references =====================
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace,
                  unnest(array['TRUNCATE','TRIGGER','REFERENCES']) priv
            where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('authenticated', c.oid, priv)),
  0, 'L3: authenticated has no TRUNCATE/TRIGGER/REFERENCES on any public table');

-- ===================== D. demo abuse protection (migration 11) =====================
select pg_temp.act('a0000000-0000-4000-8000-000000000001'); -- demo clinic owner
select pg_temp.lk(pg_temp.exec($$update public.tenants set name_en = 'Offensive' where id = 'd0000000-0000-4000-8000-000000000001'$$), 'ERR:42501:demo_readonly%', 'D1: demo owner cannot rename demo tenant (en)');
select pg_temp.lk(pg_temp.exec($$update public.tenants set name_ar = 'x' where id = 'd0000000-0000-4000-8000-000000000001'$$), 'ERR:42501:demo_readonly%', 'D1: demo owner cannot rename demo tenant (ar)');
select pg_temp.lk(pg_temp.exec($$update public.tenants set logo_url = 'http://evil/x.png' where id = 'd0000000-0000-4000-8000-000000000001'$$), 'ERR:42501:demo_readonly%', 'D1: demo owner cannot change logo');
select pg_temp.lk(pg_temp.exec($$update public.tenants set brand_color = '#000000' where id = 'd0000000-0000-4000-8000-000000000001'$$), 'ERR:42501:demo_readonly%', 'D1: demo owner cannot change brand colour');
select pg_temp.lk(pg_temp.exec($$update public.tenants set is_demo = false where id = 'd0000000-0000-4000-8000-000000000001'$$), 'ERR:42501:%', 'D1: demo owner cannot clear is_demo');
select is(pg_temp.exec($$update public.tenants set deposit_value = 60 where id = 'd0000000-0000-4000-8000-000000000001'$$), 'OK:1', 'D1: deposit settings stay editable on demo');
select is(pg_temp.exec($$update public.tenants set name_en = name_en where id = 'd0000000-0000-4000-8000-000000000001'$$), 'OK:1', 'D1: no-op write of presentation columns is allowed');
reset role;
select is((select name_en from public.tenants where id = 'd0000000-0000-4000-8000-000000000001'), 'Nabd Dental Clinic', 'D1: demo name unchanged');
select pg_temp.act('7a000000-0000-4000-8000-000000000001');
select is(pg_temp.exec($$update public.tenants set name_en = 'Renamed', brand_color = '#111111', logo_url = 'l' where id = '71111111-0000-4000-8000-00000000000a'$$), 'OK:1', 'D1: owner CAN change name/logo/colour on a non-demo tenant');
reset role;

-- caps (service_role is capped too; authenticated shares the same trigger)
select pg_temp.act_service();
select pg_temp.lk(pg_temp.exec($$insert into public.services (tenant_id, name_ar, name_en, duration_min, price) select 'd0000000-0000-4000-8000-000000000001','s','s',10,1 from generate_series(1,30) g$$), 'ERR:54000:demo_limit%', 'D2: services capped at 30');
select pg_temp.lk(pg_temp.exec($$insert into public.providers (tenant_id, name_ar, name_en) select 'd0000000-0000-4000-8000-000000000001','p','p' from generate_series(1,15) g$$), 'ERR:54000:demo_limit%', 'D2: providers capped at 15');
select pg_temp.lk(pg_temp.exec($$insert into public.working_hours (tenant_id, provider_id, weekday, start_time, end_time) select tenant_id, id, 1, '09:00','10:00' from public.providers p, generate_series(1,40) g where p.tenant_id = 'd0000000-0000-4000-8000-000000000001'$$), 'ERR:54000:demo_limit%', 'D2: working_hours capped at 100');
select pg_temp.lk(pg_temp.exec($$insert into public.time_off (tenant_id, provider_id, starts_at, ends_at) select tenant_id, id, now() + g * interval '1 day', now() + g * interval '1 day' + interval '1 hour' from public.providers p, generate_series(1,15) g where p.tenant_id = 'd0000000-0000-4000-8000-000000000001'$$), 'ERR:54000:demo_limit%', 'D2: time_off capped at 30');
select pg_temp.lk(pg_temp.exec($$insert into public.customers (tenant_id, full_name, phone) select 'd0000000-0000-4000-8000-000000000001','c','9' || g from generate_series(1,300) g$$), 'ERR:54000:demo_limit%', 'D2: customers capped at 300');
select pg_temp.lk(pg_temp.exec($$insert into public.appointments (tenant_id, provider_id, service_id, customer_id, starts_at, ends_at, status)
  select p.tenant_id, p.id, s.id, c.id, now() + interval '400 days' + g * interval '1 hour', now() + interval '400 days' + g * interval '1 hour' + interval '30 minutes', 'confirmed'
  from (select * from public.providers where tenant_id = 'd0000000-0000-4000-8000-000000000001' limit 1) p,
       (select * from public.services where tenant_id = 'd0000000-0000-4000-8000-000000000001' limit 1) s,
       (select * from public.customers where tenant_id = 'd0000000-0000-4000-8000-000000000001' limit 1) c, generate_series(1,200) g$$), 'ERR:54000:demo_limit%', 'D2: active future appointments capped at 150');
select is(pg_temp.exec($$insert into public.services (tenant_id, name_ar, name_en, duration_min, price) values ('d0000000-0000-4000-8000-000000000001','ok','ok',10,1)$$), 'OK:1', 'D2: a normal insert still works on demo');
select is(pg_temp.exec($$insert into public.services (tenant_id, name_ar, name_en, duration_min, price) select '71111111-0000-4000-8000-00000000000a','s','s',10,1 from generate_series(1,40) g$$), 'OK:40', 'D2: non-demo tenant services not capped');
-- length limits
select pg_temp.lk(pg_temp.exec($$insert into public.services (tenant_id, name_ar, name_en, duration_min, price) values ('71111111-0000-4000-8000-00000000000a', repeat('x',121),'s',10,1)$$), 'ERR:23514:%', 'D3: service name over 120 chars rejected');
select pg_temp.lk(pg_temp.exec($$insert into public.customers (tenant_id, full_name, phone) values ('71111111-0000-4000-8000-00000000000a', repeat('x',121),'0500000001')$$), 'ERR:23514:%', 'D3: customer name over 120 chars rejected');
select pg_temp.lk(pg_temp.exec($$update public.tenants set name_en = repeat('x',121) where id = '71111111-0000-4000-8000-00000000000a'$$), 'ERR:23514:%', 'D3: tenant name over 120 chars rejected');
select pg_temp.lk(pg_temp.exec($$insert into public.time_off (tenant_id, provider_id, starts_at, ends_at, reason) select tenant_id, id, now(), now() + interval '1 hour', repeat('x',201) from public.providers where tenant_id = 'd0000000-0000-4000-8000-000000000001' limit 1$$), 'ERR:23514:%', 'D3: time_off reason over 200 chars rejected');
reset role;

-- reset_demo restores everything
select pg_temp.act_service();
update public.tenants set name_en = 'Defaced' where id = 'd0000000-0000-4000-8000-000000000001';
select public.reset_demo();
reset role;
select is((select name_en from public.tenants where id = 'd0000000-0000-4000-8000-000000000001'), 'Nabd Dental Clinic', 'D4: reset_demo restores the demo tenant name');
select is((select count(*)::int from public.services where tenant_id = 'd0000000-0000-4000-8000-000000000001'), 6, 'D4: reset_demo restores seeded services');
select is((select count(*)::int from public.appointments where tenant_id = 'd0000000-0000-4000-8000-000000000001'), 100, 'D4: reset_demo restores seeded appointments (cap does not block seed)');

select * from finish();
rollback;
