// ─────────────────────────────────────────────────────────────────────────────
// Sector Rotation — data layer. Raw market data only, no scoring math.
// Reuses the existing /api/yahoo proxy (history + batch modes) and Finnhub.
// Caching follows the app's localStorage + TTL pattern (see fx.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { finnhub } from '../finnhub';
import { SECTOR_ETFS, BENCHMARK_ETF, SECTOR_CACHE } from '../../config/sectorConfig';
import type { FinnhubMetrics } from '../../types';

export interface EtfHistory {
  symbol: string;
  name: string;
  price: number;
  prevClose: number | null;
  timestamps: number[];
  closes: number[];
  volumes: number[];
}

export interface ConstituentQuote {
  symbol: string;
  name: string;
  price: number | null;
  changePct: number | null;   // percent units, e.g. 1.2 = +1.2%
  volume: number | null;
  avgVolume3M: number | null;
  ma50: number | null;
  ma200: number | null;
  marketCap: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  epsTTM: number | null;
  earningsTs: number | null;
}

// ── generic localStorage cache ───────────────────────────────────────────────

function cacheGet<T>(key: string, ttlMs: number): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { at, data } = JSON.parse(raw) as { at: number; data: T };
    if (Date.now() - at > ttlMs) return null;
    return data;
  } catch { return null; }
}

function cacheSet<T>(key: string, data: T) {
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch { /* full */ }
}

// ── ETF daily history ────────────────────────────────────────────────────────

async function fetchHistory(symbol: string): Promise<EtfHistory | null> {
  const key = `swing_sec_hist_${symbol}`;
  const cached = cacheGet<EtfHistory>(key, SECTOR_CACHE.history);
  if (cached) return cached;
  try {
    const res = await fetch(`/api/yahoo?ticker=${encodeURIComponent(symbol)}&history=1`);
    if (!res.ok) return null;
    const j = await res.json();
    if (j.error || !Array.isArray(j.closes) || j.closes.length < 60) return null;
    const h: EtfHistory = {
      symbol, name: j.name ?? symbol, price: j.price,
      prevClose: j.prevClose ?? null,
      timestamps: j.timestamps, closes: j.closes, volumes: j.volumes,
    };
    cacheSet(key, h);
    return h;
  } catch { return null; }
}

/** All 12 histories (SPY + 11 sectors), in parallel. Nulls where unavailable. */
export async function fetchAllHistories(force = false): Promise<Map<string, EtfHistory>> {
  if (force) {
    [BENCHMARK_ETF, ...SECTOR_ETFS.map(s => s.etf)].forEach(s =>
      localStorage.removeItem(`swing_sec_hist_${s}`));
  }
  const symbols = [BENCHMARK_ETF, ...SECTOR_ETFS.map(s => s.etf)];
  const results = await Promise.all(symbols.map(fetchHistory));
  const map = new Map<string, EtfHistory>();
  results.forEach(h => { if (h) map.set(h.symbol, h); });
  return map;
}

// ── batched constituent quotes (all sectors in one request) ──────────────────

export async function fetchConstituentQuotes(force = false): Promise<Map<string, ConstituentQuote>> {
  const key = 'swing_sec_constituents';
  if (force) localStorage.removeItem(key);
  const cached = cacheGet<ConstituentQuote[]>(key, SECTOR_CACHE.constituents);
  if (cached) return new Map(cached.map(q => [q.symbol, q]));
  try {
    const all = SECTOR_ETFS.flatMap(s => s.constituents);
    const res = await fetch(`/api/yahoo?tickers=${encodeURIComponent(all.join(','))}`);
    if (!res.ok) return new Map();
    const j = await res.json();
    const quotes: ConstituentQuote[] = j.quotes ?? [];
    if (quotes.length > 0) cacheSet(key, quotes);
    return new Map(quotes.map(q => [q.symbol, q]));
  } catch { return new Map(); }
}

// ── batched constituent close history (spark endpoint) ───────────────────────
// One request for all ~165 constituents' daily closes (~1y). This powers real
// breadth (20/50/200DMA, 5D/20D positive) and the drill-down when the v7
// quote endpoint is unavailable.

export async function fetchConstituentHistories(force = false): Promise<Map<string, number[]>> {
  const key = 'swing_sec_con_hist';
  if (force) localStorage.removeItem(key);
  const cached = cacheGet<Array<{ symbol: string; closes: number[] }>>(key, SECTOR_CACHE.constituentHistory);
  if (cached) return new Map(cached.map(s => [s.symbol, s.closes]));
  try {
    const all = SECTOR_ETFS.flatMap(s => s.constituents);
    const res = await fetch(`/api/yahoo?spark=1&tickers=${encodeURIComponent(all.join(','))}`);
    if (!res.ok) return new Map();
    const j = await res.json();
    const series: Array<{ symbol: string; closes: number[] }> = j.series ?? [];
    if (series.length > 0) cacheSet(key, series);
    return new Map(series.map(s => [s.symbol, s.closes]));
  } catch { return new Map(); }
}

// ── SPY header quote (fresher than history cache) ────────────────────────────

export interface SpyQuote { price: number; changePct: number }

export async function fetchSpyQuote(): Promise<SpyQuote | null> {
  const key = 'swing_sec_spyquote';
  const cached = cacheGet<SpyQuote>(key, SECTOR_CACHE.quotes);
  if (cached) return cached;
  try {
    const q = await finnhub.quote(BENCHMARK_ETF);
    if (q.c && q.c > 0) {
      const s = { price: q.c, changePct: q.dp ?? 0 };
      cacheSet(key, s);
      return s;
    }
    return null;
  } catch { return null; }
}

// ── per-ticker fundamentals for drill-down (lazy, cached 12h) ────────────────

export interface ConstituentFundamentals {
  revenueGrowth: number | null;   // % 3y CAGR
  epsGrowth: number | null;       // % 3y CAGR
  netMargin: number | null;       // %
  roe: number | null;             // %
}

export async function fetchFundamentals(symbol: string): Promise<ConstituentFundamentals | null> {
  const key = `swing_sec_fund_${symbol}`;
  const cached = cacheGet<ConstituentFundamentals>(key, SECTOR_CACHE.fundamentals);
  if (cached) return cached;
  try {
    const m: FinnhubMetrics = await finnhub.metrics(symbol.replace('-', '.'));
    const f: ConstituentFundamentals = {
      revenueGrowth: m.metric?.revenueGrowth3Y ?? null,
      epsGrowth:     m.metric?.epsGrowth3Y ?? null,
      netMargin:     m.metric?.netProfitMarginTTM ?? null,
      roe:           m.metric?.roeTTM ?? null,
    };
    cacheSet(key, f);
    return f;
  } catch { return null; }
}

/** Approximate US market status from local clock (NYSE 9:30–16:00 ET, Mon–Fri). */
export function usMarketStatus(): 'OPEN' | 'CLOSED' {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return 'CLOSED';
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins < 16 * 60 ? 'OPEN' : 'CLOSED';
}
