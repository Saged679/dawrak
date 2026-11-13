-- pgTAP: second review round. Run: npx supabase test db
--   H1 least-privilege grants (payments + audit), M2 demo caps vs public bookings + cron,
--   L1 cancel_reason / settle_payment, provider advisory locks.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

create function pg_temp.at(p_days int, p_t time) returns timestamptz language sql as $$
  select (((now() at time zone 'Asia/Riyadh')::date + p_days + p_t) at time zone 'Asia/Riyadh')
$$;
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
insert into auth.users (id, aud, role, email) values
  ('9a000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'h-owner@test.local'),
  ('9a000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'h-rec@test.local'),
  ('9a000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'h-prov@test.local');
insert into public.tenants (id, slug, name_ar, name_en, kind, deposit_enabled, deposit_type, deposit_value) values
  ('91111111-0000-4000-8000-00000000000a', 'hard-a', 'س', 'Hard A', 'clinic', true, 'fixed', 50);
insert into public.memberships (user_id, tenant_id, role) values
  ('9a000000-0000-4000-8000-000000000001', '91111111-0000-4000-8000-00000000000a', 'owner'),
  ('9a000000-0000-4000-8000-000000000002', '91111111-0000-4000-8000-00000000000a', 'receptionist'),
  ('9a000000-0000-4000-8000-000000000003', '91111111-0000-4000-8000-00000000000a', 'provider');
insert into public.providers (id, tenant_id, user_id, name_ar, name_en) values
  ('92222222-0000-4000-8000-0000000000a1', '91111111-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000003', 'م1', 'P1'),
  ('92222222-0000-4000-8000-0000000000a2', '91111111-0000-4000-8000-00000000000a', null, 'م2', 'P2');
insert into public.services (id, tenant_id, name_ar, name_en, duration_min, buffer_min, price) values
  ('93333333-0000-4000-8000-0000000000a1', '91111111-0000-4000-8000-00000000000a', 'خ', 'Svc', 30, 0, 100);
insert into public.provider_services (tenant_id, provider_id, service_id) values
  ('91111111-0000-4000-8000-00000000000a', '92222222-0000-4000-8000-0000000000a1', '93333333-0000-4000-8000-0000000000a1'),
  ('91111111-0000-4000-8000-00000000000a', '92222222-0000-4000-8000-0000000000a2', '93333333-0000-4000-8000-0000000000a1');
insert into public.working_hours (tenant_id, provider_id, weekday, start_time, end_time)
select '91111111-0000-4000-8000-00000000000a', p, w, '06:00', '23:00'
from (values ('92222222-0000-4000-8000-0000000000a1'::uuid), ('92222222-0000-4000-8000-0000000000a2'::uuid)) v(p), generate_series(0, 6) w;
insert into public.customers (id, tenant_id, full_name, phone) values
  ('94444444-0000-4000-8000-0000000000c1', '91111111-0000-4000-8000-00000000000a', 'C1', '0555300001'),
  ('94444444-0000-4000-8000-0000000000c2', '91111111-0000-4000-8000-00000000000a', 'C2', '0555300002'),
  ('94444444-0000-4000-8000-0000000000c3', '91111111-0000-4000-8000-00000000000a', 'C3', '0555300003'),
  ('94444444-0000-4000-8000-0000000000c4', '91111111-0000-4000-8000-00000000000a', 'C4', '0555300004');
-- e1: lapsed hold (cron cancels it). e2: customer cancels. e3: staff cancels. e4: unlabelled direct cancel.
insert into public.appointments (id, tenant_id, provider_id, service_id, customer_id, starts_at, ends_at, status, price, payment_expires_at) values
  ('95555555-0000-4000-8000-0000000000e1', '91111111-0000-4000-8000-00000000000a', '92222222-0000-4000-8000-0000000000a1', '93333333-0000-4000-8000-0000000000a1', '94444444-0000-4000-8000-0000000000c1', pg_temp.at(2,'09:00'), pg_temp.at(2,'09:30'), 'pending_payment', 100, now() - interval '5 minutes'),
  ('95555555-0000-4000-8000-0000000000e2', '91111111-0000-4000-8000-00000000000a', '92222222-0000-4000-8000-0000000000a1', '93333333-0000-4000-8000-0000000000a1', '94444444-0000-4000-8000-0000000000c2', pg_temp.at(3,'09:00'), pg_temp.at(3,'09:30'), 'pending_payment', 100, now() + interval '10 minutes'),
  ('95555555-0000-4000-8000-0000000000e3', '91111111-0000-4000-8000-00000000000a', '92222222-0000-4000-8000-0000000000a1', '93333333-0000-4000-8000-0000000000a1', '94444444-0000-4000-8000-0000000000c3', pg_temp.at(4,'09:00'), pg_temp.at(4,'09:30'), 'pending_payment', 100, now() + interval '10 minutes'),
  ('95555555-0000-4000-8000-0000000000e4', '91111111-0000-4000-8000-00000000000a', '92222222-0000-4000-8000-0000000000a1', '93333333-0000-4000-8000-0000000000a1', '94444444-0000-4000-8000-0000000000c4', pg_temp.at(5,'09:00'), pg_temp.at(5,'09:30'), 'pending_payment', 100, now() + interval '10 minutes');
insert into public.payments (id, tenant_id, appointment_id, amount, currency, status, provider, provider_ref, public_token, checkout_url) values
  ('96666666-0000-4000-8000-0000000000e1', '91111111-0000-4000-8000-00000000000a', '95555555-0000-4000-8000-0000000000e1', 50, 'SAR', 'pending', 'moyasar', 'h-e1', repeat('1', 48), 'https://pay.example/e1'),
  ('96666666-0000-4000-8000-0000000000e2', '91111111-0000-4000-8000-00000000000a', '95555555-0000-4000-8000-0000000000e2', 50, 'SAR', 'pending', 'moyasar', 'h-e2', repeat('2', 48), 'https://pay.example/e2'),
  ('96666666-0000-4000-8000-0000000000e3', '91111111-0000-4000-8000-00000000000a', '95555555-0000-4000-8000-0000000000e3', 50, 'SAR', 'pending', 'moyasar', 'h-e3', repeat('3', 48), 'https://pay.example/e3'),
  ('96666666-0000-4000-8000-0000000000e4', '91111111-0000-4000-8000-00000000000a', '95555555-0000-4000-8000-0000000000e4', 50, 'SAR', 'pending', 'moyasar', 'h-e4', repeat('4', 48), 'https://pay.example/e4');

-- ===================== race: provider advisory locks =====================
-- (the real concurrent proof is scripts/race-test.mjs; here: each function takes the provider lock)
create function pg_temp.has_lock(p_provider uuid) returns boolean language sql as $$
  select exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
                   and ((classid::bigint << 32) | objid::bigint) = hashtextextended(p_provider::text, 0))
$$;
grant execute on function pg_temp.has_lock(uuid) to public;
select ok(not pg_temp.has_lock('92222222-0000-4000-8000-0000000000a2'), 'race: provider 2 lock not held yet');
select pg_temp.act_service();
select is(public.create_public_booking('91111111-0000-4000-8000-00000000000a', '92222222-0000-4000-8000-0000000000a2', '93333333-0000-4000-8000-0000000000a1', pg_temp.at(8,'10:00'), 'Lock Test', '0555300099') ->> 'status', 'pending_payment', 'race: public booking still works');
reset role;
select ok(pg_temp.has_lock('92222222-0000-4000-8000-0000000000a2'), 'race: create_public_booking holds the provider advisory lock');
select ok(not pg_temp.has_lock('92222222-0000-4000-8000-0000000000a1'), 'race: ... and only that provider');
select pg_temp.act_service();
select is(public.customer_reschedule_appointment((select access_token from public.customers where phone = '0555300099'),
  (select id from public.appointments where customer_id = (select id from public.customers where phone = '0555300099')), pg_temp.at(9,'10:00')) ->> 'status', 'pending_payment', 'race: reschedule still works');
reset role;
select pg_temp.act('9a000000-0000-4000-8000-000000000001');
select is(public.staff_update_appointment((select id from public.appointments where customer_id = (select id from public.customers where phone = '0555300099')),
  null, '92222222-0000-4000-8000-0000000000a1', null, null, null) ->> 'provider_id', '92222222-0000-4000-8000-0000000000a1', 'race: staff reassign to another provider works');
reset role;
select ok(pg_temp.has_lock('92222222-0000-4000-8000-0000000000a1'), 'race: staff_update_appointment locks the target provider');

-- ===================== H1: payments are read-only and column-limited =====================
select pg_temp.act('9a000000-0000-4000-8000-000000000001');   -- owner
select is(pg_temp.exec($$update public.payments set checkout_url = 'https://evil.example'$$), 'ERR:42501:permission denied for table payments', 'H1: owner cannot PATCH checkout_url');
select alike(pg_temp.exec($$update public.payments set amount = 1$$), 'ERR:42501:%', 'H1: owner cannot PATCH amount');
select alike(pg_temp.exec($$insert into public.payments (tenant_id, appointment_id, amount) values ('91111111-0000-4000-8000-00000000000a', '95555555-0000-4000-8000-0000000000e1', 1)$$), 'ERR:42501:%', 'H1: owner cannot INSERT payments');
select alike(pg_temp.exec($$delete from public.payments$$), 'ERR:42501:%', 'H1: owner cannot DELETE payments');
select alike(pg_temp.exec($$select public_token from public.payments$$), 'ERR:42501:%', 'H1: owner cannot read public_token');
select alike(pg_temp.exec($$select checkout_url from public.payments$$), 'ERR:42501:%', 'H1: owner cannot read checkout_url');
select alike(pg_temp.exec($$select * from public.payments$$), 'ERR:42501:%', 'H1: select * is refused (explicit columns only)');
select is((select count(*)::int from public.payments), 4, 'H1: owner still reads own payment rows');
select is((select sum(amount)::int from public.payments where status = 'pending'), 200, 'H1: dashboard revenue columns (amount, status, created_at, tenant_id) still work');
select is(pg_temp.exec($$select id, tenant_id, appointment_id, amount, currency, status, provider, provider_ref, review_reason, paid_at, created_at from public.payments$$), 'OK:4', 'H1: the 11 granted columns are readable');
reset role;
select pg_temp.act('9a000000-0000-4000-8000-000000000002');   -- receptionist
select is((select count(*)::int from public.payments), 0, 'H1: receptionist reads no payments');
reset role;
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'payments' and cmd <> 'SELECT'), 0, 'H1: payments has no write policy left');
select ok(not has_column_privilege('authenticated', 'public.payments', 'public_token', 'select'), 'H1: authenticated has no select on payments.public_token');
select ok(not has_column_privilege('authenticated', 'public.payments', 'checkout_url', 'select'), 'H1: authenticated has no select on payments.checkout_url');
select ok(not has_column_privilege('authenticated', 'public.payments', 'amount', 'update'), 'H1: authenticated has no update on payments.amount');
select pg_temp.act_service();
select is(pg_temp.exec($$update public.payments set checkout_url = checkout_url where id = '96666666-0000-4000-8000-0000000000e1'$$), 'OK:1', 'H1: service_role (payments store) can still write payments');
select is(pg_temp.val($$select public_token from public.payments where id = '96666666-0000-4000-8000-0000000000e1'$$), repeat('1', 48), 'H1: service_role can still read public_token');
reset role;

-- ===================== H1 audit: other tables =====================
select pg_temp.act('9a000000-0000-4000-8000-000000000002');   -- receptionist: reads, no catalogue writes
select alike(pg_temp.exec($$insert into public.services (tenant_id, name_ar, name_en, duration_min, price) values ('91111111-0000-4000-8000-00000000000a', 'a', 'a', 10, 1)$$), 'ERR:42501:%', 'audit: receptionist cannot create services');
select is(pg_temp.exec($$update public.services set price = 1$$), 'OK:0', 'audit: receptionist cannot change service prices');
select is(pg_temp.exec($$delete from public.working_hours$$), 'OK:0', 'audit: receptionist cannot delete working hours');
select is(pg_temp.exec($$update public.providers set name_en = 'x'$$), 'OK:0', 'audit: receptionist cannot edit providers');
select cmp_ok((select count(*)::int from public.services), '>', 0, 'audit: receptionist still reads services');
reset role;
select pg_temp.act('9a000000-0000-4000-8000-000000000003');   -- provider
select is(pg_temp.exec($$delete from public.working_hours$$), 'OK:0', 'audit: a provider-role user cannot change working hours (owner only)');
select is(pg_temp.exec($$insert into public.time_off (tenant_id, provider_id, starts_at, ends_at) values ('91111111-0000-4000-8000-00000000000a', '92222222-0000-4000-8000-0000000000a1', now(), now() + interval '1 hour')$$) like 'ERR:42501:%', true, 'audit: a provider-role user cannot add time off');
reset role;
select pg_temp.act('9a000000-0000-4000-8000-000000000001');   -- owner: keeps what the dashboard does
select is(pg_temp.exec($$insert into public.services (tenant_id, name_ar, name_en, duration_min, buffer_min, price) values ('91111111-0000-4000-8000-00000000000a', 'جديد', 'New', 20, 0, 5)$$), 'OK:1', 'audit: owner creates a service');
select is(pg_temp.exec($$update public.services set price = 6, is_active = true where name_en = 'New'$$), 'OK:1', 'audit: owner edits a service');
select alike(pg_temp.exec($$delete from public.services where name_en = 'New'$$), 'ERR:42501:%', 'audit: owner cannot hard-delete services (deactivate instead)');
select is(pg_temp.exec($$update public.providers set name_en = 'P1b', is_active = true where id = '92222222-0000-4000-8000-0000000000a1'$$), 'OK:1', 'audit: owner edits a provider');
select alike(pg_temp.exec($$update public.providers set user_id = '9a000000-0000-4000-8000-000000000001' where id = '92222222-0000-4000-8000-0000000000a2'$$), 'ERR:42501:%', 'audit: owner cannot relink providers.user_id');
select alike(pg_temp.exec($$delete from public.providers where id = '92222222-0000-4000-8000-0000000000a2'$$), 'ERR:42501:%', 'audit: owner cannot hard-delete providers');
select is(pg_temp.exec($$insert into public.time_off (tenant_id, provider_id, starts_at, ends_at) values ('91111111-0000-4000-8000-00000000000a', '92222222-0000-4000-8000-0000000000a1', now() + interval '30 days', now() + interval '31 days')$$), 'OK:1', 'audit: owner adds time off');
select is(pg_temp.exec($$delete from public.time_off$$), 'OK:1', 'audit: owner deletes time off');
select is(pg_temp.exec($$delete from public.working_hours where provider_id = '92222222-0000-4000-8000-0000000000a2'$$), 'OK:7', 'audit: owner replaces working hours (delete)');
select is(pg_temp.exec($$insert into public.working_hours (tenant_id, provider_id, weekday, start_time, end_time) values ('91111111-0000-4000-8000-00000000000a', '92222222-0000-4000-8000-0000000000a2', 1, '09:00', '17:00')$$), 'OK:1', 'audit: owner replaces working hours (insert)');
select alike(pg_temp.exec($$update public.working_hours set weekday = 2$$), 'ERR:42501:%', 'audit: working_hours are replaced, never updated in place');
select is(pg_temp.exec($$insert into public.provider_services (tenant_id, provider_id, service_id) select tenant_id, '92222222-0000-4000-8000-0000000000a2', id from public.services where name_en = 'New'$$), 'OK:1', 'audit: owner links a service to a provider');
select alike(pg_temp.exec($$insert into public.kb_documents (tenant_id, title) values ('91111111-0000-4000-8000-00000000000a', 'doc')$$), 'OK:1', 'audit: owner adds a KB document');
select is(pg_temp.exec($$delete from public.kb_documents where title = 'doc'$$), 'OK:1', 'audit: owner deletes a KB document');
select alike(pg_temp.exec($$update public.kb_documents set title = 'x'$$), 'ERR:42501:%', 'audit: kb_documents are not edited in place');
select alike(pg_temp.exec($$insert into public.conversations (tenant_id) values ('91111111-0000-4000-8000-00000000000a')$$), 'ERR:42501:%', 'audit: staff cannot write conversations');
select alike(pg_temp.exec($$insert into public.messages (tenant_id, conversation_id, role) values ('91111111-0000-4000-8000-00000000000a', gen_random_uuid(), 'user')$$), 'ERR:42501:%', 'audit: staff cannot write messages');
select alike(pg_temp.exec($$update public.reminders set status = 'sent'$$), 'ERR:42501:%', 'audit: staff cannot write reminders');
select alike(pg_temp.exec($$select * from public.rate_limits$$), 'ERR:42501:%', 'audit: staff cannot touch rate_limits');
select alike(pg_temp.exec($$insert into public.appointments (tenant_id, provider_id, service_id, customer_id, starts_at, ends_at) values ('91111111-0000-4000-8000-00000000000a', '92222222-0000-4000-8000-0000000000a1', '93333333-0000-4000-8000-0000000000a1', '94444444-0000-4000-8000-0000000000c1', pg_temp.at(20,'10:00'), pg_temp.at(20,'10:30'))$$), 'ERR:42501:%', 'audit: staff cannot insert appointments directly (no slot/hours validation)');
reset role;
select is((select count(*)::int from unnest(array['anon','authenticated']) r, unnest(array['payment_events','rate_limits']) t
            where has_table_privilege(r, 'public.' || t, 'select')), 0, 'audit: payment_events / rate_limits are not readable by anon or authenticated');

-- ===================== L1: cancel_reason and settle_payment =====================
select pg_temp.act_service();
select lives_ok($$select public.expire_pending_bookings()$$, 'L1: cron runs');
reset role;
select is((select cancel_reason from public.appointments where id = '95555555-0000-4000-8000-0000000000e1'), 'payment_expired', 'L1: expire_pending_bookings records payment_expired');
select pg_temp.act_service();
select is(public.settle_payment('96666666-0000-4000-8000-0000000000e1', 'moyasar', 'h-ev1', 'paid', 'paid', 'pp1', 5000, 'SAR'), 'confirmed_after_expiry', 'L1: a lapsed hold with a free slot is still revived');
reset role;
select is((select status || '|' || coalesce(cancel_reason, 'null') from public.appointments where id = '95555555-0000-4000-8000-0000000000e1'), 'confirmed|null', 'L1: revival clears cancel_reason');

-- customer cancels
select pg_temp.act_service();
select is(public.customer_cancel_appointment((select access_token from public.customers where id = '94444444-0000-4000-8000-0000000000c2'), '95555555-0000-4000-8000-0000000000e2'), true, 'L1: customer cancels');
reset role;
select is((select cancel_reason from public.appointments where id = '95555555-0000-4000-8000-0000000000e2'), 'customer', 'L1: customer cancel records customer');
select pg_temp.act_service();
select is(public.settle_payment('96666666-0000-4000-8000-0000000000e2', 'moyasar', 'h-ev2', 'paid', 'paid', 'pp2', 5000, 'SAR'), 'refund_due', 'L1: payment after a customer cancel is refund_due, not revived');
reset role;
select is((select status from public.appointments where id = '95555555-0000-4000-8000-0000000000e2'), 'cancelled', 'L1: the customer-cancelled appointment stays cancelled');
select is((select status || '|' || review_reason from public.payments where id = '96666666-0000-4000-8000-0000000000e2'), 'refund_due|appointment_cancelled', 'L1: payment flagged refund_due / appointment_cancelled');

-- staff cancels
select pg_temp.act('9a000000-0000-4000-8000-000000000002');
select is(public.staff_update_appointment('95555555-0000-4000-8000-0000000000e3', null, null, null, 'cancelled', null) ->> 'status', 'cancelled', 'L1: staff cancels through staff_update_appointment');
reset role;
select is((select cancel_reason from public.appointments where id = '95555555-0000-4000-8000-0000000000e3'), 'staff', 'L1: staff cancel records staff');
select pg_temp.act_service();
select is(public.settle_payment('96666666-0000-4000-8000-0000000000e3', 'moyasar', 'h-ev3', 'paid', 'paid', 'pp3', 5000, 'SAR'), 'refund_due', 'L1: payment after a staff cancel is refund_due, not revived');
reset role;
select is((select status from public.appointments where id = '95555555-0000-4000-8000-0000000000e3'), 'cancelled', 'L1: the staff-cancelled appointment stays cancelled');

-- an unlabelled cancel (direct status update) is never treated as a lapsed hold
update public.appointments set status = 'cancelled' where id = '95555555-0000-4000-8000-0000000000e4';
select is((select cancel_reason from public.appointments where id = '95555555-0000-4000-8000-0000000000e4'), 'staff', 'L1: any other cancel path defaults to staff');
select pg_temp.act_service();
select is(public.settle_payment('96666666-0000-4000-8000-0000000000e4', 'moyasar', 'h-ev4', 'paid', 'paid', 'pp4', 5000, 'SAR'), 'refund_due', 'L1: unlabelled cancel is not revived either');
reset role;
-- reinstating by staff clears the reason
select pg_temp.act('9a000000-0000-4000-8000-000000000001');
select is(public.staff_update_appointment('95555555-0000-4000-8000-0000000000e3', null, null, null, 'confirmed', null) ->> 'status', 'confirmed', 'L1: staff can reinstate a cancelled appointment');
reset role;
select is((select cancel_reason from public.appointments where id = '95555555-0000-4000-8000-0000000000e3'), null, 'L1: reinstating clears cancel_reason');

-- ===================== M2: demo caps apply to public bookings =====================
-- 150-active-future-appointment / 300-customer caps (unchanged). Public bookings run as postgres inside a
-- SECURITY DEFINER function, which used to be exempt.
create function pg_temp.fill_demo() returns text language plpgsql as $$
declare
  s record; i int := 0; ok int := 0; err text := 'none';
begin
  for s in select * from public.get_available_slots('d0000000-0000-4000-8000-000000000001', null,
              'e1000000-0000-4000-8000-000000000001', current_date + 1, current_date + 60, 30) limit 700 loop
    i := i + 1;
    begin
      perform public.create_public_booking('d0000000-0000-4000-8000-000000000001', s.slot_provider_id,
        'e1000000-0000-4000-8000-000000000001', s.slot_start, 'Public ' || i, '0599' || lpad(i::text, 6, '0'));
      ok := ok + 1;
    exception when others then
      if sqlstate = '54000' then err := sqlerrm; exit; end if;
    end;
  end loop;
  return ok || '|' || err;
end $$;
grant execute on function pg_temp.fill_demo() to public;

select pg_temp.act_service();
select alike(pg_temp.val($$select pg_temp.fill_demo()$$), '%|demo_limit', 'M2: public bookings on the demo clinic hit demo_limit');
reset role;
select cmp_ok((select count(*)::int from public.appointments where tenant_id = 'd0000000-0000-4000-8000-000000000001'
                 and starts_at > now() and status in ('pending_payment','confirmed')), '<=', 150, 'M2: active future demo appointments never exceed 150');
select cmp_ok((select count(*)::int from public.customers where tenant_id = 'd0000000-0000-4000-8000-000000000001'), '<=', 300, 'M2: demo customers never exceed 300');
select alike(pg_temp.exec($$insert into public.services (tenant_id, name_ar, name_en, duration_min, price) select 'd0000000-0000-4000-8000-000000000001','s','s',10,1 from generate_series(1,40) g$$),
  'ERR:54000:%', 'M2: a plain postgres-role insert into a demo tenant is capped too (no role exemption)');
select pg_temp.act_service();
select is(pg_temp.exec($$select public.reset_demo()$$), 'OK:1', 'M2: reset_demo still works with the caps in force');
reset role;
select is((select count(*)::int from public.services where tenant_id = 'd0000000-0000-4000-8000-000000000001'), 6, 'M2: reset_demo restored the seeded services');
select cmp_ok((select count(*)::int from public.appointments where tenant_id = 'd0000000-0000-4000-8000-000000000001'), '>', 50, 'M2: reset_demo restored the seeded appointments (seed not blocked by caps)');
select is(current_setting('dawrak.seeding', true), 'off', 'M2: the seeding flag is lowered again after the reset');
select ok((select count(*) from pg_extension where extname = 'pg_cron') = 0
          or exists (select 1 from cron.job where jobname = 'dawrak_reset_demo' and schedule = '0 3 * * *'),
          'M2: pg_cron job dawrak_reset_demo is scheduled daily at 03:00 UTC');

select * from finish();
rollback;
