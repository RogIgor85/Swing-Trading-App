export type Verdict = 'GO' | 'CONDITIONAL' | 'NO GO';
export type Conviction = 'HIGH' | 'MEDIUM' | 'LOW';
export type TrendDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type LiquidityRisk = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ScorecardEntry {
  id: string;
  ticker: string;
  company_name: string;
  trade_date: string;
  technical_score: number;
  fundamental_score: number;
  risk_liquidity_score: number;
  sentiment_score: number;
  weighted_score: number;
  verdict: Verdict;
  notes: string;
  created_at: string;
}

export interface WatchItem {
  id: string;
  ticker: string;
  conviction: Conviction;
  notes: string;
  added_at: string;
}

export interface TechnicalSetup {
  id: string;
  ticker: string;
  trend_daily: TrendDirection;
  trend_weekly: TrendDirection;
  trend_monthly: TrendDirection;
  support_levels: string;
  resistance_levels: string;
  ma_50: number | null;
  ma_200: number | null;
  rsi: number | null;
  macd: string;
  chart_pattern: string;
  entry_price: number | null;
  stop_loss: number | null;
  target: number | null;
  rr_ratio: number | null;
  confidence: number;
  notes: string;
  created_at: string;
}

export interface Holding {
  id: string;
  ticker: string;
  shares: number;
  avg_cost: number;
  sector: string;
  liquidity_risk: LiquidityRisk;
  notes: string;
  created_at: string;
}

export interface FundamentalNote {
  id: string;
  ticker: string;
  bull_case: string;
  bear_case: string;
  notes: string;
  created_at: string;
}

// Finnhub API response types
export interface FinnhubQuote {
  c: number;  // current price
  d: number;  // change
  dp: number; // % change
  h: number;  // high
  l: number;  // low
  o: number;  // open
  pc: number; // previous close
}

export interface FinnhubProfile {
  name: string;
  ticker: string;
  exchange: string;
  finnhubIndustry: string;
  marketCapitalization: number;
  shareOutstanding: number;
  logo: string;
  weburl: string;
}

export interface FinnhubMetrics {
  metric: {
    '52WeekHigh': number;
    '52WeekLow': number;
    peBasicExclExtraTTM: number;
    pbAnnual: number;
    epsGrowth3Y: number;
    revenueGrowth3Y: number;
    roeTTM: number;
    debtEquityAnnual: number;
    grossMarginTTM: number;
    netProfitMarginTTM: number;
    beta: number;
    dividendYieldIndicatedAnnual: number;
  };
}

export interface FinnhubEarnings {
  actual: number | null;
  estimate: number;
  period: string;
  quarter: number;
  surprise: number | null;
  surprisePercent: number | null;
  symbol: string;
  year: number;
}

export interface FinnhubSentiment {
  buzz: {
    articlesInLastWeek: number;
    buzz: number;
    weeklyAverage: number;
  };
  companyNewsScore: number;
  sectorAverageBullishPercent: number;
  sectorAverageNewsScore: number;
  sentiment: {
    bearishPercent: number;
    bullishPercent: number;
  };
  symbol: string;
}
