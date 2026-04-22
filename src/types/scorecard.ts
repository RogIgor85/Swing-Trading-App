// ─── Market cap tiers ────────────────────────────────────────────────────────
export type MarketCapTier = 'LARGE' | 'MID' | 'SMALL';

// ─── Verdict types per frame ─────────────────────────────────────────────────
export type SwingVerdict  = 'GO' | 'CONDITIONAL' | 'NO GO';
export type MediumVerdict = 'GO' | 'CONDITIONAL' | 'NO GO';
export type LongVerdict   = 'BUY & HOLD' | 'ACCUMULATE' | 'PASS';

export type MoatRating = 'STRONG' | 'MODERATE' | 'WEAK' | 'NONE';

// ─── Position sizing ─────────────────────────────────────────────────────────
export interface SwingPosition {
  accountSize: number;
  riskPct: number;        // 0.02 or 0.01
  riskAmount: number;     // accountSize × riskPct
  stopPct: number;        // e.g. 0.06
  positionValue: number;  // riskAmount / stopPct
  shares: number;         // floor(positionValue / entryPrice)
  entry: number;
  stop: number;
  target: number;
  rrRatio: number;
}

// ─── Per-frame score objects ──────────────────────────────────────────────────
export interface SwingScore {
  technicalScore:  number;   // 0–10
  catalystScore:   number;
  riskScore:       number;
  sentimentScore:  number;
  composite:       number;
  verdict:         SwingVerdict;
  autoDisqualified: boolean;
  disqualifyReason?: string;
  cappedConditional: boolean;
  capReason?: string;
  position: SwingPosition | null;
  dataGaps: string[];
}

export interface MediumScore {
  fundamentalScore: number;
  technicalScore:   number;
  riskScore:        number;
  catalystScore:    number;
  composite:        number;
  verdict:          MediumVerdict;
  target12m:        number | null;
  thesisStop:       string;
  positionGuidance: string;
  dataGaps:         string[];
}

export interface LongScore {
  moatScore:      number;
  durabilityScore: number;
  growthScore:    number;
  valuationScore: number;
  composite:      number;
  verdict:        LongVerdict;
  moatRating:     MoatRating;
  thesis:         string;
  exitCondition:  string;
  positionGuidance: string;
  dataGaps:       string[];
}

// ─── Risk flags ───────────────────────────────────────────────────────────────
export type FlagSeverity = 'LOW' | 'MEDIUM' | 'HIGH';
export interface RiskFlag {
  label:    string;
  value:    string;
  severity: FlagSeverity;
}

// ─── Best fit ────────────────────────────────────────────────────────────────
export type BestFitFrame = 'SWING' | 'MEDIUM' | 'LONG';
export interface BestFit {
  frame:  BestFitFrame;
  reason: string;
}

// ─── Full tri-frame result ────────────────────────────────────────────────────
export interface TriFrameResult {
  ticker:       string;
  companyName:  string;
  exchange:     string;
  industry:     string;
  currentPrice: number;
  marketCap:    number;
  tier:         MarketCapTier;
  swing:        SwingScore;
  medium:       MediumScore;
  long:         LongScore;
  bestFit:      BestFit;
  riskFlags:    RiskFlag[];
  scoredAt:     string;
}

// ─── Persisted user settings ─────────────────────────────────────────────────
export interface ScorecardSettings {
  accountSize: number;   // total swing account in user currency
}
