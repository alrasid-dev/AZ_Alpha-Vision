-- ============================================================
-- AZ Alpha Vision — Daily OHLC cache for interactive charts
-- ============================================================

create table if not exists public.market_ohlc_daily (
  symbol      text not null,
  bar_date    date not null,
  open        numeric not null,
  high        numeric not null,
  low         numeric not null,
  close       numeric not null,
  volume      bigint,
  updated_at  timestamptz not null default now(),
  primary key (symbol, bar_date)
);

create index if not exists market_ohlc_daily_symbol_date_idx
  on public.market_ohlc_daily (symbol, bar_date desc);

alter table public.market_ohlc_daily enable row level security;

drop policy if exists "market_ohlc_daily_read_all" on public.market_ohlc_daily;
create policy "market_ohlc_daily_read_all"
  on public.market_ohlc_daily for select using (true);

grant select on public.market_ohlc_daily to authenticated, anon;
-- Writes via service_role only (fetch-ohlc edge function)
