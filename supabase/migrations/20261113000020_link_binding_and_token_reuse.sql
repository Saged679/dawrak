-- H2 (demo link theft) + M1 (link DoS).
--
-- M1: a still-valid customer token is REUSED (expiry slides to now()+30d) instead of being rotated on every
--     request, so anyone who knows a phone number can no longer invalidate the customer's links by spamming
--     the "send me a link" form. A new token is generated only when the current one is expired, or when the
--     caller passes p_force => true (the app does that where rotation is wanted, e.g. after a cancel).
-- H2: in DEMO tenants customer_issue_link only issues a token when the requesting visitor session
--     (SHA-256 hash of the httpOnly cookie, as in demo_appointment_sessions) is bound to that customer:
--     the session must own the customer's FIRST appointment, i.e. it is the session that created the customer.
--     A session that merely booked with the same phone later (existing customer) is not bound, so visitor B
--     cannot pull visitor A's link by typing A's phone. No binding -> empty result, the same shape as an
--     unknown contact, so the app's response stays neutral.
--     Without p_session_hash (null) a demo tenant never issues: fail closed.

drop function if exists public.customer_issue_link(uuid, text, text);
drop function if exists public.issue_customer_magic_link(uuid, text);

create or replace function public.issue_customer_magic_link(p_tenant_id uuid, p_phone text, p_force boolean default false)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[\s\-()]', '', 'g');
  v_token text;
begin
  update public.customers c
     set access_token = case when coalesce(p_force, false) or c.access_token_expires_at <= now()
                             then encode(extensions.gen_random_bytes(24), 'hex') else c.access_token end,
         access_token_expires_at = now() + interval '30 days'
   where c.tenant_id = p_tenant_id and c.phone = v_phone
  returning c.access_token into v_token;
  return v_token;
end $$;

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
begin
  if v_phone <> '' then
    select c.id into v_id from public.customers c where c.tenant_id = p_tenant_id and c.phone = v_phone;
  elsif coalesce(p_email, '') <> '' then
    select c.id into v_id from public.customers c
     where c.tenant_id = p_tenant_id and lower(c.email) = lower(p_email)
     order by c.created_at desc limit 1;
  end if;
  if v_id is null then return; end if;

  if public._tenant_is_demo(p_tenant_id) then
    if p_session_hash is null or not exists (
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

revoke all on function public.issue_customer_magic_link(uuid, text, boolean),
  public.customer_issue_link(uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.issue_customer_magic_link(uuid, text, boolean),
  public.customer_issue_link(uuid, text, text, text, boolean) to service_role;
comment on function public.issue_customer_magic_link(uuid, text, boolean) is
  'service_role only. Returns the customer''s token (reused while unexpired, expiry slides 30d; rotated when expired or p_force). Null when no such customer.';
comment on function public.customer_issue_link(uuid, text, text, text, boolean) is
  'service_role only. Token reuse like issue_customer_magic_link; in demo tenants only for the visitor session (p_session_hash) that created the customer, else empty result. Send by e-mail only.';
