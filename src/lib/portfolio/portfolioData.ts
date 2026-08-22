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

export interface Quote {
  price: number;
  prevClose: number | null;   // null when the provider gives no previous close
  source: 'finnhub' | 'yahoo';
}

const SUFFIXED = /\.(TO|V|TSX|CN|NEO|VN|L|AX|HK)$/i;

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
      return { price, prevClose: pc != null && pc > 0 ? pc : null, source: 'yahoo' };
    }
  } catch { /* unavailable */ }

  return null;
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
