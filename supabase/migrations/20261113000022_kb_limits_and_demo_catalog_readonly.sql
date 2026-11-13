-- M3 (a): size limits on knowledge-base text. NOT VALID first (new rows are checked at once), then VALIDATE;
--         if existing rows on some project do not fit, the constraint stays NOT VALID and a notice says so.
-- M3 (b): demo tenants: signed-in users cannot UPDATE/DELETE the seeded catalogue or knowledge base.
--         Rows carry created_by (default auth.uid()); a visitor may update/delete only rows they created.
--         Seeded rows have created_by NULL, so they are immutable for authenticated/anon in demo tenants.
--         Exempt: every caller that is not authenticated/anon (service_role, postgres, SECURITY DEFINER
--         functions such as reset_demo / seed_demo / staff_update_appointment, FK cascades).
--         Error: 'demo_readonly' (42501), same as the tenants / memberships freeze.
--         INSERT stays allowed within the existing caps. Appointments are not covered here: status changes and
--         rescheduling keep working.
--         Note: created_by is readable by members of the same demo tenant (random per-visitor uuids, no PII).

-- ---------- (a) size limits ----------
alter table public.kb_documents drop constraint if exists kb_documents_content_len;
alter table public.kb_documents add constraint kb_documents_content_len check (char_length(content) <= 200000) not valid;
alter table public.kb_documents drop constraint if exists kb_documents_title_len;
alter table public.kb_documents add constraint kb_documents_title_len check (char_length(title) <= 200) not valid;
alter table public.kb_chunks drop constraint if exists kb_chunks_content_len;
alter table public.kb_chunks add constraint kb_chunks_content_len check (char_length(content) <= 4000) not valid;
do $$
begin
  alter table public.kb_documents validate constraint kb_documents_content_len;
  alter table public.kb_documents validate constraint kb_documents_title_len;
  alter table public.kb_chunks validate constraint kb_chunks_content_len;
exception when check_violation then
  raise notice 'existing knowledge-base rows exceed the new limits; constraints left NOT VALID (new rows are still checked)';
end $$;

-- ---------- (b) ownership column ----------
do $$
declare t text;
begin
  foreach t in array array['providers','services','provider_services','working_hours','time_off','kb_documents','kb_chunks'] loop
    execute format('alter table public.%I add column if not exists created_by uuid default auth.uid()', t);
  end loop;
end $$;
-- the column was added with a default, so existing rows would have been backfilled with NULL (auth.uid() is
-- NULL outside a request): they are "seeded" rows and stay immutable for demo visitors.

create or replace function public.trg_demo_catalog_readonly()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_tid  uuid := old.tenant_id;
  v_mine boolean;
begin
  if current_user in ('authenticated','anon') and public._tenant_is_demo(v_tid) then
    v_mine := coalesce(v_uid is not null and old.created_by = v_uid, false);
    -- a chunk is also "mine" when it belongs to a document I created (ingestion may insert/delete chunks)
    if not v_mine and tg_table_name = 'kb_chunks' and v_uid is not null then
      v_mine := exists (select 1 from public.kb_documents d
                         where d.id = old.document_id and d.tenant_id = old.tenant_id and d.created_by = v_uid);
    end if;
    -- embeddings are (re)written by the indexing step on any chunk; only text/identity changes are frozen
    if tg_table_name = 'kb_chunks' and tg_op = 'UPDATE' then
      return new;
    end if;
    if not v_mine then raise exception 'demo_readonly' using errcode = '42501'; end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function public.trg_demo_catalog_readonly() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['providers','services','provider_services','working_hours','time_off','kb_documents','kb_chunks'] loop
    execute format('drop trigger if exists demo_catalog_readonly on public.%I', t);
    execute format('create trigger demo_catalog_readonly before update or delete on public.%I
                      for each row execute function public.trg_demo_catalog_readonly()', t);
  end loop;
end $$;
