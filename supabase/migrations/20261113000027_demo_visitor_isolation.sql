-- Phase 6 security audit fixes (M1, M2, M3, M4, L1, Info). Idempotent: safe to re-apply, safe on a hosted DB that
-- already holds data (every UPDATE/DELETE has a WHERE for pg-safeupdate; ADD COLUMN is nullable without a default,
-- so no table rewrite; the new CHECKs are added NOT VALID and validated afterwards so no long ACCESS EXCLUSIVE scan).
-- Locking: the Supabase CLI runs this file as ONE transaction, so every ACCESS EXCLUSIVE lock taken by an ALTER TABLE /
-- CREATE TRIGGER / CREATE POLICY is held until the final COMMIT (not released statement by statement). lock_timeout
-- (10 s, set with set_config(..., true), transaction-local) does not shorten that: it only makes a statement that cannot
-- GET its lock give up, which rolls the whole migration back cleanly (nothing half-applied, safe to retry). The touched
-- tables are small, so the transaction itself is short; apply it in a low-traffic moment (the demo reset window, 03:00 UTC).
-- If a runner executes statements outside a transaction the setting is simply not applied.
do $$ begin perform set_config('lock_timeout', '10s', true); end $$;

-- =====================================================================================
-- M2. Per-visitor isolation of demo data
-- =====================================================================================
-- Ownership key = SHA-256 of the visitor's httpOnly demo-session cookie (never the cookie itself).
--   customers.demo_session_hash, appointments.demo_session_hash, conversations.session_hash
--   NULL            = seeded row, visible to every demo visitor
--   '<64 hex>'      = created by that visitor session; visible only to the demo staff user registered with the
--                     same hash (demo_users.session_hash, set by enterDemo from the same cookie)
-- Non-demo tenants are never restricted. Fail-safe: a demo-tenant row inserted WITHOUT an owner (old app code,
-- a forgotten call site) gets a random hash from the trigger below, so it is invisible rather than "seeded".
alter table public.customers     add column if not exists demo_session_hash text;
alter table public.appointments  add column if not exists demo_session_hash text;
alter table public.conversations add column if not exists session_hash text;
alter table public.demo_users    add column if not exists session_hash text;

do $$
declare c record;
begin
  for c in select * from (values
    ('customers','demo_session_hash'), ('appointments','demo_session_hash'),
    ('conversations','session_hash'), ('demo_users','session_hash')) v(t, col) loop
    execute format('alter table public.%I drop constraint if exists %I', c.t, c.t || '_' || c.col || '_shape');
    execute format('alter table public.%I add constraint %I check (%I is null or %I ~ ''^[0-9a-f]{64}$'') not valid',
                   c.t, c.t || '_' || c.col || '_shape', c.col, c.col);
  end loop;
end $$;
-- validated separately: a full scan under a weaker lock (SHARE UPDATE EXCLUSIVE), after the backfill below only
-- 64-hex values exist, so validation cannot fail on rows written by this migration
alter table public.customers     validate constraint customers_demo_session_hash_shape;
alter table public.appointments  validate constraint appointments_demo_session_hash_shape;
alter table public.conversations validate constraint conversations_session_hash_shape;
alter table public.demo_users    validate constraint demo_users_session_hash_shape;

-- ---------- M3: customers are keyed PER VISITOR in demo tenants ----------
-- (tenant_id, phone) stays unique for real tenants (hash NULL -> ''), but two demo visitors can each have their own
-- customer for the same phone, so one visitor's booking is never attached to (or purged with) another's customer.
create unique index if not exists customers_tenant_phone_owner_uq
  on public.customers (tenant_id, phone, (coalesce(demo_session_hash, '')));
alter table public.customers drop constraint if exists customers_tenant_id_phone_key;
create index if not exists demo_users_session_idx on public.demo_users (session_hash) where session_hash is not null;
create index if not exists customers_demo_owner_idx on public.customers (demo_session_hash) where demo_session_hash is not null;
create index if not exists appointments_demo_owner_idx on public.appointments (demo_session_hash) where demo_session_hash is not null;
create index if not exists conversations_session_idx on public.conversations (session_hash) where session_hash is not null;

-- ---------- backfill: rows that already exist in demo tenants and are NOT seed rows become invisible ----------
-- Seed rows are exactly those created in the seed transaction (created_at = the tenant's created_at; the six
-- seeded conversations have the fixed 'cc000000-...' ids). Everything else was made by a visitor of the old,
-- shared-data demo: give each such row its own random owner so nobody inherits it. They are purged within 15 min
-- (purge_expired_demo_users) or at the next reset_demo(). Re-running changes nothing (the WHERE excludes them).
update public.customers c set demo_session_hash = encode(extensions.gen_random_bytes(32), 'hex')
  from public.tenants t
 where t.id = c.tenant_id and t.is_demo and c.demo_session_hash is null and c.created_at <> t.created_at;
update public.appointments a set demo_session_hash = encode(extensions.gen_random_bytes(32), 'hex')
  from public.tenants t
 where t.id = a.tenant_id and t.is_demo and a.demo_session_hash is null and a.created_at <> t.created_at;
update public.conversations v set session_hash = encode(extensions.gen_random_bytes(32), 'hex')
  from public.tenants t
 where t.id = v.tenant_id and t.is_demo and v.session_hash is null and v.id::text not like 'cc000000-0000-4000-8000-0000000000__';

-- ---------- helpers used by the policies (definer: they read demo_users, which signed-in users cannot) ----------
-- They only answer "may THIS caller see a row owned by <hash>?", so authenticated may execute them.
create or replace function public._demo_owner_visible(p_tenant uuid, p_hash text)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_hash is null then return true; end if;                       -- seeded row
  if not public._tenant_is_demo(p_tenant) then return true; end if; -- real tenants are not restricted
  return exists (select 1 from public.demo_users d
                  where d.user_id = (select auth.uid()) and d.session_hash = p_hash);
end $$;

create or replace function public._demo_appointment_visible(p_tenant uuid, p_appointment uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public._demo_owner_visible(p_tenant,
    (select a.demo_session_hash from public.appointments a where a.id = p_appointment and a.tenant_id = p_tenant))
$$;

create or replace function public._demo_conversation_visible(p_tenant uuid, p_conversation uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public._demo_owner_visible(p_tenant,
    (select c.session_hash from public.conversations c where c.id = p_conversation and c.tenant_id = p_tenant))
$$;

-- KB rows (and the other catalogue rows) are owned by an auth user id (created_by), not a session hash.
-- p_hash: the anonymous chat visitor's session (agent, service role); auth.uid(): a signed-in dashboard user.
create or replace function public._demo_created_by_visible(p_tenant uuid, p_created_by uuid, p_hash text default null)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_created_by is null then return true; end if;                 -- seeded row
  if not public._tenant_is_demo(p_tenant) then return true; end if;
  if p_created_by = (select auth.uid()) then return true; end if;
  if p_hash is null then return false; end if;
  return exists (select 1 from public.demo_users d where d.user_id = p_created_by and d.session_hash = p_hash);
end $$;

revoke all on function public._demo_owner_visible(uuid, text), public._demo_appointment_visible(uuid, uuid),
  public._demo_conversation_visible(uuid, uuid), public._demo_created_by_visible(uuid, uuid, text)
  from public, anon;
grant execute on function public._demo_owner_visible(uuid, text), public._demo_appointment_visible(uuid, uuid),
  public._demo_conversation_visible(uuid, uuid), public._demo_created_by_visible(uuid, uuid, text)
  to authenticated, service_role;

-- may the caller CHANGE a row owned by <hash>? Real tenants: yes (the permissive policies decide). Demo tenants: only
-- rows the caller's own visitor session created. Seeded rows (hash NULL) are read-only for every visitor.
create or replace function public._demo_owner_writable(p_tenant uuid, p_hash text)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public._tenant_is_demo(p_tenant) then return true; end if;
  if p_hash is null then return false; end if;
  return exists (select 1 from public.demo_users d
                  where d.user_id = (select auth.uid()) and d.session_hash = p_hash);
end $$;
revoke all on function public._demo_owner_writable(uuid, text) from public, anon;
grant execute on function public._demo_owner_writable(uuid, text) to authenticated, service_role;

-- ---------- RESTRICTIVE policies: AND-ed with every existing permissive policy ----------
-- The expressions short-circuit on the cheap tests first (NULL owner = seeded or real-tenant row), so real tenants'
-- rows never pay for the function except the tenant lookup.
--   SELECT: seeded rows (NULL), real tenants' rows, or the caller's own demo rows
--   UPDATE / DELETE (customers, appointments): demo tenants only the caller's own rows (seeded = read-only)
do $$
declare r record;
begin
  for r in select * from (values
    ('customers',     'demo_session_hash', 'public._demo_owner_visible(tenant_id, demo_session_hash)',  true),
    ('appointments',  'demo_session_hash', 'public._demo_owner_visible(tenant_id, demo_session_hash)',  true),
    ('conversations', 'session_hash',      'public._demo_owner_visible(tenant_id, session_hash)',       false),
    ('messages',      null,                'public._demo_conversation_visible(tenant_id, conversation_id)', false),
    ('payments',      null,                'public._demo_appointment_visible(tenant_id, appointment_id)',   false),
    ('reminders',     null,                'public._demo_appointment_visible(tenant_id, appointment_id)',   false)
  ) v(t, col, fn, writable) loop
    execute format('drop policy if exists demo_owner_isolation on public.%I', r.t);
    execute format('drop policy if exists demo_owner_select on public.%I', r.t);
    execute format('drop policy if exists demo_owner_update on public.%I', r.t);
    execute format('drop policy if exists demo_owner_delete on public.%I', r.t);
    execute format('create policy demo_owner_select on public.%I as restrictive for select to authenticated using (%s)',
                   r.t, format('tenant_id <> all (array(select id from public.tenants where is_demo)) or %s',
                               case when r.col is null then r.fn else format('%I is null or %s', r.col, r.fn) end));
    if r.writable then
      execute format('create policy demo_owner_update on public.%1$I as restrictive for update to authenticated using (tenant_id <> all (array(select id from public.tenants where is_demo)) or public._demo_owner_writable(tenant_id, %2$I)) with check (tenant_id <> all (array(select id from public.tenants where is_demo)) or public._demo_owner_writable(tenant_id, %2$I))', r.t, r.col);
      execute format('create policy demo_owner_delete on public.%1$I as restrictive for delete to authenticated using (tenant_id <> all (array(select id from public.tenants where is_demo)) or public._demo_owner_writable(tenant_id, %2$I))', r.t, r.col);
    end if;
  end loop;
  -- KB rows are owned by an auth user id (created_by); the catalogue triggers below enforce who may write
  for r in select unnest(array['kb_documents','kb_chunks']) as t loop
    execute format('drop policy if exists demo_owner_isolation on public.%I', r.t);
    execute format('create policy demo_owner_isolation on public.%I as restrictive for all to authenticated using (tenant_id <> all (array(select id from public.tenants where is_demo)) or created_by is null or public._demo_created_by_visible(tenant_id, created_by)) with check (tenant_id <> all (array(select id from public.tenants where is_demo)) or created_by is null or public._demo_created_by_visible(tenant_id, created_by))', r.t);
  end loop;
end $$;

-- ---------- fail-safe owner for demo rows inserted without one ----------
create or replace function public.trg_demo_owner_default()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('dawrak.seeding', true), '') = 'on' then return new; end if;  -- seed rows stay shared
  if (to_jsonb(new) ->> tg_argv[0]) is null and public._tenant_is_demo(new.tenant_id) then
    new := jsonb_populate_record(new, jsonb_build_object(tg_argv[0], encode(extensions.gen_random_bytes(32), 'hex')));
  end if;
  return new;
end $$;
revoke all on function public.trg_demo_owner_default() from public, anon, authenticated;

drop trigger if exists demo_owner_default on public.customers;
create trigger demo_owner_default before insert on public.customers
  for each row execute function public.trg_demo_owner_default('demo_session_hash');
drop trigger if exists demo_owner_default on public.appointments;
create trigger demo_owner_default before insert on public.appointments
  for each row execute function public.trg_demo_owner_default('demo_session_hash');
drop trigger if exists demo_owner_default on public.conversations;
create trigger demo_owner_default before insert on public.conversations
  for each row execute function public.trg_demo_owner_default('session_hash');

-- ---------- create_public_booking: stamps the owner (p_session_hash) on the new customer and appointment ----------
-- New optional last argument; old callers (9 arguments) still resolve and get an invisible, random owner.
drop function if exists public.create_public_booking(uuid, uuid, uuid, timestamptz, text, text, text, text, text);
create or replace function public.create_public_booking(
  p_tenant_id uuid, p_provider_id uuid, p_service_id uuid, p_starts_at timestamptz,
  p_full_name text, p_phone text, p_email text default null,
  p_source text default 'web', p_locale text default 'ar', p_session_hash text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_tenant   public.tenants;
  v_service  public.services;
  v_customer public.customers;
  v_appt     public.appointments;
  v_phone    text := regexp_replace(coalesce(p_phone, ''), '[\s\-()]', '', 'g');
  v_name     text := btrim(coalesce(p_full_name, ''));
  v_status   text;
  v_deposit  numeric := 0;
  v_new      boolean;
  v_hash     text;
begin
  perform public._lock_provider(p_provider_id);   -- serialise bookings per provider, before any row lock

  if p_source not in ('web','chat') then raise exception 'invalid_source'; end if;
  if char_length(v_name) < 2 or char_length(v_name) > 100 then raise exception 'invalid_name'; end if;
  if v_phone !~ '^\+?[0-9]{7,15}$' then raise exception 'invalid_phone'; end if;
  if p_email is not null and (char_length(p_email) > 200 or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'invalid_email';
  end if;

  perform public.expire_pending_bookings();

  select * into v_tenant from public.tenants where id = p_tenant_id;
  if not found then raise exception 'tenant_not_found'; end if;
  -- owner of the new rows: only demo tenants carry one (a malformed value is ignored; the trigger then randomises it)
  -- (ownerless demo booking: ONE random owner for both rows, so they purge together and stay invisible to everyone)
  v_hash := case when v_tenant.is_demo then
              case when p_session_hash ~ '^[0-9a-f]{64}$' then p_session_hash else encode(extensions.gen_random_bytes(32), 'hex') end
            end;
  select * into v_service from public.services where id = p_service_id and tenant_id = p_tenant_id and is_active;
  if not found then raise exception 'service_not_found'; end if;
  if not exists (select 1 from public.provider_services ps
                 join public.providers p on p.id = ps.provider_id and p.tenant_id = ps.tenant_id and p.is_active
                 where ps.provider_id = p_provider_id and ps.service_id = p_service_id and ps.tenant_id = p_tenant_id) then
    raise exception 'provider_not_found';
  end if;

  if p_starts_at > now() + interval '90 days' then raise exception 'too_far'; end if;
  if p_starts_at <= now()
     or not public._slot_is_free(p_tenant_id, p_provider_id, p_starts_at, v_service.duration_min, v_service.buffer_min) then
    raise exception 'slot_taken' using errcode = '23P01';
  end if;

  insert into public.customers (tenant_id, full_name, phone, email, locale, demo_session_hash)
  values (p_tenant_id, v_name, v_phone, p_email, case when p_locale = 'en' then 'en' else 'ar' end, v_hash)
  on conflict (tenant_id, phone, (coalesce(demo_session_hash, ''))) do nothing
  returning * into v_customer;
  v_new := found;
  if not v_new then
    -- same tenant and phone AND same owner (real tenants: both NULL; demo: this visitor's own customer only)
    select * into v_customer from public.customers
     where tenant_id = p_tenant_id and phone = v_phone and coalesce(demo_session_hash, '') = coalesce(v_hash, '');
  end if;

  if (select count(*) from public.appointments a
       where a.tenant_id = p_tenant_id and a.customer_id = v_customer.id
         and a.status in ('pending_payment','confirmed') and a.starts_at > now()) >= 3 then
    raise exception 'too_many_bookings';
  end if;

  v_status := case when v_tenant.deposit_enabled then 'pending_payment' else 'confirmed' end;
  if v_tenant.deposit_enabled then
    v_deposit := case v_tenant.deposit_type
                   when 'percent' then round(v_service.price * v_tenant.deposit_value / 100, 2)
                   else least(v_tenant.deposit_value, v_service.price) end;
  end if;

  begin
    insert into public.appointments (tenant_id, provider_id, service_id, customer_id, starts_at, ends_at,
                                     status, source, price, payment_expires_at, demo_session_hash)
    values (p_tenant_id, p_provider_id, p_service_id, v_customer.id, p_starts_at,
            p_starts_at + make_interval(mins => v_service.duration_min),
            v_status, p_source, v_service.price,
            case when v_tenant.deposit_enabled then now() + interval '15 minutes' end, v_hash)
    returning * into v_appt;
  exception when exclusion_violation then
    raise exception 'slot_taken' using errcode = '23P01';
  end;

  -- demo: the same session also owns the mailbox / "my link" binding (idempotent; the app calls
  -- demo_attach_session as well)
  if v_hash is not null then
    insert into public.demo_appointment_sessions (appointment_id, tenant_id, session_hash)
    values (v_appt.id, p_tenant_id, v_hash)
    on conflict (appointment_id) do nothing;
  end if;

  return jsonb_build_object(
    'appointment_id', v_appt.id, 'status', v_appt.status,
    'starts_at', v_appt.starts_at, 'ends_at', v_appt.ends_at,
    'price', v_appt.price, 'deposit_amount', v_deposit, 'currency', v_tenant.currency,
    'payment_expires_at', v_appt.payment_expires_at,
    'customer_token', case when v_new then v_customer.access_token end);
end $$;
revoke all on function public.create_public_booking(uuid, uuid, uuid, timestamptz, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_public_booking(uuid, uuid, uuid, timestamptz, text, text, text, text, text, text)
  to service_role;

-- =====================================================================================
-- M3. Knowledge search in demo tenants: seeded chunks + the current visitor's own chunks
-- =====================================================================================
-- match_kb_chunks stays SECURITY INVOKER (staff: RLS; agent: service role bypasses RLS, so the visibility
-- predicate below is what isolates visitors). Without p_session_hash a demo tenant returns seeded chunks only.
drop function if exists public.match_kb_chunks(uuid, extensions.vector, int);
create or replace function public.match_kb_chunks(
  p_tenant_id uuid, p_embedding extensions.vector(768), p_k int default 5, p_session_hash text default null)
returns table (id uuid, document_id uuid, content text, similarity double precision)
language sql stable
set search_path = public, extensions
as $$
  select c.id, c.document_id, c.content, 1 - (c.embedding <=> p_embedding) as similarity
  from public.kb_chunks c
  where c.tenant_id = p_tenant_id and c.embedding is not null
    and public._demo_created_by_visible(c.tenant_id, c.created_by, p_session_hash)
  order by c.embedding <=> p_embedding
  limit least(greatest(p_k, 1), 50)
$$;
revoke all on function public.match_kb_chunks(uuid, extensions.vector, int, text) from public, anon;
grant execute on function public.match_kb_chunks(uuid, extensions.vector, int, text) to authenticated, service_role;

-- chunks for the keyword fallback (same visibility rule); embedded = has an embedding
create or replace function public.kb_search_chunks(p_tenant_id uuid, p_session_hash text default null, p_limit int default 500)
returns table (id uuid, content text, embedded boolean)
language sql stable
set search_path = public, extensions
as $$
  select c.id, c.content, c.embedding is not null
  from public.kb_chunks c
  where c.tenant_id = p_tenant_id
    and public._demo_created_by_visible(c.tenant_id, c.created_by, p_session_hash)
  order by c.chunk_index, c.id
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke all on function public.kb_search_chunks(uuid, text, int) from public, anon;
grant execute on function public.kb_search_chunks(uuid, text, int) to authenticated, service_role;

-- =====================================================================================
-- L1. created_by cannot be forged: dropped from the INSERT grants (the column default auth.uid() sets it)
-- =====================================================================================
do $$
declare t text; v_cols text;
begin
  foreach t in array array['provider_services','working_hours','time_off','kb_documents','kb_chunks'] loop
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
      from pg_attribute a
     where a.attrelid = ('public.' || t)::regclass and a.attnum > 0 and not a.attisdropped
       and a.attgenerated = '' and a.attname <> 'created_by';
    execute format('revoke insert on public.%I from authenticated', t);
    execute format('grant insert (%s) on public.%I to authenticated', v_cols, t);
  end loop;
end $$;

-- demo catalogue freeze, tightened: UPDATE of a seeded kb_chunk (embedding included) is refused for signed-in
-- users; INSERT of a chunk is allowed only into a document the caller created. service_role (cron re-embedding,
-- seeding) and definer functions are exempt as before.
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
    if not v_mine and tg_table_name = 'kb_chunks' and v_uid is not null then
      v_mine := exists (select 1 from public.kb_documents d
                         where d.id = old.document_id and d.tenant_id = old.tenant_id and d.created_by = v_uid);
    end if;
    if not v_mine then raise exception 'demo_readonly' using errcode = '42501'; end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function public.trg_demo_catalog_readonly() from public, anon, authenticated;

create or replace function public.trg_demo_kb_chunk_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  if current_user in ('authenticated','anon') and public._tenant_is_demo(new.tenant_id) then
    if v_uid is null or not exists (select 1 from public.kb_documents d
                                     where d.id = new.document_id and d.tenant_id = new.tenant_id and d.created_by = v_uid) then
      raise exception 'demo_readonly' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.trg_demo_kb_chunk_insert() from public, anon, authenticated;
drop trigger if exists demo_kb_chunk_insert_own on public.kb_chunks;
create trigger demo_kb_chunk_insert_own before insert on public.kb_chunks
  for each row execute function public.trg_demo_kb_chunk_insert();

-- =====================================================================================
-- M4. Demo deposit is frozen (the demo clinic has none)
-- =====================================================================================
create or replace function public.trg_demo_tenants_readonly()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated','anon') then
    if new.is_demo is distinct from old.is_demo then
      raise exception 'demo_readonly' using errcode = '42501';
    end if;
    if old.is_demo and (
         new.name_ar       is distinct from old.name_ar
      or new.name_en       is distinct from old.name_en
      or new.logo_url      is distinct from old.logo_url
      or new.brand_color   is distinct from old.brand_color
      or new.slug          is distinct from old.slug
      or new.kind          is distinct from old.kind
      or new.timezone      is distinct from old.timezone
      or new.currency      is distinct from old.currency
      or new.deposit_enabled is distinct from old.deposit_enabled
      or new.deposit_type    is distinct from old.deposit_type
      or new.deposit_value   is distinct from old.deposit_value) then
      raise exception 'demo_readonly' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.trg_demo_tenants_readonly() from public, anon, authenticated;

-- One place that makes the seeded demo clinic deposit-free. seed_demo() calls it after the body (the body of
-- _seed_demo_body from migration 8 still inserts deposit_enabled = true), and this migration calls it once so a hosted
-- project converges now; reset_demo() (daily) re-applies it through seed_demo(). Idempotent.
create or replace function public._demo_post_seed()
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare v_clinic uuid := 'd0000000-0000-4000-8000-000000000001';
begin
  update public.tenants set deposit_enabled = false, deposit_type = 'fixed', deposit_value = 0
   where id = v_clinic and (deposit_enabled or deposit_value <> 0);
  -- seeded deposit receipts of future bookings no longer exist (completed visits keep their full-price payments)
  delete from public.payments p using public.appointments a
   where p.tenant_id = v_clinic and a.id = p.appointment_id and a.tenant_id = p.tenant_id
     and a.status = 'confirmed' and p.provider_ref like 'demo\_%';
  -- seeded texts that mentioned a deposit (the cron re-embeds a chunk whose embedding was cleared)
  update public.kb_chunks set content = 'لا يوجد عربون للحجز، ويتم الدفع في العيادة بعد الزيارة. يمكنك إلغاء الموعد أو تأجيله قبل الموعد بساعتين على الأقل.',
                              embedding = null
   where tenant_id = v_clinic and document_id = 'ab000000-0000-4000-8000-000000000001' and chunk_index = 1
     and content like '%العربون%';
  update public.messages set content = 'تم تأكيد الحجز. نراك في الموعد، وتصلك رسالة تذكير قبله.'
   where tenant_id = v_clinic and conversation_id = 'cc000000-0000-4000-8000-000000000001'
     and role = 'assistant' and content like '%العربون%';
end $$;
revoke all on function public._demo_post_seed() from public, anon, authenticated, service_role;

create or replace function public.seed_demo()
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform set_config('dawrak.seeding', 'on', true);
  perform public._seed_demo_body();
  perform public._demo_post_seed();
  perform set_config('dawrak.seeding', 'off', true);
end $$;
revoke all on function public.seed_demo() from public, anon, authenticated;
grant execute on function public.seed_demo() to service_role;

select public._demo_post_seed();

-- =====================================================================================
-- M2 (review). Seeded demo rows are read-only for visitors; the RPCs that bypass RLS apply the same rules
-- =====================================================================================
-- A visitor plays with their OWN data: they book (public form or chat) and then confirm / cancel / reschedule /
-- annotate those appointments from the dashboard. Seeded appointments are visible but cannot be changed
-- ('demo_readonly', 42501); another visitor's appointments do not exist for them ('appointment_not_found').
-- SECURITY DEFINER functions run as postgres (BYPASSRLS), so staff_update_appointment checks it itself.
create or replace function public.staff_update_appointment(
  p_appointment_id uuid, p_starts_at timestamptz default null, p_provider_id uuid default null,
  p_service_id uuid default null, p_status text default null, p_notes text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_appt   public.appointments;
  v_svc    public.services;
  v_prov   uuid;
  v_start  timestamptz;
  v_status text;
  v_holds  constant text[] := array['pending_payment','confirmed','completed'];
  v_old    uuid;
begin
  -- membership is checked below, under the lock. Two providers are locked in a fixed (text) order.
  select provider_id into v_old from public.appointments where id = p_appointment_id;
  if found then
    if p_provider_id is not null and p_provider_id <> v_old then
      perform public._lock_provider(case when v_old::text < p_provider_id::text then v_old else p_provider_id end);
      perform public._lock_provider(case when v_old::text < p_provider_id::text then p_provider_id else v_old end);
    else
      perform public._lock_provider(v_old);
    end if;
  end if;

  perform public.expire_pending_bookings();
  select * into v_appt from public.appointments where id = p_appointment_id for update;
  if not found or coalesce(public.auth_tenant_role(v_appt.tenant_id), '') not in ('owner','receptionist') then
    raise exception 'appointment_not_found';
  end if;
  -- demo isolation: another visitor's appointment is invisible, a seeded one is read-only
  if not public._demo_owner_visible(v_appt.tenant_id, v_appt.demo_session_hash) then
    raise exception 'appointment_not_found';
  end if;
  if not public._demo_owner_writable(v_appt.tenant_id, v_appt.demo_session_hash) then
    raise exception 'demo_readonly' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('pending_payment','confirmed','cancelled','completed','no_show') then
    raise exception 'invalid_status';
  end if;

  v_prov   := coalesce(p_provider_id, v_appt.provider_id);
  v_start  := coalesce(p_starts_at, v_appt.starts_at);
  v_status := coalesce(p_status, v_appt.status);

  select * into v_svc from public.services
   where id = coalesce(p_service_id, v_appt.service_id) and tenant_id = v_appt.tenant_id;
  if not found then raise exception 'service_not_found'; end if;
  if not exists (select 1 from public.provider_services ps
                 where ps.provider_id = v_prov and ps.service_id = v_svc.id and ps.tenant_id = v_appt.tenant_id) then
    raise exception 'provider_not_found';
  end if;

  if v_status = any (v_holds)
     and (v_start <> v_appt.starts_at or v_prov <> v_appt.provider_id or v_svc.id <> v_appt.service_id
          or not (v_appt.status = any (v_holds)))
     and not public._slot_is_free(v_appt.tenant_id, v_prov, v_start, v_svc.duration_min, v_svc.buffer_min, v_appt.id) then
    raise exception 'slot_taken' using errcode = '23P01';
  end if;

  begin
    update public.appointments
       set provider_id = v_prov,
           service_id  = v_svc.id,
           starts_at   = v_start,
           ends_at     = v_start + make_interval(mins => v_svc.duration_min),
           status      = v_status,
           cancel_reason = case when v_status = 'cancelled' then coalesce(cancel_reason, 'staff') else null end,
           price       = case when v_svc.id <> v_appt.service_id then v_svc.price else price end,
           notes       = case when p_notes is null then notes else nullif(p_notes, '') end
     where id = v_appt.id
    returning * into v_appt;
  exception when exclusion_violation then
    raise exception 'slot_taken' using errcode = '23P01';
  end;

  return jsonb_build_object('appointment_id', v_appt.id, 'provider_id', v_appt.provider_id,
    'service_id', v_appt.service_id, 'starts_at', v_appt.starts_at, 'ends_at', v_appt.ends_at,
    'status', v_appt.status, 'price', v_appt.price, 'notes', v_appt.notes);
end $$;
-- unchanged ACL (migration 10/16): staff_update_appointment stays callable by authenticated only through its own role check

-- Other definer functions that touch appointments/customers/conversations were reviewed:
--   customer_* / portal functions    : keyed by the customer's secret token (a visitor only holds their own tokens)
--   customer_issue_link              : re-created below, so a demo lookup only ever matches the caller's own customer
--   staff_get_available_slots        : returns free slots only (no appointment, customer or conversation row)
--   settle_payment / expire_pending  : service_role / cron, no staff caller
-- ---------- customer_issue_link: demo lookups only match the requesting visitor's own customer (M3) ----------
create or replace function public.customer_issue_link(
  p_tenant_id uuid, p_phone text, p_email text,
  p_session_hash text default null, p_force boolean default false)
returns table (link_token text, contact_email text, contact_name text, contact_locale text)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[\s\-()]', '', 'g');
  v_id    uuid;
  v_demo  boolean := public._tenant_is_demo(p_tenant_id);
begin
  -- demo: several visitors may hold a customer with the same phone; only this visitor's own row can match
  if v_demo and p_session_hash is null then return; end if;
  if v_phone <> '' then
    select c.id into v_id from public.customers c
     where c.tenant_id = p_tenant_id and c.phone = v_phone
       and (not v_demo or c.demo_session_hash = p_session_hash)
     order by c.created_at desc limit 1;
  elsif coalesce(p_email, '') <> '' then
    select c.id into v_id from public.customers c
     where c.tenant_id = p_tenant_id and lower(c.email) = lower(p_email)
       and (not v_demo or c.demo_session_hash = p_session_hash)
     order by c.created_at desc limit 1;
  end if;
  if v_id is null then return; end if;

  if v_demo then
    if not exists (
         select 1
           from public.demo_appointment_sessions d
          where d.session_hash = p_session_hash
            and d.tenant_id = p_tenant_id
            and d.appointment_id = (select a.id from public.appointments a
                                     where a.customer_id = v_id and a.tenant_id = p_tenant_id
                                     order by a.created_at, a.id limit 1)) then
      return;  -- not this visitor's customer: same result as "unknown contact"
    end if;
  end if;

  update public.customers c
     set access_token = case when coalesce(p_force, false) or c.access_token_expires_at <= now()
                             then encode(extensions.gen_random_bytes(24), 'hex') else c.access_token end,
         access_token_expires_at = now() + interval '30 days'
   where c.id = v_id
  returning c.access_token, c.email, c.full_name, c.locale
       into link_token, contact_email, contact_name, contact_locale;
  return next;
end $$;
revoke all on function public.customer_issue_link(uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.customer_issue_link(uuid, text, text, text, boolean) to service_role;

-- =====================================================================================
-- M3 (review). The demo is read-mostly: visitors cannot add catalogue rows (providers, services, links, hours, time off)
-- =====================================================================================
-- Rows a visitor adds to the shared catalogue would be visible on the public booking pages and in every other visitor's
-- chat (listing spam, prompt injection) or block slots for everyone (time off). Visitors keep their own KB documents
-- (visible only to them, see M3 above) and their own appointments. Updates/deletes of catalogue rows were already
-- limited to rows created by the caller (migration 22), and since inserting is now refused only legacy rows remain.
create or replace function public.trg_demo_catalog_no_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated','anon') and public._tenant_is_demo(new.tenant_id) then
    raise exception 'demo_readonly' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.trg_demo_catalog_no_insert() from public, anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['providers','services','provider_services','working_hours','time_off'] loop
    execute format('drop trigger if exists demo_catalog_no_insert on public.%I', t);
    execute format('create trigger demo_catalog_no_insert before insert on public.%I
                      for each row execute function public.trg_demo_catalog_no_insert()', t);
  end loop;
end $$;

-- =====================================================================================
-- M1. Demo capacity: 6 h visitors, eviction of old visitors instead of refusing, owned data purged with the visitor
-- =====================================================================================
alter table public.demo_users alter column expires_at set default now() + interval '6 hours';
update public.demo_users set expires_at = created_at + interval '6 hours'
 where expires_at > created_at + interval '6 hours';

-- Deletes the given visitors (auth.users cascades registry, memberships, sessions) AND everything they own.
-- EVERY delete is limited to DEMO tenants: the session hash only identifies demo data, and a real tenant's rows
-- must never be reachable from here. Rows are deleted by owner hash unless another live visitor of the same browser
-- still uses it. Customers are only removed when no other owner's appointment still hangs on them (the FK cascade
-- would take it along). Never touches the six fixed seeded users.
create or replace function public._demo_purge_users(p_ids uuid[])
returns int
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_hashes text[];
  v_n int;
  t text;
begin
  select coalesce(array_agg(distinct d.session_hash), '{}') into v_hashes
    from public.demo_users d
   where d.user_id = any(p_ids) and d.session_hash is not null
     and not exists (select 1 from public.demo_users o where o.session_hash = d.session_hash and o.user_id <> all(p_ids));

  if cardinality(v_hashes) > 0 then
    delete from public.appointments a
     where a.demo_session_hash = any(v_hashes)
       and a.tenant_id in (select x.id from public.tenants x where x.is_demo);
    delete from public.customers c
     where c.demo_session_hash = any(v_hashes)
       and c.tenant_id in (select x.id from public.tenants x where x.is_demo)
       and not exists (select 1 from public.appointments a
                        where a.customer_id = c.id and a.tenant_id = c.tenant_id
                          and a.demo_session_hash is distinct from c.demo_session_hash);
    delete from public.conversations v
     where v.session_hash = any(v_hashes)
       and v.tenant_id in (select x.id from public.tenants x where x.is_demo);
    delete from public.demo_outbox o where o.session_hash = any(v_hashes);   -- demo_outbox only ever holds demo tenants
  end if;
  foreach t in array array['kb_documents','providers','services','time_off','working_hours','provider_services'] loop
    execute format('delete from public.%I where created_by = any($1) and tenant_id in (select x.id from public.tenants x where x.is_demo)', t)
      using p_ids;
  end loop;

  delete from auth.users u
   where u.id = any(p_ids) and u.id::text !~ '^a0000000-0000-4000-8000-00000000000[0-9]$';
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public._demo_purge_users(uuid[]) from public, anon, authenticated, service_role;

-- same advisory lock as register_demo_user: a purge and a registration never interleave
create or replace function public.purge_expired_demo_users()
returns int
language plpgsql volatile security definer
set search_path = ''
as $$
declare v_n int := 0; v_o int; v_ids uuid[];
begin
  perform pg_advisory_xact_lock(hashtext('dawrak.register_demo_user'));
  select coalesce(array_agg(x.user_id), '{}') into v_ids
    from (select d.user_id from public.demo_users d where d.expires_at <= now() order by d.expires_at limit 500) x;
  if cardinality(v_ids) > 0 then v_n := public._demo_purge_users(v_ids); end if;

  -- visitors that never registered (crash between createUser and register_demo_user)
  delete from auth.users u
   where coalesce(u.raw_app_meta_data ->> 'demo_visitor', '') = 'true'
     and u.created_at < now() - interval '1 hour'
     and not exists (select 1 from public.demo_users d where d.user_id = u.id)
     and u.id::text !~ '^a0000000-0000-4000-8000-00000000000[0-9]$';
  get diagnostics v_o = row_count;

  -- visitor-owned DEMO rows never outlive the visitor lifetime (also anonymous booking visitors without an account)
  delete from public.appointments a using public.tenants t
   where t.id = a.tenant_id and t.is_demo and a.demo_session_hash is not null and a.created_at < now() - interval '6 hours';
  delete from public.customers c using public.tenants t
   where t.id = c.tenant_id and t.is_demo and c.demo_session_hash is not null and c.created_at < now() - interval '6 hours'
     and not exists (select 1 from public.appointments a
                      where a.customer_id = c.id and a.tenant_id = c.tenant_id and a.demo_session_hash is distinct from c.demo_session_hash);
  delete from public.conversations v using public.tenants t
   where t.id = v.tenant_id and t.is_demo and v.session_hash is not null and v.started_at < now() - interval '6 hours';

  return v_n + v_o;
end $$;
revoke all on function public.purge_expired_demo_users() from public, anon, authenticated;
grant execute on function public.purge_expired_demo_users() to service_role;

-- register_demo_user: + p_session_hash. When a cap is reached: expired visitors go first, then the OLDEST visitors that
-- are at least 10 minutes old; a visitor created in the last 10 minutes is never evicted. If only fresh visitors
-- remain the call is refused (54000 demo_users_limit / demo_tenant_users_limit -> the app shows "busy").
drop function if exists public.register_demo_user(uuid, uuid, text);
drop function if exists public.register_demo_user(uuid, uuid, text, text);
create or replace function public.register_demo_user(
  p_user_id uuid, p_tenant_id uuid, p_role text, p_session_hash text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_row  public.demo_users;
  v_over int;
  v_ids  uuid[];
begin
  if p_user_id is null or p_tenant_id is null then raise exception 'invalid_arguments'; end if;
  if not public._tenant_is_demo(p_tenant_id) then raise exception 'not_demo'; end if;
  if p_role is null or p_role not in ('owner','receptionist') then raise exception 'invalid_role'; end if;
  if p_session_hash is not null and p_session_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_session'; end if;
  if p_user_id::text ~ '^a0000000-0000-4000-8000-00000000000[0-9]$' then raise exception 'protected_user'; end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'user_not_found' using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(hashtext('dawrak.register_demo_user'));
  if exists (select 1 from public.demo_users where user_id = p_user_id) then raise exception 'already_registered'; end if;

  -- 1) expired visitors are free capacity
  select coalesce(array_agg(x.user_id), '{}') into v_ids
    from (select d.user_id from public.demo_users d where d.expires_at <= now() order by d.expires_at limit 500) x;
  if cardinality(v_ids) > 0 then perform public._demo_purge_users(v_ids); end if;

  -- 2) still full: evict the oldest non-fresh visitors (global 300, per tenant 150)
  v_over := (select count(*) from public.demo_users) - 299;
  if v_over > 0 then
    select coalesce(array_agg(x.user_id), '{}') into v_ids
      from (select user_id from public.demo_users where created_at < now() - interval '10 minutes'
             order by created_at, user_id limit v_over) x;
    if cardinality(v_ids) < v_over then raise exception 'demo_users_limit' using errcode = '54000'; end if;
    perform public._demo_purge_users(v_ids);
  end if;
  v_over := (select count(*) from public.demo_users where tenant_id = p_tenant_id) - 149;
  if v_over > 0 then
    select coalesce(array_agg(x.user_id), '{}') into v_ids
      from (select user_id from public.demo_users where tenant_id = p_tenant_id and created_at < now() - interval '10 minutes'
             order by created_at, user_id limit v_over) x;
    if cardinality(v_ids) < v_over then raise exception 'demo_tenant_users_limit' using errcode = '54000'; end if;
    perform public._demo_purge_users(v_ids);
  end if;

  insert into public.demo_users (user_id, tenant_id, role, session_hash, expires_at)
  values (p_user_id, p_tenant_id, p_role, p_session_hash, now() + interval '6 hours')
  returning * into v_row;
  insert into public.memberships (user_id, tenant_id, role) values (p_user_id, p_tenant_id, p_role)
  on conflict (user_id, tenant_id) do update set role = excluded.role;

  return jsonb_build_object('user_id', v_row.user_id, 'tenant_id', v_row.tenant_id,
                            'role', v_row.role, 'expires_at', v_row.expires_at);
end $$;
revoke all on function public.register_demo_user(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.register_demo_user(uuid, uuid, text, text) to service_role;
comment on function public.register_demo_user(uuid, uuid, text, text) is
  'service_role only. Registers an already-created auth user as a temporary demo visitor (6 h) bound to the visitor session hash. At 300 total / 150 per tenant: expired visitors are purged, then the oldest visitors older than 10 minutes are evicted (with their data); fresh visitors are never evicted (refused with 54000).';

-- =====================================================================================
-- Info. _demo_cap_exceeded is no longer executable by signed-in users
-- =====================================================================================
-- The row-cap trigger becomes SECURITY DEFINER so it can call the helper on behalf of the writer.
create or replace function public.trg_demo_row_cap()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('dawrak.seeding', true), '') = 'on' then return null; end if;
  if public._demo_cap_exceeded(new.tenant_id, tg_table_name, tg_argv[0]::int) then
    raise exception 'demo_limit' using errcode = '54000';
  end if;
  return null;
end $$;
revoke all on function public.trg_demo_row_cap() from public, anon, authenticated;
revoke execute on function public._demo_cap_exceeded(uuid, text, int) from authenticated;
