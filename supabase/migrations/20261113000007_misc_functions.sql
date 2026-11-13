-- match_kb_chunks: SECURITY INVOKER on purpose. Staff calls are filtered by RLS; the agent
-- (service role) bypasses RLS, so the explicit tenant filter below is what isolates tenants.
create or replace function public.match_kb_chunks(
  p_tenant_id uuid, p_embedding extensions.vector(768), p_k int default 5)
returns table (id uuid, document_id uuid, content text, similarity double precision)
language sql stable
set search_path = public, extensions
as $$
  select c.id, c.document_id, c.content, 1 - (c.embedding <=> p_embedding) as similarity
  from public.kb_chunks c
  where c.tenant_id = p_tenant_id and c.embedding is not null
  order by c.embedding <=> p_embedding
  limit least(greatest(p_k, 1), 50)
$$;

-- check_rate_limit: fixed window counter. Returns true while the caller is within p_max hits
-- per p_window, false once exceeded (the hit is still counted).
create or replace function public.check_rate_limit(p_key text, p_max int, p_window interval)
returns boolean
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_secs   double precision := greatest(extract(epoch from p_window), 1);
  v_bucket timestamptz := to_timestamp(floor(extract(epoch from now()) / v_secs) * v_secs);
  v_count  int;
begin
  insert into public.rate_limits as r (key, window_start, count)
  values (p_key, v_bucket, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning r.count into v_count;

  if random() < 0.01 then  -- opportunistic cleanup
    delete from public.rate_limits where window_start < now() - interval '2 days';
  end if;
  return v_count <= p_max;
end $$;

-- Cancels pending_payment bookings whose 15-minute payment window passed. Called by cron.
create or replace function public.expire_pending_bookings()
returns int
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare v_n int;
begin
  update public.appointments set status = 'cancelled'
   where status = 'pending_payment' and payment_expires_at is not null and payment_expires_at < now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;
