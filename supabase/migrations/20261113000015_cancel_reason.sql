-- L1 (part 1): remember WHY an appointment was cancelled, so settle_payment can tell a lapsed
-- payment hold (revivable) from a cancellation somebody chose (never revived).
--   payment_expired : expire_pending_bookings() cancelled an unpaid hold
--   customer        : customer_cancel_appointment()
--   staff           : staff_update_appointment() or any other path (default for an unlabelled cancel)
-- NULL on a cancelled row (seed data, rows created before this migration) means "not a lapsed hold":
-- it is never revived.

alter table public.appointments add column if not exists cancel_reason text;
alter table public.appointments drop constraint if exists appointments_cancel_reason_check;
alter table public.appointments add constraint appointments_cancel_reason_check
  check (cancel_reason is null or cancel_reason in ('payment_expired','customer','staff'));

-- Keeps the column honest whichever path changes the status (including direct PostgREST updates,
-- which cannot set cancel_reason themselves: it is not in authenticated's update grant).
create or replace function public.trg_appointment_cancel_reason()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'cancelled' then
    new.cancel_reason := null;
  elsif old.status <> 'cancelled' and new.cancel_reason is null then
    new.cancel_reason := 'staff';
  end if;
  return new;
end $$;
revoke all on function public.trg_appointment_cancel_reason() from public, anon, authenticated;

drop trigger if exists appointments_cancel_reason on public.appointments;
create trigger appointments_cancel_reason before update of status on public.appointments
  for each row execute function public.trg_appointment_cancel_reason();

-- Cancels unpaid holds whose window passed. Rows are claimed with FOR UPDATE SKIP LOCKED in id order,
-- so two concurrent callers (cron + a booking) never wait on each other's rows (no deadlock cycle).
create or replace function public.expire_pending_bookings()
returns int
language plpgsql volatile security definer
set search_path = ''
as $$
declare v_n int;
begin
  with due as (
    select id from public.appointments
     where status = 'pending_payment' and payment_expires_at is not null and payment_expires_at < now()
     order by id
     for update skip locked
  )
  update public.appointments a
     set status = 'cancelled', cancel_reason = 'payment_expired'
    from due
   where a.id = due.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.customer_cancel_appointment(p_token text, p_appointment_id uuid)
returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare v_n int;
begin
  update public.appointments a set status = 'cancelled', cancel_reason = 'customer'
  from public.customers c
  where a.id = p_appointment_id and c.id = a.customer_id and c.tenant_id = a.tenant_id
    and c.access_token = p_token and length(p_token) >= 32 and c.access_token_expires_at > now()
    and a.status in ('pending_payment','confirmed') and a.starts_at > now();
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;
