-- pgTAP: chat_agent_state.version compare-and-set (migration 26).
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
begin execute p_sql; get diagnostics n = row_count; return 'OK:' || n; exception when others then return 'ERR:' || sqlstate; end $$;
grant execute on all functions in schema pg_temp to public;

insert into public.tenants (id, slug, name_ar, name_en, kind) values ('d5000000-0000-4000-8000-000000000001', 'ver-a', 'أ', 'A', 'clinic');
insert into public.conversations (id, tenant_id) values ('d6000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001');

select has_column('public', 'chat_agent_state', 'version', 'version column exists');
select col_not_null('public', 'chat_agent_state', 'version', 'version is not null');

select pg_temp.act('service_role');
select is(pg_temp.exec($$insert into public.chat_agent_state (conversation_id, tenant_id, state) values ('d6000000-0000-4000-8000-000000000001','d5000000-0000-4000-8000-000000000001','{"a":1}')$$), 'OK:1', 'insert starts at version 0');
select is((select version from public.chat_agent_state where conversation_id = 'd6000000-0000-4000-8000-000000000001'), 0, 'default version is 0');
select is(pg_temp.exec($$update public.chat_agent_state set state = '{"a":2}', version = 1 where conversation_id = 'd6000000-0000-4000-8000-000000000001' and version = 0$$), 'OK:1', 'the writer that read version 0 wins');
select is(pg_temp.exec($$update public.chat_agent_state set state = '{"a":3}', version = 1 where conversation_id = 'd6000000-0000-4000-8000-000000000001' and version = 0$$), 'OK:0', 'a stale writer (still on version 0) updates nothing');
select is((select state ->> 'a' from public.chat_agent_state where conversation_id = 'd6000000-0000-4000-8000-000000000001'), '2', 'the stale write did not overwrite');
select is(pg_temp.exec($$insert into public.chat_agent_state (conversation_id, tenant_id, state) values ('d6000000-0000-4000-8000-000000000001','d5000000-0000-4000-8000-000000000001','{}')$$), 'ERR:23505', 'a second first-insert is refused (unique key)');
reset role;

select pg_temp.act('authenticated');
select is(pg_temp.exec($$update public.chat_agent_state set version = 9 where true$$), 'ERR:42501', 'authenticated still cannot touch the table');
reset role;

select * from finish();
rollback;
