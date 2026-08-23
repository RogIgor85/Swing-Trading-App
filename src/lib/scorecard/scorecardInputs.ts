// ─────────────────────────────────────────────────────────────────────────────
// Scorecard — input adapter.
//
// Maps raw Finnhub / Yahoo payloads onto the four dimension input sets. This is
// the ONLY place that knows about vendor field names and units; the score engine
// itself never sees an API response.
//
// Anything genuinely unavailable is passed through as null so the engine can
// exclude it and renormalise. Nothing is ever defaulted to a neutral value.
// ─────────────────────────────────────────────────────────────────────────────

import type { QualityInputs, ValuationInputs, TechnicalInputs, AlignmentInputs } from './scoreEngine';
import { SECTOR_ETFS } from '../../config/sectorConfig';
import { fetchAllHistories, fetchConstituentQuotes, fetchConstituentHistories } from '../sector/sectorData';
import { computeSectorMetrics } from '../sector/sectorEngine';

/** Coerce Yahoo's `{ raw, fmt }` objects and bare numbers to a finite number. */
export function yNum(v: any): number | null {
  if (v == null) return null;
  const n = typeof v === 'object' ? v.raw : v;
  return typeof n === 'number' && isFinite(n) ? n : null;
}

const asPct = (v: number | null) => v == null ? null : v * 100;

export function buildQualityInputs(yahoo: any, metrics: any): QualityInputs {
  const fd = yahoo?.financialData;
  const m  = metrics?.metric;

  const revenue = yNum(fd?.totalRevenue);
  const grossProfits = yNum(fd?.grossProfits);
  // Prefer the derived margin; fall back to Finnhub's TTM figure (already a %)
  const grossMargin = yNum(fd?.grossMargins) != null ? asPct(yNum(fd?.grossMargins))
    : grossProfits != null && revenue ? (grossProfits / revenue) * 100
    : m?.grossMarginTTM ?? null;

  return {
    netMargin:       asPct(yNum(fd?.profitMargins))    ?? m?.netProfitMarginTTM   ?? null,
    operatingMargin: asPct(yNum(fd?.operatingMargins)) ?? m?.operatingMarginTTM   ?? null,
    grossMargin,
    roe:             asPct(yNum(fd?.returnOnEquity))   ?? m?.roeTTM               ?? null,
    roic:            m?.roiTTM ?? null,
    fcf:             yNum(fd?.freeCashflow),
    revenue,
    // Yahoo reports debtToEquity as value × 100 (150 = 1.5x)
    debtToEquity:    yNum(fd?.debtToEquity) != null ? yNum(fd?.debtToEquity)! / 100
                     : m?.['totalDebt/totalEquityQuarterly'] ?? null,
    currentRatio:    yNum(fd?.currentRatio) ?? m?.currentRatioQuarterly ?? null,
    revenueGrowth:   asPct(yNum(fd?.revenueGrowth))    ?? m?.revenueGrowth3Y      ?? null,
    epsGrowth:       asPct(yNum(fd?.earningsGrowth))   ?? m?.epsGrowth3Y          ?? null,
  };
}

export function buildValuationInputs(yahoo: any, metrics: any): ValuationInputs {
  const sd = yahoo?.summaryDetail;
  const ks = yahoo?.defaultKeyStatistics;
  const fd = yahoo?.financialData;
  const m  = metrics?.metric;

  return {
    forwardPE:   yNum(sd?.forwardPE)  ?? yNum(ks?.forwardPE) ?? null,
    trailingPE:  yNum(sd?.trailingPE) ?? m?.peTTM ?? null,
    peg:         yNum(ks?.pegRatio)   ?? m?.pegRatio ?? null,
    fcf:         yNum(fd?.freeCashflow),
    marketCap:   yNum(sd?.marketCap)  ?? yNum(yahoo?.price?.marketCap) ?? null,
    priceToBook: yNum(ks?.priceToBook) ?? m?.pbQuarterly ?? null,
  };
}

export function buildTechnicalInputs(quote: any, yahoo: any, metrics: any): TechnicalInputs {
  const sd = yahoo?.summaryDetail;
  const m  = metrics?.metric;
  const price = quote?.c ?? yNum(yahoo?.price?.regularMarketPrice) ?? null;

  return {
    price,
    ma50:      yNum(sd?.fiftyDayAverage) ?? null,
    ma200:     yNum(sd?.twoHundredDayAverage) ?? null,
    low52:     m?.['52WeekLow']  ?? yNum(sd?.fiftyTwoWeekLow)  ?? null,
    high52:    m?.['52WeekHigh'] ?? yNum(sd?.fiftyTwoWeekHigh) ?? null,
    volume:    yNum(sd?.volume) ?? yNum(yahoo?.price?.regularMarketVolume) ?? null,
    avgVolume: yNum(sd?.averageVolume) ?? null,
    // Finnhub reports these as percentages
    ret1M:     m?.['monthToDatePriceReturnDaily'] != null ? m['monthToDatePriceReturnDaily'] / 100
               : m?.['1MonthPriceReturnDaily'] != null ? m['1MonthPriceReturnDaily'] / 100 : null,
  };
}

export function buildAlignmentInputs(
  metrics: any,
  sentiment: any,
  sectorPressure: number | null,
  sectorRet1M: number | null,
): AlignmentInputs {
  const m = metrics?.metric;
  const ret1M = m?.['1MonthPriceReturnDaily'] != null ? m['1MonthPriceReturnDaily'] / 100 : null;
  const ret3M = m?.['3MonthPriceReturnDaily'] != null ? m['3MonthPriceReturnDaily'] / 100 : null;

  // Relative strength: the stock's 1-month return minus its sector's. Only
  // meaningful when both legs exist — otherwise it is genuinely unknown.
  const rsVsSector1M = ret1M != null && sectorRet1M != null ? ret1M - sectorRet1M : null;

  const bullish = sentiment?.sentiment?.bullishPercent;
  return {
    sectorPressure,
    rsVsSector1M,
    ret3M,
    bullishPercent: typeof bullish === 'number' && isFinite(bullish) ? bullish : null,
  };
}

// ── Sector rotation lookup ───────────────────────────────────────────────────

const CONSTITUENT_INDEX: Record<string, string> = (() => {
  const idx: Record<string, string> = {};
  for (const s of SECTOR_ETFS) for (const c of s.constituents) idx[c.toUpperCase()] = s.etf;
  return idx;
})();

export interface SectorContext {
  etf: string;
  name: string;
  pressure: number;
  classification: string;
  ret1M: number | null;
}

/**
 * Resolve one ticker's sector and pull that sector's live rotation metrics from
 * the existing Sector Rotation engine. Rotation math is never recomputed here.
 * Returns null when the ticker cannot be mapped — the caller must then treat
 * Market Alignment's rotation component as unavailable, not neutral.
 */
export async function fetchSectorContext(ticker: string, industry?: string | null): Promise<SectorContext | null> {
  const etf = CONSTITUENT_INDEX[ticker.toUpperCase()] ?? industryToEtf(industry);
  if (!etf) return null;

  const [hist, cq, ch] = await Promise.all([
    fetchAllHistories(), fetchConstituentQuotes(), fetchConstituentHistories(),
  ]);
  const metrics = computeSectorMetrics(hist, cq, ch);
  const match = metrics.find(m => m.etf === etf);
  if (!match) return null;

  return {
    etf: match.etf,
    name: match.name,
    pressure: match.pressure,
    classification: match.classification,
    ret1M: match.ret['1M'] ?? null,
  };
}

function industryToEtf(industry?: string | null): string | null {
  if (!industry) return null;
  const key = industry.trim().toLowerCase();
  const table: Array<[string, string]> = [
    ['technology', 'XLK'], ['semiconductor', 'XLK'], ['software', 'XLK'], ['hardware', 'XLK'],
    ['bank', 'XLF'], ['financial', 'XLF'], ['insurance', 'XLF'],
    ['health', 'XLV'], ['pharmac', 'XLV'], ['biotech', 'XLV'],
    ['industrial', 'XLI'], ['aerospace', 'XLI'], ['machinery', 'XLI'], ['transport', 'XLI'],
    ['retail', 'XLY'], ['automobil', 'XLY'], ['leisure', 'XLY'], ['apparel', 'XLY'],
    ['consumer product', 'XLP'], ['food', 'XLP'], ['beverage', 'XLP'], ['tobacco', 'XLP'],
    ['energy', 'XLE'], ['oil', 'XLE'],
    ['utilit', 'XLU'], ['chemical', 'XLB'], ['metal', 'XLB'], ['mining', 'XLB'], ['building', 'XLB'],
    ['real estate', 'XLRE'],
    ['communicat', 'XLC'], ['media', 'XLC'], ['telecom', 'XLC'],
  ];
  for (const [needle, etf] of table) if (key.includes(needle)) return etf;
  return null;
}
