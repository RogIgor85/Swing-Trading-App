-- Swing Trading App — Supabase Schema
-- Run this in the Supabase SQL editor after creating your project.
-- Then set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env (or Vercel env vars).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Scorecard entries
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists scorecard_entries (
  id                  uuid primary key default gen_random_uuid(),
  ticker              text not null,
  company_name        text,
  trade_date          date not null,
  technical_score     numeric(4,2) not null,
  fundamental_score   numeric(4,2) not null,
  risk_liquidity_score numeric(4,2) not null,
  sentiment_score     numeric(4,2) not null,
  weighted_score      numeric(4,2) not null,
  verdict             text not null check (verdict in ('GO','CONDITIONAL','NO GO')),
  notes               text,
  created_at          timestamptz default now()
);

alter table scorecard_entries enable row level security;
create policy "public_access" on scorecard_entries for all using (true) with check (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Watch list
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists watchlist (
  id          uuid primary key default gen_random_uuid(),
  ticker      text not null,
  conviction  text not null check (conviction in ('HIGH','MEDIUM','LOW')),
  notes       text,
  added_at    timestamptz default now(),
  created_at  timestamptz default now()
);

alter table watchlist enable row level security;
create policy "public_access" on watchlist for all using (true) with check (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Technical setups
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists technical_setups (
  id                  uuid primary key default gen_random_uuid(),
  ticker              text not null,
  trend_daily         text not null check (trend_daily in ('BULLISH','BEARISH','NEUTRAL')),
  trend_weekly        text not null check (trend_weekly in ('BULLISH','BEARISH','NEUTRAL')),
  trend_monthly       text not null check (trend_monthly in ('BULLISH','BEARISH','NEUTRAL')),
  support_levels      text,
  resistance_levels   text,
  ma_50               numeric(10,2),
  ma_200              numeric(10,2),
  rsi                 numeric(5,2),
  macd                text,
  chart_pattern       text,
  entry_price         numeric(10,2),
  stop_loss           numeric(10,2),
  target              numeric(10,2),
  rr_ratio            numeric(6,2),
  confidence          smallint not null default 5,
  notes               text,
  created_at          timestamptz default now()
);

alter table technical_setups enable row level security;
create policy "public_access" on technical_setups for all using (true) with check (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Portfolio holdings
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists portfolio_holdings (
  id              uuid primary key default gen_random_uuid(),
  ticker          text not null,
  shares          numeric(12,3) not null,
  avg_cost        numeric(10,2) not null,
  sector          text,
  liquidity_risk  text not null check (liquidity_risk in ('LOW','MEDIUM','HIGH')),
  notes           text,
  created_at      timestamptz default now()
);

alter table portfolio_holdings enable row level security;
create policy "public_access" on portfolio_holdings for all using (true) with check (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Fundamental notes
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists fundamental_notes (
  id          uuid primary key default gen_random_uuid(),
  ticker      text not null unique,
  bull_case   text,
  bear_case   text,
  notes       text,
  created_at  timestamptz default now()
);

alter table fundamental_notes enable row level security;
create policy "public_access" on fundamental_notes for all using (true) with check (true);
