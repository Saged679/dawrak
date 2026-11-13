-- Reminders lifecycle, dispatcher support, demo mail outbox, patient-page lookups. Additive.
--
--  1. reminders: sending/cancelled states, attempts + retry bookkeeping, column-level select grant.
--  2. trg_appointment_reminders(): the ONE place that creates / moves / cancels reminders. It fires on
--     every path that changes an appointment's status or start (create_public_booking, settle_payment,
--     customer_*/staff_update_appointment, expire_pending_bookings, plain status updates).
--  3. claim_due_reminders() / complete_reminder(): atomic claim (FOR UPDATE SKIP LOCKED) and result.
--  4. demo_outbox (+ demo_appointment_sessions): emails of demo tenants never leave the database;
--     rows belong to a visitor session, stored only as a SHA-256 hash of the httpOnly cookie value.
--  5. customer_portal_get / customer_portal_appointments / customer_issue_link: patient page + "send me
--     a link" lookups (service role only; tokens are never returned by the list functions).
--  6. reset_demo() also empties the outbox.

-- =====================================================================================
-- 1. reminders columns, states, grants
-- =====================================================================================
alter table public.reminders
  add column if not exists attempts   int not null default 0,
  add column if not exists retry_at   timestamptz,
  add column if not exists claimed_at timestamptz,
  add column if not exists last_error text;

alter table public.reminders drop constraint if exists reminders_status_check;
alter table public.reminders add constraint reminders_status_check
  check (status in ('pending','sending','sent','failed','skipped','cancelled'));
alter table public.reminders drop constraint if exists reminders_last_error_len;
alter table public.reminders add constraint reminders_last_error_len
  check (last_error is null or char_length(last_error) <= 80);

drop index if exists public.reminders_due_idx;
create index reminders_due_idx on public.reminders ((coalesce(retry_at, send_at))) where status = 'pending';
create index if not exists reminders_stale_idx on public.reminders (claimed_at) where status = 'sending';
create index if not exists reminders_tenant_send_idx on public.reminders (tenant_id, send_at);

-- Staff (owner/receptionist by RLS) see status counts only: no last_error / claim internals.
revoke select on public.reminders from authenticated;
grant select (id, tenant_id, appointment_id, kind, send_at, sent_at, status, attempts, created_at)
  on public.reminders to authenticated;

-- =====================================================================================
-- 2. lifecycle trigger
-- =====================================================================================
-- SECURITY DEFINER: the caller may be a signed-in staff member who has no write access to reminders.
-- The seed (dawrak.seeding = on) inserts its own reminder rows, so the trigger stays out of its way.
create or replace function public.trg_appointment_reminders()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  k record;
  v_at timestamptz;
begin
  if coalesce(current_setting('dawrak.seeding', true), '') = 'on' then return null; end if;
  if tg_op = 'UPDATE' and old.status = new.status and old.starts_at = new.starts_at then return null; end if;

  if new.status = 'confirmed' then
    for k in select * from (values ('24h', interval '24 hours'), ('2h', interval '2 hours')) v(kind, lead) loop
      v_at := new.starts_at - k.lead;
      if v_at > now() then
        insert into public.reminders (tenant_id, appointment_id, kind, send_at, status)
        values (new.tenant_id, new.id, k.kind, v_at, 'pending')
        on conflict (appointment_id, kind) do update
           set send_at = excluded.send_at, status = 'pending', sent_at = null, attempts = 0,
               retry_at = null, claimed_at = null, last_error = null
         where public.reminders.send_at is distinct from excluded.send_at
            or public.reminders.status in ('cancelled','skipped');
      else
        -- already in the past: nothing to send (and a stale pending one must not fire)
        update public.reminders set status = 'skipped'
         where appointment_id = new.id and kind = k.kind and status in ('pending','sending');
      end if;
    end loop;
  else
    update public.reminders set status = 'cancelled', claimed_at = null
     where appointment_id = new.id and status in ('pending','sending');
  end if;
  return null;
end $$;
revoke all on function public.trg_appointment_reminders() from public, anon, authenticated;

drop trigger if exists appointments_reminders on public.appointments;
create trigger appointments_reminders after insert or update of status, starts_at on public.appointments
  for each row execute function public.trg_appointment_reminders();

-- one-off backfill for confirmed future appointments that predate the trigger
insert into public.reminders (tenant_id, appointment_id, kind, send_at, status)
select a.tenant_id, a.id, k.kind, a.starts_at - k.lead, 'pending'
  from public.appointments a
 cross join (values ('24h', interval '24 hours'), ('2h', interval '2 hours')) k(kind, lead)
 where a.status = 'confirmed' and a.starts_at - k.lead > now()
on conflict (appointment_id, kind) do nothing;

-- =====================================================================================
-- 3. claim / complete (service role only)
-- =====================================================================================
create or replace function public.claim_due_reminders(p_limit int default 20)
returns table (
  reminder_id uuid, kind text, attempts int,
  tenant_id uuid, tenant_slug text, tenant_name_ar text, tenant_name_en text, timezone text, is_demo boolean,
  appointment_id uuid, starts_at timestamptz,
  provider_name_ar text, provider_name_en text, service_name_ar text, service_name_en text,
  customer_id uuid, customer_name text, customer_phone text, customer_email text, customer_locale text,
  demo_session_hash text)
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  -- nothing to send for appointments that are no longer confirmed or already started
  update public.reminders r set status = 'skipped', last_error = 'not_applicable'
    from public.appointments a
   where a.id = r.appointment_id and a.tenant_id = r.tenant_id
     and r.status = 'pending' and coalesce(r.retry_at, r.send_at) <= now()
     and (a.status <> 'confirmed' or a.starts_at <= now());

  return query
  with due as (
    select r.id
      from public.reminders r
     where (r.status = 'pending' and coalesce(r.retry_at, r.send_at) <= now())
        or (r.status = 'sending' and r.claimed_at < now() - interval '10 minutes')
     order by coalesce(r.retry_at, r.send_at), r.id
     limit least(greatest(coalesce(p_limit, 20), 1), 50)
       for update of r skip locked
  ), upd as (
    update public.reminders r
       set status = 'sending', claimed_at = now(), attempts = r.attempts + 1
      from due
     where r.id = due.id
    returning r.id, r.kind, r.attempts, r.tenant_id, r.appointment_id
  )
  select u.id, u.kind, u.attempts,
         t.id, t.slug, t.name_ar, t.name_en, t.timezone, t.is_demo,
         a.id, a.starts_at,
         p.name_ar, p.name_en, s.name_ar, s.name_en,
         c.id, c.full_name, c.phone, c.email, c.locale,
         d.session_hash
    from upd u
    join public.appointments a on a.id = u.appointment_id and a.tenant_id = u.tenant_id
    join public.tenants t on t.id = u.tenant_id
    join public.providers p on p.id = a.provider_id and p.tenant_id = a.tenant_id
    join public.services s on s.id = a.service_id and s.tenant_id = a.tenant_id
    join public.customers c on c.id = a.customer_id and c.tenant_id = a.tenant_id
    left join public.demo_appointment_sessions d on d.appointment_id = a.id and d.tenant_id = a.tenant_id
   order by u.id;
end $$;

-- p_outcome: sent | skipped | failed (final) | retry (needs p_retry_at). Only a row still in 'sending'
-- is touched, so a reminder that was cancelled or moved meanwhile keeps its new state.
create or replace function public.complete_reminder(
  p_id uuid, p_outcome text, p_error text default null, p_retry_at timestamptz default null)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare v_status text;
begin
  if p_outcome not in ('sent','skipped','failed','retry') then raise exception 'invalid_outcome'; end if;
  if p_outcome = 'retry' and p_retry_at is null then raise exception 'retry_at_required'; end if;
  update public.reminders
     set status = case p_outcome when 'retry' then 'pending' else p_outcome end,
         sent_at = case when p_outcome = 'sent' then now() else sent_at end,
         retry_at = case when p_outcome = 'retry' then p_retry_at else null end,
         claimed_at = null,
         last_error = case when p_outcome = 'sent' then null else left(p_error, 80) end
   where id = p_id and status = 'sending'
  returning status into v_status;
  return coalesce(v_status, 'not_sending');
end $$;

revoke all on function public.claim_due_reminders(int), public.complete_reminder(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_due_reminders(int), public.complete_reminder(uuid, text, text, timestamptz)
  to service_role;
comment on function public.claim_due_reminders(int) is 'service_role only. Atomically claims due reminders (FOR UPDATE SKIP LOCKED), marks them sending and returns what the email needs.';
comment on function public.complete_reminder(uuid, text, text, timestamptz) is 'service_role only. sent | skipped | failed | retry for a reminder in sending.';

-- =====================================================================================
-- 4. demo mail outbox
-- =====================================================================================
create table if not exists public.demo_appointment_sessions (
  appointment_id uuid primary key,
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  session_hash   text not null check (session_hash ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz not null default now(),
  foreign key (appointment_id, tenant_id) references public.appointments(id, tenant_id) on delete cascade
);
create table if not exists public.demo_outbox (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  session_hash text not null check (session_hash ~ '^[0-9a-f]{64}$'),
  kind         text not null check (kind in ('24h','2h','booking','link')),
  to_email     text not null check (char_length(to_email) <= 254),
  subject      text not null check (char_length(subject) <= 300),
  body_text    text not null check (char_length(body_text) <= 8000),
  created_at   timestamptz not null default now()
);
create index if not exists demo_outbox_session_idx on public.demo_outbox (session_hash, created_at desc);
create index if not exists demo_outbox_created_idx on public.demo_outbox (created_at);

alter table public.demo_appointment_sessions enable row level security;
alter table public.demo_appointment_sessions force row level security;
alter table public.demo_outbox enable row level security;
alter table public.demo_outbox force row level security;
-- No policies and no grants: only service_role (which bypasses RLS) and the definer functions below.
revoke all on public.demo_appointment_sessions from public, anon, authenticated;
revoke all on public.demo_outbox from public, anon, authenticated;

create or replace function public.purge_demo_outbox()
returns int
language plpgsql volatile security definer
set search_path = ''
as $$
declare v_n int;
begin
  delete from public.demo_outbox where created_at < now() - interval '24 hours';
  get diagnostics v_n = row_count;
  delete from public.demo_appointment_sessions where created_at < now() - interval '3 days';
  return v_n;
end $$;

-- Caps: 20 rows per session, 2000 in total (oldest go first). Refuses non-demo tenants outright.
create or replace function public.demo_outbox_add(
  p_tenant_id uuid, p_session_hash text, p_kind text, p_to text, p_subject text, p_body text)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if not public._tenant_is_demo(p_tenant_id) then raise exception 'not_demo'; end if;
  delete from public.demo_outbox
   where session_hash = p_session_hash
     and id in (select id from public.demo_outbox where session_hash = p_session_hash
                 order by created_at desc, id offset 19);
  delete from public.demo_outbox
   where id in (select id from public.demo_outbox order by created_at desc, id offset 1999);
  insert into public.demo_outbox (tenant_id, session_hash, kind, to_email, subject, body_text)
  values (p_tenant_id, p_session_hash, p_kind, left(p_to, 254), left(p_subject, 300), left(p_body, 8000))
  returning id into v_id;
  return v_id;
end $$;

-- Binds a demo appointment to the visitor session that created it (reminders then land in that outbox).
create or replace function public.demo_attach_session(p_tenant_id uuid, p_appointment_id uuid, p_session_hash text)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not public._tenant_is_demo(p_tenant_id) then raise exception 'not_demo'; end if;
  insert into public.demo_appointment_sessions (appointment_id, tenant_id, session_hash)
  values (p_appointment_id, p_tenant_id, p_session_hash)
  on conflict (appointment_id) do nothing;
end $$;

revoke all on function public.purge_demo_outbox(),
  public.demo_outbox_add(uuid, text, text, text, text, text),
  public.demo_attach_session(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.purge_demo_outbox(),
  public.demo_outbox_add(uuid, text, text, text, text, text),
  public.demo_attach_session(uuid, uuid, text)
  to service_role;

-- reset_demo: same as migration 14 plus an explicit outbox wipe (tenant deletion also cascades).
create or replace function public.reset_demo()
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform set_config('dawrak.seeding', 'on', true);
  delete from public.demo_outbox;
  delete from public.tenants
   where is_demo
      or id in ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002');
  perform public.seed_demo();
  perform set_config('dawrak.seeding', 'off', true);
end $$;
revoke all on function public.reset_demo() from public, anon, authenticated;
grant execute on function public.reset_demo() to service_role;

-- =====================================================================================
-- 5. patient page + "send me a link" (service role only)
-- =====================================================================================
create or replace function public.customer_portal_get(p_token text)
returns table (customer_id uuid, tenant_id uuid, tenant_slug text, full_name text, locale text)
language sql stable security definer
set search_path = ''
as $$
  select c.id, c.tenant_id, t.slug, c.full_name, c.locale
    from public.customers c
    join public.tenants t on t.id = c.tenant_id
   where c.access_token = p_token and length(p_token) >= 32 and c.access_token_expires_at > now()
$$;

create or replace function public.customer_portal_appointments(p_token text)
returns table (id uuid, provider_id uuid, service_id uuid,
               provider_name_ar text, provider_name_en text, service_name_ar text, service_name_en text,
               starts_at timestamptz, ends_at timestamptz, status text, price numeric, currency text,
               deposit_status text, deposit_amount numeric, payment_expires_at timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select a.id, a.provider_id, a.service_id, p.name_ar, p.name_en, s.name_ar, s.name_en,
         a.starts_at, a.ends_at, a.status, a.price, t.currency,
         pay.status, pay.amount, a.payment_expires_at
    from public.customers c
    join public.appointments a on a.customer_id = c.id and a.tenant_id = c.tenant_id
    join public.tenants t on t.id = a.tenant_id
    join public.providers p on p.id = a.provider_id and p.tenant_id = a.tenant_id
    join public.services s on s.id = a.service_id and s.tenant_id = a.tenant_id
    left join lateral (
      select py.status, py.amount from public.payments py
       where py.appointment_id = a.id and py.tenant_id = a.tenant_id
       order by py.created_at desc limit 1) pay on true
   where c.access_token = p_token and length(p_token) >= 32 and c.access_token_expires_at > now()
   order by a.starts_at desc
   limit 100
$$;

-- Rotates the token of the customer that matches the phone (or, when no phone, the e-mail) and returns the
-- contact ON FILE. Empty result when there is no such customer. The token is only ever put in an e-mail.
create or replace function public.customer_issue_link(p_tenant_id uuid, p_phone text, p_email text)
returns table (link_token text, contact_email text, contact_name text, contact_locale text)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[\s\-()]', '', 'g');
  v_id    uuid;
begin
  if v_phone <> '' then
    select c.id into v_id from public.customers c where c.tenant_id = p_tenant_id and c.phone = v_phone;
  elsif coalesce(p_email, '') <> '' then
    select c.id into v_id from public.customers c
     where c.tenant_id = p_tenant_id and lower(c.email) = lower(p_email)
     order by c.created_at desc limit 1;
  end if;
  if v_id is null then return; end if;
  update public.customers c
     set access_token = encode(extensions.gen_random_bytes(24), 'hex'),
         access_token_expires_at = now() + interval '30 days'
   where c.id = v_id
  returning c.access_token, c.email, c.full_name, c.locale
       into link_token, contact_email, contact_name, contact_locale;
  return next;
end $$;

revoke all on function public.customer_portal_get(text), public.customer_portal_appointments(text),
  public.customer_issue_link(uuid, text, text) from public, anon, authenticated;
grant execute on function public.customer_portal_get(text), public.customer_portal_appointments(text),
  public.customer_issue_link(uuid, text, text) to service_role;
comment on function public.customer_portal_get(text) is 'service_role only. Customer behind an unexpired token (no token returned).';
comment on function public.customer_portal_appointments(text) is 'service_role only. Appointments for the patient page, with deposit state; never returns a token or a pay token.';
comment on function public.customer_issue_link(uuid, text, text) is 'service_role only. Rotates the token and returns the contact on file; send it by e-mail only.';
