-- ============================================================
-- AZ Alpha Vision — Supabase schema, RLS, and account functions
-- Run this once in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------
-- 1) PROFILES — one row per auth.users row, created automatically
-- ----------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null default '',
  email       text not null,
  role        text not null default 'user' check (role in ('user','admin')),
  approved    boolean not null default false,
  trial_end   timestamptz,               -- null until an admin approves/extends
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- avoids the classic "RLS policy queries its own table" recursion error
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- everyone can read their own row; admins can read every row
create policy "profiles_select_own_or_admin"
  on public.profiles for select
  using (auth.uid() = id or public.is_admin());

-- NOTE: intentionally no direct UPDATE policy on profiles.
-- Every state change (approve, extend trial) goes through the
-- SECURITY DEFINER functions below, so a client can never patch
-- approved/role/trial_end directly, even with a stolen session.

-- auto-create a profile row on signup; first-ever user becomes admin
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_first boolean;
begin
  select not exists (select 1 from public.profiles) into is_first;
  insert into public.profiles (id, name, email, role, approved, trial_end)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', ''),
    new.email,
    case when is_first then 'admin' else 'user' end,
    is_first,
    null  -- trial only starts once an admin approves (see approve_new_user)
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- admin action: approve a newly registered (pending) user → starts a 60-day trial
create or replace function public.approve_new_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.profiles
    set approved = true, trial_end = now() + interval '60 days'
    where id = target_user_id;
end;
$$;

-- ----------------------------------------------------------------
-- 2) WATCHLIST — replaces the old localStorage watchlist, now syncs
--    across every device the user logs into
-- ----------------------------------------------------------------
create table if not exists public.watchlist (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  symbol      text not null,
  entry_price numeric not null,
  qty         numeric not null default 1,
  added_at    timestamptz not null default now()
);

alter table public.watchlist enable row level security;

create policy "watchlist_owner_all"
  on public.watchlist for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ----------------------------------------------------------------
-- 3) UPGRADE REQUESTS — bank-transfer receipts, reviewed by an admin
-- ----------------------------------------------------------------
create table if not exists public.upgrade_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  receipt_path  text not null,
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz,
  reviewed_by   uuid references public.profiles(id)
);

alter table public.upgrade_requests enable row level security;

create policy "upgrade_requests_select_own_or_admin"
  on public.upgrade_requests for select
  using (auth.uid() = user_id or public.is_admin());

create policy "upgrade_requests_insert_own"
  on public.upgrade_requests for insert
  with check (auth.uid() = user_id);

-- NOTE: no UPDATE policy here either — status changes only via
-- review_upgrade_request(), so a request can never end up "approved"
-- without the matching trial_end extension happening in the same step.

create or replace function public.review_upgrade_request(
  request_id  uuid,
  new_status  text,
  extend_days int default 60
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if new_status not in ('approved','rejected') then
    raise exception 'invalid status';
  end if;

  select user_id into target_user from public.upgrade_requests where id = request_id;
  if target_user is null then
    raise exception 'request not found';
  end if;

  update public.upgrade_requests
    set status = new_status, reviewed_at = now(), reviewed_by = auth.uid()
    where id = request_id;

  if new_status = 'approved' then
    update public.profiles
      set approved = true,
          trial_end = greatest(coalesce(trial_end, now()), now()) + (extend_days || ' days')::interval
      where id = target_user;
  end if;
end;
$$;

-- ----------------------------------------------------------------
-- 4) STORAGE — private bucket for receipt uploads
-- ----------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

-- users may only upload under a folder named after their own uid
create policy "receipts_insert_own_folder"
  on storage.objects for insert
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- owners can see their own receipts; admins can see everyone's
create policy "receipts_select_own_or_admin"
  on storage.objects for select
  using (
    bucket_id = 'receipts'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- ----------------------------------------------------------------
-- 5) Data API grants (safe to run regardless of your project's
--    default privilege settings — RLS above is what actually
--    restricts access; these grants just make the tables reachable)
-- ----------------------------------------------------------------
grant usage on schema public to authenticated, anon;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.watchlist to authenticated;
grant select, insert on public.upgrade_requests to authenticated;
grant execute on function public.approve_new_user(uuid) to authenticated;
grant execute on function public.review_upgrade_request(uuid, text, int) to authenticated;
grant execute on function public.is_admin() to authenticated;

-- ============================================================
-- Done. Two manual checks in the dashboard after running this:
-- 1) Authentication → Providers → Email — confirm whether "Confirm
--    email" is on or off; it changes whether signUp() logs a user
--    in immediately or waits for a confirmation click (app.js
--    handles both cases, this only affects what the user sees).
-- 2) Storage → receipts bucket exists and is private (not public).
-- ============================================================
