-- ============================================================
-- AZ Alpha Vision — محرك المحاكي المالي الحقيقي (Buy/Sell Engine)
-- شغّل بعد supabase_schema.sql و market_data_schema.sql و screener_schema.sql
-- الجداول التالية كانت تُقرأ من app.js منذ البداية لكنها لم تكن موجودة إطلاقاً؛
-- بدونها كان المحاكي يعرض دائماً القيم الافتراضية (10,000$ وبلا صفقات).
-- ============================================================

create table if not exists public.shared_virtual_portfolios (
  simulation_id text primary key,
  cash          numeric not null default 10000,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.shared_virtual_positions (
  simulation_id text not null default 'global',
  symbol        text not null,
  qty           numeric not null,
  entry_price   numeric not null,
  last_price    numeric,
  peak_price    numeric,
  entry_tier    text,
  reason        text,
  entered_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (simulation_id, symbol)
);

create table if not exists public.shared_virtual_trades (
  id            uuid primary key default gen_random_uuid(),
  simulation_id text not null default 'global',
  symbol        text not null,
  action        text not null check (action in ('buy','sell')),
  qty           numeric not null,
  price         numeric not null,
  entry_price   numeric,
  tier          text,
  pnl           numeric,
  reason        text,
  created_at    timestamptz not null default now()
);

create table if not exists public.virtual_trader_runs (
  id                uuid primary key default gen_random_uuid(),
  started_at        timestamptz not null default now(),
  status            text not null default 'ok',
  market_open       boolean not null default false,
  candidate_count   int not null default 0,
  entry_candidates  int not null default 0,
  near_entries      int not null default 0,
  blocked_by_plan   int not null default 0,
  blocked_by_price  int not null default 0,
  run_note          text
);

alter table public.shared_virtual_portfolios enable row level security;
alter table public.shared_virtual_positions  enable row level security;
alter table public.shared_virtual_trades     enable row level security;
alter table public.virtual_trader_runs       enable row level security;

create policy "shared_virtual_portfolios_read_all" on public.shared_virtual_portfolios for select using (true);
create policy "shared_virtual_positions_read_all"  on public.shared_virtual_positions  for select using (true);
create policy "shared_virtual_trades_read_all"     on public.shared_virtual_trades     for select using (true);
create policy "virtual_trader_runs_read_all"       on public.virtual_trader_runs       for select using (true);

grant select on public.shared_virtual_portfolios, public.shared_virtual_positions,
  public.shared_virtual_trades, public.virtual_trader_runs to authenticated, anon;

-- تهيئة أولية إجبارية: محفظة عامة واحدة برأس مال $10,000 تعليمي (محاكاة فقط، بلا أموال حقيقية)
insert into public.shared_virtual_portfolios (simulation_id, cash)
values ('global', 10000)
on conflict (simulation_id) do nothing;

-- ملاحظة: لا صلاحية كتابة لأي دور عميل على أي من الجداول الأربعة أعلاه —
-- الكتابة حصراً عبر service_role داخل Edge Function: supabase/functions/run-virtual-trader
