import { useState, useRef, useEffect } from 'react';
import { Search, Star, Pencil, Check, X, AlertTriangle, TrendingUp, Clock, BarChart2, Eye } from 'lucide-react';
import { finnhub } from '../../lib/finnhub';
import { fetchYahoo } from '../../lib/yahoo';
import { runTriFrame, loadSettings, saveSettings } from '../../lib/scoring';
import { storage, newId, nowIso } from '../../lib/storage';
import { fmtCurrency, fmt } from '../../lib/utils';
import type { TriFrameResult, SwingScore, MediumScore, LongScore, FlagSeverity } from '../../types/scorecard';

interface FrameLevels { entry: string; exit: string }
const TABLE_WATCH = 'watch_items';

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
const FLAG_DEFINITIONS: Record<string, string> = {
  'Beta':
    'Measures volatility vs the S&P 500. Beta 1.0 = moves with the market. >1.5 = amplified swings in both directions — bigger gains but bigger drawdowns. Factor into your stop placement.',
  'Short Interest':
    'Percentage of the float sold short. >10% is elevated; >20% is HIGH. High short interest can trigger a short squeeze (rapid rally) but also signals bearish institutional conviction.',
  'Days to Cover':
    'How many days of average volume it would take all short sellers to buy back their shares. >5 days = squeeze risk. >10 days = significant squeeze potential if positive catalyst hits.',
  'Avg Volume':
    'Average daily shares traded. LOW volume (<500K) means wide bid/ask spreads, harder to exit quickly, and easier for large orders to move price against you.',
  'Next Earnings':
    'Days until the next earnings report. Earnings can cause 5–20%+ gaps overnight. Holding through earnings is a binary event — consider reducing size or closing before the date.',
};

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
  const [addedToWatch, setAddedToWatch] = useState(false);
  const [addingWatch,  setAddingWatch]  = useState(false);
  const [headerEntry,  setHeaderEntry]  = useState('');
  const [headerExit,   setHeaderExit]   = useState('');

  // Account size
  const [accountSize, setAccountSize] = useState<number>(() => loadSettings().accountSize ?? 0);
  const [editingAccount, setEditingAccount] = useState(false);
  const [accountInput, setAccountInput] = useState('');
  const accountRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editingAccount) accountRef.current?.focus(); }, [editingAccount]);

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

    try {
      // TSX and other exchange suffixes — strip for Finnhub, keep for Yahoo Finance
      const SUFFIXES = ['.TO', '.V', '.TSX', '.CN', '.NEO', '.VN'];
      const suffix = SUFFIXES.find(s => t.endsWith(s)) ?? null;
      const finnhubTicker = suffix ? t.slice(0, t.length - suffix.length) : t;
      const yahooTicker   = t;

      const [quoteRes, profileRes, metricsRes, sentimentRes, yahooRes] = await Promise.allSettled([
        finnhub.quote(finnhubTicker),
        finnhub.profile(finnhubTicker),
        finnhub.metrics(finnhubTicker),
        finnhub.sentiment(finnhubTicker),
        fetchYahoo(yahooTicker),
      ]);

      const finnhubQuote   = quoteRes.status   === 'fulfilled' ? quoteRes.value   : null;
      const finnhubProfile = profileRes.status === 'fulfilled' ? profileRes.value : null;
      const metrics        = metricsRes.status === 'fulfilled' ? metricsRes.value : null;
      const sentiment      = sentimentRes.status === 'fulfilled' ? sentimentRes.value : null;
      const yahoo          = yahooRes.status    === 'fulfilled' ? yahooRes.value   : {};

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
      setYahooData(yahoo);
      setAddedToWatch(false);
      setHeaderEntry('');
      setHeaderExit('');
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

        {accountSize === 0 && (
          <p className="text-xs text-amber-600/80 mt-2 flex items-center gap-1.5">
            <AlertTriangle size={11} />
            Set your swing account size to enable position sizing calculations.
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

            {/* Market data row: MAs + short interest */}
            {(() => {
              const sd  = yahooData?.summaryDetail;
              const ks  = yahooData?.defaultKeyStatistics;
              const ma50  = yNum(sd?.fiftyDayAverage);
              const ma200 = yNum(sd?.twoHundredDayAverage);
              const wk52Hi = yNum(sd?.fiftyTwoWeekHigh);
              const wk52Lo = yNum(sd?.fiftyTwoWeekLow);
              const shortPct = yNum(ks?.shortPercentOfFloat) ?? yNum(sd?.shortPercentOfFloat);
              const cp = result.currentPrice;

              return (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
                    <div className="text-xs text-zinc-500 mb-0.5">52W Range</div>
                    <div className="text-xs font-semibold tabular-nums text-zinc-300">
                      {wk52Lo && wk52Hi ? `${fmtCurrency(wk52Lo)} – ${fmtCurrency(wk52Hi)}` : '—'}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>

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
              <div className="flex flex-wrap gap-3">
                {result.riskFlags.map((f, i) => {
                  const def = FLAG_DEFINITIONS[f.label];
                  return (
                    <div key={i} className="relative group bg-zinc-800 rounded-lg px-3 py-2 flex flex-col gap-0.5 cursor-default">
                      <span className="text-xs text-zinc-500 flex items-center gap-1">
                        {f.label}
                        {def && <span className="text-zinc-600 text-[10px]">(?)</span>}
                      </span>
                      <span className={`text-sm font-semibold tabular-nums ${FLAG_SEVERITY[f.severity]}`}>{f.value}</span>
                      {/* Tooltip */}
                      {def && (
                        <div className="absolute bottom-full left-0 mb-2 w-72 z-20 hidden group-hover:block">
                          <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-3 shadow-xl">
                            <div className="text-xs font-semibold text-zinc-200 mb-1">{f.label}</div>
                            <p className="text-xs text-zinc-400 leading-relaxed">{def}</p>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="text-xs text-zinc-700 text-right">
            Scored {new Date(result.scoredAt).toLocaleString()} · Finnhub + Yahoo Finance
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
