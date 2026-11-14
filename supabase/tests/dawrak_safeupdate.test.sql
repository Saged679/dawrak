-- pgTAP: pg-safeupdate compatibility. PostgREST's authenticator role preloads safeupdate (hosted Supabase and
-- the local stack), which rejects any DELETE/UPDATE without WHERE ("DELETE requires a WHERE clause", 21000),
-- even inside a function called through RPC. The test session cannot LOAD the library (supautils blocks it),
-- so this is a static audit of every plpgsql/sql function in schema public: no DELETE/UPDATE statement
-- without a WHERE. (The runtime failure was also reproduced by calling /rest/v1/rpc/reset_demo.)
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

create function pg_temp.unsafe_statements() returns table(fn text, stmt text) language sql as $$
  select p.proname::text, left(regexp_replace(s.stmt, '\s+', ' ', 'g'), 120)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
    join pg_language l on l.oid = p.prolang and l.lanname in ('plpgsql', 'sql'),
    lateral regexp_split_to_table(p.prosrc, ';') as s(stmt)
   where p.prokind = 'f'
     and s.stmt ~* '^\s*(delete\s+from|update)\s'
     and s.stmt !~* '\mwhere\M'
$$;

select is((select count(*)::int from pg_temp.unsafe_statements() where fn = 'reset_demo'), 0,
  'reset_demo() has no DELETE/UPDATE without WHERE');
select is((select count(*)::int from pg_temp.unsafe_statements()), 0,
  'no function in public has a DELETE/UPDATE without WHERE (pg-safeupdate)');
select ok(pg_get_functiondef('public.reset_demo()'::regprocedure) ~* 'delete from public.demo_outbox where true',
  'reset_demo() clears the outbox with an explicit WHERE');

set local role service_role;
select lives_ok('select public.reset_demo()', 'reset_demo() still runs and re-seeds');
reset role;
select is((select count(*)::int from public.tenants where slug in ('demo-clinic', 'demo-salon')), 2, 'both demo businesses exist after reset');

select * from finish();
rollback;
