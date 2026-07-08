-- Run this once in your Supabase project's SQL editor (same place as
-- users-schema.sql). Stores one row per project: which user owns it, which
-- chat conversation it's tied to, a display title, and a full snapshot of
-- its text files so a signed-in user can resume it later even if the coding
-- sandbox itself gets recycled.
create table if not exists public.projects (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  conversation_id text not null unique,
  title text not null default '새 프로젝트',
  files jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_user_id_idx on public.projects(user_id);
create index if not exists projects_updated_at_idx on public.projects(updated_at desc);
