-- Row Level Security. Isolation is driven by memberships(user_id, tenant_id, role).
-- Roles: owner = everything; receptionist = everything except payments and tenant settings;
-- provider = only own appointments, and customers on them.
-- anon gets NO table access at all (see grants migration); public booking goes through functions.

-- ---------- helpers (security definer so they can read memberships without recursion) ----------
create or replace function public.auth_tenant_role(p_tenant_id uuid)
returns text
language sql stable security definer
set search_path = ''
as $$
  select m.role
  from public.memberships m
  where m.user_id = (select auth.uid()) and m.tenant_id = p_tenant_id
$$;

-- providers.id of the signed-in user within a tenant (null if not a provider there)
create or replace function public.auth_provider_id(p_tenant_id uuid)
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select p.id
  from public.providers p
  where p.user_id = (select auth.uid()) and p.tenant_id = p_tenant_id
$$;

revoke all on function public.auth_tenant_role(uuid), public.auth_provider_id(uuid) from public, anon;
grant execute on function public.auth_tenant_role(uuid), public.auth_provider_id(uuid) to authenticated, service_role;

-- ---------- enable + force on every table ----------
do $$
declare t text;
begin
  foreach t in array array[
    'tenants','memberships','providers','services','provider_services','working_hours','time_off',
    'customers','appointments','payments','reminders','kb_documents','kb_chunks',
    'conversations','messages','rate_limits']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- ---------- tenants: members read, owner updates settings. Creation = service role only. ----------
create policy tenants_select on public.tenants for select to authenticated
  using (public.auth_tenant_role(id) is not null);
create policy tenants_update_owner on public.tenants for update to authenticated
  using (public.auth_tenant_role(id) = 'owner')
  with check (public.auth_tenant_role(id) = 'owner');

-- ---------- memberships: see own rows; owner manages the tenant's members ----------
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or public.auth_tenant_role(tenant_id) = 'owner');
create policy memberships_insert_owner on public.memberships for insert to authenticated
  with check (public.auth_tenant_role(tenant_id) = 'owner');
create policy memberships_update_owner on public.memberships for update to authenticated
  using (public.auth_tenant_role(tenant_id) = 'owner')
  with check (public.auth_tenant_role(tenant_id) = 'owner');
create policy memberships_delete_owner on public.memberships for delete to authenticated
  using (public.auth_tenant_role(tenant_id) = 'owner');

-- ---------- catalogue tables: every member reads; owner + receptionist write ----------
do $$
declare t text;
begin
  foreach t in array array['providers','services','provider_services'] loop
    execute format($f$create policy %1$I_select on public.%1$I for select to authenticated
      using (public.auth_tenant_role(tenant_id) is not null)$f$, t);
    execute format($f$create policy %1$I_write_staff on public.%1$I for all to authenticated
      using (public.auth_tenant_role(tenant_id) in ('owner','receptionist'))
      with check (public.auth_tenant_role(tenant_id) in ('owner','receptionist'))$f$, t);
  end loop;
end $$;

-- ---------- working_hours / time_off: staff manage all; a provider manages only their own ----------
do $$
declare t text;
begin
  foreach t in array array['working_hours','time_off'] loop
    execute format($f$create policy %1$I_select on public.%1$I for select to authenticated
      using (public.auth_tenant_role(tenant_id) is not null)$f$, t);
    execute format($f$create policy %1$I_write_staff on public.%1$I for all to authenticated
      using (public.auth_tenant_role(tenant_id) in ('owner','receptionist'))
      with check (public.auth_tenant_role(tenant_id) in ('owner','receptionist'))$f$, t);
    execute format($f$create policy %1$I_write_own_provider on public.%1$I for all to authenticated
      using (public.auth_tenant_role(tenant_id) = 'provider' and provider_id = public.auth_provider_id(tenant_id))
      with check (public.auth_tenant_role(tenant_id) = 'provider' and provider_id = public.auth_provider_id(tenant_id))$f$, t);
  end loop;
end $$;

-- ---------- customers ----------
create policy customers_staff_all on public.customers for all to authenticated
  using (public.auth_tenant_role(tenant_id) in ('owner','receptionist'))
  with check (public.auth_tenant_role(tenant_id) in ('owner','receptionist'));
create policy customers_provider_select on public.customers for select to authenticated
  using (
    public.auth_tenant_role(tenant_id) = 'provider'
    and exists (
      select 1 from public.appointments a
      where a.customer_id = customers.id
        and a.tenant_id = customers.tenant_id
        and a.provider_id = public.auth_provider_id(customers.tenant_id)
    )
  );

-- ---------- appointments ----------
create policy appointments_staff_all on public.appointments for all to authenticated
  using (public.auth_tenant_role(tenant_id) in ('owner','receptionist'))
  with check (public.auth_tenant_role(tenant_id) in ('owner','receptionist'));
create policy appointments_provider_select on public.appointments for select to authenticated
  using (public.auth_tenant_role(tenant_id) = 'provider' and provider_id = public.auth_provider_id(tenant_id));
-- provider may update status/notes of their own appointments (e.g. mark completed / no_show)
create policy appointments_provider_update on public.appointments for update to authenticated
  using (public.auth_tenant_role(tenant_id) = 'provider' and provider_id = public.auth_provider_id(tenant_id))
  with check (public.auth_tenant_role(tenant_id) = 'provider' and provider_id = public.auth_provider_id(tenant_id));

-- ---------- payments: owner only (revenue). Webhook writes use the service role. ----------
create policy payments_owner_all on public.payments for all to authenticated
  using (public.auth_tenant_role(tenant_id) = 'owner')
  with check (public.auth_tenant_role(tenant_id) = 'owner');

-- ---------- reminders: staff read only (service role writes) ----------
create policy reminders_staff_select on public.reminders for select to authenticated
  using (public.auth_tenant_role(tenant_id) in ('owner','receptionist'));

-- ---------- knowledge base: staff read, owner writes ----------
do $$
declare t text;
begin
  foreach t in array array['kb_documents','kb_chunks'] loop
    execute format($f$create policy %1$I_select_staff on public.%1$I for select to authenticated
      using (public.auth_tenant_role(tenant_id) in ('owner','receptionist'))$f$, t);
    execute format($f$create policy %1$I_write_owner on public.%1$I for all to authenticated
      using (public.auth_tenant_role(tenant_id) = 'owner')
      with check (public.auth_tenant_role(tenant_id) = 'owner')$f$, t);
  end loop;
end $$;

-- ---------- conversations / messages: staff read (service role writes from the agent) ----------
create policy conversations_staff_select on public.conversations for select to authenticated
  using (public.auth_tenant_role(tenant_id) in ('owner','receptionist'));
create policy messages_staff_select on public.messages for select to authenticated
  using (public.auth_tenant_role(tenant_id) in ('owner','receptionist'));

-- rate_limits: RLS enabled + forced, deliberately NO policies. Only service_role / security
-- definer functions (check_rate_limit) touch it.
