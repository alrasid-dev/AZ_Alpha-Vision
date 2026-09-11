-- ============================================================
-- AZ Alpha Vision — محفظة المستخدم + سياسات المحاكي 50k
-- شغّل مرة واحدة في: Supabase Dashboard → SQL Editor
-- بعد: supabase_schema.sql و virtual_trader_schema.sql و notifications_and_data_schema.sql
-- تعليمي فقط — لا تنفيذ حقيقي.
-- ============================================================

-- 1) محفظة المستخدم الشخصية (منفصلة عن قائمة المراقبة والمحاكي المشترك)
create table if not exists public.user_portfolio_positions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  symbol      text not null,
  buy_price   numeric not null check (buy_price > 0),
  qty         numeric not null check (qty > 0),
  notes       text,
  added_at    timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, symbol)
);

create index if not exists user_portfolio_positions_user_idx
  on public.user_portfolio_positions (user_id);
create index if not exists user_portfolio_positions_symbol_idx
  on public.user_portfolio_positions (symbol);

alter table public.user_portfolio_positions enable row level security;

drop policy if exists "user_portfolio_owner_all" on public.user_portfolio_positions;
create policy "user_portfolio_owner_all"
  on public.user_portfolio_positions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.user_portfolio_positions to authenticated;

-- 2) رفع رأس مال المحاكي المشترك الافتراضي إلى 50,000$ (تعليمي)
--    يُحدَّث فقط إن بقي الرصيد عند القيمة القديمة ولم تُفتح مراكز بعد.
alter table public.shared_virtual_portfolios
  alter column cash set default 50000;

update public.shared_virtual_portfolios p
set cash = 50000,
    updated_at = now()
where p.simulation_id = 'global'
  and p.cash = 10000
  and not exists (
    select 1 from public.shared_virtual_positions s
    where s.simulation_id = p.simulation_id
  );

-- 3) تفضيل إشعارات محفظة/مراقبة (اختياري — الواجهة تعمل بدونه)
alter table public.notification_subscriptions
  add column if not exists portfolio_news_enabled boolean not null default true;

alter table public.notification_subscriptions
  add column if not exists picks_alerts_enabled boolean not null default true;


-- 4) علامات يومية لحساب ربح/خسارة اليوم والشهر والتاريخي لمحفظة المستخدم
create table if not exists public.user_portfolio_daily_marks (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  mark_date   date not null,
  equity      numeric not null default 0,
  invested    numeric not null default 0,
  all_time_pnl numeric not null default 0,
  day_pnl     numeric not null default 0,
  created_at  timestamptz not null default now(),
  primary key (user_id, mark_date)
);

alter table public.user_portfolio_daily_marks enable row level security;

drop policy if exists "user_portfolio_marks_owner_all" on public.user_portfolio_daily_marks;
create policy "user_portfolio_marks_owner_all"
  on public.user_portfolio_daily_marks for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.user_portfolio_daily_marks to authenticated;
