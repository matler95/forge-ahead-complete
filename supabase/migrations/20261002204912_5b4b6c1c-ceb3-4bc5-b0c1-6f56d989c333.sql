create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index on public.push_subscriptions (user_id);
grant select, delete on public.push_subscriptions to authenticated;
grant all on public.push_subscriptions to service_role;
alter table public.push_subscriptions enable row level security;
create policy "push read own" on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy "push delete own" on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());