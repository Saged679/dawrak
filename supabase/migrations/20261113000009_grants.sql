-- Least privilege. anon never touches tables; it only calls the narrow functions below.

revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;

-- Functions are PUBLIC-executable by default in Postgres: lock everything first, then grant explicitly.
revoke all on function
  public._slot_is_free(uuid, uuid, timestamptz, int, int, uuid),
  public.get_available_slots(uuid, uuid, uuid, date, date, int),
  public.public_get_tenant(text),
  public.public_list_services(uuid),
  public.public_list_providers(uuid, uuid),
  public.create_public_booking(uuid, uuid, uuid, timestamptz, text, text, text, text, text),
  public.customer_get_appointments(text),
  public.customer_cancel_appointment(text, uuid),
  public.customer_reschedule_appointment(text, uuid, timestamptz),
  public.match_kb_chunks(uuid, extensions.vector, int),
  public.check_rate_limit(text, int, interval),
  public.expire_pending_bookings(),
  public.seed_demo(),
  public.reset_demo()
from public, anon, authenticated;

-- public booking surface (anon + signed-in users)
grant execute on function
  public.get_available_slots(uuid, uuid, uuid, date, date, int),
  public.public_get_tenant(text),
  public.public_list_services(uuid),
  public.public_list_providers(uuid, uuid),
  public.create_public_booking(uuid, uuid, uuid, timestamptz, text, text, text, text, text),
  public.customer_get_appointments(text),
  public.customer_cancel_appointment(text, uuid),
  public.customer_reschedule_appointment(text, uuid, timestamptz)
to anon, authenticated, service_role;

-- staff dashboards may search the KB (RLS limits them to their tenant); not anon
grant execute on function public.match_kb_chunks(uuid, extensions.vector, int) to authenticated, service_role;

-- backend-only (service role): internals, rate limiting, cron jobs, demo reset
grant execute on function
  public._slot_is_free(uuid, uuid, timestamptz, int, int, uuid),
  public.check_rate_limit(text, int, interval),
  public.expire_pending_bookings(),
  public.seed_demo(),
  public.reset_demo()
to service_role;
