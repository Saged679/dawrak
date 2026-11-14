-- Retention for the chat confirmation tables (migration 24): rows older than 7 days are deleted, and a pending
-- confirmation that is past its own expiry is dropped from chat_agent_state earlier. Runs daily from pg_cron
-- and, as a backup, from the existing cron route (service role). Tables stay service_role only.
create or replace function public.purge_chat_agent_data()
returns int
language plpgsql volatile security definer
set search_path = ''
as $$
declare v_n int := 0; v_k int;
begin
  delete from public.chat_confirmation_uses where used_at < now() - interval '7 days';
  get diagnostics v_k = row_count; v_n := v_n + v_k;
  delete from public.chat_agent_state where updated_at < now() - interval '7 days';
  get diagnostics v_k = row_count; v_n := v_n + v_k;
  update public.chat_agent_state
     set state = state - 'pending'
   where state ? 'pending'
     and coalesce((state -> 'pending' ->> 'expiresAt')::numeric, 0) < extract(epoch from now()) * 1000;
  get diagnostics v_k = row_count; v_n := v_n + v_k;
  return v_n;
end $$;

revoke all on function public.purge_chat_agent_data() from public, anon, authenticated;
grant execute on function public.purge_chat_agent_data() to service_role;

do $$
begin
  create extension if not exists pg_cron with schema pg_catalog;
  perform cron.schedule('dawrak_purge_chat_agent', '17 3 * * *', 'select public.purge_chat_agent_data()');
exception when others then
  raise notice 'pg_cron not available (%): the cron route calls purge_chat_agent_data() as well', sqlerrm;
end $$;
