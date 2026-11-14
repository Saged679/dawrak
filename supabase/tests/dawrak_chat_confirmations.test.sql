-- pgTAP: chat confirmation single-use table and agent state (migration 24): service_role only, forced RLS,
-- atomic single use, tenant-bound foreign keys, cascade.
-- Run: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

create function pg_temp.act(p_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', p_role)::text, true);
  perform set_config('role', p_role, true);
end $$;
create function pg_temp.exec(p_sql text) returns text language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'OK:' || n;
exception when others then return 'ERR:' || sqlstate;
end $$;
grant execute on all functions in schema pg_temp to public;

insert into public.tenants (id, slug, name_ar, name_en, kind) values
  ('d1000000-0000-4000-8000-000000000001', 'cc-a', 'أ', 'A', 'clinic'),
  ('d1000000-0000-4000-8000-000000000002', 'cc-b', 'ب', 'B', 'clinic');
insert into public.conversations (id, tenant_id) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001');

select is((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.chat_confirmation_uses'::regclass), true, 'uses: RLS enabled and forced');
select is((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.chat_agent_state'::regclass), true, 'state: RLS enabled and forced');

-- visitors and staff cannot touch either table
select pg_temp.act('anon');
select is(pg_temp.exec($$select 1 from public.chat_confirmation_uses$$), 'ERR:42501', 'anon cannot read uses');
select is(pg_temp.exec($$insert into public.chat_confirmation_uses (tenant_id, conversation_id, jti, action) values ('d1000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','aaaaaaaaaaaa','create_booking')$$), 'ERR:42501', 'anon cannot insert uses');
reset role;
select pg_temp.act('authenticated');
select is(pg_temp.exec($$select 1 from public.chat_confirmation_uses$$), 'ERR:42501', 'authenticated cannot read uses');
select is(pg_temp.exec($$select 1 from public.chat_agent_state$$), 'ERR:42501', 'authenticated cannot read state');
select is(pg_temp.exec($$delete from public.chat_confirmation_uses where true$$), 'ERR:42501', 'authenticated cannot delete uses');
reset role;

-- service role: insert once, replay is refused with a unique violation, another jti is fine
select pg_temp.act('service_role');
select is(pg_temp.exec($$insert into public.chat_confirmation_uses (tenant_id, conversation_id, jti, action) values ('d1000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','jti-one-0001','create_booking')$$), 'OK:1', 'first use of a token is recorded');
select is(pg_temp.exec($$insert into public.chat_confirmation_uses (tenant_id, conversation_id, jti, action) values ('d1000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','jti-one-0001','create_booking')$$), 'ERR:23505', 'replay of the same token is a unique violation');
select is(pg_temp.exec($$insert into public.chat_confirmation_uses (tenant_id, conversation_id, jti, action) values ('d1000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','jti-two-0002','cancel_booking')$$), 'OK:1', 'another token is independent');
select is(pg_temp.exec($$insert into public.chat_confirmation_uses (tenant_id, conversation_id, jti, action) values ('d1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001','jti-three-003','create_booking')$$), 'ERR:23503', 'a conversation of another tenant is refused (tenant-bound FK)');
select is(pg_temp.exec($$insert into public.chat_confirmation_uses (tenant_id, conversation_id, jti, action) values ('d1000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','jti-four-0004','drop_database')$$), 'ERR:23514', 'unknown action is refused');
select is(pg_temp.exec($$delete from public.chat_confirmation_uses where conversation_id = 'd2000000-0000-4000-8000-000000000001' and jti = 'jti-two-0002'$$), 'OK:1', 'a failed action can release its token');
select is(pg_temp.exec($$update public.chat_confirmation_uses set action = 'cancel_booking' where true$$), 'ERR:42501', 'rows cannot be rewritten (no update grant)');

select is(pg_temp.exec($$insert into public.chat_agent_state (conversation_id, tenant_id, state) values ('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','{"a":1}')$$), 'OK:1', 'service role stores state');
select is(pg_temp.exec($$insert into public.chat_agent_state (conversation_id, tenant_id, state) values ('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','{"a":2}') on conflict (conversation_id) do update set state = excluded.state$$), 'OK:1', 'state upsert works');
reset role;

-- cascade with the conversation
select is(pg_temp.exec($$delete from public.conversations where id = 'd2000000-0000-4000-8000-000000000001'$$), 'OK:1', 'conversation deleted');
select is((select count(*)::int from public.chat_confirmation_uses) + (select count(*)::int from public.chat_agent_state where conversation_id = 'd2000000-0000-4000-8000-000000000001'), 0, 'uses and state cascade away with the conversation');

select * from finish();
rollback;
