create table public.profiles (id uuid primary key, email text, display_name text, created_at timestamptz not null default now());
create table public.organizations (id uuid primary key default gen_random_uuid(), name text not null check (char_length(name) between 1 and 120), kind text not null default 'clinic' check (kind in ('clinic','personal')), created_at timestamptz not null default now());
create table public.memberships (id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade, user_id uuid not null, role text not null default 'doctor' check (role in ('admin','doctor','staff')), created_at timestamptz not null default now(), unique (org_id, user_id));
create table public.drop_links (id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade, recipient_user_id uuid, label text not null default 'Link do wysyłania', token_hash text not null unique, revoked_at timestamptz, expires_at timestamptz, max_uses int, uses int not null default 0, created_by uuid not null, created_at timestamptz not null default now());
create table public.items (id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade, recipient_user_id uuid, drop_link_id uuid references public.drop_links(id) on delete set null, direction text not null default 'in' check (direction in ('in','to_clinic')), file_name text not null, storage_path text not null, size_bytes bigint not null default 0, mime_type text not null default 'application/octet-stream', sender_name text, note text, scan_status text not null default 'unscanned', important boolean not null default false, read_at timestamptz, archived_at timestamptz, created_at timestamptz not null default now(), expires_at timestamptz not null default (now() + interval '30 days'));
create index on public.items (recipient_user_id, created_at desc);
create index on public.items (expires_at);
create table public.audit_log (id uuid primary key default gen_random_uuid(), org_id uuid references public.organizations(id) on delete cascade, actor_user_id uuid, actor_label text, action text not null, target text, created_at timestamptz not null default now());
create table public.notifications_outbox (id uuid primary key default gen_random_uuid(), user_id uuid not null, channel text not null, body text not null, status text not null default 'dummy_sent', created_at timestamptz not null default now());

grant select, update on public.profiles to authenticated;
grant select, update on public.organizations to authenticated;
grant select, delete on public.memberships to authenticated;
grant select, insert, update on public.drop_links to authenticated;
grant select, update, delete on public.items to authenticated;
grant select on public.audit_log to authenticated;
grant select on public.notifications_outbox to authenticated;
grant all on public.profiles, public.organizations, public.memberships, public.drop_links, public.items, public.audit_log, public.notifications_outbox to service_role;

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.drop_links enable row level security;
alter table public.items enable row level security;
alter table public.audit_log enable row level security;
alter table public.notifications_outbox enable row level security;

create or replace function public.is_member(_org uuid, _uid uuid) returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.memberships where org_id=_org and user_id=_uid) $$;
create or replace function public.has_org_role(_org uuid, _uid uuid, _role text) returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.memberships where org_id=_org and user_id=_uid and role=_role) $$;
create or replace function public.shares_org(_a uuid, _b uuid) returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.memberships m1 join public.memberships m2 on m1.org_id=m2.org_id where m1.user_id=_a and m2.user_id=_b) $$;

create policy "profiles read" on public.profiles for select to authenticated using (id = auth.uid() or public.shares_org(auth.uid(), id));
create policy "profiles update own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "orgs read" on public.organizations for select to authenticated using (public.is_member(id, auth.uid()));
create policy "orgs admin update" on public.organizations for update to authenticated using (public.has_org_role(id, auth.uid(), 'admin'));
create policy "members read" on public.memberships for select to authenticated using (public.is_member(org_id, auth.uid()));
create policy "members admin delete" on public.memberships for delete to authenticated using (public.has_org_role(org_id, auth.uid(), 'admin') and user_id <> auth.uid());
create policy "links read" on public.drop_links for select to authenticated using (public.has_org_role(org_id, auth.uid(), 'admin') or recipient_user_id = auth.uid());
create policy "links insert" on public.drop_links for insert to authenticated with check (created_by = auth.uid() and public.is_member(org_id, auth.uid()) and (public.has_org_role(org_id, auth.uid(), 'admin') or recipient_user_id = auth.uid()));
create policy "links update" on public.drop_links for update to authenticated using (public.has_org_role(org_id, auth.uid(), 'admin') or recipient_user_id = auth.uid());
create policy "items read" on public.items for select to authenticated using (expires_at > now() and public.is_member(org_id, auth.uid()) and (recipient_user_id = auth.uid() or (recipient_user_id is null and (public.has_org_role(org_id, auth.uid(), 'admin') or public.has_org_role(org_id, auth.uid(), 'staff')))));
create policy "items update" on public.items for update to authenticated using (public.is_member(org_id, auth.uid()) and (recipient_user_id = auth.uid() or (recipient_user_id is null and (public.has_org_role(org_id, auth.uid(), 'admin') or public.has_org_role(org_id, auth.uid(), 'staff')))));
create policy "items delete" on public.items for delete to authenticated using (public.is_member(org_id, auth.uid()) and (recipient_user_id = auth.uid() or (recipient_user_id is null and public.has_org_role(org_id, auth.uid(), 'admin'))));
create policy "audit read" on public.audit_log for select to authenticated using (actor_user_id = auth.uid() or public.has_org_role(org_id, auth.uid(), 'admin'));
create policy "outbox read own" on public.notifications_outbox for select to authenticated using (user_id = auth.uid());

create or replace function public.create_organization(_name text, _kind text default 'clinic') returns uuid language plpgsql security definer set search_path = public as $$
declare _id uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.organizations(name, kind) values (_name, coalesce(_kind,'clinic')) returning id into _id;
  insert into public.memberships(org_id, user_id, role) values (_id, auth.uid(), 'admin');
  insert into public.audit_log(org_id, actor_user_id, action, target) values (_id, auth.uid(), 'org.create', _name);
  return _id;
end $$;
revoke execute on function public.create_organization(text, text) from public, anon;
grant execute on function public.create_organization(text, text) to authenticated;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare _org uuid; _name text;
begin
  _name := coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1));
  insert into public.profiles(id, email, display_name) values (new.id, new.email, _name);
  insert into public.organizations(name, kind) values ('Własny gabinet', 'personal') returning id into _org;
  insert into public.memberships(org_id, user_id, role) values (_org, new.id, 'admin');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

alter publication supabase_realtime add table public.items;
revoke execute on function public.is_member(uuid, uuid) from public, anon;
revoke execute on function public.has_org_role(uuid, uuid, text) from public, anon;
revoke execute on function public.shares_org(uuid, uuid) from public, anon;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.is_member(uuid, uuid) to authenticated;
grant execute on function public.has_org_role(uuid, uuid, text) to authenticated;
grant execute on function public.shares_org(uuid, uuid) to authenticated;
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (char_length(email) between 3 and 255),
  role text not null default 'doctor' check (role in ('admin','doctor','staff')),
  invited_by uuid not null,
  accepted_at timestamptz,
  declined_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index invitations_pending_uniq on public.invitations (org_id, lower(email)) where accepted_at is null and declined_at is null;
grant select, delete on public.invitations to authenticated;
grant all on public.invitations to service_role;
alter table public.invitations enable row level security;
create policy "inv read" on public.invitations for select to authenticated using (public.has_org_role(org_id, auth.uid(), 'admin') or lower(email) = lower(auth.jwt()->>'email'));
create policy "inv admin delete" on public.invitations for delete to authenticated using (public.has_org_role(org_id, auth.uid(), 'admin'));

create or replace function public.respond_invitation(_id uuid, _accept boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare inv public.invitations;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into inv from public.invitations where id = _id and accepted_at is null and declined_at is null;
  if inv.id is null or lower(inv.email) <> lower(auth.jwt()->>'email') then raise exception 'invitation not found'; end if;
  if _accept then
    insert into public.memberships(org_id, user_id, role) values (inv.org_id, auth.uid(), inv.role)
      on conflict (org_id, user_id) do nothing;
    update public.invitations set accepted_at = now() where id = _id;
    insert into public.audit_log(org_id, actor_user_id, action, target) values (inv.org_id, auth.uid(), 'invite.accept', inv.email);
  else
    update public.invitations set declined_at = now() where id = _id;
    insert into public.audit_log(org_id, actor_user_id, action, target) values (inv.org_id, auth.uid(), 'invite.decline', inv.email);
  end if;
  return inv.org_id;
end $$;

create or replace function public.set_member_role(_membership uuid, _role text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.memberships; admins int;
begin
  if _role not in ('admin','doctor','staff') then raise exception 'bad role'; end if;
  select * into m from public.memberships where id = _membership;
  if m.id is null or not public.has_org_role(m.org_id, auth.uid(), 'admin') then raise exception 'forbidden'; end if;
  if m.role = 'admin' and _role <> 'admin' then
    select count(*) into admins from public.memberships where org_id = m.org_id and role = 'admin';
    if admins <= 1 then raise exception 'last admin'; end if;
  end if;
  update public.memberships set role = _role where id = _membership;
  insert into public.audit_log(org_id, actor_user_id, action, target) values (m.org_id, auth.uid(), 'member.role', _role);
end $$;

create or replace function public.leave_organization(_org uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.memberships; admins int; k text;
begin
  select kind into k from public.organizations where id = _org;
  if k = 'personal' then raise exception 'personal'; end if;
  select * into m from public.memberships where org_id = _org and user_id = auth.uid();
  if m.id is null then raise exception 'not member'; end if;
  if m.role = 'admin' then
    select count(*) into admins from public.memberships where org_id = _org and role = 'admin';
    if admins <= 1 and (select count(*) from public.memberships where org_id = _org) > 1 then raise exception 'last admin'; end if;
  end if;
  delete from public.memberships where id = m.id;
  update public.drop_links set revoked_at = now() where org_id = _org and recipient_user_id = auth.uid() and revoked_at is null;
  insert into public.audit_log(org_id, actor_user_id, action, target) values (_org, auth.uid(), 'member.leave', null);
end $$;

revoke execute on function public.respond_invitation(uuid, boolean) from public, anon;
revoke execute on function public.set_member_role(uuid, text) from public, anon;
revoke execute on function public.leave_organization(uuid) from public, anon;
grant execute on function public.respond_invitation(uuid, boolean) to authenticated;
grant execute on function public.set_member_role(uuid, text) to authenticated;
grant execute on function public.leave_organization(uuid) to authenticated;

DROP POLICY IF EXISTS "links insert" ON public.drop_links;
CREATE POLICY "links insert" ON public.drop_links FOR INSERT TO authenticated
WITH CHECK (
  created_by = auth.uid()
  AND public.is_member(org_id, auth.uid())
  AND (
    public.has_org_role(org_id, auth.uid(), 'admin')
    OR (recipient_user_id = auth.uid() AND public.has_org_role(org_id, auth.uid(), 'doctor'))
  )
);