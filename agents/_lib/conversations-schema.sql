-- One-time setup: run this in your Supabase project's SQL editor
-- (https://supabase.com/dashboard/project/_/sql), same project as
-- users-schema.sql / projects-schema.sql.
--
-- This replaces the EdgeOne "agents" framework's built-in context.store
-- (conversation + message memory) so chat history and per-conversation
-- project-state metadata keep working identically when this app runs as
-- plain Next.js Route Handlers anywhere (Render, Vercel, a bare Node
-- server...) instead of only on EdgeOne Makers, which was the only place
-- that ever provided context.store natively. See agents/_contextStore.ts.

create table if not exists public.conversations (
  conversation_id text primary key,
  user_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id bigserial primary key,
  conversation_id text not null references public.conversations(conversation_id) on delete cascade,
  role text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_id_created_at_idx
  on public.messages(conversation_id, created_at);

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
-- No policies added on purpose: only the service_role key (used server-side,
-- never exposed to the browser) can read/write these tables; anon/authenticated
-- clients are fully locked out by RLS with zero policies, same pattern as
-- users-schema.sql / projects-schema.sql.
