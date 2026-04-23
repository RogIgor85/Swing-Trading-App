import { useState, useEffect, useCallback } from 'react';
import { Search, Save, Trash2, RefreshCw, ExternalLink } from 'lucide-react';
import { storage, newId, nowIso } from '../../lib/storage';
import { finnhub } from '../../lib/finnhub';
import { fmt, fmtCurrency, fmtPct } from '../../lib/utils';
import type {
  FundamentalNote,
  FinnhubProfile,
  FinnhubMetrics,
  FinnhubEarnings,
  FinnhubSentiment,
} from '../../types';

const TABLE = 'fundamentals';

interface FinnhubData {
  profile?: FinnhubProfile;
  metrics?: FinnhubMetrics;
  earnings?: FinnhubEarnings[];
  epsEst?: Array<{ epsAvg: number; epsHigh: number; epsLow: number; period: string; year: number }>;
  revEst?: Array<{ revenueAvg: number; revenueHigh: number; revenueLow: number; period: string; year: number }>;
  sentiment?: FinnhubSentiment;
  loading: boolean;
  error?: string;
}

export default function Fundamentals() {
  const [notes, setNotes] = useState<FundamentalNote[]>([]);
  const [searchTicker, setSearchTicker] = useState('');
  const [activeTicker, setActiveTicker] = useState('');
  const [data, setData] = useState<FinnhubData>({ loading: false });
  const [bullCase, setBullCase] = useState('');
  const [bearCase, setBearCase] = useState('');
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState(false);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await storage.getAll<FundamentalNote>(TABLE);
    setNotes(d);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function fetchData(ticker: string) {
    const t = ticker.toUpperCase().trim();
    if (!t) return;
    setActiveTicker(t);
    setData({ loading: true });
    try {
      const [profile, metrics, earnings, epsEst, revEst, sentiment] = await Promise.allSettled([
        finnhub.profile(t),
        finnhub.metrics(t),
        finnhub.earnings(t),
        finnhub.epsEstimate(t),
        finnhub.revenueEstimate(t),
        finnhub.sentiment(t),
      ]);

      setData({
        loading: false,
        profile: profile.status === 'fulfilled' ? profile.value : undefined,
        metrics: metrics.status === 'fulfilled' ? metrics.value : undefined,
        earnings: earnings.status === 'fulfilled' ? earnings.value : undefined,
        epsEst: epsEst.status === 'fulfilled' ? epsEst.value.data?.slice(0, 4) : undefined,
        revEst: revEst.status === 'fulfilled' ? revEst.value.data?.slice(0, 4) : undefined,
        sentiment: sentiment.status === 'fulfilled' ? sentiment.value : undefined,
      });

      // Load saved notes for this ticker
      const existing = notes.find((n) => n.ticker === t);
      if (existing) {
        setBullCase(existing.bull_case);
        setBearCase(existing.bear_case);
        setNoteText(existing.notes);
        setActiveNoteId(existing.id);
      } else {
        setBullCase('');
        setBearCase('');
        setNoteText('');
        setActiveNoteId(null);
      }
    } catch {
      setData({ loading: false, error: 'Failed to fetch data' });
    }
  }

  async function handleSave() {
    if (!activeTicker) return;
    setSaving(true);
    try {
      if (activeNoteId) {
        await storage.update(TABLE, activeNoteId, {
          bull_case: bullCase,
          bear_case: bearCase,
          notes: noteText,
        });
      } else {
        const note: FundamentalNote = {
          id: newId(),
          ticker: activeTicker,
          bull_case: bullCase,
          bear_case: bearCase,
          notes: noteText,
          created_at: nowIso(),
        };
        await storage.insert(TABLE, note);
        setActiveNoteId(note.id);
      }
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteNote(id: string) {
    await storage.remove(TABLE, id);
    if (activeNoteId === id) {
      setBullCase('');
      setBearCase('');
      setNoteText('');
      setActiveNoteId(null);
    }
    await load();
  }

  const m = data.metrics?.metric;
  const profile = data.profile;

  return (
    <div className="space-y-6">
      {/* Search */}
      <div className="card">
        <h2 className="text-base font-semibold text-zinc-100 mb-4">Fundamental Research</h2>
        <form
          onSubmit={(e) => { e.preventDefault(); fetchData(searchTicker); }}
          className="flex gap-3"
        >
          <input
            className="input-base flex-1 uppercase"
            placeholder="Enter ticker (e.g. AAPL, NVDA, TSLA)"
            value={searchTicker}
            onChange={(e) => setSearchTicker(e.target.value)}
          />
          <button type="submit" className="btn-primary flex items-center gap-2" disabled={data.loading}>
            <Search size={14} />
            {data.loading ? 'Loading...' : 'Research'}
          </button>
        </form>

        {/* Saved tickers quick access */}
        {notes.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {notes.map((n) => (
              <div key={n.id} className="flex items-center gap-1">
                <button
                  onClick={() => { setSearchTicker(n.ticker); fetchData(n.ticker); }}
                  className={`text-xs px-3 py-1 rounded-full border transition ${
                    activeTicker === n.ticker
                      ? 'bg-blue-900/50 text-blue-300 border-blue-700'
                      : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-500'
                  }`}
                >
                  {n.ticker}
                </button>
                <button onClick={() => handleDeleteNote(n.id)} className="text-zinc-600 hover:text-red-400 transition">
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {data.error && (
        <div className="card border-red-900 bg-red-900/10 text-red-400 text-sm">{data.error}</div>
      )}

      {profile && (
        <>
          {/* Company profile */}
          <div className="card">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                {profile.logo && (
                  <img src={profile.logo} alt={profile.name} className="w-10 h-10 rounded-lg object-contain bg-white p-0.5" />
                )}
                <div>
                  <h2 className="text-lg font-bold text-zinc-100">{profile.name}</h2>
                  <div className="flex gap-2 text-xs text-zinc-500 mt-0.5">
                    <span className="font-mono text-blue-400">{activeTicker}</span>
                    <span>·</span>
                    <span>{profile.exchange}</span>
                    <span>·</span>
                    <span>{profile.finnhubIndustry}</span>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => fetchData(activeTicker)} className="btn-ghost flex items-center gap-1.5 text-xs">
                  <RefreshCw size={12} /> Refresh
                </button>
                {profile.weburl && (
                  <a href={profile.weburl} target="_blank" rel="noopener noreferrer" className="btn-ghost flex items-center gap-1.5 text-xs">
                    <ExternalLink size={12} /> Website
                  </a>
                )}
              </div>
            </div>

            {/* Key metrics grid */}
            {m && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Market Cap', value: profile.marketCapitalization ? `$${(profile.marketCapitalization / 1000).toFixed(1)}B` : '—' },
                  { label: 'P/E Ratio', value: m.peBasicExclExtraTTM ? fmt(m.peBasicExclExtraTTM, 1) + 'x' : '—' },
                  { label: 'P/B Ratio', value: m.pbAnnual ? fmt(m.pbAnnual, 2) + 'x' : '—' },
                  { label: 'Beta', value: m.beta ? fmt(m.beta, 2) : '—' },
                  { label: '52W High', value: m['52WeekHigh'] ? fmtCurrency(m['52WeekHigh']) : '—' },
                  { label: '52W Low', value: m['52WeekLow'] ? fmtCurrency(m['52WeekLow']) : '—' },
                  { label: 'EPS Growth 3Y', value: m.epsGrowth3Y ? fmtPct(m.epsGrowth3Y) : '—' },
                  { label: 'Rev Growth 3Y', value: m.revenueGrowth3Y ? fmtPct(m.revenueGrowth3Y) : '—' },
                  { label: 'ROE', value: m.roeTTM ? fmtPct(m.roeTTM) : '—' },
                  { label: 'Gross Margin', value: m.grossMarginTTM ? fmtPct(m.grossMarginTTM) : '—' },
                  { label: 'Net Margin', value: m.netProfitMarginTTM ? fmtPct(m.netProfitMarginTTM) : '—' },
                  { label: 'Debt/Equity', value: m.debtEquityAnnual ? fmt(m.debtEquityAnnual, 2) : '—' },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-zinc-800/40 rounded-lg p-3">
                    <div className="text-xs text-zinc-500 mb-1">{label}</div>
                    <div className="text-sm font-semibold text-zinc-100">{value}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Earnings history */}
          {data.earnings && data.earnings.length > 0 && (
            <div className="card">
              <h2 className="text-base font-semibold text-zinc-100 mb-4">Earnings Surprises (Recent)</h2>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      <th className="th">Period</th>
                      <th className="th">EPS Estimate</th>
                      <th className="th">EPS Actual</th>
                      <th className="th">Surprise</th>
                      <th className="th">Surprise %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800">
                    {data.earnings.slice(0, 8).map((e) => (
                      <tr key={`${e.period}-${e.quarter}`} className="tr-hover">
                        <td className="td">{e.period} Q{e.quarter}</td>
                        <td className="td tabular-nums">{e.estimate != null ? fmt(e.estimate) : '—'}</td>
                        <td className="td tabular-nums font-medium">{e.actual != null ? fmt(e.actual) : '—'}</td>
                        <td className={`td tabular-nums font-medium ${(e.surprise ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {e.surprise != null ? (e.surprise >= 0 ? '+' : '') + fmt(e.surprise) : '—'}
                        </td>
                        <td className={`td tabular-nums font-medium ${(e.surprisePercent ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {e.surprisePercent != null ? fmtPct(e.surprisePercent) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* EPS & Revenue estimates */}
          {(data.epsEst?.length || data.revEst?.length) ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {data.epsEst && data.epsEst.length > 0 && (
                <div className="card">
                  <h2 className="text-base font-semibold text-zinc-100 mb-4">EPS Estimates (Forward)</h2>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-zinc-800">
                        <th className="th">Period</th>
                        <th className="th">Avg</th>
                        <th className="th">High</th>
                        <th className="th">Low</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                      {data.epsEst.map((e) => (
                        <tr key={e.period} className="tr-hover">
                          <td className="td">{e.period}</td>
                          <td className="td font-semibold tabular-nums">{fmt(e.epsAvg)}</td>
                          <td className="td text-emerald-400 tabular-nums">{fmt(e.epsHigh)}</td>
                          <td className="td text-red-400 tabular-nums">{fmt(e.epsLow)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {data.revEst && data.revEst.length > 0 && (
                <div className="card">
                  <h2 className="text-base font-semibold text-zinc-100 mb-4">Revenue Estimates (Forward)</h2>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-zinc-800">
                        <th className="th">Period</th>
                        <th className="th">Avg</th>
                        <th className="th">High</th>
                        <th className="th">Low</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                      {data.revEst.map((e) => (
                        <tr key={e.period} className="tr-hover">
                          <td className="td">{e.period}</td>
                          <td className="td font-semibold tabular-nums">${(e.revenueAvg / 1e9).toFixed(2)}B</td>
                          <td className="td text-emerald-400 tabular-nums">${(e.revenueHigh / 1e9).toFixed(2)}B</td>
                          <td className="td text-red-400 tabular-nums">${(e.revenueLow / 1e9).toFixed(2)}B</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}

          {/* Sentiment */}
          {data.sentiment?.sentiment && (
            <div className="card">
              <h2 className="text-base font-semibold text-zinc-100 mb-4">News Sentiment</h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
                <div className="bg-zinc-800/40 rounded-lg p-3">
                  <div className="text-xs text-zinc-500 mb-1">Bullish</div>
                  <div className="text-xl font-bold text-emerald-400">{fmt(data.sentiment.sentiment.bullishPercent * 100, 1)}%</div>
                </div>
                <div className="bg-zinc-800/40 rounded-lg p-3">
                  <div className="text-xs text-zinc-500 mb-1">Bearish</div>
                  <div className="text-xl font-bold text-red-400">{fmt(data.sentiment.sentiment.bearishPercent * 100, 1)}%</div>
                </div>
                <div className="bg-zinc-800/40 rounded-lg p-3">
                  <div className="text-xs text-zinc-500 mb-1">Articles (7d)</div>
                  <div className="text-xl font-bold">{data.sentiment.buzz?.articlesInLastWeek ?? '—'}</div>
                </div>
                <div className="bg-zinc-800/40 rounded-lg p-3">
                  <div className="text-xs text-zinc-500 mb-1">Company Score</div>
                  <div className="text-xl font-bold">{data.sentiment.companyNewsScore ? fmt(data.sentiment.companyNewsScore, 2) : '—'}</div>
                </div>
              </div>
              {/* Sentiment bar */}
              <div className="w-full bg-zinc-700 rounded-full h-3 overflow-hidden">
                <div
                  className="bg-gradient-to-r from-emerald-500 to-emerald-400 h-3 rounded-full transition-all"
                  style={{ width: `${data.sentiment.sentiment.bullishPercent * 100}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-zinc-500 mt-1">
                <span>Bearish</span>
                <span>Neutral</span>
                <span>Bullish</span>
              </div>
            </div>
          )}

          {/* Bull/Bear case & notes */}
          <div className="card">
            <h2 className="text-base font-semibold text-zinc-100 mb-4">
              Research Notes — <span className="text-blue-400">{activeTicker}</span>
              {activeNoteId && <span className="ml-2 text-xs text-zinc-600">(saved)</span>}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="label text-emerald-400">Bull Case</label>
                <textarea
                  className="input-base resize-none border-emerald-900/50 focus:border-emerald-600"
                  rows={5}
                  placeholder="Key bull case arguments:&#10;• Strong revenue growth&#10;• Margin expansion&#10;• Catalyst: product cycle..."
                  value={bullCase}
                  onChange={(e) => setBullCase(e.target.value)}
                />
              </div>
              <div>
                <label className="label text-red-400">Bear Case</label>
                <textarea
                  className="input-base resize-none border-red-900/50 focus:border-red-700"
                  rows={5}
                  placeholder="Key bear case arguments:&#10;• Valuation stretched&#10;• Margin compression risk&#10;• Competitive threat..."
                  value={bearCase}
                  onChange={(e) => setBearCase(e.target.value)}
                />
              </div>
            </div>
            <div className="mb-4">
              <label className="label">Additional Notes / Management Guidance / Segment Breakdown</label>
              <textarea
                className="input-base resize-none"
                rows={4}
                placeholder="Management guidance, segment commentary, key metrics to watch next quarter..."
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
              />
            </div>
            <button onClick={handleSave} className="btn-primary flex items-center gap-2" disabled={saving}>
              <Save size={14} />
              {saving ? 'Saving...' : 'Save Notes'}
            </button>
          </div>
        </>
      )}

      {/* Saved notes list */}
      {notes.length > 0 && !activeTicker && (
        <div className="card">
          <h2 className="text-base font-semibold text-zinc-100 mb-4">Saved Research</h2>
          <div className="space-y-2">
            {notes.map((n) => (
              <div key={n.id} className="flex items-center justify-between p-3 bg-zinc-800/40 rounded-lg border border-zinc-800">
                <div>
                  <span className="font-mono font-bold text-blue-400">{n.ticker}</span>
                  {n.bull_case && <span className="ml-3 text-xs text-zinc-500 truncate max-w-xs">{n.bull_case.slice(0, 80)}…</span>}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => { setSearchTicker(n.ticker); fetchData(n.ticker); }} className="btn-ghost text-xs flex items-center gap-1">
                    <Search size={11} /> Open
                  </button>
                  <button onClick={() => handleDeleteNote(n.id)} className="btn-danger">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!activeTicker && notes.length === 0 && (
        <div className="card text-center py-12 text-zinc-600 text-sm">
          Search a ticker above to pull fundamentals from Finnhub.
        </div>
      )}
    </div>
  );
}
