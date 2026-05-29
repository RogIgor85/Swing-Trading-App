import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, Zap, ExternalLink, TrendingUp, TrendingDown, Newspaper } from 'lucide-react';
import { storage, newId, nowIso } from '../../lib/storage';
import { finnhub } from '../../lib/finnhub';
import { calcWeightedScore, getVerdict, verdictBg, fmt, fmtCurrency } from '../../lib/utils';
import type { ScorecardEntry, FinnhubQuote, FinnhubProfile, FinnhubMetrics, FinnhubSentiment } from '../../types';

const TABLE = 'scorecard';

const CATEGORIES = [
  { key: 'technical_score',      label: 'Technical',       weight: '35%', accent: 'blue',    description: 'Trend, pattern, MA alignment, momentum' },
  { key: 'fundamental_score',    label: 'Fundamental',     weight: '30%', accent: 'emerald', description: 'Earnings, revenue growth, valuation' },
  { key: 'risk_liquidity_score', label: 'Risk / Liquidity',weight: '25%', accent: 'amber',   description: 'Position size, volume, spread, correlation' },
  { key: 'sentiment_score',      label: 'Sentiment',       weight: '10%', accent: 'purple',  description: 'News sentiment, analyst revisions, short interest' },
] as const;

const ACCENT_COLORS: Record<string, string> = {
  blue:    'accent-blue-500',
  emerald: 'accent-emerald-500',
  amber:   'accent-amber-500',
  purple:  'accent-purple-500',
};
const SCORE_BAR: Record<string, string> = {
  blue:    'bg-blue-500',
  emerald: 'bg-emerald-500',
  amber:   'bg-amber-500',
  purple:  'bg-purple-500',
};

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

interface MarketData {
  quote: FinnhubQuote;
  profile: FinnhubProfile | null;
  metrics: FinnhubMetrics['metric'] | null;
  sentiment: FinnhubSentiment | null;
  news: Array<{ headline: string; source: string; datetime: number; url: string; summary: string }>;
}

interface ScoreRationale {
  technical: string;
  fundamental: string;
  risk: string;
  sentiment: string;
}

type SortKey = 'trade_date' | 'weighted_score' | 'ticker';

// ── Helpers ───────────────────────────────────────────────────────────────────
function clamp(n: number, min = 0, max = 10) { return Math.min(max, Math.max(min, n)); }

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtBig(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}T`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}B`;
  return `$${n.toFixed(0)}M`;
}

function colorVal(n: number | null | undefined, good: 'high' | 'low' = 'high'): string {
  if (n == null) return 'text-zinc-400';
  if (good === 'high') return n > 0 ? 'text-emerald-400' : 'text-red-400';
  return n < 1 ? 'text-emerald-400' : n < 2 ? 'text-amber-400' : 'text-red-400';
}

// ── Terminal panel components ─────────────────────────────────────────────────
function Panel({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-zinc-800 overflow-hidden ${className}`}>
      <div className="bg-zinc-900 border-b border-zinc-800 px-3 py-2">
        <h3 className="text-[10px] font-bold text-blue-400 uppercase tracking-widest">{title}</h3>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function StatRow({ label, value, valueClass = '' }: { label: string; value: React.ReactNode; valueClass?: string }) {
  return (
    <div className="flex justify-between items-center py-1.5 border-b border-zinc-800/40 last:border-0">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className={`text-xs font-semibold tabular-nums ${valueClass || 'text-zinc-200'}`}>{value}</span>
    </div>
  );
}

// ── Auto-scoring logic ────────────────────────────────────────────────────────
async function fetchMarketData(ticker: string): Promise<MarketData> {
  const t = ticker.toUpperCase();
  const [profileRes, metricsRes, quoteRes, sentimentRes, newsRes] = await Promise.allSettled([
    finnhub.profile(t),
    finnhub.metrics(t),
    finnhub.quote(t),
    finnhub.sentiment(t),
    finnhub.news(t),
  ]);
  return {
    quote:     quoteRes.status     === 'fulfilled' ? quoteRes.value     : { c: 0, d: 0, dp: 0, h: 0, l: 0, o: 0, pc: 0 },
    profile:   profileRes.status   === 'fulfilled' ? profileRes.value   : null,
    metrics:   metricsRes.status   === 'fulfilled' ? metricsRes.value?.metric ?? null : null,
    sentiment: sentimentRes.status === 'fulfilled' ? sentimentRes.value : null,
    news:      newsRes.status      === 'fulfilled' ? newsRes.value.slice(0, 8) : [],
  };
}

function computeScores(data: MarketData): {
  technical_score: number; fundamental_score: number; risk_liquidity_score: number; sentiment_score: number;
  company_name: string; rationale: ScoreRationale;
} {
  const { quote, profile, metrics, sentiment } = data;

  // Technical
  let technical = 5, techNote = 'No price data.';
  if (metrics?.['52WeekHigh'] && metrics?.['52WeekLow'] && quote.c) {
    const pos = (quote.c - metrics['52WeekLow']) / (metrics['52WeekHigh'] - metrics['52WeekLow']);
    if      (pos >= 0.85) { technical = 8.0; techNote = `${(pos*100).toFixed(0)}% of 52W range — strong uptrend.`; }
    else if (pos >= 0.65) { technical = 7.5; techNote = `${(pos*100).toFixed(0)}% of 52W range — upper range, bullish.`; }
    else if (pos >= 0.45) { technical = 5.5; techNote = `${(pos*100).toFixed(0)}% of 52W range — mid-range, neutral.`; }
    else if (pos >= 0.25) { technical = 3.5; techNote = `${(pos*100).toFixed(0)}% of 52W range — lower range, weak.`; }
    else                  { technical = 2.0; techNote = `${(pos*100).toFixed(0)}% of 52W range — near 52W low, bearish.`; }
    if (quote.dp > 3)  technical = clamp(technical + 0.5);
    else if (quote.dp < -3) technical = clamp(technical - 0.5);
  }

  // Fundamental
  let fundTotal = 0, fundCount = 0;
  const fundReasons: string[] = [];
  if (metrics?.epsGrowth3Y != null) {
    const s = metrics.epsGrowth3Y > 25 ? 9 : metrics.epsGrowth3Y > 15 ? 7.5 : metrics.epsGrowth3Y > 5 ? 6 : metrics.epsGrowth3Y > 0 ? 4.5 : 2.5;
    fundTotal += s; fundCount++; fundReasons.push(`EPS 3Y: ${metrics.epsGrowth3Y.toFixed(1)}%`);
  }
  if (metrics?.revenueGrowth3Y != null) {
    const s = metrics.revenueGrowth3Y > 20 ? 9 : metrics.revenueGrowth3Y > 10 ? 7 : metrics.revenueGrowth3Y > 3 ? 5.5 : metrics.revenueGrowth3Y > 0 ? 4 : 2;
    fundTotal += s; fundCount++; fundReasons.push(`Rev 3Y: ${metrics.revenueGrowth3Y.toFixed(1)}%`);
  }
  if (metrics?.roeTTM != null) {
    const s = metrics.roeTTM > 25 ? 8.5 : metrics.roeTTM > 15 ? 7 : metrics.roeTTM > 5 ? 5 : metrics.roeTTM > 0 ? 3.5 : 2;
    fundTotal += s; fundCount++; fundReasons.push(`ROE: ${metrics.roeTTM.toFixed(1)}%`);
  }
  if (metrics?.grossMarginTTM != null) {
    const s = metrics.grossMarginTTM > 60 ? 8.5 : metrics.grossMarginTTM > 40 ? 7 : metrics.grossMarginTTM > 20 ? 5.5 : metrics.grossMarginTTM > 10 ? 4 : 2.5;
    fundTotal += s; fundCount++; fundReasons.push(`Gross margin: ${metrics.grossMarginTTM.toFixed(1)}%`);
  }
  if (metrics?.peBasicExclExtraTTM != null) {
    const pe = metrics.peBasicExclExtraTTM;
    const s = pe > 0 && pe < 15 ? 8 : pe >= 15 && pe < 25 ? 7 : pe >= 25 && pe < 40 ? 5.5 : pe >= 40 && pe < 60 ? 4 : pe < 0 ? 3 : 3;
    fundTotal += s; fundCount++; fundReasons.push(`P/E: ${pe.toFixed(1)}x`);
  }
  const fundamental = fundCount > 0 ? clamp(+(fundTotal / fundCount).toFixed(1)) : 5;
  const fundNote = fundCount > 0 ? fundReasons.join(' · ') : 'No fundamental data.';

  // Risk
  let riskTotal = 0, riskCount = 0;
  const riskReasons: string[] = [];
  if (profile?.marketCapitalization) {
    const mc = profile.marketCapitalization;
    const s = mc > 200000 ? 9.5 : mc > 50000 ? 8.5 : mc > 10000 ? 7 : mc > 2000 ? 5.5 : mc > 500 ? 4 : 2.5;
    riskTotal += s; riskCount++; riskReasons.push(`Mkt cap ${fmtBig(mc)}`);
  }
  if (metrics?.beta != null) {
    const b = metrics.beta;
    const s = b < 0.6 ? 8.5 : b < 1.0 ? 7.5 : b < 1.4 ? 6 : b < 1.8 ? 4.5 : b < 2.5 ? 3 : 1.5;
    riskTotal += s; riskCount++; riskReasons.push(`Beta: ${b.toFixed(2)}`);
  }
  if (metrics?.debtEquityAnnual != null) {
    const de = metrics.debtEquityAnnual;
    const s = de < 0.2 ? 9 : de < 0.5 ? 7.5 : de < 1.0 ? 6 : de < 1.5 ? 4.5 : de < 2.5 ? 3 : 1.5;
    riskTotal += s; riskCount++; riskReasons.push(`D/E: ${de.toFixed(2)}`);
  }
  const risk = riskCount > 0 ? clamp(+(riskTotal / riskCount).toFixed(1)) : 5;
  const riskNote = riskCount > 0 ? riskReasons.join(' · ') : 'No risk data.';

  // Sentiment
  let sentimentScore = 5, sentNote = 'No sentiment data.';
  if (sentiment?.sentiment?.bullishPercent != null) {
    sentimentScore = clamp(+(sentiment.sentiment.bullishPercent * 10).toFixed(1));
    const buzz = sentiment.buzz?.articlesInLastWeek ?? 0;
    sentNote = `${(sentiment.sentiment.bullishPercent * 100).toFixed(0)}% bullish · ${(sentiment.sentiment.bearishPercent * 100).toFixed(0)}% bearish · ${buzz} articles/wk`;
  }

  return {
    technical_score: technical, fundamental_score: fundamental,
    risk_liquidity_score: risk, sentiment_score: sentimentScore,
    company_name: profile?.name ?? '',
    rationale: { technical: techNote, fundamental: fundNote, risk: riskNote, sentiment: sentNote },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
export default function SwingScorecard() {
  const [entries, setEntries]     = useState<ScorecardEntry[]>([]);
  const [form, setForm]           = useState(defaultForm);
  const [loading, setLoading]     = useState(false);
  const [autoLoading, setAutoLoading] = useState(false);
  const [marketData, setMarketData]   = useState<MarketData | null>(null);
  const [rationale, setRationale]     = useState<ScoreRationale | null>(null);
  const [autoError, setAutoError]     = useState('');
  const [sortKey, setSortKey]   = useState<SortKey>('trade_date');
  const [sortAsc, setSortAsc]   = useState(false);

  const load = useCallback(async () => {
    const data = await storage.getAll<ScorecardEntry>(TABLE);
    setEntries(data);
  }, []);
  useEffect(() => { load(); }, [load]);

  const weighted = calcWeightedScore(form.technical_score, form.fundamental_score, form.risk_liquidity_score, form.sentiment_score);
  const verdict  = getVerdict(weighted);

  async function handleAutoScore() {
    if (!form.ticker.trim()) { setAutoError('Enter a ticker first.'); return; }
    setAutoError(''); setAutoLoading(true); setMarketData(null); setRationale(null);
    try {
      const data = await fetchMarketData(form.ticker.trim());
      const scores = computeScores(data);
      setMarketData(data);
      setRationale(scores.rationale);
      setForm(prev => ({
        ...prev,
        technical_score:      scores.technical_score,
        fundamental_score:    scores.fundamental_score,
        risk_liquidity_score: scores.risk_liquidity_score,
        sentiment_score:      scores.sentiment_score,
        company_name: scores.company_name || prev.company_name,
      }));
    } catch {
      setAutoError('Failed to fetch data. Check the ticker.');
    } finally {
      setAutoLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.ticker) return;
    setLoading(true);
    try {
      await storage.insert(TABLE, {
        id: newId(), ticker: form.ticker.toUpperCase(), company_name: form.company_name,
        trade_date: form.trade_date, technical_score: form.technical_score,
        fundamental_score: form.fundamental_score, risk_liquidity_score: form.risk_liquidity_score,
        sentiment_score: form.sentiment_score, weighted_score: weighted, verdict,
        notes: form.notes, created_at: nowIso(),
      } satisfies ScorecardEntry);
      setForm(defaultForm); setRationale(null); setMarketData(null);
      await load();
    } finally { setLoading(false); }
  }

  async function handleDelete(id: string) { await storage.remove(TABLE, id); await load(); }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(a => !a); else { setSortKey(key); setSortAsc(false); }
  }
  const sorted = [...entries].sort((a, b) => {
    const cmp = String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? ''), undefined, { numeric: true });
    return sortAsc ? cmp : -cmp;
  });
  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return null;
    return sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />;
  }

  const m = marketData;
  const q = m?.quote;
  const met = m?.metrics;
  const prof = m?.profile;
  const sent = m?.sentiment;

  // 52W range position
  const rangePos = met?.['52WeekHigh'] && met?.['52WeekLow'] && q?.c
    ? ((q.c - met['52WeekLow']) / (met['52WeekHigh'] - met['52WeekLow'])) * 100
    : null;

  const bullPct = sent?.sentiment?.bullishPercent != null ? sent.sentiment.bullishPercent * 100 : null;
  const bearPct = sent?.sentiment?.bearishPercent != null ? sent.sentiment.bearishPercent * 100 : null;

  return (
    <div className="space-y-4">

      {/* ── Input bar ──────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="w-28">
            <label className="label">Ticker *</label>
            <input
              className="input-base uppercase font-mono"
              placeholder="AAPL"
              value={form.ticker}
              onChange={e => { setForm({ ...form, ticker: e.target.value }); setMarketData(null); setRationale(null); setAutoError(''); }}
            />
          </div>
          <button
            type="button"
            onClick={handleAutoScore}
            disabled={autoLoading}
            className="flex items-center gap-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-semibold px-4 py-2 rounded-lg text-sm transition self-end"
          >
            <Zap size={14} className={autoLoading ? 'animate-pulse' : ''} />
            {autoLoading ? 'Loading…' : 'Auto-Score'}
          </button>
          <div className="flex-1 min-w-40">
            <label className="label">Company Name</label>
            <input className="input-base" placeholder="Apple Inc." value={form.company_name} onChange={e => setForm({ ...form, company_name: e.target.value })} />
          </div>
          <div className="w-36">
            <label className="label">Trade Date</label>
            <input className="input-base" type="date" value={form.trade_date} onChange={e => setForm({ ...form, trade_date: e.target.value })} />
          </div>
        </div>
        {autoError && <p className="text-red-400 text-xs mt-2">{autoError}</p>}
      </div>

      {/* ── Market data panels (terminal view) ─────────────────────────────── */}
      {m && q && (
        <>
          {/* Price header */}
          <div className="flex items-center gap-4 flex-wrap px-1">
            {prof && <span className="text-zinc-400 text-sm font-medium">{prof.name}</span>}
            {prof && <span className="text-zinc-700 text-xs">{prof.exchange} · {prof.finnhubIndustry}</span>}
            <div className="ml-auto flex items-center gap-3">
              <span className="text-3xl font-bold tabular-nums text-zinc-100">{fmtCurrency(q.c)}</span>
              <span className={`flex items-center gap-1 text-base font-semibold ${q.d >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {q.d >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
                {q.d >= 0 ? '+' : ''}{q.d.toFixed(2)} ({q.dp.toFixed(2)}%)
              </span>
              <span className="text-xs text-zinc-600">Today</span>
            </div>
          </div>

          {/* 3 panels */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Overview */}
            <Panel title={`${form.ticker.toUpperCase()} Overview`}>
              <StatRow label="Open"           value={fmtCurrency(q.o)} />
              <StatRow label="Prev Close"     value={fmtCurrency(q.pc)} />
              <StatRow label="Today High"     value={fmtCurrency(q.h)} valueClass="text-emerald-400" />
              <StatRow label="Today Low"      value={fmtCurrency(q.l)} valueClass="text-red-400" />
              <StatRow label="Market Cap"     value={fmtBig(prof?.marketCapitalization)} />
              <StatRow label="Shares Out."    value={prof?.shareOutstanding ? `${(prof.shareOutstanding / 1000).toFixed(1)}B` : '—'} />
              <StatRow label="Exchange"       value={prof?.exchange ?? '—'} />
              <StatRow label="Industry"       value={prof?.finnhubIndustry ?? '—'} />
              {/* 52W range bar */}
              {rangePos != null && (
                <div className="mt-3 pt-2 border-t border-zinc-800/50">
                  <div className="flex justify-between text-[10px] text-zinc-600 mb-1">
                    <span>{fmtCurrency(met?.['52WeekLow'])}</span>
                    <span className="text-zinc-500">52-Week Range</span>
                    <span>{fmtCurrency(met?.['52WeekHigh'])}</span>
                  </div>
                  <div className="relative h-2 bg-zinc-700 rounded-full">
                    <div className="absolute h-full bg-gradient-to-r from-red-500 via-amber-500 to-emerald-500 rounded-full opacity-40 w-full" />
                    <div
                      className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-white border-2 border-blue-400 rounded-full shadow"
                      style={{ left: `calc(${Math.min(Math.max(rangePos, 2), 98)}% - 5px)` }}
                    />
                  </div>
                  <div className="text-center text-[10px] text-zinc-500 mt-1">
                    {rangePos.toFixed(0)}% of 52W range
                  </div>
                </div>
              )}
              {prof?.weburl && (
                <a href={prof.weburl} target="_blank" rel="noopener noreferrer"
                  className="mt-2 flex items-center gap-1 text-[10px] text-zinc-600 hover:text-blue-400 transition-colors">
                  <ExternalLink size={10} /> {prof.weburl}
                </a>
              )}
            </Panel>

            {/* Key Metrics / Fundamentals */}
            <Panel title="Key Metrics">
              <StatRow label="P/E TTM"
                value={met?.peBasicExclExtraTTM != null ? `${met.peBasicExclExtraTTM.toFixed(1)}x` : '—'}
                valueClass={met?.peBasicExclExtraTTM != null ? (met.peBasicExclExtraTTM < 25 ? 'text-emerald-400' : met.peBasicExclExtraTTM < 40 ? 'text-amber-400' : 'text-red-400') : ''}
              />
              <StatRow label="P/B Annual"
                value={met?.pbAnnual != null ? `${met.pbAnnual.toFixed(1)}x` : '—'}
              />
              <StatRow label="Beta"
                value={met?.beta != null ? met.beta.toFixed(2) : '—'}
                valueClass={met?.beta != null ? (met.beta < 1.2 ? 'text-emerald-400' : met.beta < 1.8 ? 'text-amber-400' : 'text-red-400') : ''}
              />
              <StatRow label="Dividend Yield"
                value={met?.dividendYieldIndicatedAnnual != null && met.dividendYieldIndicatedAnnual > 0 ? `${met.dividendYieldIndicatedAnnual.toFixed(2)}%` : '—'}
              />
              <div className="my-1 border-t border-zinc-800/50" />
              <StatRow label="ROE TTM"
                value={met?.roeTTM != null ? `${met.roeTTM.toFixed(1)}%` : '—'}
                valueClass={colorVal(met?.roeTTM)}
              />
              <StatRow label="Gross Margin TTM"
                value={met?.grossMarginTTM != null ? `${met.grossMarginTTM.toFixed(1)}%` : '—'}
                valueClass={colorVal(met?.grossMarginTTM)}
              />
              <StatRow label="Net Margin TTM"
                value={met?.netProfitMarginTTM != null ? `${met.netProfitMarginTTM.toFixed(1)}%` : '—'}
                valueClass={colorVal(met?.netProfitMarginTTM)}
              />
              <StatRow label="D/E Annual"
                value={met?.debtEquityAnnual != null ? met.debtEquityAnnual.toFixed(2) : '—'}
                valueClass={met?.debtEquityAnnual != null ? colorVal(met.debtEquityAnnual, 'low') : ''}
              />
              <div className="my-1 border-t border-zinc-800/50" />
              <StatRow label="EPS Growth 3Y"
                value={met?.epsGrowth3Y != null ? `${met.epsGrowth3Y.toFixed(1)}%` : '—'}
                valueClass={colorVal(met?.epsGrowth3Y)}
              />
              <StatRow label="Rev Growth 3Y"
                value={met?.revenueGrowth3Y != null ? `${met.revenueGrowth3Y.toFixed(1)}%` : '—'}
                valueClass={colorVal(met?.revenueGrowth3Y)}
              />
            </Panel>

            {/* Sentiment + News preview */}
            <Panel title="News Sentiment">
              {bullPct != null && bearPct != null ? (
                <>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-emerald-400 font-semibold">{bullPct.toFixed(0)}% Bullish</span>
                    <span className="text-red-400 font-semibold">{bearPct.toFixed(0)}% Bearish</span>
                  </div>
                  <div className="h-2.5 rounded-full overflow-hidden flex mb-3">
                    <div className="bg-emerald-500 h-full transition-all" style={{ width: `${bullPct}%` }} />
                    <div className="bg-red-500 h-full flex-1" />
                  </div>
                  {sent?.buzz?.articlesInLastWeek != null && (
                    <div className="text-xs text-zinc-500 mb-3">
                      <span className="text-zinc-300 font-semibold">{sent.buzz.articlesInLastWeek}</span> articles last week
                      {sent.companyNewsScore != null && (
                        <span className="ml-2 text-zinc-600">· news score {sent.companyNewsScore.toFixed(2)}</span>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-xs text-zinc-600 mb-3">No sentiment data available</p>
              )}
              {/* Top 4 news headlines */}
              <div className="space-y-2 mt-1">
                {m.news.slice(0, 4).map((n, i) => (
                  <a key={i} href={n.url} target="_blank" rel="noopener noreferrer"
                    className="block group">
                    <div className="text-xs text-zinc-300 group-hover:text-blue-300 transition-colors leading-snug line-clamp-2">
                      {n.headline}
                    </div>
                    <div className="text-[10px] text-zinc-600 mt-0.5">
                      {n.source} · {timeAgo(n.datetime)}
                    </div>
                  </a>
                ))}
                {m.news.length === 0 && <p className="text-xs text-zinc-600">No recent news</p>}
              </div>
            </Panel>
          </div>
        </>
      )}

      {/* ── Score sliders ───────────────────────────────────────────────────── */}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {CATEGORIES.map(({ key, label, weight, accent, description }) => {
            const val = form[key as keyof typeof form] as number;
            const barW = (val / 10) * 100;
            return (
              <div key={key} className="card py-3">
                <div className="flex justify-between items-center mb-1">
                  <div>
                    <span className="text-sm font-semibold text-zinc-200">{label}</span>
                    <span className="ml-2 text-xs text-zinc-600">{weight}</span>
                  </div>
                  <span className="text-2xl font-bold tabular-nums text-zinc-100">{val}</span>
                </div>
                <p className="text-[11px] text-zinc-600 mb-2">{description}</p>
                {/* Score bar */}
                <div className="h-1.5 bg-zinc-700 rounded-full mb-2">
                  <div className={`h-1.5 rounded-full transition-all ${SCORE_BAR[accent]}`} style={{ width: `${barW}%` }} />
                </div>
                <input
                  type="range" min={0} max={10} step={0.5} value={val}
                  onChange={e => setForm({ ...form, [key]: parseFloat(e.target.value) })}
                  className={`w-full ${ACCENT_COLORS[accent]}`}
                />
                <div className="flex justify-between text-[10px] text-zinc-700">
                  <span>0 — Worst</span><span>5 — Neutral</span><span>10 — Best</span>
                </div>
                {/* Rationale from auto-score */}
                {rationale && (
                  <p className="text-[11px] text-zinc-500 mt-2 italic border-t border-zinc-800 pt-1.5">
                    {rationale[key === 'technical_score' ? 'technical' : key === 'fundamental_score' ? 'fundamental' : key === 'risk_liquidity_score' ? 'risk' : 'sentiment']}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {/* Verdict banner */}
        <div className={`rounded-lg border p-4 flex items-center gap-6 flex-wrap ${
          verdict === 'GO' ? 'bg-emerald-950/40 border-emerald-700' :
          verdict === 'CONDITIONAL' ? 'bg-amber-950/40 border-amber-700' :
          'bg-red-950/40 border-red-800'
        }`}>
          <div>
            <div className="text-xs text-zinc-500 mb-0.5">Weighted Score</div>
            <div className="text-4xl font-bold tabular-nums text-zinc-100">{fmt(weighted)}</div>
          </div>
          <div className="w-px h-12 bg-zinc-700" />
          <div>
            <div className="text-xs text-zinc-500 mb-1">Verdict</div>
            <span className={`px-4 py-1.5 rounded-full text-base font-bold ${verdictBg(verdict)}`}>{verdict}</span>
          </div>
          <div className="ml-auto text-xs text-zinc-600 leading-relaxed">
            GO ≥ 7.5<br />CONDITIONAL 6 – 7.4<br />NO GO &lt; 6
          </div>
        </div>

        {/* Notes + save */}
        <div className="card">
          <label className="label">Trade Thesis / Notes</label>
          <textarea
            className="input-base resize-none mb-3"
            rows={3}
            placeholder="Catalysts, key risks, entry/exit levels, chart pattern..."
            value={form.notes}
            onChange={e => setForm({ ...form, notes: e.target.value })}
          />
          <button type="submit" className="btn-primary flex items-center gap-2" disabled={loading}>
            <Plus size={14} />
            {loading ? 'Saving...' : 'Save Scorecard'}
          </button>
        </div>
      </form>

      {/* ── Full news feed (when market data loaded) ────────────────────────── */}
      {m && m.news.length > 0 && (
        <Panel title={`${form.ticker.toUpperCase()} News (${m.news.length})`}>
          <div className="space-y-3">
            {m.news.map((n, i) => (
              <a key={i} href={n.url} target="_blank" rel="noopener noreferrer"
                className="flex gap-3 group hover:bg-zinc-800/40 -mx-3 px-3 py-2 rounded transition-colors">
                <Newspaper size={13} className="text-zinc-600 flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-sm text-zinc-300 group-hover:text-blue-300 transition-colors font-medium leading-snug">{n.headline}</div>
                  {n.summary && <div className="text-xs text-zinc-600 mt-0.5 line-clamp-2">{n.summary}</div>}
                  <div className="text-[10px] text-zinc-700 mt-1">{n.source} · {timeAgo(n.datetime)}</div>
                </div>
                <ExternalLink size={11} className="text-zinc-700 group-hover:text-blue-400 flex-shrink-0 mt-0.5 transition-colors" />
              </a>
            ))}
          </div>
        </Panel>
      )}

      {/* ── History table ───────────────────────────────────────────────────── */}
      <div className="card">
        <h2 className="text-base font-semibold text-zinc-100 mb-4">
          Scorecard History <span className="text-zinc-600 text-sm font-normal">({entries.length})</span>
        </h2>
        {sorted.length === 0 ? (
          <p className="text-zinc-600 text-sm text-center py-8">No entries yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800">
                  {([['ticker', 'Ticker'], ['trade_date', 'Date'], ['weighted_score', 'Score']] as [SortKey, string][]).map(([k, label]) => (
                    <th key={k} className="th cursor-pointer select-none hover:text-zinc-300 whitespace-nowrap" onClick={() => toggleSort(k)}>
                      <span className="flex items-center gap-1">{label}<SortIcon k={k} /></span>
                    </th>
                  ))}
                  <th className="th">Tech</th>
                  <th className="th">Fund</th>
                  <th className="th">Risk</th>
                  <th className="th">Sent</th>
                  <th className="th">Verdict</th>
                  <th className="th">Notes</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {sorted.map(e => (
                  <tr key={e.id} className="tr-hover">
                    <td className="td">
                      <div className="font-mono font-bold text-blue-400">{e.ticker}</div>
                      {e.company_name && <div className="text-zinc-600 text-[11px]">{e.company_name}</div>}
                    </td>
                    <td className="td text-zinc-400 whitespace-nowrap">{e.trade_date}</td>
                    <td className="td font-bold text-lg tabular-nums">{fmt(e.weighted_score)}</td>
                    <td className="td text-center tabular-nums">{e.technical_score}</td>
                    <td className="td text-center tabular-nums">{e.fundamental_score}</td>
                    <td className="td text-center tabular-nums">{e.risk_liquidity_score}</td>
                    <td className="td text-center tabular-nums">{e.sentiment_score}</td>
                    <td className="td">
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${verdictBg(e.verdict)}`}>{e.verdict}</span>
                    </td>
                    <td className="td max-w-xs truncate text-zinc-500">{e.notes}</td>
                    <td className="td">
                      <button onClick={() => handleDelete(e.id)} className="btn-danger"><Trash2 size={12} /></button>
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
