-- ============================================================
-- محرك الماسح (Finviz + yfinance + توافق إشارات) → داخل AZ Alpha Vision
-- شغّل بعد supabase_schema.sql و market_data_schema.sql
-- ============================================================

create table if not exists public.screener_signals (
  preset            text not null,
  symbol            text not null,
  company           text,
  sector            text,
  industry          text,
  pe                numeric,
  price             numeric,
  change_pct        numeric,
  entry_score       int,
  entry_tier        text,        -- أولي / أقوى / صريح / null
  entry_signals     jsonb,       -- {fibonacci, smc_atr, candlestick, volume}
  exit_score        int,
  exit_tier         text,
  exit_signals      jsonb,
  fib_ratio         numeric,
  updated_at        timestamptz not null default now(),
  primary key (preset, symbol)
);

create table if not exists public.screener_alerts (
  id          uuid primary key default gen_random_uuid(),
  ts          timestamptz not null default now(),
  preset      text not null,
  symbol      text not null,
  type        text not null check (type in ('entry','exit')),
  tier        text not null,
  score       int not null,
  price       numeric,
  signals     jsonb
);

create table if not exists public.screener_performance (
  granularity       text not null,   -- month/quarter/half/year
  period            text not null,   -- e.g. 2026-08, 2026-Q3
  trades            int not null default 0,
  win_rate          numeric,
  avg_return_pct    numeric,
  total_return_pct  numeric,
  updated_at        timestamptz not null default now(),
  primary key (granularity, period)
);

create table if not exists public.screener_charts (
  symbol      text primary key,
  data        jsonb not null,   -- [[date,o,h,l,c], ...]
  updated_at  timestamptz not null default now()
);

alter table public.screener_signals     enable row level security;
alter table public.screener_alerts      enable row level security;
alter table public.screener_performance enable row level security;
alter table public.screener_charts      enable row level security;

create policy "screener_signals_read_all"     on public.screener_signals     for select using (true);
create policy "screener_alerts_read_all"      on public.screener_alerts      for select using (true);
create policy "screener_performance_read_all" on public.screener_performance for select using (true);
create policy "screener_charts_read_all"      on public.screener_charts      for select using (true);

grant select on public.screener_signals, public.screener_alerts, public.screener_performance, public.screener_charts
  to authenticated, anon;

-- ملاحظة: لا صلاحية كتابة لأي دور عميل — الكتابة فقط عبر service_role (نفس مفتاح fetch_market_data.py)
