// ─────────────────────────────────────────────────────────────────────────────
// Same-period portfolio return for benchmark comparison.
//
// Comparing lifetime P&L-on-cost against a YTD index return is invalid — the
// periods differ. This computes a year-to-date PRICE return for the positions
// currently held, weighted by market value, measured from Jan 1 (or the
// purchase date when the holding was bought during the year).
//
// Deliberately NOT a time-weighted or money-weighted return: there is no
// reliable deposit/withdrawal history yet. The interface is shaped so TWR/XIRR
// can be added later without changing callers.
// ─────────────────────────────────────────────────────────────────────────────

export type ReturnMethod = 'ytd-price-current-holdings' | 'twr' | 'mwr';

export interface PortfolioReturn {
  method: ReturnMethod;
  /** decimal, e.g. 0.124 = +12.4% */
  value: number | null;
  /** share of portfolio value with usable history, 0–1 */
  coverage: number;
  /** holdings excluded for lack of history */
  excluded: string[];
  periodStart: string;   // YYYY-MM-DD
}

export interface ReturnInput {
  ticker: string;
  marketValue: number;      // any consistent currency
  closes?: number[];        // daily closes, oldest → newest
  timestamps?: number[];    // unix seconds aligned with closes
  purchaseDate?: string | null;
}

function startOfYear(): Date {
  return new Date(new Date().getFullYear(), 0, 1);
}

/** Return at the index of the first close on/after `from`, through the latest. */
function returnFrom(closes: number[], timestamps: number[] | undefined, from: Date): number | null {
  if (closes.length < 2) return null;
  const fromSec = from.getTime() / 1000;
  let startIdx = -1;
  if (timestamps && timestamps.length === closes.length) {
    startIdx = timestamps.findIndex(t => t >= fromSec);
  } else {
    // No timestamps: approximate by trading days elapsed this year
    const days = Math.max(1, Math.round((Date.now() - from.getTime()) / 86400000));
    const bars = Math.min(closes.length - 1, Math.round(days * (252 / 365)));
    startIdx = closes.length - 1 - bars;
  }
  if (startIdx < 0 || startIdx >= closes.length - 1) return null;
  const start = closes[startIdx];
  const end = closes[closes.length - 1];
  if (!start || start <= 0) return null;
  return end / start - 1;
}

/**
 * Value-weighted YTD price return of the current holdings.
 * Holdings without usable history are excluded from both numerator and
 * denominator so partial coverage cannot distort the figure.
 */
export function computePortfolioYtd(inputs: ReturnInput[]): PortfolioReturn {
  const soy = startOfYear();
  const periodStart = soy.toISOString().split('T')[0];
  let weighted = 0, weight = 0, totalValue = 0;
  const excluded: string[] = [];

  for (const i of inputs) {
    totalValue += i.marketValue;
    if (!i.closes || i.closes.length < 5) { excluded.push(i.ticker); continue; }

    // Bought during the year → measure from the purchase date instead
    let from = soy;
    if (i.purchaseDate) {
      const pd = new Date(i.purchaseDate);
      if (!isNaN(pd.getTime()) && pd > soy) from = pd;
    }
    const r = returnFrom(i.closes, i.timestamps, from);
    if (r == null || !isFinite(r)) { excluded.push(i.ticker); continue; }

    weighted += r * i.marketValue;
    weight += i.marketValue;
  }

  return {
    method: 'ytd-price-current-holdings',
    value: weight > 0 ? weighted / weight : null,
    coverage: totalValue > 0 ? weight / totalValue : 0,
    excluded,
    periodStart,
  };
}
