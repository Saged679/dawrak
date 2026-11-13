-- Extensions live in the `extensions` schema (Supabase convention).
create extension if not exists btree_gist with schema extensions;  -- uuid = in the exclusion constraint
create extension if not exists pgcrypto   with schema extensions;  -- gen_random_bytes / crypt
create extension if not exists vector     with schema extensions;  -- pgvector
