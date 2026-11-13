-- M2: demo row caps must apply to public bookings.
-- create_public_booking is SECURITY DEFINER owned by postgres, so the old `current_user = 'postgres'`
-- exemption in trg_demo_row_cap also exempted every public booking. The exemption is now a
-- transaction-local flag that only seed_demo()/reset_demo() raise. Caps stay 300 customers /
-- 150 active future appointments / etc. (set in migration 11).
-- Note: dawrak.seeding is an ordinary custom GUC. It can only be set by code that already runs SQL
-- as a database role (PostgREST cannot call set_config), so it is not reachable from the API.

create or replace function public.trg_demo_row_cap()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('dawrak.seeding', true), '') = 'on' then return null; end if;
  if public._demo_cap_exceeded(new.tenant_id, tg_table_name, tg_argv[0]::int) then
    raise exception 'demo_limit' using errcode = '54000';
  end if;
  return null;
end $$;

-- seed_demo(): keep the existing body (migration 10) as a private function and wrap it, so the
-- 200-line seed is not duplicated. The wrapper raises the flag for the transaction and lowers it
-- again so later statements in the same transaction are capped like everyone else.
do $$
begin
  if to_regprocedure('public._seed_demo_body()') is null then
    alter function public.seed_demo() rename to _seed_demo_body;
  end if;
end $$;
revoke all on function public._seed_demo_body() from public, anon, authenticated, service_role;

create or replace function public.seed_demo()
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform set_config('dawrak.seeding', 'on', true);
  perform public._seed_demo_body();
  perform set_config('dawrak.seeding', 'off', true);
end $$;

create or replace function public.reset_demo()
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform set_config('dawrak.seeding', 'on', true);
  delete from public.tenants
   where is_demo
      or id in ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002');
  perform public.seed_demo();
  perform set_config('dawrak.seeding', 'off', true);
end $$;

revoke all on function public.seed_demo(), public.reset_demo() from public, anon, authenticated;
grant execute on function public.seed_demo(), public.reset_demo() to service_role;
comment on function public.seed_demo() is 'service_role only. Wipes demo tenants and re-seeds (self-healing). Raises dawrak.seeding for the transaction so the demo row caps do not block the seed.';
comment on function public.reset_demo() is 'service_role / pg_cron (dawrak_reset_demo, daily 03:00 UTC). Wipes every demo tenant and re-seeds.';

-- Daily demo reset at 03:00 UTC. cron.schedule() with an existing job name updates that job, so
-- re-applying this migration is idempotent. HOSTED PROJECT: pg_cron must be enabled first
-- (Dashboard > Database > Extensions > pg_cron, free tier included); otherwise this block only
-- raises a notice and reset_demo() must be called from an external scheduler.
do $$
begin
  create extension if not exists pg_cron with schema pg_catalog;
  perform cron.schedule('dawrak_reset_demo', '0 3 * * *', 'select public.reset_demo()');
exception when others then
  raise notice 'pg_cron not available (%): schedule public.reset_demo() externally', sqlerrm;
end $$;
