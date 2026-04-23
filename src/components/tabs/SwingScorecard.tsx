import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, Zap, Info } from 'lucide-react';
import { storage, newId, nowIso } from '../../lib/storage';
import { finnhub } from '../../lib/finnhub';
import { calcWeightedScore, getVerdict, verdictBg, fmt } from '../../lib/utils';
import type { ScorecardEntry } from '../../types';

const TABLE = 'scorecard';

const CATEGORIES = [
  { key: 'technical_score', label: 'Technical', weight: '35%', description: 'Trend, pattern, MA alignment, momentum' },
  { key: 'fundamental_score', label: 'Fundamental', weight: '30%', description: 'Earnings, revenue growth, valuation' },
  { key: 'risk_liquidity_score', label: 'Risk / Liquidity', weight: '25%', description: 'Position size, volume, spread, correlation' },
  { key: 'sentiment_score', label: 'Sentiment', weight: '10%', description: 'News sentiment, analyst revisions, short interest' },
] as const;

const defaultForm = {
  ticker: '',
  company_name: '',
  trade_date: new Date().toISOString().split('T')[0],
  technical_score: 5,
  fundamental_score: 5,
  risk_liquidity_score: 5,
  sentiment_score: 5,
  notes: '',
};

interface ScoreRationale {
  technical: string;
  fundamental: string;
  risk: string;
  sentiment: string;
}

type SortKey = 'trade_date' | 'weighted_score' | 'ticker';

// ── Scoring logic ─────────────────────────────────────────────────────────────

function clamp(n: number, min = 0, max = 10) {
  return Math.min(max, Math.max(min, n));
}

async function autoScore(ticker: string): Promise<{
  technical_score: number;
  fundamental_score: number;
  risk_liquidity_score: number;
  sentiment_score: number;
  company_name: string;
  rationale: ScoreRationale;
}> {
  const t = ticker.toUpperCase();

  const [profileRes, metricsRes, quoteRes, sentimentRes] = await Promise.allSettled([
    finnhub.profile(t),
    finnhub.metrics(t),
    finnhub.quote(t),
    finnhub.sentiment(t),
  ]);

  const profile = profileRes.status === 'fulfilled' ? profileRes.value : null;
  const metrics = metricsRes.status === 'fulfilled' ? metricsRes.value?.metric : null;
  const quote = quoteRes.status === 'fulfilled' ? quoteRes.value : null;
  const sentiment = sentimentRes.status === 'fulfilled' ? sentimentRes.value : null;

  // ── Technical score (0–10) ───────────────────────────────────────────────
  // Based on 52W range position: upper range = strong trend
  let technical = 5;
  let techNote = 'No price data available.';
  if (metrics?.['52WeekHigh'] && metrics?.['52WeekLow'] && quote?.c) {
    const hi = metrics['52WeekHigh'];
    const lo = metrics['52WeekLow'];
    const cur = quote.c;
    const range = hi - lo;
    const pos = range > 0 ? (cur - lo) / range : 0.5; // 0 = at 52W low, 1 = at 52W high
    // Upper portion of range = bullish trend, score higher
    // But very near 52W high could be extended — cap at 8.5
    if (pos >= 0.85) { technical = 8.0; techNote = `Price at ${(pos * 100).toFixed(0)}% of 52W range — strong uptrend, near highs.`; }
    else if (pos >= 0.65) { technical = 7.5; techNote = `Price at ${(pos * 100).toFixed(0)}% of 52W range — upper range, bullish.`; }
    else if (pos >= 0.45) { technical = 5.5; techNote = `Price at ${(pos * 100).toFixed(0)}% of 52W range — mid-range, neutral.`; }
    else if (pos >= 0.25) { technical = 3.5; techNote = `Price at ${(pos * 100).toFixed(0)}% of 52W range — lower range, weak.`; }
    else { technical = 2.0; techNote = `Price at ${(pos * 100).toFixed(0)}% of 52W range — near 52W low, bearish.`; }

    // Adjust: strong positive day change (+day momentum)
    if (quote.dp > 3) technical = clamp(technical + 0.5);
    else if (quote.dp < -3) technical = clamp(technical - 0.5);
  }

  // ── Fundamental score (0–10) ─────────────────────────────────────────────
  let fundamental = 5;
  const fundReasons: string[] = [];
  let fundTotal = 0, fundCount = 0;

  if (metrics?.epsGrowth3Y != null) {
    const s = metrics.epsGrowth3Y > 25 ? 9 : metrics.epsGrowth3Y > 15 ? 7.5 : metrics.epsGrowth3Y > 5 ? 6 : metrics.epsGrowth3Y > 0 ? 4.5 : 2.5;
    fundTotal += s; fundCount++;
    fundReasons.push(`EPS growth 3Y: ${metrics.epsGrowth3Y.toFixed(1)}%`);
  }
  if (metrics?.revenueGrowth3Y != null) {
    const s = metrics.revenueGrowth3Y > 20 ? 9 : metrics.revenueGrowth3Y > 10 ? 7 : metrics.revenueGrowth3Y > 3 ? 5.5 : metrics.revenueGrowth3Y > 0 ? 4 : 2;
    fundTotal += s; fundCount++;
    fundReasons.push(`Rev growth 3Y: ${metrics.revenueGrowth3Y.toFixed(1)}%`);
  }
  if (metrics?.roeTTM != null) {
    const s = metrics.roeTTM > 25 ? 8.5 : metrics.roeTTM > 15 ? 7 : metrics.roeTTM > 5 ? 5 : metrics.roeTTM > 0 ? 3.5 : 2;
    fundTotal += s; fundCount++;
    fundReasons.push(`ROE: ${metrics.roeTTM.toFixed(1)}%`);
  }
  if (metrics?.grossMarginTTM != null) {
    const s = metrics.grossMarginTTM > 60 ? 8.5 : metrics.grossMarginTTM > 40 ? 7 : metrics.grossMarginTTM > 20 ? 5.5 : metrics.grossMarginTTM > 10 ? 4 : 2.5;
    fundTotal += s; fundCount++;
    fundReasons.push(`Gross margin: ${metrics.grossMarginTTM.toFixed(1)}%`);
  }
  if (metrics?.peBasicExclExtraTTM != null) {
    const pe = metrics.peBasicExclExtraTTM;
    const s = pe > 0 && pe < 15 ? 8 : pe >= 15 && pe < 25 ? 7 : pe >= 25 && pe < 40 ? 5.5 : pe >= 40 && pe < 60 ? 4 : pe < 0 ? 3 : 3;
    fundTotal += s; fundCount++;
    fundReasons.push(`P/E: ${pe.toFixed(1)}x`);
  }
  if (fundCount > 0) fundamental = clamp(+(fundTotal / fundCount).toFixed(1));
  const fundNote = fundCount > 0 ? fundReasons.join(' · ') : 'No fundamental data available.';

  // ── Risk/Liquidity score (0–10) ──────────────────────────────────────────
  let risk = 5;
  const riskReasons: string[] = [];
  let riskTotal = 0, riskCount = 0;

  // Market cap → liquidity proxy (bigger = more liquid = lower risk = higher score)
  if (profile?.marketCapitalization) {
    const mc = profile.marketCapitalization; // millions
    const s = mc > 200000 ? 9.5 : mc > 50000 ? 8.5 : mc > 10000 ? 7 : mc > 2000 ? 5.5 : mc > 500 ? 4 : 2.5;
    riskTotal += s; riskCount++;
    riskReasons.push(`Mkt cap $${(mc / 1000).toFixed(0)}B`);
  }
  // Beta → volatility (lower = better for risk-adjusted swing)
  if (metrics?.beta != null) {
    const b = metrics.beta;
    const s = b < 0.6 ? 8.5 : b < 1.0 ? 7.5 : b < 1.4 ? 6 : b < 1.8 ? 4.5 : b < 2.5 ? 3 : 1.5;
    riskTotal += s; riskCount++;
    riskReasons.push(`Beta: ${b.toFixed(2)}`);
  }
  // Debt/equity → financial risk (lower = safer)
  if (metrics?.debtEquityAnnual != null) {
    const de = metrics.debtEquityAnnual;
    const s = de < 0.2 ? 9 : de < 0.5 ? 7.5 : de < 1.0 ? 6 : de < 1.5 ? 4.5 : de < 2.5 ? 3 : 1.5;
    riskTotal += s; riskCount++;
    riskReasons.push(`D/E: ${de.toFixed(2)}`);
  }
  if (riskCount > 0) risk = clamp(+(riskTotal / riskCount).toFixed(1));
  const riskNote = riskCount > 0 ? riskReasons.join(' · ') : 'No risk data available.';

  // ── Sentiment score (0–10) ───────────────────────────────────────────────
  let sentimentScore = 5;
  let sentNote = 'No sentiment data available.';
  if (sentiment?.sentiment?.bullishPercent != null) {
    const bull = sentiment.sentiment.bullishPercent; // 0–1
    sentimentScore = clamp(+(bull * 10).toFixed(1));
    const buzz = sentiment.buzz?.articlesInLastWeek ?? 0;
    sentNote = `${(bull * 100).toFixed(0)}% bullish · ${(sentiment.sentiment.bearishPercent * 100).toFixed(0)}% bearish · ${buzz} articles/week`;
  }

  return {
    technical_score: technical,
    fundamental_score: fundamental,
    risk_liquidity_score: risk,
    sentiment_score: sentimentScore,
    company_name: profile?.name ?? '',
    rationale: {
      technical: techNote,
      fundamental: fundNote,
      risk: riskNote,
      sentiment: sentNote,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export default function SwingScorecard() {
  const [entries, setEntries] = useState<ScorecardEntry[]>([]);
  const [form, setForm] = useState(defaultForm);
  const [loading, setLoading] = useState(false);
  const [autoLoading, setAutoLoading] = useState(false);
  const [rationale, setRationale] = useState<ScoreRationale | null>(null);
  const [autoError, setAutoError] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('trade_date');
  const [sortAsc, setSortAsc] = useState(false);

  const load = useCallback(async () => {
    const data = await storage.getAll<ScorecardEntry>(TABLE);
    setEntries(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  const weighted = calcWeightedScore(
    form.technical_score,
    form.fundamental_score,
    form.risk_liquidity_score,
    form.sentiment_score
  );
  const verdict = getVerdict(weighted);

  async function handleAutoScore() {
    if (!form.ticker.trim()) { setAutoError('Enter a ticker first.'); return; }
    setAutoError('');
    setAutoLoading(true);
    setRationale(null);
    try {
      const result = await autoScore(form.ticker.trim());
      setForm((prev) => ({
        ...prev,
        technical_score: result.technical_score,
        fundamental_score: result.fundamental_score,
        risk_liquidity_score: result.risk_liquidity_score,
        sentiment_score: result.sentiment_score,
        company_name: result.company_name || prev.company_name,
      }));
      setRationale(result.rationale);
    } catch {
      setAutoError('Failed to fetch data. Check the ticker and try again.');
    } finally {
      setAutoLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.ticker) return;
    setLoading(true);
    try {
      const entry: ScorecardEntry = {
        id: newId(),
        ticker: form.ticker.toUpperCase(),
        company_name: form.company_name,
        trade_date: form.trade_date,
        technical_score: form.technical_score,
        fundamental_score: form.fundamental_score,
        risk_liquidity_score: form.risk_liquidity_score,
        sentiment_score: form.sentiment_score,
        weighted_score: weighted,
        verdict,
        notes: form.notes,
        created_at: nowIso(),
      };
      await storage.insert(TABLE, entry);
      setForm(defaultForm);
      setRationale(null);
      await load();
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    await storage.remove(TABLE, id);
    await load();
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((a) => !a);
    else { setSortKey(key); setSortAsc(false); }
  }

  const sorted = [...entries].sort((a, b) => {
    const va = a[sortKey] ?? '';
    const vb = b[sortKey] ?? '';
    const cmp = String(va).localeCompare(String(vb), undefined, { numeric: true });
    return sortAsc ? cmp : -cmp;
  });

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return null;
    return sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />;
  }

  const rationaleKeys: Array<[keyof ScoreRationale, string]> = [
    ['technical', 'Technical'],
    ['fundamental', 'Fundamental'],
    ['risk', 'Risk/Liq'],
    ['sentiment', 'Sentiment'],
  ];

  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="text-base font-semibold text-zinc-100 mb-5">New Scorecard Entry</h2>
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Header fields */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="label">Ticker *</label>
              <div className="flex gap-2">
                <input
                  className="input-base uppercase flex-1"
                  placeholder="AAPL"
                  value={form.ticker}
                  onChange={(e) => { setForm({ ...form, ticker: e.target.value }); setRationale(null); setAutoError(''); }}
                  required
                />
                <button
                  type="button"
                  onClick={handleAutoScore}
                  disabled={autoLoading}
                  className="flex-shrink-0 flex items-center gap-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-medium px-3 py-2 rounded-lg text-sm transition"
                  title="Auto-score from Finnhub data"
                >
                  <Zap size={13} />
                  {autoLoading ? 'Scoring…' : 'Auto'}
                </button>
              </div>
              {autoError && <p className="text-red-400 text-xs mt-1">{autoError}</p>}
            </div>
            <div>
              <label className="label">Company Name</label>
              <input
                className="input-base"
                placeholder="Apple Inc."
                value={form.company_name}
                onChange={(e) => setForm({ ...form, company_name: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Trade Date</label>
              <input
                className="input-base"
                type="date"
                value={form.trade_date}
                onChange={(e) => setForm({ ...form, trade_date: e.target.value })}
              />
            </div>
          </div>

          {/* Auto-score rationale */}
          {rationale && (
            <div className="bg-amber-900/20 border border-amber-800/50 rounded-lg p-3 space-y-1">
              <div className="flex items-center gap-1.5 text-amber-400 text-xs font-semibold mb-2">
                <Info size={12} /> Auto-scored from Finnhub — adjust sliders if needed
              </div>
              {rationaleKeys.map(([key, label]) => (
                <div key={key} className="flex gap-2 text-xs">
                  <span className="text-zinc-500 w-20 flex-shrink-0">{label}:</span>
                  <span className="text-zinc-300">{rationale[key]}</span>
                </div>
              ))}
            </div>
          )}

          {/* Score sliders */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {CATEGORIES.map(({ key, label, weight, description }) => (
              <div key={key} className="bg-zinc-800/50 rounded-lg p-4">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <span className="text-sm font-medium text-zinc-200">{label}</span>
                    <span className="ml-2 text-xs text-zinc-500">{weight}</span>
                  </div>
                  <span className="text-2xl font-bold text-blue-400 tabular-nums">
                    {form[key as keyof typeof form]}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 mb-3">{description}</p>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={0.5}
                  value={form[key as keyof typeof form] as number}
                  onChange={(e) => setForm({ ...form, [key]: parseFloat(e.target.value) })}
                  className="w-full accent-blue-500"
                />
                <div className="flex justify-between text-xs text-zinc-600 mt-1">
                  <span>0</span>
                  <span>5</span>
                  <span>10</span>
                </div>
              </div>
            ))}
          </div>

          {/* Weighted score preview */}
          <div className="flex items-center gap-4 p-4 bg-zinc-800/30 rounded-lg border border-zinc-700">
            <div>
              <div className="text-xs text-zinc-500 mb-0.5">Weighted Score</div>
              <div className="text-3xl font-bold text-zinc-100 tabular-nums">{fmt(weighted)}</div>
            </div>
            <div className="w-px h-10 bg-zinc-700" />
            <div>
              <div className="text-xs text-zinc-500 mb-1">Verdict</div>
              <span className={`px-3 py-1 rounded-full text-sm font-semibold ${verdictBg(verdict)}`}>
                {verdict}
              </span>
            </div>
            <div className="ml-auto text-xs text-zinc-600">
              GO ≥7.5 · CONDITIONAL 6–7.4 · NO GO &lt;6
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="label">Notes</label>
            <textarea
              className="input-base resize-none"
              rows={3}
              placeholder="Trade thesis, catalysts, key risks..."
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>

          <button type="submit" className="btn-primary flex items-center gap-2" disabled={loading}>
            <Plus size={14} />
            {loading ? 'Saving...' : 'Save Scorecard'}
          </button>
        </form>
      </div>

      {/* Historical table */}
      <div className="card">
        <h2 className="text-base font-semibold text-zinc-100 mb-4">
          History <span className="text-zinc-600 text-sm font-normal">({entries.length})</span>
        </h2>
        {sorted.length === 0 ? (
          <p className="text-zinc-600 text-sm text-center py-8">No entries yet. Log your first trade above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-800">
                  {([['ticker', 'Ticker'], ['trade_date', 'Date'], ['weighted_score', 'Score']] as [SortKey, string][]).map(([k, label]) => (
                    <th key={k} className="th cursor-pointer select-none hover:text-zinc-300" onClick={() => toggleSort(k)}>
                      <span className="flex items-center gap-1">{label}<SortIcon k={k} /></span>
                    </th>
                  ))}
                  <th className="th">Technical</th>
                  <th className="th">Fundamental</th>
                  <th className="th">Risk/Liq</th>
                  <th className="th">Sentiment</th>
                  <th className="th">Verdict</th>
                  <th className="th">Notes</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {sorted.map((e) => (
                  <tr key={e.id} className="tr-hover">
                    <td className="td">
                      <div className="font-mono font-semibold text-blue-400">{e.ticker}</div>
                      {e.company_name && <div className="text-xs text-zinc-500">{e.company_name}</div>}
                    </td>
                    <td className="td text-zinc-400">{e.trade_date}</td>
                    <td className="td font-bold text-lg tabular-nums">{fmt(e.weighted_score)}</td>
                    <td className="td text-center">{e.technical_score}</td>
                    <td className="td text-center">{e.fundamental_score}</td>
                    <td className="td text-center">{e.risk_liquidity_score}</td>
                    <td className="td text-center">{e.sentiment_score}</td>
                    <td className="td">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${verdictBg(e.verdict)}`}>
                        {e.verdict}
                      </span>
                    </td>
                    <td className="td max-w-xs truncate text-zinc-500 text-xs">{e.notes}</td>
                    <td className="td">
                      <button onClick={() => handleDelete(e.id)} className="btn-danger">
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
