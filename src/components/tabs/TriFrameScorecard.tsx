import { useState, useRef, useEffect } from 'react';
import { Search, Star, Pencil, Check, X, AlertTriangle, TrendingUp, TrendingDown, Clock, BarChart2, Eye, Newspaper, Save, BookOpen } from 'lucide-react';
import { finnhub } from '../../lib/finnhub';
import { fetchYahoo } from '../../lib/yahoo';
import { runTriFrame, loadSettings, saveSettings } from '../../lib/scoring';
import { runScorecard } from '../../lib/scorecard/scoreEngine';
import type { DimensionScore, ScorecardResult } from '../../lib/scorecard/scoreEngine';
import {
  buildQualityInputs, buildValuationInputs, buildTechnicalInputs,
  buildAlignmentInputs, fetchSectorContext,
} from '../../lib/scorecard/scorecardInputs';
import type { SectorContext } from '../../lib/scorecard/scorecardInputs';
import { DIMENSION_HELP, HORIZON_LABELS } from '../../config/scorecardConfig';
import { readAccountSnapshot, snapshotAgeLabel } from '../../lib/portfolio/accountSnapshot';
import { storage, newId, nowIso } from '../../lib/storage';
import { fmtCurrency, fmt } from '../../lib/utils';
import type { TriFrameResult, SwingScore, MediumScore, LongScore, FlagSeverity } from '../../types/scorecard';
import type { FinnhubEarnings } from '../../types';

const TABLE_WATCH = 'watch_items';

// Extract next earnings date from Yahoo calendarEvents
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getNextEarningsDate(yahooData: any): string | null {
  const dates: any[] = yahooData?.calendarEvents?.earnings?.earningsDate ?? [];
  const now = Date.now();
  for (const d of dates) {
    const ts = typeof d === 'object' ? (d.raw ?? d) : d;
    const ms = typeof ts === 'number' ? ts * 1000 : new Date(ts).getTime();
    if (!isNaN(ms) && ms > now) {
      return new Date(ms).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }
  return null;
}

// Estimate next earnings from Finnhub historical earnings: last period + ~91 days
function estimateNextEarnings(history: FinnhubEarnings[] | null): string | null {
  if (!history?.length) return null;
  // Sort by period date descending
  const sorted = [...history].sort((a, b) => b.period.localeCompare(a.period));
  const lastPeriod = sorted[0]?.period; // e.g. "2025-12-31"
  if (!lastPeriod) return null;
  const lastDate = new Date(lastPeriod);
  if (isNaN(lastDate.getTime())) return null;
  // Companies typically report ~4–6 weeks after fiscal quarter end
  // Quarter end + 91 days is a reasonable estimate for the NEXT report
  const estimated = new Date(lastDate.getTime() + 91 * 24 * 60 * 60 * 1000);
  if (estimated.getTime() <= Date.now()) return null; // already passed
  return '~' + estimated.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Yahoo Finance sometimes returns {raw: number, fmt: string} even with formatted=false
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function yNum(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof v.raw === 'number') return v.raw;
  return null;
}

// ─── Verdict styling ──────────────────────────────────────────────────────────
const SWING_VERDICT_STYLE: Record<string, string> = {
  'GO':          'bg-emerald-900/50 text-emerald-300 border border-emerald-600',
  'CONDITIONAL': 'bg-amber-900/50 text-amber-300 border border-amber-600',
  'NO GO':       'bg-red-900/50 text-red-300 border border-red-600',
};
const LONG_VERDICT_STYLE: Record<string, string> = {
  'BUY & HOLD':  'bg-emerald-900/50 text-emerald-300 border border-emerald-600',
  'ACCUMULATE':  'bg-amber-900/50 text-amber-300 border border-amber-600',
  'PASS':        'bg-red-900/50 text-red-300 border border-red-600',
};
const FLAG_SEVERITY: Record<FlagSeverity, string> = {
  LOW:    'text-emerald-400',
  MEDIUM: 'text-amber-400',
  HIGH:   'text-red-400',
};
const FLAG_DEFINITIONS: Record<string, { summary: string; bullets: string[] }> = {
  'Beta': {
    summary: 'How much the stock moves relative to the S&P 500.',
    bullets: [
      'Beta = 1.0 → moves exactly with the market. S&P down 5% = stock down ~5%',
      'Beta > 1.0 → more volatile. Beta 1.5 = S&P down 5% → stock down ~7.5%',
      'Beta < 1.0 → less volatile. Beta 0.5 = S&P down 5% → stock down ~2.5%',
      'Beta < 0 → moves opposite to the market (rare — gold miners sometimes)',
    ],
  },
  'Short Interest': {
    summary: '% of the float currently sold short by traders betting the stock falls.',
    bullets: [
      '<5% — normal, minimal bearish pressure',
      '5–10% — elevated, worth monitoring',
      '>10% — HIGH short interest; squeeze risk if positive news hits',
      '>20% — very crowded short; explosive squeeze potential but strong bearish conviction',
    ],
  },
  'Avg Volume': {
    summary: 'Average daily shares traded — measures how easy it is to enter and exit.',
    bullets: [
      '>2M — highly liquid, tight spreads, easy to scale in/out',
      '500K–2M — moderate liquidity, manageable for most position sizes',
      '<500K — thin liquidity; wide spreads, harder to exit quickly in a downturn',
    ],
  },
  'Next Earnings': {
    summary: 'Days until the next earnings report — a binary overnight event.',
    bullets: [
      '>21 days — low near-term risk, safe to hold swing positions',
      '7–21 days — consider reducing position size heading into the date',
      '<7 days — HIGH risk; stocks can gap 5–20%+ after earnings; consider closing',
    ],
  },
};

function fmtLarge(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6)  return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toFixed(0)}`;
}
function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
function pct(n: number | null | undefined, mult = 1): string {
  if (n == null || isNaN(n)) return '—';
  return `${(n * mult >= 0 ? '+' : '')}${(n * mult).toFixed(1)}%`;
}
function colorG(n: number | null | undefined): string {
  if (n == null) return 'text-zinc-300';
  return n >= 0 ? 'text-emerald-400' : 'text-red-400';
}

const TIER_BADGE: Record<string, string> = {
  LARGE: 'text-blue-400 border-blue-700',
  MID:   'text-purple-400 border-purple-700',
  SMALL: 'text-zinc-400 border-zinc-600',
};

// ─── Sub-components ────────────────────────────────────────────────────────────
function ScoreBar({ label, score, weight }: { label: string; score: number; weight: number }) {
  const color = score >= 7.5 ? 'bg-emerald-500' : score >= 6 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-36 text-zinc-400 truncate">{label}</span>
      <div className="flex-1 bg-zinc-700 rounded-full h-1.5">
        <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${score * 10}%` }} />
      </div>
      <span className="w-8 text-right tabular-nums text-zinc-300">{score.toFixed(1)}</span>
      <span className="w-8 text-right tabular-nums text-zinc-600">{(weight * 100).toFixed(0)}%</span>
    </div>
  );
}

// ─── Four-dimension scoring ────────────────────────────────────────────────────

function scoreColor(s: number | null): string {
  if (s == null) return 'text-zinc-600';
  return s >= 8 ? 'text-emerald-400' : s >= 6.5 ? 'text-emerald-500'
    : s >= 5 ? 'text-amber-400' : s >= 3.5 ? 'text-orange-400' : 'text-red-400';
}
function scoreBg(s: number | null): string {
  if (s == null) return 'bg-zinc-700';
  return s >= 8 ? 'bg-emerald-400' : s >= 6.5 ? 'bg-emerald-500'
    : s >= 5 ? 'bg-amber-400' : s >= 3.5 ? 'bg-orange-400' : 'bg-red-400';
}
const CONFIDENCE_STYLE: Record<string, string> = {
  HIGH:     'text-zinc-500 border-zinc-700',
  MODERATE: 'text-amber-500/80 border-amber-800/60',
  LOW:      'text-amber-400 border-amber-700 bg-amber-950/30',
};

/** One of the four dimensions, with its component breakdown and coverage. */
function DimensionCard({ dim, title, help, accent }: {
  dim: DimensionScore; title: string; help: string; accent: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex-1 min-w-56 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`text-[11px] font-semibold uppercase tracking-wide ${accent}`}>{title}</span>
            <span title={help} className="text-zinc-600 hover:text-zinc-400 cursor-help leading-none">ⓘ</span>
          </div>
          <div className="text-[10px] text-zinc-500 mt-0.5 truncate">{dim.label}</div>
        </div>
        <div className={`text-2xl font-bold tabular-nums leading-none ${scoreColor(dim.score)}`}>
          {dim.score == null ? '—' : dim.score.toFixed(1)}
        </div>
      </div>

      <div className="bg-zinc-800 rounded-full h-1.5">
        <div className={`h-1.5 rounded-full ${scoreBg(dim.score)}`}
             style={{ width: `${(dim.score ?? 0) * 10}%` }} />
      </div>

      <div className="flex items-center justify-between text-[10px]">
        <span
          title={DIMENSION_HELP.coverage}
          className={`px-1.5 py-0.5 rounded border cursor-help ${CONFIDENCE_STYLE[dim.confidence]}`}>
          {dim.confidence === 'LOW' ? 'LOW DATA CONFIDENCE' : `${dim.confidence} CONFIDENCE`}
        </span>
        <button onClick={() => setOpen(o => !o)} className="text-zinc-500 hover:text-zinc-300">
          {dim.available}/{dim.total} inputs · {dim.coverage}% {open ? '▲' : '▼'}
        </button>
      </div>

      {open && (
        <div className="space-y-1.5 pt-1 border-t border-zinc-800">
          {dim.components.map((c, i) => (
            <div key={i} className="flex items-center gap-2 text-[11px]">
              <span className={`w-28 truncate ${c.score == null ? 'text-zinc-600' : 'text-zinc-400'}`}>{c.label}</span>
              <div className="flex-1 bg-zinc-800 rounded-full h-1">
                {c.score != null && (
                  <div className={`h-1 rounded-full ${scoreBg(c.score)}`} style={{ width: `${c.score * 10}%` }} />
                )}
              </div>
              <span className={`w-7 text-right tabular-nums ${c.score == null ? 'text-zinc-600' : 'text-zinc-300'}`}>
                {c.score == null ? '—' : c.score.toFixed(1)}
              </span>
              <span className="w-24 text-right text-zinc-600 truncate" title={c.display}>{c.display}</span>
            </div>
          ))}
          <p className="text-[10px] text-zinc-600 pt-1">
            Unavailable inputs are excluded and the remaining weights renormalised — never scored 5.0.
          </p>
        </div>
      )}
    </div>
  );
}

/** Positive / negative drivers behind one horizon score. */
function Drivers({ positives, negatives }: { positives: string[]; negatives: string[] }) {
  if (!positives.length && !negatives.length) return null;
  return (
    <div className="space-y-1 pt-2 border-t border-zinc-800">
      {positives.map((p, i) => (
        <div key={`p${i}`} className="text-[11px] text-emerald-500/90 flex gap-1.5">
          <span className="flex-shrink-0">▲</span><span>{p}</span>
        </div>
      ))}
      {negatives.map((n, i) => (
        <div key={`n${i}`} className="text-[11px] text-red-400/80 flex gap-1.5">
          <span className="flex-shrink-0">▼</span><span>{n}</span>
        </div>
      ))}
    </div>
  );
}

function DataGaps({ gaps }: { gaps: string[] }) {
  if (!gaps.length) return null;
  return (
    <div className="mt-3 space-y-1">
      {gaps.map((g, i) => (
        <div key={i} className="text-xs text-amber-600/80 flex items-start gap-1.5">
          <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
          <span>{g.replace('⚠️ ', '')}</span>
        </div>
      ))}
    </div>
  );
}

function SwingCard({ s, isBest }: { s: SwingScore; isBest: boolean }) {
  const vs = SWING_VERDICT_STYLE[s.verdict] ?? '';
  return (
    <div className={`flex-1 min-w-72 rounded-xl border p-5 flex flex-col gap-4 transition-all ${
      isBest
        ? 'border-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.25)] bg-zinc-900'
        : 'border-zinc-800 bg-zinc-900/60'
    }`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp size={14} className="text-blue-400" />
            <span className="text-sm font-semibold text-zinc-100">Swing</span>
            <span className="text-xs text-zinc-600">3–21 days</span>
            {isBest && <Star size={11} className="text-blue-400 fill-blue-400" />}
          </div>
          <div className="text-3xl font-bold tabular-nums">{s.composite.toFixed(1)}</div>
        </div>
        <span className={`text-sm font-bold px-3 py-1.5 rounded-lg ${vs}`}>{s.verdict}</span>
      </div>

      {/* Auto-disqualify / cap warning */}
      {s.autoDisqualified && (
        <div className="flex items-start gap-2 text-xs bg-red-950/50 border border-red-800 rounded-lg p-2.5">
          <AlertTriangle size={12} className="text-red-400 mt-0.5 flex-shrink-0" />
          <span className="text-red-300">{s.disqualifyReason}</span>
        </div>
      )}
      {s.cappedConditional && (
        <div className="flex items-start gap-2 text-xs bg-amber-950/50 border border-amber-800 rounded-lg p-2.5">
          <AlertTriangle size={12} className="text-amber-400 mt-0.5 flex-shrink-0" />
          <span className="text-amber-300">{s.capReason}</span>
        </div>
      )}

      {/* Category scores */}
      <div className="space-y-2">
        <ScoreBar label="Technical Setup"    score={s.technicalScore}  weight={0.40} />
        <ScoreBar label="Near-Term Catalyst" score={s.catalystScore}   weight={0.25} />
        <ScoreBar label="Risk & Liquidity"   score={s.riskScore}       weight={0.25} />
        <ScoreBar label="Sentiment & Flow"   score={s.sentimentScore}  weight={0.10} />
      </div>

      {/* Trade levels */}
      {s.position && (
        <div className="border-t border-zinc-800 pt-3 space-y-2">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">Trade Setup</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <span className="text-zinc-500">Entry</span>
            <span className="tabular-nums font-mono">{fmtCurrency(s.position.entry)}</span>
            <span className="text-zinc-500">Stop</span>
            <span className="tabular-nums font-mono text-red-400">{fmtCurrency(s.position.stop)}</span>
            <span className="text-zinc-500">Stop %</span>
            <span className="tabular-nums font-mono text-red-400">{(s.position.stopPct * 100).toFixed(1)}%</span>
            <span className="text-zinc-500">Target</span>
            <span className="tabular-nums font-mono text-emerald-400">{fmtCurrency(s.position.target)}</span>
            <span className="text-zinc-500">R:R</span>
            <span className="tabular-nums font-mono text-blue-400">{s.position.rrRatio.toFixed(1)}:1</span>
          </div>
          <div className="border-t border-zinc-800 pt-2 mt-1">
            <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-1.5">Position Sizing</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
              <span className="text-zinc-500">Risk {(s.position.riskPct * 100).toFixed(0)}%</span>
              <span className="tabular-nums font-mono">{fmtCurrency(s.position.riskAmount)}</span>
              <span className="text-zinc-500">Position $</span>
              <span className="tabular-nums font-mono font-semibold">{fmtCurrency(s.position.positionValue)}</span>
              <span className="text-zinc-500">Shares</span>
              <span className="tabular-nums font-mono font-semibold">~{s.position.shares}</span>
            </div>
          </div>
        </div>
      )}
      {!s.position && s.verdict !== 'NO GO' && (
        <div className="text-xs text-zinc-600 border-t border-zinc-800 pt-3">
          Set account size above to see position sizing.
        </div>
      )}

      <DataGaps gaps={s.dataGaps} />
    </div>
  );
}

function MediumCard({ m, isBest }: { m: MediumScore; isBest: boolean }) {
  const vs = SWING_VERDICT_STYLE[m.verdict] ?? '';
  return (
    <div className={`flex-1 min-w-72 rounded-xl border p-5 flex flex-col gap-4 transition-all ${
      isBest
        ? 'border-purple-500 shadow-[0_0_20px_rgba(168,85,247,0.25)] bg-zinc-900'
        : 'border-zinc-800 bg-zinc-900/60'
    }`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <BarChart2 size={14} className="text-purple-400" />
            <span className="text-sm font-semibold text-zinc-100">Medium Term</span>
            <span className="text-xs text-zinc-600">6–12 months</span>
            {isBest && <Star size={11} className="text-purple-400 fill-purple-400" />}
          </div>
          <div className="text-3xl font-bold tabular-nums">{m.composite.toFixed(1)}</div>
        </div>
        <span className={`text-sm font-bold px-3 py-1.5 rounded-lg ${vs}`}>{m.verdict}</span>
      </div>

      <div className="space-y-2">
        <ScoreBar label="Fundamental Quality" score={m.fundamentalScore} weight={0.35} />
        <ScoreBar label="Technical Entry"     score={m.technicalScore}   weight={0.25} />
        <ScoreBar label="Risk & Macro"        score={m.riskScore}        weight={0.25} />
        <ScoreBar label="Catalyst Pipeline"   score={m.catalystScore}    weight={0.15} />
      </div>

      <div className="border-t border-zinc-800 pt-3 space-y-2 text-xs">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">Guidance</div>
        {m.target12m && (
          <div className="flex justify-between">
            <span className="text-zinc-500">12-month target</span>
            <span className="tabular-nums font-mono text-emerald-400">{fmtCurrency(m.target12m)}</span>
          </div>
        )}
        <div>
          <span className="text-zinc-500 block mb-1">Thesis stop:</span>
          <span className="text-zinc-300 leading-relaxed">{m.thesisStop}</span>
        </div>
        <div className="flex justify-between items-center pt-1">
          <span className="text-zinc-500">Position size</span>
          <span className="text-blue-300 font-medium">{m.positionGuidance}</span>
        </div>
      </div>

      <DataGaps gaps={m.dataGaps} />
    </div>
  );
}

function LongCard({ l, isBest }: { l: LongScore; isBest: boolean }) {
  const vs = LONG_VERDICT_STYLE[l.verdict] ?? '';
  const moatColor = l.moatRating === 'STRONG' ? 'text-emerald-400' : l.moatRating === 'MODERATE' ? 'text-blue-400' : l.moatRating === 'WEAK' ? 'text-amber-400' : 'text-red-400';
  return (
    <div className={`flex-1 min-w-72 rounded-xl border p-5 flex flex-col gap-4 transition-all ${
      isBest
        ? 'border-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.25)] bg-zinc-900'
        : 'border-zinc-800 bg-zinc-900/60'
    }`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Clock size={14} className="text-emerald-400" />
            <span className="text-sm font-semibold text-zinc-100">Long Term</span>
            <span className="text-xs text-zinc-600">2+ years</span>
            {isBest && <Star size={11} className="text-emerald-400 fill-emerald-400" />}
          </div>
          <div className="text-3xl font-bold tabular-nums">{l.composite.toFixed(1)}</div>
        </div>
        <span className={`text-sm font-bold px-3 py-1.5 rounded-lg ${vs}`}>{l.verdict}</span>
      </div>

      <div className="space-y-2">
        <ScoreBar label="Business Quality / Moat" score={l.moatScore}        weight={0.40} />
        <ScoreBar label="Financial Durability"     score={l.durabilityScore}  weight={0.25} />
        <ScoreBar label="Growth Runway"            score={l.growthScore}      weight={0.20} />
        <ScoreBar label="Valuation / Entry"        score={l.valuationScore}   weight={0.15} />
      </div>

      <div className="border-t border-zinc-800 pt-3 space-y-2.5 text-xs">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">Thesis</div>
        <div className="flex items-center gap-2">
          <span className="text-zinc-500">Moat</span>
          <span className={`font-semibold ${moatColor}`}>{l.moatRating}</span>
        </div>
        <p className="text-zinc-400 leading-relaxed">{l.thesis}</p>
        <div>
          <span className="text-zinc-500 block mb-1">Exit condition:</span>
          <span className="text-zinc-400 leading-relaxed">{l.exitCondition}</span>
        </div>
        <div className="flex justify-between items-center pt-1">
          <span className="text-zinc-500">Position size</span>
          <span className="text-emerald-300 font-medium">{l.positionGuidance}</span>
        </div>
      </div>

      <DataGaps gaps={l.dataGaps} />
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
export default function TriFrameScorecard() {
  const [tickerInput, setTickerInput] = useState('');
  const [result, setResult] = useState<TriFrameResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [yahooData, setYahooData] = useState<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [finnhubMetrics, setFinnhubMetrics] = useState<any>(null);
  const [finnhubEarnings, setFinnhubEarnings] = useState<FinnhubEarnings[] | null>(null);
  const [addedToWatch, setAddedToWatch] = useState(false);
  const [addingWatch,  setAddingWatch]  = useState(false);
  const [headerEntry,  setHeaderEntry]  = useState('');
  const [headerExit,   setHeaderExit]   = useState('');

  // Four-dimension scorecard (separate from the legacy tri-frame result)
  const [scorecard, setScorecard] = useState<ScorecardResult | null>(null);
  const [sectorCtx, setSectorCtx] = useState<SectorContext | null>(null);
  const rawRef = useRef<{ ticker: string; quote: any; yahoo: any; metrics: any; sentiment: any } | null>(null);

  // Supplemental data
  const [newsData,    setNewsData]    = useState<Array<{headline:string;source:string;datetime:number;url:string;summary:string}>>([]);
  const [epsEstData,  setEpsEstData]  = useState<Array<{epsAvg:number;period:string;year:number}>>([]);
  const [revEstData,  setRevEstData]  = useState<Array<{revenueAvg:number;period:string;year:number}>>([]);

  // Thesis / investment notes
  const [bullCase,     setBullCase]     = useState('');
  const [bearCase,     setBearCase]     = useState('');
  const [thesisNote,   setThesisNote]   = useState('');
  const [notesSaving,  setNotesSaving]  = useState(false);
  const [notesId,      setNotesId]      = useState<string | null>(null);
  const [notesSaved,   setNotesSaved]   = useState(false);

  // Account size
  const [accountSize, setAccountSize] = useState<number>(() => loadSettings().accountSize ?? 0);
  const [editingAccount, setEditingAccount] = useState(false);
  const [accountInput, setAccountInput] = useState('');
  const accountRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editingAccount) accountRef.current?.focus(); }, [editingAccount]);

  // Real balances published by Portfolio — re-read on mount so a fresh
  // Portfolio load is picked up when the user switches back to this tab.
  const [snapshot, setSnapshot] = useState(() => readAccountSnapshot());
  useEffect(() => { setSnapshot(readAccountSnapshot()); }, []);

  function applyAccountSize(v: number) {
    setAccountSize(v);
    saveSettings({ accountSize: v });
    setEditingAccount(false);
  }

  // ── Thesis notes helpers ──────────────────────────────────────────────────
  async function loadNotes(ticker: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = await storage.getAll<any>('fundamentals');
    const ex  = all.find((n: { ticker: string }) => n.ticker === ticker);
    if (ex) { setBullCase(ex.bull_case ?? ''); setBearCase(ex.bear_case ?? ''); setThesisNote(ex.notes ?? ''); setNotesId(ex.id); }
    else    { setBullCase(''); setBearCase(''); setThesisNote(''); setNotesId(null); }
  }

  async function saveNotes() {
    if (!result?.ticker) return;
    setNotesSaving(true);
    try {
      const patch = { bull_case: bullCase, bear_case: bearCase, notes: thesisNote };
      if (notesId) {
        await storage.update('fundamentals', notesId, patch);
      } else {
        const row = { id: newId(), ticker: result.ticker, ...patch, created_at: nowIso() };
        await storage.insert('fundamentals', row);
        setNotesId(row.id);
      }
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2000);
    } finally { setNotesSaving(false); }
  }

  function commitAccountSize() {
    const v = parseFloat(accountInput.replace(/,/g, ''));
    if (!isNaN(v) && v > 0) {
      setAccountSize(v);
      saveSettings({ accountSize: v });
    }
    setEditingAccount(false);
  }

  async function handleScore(e: React.FormEvent) {
    e.preventDefault();
    const t = tickerInput.trim().toUpperCase();
    if (!t) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setFinnhubMetrics(null);
    setFinnhubEarnings(null);

    try {
      // TSX and other exchange suffixes — strip for Finnhub, keep for Yahoo Finance
      const SUFFIXES = ['.TO', '.V', '.TSX', '.CN', '.NEO', '.VN'];
      const suffix = SUFFIXES.find(s => t.endsWith(s)) ?? null;
      const finnhubTicker = suffix ? t.slice(0, t.length - suffix.length) : t;
      const yahooTicker   = t;

      const [quoteRes, profileRes, metricsRes, sentimentRes, yahooRes, earningsRes] = await Promise.allSettled([
        finnhub.quote(finnhubTicker),
        finnhub.profile(finnhubTicker),
        finnhub.metrics(finnhubTicker),
        finnhub.sentiment(finnhubTicker),
        fetchYahoo(yahooTicker),
        finnhub.earnings(finnhubTicker),
      ]);

      const finnhubQuote   = quoteRes.status   === 'fulfilled' ? quoteRes.value   : null;
      const finnhubProfile = profileRes.status === 'fulfilled' ? profileRes.value : null;
      const metrics        = metricsRes.status === 'fulfilled' ? metricsRes.value : null;
      const sentiment      = sentimentRes.status === 'fulfilled' ? sentimentRes.value : null;
      const yahoo          = yahooRes.status    === 'fulfilled' ? yahooRes.value   : {};
      const earningsHist   = earningsRes.status === 'fulfilled' ? earningsRes.value : null;

      // For exchange-suffix tickers (e.g. .TO) Finnhub may return the wrong company
      // (T → AT&T instead of Telus). Detect by checking if the exchange is non-Canadian.
      const fExchange = finnhubProfile?.exchange?.toLowerCase() ?? '';
      const isCanadian = fExchange.includes('tsx') || fExchange.includes('toronto') ||
                         fExchange.includes('canada') || fExchange.includes('cnq');
      const finnhubWrongStock = suffix && finnhubProfile && !isCanadian;

      // Build authoritative quote — prefer Yahoo Finance price for exchange-suffix tickers
      const yp = yahoo.price;
      const yfPrice = yp?.regularMarketPrice ?? null;
      const sd = yahoo.summaryDetail;

      let quote = finnhubQuote;
      if (suffix && yfPrice) {
        // Synthesise a quote object from Yahoo Finance data
        quote = {
          c:  yfPrice,
          d:  0,
          dp: 0,
          h:  yp?.regularMarketDayHigh ?? sd?.dayHigh ?? yfPrice,
          l:  yp?.regularMarketDayLow  ?? sd?.dayLow  ?? yfPrice,
          o:  yp?.regularMarketOpen    ?? sd?.open     ?? yfPrice,
          pc: yp?.regularMarketPreviousClose ?? sd?.previousClose ?? yfPrice,
        };
      }

      // Build authoritative profile — use Yahoo Finance when Finnhub is wrong/missing
      let profile = finnhubWrongStock ? null : finnhubProfile;
      if (!profile) {
        if (yp?.longName ?? yp?.shortName) {
          profile = {
            name:                   yp?.longName ?? yp?.shortName ?? t,
            ticker:                 t,
            exchange:               yp?.fullExchangeName ?? yp?.exchangeName ?? (suffix ? 'TSX' : ''),
            finnhubIndustry:        '',
            marketCapitalization:   (yp?.marketCap ?? sd?.marketCap ?? 0) / 1e6,
            shareOutstanding:       0,
            logo:                   '',
            weburl:                 '',
          };
        }
      }

      if (!quote?.c || !profile?.name) {
        setError(`Could not find data for "${t}". Check the ticker symbol and try again.`);
        return;
      }

      const res = runTriFrame(t, quote, profile, metrics, sentiment, yahoo, accountSize);
      setResult(res);

      // Four-dimension scorecard. Sector rotation isn't loaded yet, so Market
      // Alignment starts without it and is recomputed below once it arrives —
      // it is left unavailable rather than filled with a neutral value.
      rawRef.current = { ticker: t, quote, yahoo, metrics, sentiment };
      setSectorCtx(null);
      setScorecard(runScorecard({
        ticker: t,
        quality:   buildQualityInputs(yahoo, metrics),
        valuation: buildValuationInputs(yahoo, metrics),
        technical: buildTechnicalInputs(quote, yahoo, metrics),
        alignment: buildAlignmentInputs(metrics, sentiment, null, null),
      }));

      setYahooData(yahoo);
      setFinnhubMetrics(metrics);
      setFinnhubEarnings(earningsHist);
      setAddedToWatch(false);
      setHeaderEntry('');
      setHeaderExit('');
      setNewsData([]);
      setEpsEstData([]);
      setRevEstData([]);

      // Fire supplemental fetches in background — don't block score display
      void (async () => {
        const [newsR, epsR, revR] = await Promise.allSettled([
          finnhub.news(finnhubTicker),
          finnhub.epsEstimate(finnhubTicker),
          finnhub.revenueEstimate(finnhubTicker),
        ]);
        if (newsR.status === 'fulfilled') setNewsData(newsR.value.slice(0, 8));
        if (epsR.status  === 'fulfilled') setEpsEstData(epsR.value?.data?.slice(0, 4) ?? []);
        if (revR.status  === 'fulfilled') setRevEstData(revR.value?.data?.slice(0, 4) ?? []);
      })();

      // Sector rotation loads separately — it drives Market Alignment only.
      // Company Quality and Valuation are untouched by it and never re-scored.
      void (async () => {
        try {
          const ctx = await fetchSectorContext(t, profile?.finnhubIndustry);
          const raw = rawRef.current;
          if (!ctx || !raw || raw.ticker !== t) return;
          setSectorCtx(ctx);
          setScorecard(runScorecard({
            ticker: t,
            quality:   buildQualityInputs(raw.yahoo, raw.metrics),
            valuation: buildValuationInputs(raw.yahoo, raw.metrics),
            technical: buildTechnicalInputs(raw.quote, raw.yahoo, raw.metrics),
            alignment: buildAlignmentInputs(raw.metrics, raw.sentiment, ctx.pressure, ctx.ret1M),
          }));
        } catch { /* rotation is optional — alignment simply stays partial */ }
      })();

      void loadNotes(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error — check console.');
    } finally {
      setLoading(false);
    }
  }

  async function handleAddToWatchlist() {
    if (!result) return;
    setAddingWatch(true);
    try {
      await storage.insert(TABLE_WATCH, {
        id:             newId(),
        ticker:         result.ticker,
        conviction:     'MEDIUM',
        notes:          headerExit ? `Target exit: $${headerExit}` : '',
        watch_price:    result.currentPrice,
        watch_date:     new Date().toISOString().split('T')[0],
        analyst_target: headerExit  ? parseFloat(headerExit)  : null,
        target_entry:   headerEntry ? parseFloat(headerEntry) : null,
        created_at:     nowIso(),
      });
      setAddedToWatch(true);
    } catch { /* ignore */ } finally {
      setAddingWatch(false);
    }
  }

  const bf = result?.bestFit.frame;

  return (
    <div className="space-y-6">
      {/* Search + account size header */}
      <div className="card">
        <div className="flex flex-wrap gap-4 items-end">
          {/* Ticker search */}
          <form onSubmit={handleScore} className="flex gap-2 items-end flex-1 min-w-64">
            <div className="flex-1">
              <label className="label">Ticker</label>
              <input
                className="input-base uppercase text-lg font-mono"
                placeholder="AAPL, SHOP.TO, NVDA…"
                value={tickerInput}
                onChange={(e) => setTickerInput(e.target.value)}
                disabled={loading}
              />
            </div>
            <button type="submit" disabled={loading || !tickerInput.trim()} className="btn-primary flex items-center gap-2 h-9">
              <Search size={14} />
              {loading ? 'Scoring…' : 'Score'}
            </button>
          </form>

          {/* Account size */}
          <div className="flex-shrink-0">
            <label className="label">Swing Account Size</label>
            {editingAccount ? (
              <div className="flex items-center gap-1">
                <input
                  ref={accountRef}
                  type="text"
                  className="w-32 bg-zinc-800 border border-blue-500 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none"
                  placeholder="e.g. 25000"
                  value={accountInput}
                  onChange={(e) => setAccountInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitAccountSize(); if (e.key === 'Escape') setEditingAccount(false); }}
                />
                <button onClick={commitAccountSize} className="text-emerald-400 p-1"><Check size={14} /></button>
                <button onClick={() => setEditingAccount(false)} className="text-zinc-500 p-1"><X size={14} /></button>
              </div>
            ) : (
              <button
                onClick={() => { setAccountInput(accountSize ? accountSize.toString() : ''); setEditingAccount(true); }}
                className="group flex items-center gap-2 h-9 px-3 rounded bg-zinc-800 border border-zinc-700 hover:border-zinc-500 transition-colors text-sm"
              >
                {accountSize > 0
                  ? <span className="font-mono tabular-nums">${accountSize.toLocaleString()}</span>
                  : <span className="text-zinc-500">Set account size…</span>
                }
                <Pencil size={11} className="opacity-0 group-hover:opacity-60 transition-opacity text-zinc-400" />
              </button>
            )}
          </div>
        </div>

        {/* Real account balances published by the Portfolio tab */}
        {snapshot && (
          <div className="mt-3 pt-3 border-t border-zinc-800">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs text-zinc-500">Use a real account balance:</span>
              <span className="text-[10px] text-zinc-600">
                from Portfolio, {snapshotAgeLabel(snapshot)}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(snapshot.byAccount)
                .filter(([, v]) => v > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([name, value]) => (
                  <button
                    key={name}
                    onClick={() => applyAccountSize(Math.round(value))}
                    className={`px-2.5 py-1.5 rounded border text-xs transition-colors ${
                      Math.round(value) === accountSize
                        ? 'border-blue-500 bg-blue-950/40 text-blue-300'
                        : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500'
                    }`}
                  >
                    {name} <span className="font-mono tabular-nums ml-1">
                      ${Math.round(value).toLocaleString()}
                    </span>
                  </button>
                ))}
              <button
                onClick={() => applyAccountSize(Math.round(snapshot.totalCAD))}
                className={`px-2.5 py-1.5 rounded border text-xs transition-colors ${
                  Math.round(snapshot.totalCAD) === accountSize
                    ? 'border-blue-500 bg-blue-950/40 text-blue-300'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500'
                }`}
              >
                All accounts <span className="font-mono tabular-nums ml-1">
                  ${Math.round(snapshot.totalCAD).toLocaleString()}
                </span>
              </button>
            </div>
            <p className="text-[10px] text-zinc-600 mt-1.5">
              Values are CAD market value. Sizing a USD trade against a CAD balance
              overstates the share count — convert first if the ticker trades in USD.
            </p>
          </div>
        )}

        {accountSize === 0 && (
          <p className="text-xs text-amber-600/80 mt-2 flex items-center gap-1.5">
            <AlertTriangle size={11} />
            {snapshot
              ? 'Pick an account above, or type a size, to enable position sizing.'
              : 'Set your swing account size to enable position sizing calculations. Open the Portfolio tab once to pull real account balances here.'}
          </p>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="card border-red-800 bg-red-950/30 text-red-300 text-sm flex items-center gap-2">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="card flex items-center justify-center gap-3 py-12 text-zinc-500 text-sm">
          <div className="w-4 h-4 border-2 border-zinc-600 border-t-blue-500 rounded-full animate-spin" />
          Fetching data from Finnhub + Yahoo Finance…
        </div>
      )}

      {/* Results */}
      {result && !loading && (
        <>
          {/* Company header */}
          <div className="card">
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <div className="font-mono font-bold text-blue-400 text-2xl">{result.ticker}</div>
              <div className="text-zinc-200 font-semibold text-lg">{result.companyName}</div>
              <span className={`text-xs px-2 py-0.5 rounded border bg-zinc-800 ${TIER_BADGE[result.tier]}`}>
                {result.tier} CAP
              </span>
              <span className="text-xs text-zinc-500">{result.exchange}</span>
              <span className="text-xs text-zinc-600">·</span>
              <span className="text-xs text-zinc-500">{result.industry}</span>
              <div className="ml-auto flex items-center gap-3 flex-wrap justify-end">
                {/* Price */}
                <div className="text-right">
                  <div className="text-2xl font-bold tabular-nums">{fmtCurrency(result.currentPrice)}</div>
                  <div className="text-xs text-zinc-500">
                    Mkt cap: {result.marketCap >= 1e12
                      ? `$${(result.marketCap / 1e12).toFixed(2)}T`
                      : result.marketCap >= 1e9
                      ? `$${(result.marketCap / 1e9).toFixed(1)}B`
                      : `$${(result.marketCap / 1e6).toFixed(0)}M`}
                  </div>
                </div>

                {/* Entry / Exit inputs */}
                <div className="flex items-center gap-2">
                  <div>
                    <label className="text-[10px] text-zinc-500 block mb-0.5">Entry $</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="—"
                      value={headerEntry}
                      onChange={(e) => setHeaderEntry(e.target.value)}
                      className="w-24 bg-zinc-800 border border-zinc-700 focus:border-blue-500 rounded px-2 py-1.5 text-sm font-mono text-zinc-100 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-500 block mb-0.5">Exit / Target $</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="—"
                      value={headerExit}
                      onChange={(e) => setHeaderExit(e.target.value)}
                      className="w-24 bg-zinc-800 border border-zinc-700 focus:border-blue-500 rounded px-2 py-1.5 text-sm font-mono text-zinc-100 focus:outline-none"
                    />
                  </div>
                </div>

                {/* Watch List button */}
                <button
                  onClick={handleAddToWatchlist}
                  disabled={addingWatch || addedToWatch}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    addedToWatch
                      ? 'bg-emerald-900/50 text-emerald-400 border border-emerald-700 cursor-default'
                      : 'bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50'
                  }`}
                >
                  <Eye size={13} />
                  {addedToWatch ? 'Added!' : addingWatch ? 'Adding…' : 'Watch List'}
                </button>
              </div>
            </div>

            {/* Market data row: MAs + short interest + earnings */}
            {(() => {
              const sd  = yahooData?.summaryDetail;
              const ks  = yahooData?.defaultKeyStatistics;
              const ma50  = yNum(sd?.fiftyDayAverage);
              const ma200 = yNum(sd?.twoHundredDayAverage);
              const wk52Hi = yNum(sd?.fiftyTwoWeekHigh);
              const wk52Lo = yNum(sd?.fiftyTwoWeekLow);
              // Short interest: Yahoo is primary; fall back to Finnhub shortInterest/sharesFloat ratio
              const yahooShortPct = yNum(ks?.shortPercentOfFloat) ?? yNum(sd?.shortPercentOfFloat);
              const fm = finnhubMetrics?.metric;
              const finnhubShortPct =
                fm?.shortInterest != null && fm?.sharesFloat != null && fm.sharesFloat > 0
                  ? fm.shortInterest / fm.sharesFloat
                  : null;
              const shortPct = yahooShortPct ?? finnhubShortPct;
              const earningsDate = getNextEarningsDate(yahooData) ?? estimateNextEarnings(finnhubEarnings);
              const cp = result.currentPrice;

              return (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  <div className="bg-zinc-800/50 rounded-lg px-3 py-2">
                    <div className="text-xs text-zinc-500 mb-0.5">50D MA</div>
                    <div className={`text-sm font-semibold tabular-nums ${ma50 ? (cp > ma50 ? 'text-emerald-400' : 'text-red-400') : 'text-zinc-300'}`}>
                      {ma50 ? fmtCurrency(ma50) : '—'}
                    </div>
                    {ma50 && <div className="text-xs text-zinc-600">{cp > ma50 ? '▲ above' : '▼ below'}</div>}
                  </div>
                  <div className="bg-zinc-800/50 rounded-lg px-3 py-2">
                    <div className="text-xs text-zinc-500 mb-0.5">200D MA</div>
                    <div className={`text-sm font-semibold tabular-nums ${ma200 ? (cp > ma200 ? 'text-emerald-400' : 'text-red-400') : 'text-zinc-300'}`}>
                      {ma200 ? fmtCurrency(ma200) : '—'}
                    </div>
                    {ma200 && <div className="text-xs text-zinc-600">{cp > ma200 ? '▲ above' : '▼ below'}</div>}
                  </div>
                  <div className="bg-zinc-800/50 rounded-lg px-3 py-2">
                    <div className="text-xs text-zinc-500 mb-0.5">Short Interest</div>
                    <div className="text-sm font-semibold tabular-nums text-zinc-300">
                      {shortPct != null ? `${(shortPct * 100).toFixed(1)}%` : '—'}
                    </div>
                  </div>
                  <div className="bg-zinc-800/50 rounded-lg px-3 py-2">
                    <div className="text-xs text-zinc-500 mb-0.5">
                      Next Earnings{earningsDate?.startsWith('~') ? <span className="text-zinc-600 ml-1">est.</span> : null}
                    </div>
                    <div className="text-sm font-semibold tabular-nums text-amber-300">
                      {earningsDate ? earningsDate.replace(/^~/, '') : '—'}
                    </div>
                  </div>
                  <div className="bg-zinc-800/50 rounded-lg px-3 py-2">
                    <div className="text-xs text-zinc-500 mb-0.5">52W Range</div>
                    <div className="text-xs font-semibold tabular-nums text-zinc-300">
                      {wk52Lo && wk52Hi ? `${fmtCurrency(wk52Lo)} – ${fmtCurrency(wk52Hi)}` : '—'}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Four independent dimensions — scored before any horizon blend */}
          {scorecard && (
            <div className="card">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-100">What This Stock Is</h3>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Four separate questions. A great business can have a poor entry — these are
                    measured independently and never averaged into one verdict.
                  </p>
                </div>
                {sectorCtx && (
                  <div className="text-right flex-shrink-0">
                    <div className="text-[10px] text-zinc-500 uppercase tracking-wide">Sector</div>
                    <div className="text-xs text-zinc-300">{sectorCtx.name} ({sectorCtx.etf})</div>
                    <div className={`text-xs tabular-nums ${sectorCtx.pressure >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      pressure {sectorCtx.pressure >= 0 ? '+' : ''}{sectorCtx.pressure}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-3">
                <DimensionCard dim={scorecard.dimensions.companyQuality}
                  title="Company Quality" accent="text-emerald-400" help={DIMENSION_HELP.companyQuality} />
                <DimensionCard dim={scorecard.dimensions.valuation}
                  title="Valuation" accent="text-sky-400" help={DIMENSION_HELP.valuation} />
                <DimensionCard dim={scorecard.dimensions.technicalSetup}
                  title="Technical Setup" accent="text-blue-400" help={DIMENSION_HELP.technicalSetup} />
                <DimensionCard dim={scorecard.dimensions.marketAlignment}
                  title="Market Alignment" accent="text-purple-400" help={DIMENSION_HELP.marketAlignment} />
              </div>

              {scorecard.overallCoverage < 80 && (
                <div className="mt-3 text-xs text-amber-500/90 flex items-start gap-1.5">
                  <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                  <span>
                    Overall data coverage {scorecard.overallCoverage}%. Scores are computed from the inputs that
                    exist and the remaining weights renormalised — missing data lowers confidence, not the score.
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Horizon scores built from those four dimensions */}
          {scorecard && (
            <div className="card">
              <h3 className="text-sm font-semibold text-zinc-100 mb-1">Opportunity by Horizon</h3>
              <p className="text-xs text-zinc-500 mb-3">
                The same four dimensions, weighted differently for each holding period.
              </p>
              <div className="flex flex-col lg:flex-row gap-3">
                {(['swing', 'medium', 'long'] as const).map(key => {
                  const h = scorecard.horizons[key];
                  const meta = HORIZON_LABELS[key];
                  const best = scorecard.bestFit.key === key;
                  return (
                    <div key={key} className={`flex-1 min-w-64 rounded-xl border p-4 flex flex-col gap-2 ${
                      best ? 'border-zinc-500 bg-zinc-900' : 'border-zinc-800 bg-zinc-900/50'
                    }`}>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-xs font-semibold text-zinc-200">{meta.title}</div>
                          <div className="text-[10px] text-zinc-500">{meta.window}</div>
                        </div>
                        <div className="text-right">
                          <div className={`text-2xl font-bold tabular-nums leading-none ${scoreColor(h.score)}`}>
                            {h.score == null ? '—' : h.score.toFixed(1)}
                          </div>
                          <div className="text-[10px] text-zinc-500 mt-0.5">{h.label}</div>
                        </div>
                      </div>
                      <div className="bg-zinc-800 rounded-full h-1.5">
                        <div className={`h-1.5 rounded-full ${scoreBg(h.score)}`} style={{ width: `${(h.score ?? 0) * 10}%` }} />
                      </div>
                      <div className="space-y-0.5">
                        {h.contributions.map((c, i) => (
                          <div key={i} className="flex items-center justify-between text-[10px]">
                            <span className={c.score == null ? 'text-zinc-600' : 'text-zinc-500'}>
                              {c.label} <span className="text-zinc-700">{c.weight}%</span>
                            </span>
                            <span className={`tabular-nums ${c.score == null ? 'text-zinc-600' : 'text-zinc-400'}`}>
                              {c.score == null ? 'excluded' : c.score.toFixed(1)}
                            </span>
                          </div>
                        ))}
                      </div>
                      <Drivers positives={h.positives} negatives={h.negatives} />
                    </div>
                  );
                })}
              </div>

              {/* Best fit, explained */}
              {scorecard.bestFit.key && (
                <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-800/40 p-3 flex items-start gap-2">
                  <Star size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="text-xs font-semibold text-zinc-100 mb-0.5">
                      Best Fit: {HORIZON_LABELS[scorecard.bestFit.key].title} ({HORIZON_LABELS[scorecard.bestFit.key].window})
                    </div>
                    <div className="text-xs text-zinc-400">{scorecard.bestFit.reason}</div>
                  </div>
                </div>
              )}

              {/* What would move the score */}
              {(scorecard.levers.improve.length > 0 || scorecard.levers.weaken.length > 0) && (
                <div className="mt-3 grid md:grid-cols-2 gap-3">
                  {scorecard.levers.improve.length > 0 && (
                    <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/20 p-3">
                      <div className="text-xs font-semibold text-emerald-400 mb-1.5">What Would Improve the Setup</div>
                      <ul className="space-y-1">
                        {scorecard.levers.improve.map((x, i) => (
                          <li key={i} className="text-xs text-zinc-400 flex gap-1.5">
                            <span className="text-emerald-600 flex-shrink-0">→</span><span>{x}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {scorecard.levers.weaken.length > 0 && (
                    <div className="rounded-lg border border-red-900/60 bg-red-950/20 p-3">
                      <div className="text-xs font-semibold text-red-400 mb-1.5">What Would Weaken It</div>
                      <ul className="space-y-1">
                        {scorecard.levers.weaken.map((x, i) => (
                          <li key={i} className="text-xs text-zinc-400 flex gap-1.5">
                            <span className="text-red-700 flex-shrink-0">→</span><span>{x}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 3 cards */}
          <div className="flex flex-col lg:flex-row gap-4">
            <SwingCard  s={result.swing}  isBest={bf === 'SWING'} />
            <MediumCard m={result.medium} isBest={bf === 'MEDIUM'} />
            <LongCard   l={result.long}   isBest={bf === 'LONG'} />
          </div>

          {/* Best fit banner */}
          <div className={`card flex items-start gap-3 border ${
            bf === 'SWING'  ? 'border-blue-700 bg-blue-950/30' :
            bf === 'MEDIUM' ? 'border-purple-700 bg-purple-950/30' :
                              'border-emerald-700 bg-emerald-950/30'
          }`}>
            <Star size={16} className={`mt-0.5 flex-shrink-0 ${
              bf === 'SWING' ? 'text-blue-400' : bf === 'MEDIUM' ? 'text-purple-400' : 'text-emerald-400'
            }`} />
            <div>
              <div className="text-sm font-semibold text-zinc-100 mb-0.5">
                Best Fit: {result.bestFit.frame === 'SWING' ? 'Swing (3–21 days)' : result.bestFit.frame === 'MEDIUM' ? 'Medium Term (6–12 months)' : 'Long Term (2+ years)'}
              </div>
              <div className="text-sm text-zinc-400">{result.bestFit.reason}</div>
            </div>
          </div>

          {/* Risk flags */}
          {result.riskFlags.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-zinc-100 mb-3 flex items-center gap-2">
                <AlertTriangle size={14} className="text-amber-400" /> Risk Flags
              </h3>
              {/* Definitions live in tooltips — the values are what matter at a glance */}
              <div className="flex flex-wrap gap-3">
                {result.riskFlags.map((f, i) => {
                  const def = FLAG_DEFINITIONS[f.label];
                  const tip = def ? `${f.label}\n${def.summary}\n\n${def.bullets.join('\n')}` : f.label;
                  return (
                    <div key={i} title={tip}
                         className="bg-zinc-800 rounded-lg px-3 py-2 flex flex-col gap-0.5 cursor-help hover:bg-zinc-750 border border-transparent hover:border-zinc-700">
                      <span className="text-xs text-zinc-500 flex items-center gap-1">
                        {f.label}{def && <span className="text-zinc-600">ⓘ</span>}
                      </span>
                      <span className={`text-sm font-semibold tabular-nums ${FLAG_SEVERITY[f.severity]}`}>{f.value}</span>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-zinc-600 mt-2">Hover any flag for how to read it.</p>
            </div>
          )}

          <div className="text-xs text-zinc-700 text-right">
            Scored {new Date(result.scoredAt).toLocaleString()} · Finnhub + Yahoo Finance
          </div>

          {/* ── KEY FUNDAMENTALS ─────────────────────────────────────────── */}
          {(() => {
            const sd  = yahooData?.summaryDetail;
            const ks  = yahooData?.defaultKeyStatistics;
            const fd  = yahooData?.financialData;
            const fm  = finnhubMetrics?.metric;
            const rec = fd?.recommendationKey?.replace(/_/g, ' ').toUpperCase();
            const recColor = !rec ? 'text-zinc-400' :
              rec.includes('STRONG BUY') ? 'text-emerald-300' : rec.includes('BUY') ? 'text-emerald-400' :
              rec.includes('HOLD') ? 'text-amber-400' : 'text-red-400';
            return (
              <div className="card">
                <h3 className="text-sm font-bold text-zinc-100 mb-4 flex items-center gap-2">
                  <BarChart2 size={14} className="text-blue-400" /> Key Fundamentals
                </h3>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                  {/* Valuation */}
                  <div>
                    <div className="text-[10px] font-bold text-blue-400 uppercase tracking-widest mb-2">Valuation</div>
                    <div className="space-y-0">
                      {[
                        { label: 'Market Cap',   val: fmtLarge(yNum(sd?.marketCap) ?? (result.marketCap ?? null)) },
                        { label: 'P/E TTM',      val: yNum(sd?.trailingPE) != null ? `${yNum(sd?.trailingPE)!.toFixed(1)}x` : fm?.peBasicExclExtraTTM != null ? `${fm.peBasicExclExtraTTM.toFixed(1)}x` : '—' },
                        { label: 'Forward P/E',  val: yNum(ks?.forwardPE) != null ? `${yNum(ks?.forwardPE)!.toFixed(1)}x` : yNum(sd?.forwardPE) != null ? `${yNum(sd?.forwardPE)!.toFixed(1)}x` : '—' },
                        { label: 'PEG Ratio',    val: yNum(ks?.pegRatio) != null ? `${yNum(ks?.pegRatio)!.toFixed(2)}` : '—' },
                        { label: 'Price / Book', val: yNum(ks?.priceToBook) != null ? `${yNum(ks?.priceToBook)!.toFixed(2)}x` : fm?.pbAnnual != null ? `${fm.pbAnnual.toFixed(2)}x` : '—' },
                        { label: 'Beta',         val: yNum(sd?.beta) != null ? yNum(sd?.beta)!.toFixed(2) : fm?.beta != null ? fm.beta.toFixed(2) : '—' },
                        { label: 'Div Yield',    val: fm?.dividendYieldIndicatedAnnual != null && fm.dividendYieldIndicatedAnnual > 0 ? `${fm.dividendYieldIndicatedAnnual.toFixed(2)}%` : '—' },
                        { label: 'Trailing EPS', val: yNum(ks?.trailingEps) != null ? `$${yNum(ks?.trailingEps)!.toFixed(2)}` : '—' },
                        { label: 'Forward EPS',  val: yNum(ks?.forwardEps) != null ? `$${yNum(ks?.forwardEps)!.toFixed(2)}` : '—' },
                      ].map(({ label, val }) => (
                        <div key={label} className="flex justify-between items-center py-1.5 border-b border-zinc-800/40 last:border-0 text-xs">
                          <span className="text-zinc-500">{label}</span>
                          <span className="font-semibold tabular-nums text-zinc-200">{val}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Growth & Quality */}
                  <div>
                    <div className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest mb-2">Growth & Quality</div>
                    <div className="space-y-0">
                      {[
                        { label: 'Revenue TTM',     val: fmtLarge(yNum(fd?.totalRevenue)),      cls: '' },
                        { label: 'Revenue Growth',  val: fd?.revenueGrowth != null ? pct(fd.revenueGrowth, 100) : fm?.revenueGrowth3Y != null ? `${fm.revenueGrowth3Y.toFixed(1)}% (3Y)` : '—', cls: colorG(fd?.revenueGrowth ?? fm?.revenueGrowth3Y) },
                        { label: 'Earnings Growth', val: fd?.earningsGrowth != null ? pct(fd.earningsGrowth, 100) : fm?.epsGrowth3Y != null ? `${fm.epsGrowth3Y.toFixed(1)}% (3Y)` : '—', cls: colorG(fd?.earningsGrowth ?? fm?.epsGrowth3Y) },
                        { label: 'Gross Margin',    val: fm?.grossMarginTTM != null ? `${fm.grossMarginTTM.toFixed(1)}%` : '—',       cls: '' },
                        { label: 'Net Margin',      val: fm?.netProfitMarginTTM != null ? `${fm.netProfitMarginTTM.toFixed(1)}%` : fd?.profitMargins != null ? `${(fd.profitMargins*100).toFixed(1)}%` : '—', cls: '' },
                        { label: 'ROE',             val: fm?.roeTTM != null ? `${fm.roeTTM.toFixed(1)}%` : fd?.returnOnEquity != null ? `${(fd.returnOnEquity*100).toFixed(1)}%` : '—', cls: '' },
                        { label: 'Debt / Equity',   val: fm?.debtEquityAnnual != null ? fm.debtEquityAnnual.toFixed(2) : fd?.debtToEquity != null ? (fd.debtToEquity / 100).toFixed(2) : '—', cls: '' },
                        { label: 'Free Cash Flow',  val: fmtLarge(yNum(fd?.freeCashflow)),      cls: '' },
                        { label: 'Current Ratio',   val: fd?.currentRatio != null ? fd.currentRatio.toFixed(2) : '—',       cls: '' },
                      ].map(({ label, val, cls }) => (
                        <div key={label} className="flex justify-between items-center py-1.5 border-b border-zinc-800/40 last:border-0 text-xs">
                          <span className="text-zinc-500">{label}</span>
                          <span className={`font-semibold tabular-nums ${cls || 'text-zinc-200'}`}>{val}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Analyst Consensus */}
                  <div>
                    <div className="text-[10px] font-bold text-purple-400 uppercase tracking-widest mb-2">Analyst Consensus</div>
                    {rec && (
                      <div className="mb-3 p-3 bg-zinc-800/50 rounded-lg text-center">
                        <div className={`text-lg font-bold ${recColor}`}>{rec}</div>
                        {fd?.numberOfAnalystOpinions != null && (
                          <div className="text-xs text-zinc-500 mt-0.5">{fd.numberOfAnalystOpinions} analysts</div>
                        )}
                      </div>
                    )}
                    <div className="space-y-0">
                      {[
                        { label: 'Price Target',  val: fd?.targetMeanPrice != null ? fmtCurrency(fd.targetMeanPrice) : '—' },
                        { label: 'Target High',   val: fd?.targetHighPrice != null ? fmtCurrency(fd.targetHighPrice) : '—' },
                        { label: 'Target Low',    val: fd?.targetLowPrice  != null ? fmtCurrency(fd.targetLowPrice)  : '—' },
                        { label: 'Upside',        val: fd?.targetMeanPrice != null && result.currentPrice > 0
                          ? (() => { const u = (fd.targetMeanPrice - result.currentPrice) / result.currentPrice * 100; return <span className={u >= 0 ? 'text-emerald-400' : 'text-red-400'}>{u >= 0 ? '+' : ''}{u.toFixed(1)}%</span>; })()
                          : '—' },
                        { label: 'Short Interest',val: yNum(ks?.shortPercentOfFloat) != null ? `${(yNum(ks?.shortPercentOfFloat)! * 100).toFixed(1)}%` : '—' },
                        { label: 'Short Ratio',   val: yNum(ks?.shortRatio) != null ? `${yNum(ks?.shortRatio)!.toFixed(1)} days` : '—' },
                      ].map(({ label, val }) => (
                        <div key={label} className="flex justify-between items-center py-1.5 border-b border-zinc-800/40 last:border-0 text-xs">
                          <span className="text-zinc-500">{label}</span>
                          <span className="font-semibold tabular-nums text-zinc-200">{val}</span>
                        </div>
                      ))}
                    </div>

                    {/* EPS + Revenue estimates */}
                    {epsEstData.length > 0 && (
                      <div className="mt-4">
                        <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">EPS Estimates</div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead><tr className="border-b border-zinc-800">{epsEstData.map(e => <th key={e.period} className="text-center text-zinc-600 pb-1 px-1 font-normal">{e.period}</th>)}</tr></thead>
                            <tbody><tr>{epsEstData.map(e => <td key={e.period} className="text-center tabular-nums font-semibold text-emerald-400 px-1 pt-1">${e.epsAvg.toFixed(2)}</td>)}</tr></tbody>
                          </table>
                        </div>
                      </div>
                    )}
                    {revEstData.length > 0 && (
                      <div className="mt-3">
                        <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Revenue Estimates</div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead><tr className="border-b border-zinc-800">{revEstData.map(e => <th key={e.period} className="text-center text-zinc-600 pb-1 px-1 font-normal">{e.period}</th>)}</tr></thead>
                            <tbody><tr>{revEstData.map(e => <td key={e.period} className="text-center tabular-nums font-semibold text-blue-400 px-1 pt-1">{fmtLarge(e.revenueAvg)}</td>)}</tr></tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* ── NEWS FEED ────────────────────────────────────────────────── */}
          {newsData.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-bold text-zinc-100 mb-4 flex items-center gap-2">
                <Newspaper size={14} className="text-blue-400" />
                Recent News <span className="text-zinc-600 text-xs font-normal">({newsData.length})</span>
              </h3>
              <div className="space-y-1">
                {newsData.map((n, i) => (
                  <a key={i} href={n.url} target="_blank" rel="noopener noreferrer"
                    className="flex gap-3 group hover:bg-zinc-800/50 -mx-3 px-3 py-2.5 rounded transition-colors">
                    <div className="flex-shrink-0 mt-0.5">
                      {i % 2 === 0 ? <TrendingUp size={12} className="text-zinc-600" /> : <TrendingDown size={12} className="text-zinc-600" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-zinc-300 group-hover:text-blue-300 transition-colors font-medium leading-snug">{n.headline}</div>
                      {n.summary && <div className="text-xs text-zinc-600 mt-0.5 line-clamp-1">{n.summary}</div>}
                    </div>
                    <div className="text-[10px] text-zinc-700 flex-shrink-0 self-start mt-0.5 whitespace-nowrap">{n.source} · {timeAgo(n.datetime)}</div>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* ── INVESTMENT THESIS ────────────────────────────────────────── */}
          <div className="card">
            <h3 className="text-sm font-bold text-zinc-100 mb-4 flex items-center gap-2">
              <BookOpen size={14} className="text-amber-400" /> Investment Thesis
              {notesId && <span className="text-[10px] text-zinc-600 font-normal ml-1">· saved</span>}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="text-xs font-semibold text-emerald-400 uppercase tracking-wide block mb-1.5">🟢 Bull Case</label>
                <textarea
                  className="input-base resize-none text-sm"
                  rows={4}
                  placeholder="Why this stock goes up — catalysts, tailwinds, growth drivers..."
                  value={bullCase}
                  onChange={e => setBullCase(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-red-400 uppercase tracking-wide block mb-1.5">🔴 Bear Case</label>
                <textarea
                  className="input-base resize-none text-sm"
                  rows={4}
                  placeholder="Key risks, headwinds, what could go wrong..."
                  value={bearCase}
                  onChange={e => setBearCase(e.target.value)}
                />
              </div>
            </div>
            <div className="mb-4">
              <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wide block mb-1.5">Notes</label>
              <textarea
                className="input-base resize-none text-sm"
                rows={3}
                placeholder="Entry levels, key dates, position sizing thoughts..."
                value={thesisNote}
                onChange={e => setThesisNote(e.target.value)}
              />
            </div>
            <button
              onClick={saveNotes}
              disabled={notesSaving}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                notesSaved
                  ? 'bg-emerald-900/50 text-emerald-400 border border-emerald-700'
                  : 'bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50'
              }`}
            >
              <Save size={13} />
              {notesSaved ? 'Saved!' : notesSaving ? 'Saving…' : 'Save Thesis'}
            </button>
          </div>
        </>
      )}

      {!result && !loading && !error && (
        <div className="card text-center py-16 text-zinc-600 text-sm">
          Enter a ticker above to run all three scoring frameworks simultaneously.
        </div>
      )}
    </div>
  );
}
