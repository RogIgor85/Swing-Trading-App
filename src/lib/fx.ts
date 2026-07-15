// Live USD/CAD exchange rate with a 12-hour localStorage cache.
// Source: Yahoo Finance "CAD=X" (USD→CAD) via our /api/yahoo proxy.
// Fallback chain: fresh fetch → cached value (any age) → 1.38.

import { fetchYahoo } from './yahoo';

const FX_CACHE_KEY = 'swing_fx_usdcad';
const TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const FALLBACK_RATE = 1.38;

interface FxCache {
  rate: number;
  fetchedAt: number;
}

function readCache(): FxCache | null {
  try {
    const raw = localStorage.getItem(FX_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FxCache;
    if (typeof parsed.rate !== 'number' || parsed.rate <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Synchronous: last known rate (cached or fallback). Never blocks. */
export function getUsdCadCached(): number {
  return readCache()?.rate ?? FALLBACK_RATE;
}

let inflight: Promise<number> | null = null;

/**
 * Async: live rate. Returns cached value if fresh (<12h), otherwise fetches
 * from Yahoo. On failure falls back to the stale cache, then 1.38.
 */
export function getUsdCad(): Promise<number> {
  const cache = readCache();
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) {
    return Promise.resolve(cache.rate);
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const y = await fetchYahoo('CAD=X');
      const rate = y.price?.regularMarketPrice ?? null;
      if (rate && rate > 0.5 && rate < 3) {  // sanity bounds for USD/CAD
        localStorage.setItem(FX_CACHE_KEY, JSON.stringify({ rate, fetchedAt: Date.now() } satisfies FxCache));
        return rate;
      }
      return cache?.rate ?? FALLBACK_RATE;
    } catch {
      return cache?.rate ?? FALLBACK_RATE;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
