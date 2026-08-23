import { describe, it, expect } from 'vitest';
import {
  scoreCompanyQuality, scoreValuation, scoreTechnical, scoreMarketAlignment,
  scoreHorizons, explainBestFit, scoreLevers, runScorecard,
} from './scoreEngine';
import type { QualityInputs, ValuationInputs, TechnicalInputs, AlignmentInputs } from './scoreEngine';
import { SWING_WEIGHTS, LONG_TERM_WEIGHTS } from '../../config/scorecardConfig';

// A high-quality business: strong margins, cash generation, low leverage
const excellentBusiness: QualityInputs = {
  netMargin: 24, operatingMargin: 31, grossMargin: 46, roe: 150, roic: 55,
  fcf: 100e9, revenue: 400e9, debtToEquity: 1.5, currentRatio: 0.9,
  revenueGrowth: 8, epsGrowth: 12,
};
const weakBusiness: QualityInputs = {
  netMargin: -6, operatingMargin: -3, grossMargin: 14, roe: -8, roic: -4,
  fcf: -500e6, revenue: 3e9, debtToEquity: 4.2, currentRatio: 0.7,
  revenueGrowth: -9, epsGrowth: -25,
};

// ── PRIORITY 1: missing data must never become 5.0 ───────────────────────────

describe('missing data handling', () => {
  it('excludes an unavailable metric instead of scoring it 5.0', () => {
    const full = scoreCompanyQuality(excellentBusiness);
    const partial = scoreCompanyQuality({ ...excellentBusiness, revenueGrowth: null, epsGrowth: null });

    const growth = partial.components.find(c => c.label === 'Growth Quality')!;
    expect(growth.score).toBeNull();          // excluded, not 5.0
    expect(growth.display).toBe('N/A');
    expect(partial.coverage).toBeLessThan(full.coverage);
    // With growth removed, the remaining strong metrics must not be dragged down
    expect(partial.score!).toBeGreaterThan(7);
  });

  it('renormalises the remaining weights to 100%', () => {
    const d = scoreCompanyQuality({ netMargin: 24, operatingMargin: 31 });   // only profitability
    const profitability = d.components.find(c => c.label === 'Profitability')!;
    expect(d.score).toBeCloseTo(profitability.score!, 6);   // single metric drives it entirely
    expect(d.available).toBe(1);
  });

  it('a strong business with sparse data still scores strongly', () => {
    // Only two metrics available, both excellent
    const d = scoreCompanyQuality({ roic: 55, grossMargin: 46 });
    expect(d.score!).toBeGreaterThan(7.5);
    expect(d.confidence).toBe('LOW');          // uncertainty reported separately
    expect(d.coverage).toBeLessThan(60);
  });

  it('returns null — not 5.0 — when nothing is available', () => {
    const d = scoreCompanyQuality({});
    expect(d.score).toBeNull();
    expect(d.coverage).toBe(0);
    expect(d.label).toBe('NO DATA');
  });

  it('does not penalise missing sentiment or analyst data', () => {
    const withSentiment = scoreMarketAlignment({ sectorPressure: 30, rsVsSector1M: 0.08, ret3M: 0.12, bullishPercent: 0.7 });
    const without = scoreMarketAlignment({ sectorPressure: 30, rsVsSector1M: 0.08, ret3M: 0.12 });
    // Removing a good metric lowers coverage but must not tank the score
    expect(without.coverage).toBeLessThan(withSentiment.coverage);
    expect(without.score!).toBeGreaterThan(6.5);
    expect(without.components.find(c => c.label === 'Sentiment')!.score).toBeNull();
  });

  it('flags low confidence without lowering the score', () => {
    const sparse = scoreValuation({ forwardPE: 12 });
    const full = scoreValuation({ forwardPE: 12, trailingPE: 14, peg: 0.9, fcf: 5e9, marketCap: 60e9, priceToBook: 2 });
    expect(sparse.confidence).toBe('LOW');
    expect(sparse.score!).toBeGreaterThan(7);      // still a good valuation reading
    expect(full.confidence).toBe('HIGH');
  });
});

// ── PRIORITY 2/3: dimensions are independent ─────────────────────────────────

describe('dimension independence', () => {
  it('Company Quality contains no price, chart or rotation input', () => {
    const d = scoreCompanyQuality(excellentBusiness);
    const labels = d.components.map(c => c.label.toLowerCase()).join(' ');
    expect(labels).not.toMatch(/price|rsi|moving average|momentum|rotation|52-week|drawdown/);
  });

  it('a collapsing chart does not change Company Quality', () => {
    const quality = scoreCompanyQuality(excellentBusiness);
    const strongChart = scoreTechnical({ price: 250, ma50: 230, ma200: 200, low52: 150, high52: 260, volume: 2e6, avgVolume: 1.5e6, ret1M: 0.12 });
    const brokenChart = scoreTechnical({ price: 120, ma50: 180, ma200: 210, low52: 110, high52: 260, volume: 3e6, avgVolume: 1.5e6, ret1M: -0.28 });
    expect(strongChart.score!).toBeGreaterThan(brokenChart.score!);
    // Same business inputs → identical quality regardless of the chart
    expect(scoreCompanyQuality(excellentBusiness).score).toBe(quality.score);
  });

  it('sector rotation feeds Market Alignment, never Company Quality', () => {
    const good = scoreMarketAlignment({ sectorPressure: 55, rsVsSector1M: 0.1, ret3M: 0.15 });
    const bad = scoreMarketAlignment({ sectorPressure: -55, rsVsSector1M: 0.1, ret3M: 0.15 });
    expect(good.score!).toBeGreaterThan(bad.score!);
    expect(scoreCompanyQuality(excellentBusiness).components.some(c => /rotation/i.test(c.label))).toBe(false);
  });

  it('separates a great business at a full price', () => {
    const quality = scoreCompanyQuality(excellentBusiness);
    const valuation = scoreValuation({ forwardPE: 33, trailingPE: 38, peg: 2.6, fcf: 100e9, marketCap: 3400e9, priceToBook: 48 });
    expect(quality.score!).toBeGreaterThan(7.5);
    expect(valuation.score!).toBeLessThan(6);
    // Not a contradiction — they measure different things
    expect(quality.score!).toBeGreaterThan(valuation.score!);
  });

  it('scores a weak business low on quality', () => {
    expect(scoreCompanyQuality(weakBusiness).score!).toBeLessThan(4.5);
  });
});

// ── PRIORITY 4: horizon blends ───────────────────────────────────────────────

describe('horizon scores', () => {
  const dims = () => ({
    companyQuality:  scoreCompanyQuality(excellentBusiness),
    valuation:       scoreValuation({ forwardPE: 30, trailingPE: 35, peg: 2.4, fcf: 100e9, marketCap: 3400e9, priceToBook: 40 }),
    technicalSetup:  scoreTechnical({ price: 200, ma50: 210, ma200: 205, low52: 165, high52: 260, volume: 1.2e6, avgVolume: 1.5e6, ret1M: -0.06 }),
    marketAlignment: scoreMarketAlignment({ sectorPressure: -17, rsVsSector1M: -0.02, ret3M: -0.04 }),
  });

  it('weights technical setup most heavily for swing', () => {
    const h = scoreHorizons(dims());
    const tech = h.swing.contributions.find(c => c.label === 'Technical Setup')!;
    expect(tech.weight).toBe(SWING_WEIGHTS.technicalSetup);
    expect(tech.weight).toBeGreaterThan(h.swing.contributions.find(c => c.label === 'Company Quality')!.weight);
  });

  it('weights company quality most heavily for long term', () => {
    const h = scoreHorizons(dims());
    const cq = h.long.contributions.find(c => c.label === 'Company Quality')!;
    expect(cq.weight).toBe(LONG_TERM_WEIGHTS.companyQuality);
    expect(cq.weight).toBeGreaterThanOrEqual(50);
  });

  it('a weak setup does not sink the long-term score of a great business', () => {
    const d = dims();
    const h = scoreHorizons(d);
    // Long term is 60% quality, so it must sit clearly above the swing read...
    expect(h.long.score!).toBeGreaterThan(h.swing.score! + 0.5);
    expect(h.long.score!).toBeGreaterThan(6);
    // ...but a rich valuation still legitimately holds it below the quality score
    expect(h.long.score!).toBeLessThan(d.companyQuality.score!);
  });

  it('temporary sector weakness barely moves the long-term score', () => {
    const base = dims();
    const hostile = { ...base, marketAlignment: scoreMarketAlignment({ sectorPressure: -80, rsVsSector1M: -0.2, ret3M: -0.3 }) };
    const friendly = { ...base, marketAlignment: scoreMarketAlignment({ sectorPressure: 60, rsVsSector1M: 0.2, ret3M: 0.3 }) };
    const swingGap = scoreHorizons(friendly).swing.score! - scoreHorizons(hostile).swing.score!;
    const longGap  = scoreHorizons(friendly).long.score!  - scoreHorizons(hostile).long.score!;
    expect(longGap).toBeLessThan(swingGap);     // 5% vs 30% weighting
    expect(longGap).toBeLessThan(0.5);
  });

  it('reports positive and negative drivers', () => {
    const h = scoreHorizons(dims());
    expect(h.medium.positives.length + h.medium.negatives.length).toBeGreaterThan(0);
    expect(h.medium.positives.some(p => /Company Quality/.test(p))).toBe(true);
  });

  it('names an excluded dimension as a negative driver', () => {
    const d = {
      companyQuality:  scoreCompanyQuality(excellentBusiness),
      valuation:       scoreValuation({}),           // no data at all
      technicalSetup:  scoreTechnical({ price: 200, ma50: 190, ma200: 180, low52: 150, high52: 220 }),
      marketAlignment: scoreMarketAlignment({ sectorPressure: 10 }),
    };
    const h = scoreHorizons(d);
    expect(h.medium.negatives.some(n => /Valuation unavailable/i.test(n))).toBe(true);
    expect(h.medium.score).not.toBeNull();         // still scored from what exists
  });

  it('returns null horizons when no dimension has data', () => {
    const empty = {
      companyQuality: scoreCompanyQuality({}), valuation: scoreValuation({}),
      technicalSetup: scoreTechnical({}), marketAlignment: scoreMarketAlignment({}),
    };
    const h = scoreHorizons(empty);
    expect(h.swing.score).toBeNull();
    expect(h.long.score).toBeNull();
  });
});

// ── Best fit and levers ──────────────────────────────────────────────────────

describe('best fit', () => {
  it('explains why one horizon wins rather than just picking the max', () => {
    const d = {
      companyQuality:  scoreCompanyQuality(excellentBusiness),
      valuation:       scoreValuation({ forwardPE: 30, peg: 2.4 }),
      technicalSetup:  scoreTechnical({ price: 200, ma50: 215, ma200: 210, low52: 165, high52: 260, ret1M: -0.08 }),
      marketAlignment: scoreMarketAlignment({ sectorPressure: -17, rsVsSector1M: -0.02 }),
    };
    const fit = explainBestFit(scoreHorizons(d), d);
    expect(fit.key).toBe('long');
    expect(fit.reason).toMatch(/leads/i);
    expect(fit.reason).toMatch(/Strong business quality|technical setup|sector conditions/i);
  });

  it('handles a total absence of data', () => {
    const empty = {
      companyQuality: scoreCompanyQuality({}), valuation: scoreValuation({}),
      technicalSetup: scoreTechnical({}), marketAlignment: scoreMarketAlignment({}),
    };
    expect(explainBestFit(scoreHorizons(empty), empty).key).toBeNull();
  });
});

describe('score levers', () => {
  it('suggests reclaiming a moving average the stock sits below', () => {
    const t: TechnicalInputs = { price: 190, ma50: 210, ma200: 200, low52: 150, high52: 260 };
    const a: AlignmentInputs = { sectorPressure: -20, rsVsSector1M: -0.05 };
    const d = {
      companyQuality: scoreCompanyQuality(excellentBusiness), valuation: scoreValuation({ forwardPE: 30 }),
      technicalSetup: scoreTechnical(t), marketAlignment: scoreMarketAlignment(a),
    };
    const l = scoreLevers(d, a, t);
    expect(l.improve.some(x => /50-day/.test(x))).toBe(true);
    expect(l.improve.some(x => /rotation pressure turns positive/i.test(x))).toBe(true);
  });

  it('warns about losing support when the stock is above it', () => {
    const t: TechnicalInputs = { price: 230, ma50: 210, ma200: 200, low52: 150, high52: 260 };
    const a: AlignmentInputs = { sectorPressure: 25, rsVsSector1M: 0.08 };
    const d = {
      companyQuality: scoreCompanyQuality(excellentBusiness), valuation: scoreValuation({ forwardPE: 30 }),
      technicalSetup: scoreTechnical(t), marketAlignment: scoreMarketAlignment(a),
    };
    const l = scoreLevers(d, a, t);
    expect(l.weaken.some(x => /50-day|200-day/.test(x))).toBe(true);
  });
});

// ── The scenario that motivated the rewrite ──────────────────────────────────

describe('great business, mediocre setup', () => {
  const result = () => runScorecard({
    ticker: 'TEST',
    quality: excellentBusiness,
    valuation: { forwardPE: 32, trailingPE: 37, peg: 2.5, fcf: 100e9, marketCap: 3400e9, priceToBook: 45 },
    technical: { price: 205, ma50: 212, ma200: 208, low52: 164, high52: 260, volume: 1.1e6, avgVolume: 1.6e6, ret1M: -0.05 },
    alignment: { sectorPressure: -17, rsVsSector1M: -0.01, ret3M: -0.03 },
  });

  it('reports high company quality alongside a weaker setup', () => {
    const r = result();
    expect(r.dimensions.companyQuality.score!).toBeGreaterThan(7.5);
    expect(r.dimensions.technicalSetup.score!).toBeLessThan(6.5);
    expect(r.dimensions.marketAlignment.score!).toBeLessThan(6);
  });

  it('does not let a mediocre setup define the business', () => {
    const r = result();
    // The horizon scores may be modest, but quality stands on its own
    expect(r.dimensions.companyQuality.score!).toBeGreaterThan(r.horizons.swing.score!);
    expect(r.dimensions.companyQuality.label).toMatch(/SOLID|HIGH QUALITY|EXCEPTIONAL/);
    // and the long horizon, which is 60% quality, must clearly beat the swing view
    expect(r.horizons.long.score!).toBeGreaterThan(r.horizons.swing.score! + 0.5);
  });

  it('exposes an auditable component breakdown for every dimension', () => {
    const r = result();
    for (const dim of Object.values(r.dimensions)) {
      expect(dim.components.length).toBeGreaterThan(0);
      for (const c of dim.components) {
        expect(c.weight).toBeGreaterThan(0);
        expect(typeof c.display).toBe('string');
      }
    }
  });

  it('keeps all four dimension scores within 0–10', () => {
    const r = result();
    for (const dim of Object.values(r.dimensions)) {
      if (dim.score == null) continue;
      expect(dim.score).toBeGreaterThanOrEqual(0);
      expect(dim.score).toBeLessThanOrEqual(10);
    }
  });
});
