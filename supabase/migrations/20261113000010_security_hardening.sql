-- Security hardening (review findings C1, H1-H3, M1-M3, L1-L3). Additive: replaces functions with
-- `create or replace` and tightens grants; old migrations are untouched.
--
-- WHO MAY CALL WHAT (also stored as COMMENT ON FUNCTION)
--   anon + authenticated + service_role : public_get_tenant, public_list_services, public_list_providers
--   authenticated (members) + service_role : staff_get_available_slots, staff_update_appointment,
--                                            match_kb_chunks, auth_tenant_role, auth_provider_id
--   service_role ONLY : create_public_booking, get_available_slots, customer_get_appointments,
--                       customer_cancel_appointment, customer_reschedule_appointment,
--                       issue_customer_magic_link, check_rate_limit, expire_pending_bookings,
--                       seed_demo, reset_demo, _slot_is_free
-- The Next.js server calls the service-role-only functions AFTER check_rate_limit(), so the rate
-- limit can no longer be bypassed through /rest/v1/rpc.
--
-- NOTE (M3): also set "Allow new users to sign up" = OFF on the HOSTED Supabase project
-- (Dashboard > Authentication > Providers/Sign In), same as enable_signup = false in config.toml.

-- =====================================================================================
-- L1. New functions are private by default
-- =====================================================================================
-- Global form removes the implicit PUBLIC execute; the in-schema form removes Supabase's
-- default grants to anon/authenticated/service_role (service_role is re-granted explicitly).
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant execute on functions to service_role;
do $$ begin
  alter default privileges for role supabase_admin revoke execute on functions from public;
  alter default privileges for role supabase_admin in schema public revoke execute on functions from public, anon, authenticated, service_role;
  alter default privileges for role supabase_admin in schema public grant execute on functions to service_role;
exception when others then
  raise notice 'could not alter supabase_admin default privileges: %', sqlerrm;
end $$;

-- =====================================================================================
-- L3. authenticated never needs truncate / trigger / references
-- =====================================================================================
revoke truncate, trigger, references on all tables in schema public from authenticated;
alter default privileges for role postgres in schema public revoke truncate, trigger, references on tables from authenticated;

-- =====================================================================================
-- M1 (schema part). Token expiry; staff can no longer read or write access_token
-- =====================================================================================
alter table public.customers
  add column if not exists access_token_expires_at timestamptz not null default now() + interval '30 days';

revoke select, insert, update on public.customers from authenticated;
do $$
declare v_cols text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
  from pg_attribute a
  where a.attrelid = 'public.customers'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attname <> 'access_token';
  execute format('grant select (%s) on public.customers to authenticated', v_cols);
end $$;
grant insert (tenant_id, full_name, phone, email, locale) on public.customers to authenticated;
grant update (full_name, phone, email, locale) on public.customers to authenticated;
-- (delete stays granted; RLS limits it to owner/receptionist.) If a column is added to customers
-- later, re-run the grant select (...) above for it. `select *` by staff now fails: list columns.

-- =====================================================================================
-- H2. Tenants: owners may edit settings only, not identity/flags
-- =====================================================================================
revoke update, insert, delete on public.tenants from authenticated;
grant update (name_ar, name_en, timezone, currency, deposit_enabled, deposit_type, deposit_value, logo_url, brand_color)
  on public.tenants to authenticated;

-- =====================================================================================
-- H3. Appointments: provider limited to status; staff structural edits go through a function
-- =====================================================================================
revoke update on public.appointments from authenticated;
grant update (status, notes) on public.appointments to authenticated;

drop policy if exists appointments_provider_update on public.appointments;
create policy appointments_provider_update on public.appointments for update to authenticated
  using (public.auth_tenant_role(tenant_id) = 'provider'
         and provider_id = public.auth_provider_id(tenant_id)
         and status in ('confirmed','completed','no_show'))   -- never touch unpaid / cancelled rows
  with check (public.auth_tenant_role(tenant_id) = 'provider'
              and provider_id = public.auth_provider_id(tenant_id)
              and status in ('completed','no_show'));

-- =====================================================================================
-- L2 + M2. Core booking functions: search_path = '' and fully qualified names
-- =====================================================================================
-- Same as before, plus: an expired pending_payment hold no longer blocks a slot.
create or replace function public._slot_is_free(
  p_tenant_id uuid, p_provider_id uuid, p_start timestamptz,
  p_duration_min int, p_buffer_min int, p_exclude_appointment uuid default null)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  with tz as (select timezone from public.tenants where id = p_tenant_id),
  loc as (select (p_start at time zone tz.timezone) as ts, tz.timezone as zone from tz)
  select
    exists (
      select 1 from loc
      join public.working_hours wh
        on wh.tenant_id = p_tenant_id and wh.provider_id = p_provider_id
       and wh.weekday = extract(dow from loc.ts)::int
      where p_start >= ((loc.ts::date + wh.start_time) at time zone loc.zone)
        and p_start + make_interval(mins => p_duration_min) <= ((loc.ts::date + wh.end_time) at time zone loc.zone)
    )
    and not exists (
      select 1 from public.time_off o
      where o.tenant_id = p_tenant_id and o.provider_id = p_provider_id
        and tstzrange(o.starts_at, o.ends_at, '[)')
            && tstzrange(p_start, p_start + make_interval(mins => p_duration_min + p_buffer_min), '[)')
    )
    and not exists (
      select 1
      from public.appointments a
      join public.services s on s.id = a.service_id and s.tenant_id = a.tenant_id
      where a.tenant_id = p_tenant_id and a.provider_id = p_provider_id
        and a.status in ('pending_payment','confirmed','completed')
        and not (a.status = 'pending_payment' and a.payment_expires_at is not null and a.payment_expires_at < now())
        and a.id is distinct from p_exclude_appointment
        and tstzrange(a.starts_at, a.ends_at + make_interval(mins => s.buffer_min), '[)')
            && tstzrange(p_start, p_start + make_interval(mins => p_duration_min + p_buffer_min), '[)')
    )
$$;

-- Service role only. Slots are capped at 90 days ahead (same horizon as create_public_booking).
create or replace function public.get_available_slots(
  p_tenant_id uuid, p_provider_id uuid, p_service_id uuid,
  p_date_from date, p_date_to date, p_step_min int default 15)
returns table (slot_provider_id uuid, slot_start timestamptz, slot_end timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select p.id,
         g.s,
         g.s + make_interval(mins => sv.duration_min)
  from public.tenants t
  join public.services sv
    on sv.id = p_service_id and sv.tenant_id = t.id and sv.is_active
  join public.providers p
    on p.tenant_id = t.id and p.is_active and (p_provider_id is null or p.id = p_provider_id)
  join public.provider_services ps
    on ps.provider_id = p.id and ps.service_id = sv.id and ps.tenant_id = t.id
  cross join lateral generate_series(p_date_from::timestamp,
                                     least(p_date_to, p_date_from + 60)::timestamp,
                                     interval '1 day') d(day)
  join public.working_hours wh
    on wh.provider_id = p.id and wh.tenant_id = t.id
   and wh.weekday = extract(dow from d.day)::int
  cross join lateral generate_series(
        ((d.day::date + wh.start_time) at time zone t.timezone),
        ((d.day::date + wh.end_time)   at time zone t.timezone) - make_interval(mins => sv.duration_min),
        make_interval(mins => greatest(p_step_min, 5))) g(s)
  where t.id = p_tenant_id
    and g.s > now()
    and g.s <= now() + interval '90 days'
    and public._slot_is_free(t.id, p.id, g.s, sv.duration_min, sv.buffer_min)
  order by g.s, p.id
$$;

-- Staff-dashboard path to availability: membership checked, owner/receptionist only.
create or replace function public.staff_get_available_slots(
  p_tenant_id uuid, p_provider_id uuid, p_service_id uuid,
  p_date_from date, p_date_to date, p_step_min int default 15)
returns table (slot_provider_id uuid, slot_start timestamptz, slot_end timestamptz)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if coalesce(public.auth_tenant_role(p_tenant_id), '') not in ('owner','receptionist') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query select * from public.get_available_slots(p_tenant_id, p_provider_id, p_service_id,
                                                        p_date_from, p_date_to, p_step_min);
end $$;

-- Public read helpers: unchanged behaviour, search_path hardened.
alter function public.public_get_tenant(text)                 set search_path = '';
alter function public.public_list_services(uuid)              set search_path = '';
alter function public.public_list_providers(uuid, uuid)       set search_path = '';
alter function public.check_rate_limit(text, int, interval)   set search_path = '';
alter function public.expire_pending_bookings()               set search_path = '';

-- ---------- create_public_booking (service role only) ----------
-- C1: an EXISTING customer (same tenant + phone) is never modified and its token is never
--     returned: customer_token is non-null only when the customer row was created by this call
--     (otherwise the app sends the magic link to the contact already on file, see
--     issue_customer_magic_link). Errors: invalid_*, tenant_not_found, service_not_found,
--     provider_not_found, too_far, too_many_bookings, slot_taken (23P01).
create or replace function public.create_public_booking(
  p_tenant_id uuid, p_provider_id uuid, p_service_id uuid, p_starts_at timestamptz,
  p_full_name text, p_phone text, p_email text default null,
  p_source text default 'web', p_locale text default 'ar')
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_tenant   public.tenants;
  v_service  public.services;
  v_customer public.customers;
  v_appt     public.appointments;
  v_phone    text := regexp_replace(coalesce(p_phone, ''), '[\s\-()]', '', 'g');
  v_name     text := btrim(coalesce(p_full_name, ''));
  v_status   text;
  v_deposit  numeric := 0;
  v_new      boolean;
begin
  if p_source not in ('web','chat') then raise exception 'invalid_source'; end if;
  if char_length(v_name) < 2 or char_length(v_name) > 100 then raise exception 'invalid_name'; end if;
  if v_phone !~ '^\+?[0-9]{7,15}$' then raise exception 'invalid_phone'; end if;
  if p_email is not null and (char_length(p_email) > 200 or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'invalid_email';
  end if;

  perform public.expire_pending_bookings();   -- M2: free expired holds first

  select * into v_tenant from public.tenants where id = p_tenant_id;
  if not found then raise exception 'tenant_not_found'; end if;
  select * into v_service from public.services where id = p_service_id and tenant_id = p_tenant_id and is_active;
  if not found then raise exception 'service_not_found'; end if;
  if not exists (select 1 from public.provider_services ps
                 join public.providers p on p.id = ps.provider_id and p.tenant_id = ps.tenant_id and p.is_active
                 where ps.provider_id = p_provider_id and ps.service_id = p_service_id and ps.tenant_id = p_tenant_id) then
    raise exception 'provider_not_found';
  end if;

  if p_starts_at > now() + interval '90 days' then raise exception 'too_far'; end if;
  if p_starts_at <= now()
     or not public._slot_is_free(p_tenant_id, p_provider_id, p_starts_at, v_service.duration_min, v_service.buffer_min) then
    raise exception 'slot_taken' using errcode = '23P01';
  end if;

  -- C1: create-if-absent only. Never update an existing customer.
  insert into public.customers (tenant_id, full_name, phone, email, locale)
  values (p_tenant_id, v_name, v_phone, p_email, case when p_locale = 'en' then 'en' else 'ar' end)
  on conflict (tenant_id, phone) do nothing
  returning * into v_customer;
  v_new := found;
  if not v_new then
    select * into v_customer from public.customers where tenant_id = p_tenant_id and phone = v_phone;
  end if;

  -- H1: at most 3 active future appointments per phone per tenant
  if (select count(*) from public.appointments a
       where a.tenant_id = p_tenant_id and a.customer_id = v_customer.id
         and a.status in ('pending_payment','confirmed') and a.starts_at > now()) >= 3 then
    raise exception 'too_many_bookings';
  end if;

  v_status := case when v_tenant.deposit_enabled then 'pending_payment' else 'confirmed' end;
  if v_tenant.deposit_enabled then
    v_deposit := case v_tenant.deposit_type
                   when 'percent' then round(v_service.price * v_tenant.deposit_value / 100, 2)
                   else least(v_tenant.deposit_value, v_service.price) end;
  end if;

  begin
    insert into public.appointments (tenant_id, provider_id, service_id, customer_id, starts_at, ends_at,
                                     status, source, price, payment_expires_at)
    values (p_tenant_id, p_provider_id, p_service_id, v_customer.id, p_starts_at,
            p_starts_at + make_interval(mins => v_service.duration_min),
            v_status, p_source, v_service.price,
            case when v_tenant.deposit_enabled then now() + interval '15 minutes' end)
    returning * into v_appt;
  exception when exclusion_violation then
    raise exception 'slot_taken' using errcode = '23P01';
  end;

  return jsonb_build_object(
    'appointment_id', v_appt.id, 'status', v_appt.status,
    'starts_at', v_appt.starts_at, 'ends_at', v_appt.ends_at,
    'price', v_appt.price, 'deposit_amount', v_deposit, 'currency', v_tenant.currency,
    'payment_expires_at', v_appt.payment_expires_at,
    'customer_token', case when v_new then v_customer.access_token end);
end $$;

-- ---------- customer token functions (service role only; tokens now expire) ----------
create or replace function public.customer_get_appointments(p_token text)
returns table (id uuid, tenant_id uuid, tenant_slug text, tenant_name_ar text, tenant_name_en text,
               provider_name_ar text, provider_name_en text, service_name_ar text, service_name_en text,
               starts_at timestamptz, ends_at timestamptz, status text, price numeric)
language sql stable security definer
set search_path = ''
as $$
  select a.id, a.tenant_id, t.slug, t.name_ar, t.name_en, p.name_ar, p.name_en, s.name_ar, s.name_en,
         a.starts_at, a.ends_at, a.status, a.price
  from public.customers c
  join public.appointments a on a.customer_id = c.id and a.tenant_id = c.tenant_id
  join public.tenants t on t.id = a.tenant_id
  join public.providers p on p.id = a.provider_id
  join public.services s on s.id = a.service_id
  where c.access_token = p_token and length(p_token) >= 32 and c.access_token_expires_at > now()
  order by a.starts_at desc
$$;

create or replace function public.customer_cancel_appointment(p_token text, p_appointment_id uuid)
returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare v_n int;
begin
  update public.appointments a set status = 'cancelled'
  from public.customers c
  where a.id = p_appointment_id and c.id = a.customer_id and c.tenant_id = a.tenant_id
    and c.access_token = p_token and length(p_token) >= 32 and c.access_token_expires_at > now()
    and a.status in ('pending_payment','confirmed') and a.starts_at > now();
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

-- Errors: appointment_not_found, too_far, too_many_bookings, slot_taken (23P01).
-- (the cap counts the customer's OTHER active future appointments, so it only bites at 4+.)
create or replace function public.customer_reschedule_appointment(p_token text, p_appointment_id uuid, p_new_starts_at timestamptz)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_appt public.appointments;
  v_svc  public.services;
begin
  perform public.expire_pending_bookings();   -- M2

  select a.* into v_appt
  from public.appointments a
  join public.customers c on c.id = a.customer_id and c.tenant_id = a.tenant_id
  where a.id = p_appointment_id and c.access_token = p_token and length(p_token) >= 32
    and c.access_token_expires_at > now()
    and a.status in ('pending_payment','confirmed') and a.starts_at > now()
  for update of a;
  if not found then raise exception 'appointment_not_found'; end if;

  if p_new_starts_at > now() + interval '90 days' then raise exception 'too_far'; end if;
  if (select count(*) from public.appointments o
       where o.tenant_id = v_appt.tenant_id and o.customer_id = v_appt.customer_id and o.id <> v_appt.id
         and o.status in ('pending_payment','confirmed') and o.starts_at > now()) >= 3 then
    raise exception 'too_many_bookings';
  end if;

  select * into v_svc from public.services where id = v_appt.service_id and tenant_id = v_appt.tenant_id;
  if p_new_starts_at <= now()
     or not public._slot_is_free(v_appt.tenant_id, v_appt.provider_id, p_new_starts_at,
                                 v_svc.duration_min, v_svc.buffer_min, v_appt.id) then
    raise exception 'slot_taken' using errcode = '23P01';
  end if;

  begin
    update public.appointments
       set starts_at = p_new_starts_at,
           ends_at   = p_new_starts_at + make_interval(mins => v_svc.duration_min)
     where id = v_appt.id
    returning * into v_appt;
  exception when exclusion_violation then
    raise exception 'slot_taken' using errcode = '23P01';
  end;
  return jsonb_build_object('appointment_id', v_appt.id, 'starts_at', v_appt.starts_at,
                            'ends_at', v_appt.ends_at, 'status', v_appt.status);
end $$;

-- ---------- M1: issue a fresh magic-link token (service role only) ----------
-- Rotates the token (old links stop working) and extends the expiry by 30 days.
-- Returns null when no customer has that phone in the tenant. The app sends the link to the
-- contact ON FILE; the token is never shown to whoever supplied the phone number.
create or replace function public.issue_customer_magic_link(p_tenant_id uuid, p_phone text)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[\s\-()]', '', 'g');
  v_token text;
begin
  update public.customers
     set access_token = encode(extensions.gen_random_bytes(24), 'hex'),
         access_token_expires_at = now() + interval '30 days'
   where tenant_id = p_tenant_id and phone = v_phone
  returning access_token into v_token;
  return v_token;
end $$;

-- ---------- H3: staff edit of an appointment (owner / receptionist of that tenant) ----------
-- Any argument left null is unchanged (p_notes: pass '' to clear). Re-validates the slot when the
-- time, provider, service or revived status would occupy it. Errors: appointment_not_found
-- (also for non-members), invalid_status, provider_not_found, service_not_found, slot_taken.
create or replace function public.staff_update_appointment(
  p_appointment_id uuid, p_starts_at timestamptz default null, p_provider_id uuid default null,
  p_service_id uuid default null, p_status text default null, p_notes text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_appt   public.appointments;
  v_svc    public.services;
  v_prov   uuid;
  v_start  timestamptz;
  v_status text;
  v_holds  constant text[] := array['pending_payment','confirmed','completed'];
begin
  perform public.expire_pending_bookings();
  select * into v_appt from public.appointments where id = p_appointment_id for update;
  if not found or coalesce(public.auth_tenant_role(v_appt.tenant_id), '') not in ('owner','receptionist') then
    raise exception 'appointment_not_found';
  end if;
  if p_status is not null and p_status not in ('pending_payment','confirmed','cancelled','completed','no_show') then
    raise exception 'invalid_status';
  end if;

  v_prov   := coalesce(p_provider_id, v_appt.provider_id);
  v_start  := coalesce(p_starts_at, v_appt.starts_at);
  v_status := coalesce(p_status, v_appt.status);

  select * into v_svc from public.services
   where id = coalesce(p_service_id, v_appt.service_id) and tenant_id = v_appt.tenant_id;
  if not found then raise exception 'service_not_found'; end if;
  if not exists (select 1 from public.provider_services ps
                 where ps.provider_id = v_prov and ps.service_id = v_svc.id and ps.tenant_id = v_appt.tenant_id) then
    raise exception 'provider_not_found';
  end if;

  if v_status = any (v_holds)
     and (v_start <> v_appt.starts_at or v_prov <> v_appt.provider_id or v_svc.id <> v_appt.service_id
          or not (v_appt.status = any (v_holds)))
     and not public._slot_is_free(v_appt.tenant_id, v_prov, v_start, v_svc.duration_min, v_svc.buffer_min, v_appt.id) then
    raise exception 'slot_taken' using errcode = '23P01';
  end if;

  begin
    update public.appointments
       set provider_id = v_prov,
           service_id  = v_svc.id,
           starts_at   = v_start,
           ends_at     = v_start + make_interval(mins => v_svc.duration_min),
           status      = v_status,
           price       = case when v_svc.id <> v_appt.service_id then v_svc.price else price end,
           notes       = case when p_notes is null then notes else nullif(p_notes, '') end
     where id = v_appt.id
    returning * into v_appt;
  exception when exclusion_violation then
    raise exception 'slot_taken' using errcode = '23P01';
  end;

  return jsonb_build_object('appointment_id', v_appt.id, 'provider_id', v_appt.provider_id,
    'service_id', v_appt.service_id, 'starts_at', v_appt.starts_at, 'ends_at', v_appt.ends_at,
    'status', v_appt.status, 'price', v_appt.price, 'notes', v_appt.notes);
end $$;

-- =====================================================================================
-- M3. Demo tenants: cap KB growth, freeze memberships for signed-in users
-- =====================================================================================
create or replace function public._tenant_is_demo(p_tenant_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$ select coalesce((select t.is_demo from public.tenants t where t.id = p_tenant_id), false) $$;

-- Security INVOKER on purpose: current_user is the caller (authenticated / anon via PostgREST).
-- service_role, postgres and SECURITY DEFINER functions (reset_demo) are not blocked.
create or replace function public.trg_demo_memberships_readonly()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated','anon') then
    if tg_op in ('UPDATE','DELETE') and public._tenant_is_demo(old.tenant_id) then
      raise exception 'demo_readonly' using errcode = '42501';
    end if;
    if tg_op in ('INSERT','UPDATE') and public._tenant_is_demo(new.tenant_id) then
      raise exception 'demo_readonly' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists demo_memberships_readonly on public.memberships;
create trigger demo_memberships_readonly before insert or update or delete on public.memberships
  for each row execute function public.trg_demo_memberships_readonly();

-- AFTER trigger so a multi-row INSERT is counted as a whole. arg0 = cap per demo tenant.
create or replace function public.trg_demo_kb_cap()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare v_n int;
begin
  if public._tenant_is_demo(new.tenant_id) then
    execute format('select count(*) from public.%I where tenant_id = $1', tg_table_name)
      into v_n using new.tenant_id;
    if v_n > tg_argv[0]::int then
      raise exception 'demo_limit' using errcode = '54000';
    end if;
  end if;
  return null;
end $$;

drop trigger if exists demo_kb_chunks_cap on public.kb_chunks;
create trigger demo_kb_chunks_cap after insert on public.kb_chunks
  for each row execute function public.trg_demo_kb_cap(200);
drop trigger if exists demo_kb_documents_cap on public.kb_documents;
create trigger demo_kb_documents_cap after insert on public.kb_documents
  for each row execute function public.trg_demo_kb_cap(20);

-- =====================================================================================
-- H2. Demo seed / reset (seed_demo now self-heals; same body as migration 08 otherwise)
-- =====================================================================================
create or replace function public.seed_demo()
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_clinic uuid := 'd0000000-0000-4000-8000-000000000001';
  v_salon  uuid := 'd0000000-0000-4000-8000-000000000002';
  t        record;
  pr       record;
  v_times  time[];
  v_svc    public.services;
  v_svc_id uuid;
  v_cnt    int;
  v_cust   uuid;
  v_start  timestamptz;
  v_status text;
  v_appt   uuid;
  v_price  numeric;
  d        int;
  i        int;
begin
  -- Self-healing: never trust partial / defaced demo data. Wipe every demo tenant (cascades) and
  -- anything sitting on the two fixed demo ids, then seed from scratch.
  delete from public.tenants where is_demo or id in (v_clinic, v_salon);

  insert into public.tenants (id, slug, name_ar, name_en, kind, deposit_enabled, deposit_type, deposit_value, brand_color, is_demo) values
    (v_clinic, 'demo-clinic', 'عيادة نبض لطب الأسنان', 'Nabd Dental Clinic', 'clinic', true,  'fixed', 50, '#0f766e', true),
    (v_salon,  'demo-salon',  'صالون لمسة للسيدات',    'Lamsa Ladies Salon', 'salon',  false, 'fixed', 0,  '#be185d', true);

  -- ---- services (SAR) ----
  insert into public.services (id, tenant_id, name_ar, name_en, description_ar, duration_min, buffer_min, price) values
    ('e1000000-0000-4000-8000-000000000001', v_clinic, 'كشف وفحص',            'Check-up & Exam',        'فحص شامل للأسنان مع التشخيص',            30, 10, 150),
    ('e1000000-0000-4000-8000-000000000002', v_clinic, 'تنظيف الأسنان',       'Teeth Cleaning',         'إزالة الجير والتلميع',                    45, 10, 300),
    ('e1000000-0000-4000-8000-000000000003', v_clinic, 'حشو تجميلي',          'Cosmetic Filling',       'حشوة بلون السن الطبيعي',                  60, 10, 450),
    ('e1000000-0000-4000-8000-000000000004', v_clinic, 'تبييض الأسنان',       'Teeth Whitening',        'جلسة تبييض بالليزر',                      60, 10, 900),
    ('e1000000-0000-4000-8000-000000000005', v_clinic, 'علاج قناة الجذر',     'Root Canal Treatment',   'علاج العصب تحت التخدير الموضعي',          90, 10, 1200),
    ('e1000000-0000-4000-8000-000000000006', v_clinic, 'استشارة تقويم',       'Orthodontic Consultation','تقييم الحالة وخطة العلاج',                30, 10, 200),
    ('e2000000-0000-4000-8000-000000000001', v_salon,  'قص وتصفيف',           'Cut & Style',            'قص حسب الطلب مع سشوار',                   45, 10, 120),
    ('e2000000-0000-4000-8000-000000000002', v_salon,  'صبغة شعر',            'Hair Colour',            'صبغة كاملة مع العناية',                   120, 10, 450),
    ('e2000000-0000-4000-8000-000000000003', v_salon,  'علاج كيراتين',        'Keratin Treatment',      'علاج لفرد الشعر وتنعيمه',                 150, 10, 800),
    ('e2000000-0000-4000-8000-000000000004', v_salon,  'مكياج سهرة',          'Evening Makeup',         'مكياج كامل للمناسبات',                    60, 10, 350),
    ('e2000000-0000-4000-8000-000000000005', v_salon,  'مانيكير وباديكير',    'Manicure & Pedicure',    'عناية كاملة بالأظافر',                    75, 10, 180),
    ('e2000000-0000-4000-8000-000000000006', v_salon,  'حمام مغربي',          'Moroccan Bath',          'جلسة استرخاء وتنظيف للبشرة',              60, 10, 250);

  -- ---- providers (user_id links to demo auth users when present) ----
  insert into public.providers (id, tenant_id, user_id, name_ar, name_en, title_ar, title_en) values
    ('f1000000-0000-4000-8000-000000000001', v_clinic, (select id from auth.users where id = 'a0000000-0000-4000-8000-000000000003'),
       'د. سلمى الحارثي', 'Dr. Salma Al-Harithi', 'استشارية طب الأسنان العام', 'General Dentistry Consultant'),
    ('f1000000-0000-4000-8000-000000000002', v_clinic, null, 'د. ماجد الدوسري', 'Dr. Majed Al-Dosari', 'أخصائي علاج الجذور', 'Endodontist'),
    ('f1000000-0000-4000-8000-000000000003', v_clinic, null, 'د. نورة العتيبي', 'Dr. Noura Al-Otaibi', 'أخصائية تقويم الأسنان', 'Orthodontist'),
    ('f2000000-0000-4000-8000-000000000001', v_salon,  (select id from auth.users where id = 'a0000000-0000-4000-8000-000000000006'),
       'ليان المطيري', 'Layan Al-Mutairi', 'مصففة شعر رئيسية', 'Senior Hair Stylist'),
    ('f2000000-0000-4000-8000-000000000002', v_salon,  null, 'هيفاء الشمري', 'Haifa Al-Shammari', 'خبيرة مكياج', 'Makeup Artist'),
    ('f2000000-0000-4000-8000-000000000003', v_salon,  null, 'دانة الزهراني', 'Dana Al-Zahrani', 'أخصائية عناية', 'Spa & Nails Specialist');

  insert into public.provider_services (tenant_id, provider_id, service_id)
  select case when p like 'f1%' then v_clinic else v_salon end, p::uuid, s::uuid
  from (values
    ('f1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001'),
    ('f1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002'),
    ('f1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000003'),
    ('f1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000004'),
    ('f1000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000001'),
    ('f1000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000003'),
    ('f1000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000005'),
    ('f1000000-0000-4000-8000-000000000003','e1000000-0000-4000-8000-000000000001'),
    ('f1000000-0000-4000-8000-000000000003','e1000000-0000-4000-8000-000000000006'),
    ('f2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001'),
    ('f2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000002'),
    ('f2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000003'),
    ('f2000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000001'),
    ('f2000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000004'),
    ('f2000000-0000-4000-8000-000000000003','e2000000-0000-4000-8000-000000000005'),
    ('f2000000-0000-4000-8000-000000000003','e2000000-0000-4000-8000-000000000006')
  ) v(p, s);

  -- ---- working hours (0 = Sunday) ----
  -- Clinic: Sun-Thu split shift; doctor 3 afternoons only. Salon: Sat-Thu 10:00-22:00 (stylist 3 from 14:00).
  insert into public.working_hours (tenant_id, provider_id, weekday, start_time, end_time)
  select v_clinic, p.id, w, s, e
  from public.providers p
  cross join generate_series(0, 4) w
  cross join (values ('09:00'::time, '13:00'::time), ('16:00'::time, '21:00'::time)) sh(s, e)
  where p.tenant_id = v_clinic and not (p.id = 'f1000000-0000-4000-8000-000000000003' and s = '09:00'::time);

  insert into public.working_hours (tenant_id, provider_id, weekday, start_time, end_time)
  select v_salon, p.id, w, case when p.id = 'f2000000-0000-4000-8000-000000000003' then '14:00'::time else '10:00'::time end, '22:00'::time
  from public.providers p
  cross join (values (0),(1),(2),(3),(4),(6)) x(w)
  where p.tenant_id = v_salon;

  -- one upcoming day off so availability visibly differs
  insert into public.time_off (tenant_id, provider_id, starts_at, ends_at, reason)
  values (v_clinic, 'f1000000-0000-4000-8000-000000000002',
          ((current_date + 10) + time '00:00') at time zone 'Asia/Riyadh',
          ((current_date + 11) + time '00:00') at time zone 'Asia/Riyadh', 'إجازة / Leave');

  -- ---- customers (fictional) ----
  insert into public.customers (tenant_id, full_name, phone, email, locale)
  select v_clinic, n, '05000010' || lpad(idx::text, 2, '0'), 'patient' || idx || '@example.com', 'ar'
  from unnest(array['فهد الراشد','منال السبيعي','عبدالله القرني','هند الغامدي','تركي العنزي',
                    'أمل الشهري','سعود البقمي','لجين الحربي','ياسر المالكي','جود الخالدي']) with ordinality as u(n, idx);
  insert into public.customers (tenant_id, full_name, phone, email, locale)
  select v_salon, n, '05000020' || lpad(idx::text, 2, '0'), 'client' || idx || '@example.com', 'ar'
  from unnest(array['شهد الدوسري','رهف الجهني','غدير العمري','أريج السلمي','ملاك الشريف',
                    'رزان البلوي','عهود القحطاني','لمى الأحمدي','سديم الفيفي','تالا العسيري']) with ordinality as u(n, idx);

  -- ---- appointments: today-7 .. today+7 (only slots that are valid per working hours / services) ----
  for t in select id, timezone, kind, deposit_enabled, deposit_value from public.tenants where id in (v_clinic, v_salon) loop
    v_times := case when t.kind = 'clinic'
                    then array['09:30','11:30','17:00','19:00']::time[]
                    else array['10:00','13:00','16:00','19:00']::time[] end;
    for pr in select p.id as pid, (row_number() over (order by p.id))::int as rn
              from public.providers p where p.tenant_id = t.id loop
      select count(*) into v_cnt from public.provider_services where provider_id = pr.pid;
      for d in -7..7 loop
        for i in 1..array_length(v_times, 1) loop
          v_start := ((current_date + d) + v_times[i]) at time zone t.timezone;
          select ps.service_id into v_svc_id from public.provider_services ps
            where ps.provider_id = pr.pid order by ps.service_id
            offset ((d + 7) * 4 + i + pr.rn) % v_cnt limit 1;
          select * into v_svc from public.services where id = v_svc_id;
          continue when not public._slot_is_free(t.id, pr.pid, v_start, v_svc.duration_min, v_svc.buffer_min);

          select id into v_cust from public.customers where tenant_id = t.id
            order by phone offset ((d + 7) * 7 + i * 3 + pr.rn) % 10 limit 1;

          if v_start < now() then
            v_status := case when (d + i + pr.rn) % 9 = 0 then 'cancelled'
                              when (d + i + pr.rn) % 7 = 0 then 'no_show'
                              else 'completed' end;
          else
            v_status := case when (d + i + pr.rn) % 11 = 0 then 'cancelled' else 'confirmed' end;
          end if;

          insert into public.appointments (tenant_id, provider_id, service_id, customer_id, starts_at, ends_at, status, source, price)
          values (t.id, pr.pid, v_svc.id, v_cust, v_start, v_start + make_interval(mins => v_svc.duration_min),
                  v_status, (array['web','chat','staff'])[1 + i % 3], v_svc.price)
          returning id into v_appt;

          -- revenue: completed = full price paid; future confirmed in a deposit tenant = deposit paid
          v_price := case when v_status = 'completed' then v_svc.price
                          when v_status = 'confirmed' and t.deposit_enabled then least(t.deposit_value, v_svc.price)
                          else null end;
          if v_price is not null then
            insert into public.payments (tenant_id, appointment_id, amount, status, provider, provider_ref)
            values (t.id, v_appt, v_price, 'paid', 'moyasar', 'demo_' || v_appt);
          end if;

          if v_status = 'confirmed' then
            insert into public.reminders (tenant_id, appointment_id, kind, send_at, status)
            select t.id, v_appt, k.kind, v_start - k.lead,
                   case when v_start - k.lead > now() then 'pending' else 'skipped' end
            from (values ('24h', interval '24 hours'), ('2h', interval '2 hours')) k(kind, lead);
          end if;
        end loop;
      end loop;
    end loop;
  end loop;

  -- ---- knowledge base (embeddings are filled by the app's ingestion step) ----
  insert into public.kb_documents (id, tenant_id, title, source_type, content) values
    ('ab000000-0000-4000-8000-000000000001', v_clinic, 'الأسئلة الشائعة', 'faq', 'أسئلة شائعة عن العيادة'),
    ('ab000000-0000-4000-8000-000000000002', v_salon,  'الأسئلة الشائعة', 'faq', 'أسئلة شائعة عن الصالون');
  insert into public.kb_chunks (tenant_id, document_id, chunk_index, content) values
    (v_clinic, 'ab000000-0000-4000-8000-000000000001', 0, 'ساعات العمل: من الأحد إلى الخميس، من 9 صباحاً إلى 1 ظهراً ومن 4 عصراً إلى 9 مساءً. الجمعة والسبت إجازة.'),
    (v_clinic, 'ab000000-0000-4000-8000-000000000001', 1, 'العربون 50 ريال يُخصم من قيمة الخدمة، ويُلغى الحجز تلقائياً إذا لم يتم الدفع خلال 15 دقيقة.'),
    (v_clinic, 'ab000000-0000-4000-8000-000000000001', 2, 'نقبل التأمين الطبي من عدة شركات، يرجى إحضار البطاقة عند الحضور.'),
    (v_salon,  'ab000000-0000-4000-8000-000000000002', 0, 'ساعات العمل: من السبت إلى الخميس من 10 صباحاً حتى 10 مساءً، والجمعة إجازة.'),
    (v_salon,  'ab000000-0000-4000-8000-000000000002', 1, 'يمكن إلغاء الحجز أو تأجيله قبل الموعد بساعتين على الأقل.'),
    (v_salon,  'ab000000-0000-4000-8000-000000000002', 2, 'نوفر باقات للعروس تشمل المكياج والشعر والعناية بالأظافر، اسألي عن العروض الحالية.');

  -- ---- conversations ----
  insert into public.conversations (id, tenant_id, customer_id, channel, external_id, started_at, last_message_at)
  select v.id::uuid, v.tid, (select c.id from public.customers c where c.tenant_id = v.tid and c.phone = v.phone),
         'web', 'demo-session-' || right(v.id, 4), now() - v.ago, now() - v.ago
  from (values
    ('cc000000-0000-4000-8000-000000000001', v_clinic, '0500001001', interval '1 day'),
    ('cc000000-0000-4000-8000-000000000002', v_clinic, '0500001002', interval '3 hours'),
    ('cc000000-0000-4000-8000-000000000003', v_clinic, '0500001003', interval '2 days'),
    ('cc000000-0000-4000-8000-000000000011', v_salon,  '0500002001', interval '1 day'),
    ('cc000000-0000-4000-8000-000000000012', v_salon,  '0500002002', interval '5 hours'),
    ('cc000000-0000-4000-8000-000000000013', v_salon,  '0500002003', interval '2 days')
  ) v(id, tid, phone, ago);

  insert into public.messages (tenant_id, conversation_id, role, content, created_at)
  select c.tenant_id, c.id, m.role, m.content, c.started_at + (m.seq * interval '40 seconds')
  from (values
    ('cc000000-0000-4000-8000-000000000001', 1, 'user',      'السلام عليكم، أبغى أحجز موعد تنظيف أسنان'),
    ('cc000000-0000-4000-8000-000000000001', 2, 'assistant', 'وعليكم السلام ورحمة الله. تنظيف الأسنان مدته 45 دقيقة وسعره 300 ريال. أي يوم يناسبك؟'),
    ('cc000000-0000-4000-8000-000000000001', 3, 'user',      'الأحد القادم مساءً'),
    ('cc000000-0000-4000-8000-000000000001', 4, 'assistant', 'متاح الأحد الساعة 5:00 م و7:00 م مع د. سلمى الحارثي. أيهما تفضل؟'),
    ('cc000000-0000-4000-8000-000000000001', 5, 'user',      '5 مساءً'),
    ('cc000000-0000-4000-8000-000000000001', 6, 'assistant', 'تم تجهيز الحجز. يرجى دفع العربون 50 ريال خلال 15 دقيقة لتأكيده.'),
    ('cc000000-0000-4000-8000-000000000002', 1, 'user',      'كم سعر تبييض الأسنان؟'),
    ('cc000000-0000-4000-8000-000000000002', 2, 'assistant', 'جلسة تبييض الأسنان بالليزر 900 ريال وتستغرق ساعة تقريباً. تحب أشوف لك أقرب موعد؟'),
    ('cc000000-0000-4000-8000-000000000003', 1, 'user',      'هل تقبلون التأمين الطبي؟'),
    ('cc000000-0000-4000-8000-000000000003', 2, 'assistant', 'نعم، نقبل التأمين من عدة شركات. يرجى إحضار البطاقة عند الحضور.'),
    ('cc000000-0000-4000-8000-000000000011', 1, 'user',      'مرحباً، أبغى مكياج سهرة يوم الخميس'),
    ('cc000000-0000-4000-8000-000000000011', 2, 'assistant', 'أهلاً بك. مكياج السهرة مدته ساعة وسعره 350 ريال مع هيفاء الشمري. أي وقت يناسبك الخميس؟'),
    ('cc000000-0000-4000-8000-000000000011', 3, 'user',      'الساعة 6 مساءً'),
    ('cc000000-0000-4000-8000-000000000011', 4, 'assistant', 'تم تأكيد حجزك الخميس الساعة 6:00 م مع هيفاء. نذكرك قبل الموعد بيوم.'),
    ('cc000000-0000-4000-8000-000000000012', 1, 'user',      'عندكم عروض للعروس؟'),
    ('cc000000-0000-4000-8000-000000000012', 2, 'assistant', 'نوفر باقات للعروس تشمل المكياج والشعر والأظافر. تحبين أحجز لك موعد استشارة؟'),
    ('cc000000-0000-4000-8000-000000000013', 1, 'user',      'أبغى أأجل موعدي لبكرة'),
    ('cc000000-0000-4000-8000-000000000013', 2, 'assistant', 'أكيد، تقدرين تأجلين من صفحة مواعيدي عبر الرابط المرسل لك، أو أساعدك هنا. أي وقت تفضلين بكرة؟')
  ) m(conv, seq, role, content)
  join public.conversations c on c.id = m.conv::uuid;

  -- ---- demo memberships (only for demo auth users that exist) ----
  insert into public.memberships (user_id, tenant_id, role)
  select u.id, v.tid, v.role
  from (values
    ('a0000000-0000-4000-8000-000000000001', v_clinic, 'owner'),
    ('a0000000-0000-4000-8000-000000000002', v_clinic, 'receptionist'),
    ('a0000000-0000-4000-8000-000000000003', v_clinic, 'provider'),
    ('a0000000-0000-4000-8000-000000000004', v_salon,  'owner'),
    ('a0000000-0000-4000-8000-000000000005', v_salon,  'receptionist'),
    ('a0000000-0000-4000-8000-000000000006', v_salon,  'provider')
  ) v(uid, tid, role)
  join auth.users u on u.id = v.uid::uuid;
end $$;


-- Wipes every demo tenant (is_demo OR the two fixed demo ids, so defacing is_demo does not help)
-- and re-seeds. Demo auth users are kept. Service role only.
create or replace function public.reset_demo()
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  delete from public.tenants
   where is_demo
      or id in ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002');
  perform public.seed_demo();
end $$;

-- =====================================================================================
-- H1. Grants: sensitive booking functions are service-role only
-- =====================================================================================
revoke all on function
  public.create_public_booking(uuid, uuid, uuid, timestamptz, text, text, text, text, text),
  public.customer_get_appointments(text),
  public.customer_cancel_appointment(text, uuid),
  public.customer_reschedule_appointment(text, uuid, timestamptz),
  public.get_available_slots(uuid, uuid, uuid, date, date, int),
  public.issue_customer_magic_link(uuid, text),
  public.staff_get_available_slots(uuid, uuid, uuid, date, date, int),
  public.staff_update_appointment(uuid, timestamptz, uuid, uuid, text, text),
  public._tenant_is_demo(uuid)
from public, anon, authenticated;

grant execute on function
  public.create_public_booking(uuid, uuid, uuid, timestamptz, text, text, text, text, text),
  public.customer_get_appointments(text),
  public.customer_cancel_appointment(text, uuid),
  public.customer_reschedule_appointment(text, uuid, timestamptz),
  public.get_available_slots(uuid, uuid, uuid, date, date, int),
  public.issue_customer_magic_link(uuid, text),
  public.staff_get_available_slots(uuid, uuid, uuid, date, date, int),
  public.staff_update_appointment(uuid, timestamptz, uuid, uuid, text, text),
  public._tenant_is_demo(uuid)
to service_role;

-- members-only (tenant membership checked inside)
grant execute on function
  public.staff_get_available_slots(uuid, uuid, uuid, date, date, int),
  public.staff_update_appointment(uuid, timestamptz, uuid, uuid, text, text)
to authenticated;
-- needed by the invoker trigger on memberships
grant execute on function public._tenant_is_demo(uuid) to authenticated;

revoke all on function public.trg_demo_memberships_readonly(), public.trg_demo_kb_cap() from public, anon, authenticated;

comment on function public.create_public_booking(uuid, uuid, uuid, timestamptz, text, text, text, text, text)
  is 'service_role only. Call after check_rate_limit(). Never modifies an existing customer; customer_token only for newly created customers. Errors: too_far, too_many_bookings, slot_taken (23P01), invalid_*.';
comment on function public.get_available_slots(uuid, uuid, uuid, date, date, int)
  is 'service_role only (public booking page via the Next.js server, after check_rate_limit). Staff dashboard uses staff_get_available_slots.';
comment on function public.customer_get_appointments(text) is 'service_role only. Token must be unexpired.';
comment on function public.customer_cancel_appointment(text, uuid) is 'service_role only. Token must be unexpired.';
comment on function public.customer_reschedule_appointment(text, uuid, timestamptz)
  is 'service_role only. Errors: appointment_not_found, too_far, too_many_bookings, slot_taken.';
comment on function public.issue_customer_magic_link(uuid, text)
  is 'service_role only. Rotates the customer token (30 day expiry) and returns it; null if no such customer. Send it to the contact on file, never to the requester.';
comment on function public.staff_get_available_slots(uuid, uuid, uuid, date, date, int)
  is $q$authenticated owner/receptionist of p_tenant_id (membership checked via auth_tenant_role). service_role has no user, use get_available_slots.$q$;
comment on function public.staff_update_appointment(uuid, timestamptz, uuid, uuid, text, text)
  is 'authenticated owner/receptionist of the appointment tenant. Reschedule / reassign / change service / status / notes.';
comment on function public.public_get_tenant(text) is 'anon, authenticated, service_role (public booking page data).';
comment on function public.public_list_services(uuid) is 'anon, authenticated, service_role.';
comment on function public.public_list_providers(uuid, uuid) is 'anon, authenticated, service_role.';
comment on function public.check_rate_limit(text, int, interval) is 'service_role only.';
comment on function public.expire_pending_bookings() is 'service_role / pg_cron (every minute) / called inside booking functions.';
comment on function public.seed_demo() is 'service_role only. Wipes demo tenants and re-seeds (self-healing).';
comment on function public.reset_demo() is 'service_role only. Daily demo reset.';

-- =====================================================================================
-- M2. Expire unpaid holds every minute (pg_cron ships with Supabase, incl. the free tier)
-- =====================================================================================
-- If the extension cannot be enabled (older local images), call expire_pending_bookings()
-- from an external scheduler (e.g. Vercel Cron -> service-role RPC) instead. Booking and
-- reschedule already call it first, and _slot_is_free ignores expired holds, so correctness
-- does not depend on the schedule.
do $$
begin
  create extension if not exists pg_cron with schema pg_catalog;
  perform cron.schedule('dawrak_expire_pending', '* * * * *', 'select public.expire_pending_bookings()');
exception when others then
  raise notice 'pg_cron not available (%): schedule public.expire_pending_bookings() externally', sqlerrm;
end $$;
