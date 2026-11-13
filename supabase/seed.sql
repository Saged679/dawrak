-- Local seed (runs after migrations on `supabase db reset`).
--
-- 1. Demo auth users. Supabase auth users must have a row in auth.users AND auth.identities
--    (email provider) with a bcrypt password, otherwise password sign-in fails. Fixed ids are
--    referenced by seed_demo() (migration 08).
--    Password for all demo users: Demo#2026   (demo data only, never reuse)
--      clinic-owner@example.com      owner          (عيادة نبض)
--      clinic-reception@example.com  receptionist
--      clinic-doctor@example.com     provider       (د. سلمى الحارثي)
--      salon-owner@example.com       owner          (صالون لمسة)
--      salon-reception@example.com   receptionist
--      salon-stylist@example.com     provider       (ليان المطيري)
--    On the HOSTED project do not run this file: create the same users with the Admin API
--    (auth.admin.createUser({ id, email, password, email_confirm: true })) using the same ids,
--    then call `select public.reset_demo();` (service role) to attach memberships.
-- 2. The "demo customer" role needs no login: customers use their access_token via customer_* functions.
-- 3. Tenants, services, providers, hours, ~2 weeks of appointments, KB and conversations come from
--    public.seed_demo().

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change)
select
  '00000000-0000-0000-0000-000000000000', v.id::uuid, 'authenticated', 'authenticated', v.email,
  extensions.crypt('Demo#2026', extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('full_name', v.full_name),
  now(), now(), '', '', '', ''
from (values
  ('a0000000-0000-4000-8000-000000000001', 'clinic-owner@example.com',     'مالك عيادة نبض'),
  ('a0000000-0000-4000-8000-000000000002', 'clinic-reception@example.com', 'استقبال عيادة نبض'),
  ('a0000000-0000-4000-8000-000000000003', 'clinic-doctor@example.com',    'د. سلمى الحارثي'),
  ('a0000000-0000-4000-8000-000000000004', 'salon-owner@example.com',      'مالكة صالون لمسة'),
  ('a0000000-0000-4000-8000-000000000005', 'salon-reception@example.com',  'استقبال صالون لمسة'),
  ('a0000000-0000-4000-8000-000000000006', 'salon-stylist@example.com',    'ليان المطيري')
) v(id, email, full_name)
on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text, 'email',
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       now(), now(), now()
from auth.users u
where u.id::text like 'a0000000-0000-4000-8000-00000000000%'
  and not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email');

-- LOCAL / e2e ONLY: let the six fixed demo logins above keep their known password across reset_demo().
-- Without this demo_config row (the hosted project never runs this file) reset_demo() replaces their
-- passwords with random ones, so the shared accounts cannot be used for interactive login.
insert into public.demo_config (key, value) values ('allow_fixed_demo_login', 'on')
on conflict (key) do update set value = excluded.value;

select public.seed_demo();
