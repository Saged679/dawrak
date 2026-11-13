create table if not exists public.appointments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  provider_id uuid not null,
  service_id  uuid not null,
  customer_id uuid not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  status      text not null default 'confirmed'
              check (status in ('pending_payment','confirmed','cancelled','completed','no_show')),
  source      text not null default 'staff' check (source in ('web','chat','staff')),
  price       numeric(10,2) not null default 0,
  notes       text,
  payment_expires_at timestamptz,
  created_at  timestamptz not null default now(),
  check (ends_at > starts_at),
  foreign key (provider_id, tenant_id) references public.providers(id, tenant_id) on delete cascade,
  foreign key (service_id,  tenant_id) references public.services(id,  tenant_id) on delete cascade,
  foreign key (customer_id, tenant_id) references public.customers(id, tenant_id) on delete cascade,
  unique (id, tenant_id),
  -- No double booking: same provider, overlapping time, only for statuses that hold the slot.
  constraint appointments_no_overlap exclude using gist (
    provider_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('pending_payment','confirmed','completed'))
);
create index if not exists appointments_tenant_start_idx on public.appointments(tenant_id, starts_at);
create index if not exists appointments_customer_idx on public.appointments(customer_id);
create index if not exists appointments_pending_idx on public.appointments(payment_expires_at) where status = 'pending_payment';

create table if not exists public.payments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  appointment_id uuid not null,
  amount         numeric(10,2) not null check (amount >= 0),
  currency       text not null default 'SAR',
  status         text not null default 'pending' check (status in ('pending','paid','failed','refunded')),
  provider       text not null default 'moyasar',
  provider_ref   text,
  raw            jsonb,
  created_at     timestamptz not null default now(),
  foreign key (appointment_id, tenant_id) references public.appointments(id, tenant_id) on delete cascade
);
create index if not exists payments_tenant_idx on public.payments(tenant_id, created_at);
create unique index if not exists payments_provider_ref_uq on public.payments(provider, provider_ref) where provider_ref is not null;

create table if not exists public.reminders (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  appointment_id uuid not null,
  kind           text not null check (kind in ('24h','2h')),
  send_at        timestamptz not null,
  sent_at        timestamptz,
  status         text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  created_at     timestamptz not null default now(),
  foreign key (appointment_id, tenant_id) references public.appointments(id, tenant_id) on delete cascade,
  unique (appointment_id, kind)
);
create index if not exists reminders_due_idx on public.reminders(send_at) where status = 'pending';
