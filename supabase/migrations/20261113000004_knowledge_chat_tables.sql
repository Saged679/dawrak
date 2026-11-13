create table if not exists public.kb_documents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  title        text not null,
  source_type  text not null default 'faq' check (source_type in ('pdf','faq','text')),
  storage_path text,
  content      text,
  created_at   timestamptz not null default now(),
  unique (id, tenant_id)
);

-- Embedding dimension 768: Gemini embeddings (gemini-embedding-001) support
-- outputDimensionality=768 (Matryoshka truncation); text-embedding-004 is natively 768.
-- 768 keeps HNSW indexable (pgvector caps `vector` indexes at 2000 dims, so the 3072 default
-- would not fit) and is 4x smaller than 3072, which matters on the 500 MB free tier.
-- The app MUST request outputDimensionality=768 (and L2-normalise) when embedding.
create table if not exists public.kb_chunks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  document_id uuid not null,
  chunk_index int not null default 0,
  content     text not null,
  embedding   extensions.vector(768),
  created_at  timestamptz not null default now(),
  foreign key (document_id, tenant_id) references public.kb_documents(id, tenant_id) on delete cascade
);
create index if not exists kb_chunks_tenant_idx on public.kb_chunks(tenant_id, document_id);
create index if not exists kb_chunks_embedding_idx on public.kb_chunks using hnsw (embedding extensions.vector_cosine_ops);

create table if not exists public.conversations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  customer_id     uuid,
  channel         text not null default 'web' check (channel in ('web','whatsapp')),
  external_id     text,                       -- browser session id / WhatsApp number
  started_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  foreign key (customer_id, tenant_id) references public.customers(id, tenant_id) on delete cascade,
  unique (id, tenant_id)
);
create index if not exists conversations_tenant_idx on public.conversations(tenant_id, last_message_at desc);

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null,
  role            text not null check (role in ('user','assistant','tool','system')),
  content         text not null default '',
  parts           jsonb,
  created_at      timestamptz not null default now(),
  foreign key (conversation_id, tenant_id) references public.conversations(id, tenant_id) on delete cascade
);
create index if not exists messages_conv_idx on public.messages(conversation_id, created_at);
create index if not exists messages_tenant_day_idx on public.messages(tenant_id, created_at);

-- Truly global: keys are opaque strings (e.g. 'ip:1.2.3.4:chat'), so no tenant_id.
create table if not exists public.rate_limits (
  key          text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (key, window_start)
);
