// ─────────────────────────────────────────────────────────────────────────────
// Watch List — centralized configuration.
// All thresholds and scoring weights live here, never inline in components.
// ─────────────────────────────────────────────────────────────────────────────

export const WATCH_THRESHOLDS = {
  nearEntryPct: 3,        // within this % above entry → NEAR ENTRY
  extendedPct: 10,        // more than this % above entry → EXTENDED
  staleDays: 90,          // watch age beyond this can trigger REVIEW
  reviewDueDays: 60,      // days since last review → REVIEW DUE chip
  catalystSoonDays: 10,   // catalyst within this many days → "catalyst soon"
  sectorShiftDelta: 25,   // |5D sector pressure change| ≥ this → SECTOR SHIFT chip
};

// Stock-vs-sector relative strength interpretation (decimal returns, 1M)
export const WATCH_RS_THRESHOLDS = {
  outperform: 0.02,       // > +2% vs sector = outperforming
  strongOutperform: 0.05, // > +5% = strongly outperforming
  underperform: -0.02,    // < −2% = underperforming
};

// Actionability Score (0–100). Missing components are dropped and the
// remaining weights renormalized — missing data never counts as zero.
export const ACTIONABILITY_WEIGHTS = {
  entryProximity: 40,
  conviction: 15,
  sectorPressure: 15,
  stockRelStrength: 10,
  catalystSoon: 10,
  freshness: 10,
};

export type WatchStatus =
  | 'ACTIONABLE'
  | 'NEAR ENTRY'
  | 'WATCH'
  | 'WAIT FOR CATALYST'
  | 'EXTENDED'
  | 'REVIEW'
  | 'THESIS BROKEN';

export const STATUS_STYLE: Record<WatchStatus, { badge: string; border: string }> = {
  'ACTIONABLE':        { badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-600/60', border: 'border-l-emerald-500' },
  'NEAR ENTRY':        { badge: 'bg-blue-500/15 text-blue-300 border-blue-600/60',          border: 'border-l-blue-500' },
  'WATCH':             { badge: 'bg-zinc-700/40 text-zinc-300 border-zinc-600/60',          border: 'border-l-zinc-600' },
  'WAIT FOR CATALYST': { badge: 'bg-violet-500/15 text-violet-300 border-violet-600/60',    border: 'border-l-violet-500' },
  'EXTENDED':          { badge: 'bg-amber-500/15 text-amber-300 border-amber-600/60',       border: 'border-l-amber-500' },
  'REVIEW':            { badge: 'bg-orange-500/15 text-orange-300 border-orange-600/60',    border: 'border-l-orange-500' },
  'THESIS BROKEN':     { badge: 'bg-red-500/20 text-red-300 border-red-600/70',             border: 'border-l-red-500' },
};

export type Alignment = 'STRONG ALIGNMENT' | 'SECTOR TAILWIND' | 'STOCK LEADER' | 'WEAK ALIGNMENT';

export const ALIGNMENT_STYLE: Record<Alignment, string> = {
  'STRONG ALIGNMENT': 'text-emerald-400',
  'SECTOR TAILWIND':  'text-blue-400',
  'STOCK LEADER':     'text-violet-400',
  'WEAK ALIGNMENT':   'text-red-400',
};
