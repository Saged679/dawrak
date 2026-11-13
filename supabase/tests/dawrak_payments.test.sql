-- pgTAP: payments (settle_payment, public token, grants). Run: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

create function pg_temp.at(p_days int, p_t time) returns timestamptz language sql as $$
  select (((now() at time zone 'Asia/Riyadh')::date + p_days + p_t) at time zone 'Asia/Riyadh')
$$;
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
create function pg_temp.q(p_sql text) returns text language plpgsql as $$
declare r text;
begin
  execute p_sql into r;
  return coalesce(r, 'NULL');
exception when others then return 'ERR:' || sqlstate || ':' || sqlerrm;
end $$;
grant execute on all functions in schema pg_temp to public;

-- ---------- fixtures ----------
insert into public.tenants (id, slug, name_ar, name_en, kind, deposit_enabled, deposit_type, deposit_value) values
  ('81111111-0000-4000-8000-00000000000a', 'pay-x', 'س', 'Pay X', 'clinic', true, 'fixed', 50);
insert into public.providers (id, tenant_id, name_ar, name_en) values
  ('82222222-0000-4000-8000-0000000000a1', '81111111-0000-4000-8000-00000000000a', 'م1', 'P1');
insert into public.services (id, tenant_id, name_ar, name_en, duration_min, buffer_min, price) values
  ('83333333-0000-4000-8000-0000000000a1', '81111111-0000-4000-8000-00000000000a', 'خ', 'Svc', 60, 0, 100);
insert into public.customers (id, tenant_id, full_name, phone) values
  ('84444444-0000-4000-8000-0000000000c1', '81111111-0000-4000-8000-00000000000a', 'C1', '0555100001'),
  ('84444444-0000-4000-8000-0000000000c2', '81111111-0000-4000-8000-00000000000a', 'C2', '0555100002');

-- a1: live hold, a2: expired hold the cron already cancelled (slot still free),
-- a3: expired+cancelled whose slot was re-booked by a4 (confirmed, same provider/time)
insert into public.appointments (id, tenant_id, provider_id, service_id, customer_id, starts_at, ends_at, status, price, payment_expires_at) values
  ('85555555-0000-4000-8000-0000000000a1', '81111111-0000-4000-8000-00000000000a', '82222222-0000-4000-8000-0000000000a1', '83333333-0000-4000-8000-0000000000a1', '84444444-0000-4000-8000-0000000000c1', pg_temp.at(2,'09:00'), pg_temp.at(2,'10:00'), 'pending_payment', 100, now() + interval '10 minutes'),
  ('85555555-0000-4000-8000-0000000000a2', '81111111-0000-4000-8000-00000000000a', '82222222-0000-4000-8000-0000000000a1', '83333333-0000-4000-8000-0000000000a1', '84444444-0000-4000-8000-0000000000c1', pg_temp.at(3,'09:00'), pg_temp.at(3,'10:00'), 'cancelled', 100, now() - interval '5 minutes'),
  ('85555555-0000-4000-8000-0000000000a3', '81111111-0000-4000-8000-00000000000a', '82222222-0000-4000-8000-0000000000a1', '83333333-0000-4000-8000-0000000000a1', '84444444-0000-4000-8000-0000000000c1', pg_temp.at(4,'09:00'), pg_temp.at(4,'10:00'), 'cancelled', 100, now() - interval '5 minutes'),
  ('85555555-0000-4000-8000-0000000000a4', '81111111-0000-4000-8000-00000000000a', '82222222-0000-4000-8000-0000000000a1', '83333333-0000-4000-8000-0000000000a1', '84444444-0000-4000-8000-0000000000c2', pg_temp.at(4,'09:00'), pg_temp.at(4,'10:00'), 'confirmed', 100, null),
  ('85555555-0000-4000-8000-0000000000a5', '81111111-0000-4000-8000-00000000000a', '82222222-0000-4000-8000-0000000000a1', '83333333-0000-4000-8000-0000000000a1', '84444444-0000-4000-8000-0000000000c2', pg_temp.at(5,'09:00'), pg_temp.at(5,'10:00'), 'pending_payment', 100, now() + interval '10 minutes'),
  ('85555555-0000-4000-8000-0000000000a6', '81111111-0000-4000-8000-00000000000a', '82222222-0000-4000-8000-0000000000a1', '83333333-0000-4000-8000-0000000000a1', '84444444-0000-4000-8000-0000000000c2', pg_temp.at(6,'09:00'), pg_temp.at(6,'10:00'), 'pending_payment', 100, now() + interval '10 minutes');
insert into public.payments (id, tenant_id, appointment_id, amount, currency, status, provider, provider_ref, public_token) values
  ('86666666-0000-4000-8000-0000000000a1', '81111111-0000-4000-8000-00000000000a', '85555555-0000-4000-8000-0000000000a1', 50, 'SAR', 'pending', 'moyasar', 'inv-a1', repeat('a', 48)),
  ('86666666-0000-4000-8000-0000000000a2', '81111111-0000-4000-8000-00000000000a', '85555555-0000-4000-8000-0000000000a2', 50, 'SAR', 'pending', 'moyasar', 'inv-a2', repeat('b', 48)),
  ('86666666-0000-4000-8000-0000000000a3', '81111111-0000-4000-8000-00000000000a', '85555555-0000-4000-8000-0000000000a3', 50, 'SAR', 'pending', 'moyasar', 'inv-a3', repeat('c', 48)),
  ('86666666-0000-4000-8000-0000000000a5', '81111111-0000-4000-8000-00000000000a', '85555555-0000-4000-8000-0000000000a5', 50, 'SAR', 'pending', 'moyasar', 'inv-a5', repeat('d', 48)),
  ('86666666-0000-4000-8000-0000000000a6', '81111111-0000-4000-8000-00000000000a', '85555555-0000-4000-8000-0000000000a6', 50, 'SAR', 'pending', 'moyasar', 'inv-a6', repeat('e', 48));

-- a2 and a3 were cancelled by expire_pending_bookings(); since L1 that reason is what allows a revival
update public.appointments set cancel_reason = 'payment_expired'
 where id in ('85555555-0000-4000-8000-0000000000a2', '85555555-0000-4000-8000-0000000000a3');

-- ===================== grants =====================
select is((select count(*)::int from unnest(array['anon','authenticated']) r
            where has_function_privilege(r, 'public.settle_payment(uuid,text,text,text,text,text,bigint,text)', 'execute')),
  0, 'settle_payment is not executable by anon or authenticated');
select ok(has_function_privilege('service_role', 'public.settle_payment(uuid,text,text,text,text,text,bigint,text)', 'execute'),
  'settle_payment is executable by service_role');
select is((select count(*)::int from unnest(array['anon','authenticated']) r
            where has_table_privilege(r, 'public.payment_events', 'select')),
  0, 'payment_events is not readable by anon or authenticated');

-- ===================== public token =====================
select throws_ok($$insert into public.payments (tenant_id, appointment_id, amount, public_token) values ('81111111-0000-4000-8000-00000000000a', '85555555-0000-4000-8000-0000000000a1', 1, 'short')$$,
  '23514', null, 'a short (guessable) public token is refused');
select throws_ok($$insert into public.payments (tenant_id, appointment_id, amount, public_token) values ('81111111-0000-4000-8000-00000000000a', '85555555-0000-4000-8000-0000000000a1', 1, repeat('a', 48))$$,
  '23505', null, 'public tokens are unique');

-- ===================== success inside the hold =====================
select pg_temp.act_service();
select is(public.settle_payment('86666666-0000-4000-8000-0000000000a1', 'moyasar', 'evt-1', 'payment_paid', 'paid', 'pay-1', 5000, 'SAR'),
  'confirmed', 'paid inside the hold confirms');
select is((select status from public.appointments where id = '85555555-0000-4000-8000-0000000000a1'), 'confirmed', 'appointment is confirmed');
select is((select status || '|' || (provider_payment_id) from public.payments where id = '86666666-0000-4000-8000-0000000000a1'), 'paid|pay-1', 'payment is paid with the provider id');
select is((select payment_expires_at from public.appointments where id = '85555555-0000-4000-8000-0000000000a1'), null, 'the hold deadline is cleared');

-- replay and duplicate delivery
select is(public.settle_payment('86666666-0000-4000-8000-0000000000a1', 'moyasar', 'evt-1', 'payment_paid', 'paid', 'pay-1', 5000, 'SAR'),
  'duplicate', 'the same event id twice is a no-op');
select is(public.settle_payment('86666666-0000-4000-8000-0000000000a1', 'moyasar', 'evt-1b', 'payment_paid', 'paid', 'pay-1', 5000, 'SAR'),
  'already_paid', 'a second event for an already paid payment is a no-op');
select is((select count(*)::int from public.payment_events where payment_id = '86666666-0000-4000-8000-0000000000a1'), 2, 'both events recorded once each');

-- ===================== hold expired, slot still free: confirm after expiry =====================
select is(public.settle_payment('86666666-0000-4000-8000-0000000000a2', 'moyasar', 'evt-2', 'payment_paid', 'paid', 'pay-2', 5000, 'SAR'),
  'confirmed_after_expiry', 'paid after the hold expired, slot still free: booking is reinstated');
select is((select status from public.appointments where id = '85555555-0000-4000-8000-0000000000a2'), 'confirmed', 'the reinstated appointment is confirmed');

-- ===================== race: hold expired and the slot was re-booked =====================
select is(public.settle_payment('86666666-0000-4000-8000-0000000000a3', 'moyasar', 'evt-3', 'payment_paid', 'paid', 'pay-3', 5000, 'SAR'),
  'refund_due', 'paid after the slot was re-booked: refund_due, no double booking');
select is((select status from public.appointments where id = '85555555-0000-4000-8000-0000000000a3'), 'cancelled', 'the old appointment stays cancelled');
select is((select status || '|' || review_reason from public.payments where id = '86666666-0000-4000-8000-0000000000a3'), 'refund_due|slot_unavailable_after_payment', 'payment is flagged for refund / review');
select is((select count(*)::int from public.appointments where provider_id = '82222222-0000-4000-8000-0000000000a1' and starts_at = pg_temp.at(4,'09:00') and status in ('confirmed','pending_payment')), 1, 'exactly one live appointment holds that slot');

-- ===================== amount / currency mismatch never confirms =====================
select is(public.settle_payment('86666666-0000-4000-8000-0000000000a5', 'moyasar', 'evt-5', 'payment_paid', 'paid', 'pay-5', 100, 'SAR'),
  'amount_mismatch', 'wrong amount is not confirmed');
select is((select status from public.appointments where id = '85555555-0000-4000-8000-0000000000a5'), 'pending_payment', 'appointment untouched on amount mismatch');
select is((select status from public.payments where id = '86666666-0000-4000-8000-0000000000a5'), 'refund_due', 'mismatching payment goes to manual review');
select is(public.settle_payment('86666666-0000-4000-8000-0000000000a6', 'moyasar', 'evt-6', 'payment_paid', 'paid', 'pay-6', 5000, 'USD'),
  'amount_mismatch', 'wrong currency is not confirmed');

-- ===================== failure keeps the hold =====================
reset role;
update public.payments set status = 'pending', review_reason = null where id = '86666666-0000-4000-8000-0000000000a6';
select pg_temp.act_service();
select is(public.settle_payment('86666666-0000-4000-8000-0000000000a6', 'moyasar', 'evt-7', 'payment_failed', 'failed', 'pay-7', 5000, 'SAR'),
  'failed', 'a failed attempt is recorded');
select is((select status from public.appointments where id = '85555555-0000-4000-8000-0000000000a6'), 'pending_payment', 'the hold stays until it expires');
select is(public.settle_payment('86666666-0000-4000-8000-0000000000a6', 'moyasar', 'evt-8', 'payment_paid', 'paid', 'pay-8', 5000, 'SAR'),
  'confirmed', 'a successful retry after a failure confirms');

-- ===================== misc =====================
select is(public.settle_payment('86666666-0000-4000-8000-00000000ffff', 'moyasar', 'evt-9', 'payment_paid', 'paid', 'pay-9', 5000, 'SAR'),
  'not_found', 'unknown payment id');
select matches(pg_temp.q($$select public.settle_payment('86666666-0000-4000-8000-0000000000a1', 'moyasar', 'evt-10', 'x', 'bogus', 'p', 1, 'SAR')$$),
  'invalid_outcome', 'invalid outcome is rejected');

reset role; select pg_temp.act_anon();
select matches(pg_temp.q($$select public.settle_payment('86666666-0000-4000-8000-0000000000a1', 'moyasar', 'evt-11', 'payment_paid', 'paid', 'p', 5000, 'SAR')$$),
  '^ERR:42501', 'anon cannot call settle_payment');

reset role;
select * from finish();
rollback;
