-- Demo abuse protection. Additive; earlier migrations untouched.
--  1. Demo tenants: presentation/identity columns are frozen for signed-in users (demo_readonly, 42501).
--     Deposit settings (deposit_enabled/type/value) stay editable: harmless and CHECK-bounded.
--  2. Per-tenant row caps on demo tenants (demo_limit, 54000).
--  3. Length limits on free text (all tenants).
-- Enforcement applies to every caller except postgres/supabase_admin, so seed_demo()/reset_demo()
-- (SECURITY DEFINER, owned by postgres) and migrations are never blocked. service_role IS capped,
-- because public bookings (create_public_booking) create customers/appointments through it.

-- ---------- 1. tenants ----------
create or replace function public.trg_demo_tenants_readonly()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated','anon') then
    if new.is_demo is distinct from old.is_demo then
      raise exception 'demo_readonly' using errcode = '42501';
    end if;
    if old.is_demo and (
         new.name_ar     is distinct from old.name_ar
      or new.name_en     is distinct from old.name_en
      or new.logo_url    is distinct from old.logo_url
      or new.brand_color is distinct from old.brand_color
      or new.slug        is distinct from old.slug
      or new.kind        is distinct from old.kind
      or new.timezone    is distinct from old.timezone
      or new.currency    is distinct from old.currency) then
      raise exception 'demo_readonly' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists demo_tenants_readonly on public.tenants;
create trigger demo_tenants_readonly before update on public.tenants
  for each row execute function public.trg_demo_tenants_readonly();

-- ---------- 2. caps ----------
-- AFTER trigger (multi-row inserts are counted as a whole). arg0 = cap. For appointments only
-- active future rows count; the trigger also fires on status/starts_at updates.
-- Counting runs in a SECURITY DEFINER helper (sees every row regardless of RLS); the trigger itself
-- is SECURITY INVOKER so current_user is the real caller (postgres inside seed_demo => exempt).
create or replace function public._demo_cap_exceeded(p_tenant uuid, p_table text, p_cap int)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare v_n int;
begin
  if not public._tenant_is_demo(p_tenant) then return false; end if;
  if p_table = 'appointments' then
    select count(*) into v_n from public.appointments
     where tenant_id = p_tenant and starts_at > now() and status in ('pending_payment','confirmed');
  else
    execute format('select count(*) from public.%I where tenant_id = $1', p_table) into v_n using p_tenant;
  end if;
  return v_n > p_cap;
end $$;

create or replace function public.trg_demo_row_cap()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('postgres','supabase_admin') then return null; end if;
  if public._demo_cap_exceeded(new.tenant_id, tg_table_name, tg_argv[0]::int) then
    raise exception 'demo_limit' using errcode = '54000';
  end if;
  return null;
end $$;
revoke all on function public._demo_cap_exceeded(uuid, text, int) from public, anon, authenticated;
grant execute on function public._demo_cap_exceeded(uuid, text, int) to authenticated, service_role;
revoke all on function public.trg_demo_tenants_readonly(), public.trg_demo_row_cap() from public, anon, authenticated;

drop trigger if exists demo_services_cap on public.services;
create trigger demo_services_cap after insert on public.services
  for each row execute function public.trg_demo_row_cap(30);
drop trigger if exists demo_providers_cap on public.providers;
create trigger demo_providers_cap after insert on public.providers
  for each row execute function public.trg_demo_row_cap(15);
drop trigger if exists demo_working_hours_cap on public.working_hours;
create trigger demo_working_hours_cap after insert on public.working_hours
  for each row execute function public.trg_demo_row_cap(100);
drop trigger if exists demo_time_off_cap on public.time_off;
create trigger demo_time_off_cap after insert on public.time_off
  for each row execute function public.trg_demo_row_cap(30);
drop trigger if exists demo_customers_cap on public.customers;
create trigger demo_customers_cap after insert on public.customers
  for each row execute function public.trg_demo_row_cap(300);
-- 150 active future appointments (seed has well under that).
drop trigger if exists demo_appointments_cap on public.appointments;
create trigger demo_appointments_cap after insert or update of status, starts_at on public.appointments
  for each row execute function public.trg_demo_row_cap(150);

-- ---------- 3. length limits (all tenants) ----------
do $$
declare c record;
begin
  for c in select * from (values
    ('tenants','name_ar',120),('tenants','name_en',120),('tenants','logo_url',500),('tenants','brand_color',20),
    ('providers','name_ar',120),('providers','name_en',120),('providers','title_ar',120),('providers','title_en',120),
    ('providers','bio_ar',500),('providers','bio_en',500),('providers','avatar_url',500),
    ('services','name_ar',120),('services','name_en',120),('services','description_ar',500),('services','description_en',500),
    ('time_off','reason',200),
    ('customers','full_name',120),('customers','phone',32),('customers','email',254),
    ('appointments','notes',500)
  ) v(t,col,n) loop
    execute format('alter table public.%I drop constraint if exists %I', c.t, c.t||'_'||c.col||'_len');
    execute format('alter table public.%I add constraint %I check (char_length(%I) <= %s)', c.t, c.t||'_'||c.col||'_len', c.col, c.n);
  end loop;
end $$;
