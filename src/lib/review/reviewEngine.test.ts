import { describe, it, expect } from 'vitest';
import {
  computeCompanyQuality, computeEtfRole, computePositionFit, deriveStatus,
  buildAction, computePortfolioHealth, computeMarketAlignment, buildAlerts,
  isOverweightExposure, sectorLabelFor, isBroadEtf, isGrowthEtf, positionTypeFor,
} from './reviewEngine';
import type { CompanyQuality, PositionReview } from './reviewEngine';
import { computePortfolioYtd } from './portfolioReturn';
import { EXPOSURE_THRESHOLDS, DRAWDOWN_THRESHOLDS } from '../../config/reviewConfig';
import { GROWTH_ETF_LABEL, DIVERSIFIED_LABEL } from '../../config/portfolioConfig';
import type { FinnhubMetrics } from '../../types';

type Metric = FinnhubMetrics['metric'];

const excellent: Partial<Metric> = {
  revenueGrowth3Y: 16, epsGrowth3Y: 20, grossMarginTTM: 69,
  netProfitMarginTTM: 36, roeTTM: 33, debtEquityAnnual: 0.35, peBasicExclExtraTTM: 34,
};
const poor: Partial<Metric> = {
  revenueGrowth3Y: -8, epsGrowth3Y: -20, grossMarginTTM: 12,
  netProfitMarginTTM: -5, roeTTM: -3, debtEquityAnnual: 3.2, peBasicExclExtraTTM: -1,
};

function fitInput(over: Partial<Parameters<typeof computePositionFit>[0]> = {}) {
  return computePositionFit({
    companyQuality: 9.5, rsVsSector1M: 0.10, ret3M: 0.12,
    positionPct: 12, combinedExposurePct: 12, sectorPressure: -17,
    targetRemainingPct: 30, isEtf: false, isBroadEtf: false,
    ...over,
  });
}

function statusInput(over: Partial<Parameters<typeof deriveStatus>[0]> = {}) {
  const quality = computeCompanyQuality(excellent as Metric);
  return deriveStatus({
    fit: 7.8, quality, combinedExposurePct: 12, pnlPct: 20,
    rsVsSector1M: 0.10, isEtf: false, isBroadEtf: false, thesisBroken: false,
    ...over,
  });
}

// ── P1: Company Quality vs Position Fit ──────────────────────────────────────

describe('Company Quality', () => {
  it('scores a high-quality business highly and a weak one low', () => {
    expect(computeCompanyQuality(excellent as Metric).score).toBeGreaterThan(8);
    expect(computeCompanyQuality(poor as Metric).score).toBeLessThan(4.5);
  });

  it('is identical regardless of which account holds it', () => {
    const a = computeCompanyQuality(excellent as Metric);
    const b = computeCompanyQuality(excellent as Metric);
    expect(a.score).toBe(b.score);
  });

  it('is NOT reduced by price performance — no price input exists', () => {
    const q = computeCompanyQuality(excellent as Metric);
    // Same metrics, wildly different P&L → same quality
    const downBig = deriveStatus({ fit: 5, quality: q, combinedExposurePct: 5, pnlPct: -45, rsVsSector1M: -0.2, isEtf: false, isBroadEtf: false, thesisBroken: false });
    const upBig   = deriveStatus({ fit: 5, quality: q, combinedExposurePct: 5, pnlPct: 45, rsVsSector1M: 0.2, isEtf: false, isBroadEtf: false, thesisBroken: false });
    expect(q.score).toBeGreaterThan(8);
    expect(downBig.status).not.toBe(upBig.status);   // status differs
  });

  it('renormalizes when fundamentals are missing rather than scoring zero', () => {
    const partial = computeCompanyQuality({ roeTTM: 30, grossMarginTTM: 65 } as Metric);
    expect(partial.score).toBeGreaterThan(6);
    expect(partial.coverage).toBeLessThan(1);
    expect(partial.coverage).toBeGreaterThan(0);
  });

  it('returns a neutral score with no data at all', () => {
    const none = computeCompanyQuality(null);
    expect(none.coverage).toBe(0);
    expect(none.score).toBeGreaterThan(3);
    expect(none.score).toBeLessThan(7);
  });
});

describe('Position Fit', () => {
  it('differs between two accounts holding the same company', () => {
    const lira = fitInput({ positionPct: 12.9, targetRemainingPct: 34 });
    const tfsa = fitInput({ positionPct: 13.5, targetRemainingPct: -5 });
    expect(lira.score).not.toBeCloseTo(tfsa.score, 5);
  });

  it('falls as combined exposure rises, holding everything else equal', () => {
    const normal = fitInput({ combinedExposurePct: 8 });
    const heavy  = fitInput({ combinedExposurePct: 26.5 });
    expect(heavy.score).toBeLessThan(normal.score);
  });

  it('does not penalize size for a broad-market ETF', () => {
    const broad = fitInput({ isEtf: true, isBroadEtf: true, positionPct: 32, combinedExposurePct: 32, companyQuality: 9 });
    const stock = fitInput({ positionPct: 32, combinedExposurePct: 32 });
    expect(broad.score).toBeGreaterThan(stock.score);
  });

  it('rewards strong relative strength', () => {
    expect(fitInput({ rsVsSector1M: 0.24 }).score)
      .toBeGreaterThan(fitInput({ rsVsSector1M: -0.10 }).score);
  });

  it('stays within 0–10 at extremes', () => {
    const hi = fitInput({ companyQuality: 10, rsVsSector1M: 2, ret3M: 3, positionPct: 1, combinedExposurePct: 1, sectorPressure: 100, targetRemainingPct: 300 });
    const lo = fitInput({ companyQuality: 0, rsVsSector1M: -0.9, ret3M: -0.9, positionPct: 90, combinedExposurePct: 90, sectorPressure: -100, targetRemainingPct: -90 });
    expect(hi.score).toBeLessThanOrEqual(10);
    expect(lo.score).toBeGreaterThanOrEqual(0);
    expect(hi.score).toBeGreaterThan(lo.score);
  });
});

// ── P2: exposure drives the action language ──────────────────────────────────

describe('OVERWEIGHT and suggested action', () => {
  it('flags OVERWEIGHT above the configured threshold', () => {
    expect(statusInput({ combinedExposurePct: 26.5 }).flags).toContain('OVERWEIGHT');
    expect(statusInput({ combinedExposurePct: 8 }).flags).not.toContain('OVERWEIGHT');
  });

  it('keeps STRONG HOLD while flagging OVERWEIGHT — not a downgrade', () => {
    const s = statusInput({ combinedExposurePct: 26.5, fit: 7.8 });
    expect(s.status).toBe('STRONG HOLD');
    expect(s.flags).toContain('OVERWEIGHT');
  });

  it('never suggests increasing allocation when overweight', () => {
    const quality = computeCompanyQuality(excellent as Metric);
    const action = buildAction({
      status: 'STRONG HOLD', flags: ['OVERWEIGHT'], companyName: 'Microsoft',
      quality, combinedExposurePct: 26.5, siblingCount: 2, pnlPct: 20,
      rsVsSector1M: 0.239, sectorLabel: 'Technology', sectorPressure: -17,
      isBroadEtf: false, isGrowthEtf: false,
    });
    expect(action).toMatch(/avoid adding/i);
    expect(action).toContain('26.5%');
    expect(action).not.toMatch(/increase allocation/i);
    expect(action).not.toMatch(/consider adding/i);
  });

  it('does allow adding language when exposure is normal', () => {
    const quality = computeCompanyQuality(excellent as Metric);
    const action = buildAction({
      status: 'STRONG HOLD', flags: [], companyName: 'Microsoft',
      quality, combinedExposurePct: 6, siblingCount: 1, pnlPct: 20,
      rsVsSector1M: 0.1, sectorLabel: 'Technology', sectorPressure: 10,
      isBroadEtf: false, isGrowthEtf: false,
    });
    expect(action).toMatch(/room to add/i);
  });

  it('requires poor fit as well as overweight before suggesting TRIM', () => {
    expect(statusInput({ combinedExposurePct: 26.5, fit: 7.8 }).status).toBe('STRONG HOLD');
    expect(statusInput({ combinedExposurePct: 26.5, fit: 4.6, pnlPct: 5 }).status).toBe('TRIM');
  });
});

// ── P3: losses never auto-EXIT ───────────────────────────────────────────────

describe('EXIT requires explicit evidence', () => {
  it.each([-10, -20, -45, -70])('a %i%% drawdown alone does not produce EXIT', (pnl) => {
    const s = statusInput({ pnlPct: pnl, fit: 4 });
    expect(s.status).not.toBe('EXIT');
  });

  it('routes a severe drawdown to REVIEW', () => {
    expect(statusInput({ pnlPct: -45, fit: 4 }).status).toBe('REVIEW');
    expect(statusInput({ pnlPct: DRAWDOWN_THRESHOLDS.review - 1, fit: 6 }).status).toBe('REVIEW');
  });

  it('produces EXIT only when the thesis is explicitly marked broken', () => {
    expect(statusInput({ thesisBroken: true, pnlPct: 50, fit: 9 }).status).toBe('EXIT');
  });

  it('EXIT language references the manual marker, not the price', () => {
    const quality = computeCompanyQuality(excellent as Metric);
    const a = buildAction({
      status: 'EXIT', flags: [], companyName: 'X', quality, combinedExposurePct: 5,
      siblingCount: 1, pnlPct: -60, rsVsSector1M: -0.3, sectorLabel: 'Technology',
      sectorPressure: -40, isBroadEtf: false, isGrowthEtf: false,
    });
    expect(a).toMatch(/marked this thesis as broken/i);
  });

  it('REVIEW language explicitly avoids claiming the thesis is broken', () => {
    const quality = computeCompanyQuality(poor as Metric);
    const a = buildAction({
      status: 'REVIEW', flags: [], companyName: 'X', quality, combinedExposurePct: 5,
      siblingCount: 1, pnlPct: -44, rsVsSector1M: -0.12, sectorLabel: 'Technology',
      sectorPressure: -30, isBroadEtf: false, isGrowthEtf: false,
    });
    expect(a).toMatch(/not evidence the thesis is broken/i);
  });
});

// ── P4: benchmark period ─────────────────────────────────────────────────────

describe('portfolio YTD return', () => {
  const yearBars = 260;
  const rising = Array.from({ length: yearBars }, (_, i) => 100 * (1 + i * 0.0008));
  const stamps = Array.from({ length: yearBars }, (_, i) =>
    Math.floor((Date.now() - (yearBars - 1 - i) * 86400000) / 1000));

  it('measures from January 1, not from inception', () => {
    const r = computePortfolioYtd([{ ticker: 'A', marketValue: 100, closes: rising, timestamps: stamps }]);
    expect(r.value).not.toBeNull();
    expect(r.periodStart.endsWith('-01-01')).toBe(true);
    // YTD must be smaller than the full-series return
    const full = rising[rising.length - 1] / rising[0] - 1;
    expect(r.value!).toBeLessThan(full);
  });

  it('weights by market value', () => {
    const flat = Array.from({ length: yearBars }, () => 100);
    const r = computePortfolioYtd([
      { ticker: 'UP', marketValue: 900, closes: rising, timestamps: stamps },
      { ticker: 'FLAT', marketValue: 100, closes: flat, timestamps: stamps },
    ]);
    const solo = computePortfolioYtd([{ ticker: 'UP', marketValue: 900, closes: rising, timestamps: stamps }]);
    expect(r.value!).toBeLessThan(solo.value!);
    expect(r.value!).toBeGreaterThan(0);
  });

  it('excludes holdings without history and reports coverage', () => {
    const r = computePortfolioYtd([
      { ticker: 'A', marketValue: 50, closes: rising, timestamps: stamps },
      { ticker: 'B', marketValue: 50 },
    ]);
    expect(r.excluded).toContain('B');
    expect(r.coverage).toBeCloseTo(0.5, 2);
  });

  it('returns null with no usable history at all', () => {
    const r = computePortfolioYtd([{ ticker: 'A', marketValue: 100 }]);
    expect(r.value).toBeNull();
    expect(r.coverage).toBe(0);
  });
});

// ── P5/P6: shared sector mapping and ETF logic ───────────────────────────────

describe('sector mapping and ETF classification', () => {
  it('uses the shared registry for funds and detection for stocks', () => {
    expect(sectorLabelFor('XEQT.TO', null).label).toBe(DIVERSIFIED_LABEL);
    expect(sectorLabelFor('QQC.TO', null).label).toBe(GROWTH_ETF_LABEL);
    expect(sectorLabelFor('TSLA', 'XLY').label).toBe('Consumer Discretionary');
    expect(sectorLabelFor('NFLX', 'XLC').label).toBe('Communication Services');
    expect(sectorLabelFor('MSFT', 'XLK').label).toBe('Technology');
  });

  it('distinguishes broad from growth funds', () => {
    expect(isBroadEtf('XEQT.TO')).toBe(true);
    expect(isGrowthEtf('XEQT.TO')).toBe(false);
    expect(isGrowthEtf('QQC.TO')).toBe(true);
    expect(isBroadEtf('QQC.TO')).toBe(false);
    expect(positionTypeFor('MSFT')).toBe('Individual Stock');
  });

  it('scores a broad ETF on role, never on company fundamentals', () => {
    const q = computeEtfRole('XEQT.TO', 0);
    expect(q.kind).toBe('etf');
    expect(q.score).toBeGreaterThan(8);
    const labels = q.components.map(c => c.label.toLowerCase()).join(' ');
    expect(labels).not.toMatch(/revenue|eps|gross margin|return on equity/);
  });

  it('does not describe a Nasdaq fund as broadly diversified', () => {
    const q = computeEtfRole('QQC.TO', 40);
    expect(q.score).toBeLessThan(computeEtfRole('XEQT.TO', 0).score);
    const text = [...q.pros, ...q.cons].join(' ').toLowerCase();
    expect(text).toMatch(/concentrated in large-cap growth/);
    expect(text).not.toMatch(/hundreds of stocks/);
    expect(text).toMatch(/overlap/);
  });

  it('a broad ETF gets CORE status regardless of size', () => {
    const q = computeEtfRole('XEQT.TO', 0);
    const s = deriveStatus({ fit: 6, quality: q, combinedExposurePct: 32, pnlPct: 1, rsVsSector1M: null, isEtf: true, isBroadEtf: true, thesisBroken: false });
    expect(s.status).toBe('CORE');
    expect(s.flags).not.toContain('OVERWEIGHT');
  });
});

// ── P7: explainable health ───────────────────────────────────────────────────

describe('portfolio health', () => {
  function review(over: Partial<PositionReview> = {}): PositionReview {
    return {
      holding: {} as never, ticker: 'MSFT', base: 'MSFT', companyName: 'Microsoft',
      account: 'LIRA', currency: 'USD', positionType: 'Individual Stock', isEtf: false,
      companyQuality: computeCompanyQuality(excellent as Metric),
      combinedExposurePct: 12, siblingCount: 1,
      positionPct: 12, positionFit: 7.5, fitComponents: [],
      status: 'STRONG HOLD', flags: [], pros: [], cons: [], action: '',
      sectorEtf: 'XLK', sectorLabel: 'Technology', sector: null,
      rsVsSector1M: 0.1, ret1M: 0.05, ret3M: 0.1,
      currentPrice: 100, pnlPct: 20,
      marketValueNative: over.marketValueNative ?? 1000,
      marketValueCAD: over.marketValueCAD ?? over.marketValueNative ?? 1000,
      targetRemainingPct: 30,
      ...over,
    };
  }

  /** Portfolio resembling the reported one: quality ~8, fit ~7, 32% XEQT, MSFT 26.5%. */
  function realisticInput(over: Partial<Parameters<typeof computePortfolioHealth>[0]> = {}) {
    const etfQuality = computeEtfRole('XEQT.TO', 0);
    const reviews = [
      review({ ticker: 'XEQT.TO', base: 'XEQT', companyQuality: etfQuality, positionFit: 8.5, marketValueNative: 3200, positionPct: 32, status: 'CORE', isEtf: true }),
      review({ ticker: 'MSFT', base: 'MSFT', positionFit: 7.2, marketValueNative: 1300, positionPct: 13 }),
      review({ ticker: 'MSFT.TO', base: 'MSFT', positionFit: 6.9, marketValueNative: 1350, positionPct: 13.5 }),
      review({ ticker: 'QQC.TO', base: 'QQC', companyQuality: computeEtfRole('QQC.TO', 36), positionFit: 6.5, marketValueNative: 1040, positionPct: 10.4, isEtf: true }),
      review({ ticker: 'META', base: 'META', positionFit: 7.4, marketValueNative: 900, positionPct: 9 }),
      review({ ticker: 'ORCL', base: 'ORCL', positionFit: 4.2, marketValueNative: 430, positionPct: 4.3, status: 'REVIEW', pnlPct: -30 }),
      review({ ticker: 'TSLA', base: 'TSLA', positionFit: 4.0, marketValueNative: 380, positionPct: 3.8, status: 'REVIEW', pnlPct: -44 }),
      review({ ticker: 'NFLX', base: 'NFLX', positionFit: 6.8, marketValueNative: 700, positionPct: 7 }),
      review({ ticker: 'ANET', base: 'ANET', positionFit: 7.0, marketValueNative: 700, positionPct: 7 }),
    ];
    const combinedExposure = new Map<string, number>([
      ['XEQT', 32], ['MSFT', 26.5], ['QQC', 10.4], ['META', 9], ['ORCL', 4.3], ['TSLA', 3.8], ['NFLX', 7], ['ANET', 7],
    ]);
    const representativeTicker = new Map<string, string>([
      ['XEQT', 'XEQT.TO'], ['MSFT', 'MSFT'], ['QQC', 'QQC.TO'], ['META', 'META'],
      ['ORCL', 'ORCL'], ['TSLA', 'TSLA'], ['NFLX', 'NFLX'], ['ANET', 'ANET'],
    ]);
    const sectorTotals = new Map<string, number>([
      ['Technology', 33.5], ['Communication Services', 16], ['Consumer Discretionary', 3.8], ['Industrials', 4.3],
    ]);
    return {
      reviews, combinedExposure, representativeTicker, sectorTotals,
      broadEtfPct: 32, growthEtfPct: 10.4,
      avgRs: 0.08, avgSectorPressure: -14,
      ...over,
    };
  }

  it('exposes every weighted component in the specified order', () => {
    const h = computePortfolioHealth(realisticInput())!;
    expect(h.components.map(c => c.key)).toEqual([
      'assetQuality', 'positionFit', 'diversification',
      'concentration', 'trendStrength', 'sectorAlignment',
    ]);
    for (const c of h.components) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(10);
      expect(c.detail.length).toBeGreaterThan(0);
    }
    // structural factors dominate; tactical is only 10%
    const tactical = h.components.filter(c => c.key === 'trendStrength' || c.key === 'sectorAlignment')
      .reduce((s, c) => s + c.weight, 0);
    expect(tactical).toBe(10);
  });

  it('equals the weighted mean of its components, rounded to 1dp', () => {
    const h = computePortfolioHealth(realisticInput())!;
    const totalW = h.components.reduce((s, c) => s + c.weight, 0);
    const raw = h.components.reduce((s, c) => s + c.score * c.weight, 0) / totalW;
    expect(h.score).toBe(Math.round(raw * 10) / 10);
  });

  it('rates a structurally sound portfolio well above WEAK', () => {
    const h = computePortfolioHealth(realisticInput())!;
    // quality ~8, fit ~7, 32% broad core, one real concentration issue
    expect(h.score).toBeGreaterThan(6.0);
    expect(['EXCELLENT', 'HEALTHY', 'MIXED']).toContain(h.label);
  });

  it('does NOT treat a 32% broad-market ETF as concentration', () => {
    const withEtf = computePortfolioHealth(realisticInput())!;
    // Same weight moved into a single stock instead
    const asStock = computePortfolioHealth(realisticInput({
      combinedExposure: new Map([...realisticInput().combinedExposure].map(([k, v]) => k === 'XEQT' ? ['BIGCO', v] : [k, v])),
      representativeTicker: new Map([...realisticInput().representativeTicker].map(([k, v]) => k === 'XEQT' ? ['BIGCO', 'BIGCO'] : [k, v])),
      broadEtfPct: 0,
    }))!;
    const cWith = withEtf.components.find(c => c.key === 'concentration')!.score;
    const cAs = asStock.components.find(c => c.key === 'concentration')!.score;
    expect(cWith).toBeGreaterThan(cAs);
    expect(withEtf.score).toBeGreaterThan(asStock.score);
  });

  it('still penalizes a genuine single-company overweight', () => {
    const normal = computePortfolioHealth(realisticInput({
      combinedExposure: new Map([['XEQT', 32], ['MSFT', 8], ['META', 9]]),
      representativeTicker: new Map([['XEQT', 'XEQT.TO'], ['MSFT', 'MSFT'], ['META', 'META']]),
    }))!;
    const heavy = computePortfolioHealth(realisticInput())!;
    const cn = normal.components.find(c => c.key === 'concentration')!.score;
    const ch = heavy.components.find(c => c.key === 'concentration')!.score;
    expect(cn).toBeGreaterThan(ch);
    expect(heavy.risks.some(r => r.includes('MSFT') && r.includes('26.5'))).toBe(true);
  });

  it('lets a rotation downturn move Health only slightly', () => {
    const good = computePortfolioHealth(realisticInput({ avgSectorPressure: 40, avgRs: 0.15 }))!;
    const bad  = computePortfolioHealth(realisticInput({ avgSectorPressure: -60, avgRs: -0.15 }))!;
    expect(good.score - bad.score).toBeLessThan(1.2);   // 10% combined weight
  });

  it('weights review holdings by value, not by count', () => {
    const smallReview = computePortfolioHealth(realisticInput())!;
    // Same two REVIEW holdings, but now a third of the portfolio
    const bigReview = computePortfolioHealth(realisticInput({
      reviews: realisticInput().reviews.map(r =>
        r.status === 'REVIEW'
          ? { ...r, marketValueNative: 3000, marketValueCAD: 3000, positionPct: 30 }
          : r),
    }))!;
    expect(bigReview.components.find(c => c.key === 'positionFit')!.score)
      .toBeLessThan(smallReview.components.find(c => c.key === 'positionFit')!.score);
  });

  it('surfaces explicit risks and positives', () => {
    const h = computePortfolioHealth(realisticInput())!;
    expect(h.positives.some(p => /broad diversified core/i.test(p))).toBe(true);
    expect(h.risks.length).toBeGreaterThan(0);
  });

  it('returns null for an empty portfolio', () => {
    expect(computePortfolioHealth({
      reviews: [], combinedExposure: new Map(), representativeTicker: new Map(),
      sectorTotals: new Map(), broadEtfPct: 0, growthEtfPct: 0,
      avgRs: null, avgSectorPressure: null,
    })).toBeNull();
  });

  it('weights by CAD value so USD and CAD holdings are comparable', () => {
    // Two holdings with equal NATIVE value but different currencies: the USD
    // one is worth ~1.4x in CAD and must dominate the weighted quality.
    const hiQ = { score: 9, isEtf: false, kind: 'company' as const, components: [], pros: [], cons: [], coverage: 1 };
    const loQ = { score: 3, isEtf: false, kind: 'company' as const, components: [], pros: [], cons: [], coverage: 1 };
    const reviews = [
      review({ ticker: 'USDCO', base: 'USDCO', companyQuality: hiQ, marketValueNative: 1000, marketValueCAD: 1400 }),
      review({ ticker: 'CADCO', base: 'CADCO', companyQuality: loQ, marketValueNative: 1000, marketValueCAD: 1000 }),
    ];
    const h = computePortfolioHealth({
      reviews,
      combinedExposure: new Map([['USDCO', 58], ['CADCO', 42]]),
      representativeTicker: new Map([['USDCO', 'USDCO'], ['CADCO', 'CADCO']]),
      sectorTotals: new Map([['Technology', 100]]),
      broadEtfPct: 0, growthEtfPct: 0, avgRs: null, avgSectorPressure: null,
    })!;
    const aq = h.components.find(c => c.key === 'assetQuality')!.score;
    // CAD-weighted: (9*1400 + 3*1000)/2400 = 6.5 — native weighting would give 6.0
    expect(aq).toBeCloseTo(6.5, 2);
  });

  it('counts the largest holding once — not in breadth or sector terms too', () => {
    const h = computePortfolioHealth(realisticInput())!;
    const next2 = h.penalties.find(p => p.factor === 'Next two companies')!;
    const sector = h.penalties.find(p => p.factor === 'Sector beyond top name')!;
    // MSFT 26.5% must not appear in either basis
    expect(next2.basis).toContain('largest excluded');
    expect(parseFloat(sector.basis.match(/([\d.]+)%/)![1])).toBeLessThan(33.5);
    expect(h.penalties.reduce((s, p) => s + p.weight, 0)).toBe(100);
  });

  it('rounds to one decimal and derives the label from the same value', () => {
    const h = computePortfolioHealth(realisticInput())!;
    expect(h.score).toBeCloseTo(Math.round(h.score * 10) / 10, 10);
    const expectedLabel =
      h.score >= 8.5 ? 'EXCELLENT' : h.score >= 7.0 ? 'HEALTHY'
      : h.score >= 5.5 ? 'MIXED' : h.score >= 4.0 ? 'WEAK' : 'POOR';
    expect(h.label).toBe(expectedLabel);
  });
});

describe('Market Alignment', () => {
  it('is separate from Health and reflects tactical conditions', () => {
    const weak = computeMarketAlignment({ avgSectorPressure: -50, avgRs: -0.12, avgTrend3M: -0.2, regime: 'Risk-Off', sectorNotes: [] })!;
    const strong = computeMarketAlignment({ avgSectorPressure: 45, avgRs: 0.15, avgTrend3M: 0.3, regime: 'Risk-On', sectorNotes: [] })!;
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(weak.label).toMatch(/HEADWIND|NEGATIVE/);
    expect(strong.label).toMatch(/TAILWIND|POSITIVE/);
  });

  it('weights sector rotation most heavily', () => {
    const c = computeMarketAlignment({ avgSectorPressure: 0, avgRs: 0, avgTrend3M: 0, regime: 'Mixed', sectorNotes: [] })!;
    const rotation = c.components.find(x => x.label === 'Sector rotation')!;
    expect(rotation.weight).toBe(40);
    expect(c.components.reduce((s, x) => s + x.weight, 0)).toBe(100);
  });

  it('returns null when no tactical data exists', () => {
    expect(computeMarketAlignment({ avgSectorPressure: null, avgRs: null, avgTrend3M: null, regime: null, sectorNotes: [] })).toBeNull();
  });
});

describe('overweight classification by asset type', () => {
  it('does not flag a broad core ETF at 32%', () => {
    expect(isOverweightExposure('XEQT.TO', 32)).toBe(false);
    expect(isOverweightExposure('XEQT.TO', 85)).toBe(true);
  });

  it('flags a single company at 26.5%', () => {
    expect(isOverweightExposure('MSFT', 26.5)).toBe(true);
    expect(isOverweightExposure('MSFT', 12)).toBe(false);
  });

  it('applies moderate rules to a growth ETF', () => {
    expect(isOverweightExposure('QQC.TO', 10.4)).toBe(false);
    expect(isOverweightExposure('QQC.TO', 45)).toBe(true);
  });
});

// ── P8: alerts ───────────────────────────────────────────────────────────────

describe('alerts', () => {
  function r(status: PositionReview['status'], ticker: string): PositionReview {
    return { status, ticker, marketValueNative: 100 } as PositionReview;
  }

  it('reports review severity instead of claiming EXIT', () => {
    const alerts = buildAlerts(
      [r('REVIEW', 'A'), r('REVIEW', 'B'), r('WATCH', 'C'), r('TRIM', 'D')],
      new Map(),
    );
    expect(alerts.some(a => /require high-priority review/.test(a))).toBe(true);
    expect(alerts.join(' ')).not.toMatch(/flagged for EXIT/);
  });

  it('names overweight underlying companies', () => {
    const alerts = buildAlerts([r('STRONG HOLD', 'MSFT')], new Map([['MSFT', 26.5]]),
      new Map([['MSFT', 'MSFT']]));
    expect(alerts.some(a => a.includes('MSFT') && a.includes('26.5') && /OVERWEIGHT/.test(a))).toBe(true);
  });

  it('does NOT flag a broad-market ETF at 32% as overweight', () => {
    const alerts = buildAlerts([r('CORE', 'XEQT.TO')], new Map([['XEQT', 32]]),
      new Map([['XEQT', 'XEQT.TO']]));
    expect(alerts.join(' ')).not.toMatch(/XEQT/);
  });

  it('reports the value share of holdings needing review', () => {
    const reviews = [
      { status: 'REVIEW', ticker: 'A', marketValueNative: 430, marketValueCAD: 430 },
      { status: 'STRONG HOLD', ticker: 'B', marketValueNative: 9570, marketValueCAD: 9570 },
    ] as PositionReview[];
    const alerts = buildAlerts(reviews, new Map());
    expect(alerts.some(a => /4\.3% of value/.test(a))).toBe(true);
  });

  it('flags elevated growth-ETF overlap', () => {
    const alerts = buildAlerts([r('HOLD', 'QQC.TO')], new Map(), new Map(), 30);
    expect(alerts.some(a => /Growth \/ Nasdaq ETF overlap/.test(a))).toBe(true);
  });

  it('stays quiet for a clean portfolio', () => {
    expect(buildAlerts([r('STRONG HOLD', 'A'), r('HOLD', 'B')], new Map([['A', 8]]),
      new Map([['A', 'A']]))).toEqual([]);
  });
});

// ── the worked Microsoft example from the spec ───────────────────────────────

describe('Microsoft two-account scenario', () => {
  const quality = computeCompanyQuality(excellent as Metric);
  const combined = 26.5;

  const lira = computePositionFit({
    companyQuality: quality.score, rsVsSector1M: 0.239, ret3M: 0.15,
    positionPct: 12.9, combinedExposurePct: combined, sectorPressure: -17,
    targetRemainingPct: 34, isEtf: false, isBroadEtf: false,
  });
  const tfsa = computePositionFit({
    companyQuality: quality.score, rsVsSector1M: 0.239, ret3M: 0.15,
    positionPct: 13.5, combinedExposurePct: combined, sectorPressure: -17,
    targetRemainingPct: 8, isEtf: false, isBroadEtf: false,
  });

  it('shares one Company Quality score across both accounts', () => {
    // High-quality compounder, but a 34x P/E is a genuine premium — the model
    // does not inflate the score to a perfect 10 for that reason.
    expect(quality.score).toBeGreaterThan(8);
    expect(computeCompanyQuality(excellent as Metric).score).toBe(quality.score);
  });

  it('produces different Position Fit scores per account', () => {
    expect(lira.score).not.toBeCloseTo(tfsa.score, 3);
  });

  it('marks both OVERWEIGHT without downgrading the rating', () => {
    for (const fit of [lira.score, tfsa.score]) {
      const s = deriveStatus({
        fit, quality, combinedExposurePct: combined, pnlPct: 20,
        rsVsSector1M: 0.239, isEtf: false, isBroadEtf: false, thesisBroken: false,
      });
      expect(s.flags).toContain('OVERWEIGHT');
      expect(['STRONG HOLD', 'HOLD']).toContain(s.status);
    }
  });

  it('uses the configured overweight threshold', () => {
    expect(combined).toBeGreaterThanOrEqual(EXPOSURE_THRESHOLDS.overweight);
  });
});
