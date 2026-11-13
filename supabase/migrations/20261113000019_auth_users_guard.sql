-- H1 defence in depth: the six fixed seeded demo users (a0000000-...-00000000000N) must not have their
-- credentials changed or be deleted through GoTrue.
--
-- GoTrue (user-initiated updates AND the Admin API) connects as supabase_auth_admin, so a role check cannot
-- tell a visitor's own PUT /user from an admin call. The guard therefore applies to everything except
-- postgres / supabase_admin / service_role (reset_demo() and migrations run as postgres).
-- Ordinary GoTrue activity (last_sign_in_at, refresh-token rotation, sessions) touches other columns and is
-- unaffected. Per-visitor demo users (registered in demo_users) are NOT guarded on purpose: a visitor may
-- change their own password, which only affects their own throwaway account.

create or replace function public.trg_auth_users_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('postgres','supabase_admin','service_role') then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if old.id::text ~ '^a0000000-0000-4000-8000-00000000000[0-9]$' then
    if tg_op = 'DELETE'
       or new.encrypted_password is distinct from old.encrypted_password
       or new.email              is distinct from old.email
       or new.phone              is distinct from old.phone
       or new.email_change       is distinct from old.email_change             -- pending e-mail change (PUT /user)
       or new.email_change_token_new is distinct from old.email_change_token_new then
      raise exception 'demo_user_protected' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function public.trg_auth_users_guard() from public, anon, authenticated;

drop trigger if exists dawrak_auth_users_guard on auth.users;
create trigger dawrak_auth_users_guard before update or delete on auth.users
  for each row execute function public.trg_auth_users_guard();

-- "Global logout" by a visitor who holds a fixed demo user's session (POST /logout?scope=global, the default
-- of supabase-js signOut) deletes ALL sessions of that user and would kick out every other holder of the
-- shared login. For the fixed demo users GoTrue's DELETE on auth.sessions is therefore skipped silently
-- (the client still gets 204 and clears its own cookie; the sessions simply expire on their own).
-- Cascades from a deliberate delete of the user by postgres run at trigger depth > 1 and are let through.
-- On the hosted project the fixed users have random passwords, so nobody can hold such a session anyway.
create or replace function public.trg_auth_sessions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('postgres','supabase_admin','service_role')
     and pg_trigger_depth() <= 1
     and old.user_id::text ~ '^a0000000-0000-4000-8000-00000000000[0-9]$' then
    return null;   -- skip this row's deletion
  end if;
  return old;
end $$;
revoke all on function public.trg_auth_sessions_guard() from public, anon, authenticated;

drop trigger if exists dawrak_auth_sessions_guard on auth.sessions;
create trigger dawrak_auth_sessions_guard before delete on auth.sessions
  for each row execute function public.trg_auth_sessions_guard();
