-- ============================================================
-- AZ Alpha Vision — real market data schema
-- Run in: Supabase Dashboard → SQL Editor (after supabase_schema.sql)
-- ============================================================

-- Three separate tables on purpose: each is written by exactly ONE
-- job, so a partial upsert from one job can never silently blank out
-- columns that only the other job knows how to fill in.

-- 1) FUNDAMENTALS — sector/industry/valuation, barely changes intraday.
--    Written once a day by fetch_market_data.py --mode full
create table if not exists public.market_fundamentals (
  symbol                 text primary key,
  company                text,
  sector                 text,          -- translated to tech/finance/healthcare/consumer/industrial/energy/reits/other
  finviz_sector          text,          -- original Finviz sector name, kept for reference/debugging
  industry               text,
  pe                     numeric,
  pb                     numeric,
  eps_growth_qtr         numeric,
  eps_growth_this_year   numeric,
  eps_growth_next_year   numeric,
  eps_growth_5y          numeric,
  eps_growth_next_5y     numeric,
  lt_debt_equity         numeric,
  updated_at             timestamptz not null default now()
);

-- 2) TECHNICALS — price + indicators as of the last daily full scan.
--    Used by the screener and weekly picks (a day of staleness is fine here).
create table if not exists public.market_technicals (
  symbol         text primary key references public.market_fundamentals(symbol) on delete cascade,
  price          numeric,
  change_pct     numeric,
  volume         bigint,
  avg_volume     bigint,
  rel_volume     numeric,
  sma20          numeric,
  sma50          numeric,
  sma200         numeric,
  rsi14          numeric,
  atr14          numeric,
  perf_week      numeric,
  updated_at     timestamptz not null default now()
);

-- 3) LIVE QUOTES — price/change only, for the small tracked list shown
--    on the "Live Stocks" tab. Written every ~15 min by --mode quick.
create table if not exists public.live_quotes (
  symbol       text primary key,
  price        numeric,
  change_pct   numeric,
  volume       bigint,
  updated_at   timestamptz not null default now()
);

alter table public.market_fundamentals enable row level security;
alter table public.market_technicals   enable row level security;
alter table public.live_quotes         enable row level security;

-- market data is not user-specific — anyone signed in can read it,
-- nobody (except the service role, which bypasses RLS entirely) can write it
create policy "market_fundamentals_read_all" on public.market_fundamentals for select using (true);
create policy "market_technicals_read_all"   on public.market_technicals   for select using (true);
create policy "live_quotes_read_all"         on public.live_quotes         for select using (true);

grant select on public.market_fundamentals to authenticated, anon;
grant select on public.market_technicals   to authenticated, anon;
grant select on public.live_quotes         to authenticated, anon;

-- ============================================================
-- fetch_market_data.py writes here using the SERVICE ROLE key
-- (Settings → API → service_role in your Supabase dashboard).
-- That key bypasses RLS by design — it must only ever live in
-- GitHub Actions secrets, never in app.js or any client file.
-- ============================================================
