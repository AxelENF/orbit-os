-- SnapGad Content OS: private, owner-scoped storage and publication traceability.
create extension if not exists pgcrypto;

create type public.profile_role as enum ('owner', 'reviewer');
create type public.content_state as enum (
  'UPLOADED', 'GENERATING', 'DRAFT', 'REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'REJECTED', 'ERROR'
);
create type public.publication_platform as enum ('FACEBOOK', 'INSTAGRAM');
create type public.publication_status as enum ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SCHEDULED', 'PUBLISHED', 'ERROR');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.profile_role not null default 'owner',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  bucket_id text not null default 'content-assets' check (bucket_id = 'content-assets'),
  storage_path text not null unique,
  filename text not null,
  mime_type text not null,
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  checksum text not null,
  created_at timestamptz not null default now()
);

create table public.content_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  asset_id uuid references public.assets(id) on delete set null,
  business_line text not null,
  service text not null,
  niche text not null,
  content_type text not null,
  objective text not null,
  format text not null check (format = 'feed_4_5'),
  cta text not null check (length(trim(cta)) > 0),
  human_description text not null check (length(trim(human_description)) > 0),
  allowed_facts jsonb not null check (jsonb_typeof(allowed_facts) = 'array' and jsonb_array_length(allowed_facts) > 0),
  state public.content_state not null default 'UPLOADED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.copy_drafts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  visual_analysis jsonb not null default '{}'::jsonb,
  headline text,
  body text not null,
  cta text not null,
  provider text,
  model text,
  revision integer not null default 1 check (revision > 0),
  selected_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.publication_targets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  platform public.publication_platform not null,
  status public.publication_status not null default 'PENDING_REVIEW',
  scheduled_for timestamptz,
  remote_post_id text,
  remote_url text,
  published_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (content_item_id, platform)
);

create table public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  content_item_id uuid references public.content_items(id) on delete cascade,
  publication_target_id uuid references public.publication_targets(id) on delete cascade,
  kind text not null check (kind in ('COPY_REQUEST', 'COPY_CALLBACK', 'PUBLISH_REQUEST', 'PUBLISH_CALLBACK')),
  idempotency_key uuid not null,
  status text not null,
  request_payload jsonb,
  response_payload jsonb,
  sanitized_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (idempotency_key)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  content_item_id uuid references public.content_items(id) on delete cascade,
  publication_target_id uuid references public.publication_targets(id) on delete cascade,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.assets enable row level security;
alter table public.content_items enable row level security;
alter table public.copy_drafts enable row level security;
alter table public.publication_targets enable row level security;
alter table public.automation_runs enable row level security;
alter table public.audit_events enable row level security;

create policy "Owners manage their profile" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);
create policy "Owners manage their assets" on public.assets
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "Owners manage their content" on public.content_items
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "Owners manage their copy drafts" on public.copy_drafts
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "Owners manage their publication targets" on public.publication_targets
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "Owners manage their automation runs" on public.automation_runs
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "Owners manage their audit events" on public.audit_events
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

insert into storage.buckets (id, name, public)
values ('content-assets', 'content-assets', false)
on conflict (id) do update set public = false;

create policy "Owners access their content assets" on storage.objects
  for all using (bucket_id = 'content-assets' and owner_id = auth.uid())
  with check (bucket_id = 'content-assets' and owner_id = auth.uid());
