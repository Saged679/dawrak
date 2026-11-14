-- reset_demo() failed through PostgREST (hosted AND the local stack): the authenticator role preloads
-- pg-safeupdate, which rejects any DELETE/UPDATE without a WHERE clause ("DELETE requires a WHERE clause",
-- SQLSTATE 21000), including statements inside a function body. Migration 18's body had an unconditional
-- `delete from public.demo_outbox;`. Same behaviour as before, with an explicit `where true`.
-- Audit of every other function in migrations 1-22: no other unconditional DELETE/UPDATE exists
-- (seed_demo, purge_expired_demo_users, purge_demo_outbox, expire_pending_bookings all filter).
create or replace function public.reset_demo()
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform set_config('dawrak.seeding', 'on', true);
  delete from public.demo_outbox where true;

  -- every temporary visitor goes (auth rows cascade to identities, sessions, refresh tokens, memberships)
  delete from auth.users u
   where u.id in (select d.user_id from public.demo_users d)
     and u.id::text !~ '^a0000000-0000-4000-8000-00000000000[0-9]$';
  delete from auth.users u
   where coalesce(u.raw_app_meta_data ->> 'demo_visitor', '') = 'true'
     and u.id::text !~ '^a0000000-0000-4000-8000-00000000000[0-9]$';

  delete from public.tenants
   where is_demo
      or id in ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002');
  perform public.seed_demo();

  -- The fixed shared demo logins must not be usable on a public project: random passwords, unless this
  -- database opted in (supabase/seed.sql sets demo_config.allow_fixed_demo_login for local dev and e2e).
  if not exists (select 1 from public.demo_config where key = 'allow_fixed_demo_login' and value = 'on') then
    update auth.users
       set encrypted_password = extensions.crypt(encode(extensions.gen_random_bytes(24), 'hex'), extensions.gen_salt('bf'))
     where id::text ~ '^a0000000-0000-4000-8000-00000000000[1-6]$';
  end if;
  perform set_config('dawrak.seeding', 'off', true);
end $$;
revoke all on function public.reset_demo() from public, anon, authenticated;
grant execute on function public.reset_demo() to service_role;
comment on function public.reset_demo() is
  'service_role / pg_cron (dawrak_reset_demo, daily 03:00 UTC). Wipes every demo tenant and visitor and re-seeds. Safe under pg-safeupdate (every DELETE/UPDATE has a WHERE).';
