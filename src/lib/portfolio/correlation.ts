// ─────────────────────────────────────────────────────────────────────────────
// Real historical return correlation.
// Pearson correlation of daily returns from each security's native price
// series. Returns null (→ "N/A") whenever there is insufficient overlapping
// history — no estimated or sector-implied values are ever produced.
// ─────────────────────────────────────────────────────────────────────────────

import { CORRELATION_SETTINGS } from '../../config/portfolioConfig';

/** Daily simple returns from a close series. */
export function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (!prev || prev === 0) continue;
    out.push(closes[i] / prev - 1);
  }
  return out;
}

/** Pearson correlation. Returns null when undefined (zero variance / too few points). */
export function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const xa = a.slice(a.length - n);
  const xb = b.slice(b.length - n);

  const ma = xa.reduce((s, x) => s + x, 0) / n;
  const mb = xb.reduce((s, x) => s + x, 0) / n;

  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const va = xa[i] - ma;
    const vb = xb[i] - mb;
    num += va * vb;
    da += va * va;
    db += vb * vb;
  }
  const den = Math.sqrt(da * db);
  if (!isFinite(den) || den === 0) return null;   // a flat series has no correlation
  const r = num / den;
  if (!isFinite(r)) return null;
  return Math.max(-1, Math.min(1, r));
}

export interface CorrelationMatrix {
  tickers: string[];
  /** get(a, b) → correlation or null when insufficient data */
  get: (a: string, b: string) => number | null;
  /** number of overlapping observations used for a pair */
  observations: (a: string, b: string) => number;
  /** tickers excluded for lack of history */
  unavailable: string[];
  days: number;
}

/**
 * Build a correlation matrix over the last `days` trading days.
 * Series are aligned from the right (most recent), which is correct for
 * same-market daily bars; pairs with fewer than `minObservations` overlapping
 * returns are reported as null.
 */
export function computeCorrelationMatrix(
  tickers: string[],
  closesByTicker: Map<string, number[]>,
  days: number = CORRELATION_SETTINGS.defaultDays,
  minObservations: number = CORRELATION_SETTINGS.minObservations,
): CorrelationMatrix {
  const returns = new Map<string, number[]>();
  const unavailable: string[] = [];

  for (const t of tickers) {
    const closes = closesByTicker.get(t.toUpperCase());
    if (!closes || closes.length < minObservations + 1) { unavailable.push(t); continue; }
    // +1 close yields `days` returns
    const window = closes.slice(-(days + 1));
    const rets = dailyReturns(window);
    if (rets.length < minObservations) { unavailable.push(t); continue; }
    returns.set(t.toUpperCase(), rets);
  }

  const cache = new Map<string, number | null>();
  const key = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`;

  function get(a: string, b: string): number | null {
    const A = a.toUpperCase(), B = b.toUpperCase();
    if (A === B) return 1;
    const k = key(A, B);
    if (cache.has(k)) return cache.get(k)!;
    const ra = returns.get(A), rb = returns.get(B);
    let r: number | null = null;
    if (ra && rb) {
      const n = Math.min(ra.length, rb.length);
      r = n >= minObservations ? pearson(ra, rb) : null;
    }
    cache.set(k, r);
    return r;
  }

  function observations(a: string, b: string): number {
    const ra = returns.get(a.toUpperCase()), rb = returns.get(b.toUpperCase());
    if (!ra || !rb) return 0;
    return Math.min(ra.length, rb.length);
  }

  return { tickers, get, observations, unavailable, days };
}

/** Average pairwise correlation — a single diversification read-out. */
export function averageCorrelation(m: CorrelationMatrix): number | null {
  const ts = m.tickers;
  let sum = 0, n = 0;
  for (let i = 0; i < ts.length; i++) {
    for (let j = i + 1; j < ts.length; j++) {
      const r = m.get(ts[i], ts[j]);
      if (r == null) continue;
      sum += r;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}
