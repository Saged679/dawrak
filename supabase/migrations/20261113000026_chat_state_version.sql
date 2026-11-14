-- Compare-and-set for chat_agent_state: every write says which version it read (update ... where version = v),
-- so a stale in-memory copy of one request can never overwrite what an overlapping request wrote. A failed
-- compare-and-set makes the writer fail closed (the pending confirmation is treated as absent).
-- The table stays service_role only (migration 24 grants); this only adds the column.
alter table public.chat_agent_state add column if not exists version int not null default 0;
