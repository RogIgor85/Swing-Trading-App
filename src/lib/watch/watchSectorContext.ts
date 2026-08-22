// ─────────────────────────────────────────────────────────────────────────────
// Watch List → Sector Rotation context.
// Maps a watchlist ticker to a sector ETF and pulls that sector's live rotation
// metrics from the EXISTING sector engine (no rotation math is duplicated here).
// Also batches ~1y closes for watchlist tickers to derive stock returns and
// relative strength vs the sector ETF.
// ─────────────────────────────────────────────────────────────────────────────

import { SECTOR_ETFS } from '../../config/sectorConfig';
import { finnhub } from '../finnhub';

const SECTOR_MAP_KEY = 'swing_watch_sector_map';
const SECTOR_MAP_TTL = 24 * 60 * 60 * 1000; // 24h — sector membership is stable

// Finnhub industry → sector ETF. Only used when a ticker isn't a tracked
// constituent. Unmapped industries return null (never guessed).
const INDUSTRY_TO_ETF: Record<string, string> = {
  'Technology': 'XLK',
  'Semiconductors': 'XLK',
  'Electronic Equipment': 'XLK',
  'Software': 'XLK',
  'Hardware': 'XLK',
  'Banking': 'XLF',
  'Financial Services': 'XLF',
  'Insurance': 'XLF',
  'Health Care': 'XLV',
  'Healthcare': 'XLV',
  'Pharmaceuticals': 'XLV',
  'Biotechnology': 'XLV',
  'Life Sciences Tools & Services': 'XLV',
  'Industrials': 'XLI',
  'Machinery': 'XLI',
  'Aerospace & Defense': 'XLI',
  'Transportation': 'XLI',
  'Airlines': 'XLI',
  'Logistics & Transportation': 'XLI',
  'Retail': 'XLY',
  'Automobiles': 'XLY',
  'Auto Components': 'XLY',
  'Hotels, Restaurants & Leisure': 'XLY',
  'Textiles, Apparel & Luxury Goods': 'XLY',
  'Consumer products': 'XLP',
  'Food Products': 'XLP',
  'Beverages': 'XLP',
  'Tobacco': 'XLP',
  'Energy': 'XLE',
  'Oil & Gas': 'XLE',
  'Utilities': 'XLU',
  'Chemicals': 'XLB',
  'Metals & Mining': 'XLB',
  'Building': 'XLB',
  'Constr. Mat.': 'XLB',
  'Real Estate': 'XLRE',
  'Communications': 'XLC',
  'Media': 'XLC',
  'Telecommunication': 'XLC',
};

// Ticker → sector ETF from the tracked constituent lists (exact membership)
const CONSTITUENT_INDEX: Record<string, string> = (() => {
  const idx: Record<string, string> = {};
  for (const s of SECTOR_ETFS) for (const t of s.constituents) idx[t] = s.etf;
  return idx;
})();

interface SectorMapCache { at: number; map: Record<string, string | null> }

function readMap(): Record<string, string | null> {
  try {
    const raw = localStorage.getItem(SECTOR_MAP_KEY);
    if (!raw) return {};
    const c = JSON.parse(raw) as SectorMapCache;
    if (Date.now() - c.at > SECTOR_MAP_TTL) return {};
    return c.map ?? {};
  } catch { return {}; }
}

function writeMap(map: Record<string, string | null>) {
  try { localStorage.setItem(SECTOR_MAP_KEY, JSON.stringify({ at: Date.now(), map } satisfies SectorMapCache)); }
  catch { /* quota */ }
}

/**
 * Resolve tickers → sector ETF. Constituent membership first, then a single
 * Finnhub profile call per unknown ticker (cached 24h). Returns null for
 * tickers whose sector cannot be determined — never guessed.
 */
export async function resolveSectors(tickers: string[]): Promise<Record<string, string | null>> {
  const cache = readMap();
  const out: Record<string, string | null> = {};
  const unknown: string[] = [];

  for (const t of tickers) {
    const up = t.toUpperCase();
    if (CONSTITUENT_INDEX[up]) { out[up] = CONSTITUENT_INDEX[up]; continue; }
    if (up in cache) { out[up] = cache[up]; continue; }
    unknown.push(up);
  }

  if (unknown.length > 0) {
    const results = await Promise.allSettled(
      unknown.map(async t => {
        // Finnhub uses the base symbol (no .TO suffix)
        const base = t.replace(/\.(TO|V|TSX|CN|NEO|VN)$/i, '');
        const p = await finnhub.profile(base);
        const industry = p?.finnhubIndustry ?? '';
        return { t, etf: INDUSTRY_TO_ETF[industry] ?? null };
      })
    );
    results.forEach((r, i) => {
      const t = unknown[i];
      const etf = r.status === 'fulfilled' ? r.value.etf : null;
      out[t] = etf;
      cache[t] = etf;
    });
    writeMap(cache);
  }

  return out;
}

// ── batched watchlist price history (for stock returns / RS vs sector) ───────

const HIST_KEY = 'swing_watch_hist';
const HIST_TTL = 30 * 60 * 1000;

export interface StockReturns { ret5D: number | null; ret1M: number | null; ret3M: number | null }

function retN(closes: number[], n: number): number | null {
  const end = closes.length - 1;
  const start = end - n;
  if (start < 0 || closes[start] === 0) return null;
  return closes[end] / closes[start] - 1;
}

/**
 * Batched ~1y daily closes for watchlist tickers via the existing spark proxy.
 * Returns per-ticker 5D/1M/3M returns. Missing tickers are simply absent.
 */
export async function fetchWatchReturns(tickers: string[], force = false): Promise<Map<string, StockReturns>> {
  if (tickers.length === 0) return new Map();
  if (force) { try { localStorage.removeItem(HIST_KEY); } catch { /* noop */ } }

  try {
    const raw = localStorage.getItem(HIST_KEY);
    if (raw && !force) {
      const c = JSON.parse(raw) as { at: number; series: Array<{ symbol: string; closes: number[] }> };
      if (Date.now() - c.at < HIST_TTL) {
        const have = new Set(c.series.map(s => s.symbol));
        if (tickers.every(t => have.has(t.toUpperCase()))) {
          return new Map(c.series.map(s => [s.symbol, {
            ret5D: retN(s.closes, 5), ret1M: retN(s.closes, 21), ret3M: retN(s.closes, 63),
          }]));
        }
      }
    }
  } catch { /* fall through to fetch */ }

  try {
    const syms = tickers.map(t => t.toUpperCase()).join(',');
    const res = await fetch(`/api/yahoo?spark=1&tickers=${encodeURIComponent(syms)}`);
    if (!res.ok) return new Map();
    const j = await res.json();
    const series: Array<{ symbol: string; closes: number[] }> = j.series ?? [];
    if (series.length > 0) {
      try { localStorage.setItem(HIST_KEY, JSON.stringify({ at: Date.now(), series })); } catch { /* quota */ }
    }
    return new Map(series.map(s => [s.symbol, {
      ret5D: retN(s.closes, 5), ret1M: retN(s.closes, 21), ret3M: retN(s.closes, 63),
    }]));
  } catch { return new Map(); }
}
