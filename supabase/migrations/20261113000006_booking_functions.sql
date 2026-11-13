-- Availability + the narrow public (anon) surface for the booking page + customer token functions.
-- All security-definer functions pin search_path and are granted explicitly (see grants migration).

-- ---------- internal: is [p_start, p_start+duration) bookable for this provider? ----------
-- Checks: inside a working-hours window (tenant timezone), no time off, no overlapping
-- appointment (an existing appointment also blocks its service's buffer_min after it).
create or replace function public._slot_is_free(
  p_tenant_id uuid, p_provider_id uuid, p_start timestamptz,
  p_duration_min int, p_buffer_min int, p_exclude_appointment uuid default null)
returns boolean
language sql stable security definer
set search_path = public, extensions
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
        and a.id is distinct from p_exclude_appointment
        and tstzrange(a.starts_at, a.ends_at + make_interval(mins => s.buffer_min), '[)')
            && tstzrange(p_start, p_start + make_interval(mins => p_duration_min + p_buffer_min), '[)')
    )
$$;

-- ---------- get_available_slots ----------
-- p_provider_id null = every active provider offering the service.
-- p_date_from/p_date_to are calendar dates in the tenant's timezone (range capped at 61 days).
-- weekday 0 = Sunday (extract(dow)).
create or replace function public.get_available_slots(
  p_tenant_id uuid, p_provider_id uuid, p_service_id uuid,
  p_date_from date, p_date_to date, p_step_min int default 15)
returns table (slot_provider_id uuid, slot_start timestamptz, slot_end timestamptz)
language sql stable security definer
set search_path = public, extensions
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
    and public._slot_is_free(t.id, p.id, g.s, sv.duration_min, sv.buffer_min)
  order by g.s, p.id
$$;

-- ---------- public read functions for the booking page (anon) ----------
create or replace function public.public_get_tenant(p_slug text)
returns table (id uuid, slug text, name_ar text, name_en text, kind text, timezone text, currency text,
               deposit_enabled boolean, deposit_type text, deposit_value numeric,
               logo_url text, brand_color text, is_demo boolean)
language sql stable security definer
set search_path = public, extensions
as $$
  select t.id, t.slug, t.name_ar, t.name_en, t.kind, t.timezone, t.currency,
         t.deposit_enabled, t.deposit_type, t.deposit_value, t.logo_url, t.brand_color, t.is_demo
  from public.tenants t where t.slug = p_slug
$$;

create or replace function public.public_list_services(p_tenant_id uuid)
returns table (id uuid, name_ar text, name_en text, description_ar text, description_en text,
               duration_min int, price numeric)
language sql stable security definer
set search_path = public, extensions
as $$
  select s.id, s.name_ar, s.name_en, s.description_ar, s.description_en, s.duration_min, s.price
  from public.services s where s.tenant_id = p_tenant_id and s.is_active
  order by s.created_at, s.name_ar
$$;

create or replace function public.public_list_providers(p_tenant_id uuid, p_service_id uuid default null)
returns table (id uuid, name_ar text, name_en text, title_ar text, title_en text, bio_ar text, bio_en text, avatar_url text)
language sql stable security definer
set search_path = public, extensions
as $$
  select p.id, p.name_ar, p.name_en, p.title_ar, p.title_en, p.bio_ar, p.bio_en, p.avatar_url
  from public.providers p
  where p.tenant_id = p_tenant_id and p.is_active
    and (p_service_id is null or exists (
          select 1 from public.provider_services ps
          where ps.provider_id = p.id and ps.service_id = p_service_id and ps.tenant_id = p.tenant_id))
  order by p.created_at, p.name_ar
$$;

-- ---------- public booking (anon) ----------
-- Re-validates the slot server-side (working hours, time off, conflicts) and relies on the
-- exclusion constraint for races. Raises 'slot_taken' (SQLSTATE 23P01) when the slot is gone.
-- Callers should wrap it with check_rate_limit() (service role) before invoking.
create or replace function public.create_public_booking(
  p_tenant_id uuid, p_provider_id uuid, p_service_id uuid, p_starts_at timestamptz,
  p_full_name text, p_phone text, p_email text default null,
  p_source text default 'web', p_locale text default 'ar')
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
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
begin
  if p_source not in ('web','chat') then raise exception 'invalid_source'; end if;
  if char_length(v_name) < 2 or char_length(v_name) > 100 then raise exception 'invalid_name'; end if;
  if v_phone !~ '^\+?[0-9]{7,15}$' then raise exception 'invalid_phone'; end if;
  if p_email is not null and (char_length(p_email) > 200 or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'invalid_email';
  end if;

  select * into v_tenant from public.tenants where id = p_tenant_id;
  if not found then raise exception 'tenant_not_found'; end if;
  select * into v_service from public.services where id = p_service_id and tenant_id = p_tenant_id and is_active;
  if not found then raise exception 'service_not_found'; end if;
  if not exists (select 1 from public.provider_services ps
                 join public.providers p on p.id = ps.provider_id and p.tenant_id = ps.tenant_id and p.is_active
                 where ps.provider_id = p_provider_id and ps.service_id = p_service_id and ps.tenant_id = p_tenant_id) then
    raise exception 'provider_not_found';
  end if;

  if p_starts_at <= now()
     or not public._slot_is_free(p_tenant_id, p_provider_id, p_starts_at, v_service.duration_min, v_service.buffer_min) then
    raise exception 'slot_taken' using errcode = '23P01';
  end if;

  insert into public.customers (tenant_id, full_name, phone, email, locale)
  values (p_tenant_id, v_name, v_phone, p_email, case when p_locale = 'en' then 'en' else 'ar' end)
  on conflict (tenant_id, phone) do update
    set full_name = excluded.full_name,
        email = coalesce(excluded.email, public.customers.email)
  returning * into v_customer;

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
    'customer_token', v_customer.access_token);
end $$;

-- ---------- customer magic-link / token functions (anon) ----------
-- The token (customers.access_token) is the credential; it scopes everything to one customer.
create or replace function public.customer_get_appointments(p_token text)
returns table (id uuid, tenant_id uuid, tenant_slug text, tenant_name_ar text, tenant_name_en text,
               provider_name_ar text, provider_name_en text, service_name_ar text, service_name_en text,
               starts_at timestamptz, ends_at timestamptz, status text, price numeric)
language sql stable security definer
set search_path = public, extensions
as $$
  select a.id, a.tenant_id, t.slug, t.name_ar, t.name_en, p.name_ar, p.name_en, s.name_ar, s.name_en,
         a.starts_at, a.ends_at, a.status, a.price
  from public.customers c
  join public.appointments a on a.customer_id = c.id and a.tenant_id = c.tenant_id
  join public.tenants t on t.id = a.tenant_id
  join public.providers p on p.id = a.provider_id
  join public.services s on s.id = a.service_id
  where c.access_token = p_token and length(p_token) >= 32
  order by a.starts_at desc
$$;

create or replace function public.customer_cancel_appointment(p_token text, p_appointment_id uuid)
returns boolean
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare v_n int;
begin
  update public.appointments a set status = 'cancelled'
  from public.customers c
  where a.id = p_appointment_id and c.id = a.customer_id and c.tenant_id = a.tenant_id
    and c.access_token = p_token and length(p_token) >= 32
    and a.status in ('pending_payment','confirmed') and a.starts_at > now();
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

create or replace function public.customer_reschedule_appointment(p_token text, p_appointment_id uuid, p_new_starts_at timestamptz)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_appt public.appointments;
  v_svc  public.services;
begin
  select a.* into v_appt
  from public.appointments a
  join public.customers c on c.id = a.customer_id and c.tenant_id = a.tenant_id
  where a.id = p_appointment_id and c.access_token = p_token and length(p_token) >= 32
    and a.status in ('pending_payment','confirmed') and a.starts_at > now()
  for update of a;
  if not found then raise exception 'appointment_not_found'; end if;

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
