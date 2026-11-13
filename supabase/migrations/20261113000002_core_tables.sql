-- Core tenant tables. Every table carries tenant_id; (id, tenant_id) unique keys
-- let child tables use composite FKs so a row can never point at another tenant's parent.

create table if not exists public.tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name_ar         text not null,
  name_en         text not null,
  kind            text not null check (kind in ('clinic','salon')),
  timezone        text not null default 'Asia/Riyadh',
  currency        text not null default 'SAR',
  deposit_enabled boolean not null default false,
  deposit_type    text not null default 'fixed' check (deposit_type in ('fixed','percent')),
  deposit_value   numeric(10,2) not null default 0 check (deposit_value >= 0),
  logo_url        text,
  brand_color     text,
  is_demo         boolean not null default false,
  created_at      timestamptz not null default now()
);

create table if not exists public.memberships (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  role       text not null check (role in ('owner','receptionist','provider')),
  created_at timestamptz not null default now(),
  unique (user_id, tenant_id)
);
create index if not exists memberships_tenant_idx on public.memberships(tenant_id);

create table if not exists public.providers (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete set null, -- login of a provider-role member
  name_ar    text not null,
  name_en    text not null,
  title_ar   text,
  title_en   text,
  bio_ar     text,
  bio_en     text,
  avatar_url text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, tenant_id)
);
create unique index if not exists providers_tenant_user_uq on public.providers(tenant_id, user_id) where user_id is not null;

create table if not exists public.services (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name_ar     text not null,
  name_en     text not null,
  description_ar text,
  description_en text,
  duration_min   int not null check (duration_min > 0),
  buffer_min     int not null default 0 check (buffer_min >= 0),
  price          numeric(10,2) not null check (price >= 0),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (id, tenant_id)
);

create table if not exists public.provider_services (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  provider_id uuid not null,
  service_id  uuid not null,
  primary key (provider_id, service_id),
  foreign key (provider_id, tenant_id) references public.providers(id, tenant_id) on delete cascade,
  foreign key (service_id,  tenant_id) references public.services(id,  tenant_id) on delete cascade
);

-- weekday follows extract(dow): 0 = Sunday ... 6 = Saturday. Several rows per day = split shifts.
create table if not exists public.working_hours (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  provider_id uuid not null,
  weekday     smallint not null check (weekday between 0 and 6),
  start_time  time not null,
  end_time    time not null,
  check (end_time > start_time),
  foreign key (provider_id, tenant_id) references public.providers(id, tenant_id) on delete cascade
);
create index if not exists working_hours_provider_idx on public.working_hours(provider_id, weekday);

create table if not exists public.time_off (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  provider_id uuid not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  reason      text,
  check (ends_at > starts_at),
  foreign key (provider_id, tenant_id) references public.providers(id, tenant_id) on delete cascade
);
create index if not exists time_off_provider_idx on public.time_off(provider_id, starts_at);

create table if not exists public.customers (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  full_name    text not null,
  phone        text not null,
  email        text,
  locale       text not null default 'ar' check (locale in ('ar','en')),
  -- magic-link secret for the customer_* self-service functions
  access_token text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  created_at   timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, phone)
);
