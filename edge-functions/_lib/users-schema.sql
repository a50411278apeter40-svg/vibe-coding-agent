-- One-time setup: run this in your Supabase project's SQL editor
-- (https://supabase.com/dashboard/project/_/sql) before using signup/login.
-- Free tier is plenty for this project's auth needs (50k MAU, unlimited API requests).

create table if not exists public.users (
  id text primary key,
  email text unique not null,
  username text unique not null,
  name text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

alter table public.users enable row level security;
-- No policies added on purpose: only the service_role key (used by the
-- edge functions, never exposed to the browser) can read/write this table;
-- anon/authenticated clients are fully locked out by RLS with zero policies.
