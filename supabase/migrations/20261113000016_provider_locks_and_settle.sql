-- Race fix + L1 (part 2).
--
-- RACE: two concurrent create_public_booking calls for the same provider and slot could end in a
-- Postgres deadlock (40P01) instead of slot_taken: both insert an overlapping appointment, each
-- waits for the other's uncommitted exclusion-constraint conflict. Every path that can take or move
-- a provider's slot now first takes a transaction-level advisory lock for that provider.
--
-- LOCK ORDER (everywhere): 1) provider advisory lock(s) (two providers: smaller uuid text first)
--                          2) customer row / payment row
--                          3) appointment rows
-- expire_pending_bookings() uses SKIP LOCKED, so it never waits and cannot close a cycle.

create or replace function public._lock_provider(p_provider_id uuid)
returns void
language sql volatile
set search_path = ''
as $$ select pg_advisory_xact_lock(hashtextextended(p_provider_id::text, 0)) $$;
revoke all on function public._lock_provider(uuid) from public, anon, authenticated;
grant execute on function public._lock_provider(uuid) to service_role;
-- staff_update_appointment is SECURITY DEFINER (owner postgres), so authenticated needs no grant.

-- ---------- create_public_booking: same as migration 10 + provider lock first ----------
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
  perform public._lock_provider(p_provider_id);   -- serialise bookings per provider, before any row lock

  if p_source not in ('web','chat') then raise exception 'invalid_source'; end if;
  if char_length(v_name) < 2 or char_length(v_name) > 100 then raise exception 'invalid_name'; end if;
  if v_phone !~ '^\+?[0-9]{7,15}$' then raise exception 'invalid_phone'; end if;
  if p_email is not null and (char_length(p_email) > 200 or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'invalid_email';
  end if;

  perform public.expire_pending_bookings();

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

  insert into public.customers (tenant_id, full_name, phone, email, locale)
  values (p_tenant_id, v_name, v_phone, p_email, case when p_locale = 'en' then 'en' else 'ar' end)
  on conflict (tenant_id, phone) do nothing
  returning * into v_customer;
  v_new := found;
  if not v_new then
    select * into v_customer from public.customers where tenant_id = p_tenant_id and phone = v_phone;
  end if;

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

-- ---------- customer_reschedule_appointment: find the provider, lock it, then lock the row ----------
create or replace function public.customer_reschedule_appointment(p_token text, p_appointment_id uuid, p_new_starts_at timestamptz)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_appt public.appointments;
  v_svc  public.services;
  v_prov uuid;
begin
  select a.provider_id into v_prov
  from public.appointments a
  join public.customers c on c.id = a.customer_id and c.tenant_id = a.tenant_id
  where a.id = p_appointment_id and c.access_token = p_token and length(p_token) >= 32
    and c.access_token_expires_at > now();
  if not found then raise exception 'appointment_not_found'; end if;
  perform public._lock_provider(v_prov);           -- before the row lock below

  perform public.expire_pending_bookings();

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

-- ---------- staff_update_appointment: lock old and new provider (sorted), then the row ----------
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
  v_old    uuid;
begin
  -- membership is checked below, under the lock. Two providers are locked in a fixed (text) order.
  select provider_id into v_old from public.appointments where id = p_appointment_id;
  if found then
    if p_provider_id is not null and p_provider_id <> v_old then
      perform public._lock_provider(case when v_old::text < p_provider_id::text then v_old else p_provider_id end);
      perform public._lock_provider(case when v_old::text < p_provider_id::text then p_provider_id else v_old end);
    else
      perform public._lock_provider(v_old);
    end if;
  end if;

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
           cancel_reason = case when v_status = 'cancelled' then coalesce(cancel_reason, 'staff') else null end,
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

-- ---------- settle_payment: revive only a lapsed hold (cancel_reason = payment_expired) ----------
-- Outcomes unchanged, plus: a payment for an appointment the customer or staff cancelled on purpose
-- (or any cancelled row without the payment_expired reason) becomes refund_due with
-- review_reason 'appointment_cancelled' and the appointment stays cancelled.
create or replace function public.settle_payment(
  p_payment_id          uuid,
  p_provider            text,
  p_event_id            text,
  p_event_type          text,
  p_outcome             text,
  p_provider_payment_id text,
  p_amount_minor        bigint,
  p_currency            text
) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_pay    public.payments%rowtype;
  v_appt   public.appointments%rowtype;
  v_res    text;
  v_reason text := 'slot_unavailable_after_payment';
  v_prov   uuid;
begin
  if p_outcome not in ('paid','failed') then raise exception 'invalid_outcome'; end if;

  -- provider lock first (the revive path competes with public bookings for the slot)
  select a.provider_id into v_prov
    from public.payments p join public.appointments a on a.id = p.appointment_id and a.tenant_id = p.tenant_id
   where p.id = p_payment_id;
  if v_prov is not null then perform public._lock_provider(v_prov); end if;

  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found then return 'not_found'; end if;

  insert into public.payment_events (provider, event_id, tenant_id, payment_id, type)
  values (p_provider, p_event_id, v_pay.tenant_id, v_pay.id, left(p_event_type, 64))
  on conflict (provider, event_id) do nothing;
  if not found then return 'duplicate'; end if;

  if p_outcome = 'failed' then
    if v_pay.status = 'pending' then
      update public.payments set status = 'failed', provider_payment_id = coalesce(provider_payment_id, p_provider_payment_id)
       where id = v_pay.id;
    end if;
    v_res := case when v_pay.status = 'paid' then 'already_paid' else 'failed' end;
    update public.payment_events set outcome = v_res where provider = p_provider and event_id = p_event_id;
    return v_res;
  end if;

  if v_pay.status in ('paid','refund_due','refunded') then
    update public.payment_events set outcome = 'already_paid' where provider = p_provider and event_id = p_event_id;
    return 'already_paid';
  end if;

  if p_amount_minor is distinct from round(v_pay.amount * 100)::bigint
     or upper(coalesce(p_currency, '')) <> upper(v_pay.currency) then
    update public.payments
       set status = 'refund_due', review_reason = 'amount_mismatch',
           provider_payment_id = coalesce(provider_payment_id, p_provider_payment_id), paid_at = now()
     where id = v_pay.id;
    update public.payment_events set outcome = 'amount_mismatch' where provider = p_provider and event_id = p_event_id;
    return 'amount_mismatch';
  end if;

  select * into v_appt from public.appointments
   where id = v_pay.appointment_id and tenant_id = v_pay.tenant_id for update;

  if v_appt.status = 'pending_payment' then
    update public.appointments set status = 'confirmed', payment_expires_at = null where id = v_appt.id;
    v_res := 'confirmed';
  elsif v_appt.status = 'cancelled' and v_appt.cancel_reason = 'payment_expired' then
    -- the hold lapsed. Take the slot back; the exclusion constraint refuses if it was re-booked.
    begin
      update public.appointments set status = 'confirmed', payment_expires_at = null where id = v_appt.id;
      v_res := 'confirmed_after_expiry';
    exception when exclusion_violation then
      v_res := 'refund_due';
    end;
  elsif v_appt.status = 'cancelled' then
    v_res := 'refund_due';                    -- cancelled on purpose (customer / staff): never revived
    v_reason := 'appointment_cancelled';
  else
    v_res := 'refund_due';   -- confirmed/completed/no_show already: the money has no booking to pay for
  end if;

  if v_res = 'refund_due' then
    update public.payments
       set status = 'refund_due', review_reason = v_reason,
           provider_payment_id = coalesce(provider_payment_id, p_provider_payment_id), paid_at = now()
     where id = v_pay.id;
  else
    update public.payments
       set status = 'paid', provider_payment_id = coalesce(provider_payment_id, p_provider_payment_id), paid_at = now()
     where id = v_pay.id;
  end if;
  update public.payment_events set outcome = v_res where provider = p_provider and event_id = p_event_id;
  return v_res;
end $$;
