-- pgTAP: the cron re-embedding step (service role) can write kb_chunks.embedding on seeded demo chunks,
-- and seeded chunks start without an embedding (reset_demo), which is why search_knowledge has a lexical fallback.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

select cmp_ok((select count(*)::int from public.kb_chunks c join public.tenants t on t.id = c.tenant_id
                where t.is_demo and c.embedding is null), '>', 0, 'seeded demo chunks have no embedding');

set local role service_role;
select lives_ok(
  $$update public.kb_chunks set embedding = ('[' || array_to_string(array_fill(0.01::float, array[768]), ',') || ']')::extensions.vector
     where id = (select c.id from public.kb_chunks c join public.tenants t on t.id = c.tenant_id
                  where t.is_demo and c.embedding is null limit 1)$$,
  'service_role can UPDATE the embedding of a demo chunk (not blocked by demo_catalog_readonly)');
reset role;
select cmp_ok((select count(*)::int from public.kb_chunks c join public.tenants t on t.id = c.tenant_id
                where t.is_demo and c.embedding is not null), '>=', 1, 'the embedding was stored');

select * from finish();
rollback;
