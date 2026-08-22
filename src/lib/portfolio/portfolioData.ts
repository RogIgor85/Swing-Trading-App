// ─────────────────────────────────────────────────────────────────────────────
// Portfolio market data.
//
// IMPORTANT: Finnhub ignores exchange suffixes — quoting "MSFT.TO" returns the
// US listing's USD price, and quoting "QQC.TO" can resolve to an unrelated
// symbol entirely. That produced wrong prices and nonsense daily moves for
// Canadian holdings. Exchange-suffixed tickers therefore go to Yahoo ONLY,
// which returns the real CAD-listed price. US tickers still use Finnhub first.
// ─────────────────────────────────────────────────────────────────────────────

import { finnhub } from '../finnhub';
import { fetchYahoo } from '../yahoo';
import { ETF_REGISTRY } from '../../config/portfolioConfig';

export interface Quote {
  price: number;
  prevClose: number | null;   // null when the provider gives no previous close
  source: 'finnhub' | 'yahoo';
}

const SUFFIXED = /\.(TO|V|TSX|CN|NEO|VN|L|AX|HK)$/i;

// Bumped whenever a data bug invalidates cached values. v2 clears caches
// written while the proxy was returning a year-old "previous close".
const CACHE_VERSION = '2';
const VERSION_KEY = 'swing_cache_version';

/** One-time purge of caches poisoned by a previous data bug. */
export function purgeStaleCaches(): void {
  try {
    if (localStorage.getItem(VERSION_KEY) === CACHE_VERSION) return;
    [
      'swing_live_prices', 'swing_daily_change', 'swing_portfolio_hist',
      'swing_watch_hist', 'swing_sec_con_hist', 'swing_sec_constituents',
      'swing_sec_spyquote',
    ].forEach(k => localStorage.removeItem(k));
    Object.keys(localStorage)
      .filter(k => k.startsWith('swing_sec_hist_'))
      .forEach(k => localStorage.removeItem(k));
    localStorage.setItem(VERSION_KEY, CACHE_VERSION);
  } catch { /* private mode */ }
}

/**
 * Implied daily moves beyond these bounds indicate a mismatched previous close.
 * Diversified funds essentially never move double digits in a session, so they
 * get a tight bound; individual stocks can genuinely gap on earnings, so theirs
 * is far looser to avoid discarding real moves.
 */
export const MAX_PLAUSIBLE_DAILY_MOVE_FUND  = 0.15;
export const MAX_PLAUSIBLE_DAILY_MOVE_STOCK = 0.40;

export function hasExchangeSuffix(ticker: string): boolean {
  return SUFFIXED.test(ticker);
}

/** Single quote with the correct provider for the listing. */
export async function fetchQuote(ticker: string): Promise<Quote | null> {
  const t = ticker.toUpperCase();

  if (!hasExchangeSuffix(t)) {
    try {
      const q = await finnhub.quote(t);
      if (q?.c && q.c > 0) {
        return { price: q.c, prevClose: q.pc && q.pc > 0 ? q.pc : null, source: 'finnhub' };
      }
    } catch { /* fall through to Yahoo */ }
  }

  try {
    const y = await fetchYahoo(t);
    const price = y.price?.regularMarketPrice ?? null;
    if (price != null && price > 0) {
      const pc = y.price?.regularMarketPreviousClose ?? null;
      return { price, prevClose: validatePrevClose(t, price, pc), source: 'yahoo' };
    }
  } catch { /* unavailable */ }

  return null;
}

/**
 * Reject a previous close that implies an implausible single-session move —
 * that signature means the provider returned a close from the wrong period
 * (or the wrong listing), not a real gap. Returns null so the UI shows N/A
 * rather than a fabricated daily figure.
 */
export function validatePrevClose(ticker: string, price: number, prevClose: number | null): number | null {
  if (prevClose == null || !(prevClose > 0)) return null;
  const isFund = ticker.toUpperCase() in ETF_REGISTRY;
  const limit = isFund ? MAX_PLAUSIBLE_DAILY_MOVE_FUND : MAX_PLAUSIBLE_DAILY_MOVE_STOCK;
  const move = Math.abs(price / prevClose - 1);
  if (move > limit) {
    if (import.meta.env.DEV) {
      console.warn(
        `[portfolio] ${ticker}: rejecting previous close ${prevClose} vs price ${price} ` +
        `(${(move * 100).toFixed(1)}% implied daily move) — likely a mismatched period or listing.`
      );
    }
    return null;
  }
  return prevClose;
}

// ── batched close history (for 1M/3M returns and correlation) ────────────────

const HIST_KEY = 'swing_portfolio_hist';
const HIST_TTL = 30 * 60 * 1000;

interface HistCache { at: number; series: Array<{ symbol: string; closes: number[] }> }

/**
 * One batched request for ~1y of daily closes across all portfolio tickers.
 * Cached 30 minutes so tab switching doesn't re-hit the API.
 */
export async function fetchPortfolioHistories(tickers: string[], force = false): Promise<Map<string, number[]>> {
  if (tickers.length === 0) return new Map();
  const wanted = tickers.map(t => t.toUpperCase());

  if (force) { try { localStorage.removeItem(HIST_KEY); } catch { /* noop */ } }
  else {
    try {
      const raw = localStorage.getItem(HIST_KEY);
      if (raw) {
        const c = JSON.parse(raw) as HistCache;
        if (Date.now() - c.at < HIST_TTL) {
          const have = new Set(c.series.map(s => s.symbol));
          if (wanted.every(t => have.has(t))) {
            return new Map(c.series.map(s => [s.symbol, s.closes]));
          }
        }
      }
    } catch { /* refetch */ }
  }

  try {
    const res = await fetch(`/api/yahoo?spark=1&tickers=${encodeURIComponent(wanted.join(','))}`);
    if (!res.ok) return new Map();
    const j = await res.json();
    const series: Array<{ symbol: string; closes: number[] }> = j.series ?? [];
    if (series.length > 0) {
      try { localStorage.setItem(HIST_KEY, JSON.stringify({ at: Date.now(), series } satisfies HistCache)); }
      catch { /* quota */ }
    }
    return new Map(series.map(s => [s.symbol, s.closes]));
  } catch { return new Map(); }
}
