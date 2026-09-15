-- ============================================================
-- AZ Alpha Vision — Support tickets + replies (user-scoped RLS)
-- Run once in: Supabase Dashboard → SQL Editor
-- ============================================================

create table if not exists public.support_tickets (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  subject      text not null,
  message      text not null,
  priority     text not null default 'normal'
                 check (priority in ('normal','high','urgent')),
  status       text not null default 'open'
                 check (status in ('open','in_progress','resolved','closed')),
  admin_reply  text,
  replied_at   timestamptz,
  replied_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists support_tickets_user_idx
  on public.support_tickets (user_id, created_at desc);
create index if not exists support_tickets_status_idx
  on public.support_tickets (status, created_at desc);

alter table public.support_tickets enable row level security;

drop policy if exists "support_tickets_select_own_or_admin" on public.support_tickets;
create policy "support_tickets_select_own_or_admin"
  on public.support_tickets for select
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists "support_tickets_insert_own" on public.support_tickets;
create policy "support_tickets_insert_own"
  on public.support_tickets for insert
  with check (auth.uid() = user_id);

drop policy if exists "support_tickets_update_admin" on public.support_tickets;
create policy "support_tickets_update_admin"
  on public.support_tickets for update
  using (public.is_admin());

-- History / thread replies
create table if not exists public.support_ticket_replies (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null references public.support_tickets(id) on delete cascade,
  author_id   uuid not null references public.profiles(id) on delete cascade,
  is_admin    boolean not null default false,
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists support_ticket_replies_ticket_idx
  on public.support_ticket_replies (ticket_id, created_at);

alter table public.support_ticket_replies enable row level security;

drop policy if exists "support_replies_select_own_or_admin" on public.support_ticket_replies;
create policy "support_replies_select_own_or_admin"
  on public.support_ticket_replies for select
  using (
    public.is_admin()
    or exists (
      select 1 from public.support_tickets t
      where t.id = ticket_id and t.user_id = auth.uid()
    )
  );

drop policy if exists "support_replies_insert_participant" on public.support_ticket_replies;
create policy "support_replies_insert_participant"
  on public.support_ticket_replies for insert
  with check (
    auth.uid() = author_id
    and (
      public.is_admin()
      or exists (
        select 1 from public.support_tickets t
        where t.id = ticket_id and t.user_id = auth.uid()
      )
    )
  );

grant select, insert on public.support_tickets to authenticated;
grant update on public.support_tickets to authenticated;
grant select, insert on public.support_ticket_replies to authenticated;
