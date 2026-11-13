-- pgTAP: reminder lifecycle, claim/complete, demo outbox, patient-page lookups, grants.
-- Run: npx supabase test db
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
insert into auth.users (id, aud, role, email) values
  ('ba000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'r-owner@test.local'),
  ('ba000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'r-rec@test.local'),
  ('ba000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'r-prov@test.local');
insert into public.tenants (id, slug, name_ar, name_en, kind, deposit_enabled, deposit_type, deposit_value, is_demo) values
  ('b1111111-0000-4000-8000-00000000000a', 'rem-a',    'س', 'Rem A',    'clinic', true,  'fixed', 50, false),
  ('b1111111-0000-4000-8000-00000000000b', 'rem-demo', 'س', 'Rem Demo', 'clinic', false, 'fixed', 0,  true);
insert into public.memberships (user_id, tenant_id, role) values
  ('ba000000-0000-4000-8000-000000000001', 'b1111111-0000-4000-8000-00000000000a', 'owner'),
  ('ba000000-0000-4000-8000-000000000002', 'b1111111-0000-4000-8000-00000000000a', 'receptionist'),
  ('ba000000-0000-4000-8000-000000000003', 'b1111111-0000-4000-8000-00000000000a', 'provider');
insert into public.providers (id, tenant_id, user_id, name_ar, name_en) values
  ('b2222222-0000-4000-8000-0000000000a1', 'b1111111-0000-4000-8000-00000000000a', 'ba000000-0000-4000-8000-000000000003', 'م1', 'P1'),
  ('b2222222-0000-4000-8000-0000000000b1', 'b1111111-0000-4000-8000-00000000000b', null, 'م1', 'PD');
insert into public.services (id, tenant_id, name_ar, name_en, duration_min, buffer_min, price) values
  ('b3333333-0000-4000-8000-0000000000a1', 'b1111111-0000-4000-8000-00000000000a', 'خ', 'Svc', 30, 0, 100),
  ('b3333333-0000-4000-8000-0000000000b1', 'b1111111-0000-4000-8000-00000000000b', 'خ', 'SvcD', 30, 0, 100);
insert into public.provider_services (tenant_id, provider_id, service_id) values
  ('b1111111-0000-4000-8000-00000000000a', 'b2222222-0000-4000-8000-0000000000a1', 'b3333333-0000-4000-8000-0000000000a1'),
  ('b1111111-0000-4000-8000-00000000000b', 'b2222222-0000-4000-8000-0000000000b1', 'b3333333-0000-4000-8000-0000000000b1');
insert into public.working_hours (tenant_id, provider_id, weekday, start_time, end_time)
select 'b1111111-0000-4000-8000-00000000000a', 'b2222222-0000-4000-8000-0000000000a1', w, '00:00', '23:59' from generate_series(0, 6) w;
insert into public.customers (id, tenant_id, full_name, phone, email, access_token) values
  ('b4444444-0000-4000-8000-0000000000c1', 'b1111111-0000-4000-8000-00000000000a', 'C1', '+966500000071', 'c1@example.com', repeat('a', 48)),
  ('b4444444-0000-4000-8000-0000000000c2', 'b1111111-0000-4000-8000-00000000000b', 'C2', '+966500000072', null, repeat('b', 48));
insert into public.customers (id, tenant_id, full_name, phone, access_token, access_token_expires_at) values
  ('b4444444-0000-4000-8000-0000000000c4', 'b1111111-0000-4000-8000-00000000000a', 'C4', '+966500000074', repeat('d', 48), now() + interval '30 days'),
  ('b4444444-0000-4000-8000-0000000000c3', 'b1111111-0000-4000-8000-00000000000a', 'Expired', '+966500000073', repeat('c', 48), now() - interval '1 day');

-- ===================== lifecycle =====================
-- r1: confirmed in 3 days -> both reminders; r2: in 5 h -> only 2h; r3: in 1 h -> none; r4: pending_payment -> none
insert into public.appointments (id, tenant_id, provider_id, service_id, customer_id, starts_at, ends_at, status, price, payment_expires_at) values
  ('b5555555-0000-4000-8000-0000000000a1', 'b1111111-0000-4000-8000-00000000000a', 'b2222222-0000-4000-8000-0000000000a1', 'b3333333-0000-4000-8000-0000000000a1', 'b4444444-0000-4000-8000-0000000000c1', now() + interval '3 days', now() + interval '3 days 30 minutes', 'confirmed', 100, null),
  ('b5555555-0000-4000-8000-0000000000a2', 'b1111111-0000-4000-8000-00000000000a', 'b2222222-0000-4000-8000-0000000000a1', 'b3333333-0000-4000-8000-0000000000a1', 'b4444444-0000-4000-8000-0000000000c1', now() + interval '5 hours', now() + interval '5 hours 30 minutes', 'confirmed', 100, null),
  ('b5555555-0000-4000-8000-0000000000a3', 'b1111111-0000-4000-8000-00000000000a', 'b2222222-0000-4000-8000-0000000000a1', 'b3333333-0000-4000-8000-0000000000a1', 'b4444444-0000-4000-8000-0000000000c4', now() + interval '1 hour', now() + interval '90 minutes', 'confirmed', 100, null),
  ('b5555555-0000-4000-8000-0000000000a4', 'b1111111-0000-4000-8000-00000000000a', 'b2222222-0000-4000-8000-0000000000a1', 'b3333333-0000-4000-8000-0000000000a1', 'b4444444-0000-4000-8000-0000000000c1', now() + interval '4 days', now() + interval '4 days 30 minutes', 'pending_payment', 100, now() + interval '10 minutes');

select is((select count(*)::int from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a1' and status = 'pending'), 2, 'confirmed in 3 days: 24h and 2h reminders');
select ok((select send_at from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a1' and kind = '24h')
          = (select starts_at - interval '24 hours' from public.appointments where id = 'b5555555-0000-4000-8000-0000000000a1'), '24h reminder is 24h before the start');
select ok((select send_at from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a1' and kind = '2h')
          = (select starts_at - interval '2 hours' from public.appointments where id = 'b5555555-0000-4000-8000-0000000000a1'), '2h reminder is 2h before the start');
select is((select array_agg(kind) from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a2'), array['2h'], 'starting in 5h: the 24h slot is in the past and skipped, only 2h exists');
select is((select count(*)::int from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a3'), 0, 'starting in 1h: no reminder rows at all');
select is((select count(*)::int from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a4'), 0, 'pending_payment: no reminders yet');

-- settle_payment confirms -> reminders appear
insert into public.payments (id, tenant_id, appointment_id, amount, currency, status, provider, provider_ref, public_token) values
  ('b6666666-0000-4000-8000-0000000000a4', 'b1111111-0000-4000-8000-00000000000a', 'b5555555-0000-4000-8000-0000000000a4', 50, 'SAR', 'pending', 'moyasar', 'inv-rem-a4', repeat('r', 48));
select pg_temp.act_service();
select is(public.settle_payment('b6666666-0000-4000-8000-0000000000a4', 'moyasar', 'evt-rem-1', 'payment_paid', 'paid', 'pid-1', 5000, 'SAR'), 'confirmed', 'settle_payment confirms');
reset role;
select is((select count(*)::int from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a4' and status = 'pending'), 2, 'settle_payment path created both reminders');

-- customer reschedule moves them
select pg_temp.act_service();
select is((public.customer_reschedule_appointment(repeat('a', 48), 'b5555555-0000-4000-8000-0000000000a1', now() + interval '6 days')->>'status'), 'confirmed', 'customer reschedules');
reset role;
select ok((select send_at from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a1' and kind = '24h')
          = (select starts_at - interval '24 hours' from public.appointments where id = 'b5555555-0000-4000-8000-0000000000a1'), 'reschedule moved the 24h reminder');
select is((select count(*)::int from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a1' and status = 'pending'), 2, 'still exactly two pending reminders after the move');

-- a reminder that was already sent is not resent when the same status is written again
update public.reminders set status = 'sent', sent_at = now() where appointment_id = 'b5555555-0000-4000-8000-0000000000a1' and kind = '24h';
update public.appointments set status = 'confirmed' where id = 'b5555555-0000-4000-8000-0000000000a1';
select is((select status from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a1' and kind = '24h'), 'sent', 'rewriting the same status does not revive a sent reminder');

-- customer cancel cancels the rest; the sent one is history
select pg_temp.act_service();
select is(public.customer_cancel_appointment(repeat('a', 48), 'b5555555-0000-4000-8000-0000000000a1')::text, 'true', 'customer cancels');
reset role;
select is((select string_agg(kind || ':' || status, ',' order by kind) from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a1'), '24h:sent,2h:cancelled', 'cancel: pending reminder cancelled, sent kept');

-- completed also cancels pending ones
update public.appointments set status = 'completed' where id = 'b5555555-0000-4000-8000-0000000000a2';
select is((select status from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a2' and kind = '2h'), 'cancelled', 'completed cancels pending reminders');
-- revived (staff un-cancels): pending again
update public.appointments set status = 'confirmed' where id = 'b5555555-0000-4000-8000-0000000000a2';
select is((select status from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a2' and kind = '2h'), 'pending', 're-confirming revives a cancelled reminder');

-- ===================== claim / complete =====================
-- make a2's 2h reminder due now
update public.reminders set send_at = now() - interval '1 minute' where appointment_id = 'b5555555-0000-4000-8000-0000000000a2' and kind = '2h';
select pg_temp.act_service();
select is((select count(*)::int from public.claim_due_reminders(10) where appointment_id = 'b5555555-0000-4000-8000-0000000000a2'), 1, 'claim returns the due reminder once');
select is((select count(*)::int from public.claim_due_reminders(10) where appointment_id = 'b5555555-0000-4000-8000-0000000000a2'), 0, 'a second claim returns nothing (already sending)');
reset role;
select is((select status || ':' || attempts from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a2'), 'sending:1', 'claimed row is sending with attempts = 1');
select pg_temp.act_service();
select is(public.complete_reminder((select id from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a2'), 'retry', 'http_500', now() - interval '1 second'), 'pending', 'retry puts it back to pending with retry_at');
select is((select count(*)::int from public.claim_due_reminders(10) where appointment_id = 'b5555555-0000-4000-8000-0000000000a2'), 1, 'the retry is claimed again once retry_at passed');
select is(public.complete_reminder((select id from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a2'), 'sent'), 'sent', 'complete sent');
select is(public.complete_reminder((select id from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a2'), 'sent'), 'not_sending', 'completing twice is a no-op');
reset role;
select is((select attempts from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a2'), 2, 'attempts counted claims');

-- a reminder whose appointment got cancelled meanwhile is not completed over the cancellation
update public.reminders set status = 'pending', send_at = now() - interval '1 minute', attempts = 0 where appointment_id = 'b5555555-0000-4000-8000-0000000000a2';
select pg_temp.act_service();
select is((select count(*)::int from public.claim_due_reminders(10) where appointment_id = 'b5555555-0000-4000-8000-0000000000a2'), 1, 'claimed again');
reset role;
update public.appointments set status = 'cancelled' where id = 'b5555555-0000-4000-8000-0000000000a2';
select pg_temp.act_service();
select is(public.complete_reminder((select id from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a2'), 'sent'), 'not_sending', 'cancelled while sending: late completion does not resurrect it');
reset role;
select is((select status from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a2'), 'cancelled', 'and it stays cancelled');

-- a stale "sending" row (crashed worker) is reclaimed after 10 minutes
update public.appointments set status = 'confirmed' where id = 'b5555555-0000-4000-8000-0000000000a2';
update public.reminders set status = 'sending', claimed_at = now() - interval '11 minutes', send_at = now() - interval '1 hour' where appointment_id = 'b5555555-0000-4000-8000-0000000000a2';
select pg_temp.act_service();
select is((select count(*)::int from public.claim_due_reminders(10) where appointment_id = 'b5555555-0000-4000-8000-0000000000a2'), 1, 'stale sending row is reclaimed');
reset role;

-- not applicable (appointment already started) is skipped, never claimed
update public.appointments set starts_at = now() - interval '10 minutes', ends_at = now() + interval '20 minutes' where id = 'b5555555-0000-4000-8000-0000000000a2';
update public.reminders set status = 'pending', send_at = now() - interval '2 hours', claimed_at = null where appointment_id = 'b5555555-0000-4000-8000-0000000000a2';
select pg_temp.act_service();
select is((select count(*)::int from public.claim_due_reminders(10) where appointment_id = 'b5555555-0000-4000-8000-0000000000a2'), 0, 'a reminder for an appointment that already began is not claimed');
reset role;
select is((select status from public.reminders where appointment_id = 'b5555555-0000-4000-8000-0000000000a2'), 'skipped', '... it is skipped');

-- ===================== grants =====================
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname in ('demo_outbox','demo_appointment_sessions') and c.relrowsecurity and c.relforcerowsecurity), 2, 'new tables have forced RLS');
select is((select count(*)::int from unnest(array['anon','authenticated']) r, unnest(array['demo_outbox','demo_appointment_sessions']) t,
            unnest(array['select','insert','update','delete']) p where has_table_privilege(r, 'public.' || t, p)), 0, 'anon/authenticated hold no privilege on the outbox tables');
select pg_temp.act_anon();
select is(pg_temp.exec($$select * from public.demo_outbox$$), 'ERR:42501:permission denied for table demo_outbox', 'anon cannot read the outbox');
select is(pg_temp.exec($$select * from public.reminders$$), 'ERR:42501:permission denied for table reminders', 'anon cannot read reminders');
reset role;
select pg_temp.act('ba000000-0000-4000-8000-000000000001');
select is(pg_temp.exec($$select * from public.demo_outbox$$), 'ERR:42501:permission denied for table demo_outbox', 'owner cannot read the outbox');
select is(pg_temp.exec($$select * from public.demo_appointment_sessions$$), 'ERR:42501:permission denied for table demo_appointment_sessions', 'owner cannot read demo sessions');
select is(pg_temp.exec($$select last_error from public.reminders$$), 'ERR:42501:permission denied for table reminders', 'owner cannot read reminder internals (last_error)');
select ok((select count(*) from (select status, send_at, attempts from public.reminders) x) > 0, 'owner reads reminder status columns of own tenant');
select is(pg_temp.exec($$update public.reminders set status = 'sent'$$), 'ERR:42501:permission denied for table reminders', 'owner cannot write reminders');
select is(pg_temp.exec($$select public.claim_due_reminders(5)$$), 'ERR:42501:permission denied for function claim_due_reminders', 'owner cannot claim');
select is(pg_temp.exec($$select public.demo_outbox_add('b1111111-0000-4000-8000-00000000000b', repeat('0',64), 'link', 'x@y.z', 's', 'b')$$), 'ERR:42501:permission denied for function demo_outbox_add', 'owner cannot write the outbox');
select is(pg_temp.exec($$select * from public.customer_portal_get(repeat('a', 48))$$), 'ERR:42501:permission denied for function customer_portal_get', 'authenticated cannot call the portal lookup');
reset role;
select pg_temp.act('ba000000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.reminders), 0, 'a provider-role member sees no reminders');
reset role;
select pg_temp.act('ba000000-0000-4000-8000-000000000002');
select ok((select count(*) from public.reminders) > 0, 'a receptionist sees own tenant reminders');
select is((select count(*)::int from public.reminders where tenant_id = 'b1111111-0000-4000-8000-00000000000b'), 0, 'and none of another tenant');
reset role;
select pg_temp.act_anon();
select is(pg_temp.exec($$select public.customer_portal_appointments(repeat('a', 48))$$), 'ERR:42501:permission denied for function customer_portal_appointments', 'anon cannot call the portal appointments');
select is(pg_temp.exec($$select public.customer_issue_link('b1111111-0000-4000-8000-00000000000a', '+966500000071', null)$$), 'ERR:42501:permission denied for function customer_issue_link', 'anon cannot issue links');
reset role;

-- ===================== demo outbox =====================
select pg_temp.act_service();
select is(pg_temp.exec($$select public.demo_outbox_add('b1111111-0000-4000-8000-00000000000a', repeat('0',64), 'link', 'x@y.z', 's', 'b')$$), 'ERR:P0001:not_demo', 'outbox refuses a non-demo tenant');
select is(pg_temp.exec($$select public.demo_outbox_add('b1111111-0000-4000-8000-00000000000b', 'not-a-hash', 'link', 'x@y.z', 's', 'b')$$), 'ERR:23514:new row for relation "demo_outbox" violates check constraint "demo_outbox_session_hash_check"', 'session hash must be 64 hex chars');
select lives_ok($$select public.demo_outbox_add('b1111111-0000-4000-8000-00000000000b', repeat('1',64), 'link', 'x@y.z', 'S1', 'b')$$, 'outbox add (demo tenant)');
select lives_ok($$select public.demo_outbox_add('b1111111-0000-4000-8000-00000000000b', repeat('2',64), 'link', 'x@y.z', 'S2', 'b')$$, 'outbox add, other session');
select is((select count(*)::int from public.demo_outbox where session_hash = repeat('1',64)), 1, 'sessions are separate rows');
do $$ begin for i in 1..30 loop perform public.demo_outbox_add('b1111111-0000-4000-8000-00000000000b', repeat('3',64), 'link', 'x@y.z', 'n' || i, 'b'); end loop; end $$;
select is((select count(*)::int from public.demo_outbox where session_hash = repeat('3',64)), 20, 'per-session cap is 20');
select is((select subject from public.demo_outbox where session_hash = repeat('3',64) order by created_at desc, id limit 1) is not null, true, 'newest rows are kept');
select is((select count(*)::int from public.demo_outbox where session_hash = repeat('1',64)), 1, 'another session is untouched by the cap');
update public.demo_outbox set created_at = now() - interval '25 hours' where session_hash = repeat('2',64);
select is(public.purge_demo_outbox() >= 1, true, 'purge removes rows older than 24h');
select is((select count(*)::int from public.demo_outbox where session_hash = repeat('2',64)), 0, 'the old row is gone');
select is(pg_temp.exec($$select public.demo_attach_session('b1111111-0000-4000-8000-00000000000a', 'b5555555-0000-4000-8000-0000000000a3', repeat('1',64))$$), 'ERR:P0001:not_demo', 'attach session refuses a non-demo tenant');
reset role;

-- ===================== patient page lookups =====================
select pg_temp.act_service();
select is((select count(*)::int from public.customer_portal_get(repeat('a', 48))), 1, 'valid token resolves');
select is((select tenant_slug from public.customer_portal_get(repeat('a', 48))), 'rem-a', 'and reports its own clinic slug');
select is((select count(*)::int from public.customer_portal_get(repeat('c', 48))), 0, 'expired token resolves to nothing');
select is((select count(*)::int from public.customer_portal_get('short')), 0, 'short token resolves to nothing');
select is((select count(*)::int from public.customer_portal_get(repeat('z', 48))), 0, 'unknown token resolves to nothing');
select is((select count(*)::int from public.customer_portal_appointments(repeat('c', 48))), 0, 'expired token lists nothing');
select ok((select count(*) from public.customer_portal_appointments(repeat('a', 48))) >= 2, 'valid token lists the appointments');
select is((select deposit_status from public.customer_portal_appointments(repeat('a', 48)) where id = 'b5555555-0000-4000-8000-0000000000a4'), 'paid', 'deposit state is reported');
select is((select count(*)::int from public.customer_portal_appointments(repeat('b', 48)) where id = 'b5555555-0000-4000-8000-0000000000a1'), 0, 'another customer''s token never lists these appointments');
-- customer_issue_link: by phone, by e-mail, unknown, and the rotated token invalidates the old one
select is((select contact_email from public.customer_issue_link('b1111111-0000-4000-8000-00000000000a', '+966500000071', null, null, true)), 'c1@example.com', 'link issue by phone returns the contact on file (p_force rotates since round 3)');
select is((select count(*)::int from public.customer_portal_get(repeat('a', 48))), 0, 'the old token stopped working after rotation');
select is((select count(*)::int from public.customer_issue_link('b1111111-0000-4000-8000-00000000000a', null, 'C1@EXAMPLE.COM')), 1, 'link issue by e-mail (case-insensitive)');
select is((select count(*)::int from public.customer_issue_link('b1111111-0000-4000-8000-00000000000a', '+966599999999', null)), 0, 'unknown phone returns nothing');
select is((select count(*)::int from public.customer_issue_link('b1111111-0000-4000-8000-00000000000b', '+966500000071', null)), 0, 'a phone from another clinic is not found');
reset role;

select * from finish();
rollback;
