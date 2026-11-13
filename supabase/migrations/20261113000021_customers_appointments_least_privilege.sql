-- M2: signed-in staff can no longer delete appointments/customers or write customers directly.
-- Verified against src/: the dashboard only SELECTs customers; appointments are changed through
-- update(status/notes) (kept) and staff_update_appointment() (SECURITY DEFINER); customer rows are written by
-- create_public_booking (definer). No legitimate authenticated write on customers or delete on appointments
-- exists, so no column grant is kept. (customers SELECT column grant from migration 10 is unchanged.)
revoke delete on public.appointments from authenticated;
revoke delete, insert, update on public.customers from authenticated;
