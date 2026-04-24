import type {
  MarketCapTier, SwingVerdict, MediumVerdict, LongVerdict, MoatRating,
  SwingScore, MediumScore, LongScore,
  SwingPosition, BestFit, RiskFlag, TriFrameResult,
} from '../types/scorecard';
import type { FinnhubQuote, FinnhubProfile, FinnhubMetrics, FinnhubSentiment } from '../types';
import type { YahooData } from './yahoo';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(n: number, lo = 0, hi = 10): number {
  return Math.max(lo, Math.min(hi, n));
}
function avg(...nums: (number | null | undefined)[]): number {
  const valid = nums.filter((n): n is number => n != null && !isNaN(n));
  if (!valid.length) return 5;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}
function round2(n: number) { return Math.round(n * 100) / 100; }

export function getMarketCapTier(marketCapUSD: number | null | undefined): MarketCapTier {
  if (!marketCapUSD) return 'MID';
  if (marketCapUSD >= 50e9) return 'LARGE';
  if (marketCapUSD >= 2e9)  return 'MID';
  return 'SMALL';
}

export function stopPctForBeta(beta: number | null | undefined): number {
  const b = beta ?? 1;
  if (b > 1.8) return 0.08;
  if (b > 1.2) return 0.07;
  if (b > 0.8) return 0.06;
  return 0.05;
}

// ─── Settings persistence ──────────────────────────────────────────────────────
const SETTINGS_KEY = 'swing_settings';
export function loadSettings(): { accountSize: number } {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'); } catch { return { accountSize: 0 }; }
}
export function saveSettings(s: { accountSize: number }) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// ─── Individual sub-scores ──────────────────────────────────────────────────
function score52WPosition(current: number, low: number, high: number): number {
  if (high <= low) return 5;
  const pos = (current - low) / (high - low);
  if (pos < 0.15) return 4;
  if (pos < 0.35) return 6;
  if (pos < 0.55) return 8;
  if (pos < 0.75) return 9;
  if (pos < 0.90) return 7;
  return 5;
}

function scoreVs200MA(current: number, ma200: number): number {
  const pct = (current - ma200) / ma200;
  if (pct >  0.20) return 6;
  if (pct >  0.10) return 8;
  if (pct >  0.05) return 9;
  if (pct >  0.00) return 8;
  if (pct > -0.05) return 5;
  if (pct > -0.10) return 4;
  return 2;
}

function scoreVs50MA(current: number, ma50: number): number {
  const pct = (current - ma50) / ma50;
  if (pct >  0.15) return 5;
  if (pct >  0.05) return 7;
  if (pct >  0.00) return 9;
  if (pct > -0.03) return 6;
  if (pct > -0.08) return 5;
  return 3;
}

function scoreVolume(current: number | null | undefined, avg: number | null | undefined): number {
  if (!current || !avg || avg === 0) return 5;
  const ratio = current / avg;
  if (ratio > 1.5) return 8;
  if (ratio > 1.0) return 7;
  if (ratio > 0.7) return 6;
  return 5;
}

function scoreBeta(beta: number | null | undefined): number {
  const b = beta ?? 1;
  if (b < 0.6) return 6;
  if (b < 0.8) return 7;
  if (b < 1.2) return 9;
  if (b < 1.8) return 7;
  if (b < 2.5) return 5;
  return 3;
}

function scoreShortInterest(pct: number | null | undefined): number {
  // Yahoo Finance returns as decimal (0.05 = 5%)
  if (pct == null) return 5;
  if (pct < 0.03) return 8;
  if (pct < 0.08) return 7;
  if (pct < 0.15) return 5;
  if (pct < 0.25) return 3;
  return 2;
}

function scoreDebtEquity(de: number | null | undefined): number {
  // Yahoo Finance returns debtToEquity as value×100 (150 = 1.5x)
  if (de == null) return 5;
  const ratio = de / 100;
  if (ratio < 0)   return 9; // net cash
  if (ratio < 0.5) return 8;
  if (ratio < 1.0) return 7;
  if (ratio < 2.0) return 6;
  if (ratio < 3.0) return 4;
  return 2;
}

function scoreMarketCap(cap: number | null | undefined): number {
  const t = getMarketCapTier(cap);
  return t === 'LARGE' ? 8 : t === 'MID' ? 7 : 5;
}

function scoreGrowth(growthDecimal: number | null | undefined): number {
  if (growthDecimal == null) return 5;
  const g = growthDecimal;
  if (g > 0.30) return 9;
  if (g > 0.20) return 8;
  if (g > 0.10) return 7;
  if (g > 0.05) return 6;
  if (g > 0.00) return 5;
  return 3;
}

function scoreGrossMargin(grossProfits: number | null, totalRevenue: number | null, finnhubMargin?: number | null): number {
  let margin: number | null = finnhubMargin ?? null;
  if (margin == null && grossProfits != null && totalRevenue && totalRevenue > 0) {
    margin = grossProfits / totalRevenue;
  }
  if (margin == null) return 5;
  if (margin > 0.60) return 9;
  if (margin > 0.45) return 8;
  if (margin > 0.30) return 7;
  if (margin > 0.15) return 6;
  return 4;
}

function scoreROE(roe: number | null | undefined): number {
  if (roe == null) return 5;
  if (roe > 0.25) return 9;
  if (roe > 0.15) return 8;
  if (roe > 0.10) return 7;
  if (roe > 0.05) return 6;
  if (roe > 0.00) return 4;
  return 2;
}

function scoreFCF(fcf: number | null | undefined): number {
  if (fcf == null) return 5;
  if (fcf > 0) return 8;
  return 3;
}

function scoreCurrentRatio(cr: number | null | undefined): number {
  if (cr == null) return 5;
  if (cr > 3.0) return 7;
  if (cr > 2.0) return 8;
  if (cr > 1.5) return 9;
  if (cr > 1.0) return 7;
  if (cr > 0.5) return 4;
  return 2;
}

function scoreAnalystRec(key: string | null | undefined, count: number | null | undefined): number {
  let base = 5;
  switch (key) {
    case 'strongBuy': base = 9; break;
    case 'buy':       base = 8; break;
    case 'hold':      base = 6; break;
    case 'underperform': base = 3; break;
    case 'sell':      base = 2; break;
  }
  if (count != null && count < 3) base = Math.max(base - 1, 2);
  return base;
}

function scoreEarningsProximity(earningsDateStr: string | null | undefined): number {
  if (!earningsDateStr) return 5;
  const daysAway = (new Date(earningsDateStr).getTime() - Date.now()) / (1000 * 86400);
  if (daysAway < 0)    return 5;  // already passed
  if (daysAway < 3)    return 3;  // binary event risk
  if (daysAway < 7)    return 5;
  if (daysAway < 21)   return 8;  // catalyst window
  if (daysAway < 45)   return 7;
  if (daysAway < 90)   return 6;
  return 5;
}

function nextEarningsDate(cal: { earnings?: { earningsDate?: string[] | null } } | null | undefined): string | null {
  const dates = cal?.earnings?.earningsDate;
  if (!dates?.length) return null;
  const future = dates
    .map(d => new Date(d))
    .filter(d => d.getTime() > Date.now())
    .sort((a, b) => a.getTime() - b.getTime());
  return future.length ? future[0].toISOString().split('T')[0] : null;
}

// ─── Technical sub-score (shared between swing + medium) ─────────────────────
function buildTechnicalScore(
  current: number,
  quote: FinnhubQuote | null,
  metrics: FinnhubMetrics | null,
  yahoo: YahooData,
  gaps: string[],
): number {
  const m = metrics?.metric;
  const sd = yahoo.summaryDetail;

  const high52 = m?.['52WeekHigh']   ?? sd?.fiftyTwoWeekHigh  ?? null;
  const low52  = m?.['52WeekLow']    ?? sd?.fiftyTwoWeekLow   ?? null;
  const ma200  = sd?.twoHundredDayAverage ?? null;
  const ma50   = sd?.fiftyDayAverage ?? null;
  const vol    = sd?.volume ?? null;
  const avgVol = sd?.averageVolume ?? sd?.averageVolume10days ?? null;

  const scores: number[] = [];
  const weights: number[] = [];

  if (high52 && low52) {
    scores.push(score52WPosition(current, low52, high52)); weights.push(0.20);
  } else { gaps.push('⚠️ 52-week range — not available'); }

  if (ma200) {
    scores.push(scoreVs200MA(current, ma200)); weights.push(0.35);
  } else { gaps.push('⚠️ 200-day MA — not available'); }

  if (ma50) {
    scores.push(scoreVs50MA(current, ma50)); weights.push(0.30);
  } else { gaps.push('⚠️ 50-day MA — not available'); }

  if (vol || avgVol) {
    scores.push(scoreVolume(vol, avgVol)); weights.push(0.15);
  }

  if (!scores.length) return 5;
  const totalW = weights.reduce((a, b) => a + b, 0);
  return round2(scores.reduce((acc, s, i) => acc + s * weights[i], 0) / totalW);
}

// ─── SWING scoring ────────────────────────────────────────────────────────────
export function scoreSwing(
  current: number,
  quote: FinnhubQuote | null,
  profile: FinnhubProfile | null,
  metrics: FinnhubMetrics | null,
  sentiment: FinnhubSentiment | null,
  yahoo: YahooData,
  accountSize: number,
): SwingScore {
  const gaps: string[] = [];
  const m  = metrics?.metric;
  const sd = yahoo.summaryDetail;
  const fd = yahoo.financialData;
  const ks = yahoo.defaultKeyStatistics;
  const cal = yahoo.calendarEvents;

  const marketCap = sd?.marketCap ?? (profile ? profile.marketCapitalization * 1e6 : null);
  const tier = getMarketCapTier(marketCap);
  const beta = sd?.beta ?? ks?.beta ?? m?.beta ?? null;

  // 1. Technical (40%)
  const technicalScore = clamp(buildTechnicalScore(current, quote, metrics, yahoo, gaps));

  // 2. Near-Term Catalyst (25%)
  const earnDate = nextEarningsDate(cal);
  const earnProx = scoreEarningsProximity(earnDate);
  const sentScore = sentiment?.sentiment
    ? clamp(sentiment.sentiment.bullishPercent * 10)
    : (() => { gaps.push('⚠️ News sentiment — not available'); return 5; })();
  const analystScore = scoreAnalystRec(fd?.recommendationKey, fd?.numberOfAnalystOpinions);
  if (!fd?.recommendationKey) gaps.push('⚠️ Analyst recommendation — not available');

  const catalystScore = round2(earnProx * 0.35 + sentScore * 0.40 + analystScore * 0.25);

  // 3. Risk & Liquidity (25%)
  const capScore   = scoreMarketCap(marketCap);
  const betaScore  = scoreBeta(beta);
  if (beta == null) gaps.push('⚠️ Beta — not available');
  const finnhubShortPct =
    m?.shortInterest != null && m?.sharesFloat != null && m.sharesFloat > 0
      ? m.shortInterest / m.sharesFloat
      : null;
  const shortPct = ks?.shortPercentOfFloat ?? finnhubShortPct;
  const shortScore = scoreShortInterest(shortPct);
  if (shortPct == null) gaps.push('⚠️ Short interest — not available');
  const deScore    = scoreDebtEquity(fd?.debtToEquity);

  const riskScore = round2(capScore * 0.25 + betaScore * 0.35 + shortScore * 0.25 + deScore * 0.15);

  // 4. Sentiment (10%)
  const sentimentScore = sentScore;

  // Weighted composite
  const composite = round2(
    technicalScore * 0.40 +
    catalystScore  * 0.25 +
    riskScore      * 0.25 +
    sentimentScore * 0.10
  );

  // Auto-disqualify + capping
  let autoDisqualified = false;
  let disqualifyReason: string | undefined;
  let cappedConditional = false;
  let capReason: string | undefined;

  const stopPct = stopPctForBeta(beta);
  const stopPrice = current * (1 - stopPct);
  const targetPrice = current + (current - stopPrice) * 2.5;
  const rrRatio = round2((targetPrice - current) / (current - stopPrice));

  if (technicalScore < 6) {
    autoDisqualified = true;
    disqualifyReason = `Technical score ${technicalScore.toFixed(1)} < 6.0 — auto disqualified`;
  }
  if (rrRatio < 2.0 && !autoDisqualified) {
    cappedConditional = true;
    capReason = `R:R ${rrRatio.toFixed(1)}:1 < 2:1 — capped at CONDITIONAL`;
  }

  // Verdict by cap tier
  function swingVerdict(score: number): SwingVerdict {
    if (tier === 'LARGE') return score >= 6.8 ? 'GO' : score >= 5.5 ? 'CONDITIONAL' : 'NO GO';
    if (tier === 'MID')   return score >= 7.0 ? 'GO' : score >= 5.5 ? 'CONDITIONAL' : 'NO GO';
    return score >= 7.5 ? 'GO' : score >= 6.0 ? 'CONDITIONAL' : 'NO GO';
  }

  let verdict: SwingVerdict = autoDisqualified ? 'NO GO' : swingVerdict(composite);
  if (!autoDisqualified && cappedConditional && verdict === 'GO') verdict = 'CONDITIONAL';

  // Position sizing
  let position: SwingPosition | null = null;
  if (accountSize > 0 && verdict !== 'NO GO') {
    const riskPct   = verdict === 'GO' ? 0.02 : 0.01;
    const riskAmount = accountSize * riskPct;
    const posValue  = riskAmount / stopPct;
    const shares    = Math.floor(posValue / current);
    position = {
      accountSize, riskPct, riskAmount,
      stopPct, positionValue: posValue,
      shares, entry: current, stop: stopPrice,
      target: round2(targetPrice), rrRatio,
    };
  } else if (accountSize === 0) {
    gaps.push('⚠️ Account size not set — position sizing unavailable');
  }

  return {
    technicalScore, catalystScore, riskScore, sentimentScore,
    composite, verdict, autoDisqualified, disqualifyReason,
    cappedConditional, capReason, position, dataGaps: gaps,
  };
}

// ─── MEDIUM TERM scoring ───────────────────────────────────────────────────────
export function scoreMedium(
  current: number,
  quote: FinnhubQuote | null,
  profile: FinnhubProfile | null,
  metrics: FinnhubMetrics | null,
  yahoo: YahooData,
): MediumScore {
  const gaps: string[] = [];
  const m  = metrics?.metric;
  const fd = yahoo.financialData;
  const ks = yahoo.defaultKeyStatistics;
  const sd = yahoo.summaryDetail;

  // 1. Fundamental Quality (35%)
  const revGrowth = fd?.revenueGrowth ?? null;
  const epsGrowth = fd?.earningsGrowth ?? (m?.epsGrowth3Y != null ? m.epsGrowth3Y / 100 : null);
  const grossMarginScore = scoreGrossMargin(fd?.grossProfits ?? null, fd?.totalRevenue ?? null, m?.grossMarginTTM);
  const roeScore  = scoreROE(fd?.returnOnEquity ?? (m?.roeTTM != null ? m.roeTTM / 100 : null));
  const fcfScore  = scoreFCF(fd?.freeCashflow);

  if (revGrowth == null) gaps.push('⚠️ Revenue growth — not available');
  if (epsGrowth == null) gaps.push('⚠️ EPS growth — not available');
  if (fd?.freeCashflow == null) gaps.push('⚠️ Free cash flow — not available');

  const fundamentalScore = round2(avg(
    scoreGrowth(revGrowth),
    scoreGrowth(epsGrowth),
    grossMarginScore,
    roeScore,
    fcfScore,
  ));

  // 2. Technical Entry (25%) — reuse swing technical logic
  const technicalScore = clamp(buildTechnicalScore(current, quote, metrics, yahoo, gaps));

  // 3. Risk & Macro (25%)
  const beta = sd?.beta ?? ks?.beta ?? m?.beta ?? null;
  const betaScore = scoreBeta(beta);
  const deScore   = scoreDebtEquity(fd?.debtToEquity);
  const crScore   = scoreCurrentRatio(fd?.currentRatio);
  const capScore  = scoreMarketCap(sd?.marketCap ?? (profile ? profile.marketCapitalization * 1e6 : null));

  const riskScore = round2(betaScore * 0.30 + deScore * 0.35 + crScore * 0.20 + capScore * 0.15);

  // 4. Catalyst Pipeline (15%)
  const analystScore  = scoreAnalystRec(fd?.recommendationKey, fd?.numberOfAnalystOpinions);
  const cal = yahoo.calendarEvents;
  const earnDate = nextEarningsDate(cal);
  const earnScore = scoreEarningsProximity(earnDate);
  const catalystScore = round2(analystScore * 0.60 + earnScore * 0.40);

  const composite = round2(
    fundamentalScore * 0.35 +
    technicalScore   * 0.25 +
    riskScore        * 0.25 +
    catalystScore    * 0.15
  );

  const verdict: MediumVerdict =
    composite >= 7.0 ? 'GO' : composite >= 5.5 ? 'CONDITIONAL' : 'NO GO';

  const target12m = fd?.targetMeanPrice ?? null;
  const ma200 = sd?.twoHundredDayAverage ?? null;
  const thesisStop = ma200
    ? `Break and close below 200-day MA (~$${ma200.toFixed(2)}) on high volume`
    : 'Break below key support on high volume (set manually in Technical tab)';

  const positionGuidance = verdict === 'GO' ? '4–6% of portfolio' : verdict === 'CONDITIONAL' ? '2–3% of portfolio' : 'No position — wait for improvement';

  return {
    fundamentalScore, technicalScore, riskScore, catalystScore,
    composite, verdict, target12m, thesisStop, positionGuidance, dataGaps: gaps,
  };
}

// ─── LONG TERM scoring ─────────────────────────────────────────────────────────
export function scoreLong(
  current: number,
  profile: FinnhubProfile | null,
  metrics: FinnhubMetrics | null,
  yahoo: YahooData,
): LongScore {
  const gaps: string[] = [];
  const m  = metrics?.metric;
  const fd = yahoo.financialData;
  const ks = yahoo.defaultKeyStatistics;
  const sd = yahoo.summaryDetail;

  // 1. Business Quality & Moat (40%)
  const grossM  = scoreGrossMargin(fd?.grossProfits ?? null, fd?.totalRevenue ?? null, m?.grossMarginTTM);
  const roeScore = scoreROE(fd?.returnOnEquity ?? (m?.roeTTM != null ? m.roeTTM / 100 : null));
  const revGrowthScore = scoreGrowth(fd?.revenueGrowth ?? (m?.revenueGrowth3Y != null ? m.revenueGrowth3Y / 100 : null));
  const capScore = scoreMarketCap(sd?.marketCap ?? (profile ? profile.marketCapitalization * 1e6 : null));

  if (m?.grossMarginTTM == null && fd?.grossProfits == null) gaps.push('⚠️ Gross margin — not available');
  if (fd?.returnOnEquity == null && m?.roeTTM == null) gaps.push('⚠️ Return on equity — not available');

  const moatScore = round2(avg(grossM, roeScore, revGrowthScore, capScore));

  const moatRating: MoatRating =
    moatScore >= 8.0 ? 'STRONG' :
    moatScore >= 6.5 ? 'MODERATE' :
    moatScore >= 5.0 ? 'WEAK' : 'NONE';

  // 2. Financial Durability (25%)
  const deScore  = scoreDebtEquity(fd?.debtToEquity);
  const crScore  = scoreCurrentRatio(fd?.currentRatio);
  const fcfScore = scoreFCF(fd?.freeCashflow);
  const netMarginScore = fd?.profitMargins != null
    ? clamp(fd.profitMargins > 0.20 ? 9 : fd.profitMargins > 0.10 ? 7 : fd.profitMargins > 0.05 ? 6 : fd.profitMargins > 0 ? 5 : 3)
    : (() => { gaps.push('⚠️ Net profit margin — not available'); return 5; })();

  const durabilityScore = round2(avg(deScore, crScore, fcfScore, netMarginScore));

  // 3. Growth Runway (20%)
  const epsGrowthScore = scoreGrowth(fd?.earningsGrowth ?? (m?.epsGrowth3Y != null ? m.epsGrowth3Y / 100 : null));
  const revGrowth2     = scoreGrowth(fd?.revenueGrowth  ?? (m?.revenueGrowth3Y != null ? m.revenueGrowth3Y / 100 : null));
  const peg = ks?.pegRatio ?? null;
  const pegScore = peg == null ? 5
    : peg < 0   ? 5  // negative PEG is ambiguous
    : peg < 1   ? 9
    : peg < 2   ? 7
    : peg < 3   ? 5 : 3;
  if (peg == null) gaps.push('⚠️ PEG ratio — not available');

  const growthScore = round2(avg(epsGrowthScore, revGrowth2, pegScore));

  // 4. Technical Entry / Valuation (15%)
  const pe = sd?.trailingPE ?? m?.peBasicExclExtraTTM ?? null;
  const peScore = pe == null ? 5
    : pe < 0   ? 3   // negative earnings
    : pe < 15  ? 9
    : pe < 25  ? 8
    : pe < 35  ? 7
    : pe < 50  ? 5
    : pe < 80  ? 4 : 2;
  const pb = ks?.priceToBook ?? m?.pbAnnual ?? null;
  const pbScore = pb == null ? 5
    : pb < 1   ? 9
    : pb < 2   ? 8
    : pb < 4   ? 7
    : pb < 8   ? 5 : 3;

  const valuationScore = round2(avg(peScore, pbScore));

  const composite = round2(
    moatScore        * 0.40 +
    durabilityScore  * 0.25 +
    growthScore      * 0.20 +
    valuationScore   * 0.15
  );

  const verdict: LongVerdict =
    composite >= 7.5 ? 'BUY & HOLD' : composite >= 6.0 ? 'ACCUMULATE' : 'PASS';

  const ma200 = yahoo.summaryDetail?.twoHundredDayAverage ?? null;
  const thesis = `${moatRating} moat. ${fd?.revenueGrowth != null ? `Revenue growing ${(fd.revenueGrowth * 100).toFixed(0)}% YoY.` : ''} ${fd?.returnOnEquity != null ? `ROE ${(fd.returnOnEquity * 100).toFixed(0)}%.` : ''} Long-term thesis intact while fundamentals hold.`;
  const exitCondition = `Thesis broken if: moat deteriorates (gross margin compression > 500bps), ROE falls sustainably below 10%, or competitive position weakens materially.${ma200 ? ` Tactical stop: close below 200MA ($${ma200.toFixed(2)}) for 3+ weeks.` : ''}`;

  const positionGuidance = verdict === 'BUY & HOLD'
    ? '5–10% of portfolio'
    : verdict === 'ACCUMULATE'
    ? 'Start 2–3%, scale in over 3–6 months'
    : 'Pass — revisit on materially better entry or fundamentals';

  return {
    moatScore, durabilityScore, growthScore, valuationScore,
    composite, verdict, moatRating, thesis, exitCondition, positionGuidance, dataGaps: gaps,
  };
}

// ─── Best-fit logic ────────────────────────────────────────────────────────────
export function getBestFit(swing: SwingScore, medium: MediumScore, long: LongScore): BestFit {
  const swingEff  = swing.verdict  !== 'NO GO'      ? swing.composite  : 0;
  const mediumEff = medium.verdict !== 'NO GO'       ? medium.composite : 0;
  const longEff   = long.verdict   !== 'PASS'        ? long.composite   : 0;

  const best = (
    swingEff >= mediumEff && swingEff >= longEff   ? 'SWING' :
    mediumEff >= longEff                            ? 'MEDIUM' : 'LONG'
  ) as 'SWING' | 'MEDIUM' | 'LONG';

  const reasons: Record<string, string> = {
    SWING:  swing.verdict  === 'GO'
      ? `Strong technical setup with clear entry/stop — best opportunity in the next 3–21 days`
      : `Near-term technical opportunity despite some caveats — swing window is open`,
    MEDIUM: medium.verdict === 'GO'
      ? `Solid fundamentals + reasonable entry timing support a 6–12 month hold`
      : `Fundamental story building — medium-term positioning makes more sense than short-term trade`,
    LONG:   long.verdict   === 'BUY & HOLD'
      ? `${long.moatRating} moat + durable financials — this is a core long-term position`
      : `Fundamental quality supports gradual accumulation over 2+ years`,
  };

  return { frame: best, reason: reasons[best] };
}

// ─── Risk flags ───────────────────────────────────────────────────────────────
export function buildRiskFlags(
  metrics: FinnhubMetrics | null,
  yahoo: YahooData,
  earningsDate: string | null,
): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const m  = metrics?.metric;
  const ks = yahoo.defaultKeyStatistics;
  const sd = yahoo.summaryDetail;

  // Short interest: Yahoo primary, Finnhub shortInterest/sharesFloat as fallback
  const yahooSi = ks?.shortPercentOfFloat;
  const finnhubSi =
    m?.shortInterest != null && m?.sharesFloat != null && m.sharesFloat > 0
      ? m.shortInterest / m.sharesFloat
      : null;
  const si = yahooSi ?? finnhubSi;
  if (si != null) {
    const pct = (si * 100).toFixed(1);
    flags.push({
      label: 'Short Interest',
      value: `${pct}% of float`,
      severity: si > 0.20 ? 'HIGH' : si > 0.10 ? 'MEDIUM' : 'LOW',
    });
  }

  // Beta
  const beta = sd?.beta ?? ks?.beta ?? m?.beta;
  if (beta != null) {
    flags.push({
      label: 'Beta',
      value: `${beta.toFixed(2)}`,
      severity: beta > 2.0 ? 'HIGH' : beta > 1.5 ? 'MEDIUM' : 'LOW',
    });
  }

  // Volume
  const avgVol = sd?.averageVolume;
  if (avgVol != null) {
    const volStr = avgVol >= 1e6 ? `${(avgVol / 1e6).toFixed(1)}M` : `${(avgVol / 1e3).toFixed(0)}K`;
    flags.push({
      label: 'Avg Volume',
      value: volStr,
      severity: avgVol < 500_000 ? 'HIGH' : avgVol < 2_000_000 ? 'MEDIUM' : 'LOW',
    });
  }

  // Earnings proximity
  if (earningsDate) {
    const days = Math.ceil((new Date(earningsDate).getTime() - Date.now()) / 86400000);
    if (days >= 0) {
      flags.push({
        label: 'Next Earnings',
        value: `${earningsDate} (${days}d)`,
        severity: days < 7 ? 'HIGH' : days < 21 ? 'MEDIUM' : 'LOW',
      });
    }
  }

  // Short ratio
  const sr = ks?.shortRatio;
  if (sr != null && sr > 5) {
    flags.push({
      label: 'Days to Cover',
      value: `${sr.toFixed(1)} days`,
      severity: sr > 10 ? 'HIGH' : 'MEDIUM',
    });
  }

  return flags;
}

// ─── Master scorer ─────────────────────────────────────────────────────────────
export function runTriFrame(
  ticker: string,
  quote: FinnhubQuote,
  profile: FinnhubProfile,
  metrics: FinnhubMetrics | null,
  sentiment: FinnhubSentiment | null,
  yahoo: YahooData,
  accountSize: number,
): TriFrameResult {
  const current = quote.c;
  const sd = yahoo.summaryDetail;
  const marketCap = sd?.marketCap ?? (profile.marketCapitalization * 1e6);
  const tier = getMarketCapTier(marketCap);

  const swing  = scoreSwing(current, quote, profile, metrics, sentiment, yahoo, accountSize);
  const medium = scoreMedium(current, quote, profile, metrics, yahoo);
  const long   = scoreLong(current, profile, metrics, yahoo);
  const bestFit = getBestFit(swing, medium, long);

  const cal = yahoo.calendarEvents;
  const earningsDate = nextEarningsDate(cal);
  const riskFlags = buildRiskFlags(metrics, yahoo, earningsDate);

  return {
    ticker: ticker.toUpperCase(),
    companyName: profile.name,
    exchange: profile.exchange,
    industry: profile.finnhubIndustry,
    currentPrice: current,
    marketCap,
    tier,
    swing, medium, long,
    bestFit, riskFlags,
    scoredAt: new Date().toISOString(),
  };
}
