-- Least-privilege table grants for signed-in users (review finding H1 + audit of every table).
-- Supabase grants INSERT/UPDATE/DELETE/SELECT on every new public table to `authenticated` by default,
-- and RLS policies only decide WHICH rows, not which columns or verbs. This migration trims the grants
-- to what the dashboard really does (the Next.js app talks to the DB as `authenticated` for the
-- dashboard and as `service_role` for everything else; service_role is untouched here).
--
--   table              authenticated BEFORE                    AFTER
--   payments           select/insert/update/delete (owner)     select (11 safe columns), owner only
--   providers          all verbs                               select; insert/update on 8 profile columns
--   services           all verbs                               select; insert/update on profile columns
--   provider_services  all verbs                               select, insert, delete
--   working_hours      all verbs                               select, insert, delete (owner writes)
--   time_off           all verbs                               select, insert, delete (owner writes)
--   appointments       select, insert, delete, update(status,notes)  select, delete, update(status,notes)
--   kb_documents       all verbs                               select, insert, delete (owner)
--   kb_chunks          all verbs                               select, insert, delete, update(embedding)
--   conversations      all verbs                               select (staff)
--   messages           all verbs                               select (staff)
--   reminders          all verbs                               select (staff)
--   rate_limits        all verbs (no policy = no rows)         nothing
--   memberships        all verbs (owner policies)              unchanged (tests/dashboard rely on owner management)
--   tenants/customers  already column-limited by migration 10  unchanged

-- ---------- payments (H1) ----------
revoke all on public.payments from authenticated;
-- No public_token (the pay-page secret), checkout_url (redirect target), provider_payment_id or raw.
-- If a column is added to payments later it stays invisible to dashboards until granted here.
grant select (id, tenant_id, appointment_id, amount, currency, status, provider, provider_ref,
              review_reason, paid_at, created_at)
  on public.payments to authenticated;

drop policy if exists payments_owner_all on public.payments;
drop policy if exists payments_owner_select on public.payments;
create policy payments_owner_select on public.payments for select to authenticated
  using (public.auth_tenant_role(tenant_id) = 'owner');

-- ---------- catalogue: owner writes only what the dashboard form sends ----------
revoke insert, update, delete on public.providers from authenticated;
grant insert (tenant_id, name_ar, name_en, title_ar, title_en, bio_ar, bio_en, avatar_url, is_active)
  on public.providers to authenticated;
grant update (name_ar, name_en, title_ar, title_en, bio_ar, bio_en, avatar_url, is_active)
  on public.providers to authenticated;

revoke insert, update, delete on public.services from authenticated;
grant insert (tenant_id, name_ar, name_en, description_ar, description_en, duration_min, buffer_min, price, is_active)
  on public.services to authenticated;
grant update (name_ar, name_en, description_ar, description_en, duration_min, buffer_min, price, is_active)
  on public.services to authenticated;

revoke update on public.provider_services from authenticated;
revoke update on public.working_hours from authenticated;
revoke update on public.time_off from authenticated;

-- the dashboard gates catalogue edits on owner (canManageCatalog); make the database say the same,
-- and drop the "provider edits own hours" path the UI never offered.
do $$
declare t text;
begin
  foreach t in array array['providers','services','provider_services','working_hours','time_off'] loop
    execute format('drop policy if exists %I on public.%I', t || '_write_staff', t);
    execute format($f$create policy %1$I on public.%2$I for all to authenticated
      using (public.auth_tenant_role(tenant_id) = 'owner')
      with check (public.auth_tenant_role(tenant_id) = 'owner')$f$, t || '_write_owner', t);
  end loop;
  drop policy if exists working_hours_write_own_provider on public.working_hours;
  drop policy if exists time_off_write_own_provider on public.time_off;
end $$;

-- ---------- appointments: staff change them through staff_update_appointment / status updates ----------
revoke insert on public.appointments from authenticated;  -- delete stays: owner/receptionist RLS, covered by existing isolation tests

-- ---------- knowledge base: owner inserts/deletes documents and chunks, re-embeds chunks ----------
revoke update on public.kb_documents from authenticated;
revoke update on public.kb_chunks from authenticated;
grant update (embedding) on public.kb_chunks to authenticated;

-- ---------- read-only for staff (the agent / cron write with the service role) ----------
revoke insert, update, delete on public.conversations, public.messages, public.reminders from authenticated;

-- ---------- internal ----------
revoke all on public.rate_limits from authenticated;
revoke all on public.payment_events from authenticated;
