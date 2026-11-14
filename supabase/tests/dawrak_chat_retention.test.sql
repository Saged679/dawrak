-- pgTAP: retention of chat_confirmation_uses / chat_agent_state (migration 25).
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

create function pg_temp.act(p_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', p_role)::text, true);
  perform set_config('role', p_role, true);
end $$;
create function pg_temp.exec(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'OK'; exception when others then return 'ERR:' || sqlstate; end $$;
grant execute on all functions in schema pg_temp to public;

insert into public.tenants (id, slug, name_ar, name_en, kind) values ('d3000000-0000-4000-8000-000000000001', 'ret-a', 'أ', 'A', 'clinic');
insert into public.conversations (id, tenant_id) values
  ('d4000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001'),
  ('d4000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000001'),
  ('d4000000-0000-4000-8000-000000000003', 'd3000000-0000-4000-8000-000000000001');
insert into public.chat_confirmation_uses (tenant_id, conversation_id, jti, action, used_at) values
  ('d3000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'old-jti-0001', 'create_booking', now() - interval '8 days'),
  ('d3000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'new-jti-0002', 'create_booking', now() - interval '1 day');
insert into public.chat_agent_state (conversation_id, tenant_id, state, updated_at) values
  ('d4000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', '{"a":1}', now() - interval '8 days'),
  ('d4000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000001', jsonb_build_object('pending', jsonb_build_object('expiresAt', (extract(epoch from now()) * 1000)::bigint - 1000), 'availability', '{"x":1}'::jsonb), now()),
  ('d4000000-0000-4000-8000-000000000003', 'd3000000-0000-4000-8000-000000000001', jsonb_build_object('pending', jsonb_build_object('expiresAt', (extract(epoch from now()) * 1000)::bigint + 600000)), now());

select pg_temp.act('authenticated');
select is(pg_temp.exec($$select public.purge_chat_agent_data()$$), 'ERR:42501', 'authenticated cannot run the purge');
reset role;
select pg_temp.act('anon');
select is(pg_temp.exec($$select public.purge_chat_agent_data()$$), 'ERR:42501', 'anon cannot run the purge');
reset role;
select pg_temp.act('service_role');
select is(public.purge_chat_agent_data(), 3, 'purge reports 3 changes (1 use, 1 state, 1 expired pending)');
reset role;

select is((select count(*)::int from public.chat_confirmation_uses where jti = 'old-jti-0001'), 0, 'a use older than 7 days is gone');
select is((select count(*)::int from public.chat_confirmation_uses where jti = 'new-jti-0002'), 1, 'a recent use stays');
select is((select count(*)::int from public.chat_agent_state where conversation_id = 'd4000000-0000-4000-8000-000000000001'), 0, 'state older than 7 days is gone');
select is((select state ? 'pending' from public.chat_agent_state where conversation_id = 'd4000000-0000-4000-8000-000000000002'), false, 'an expired pending confirmation is dropped');
select is((select state ? 'availability' from public.chat_agent_state where conversation_id = 'd4000000-0000-4000-8000-000000000002'), true, '... but the rest of the state stays');
select is((select state ? 'pending' from public.chat_agent_state where conversation_id = 'd4000000-0000-4000-8000-000000000003'), true, 'a live pending confirmation stays');

select * from finish();
rollback;
