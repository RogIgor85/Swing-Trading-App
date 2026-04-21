import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Edit2, X, Check } from 'lucide-react';
import { storage, newId, nowIso } from '../../lib/storage';
import { calcRR, fmt, fmtCurrency } from '../../lib/utils';
import type { TechnicalSetup as TTechnicalSetup, TrendDirection } from '../../types';

const TABLE = 'technical_setups';

const CHART_PATTERNS = [
  'None', 'Bull Flag', 'Bear Flag', 'Cup & Handle', 'Inverse H&S', 'H&S',
  'Double Bottom', 'Double Top', 'Ascending Triangle', 'Descending Triangle',
  'Symmetrical Triangle', 'Wedge Up', 'Wedge Down', 'Breakout', 'Breakdown',
  'Base Breakout', 'VCP', 'IPO Base', 'Other',
];

const trendColors: Record<TrendDirection, string> = {
  BULLISH: 'text-emerald-400',
  BEARISH: 'text-red-400',
  NEUTRAL: 'text-zinc-400',
};

const defaultForm = {
  ticker: '',
  trend_daily: 'NEUTRAL' as TrendDirection,
  trend_weekly: 'NEUTRAL' as TrendDirection,
  trend_monthly: 'NEUTRAL' as TrendDirection,
  support_levels: '',
  resistance_levels: '',
  ma_50: '',
  ma_200: '',
  rsi: '',
  macd: '',
  chart_pattern: 'None',
  entry_price: '',
  stop_loss: '',
  target: '',
  confidence: 5,
  notes: '',
};

export default function TechnicalSetup() {
  const [setups, setSetups] = useState<TTechnicalSetup[]>([]);
  const [form, setForm] = useState(defaultForm);
  const [loading, setLoading] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await storage.getAll<TTechnicalSetup>(TABLE);
    setSetups(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  const entry = parseFloat(form.entry_price) || 0;
  const stop = parseFloat(form.stop_loss) || 0;
  const target = parseFloat(form.target) || 0;
  const rr = entry && stop && target ? calcRR(entry, stop, target) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.ticker) return;
    setLoading(true);
    try {
      const setup: TTechnicalSetup = {
        id: editId ?? newId(),
        ticker: form.ticker.toUpperCase(),
        trend_daily: form.trend_daily,
        trend_weekly: form.trend_weekly,
        trend_monthly: form.trend_monthly,
        support_levels: form.support_levels,
        resistance_levels: form.resistance_levels,
        ma_50: form.ma_50 ? parseFloat(form.ma_50) : null,
        ma_200: form.ma_200 ? parseFloat(form.ma_200) : null,
        rsi: form.rsi ? parseFloat(form.rsi) : null,
        macd: form.macd,
        chart_pattern: form.chart_pattern,
        entry_price: entry || null,
        stop_loss: stop || null,
        target: target || null,
        rr_ratio: rr,
        confidence: form.confidence,
        notes: form.notes,
        created_at: nowIso(),
      };
      if (editId) {
        await storage.update(TABLE, editId, setup);
        setEditId(null);
      } else {
        await storage.insert(TABLE, setup);
      }
      setForm(defaultForm);
      await load();
    } finally {
      setLoading(false);
    }
  }

  function startEdit(s: TTechnicalSetup) {
    setEditId(s.id);
    setForm({
      ticker: s.ticker,
      trend_daily: s.trend_daily,
      trend_weekly: s.trend_weekly,
      trend_monthly: s.trend_monthly,
      support_levels: s.support_levels,
      resistance_levels: s.resistance_levels,
      ma_50: s.ma_50?.toString() ?? '',
      ma_200: s.ma_200?.toString() ?? '',
      rsi: s.rsi?.toString() ?? '',
      macd: s.macd,
      chart_pattern: s.chart_pattern,
      entry_price: s.entry_price?.toString() ?? '',
      stop_loss: s.stop_loss?.toString() ?? '',
      target: s.target?.toString() ?? '',
      confidence: s.confidence,
      notes: s.notes,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleDelete(id: string) {
    await storage.remove(TABLE, id);
    await load();
  }

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-zinc-100">
            {editId ? 'Edit Setup' : 'New Technical Setup'}
          </h2>
          {editId && (
            <button onClick={() => { setEditId(null); setForm(defaultForm); }} className="btn-ghost flex items-center gap-1.5">
              <X size={13} /> Cancel Edit
            </button>
          )}
        </div>
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Ticker */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <label className="label">Ticker *</label>
              <input
                className="input-base uppercase"
                placeholder="TSLA"
                value={form.ticker}
                onChange={(e) => setForm({ ...form, ticker: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="label">Chart Pattern</label>
              <select className="select-base" value={form.chart_pattern} onChange={(e) => setForm({ ...form, chart_pattern: e.target.value })}>
                {CHART_PATTERNS.map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Confidence (1-10)</label>
              <div className="flex items-center gap-3">
                <input
                  type="range" min={1} max={10} value={form.confidence}
                  onChange={(e) => setForm({ ...form, confidence: parseInt(e.target.value) })}
                  className="flex-1 accent-blue-500"
                />
                <span className="text-blue-400 font-bold w-4 tabular-nums">{form.confidence}</span>
              </div>
            </div>
          </div>

          {/* Trend direction */}
          <div>
            <label className="label">Trend Direction</label>
            <div className="grid grid-cols-3 gap-3">
              {(['daily', 'weekly', 'monthly'] as const).map((tf) => {
                const key = `trend_${tf}` as 'trend_daily' | 'trend_weekly' | 'trend_monthly';
                return (
                  <div key={tf} className="bg-zinc-800/40 rounded-lg p-3">
                    <div className="text-xs text-zinc-500 mb-2 uppercase tracking-wider">{tf}</div>
                    <div className="flex gap-1">
                      {(['BULLISH', 'NEUTRAL', 'BEARISH'] as TrendDirection[]).map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setForm({ ...form, [key]: d })}
                          className={`flex-1 text-xs py-1.5 rounded font-medium transition ${
                            form[key] === d
                              ? d === 'BULLISH' ? 'bg-emerald-700 text-emerald-100' : d === 'BEARISH' ? 'bg-red-800 text-red-100' : 'bg-zinc-600 text-zinc-100'
                              : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'
                          }`}
                        >
                          {d === 'BULLISH' ? '▲' : d === 'BEARISH' ? '▼' : '–'}
                        </button>
                      ))}
                    </div>
                    <div className={`text-xs mt-1 font-medium ${trendColors[form[key]]}`}>{form[key]}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Technical indicators */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <label className="label">50-Day MA</label>
              <input className="input-base" type="number" step="0.01" placeholder="150.00" value={form.ma_50} onChange={(e) => setForm({ ...form, ma_50: e.target.value })} />
            </div>
            <div>
              <label className="label">200-Day MA</label>
              <input className="input-base" type="number" step="0.01" placeholder="140.00" value={form.ma_200} onChange={(e) => setForm({ ...form, ma_200: e.target.value })} />
            </div>
            <div>
              <label className="label">RSI (14)</label>
              <input className="input-base" type="number" step="0.1" min="0" max="100" placeholder="55.0" value={form.rsi} onChange={(e) => setForm({ ...form, rsi: e.target.value })} />
            </div>
            <div>
              <label className="label">MACD Signal</label>
              <input className="input-base" placeholder="Bullish crossover" value={form.macd} onChange={(e) => setForm({ ...form, macd: e.target.value })} />
            </div>
          </div>

          {/* Key levels */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Support Levels (comma separated)</label>
              <input className="input-base" placeholder="145.00, 140.50, 135.00" value={form.support_levels} onChange={(e) => setForm({ ...form, support_levels: e.target.value })} />
            </div>
            <div>
              <label className="label">Resistance Levels (comma separated)</label>
              <input className="input-base" placeholder="155.00, 160.00, 165.50" value={form.resistance_levels} onChange={(e) => setForm({ ...form, resistance_levels: e.target.value })} />
            </div>
          </div>

          {/* Trade levels */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 items-end">
            <div>
              <label className="label">Entry Price</label>
              <input className="input-base" type="number" step="0.01" placeholder="150.00" value={form.entry_price} onChange={(e) => setForm({ ...form, entry_price: e.target.value })} />
            </div>
            <div>
              <label className="label">Stop-Loss</label>
              <input className="input-base" type="number" step="0.01" placeholder="145.00" value={form.stop_loss} onChange={(e) => setForm({ ...form, stop_loss: e.target.value })} />
            </div>
            <div>
              <label className="label">Target</label>
              <input className="input-base" type="number" step="0.01" placeholder="165.00" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} />
            </div>
            <div className="bg-zinc-800/40 rounded-lg px-4 py-2.5">
              <div className="text-xs text-zinc-500 mb-0.5">R:R Ratio</div>
              <div className={`text-xl font-bold tabular-nums ${rr && rr >= 2 ? 'text-emerald-400' : rr && rr >= 1 ? 'text-amber-400' : 'text-zinc-400'}`}>
                {rr ? `1 : ${rr}` : '—'}
              </div>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="label">Notes</label>
            <textarea className="input-base resize-none" rows={3} placeholder="Setup rationale, key observations..." value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>

          <button type="submit" className="btn-primary flex items-center gap-2" disabled={loading}>
            {editId ? <Check size={14} /> : <Plus size={14} />}
            {loading ? 'Saving...' : editId ? 'Update Setup' : 'Save Setup'}
          </button>
        </form>
      </div>

      {/* Saved setups */}
      <div className="card">
        <h2 className="text-base font-semibold text-zinc-100 mb-4">
          Saved Setups <span className="text-zinc-600 text-sm font-normal">({setups.length})</span>
        </h2>
        {setups.length === 0 ? (
          <p className="text-zinc-600 text-sm text-center py-8">No setups saved yet.</p>
        ) : (
          <div className="space-y-3">
            {setups.map((s) => (
              <div key={s.id} className="bg-zinc-800/40 rounded-lg border border-zinc-800 p-4">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <span className="font-mono font-bold text-blue-400 text-lg">{s.ticker}</span>
                    {s.chart_pattern !== 'None' && (
                      <span className="text-xs bg-blue-900/40 text-blue-300 border border-blue-700 px-2 py-0.5 rounded-full">{s.chart_pattern}</span>
                    )}
                    <span className="text-xs text-zinc-500">Confidence: <span className="text-zinc-300 font-medium">{s.confidence}/10</span></span>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => startEdit(s)} className="btn-ghost flex items-center gap-1 text-xs">
                      <Edit2 size={11} /> Edit
                    </button>
                    <button onClick={() => handleDelete(s.id)} className="btn-danger">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 text-xs mb-3">
                  {(['daily', 'weekly', 'monthly'] as const).map((tf) => {
                    const key = `trend_${tf}` as keyof TTechnicalSetup;
                    const val = s[key] as TrendDirection;
                    return (
                      <div key={tf} className="text-center">
                        <div className="text-zinc-600 uppercase mb-0.5">{tf.slice(0, 1)}</div>
                        <span className={`font-medium ${trendColors[val]}`}>
                          {val === 'BULLISH' ? '▲' : val === 'BEARISH' ? '▼' : '–'} {val}
                        </span>
                      </div>
                    );
                  })}
                  <div className="text-center">
                    <div className="text-zinc-600 mb-0.5">RSI</div>
                    <span className={`font-medium ${s.rsi && s.rsi > 70 ? 'text-red-400' : s.rsi && s.rsi < 30 ? 'text-emerald-400' : 'text-zinc-300'}`}>
                      {s.rsi ?? '—'}
                    </span>
                  </div>
                  <div className="text-center">
                    <div className="text-zinc-600 mb-0.5">50MA</div>
                    <span className="text-zinc-300">{s.ma_50 ? fmtCurrency(s.ma_50) : '—'}</span>
                  </div>
                  <div className="text-center">
                    <div className="text-zinc-600 mb-0.5">200MA</div>
                    <span className="text-zinc-300">{s.ma_200 ? fmtCurrency(s.ma_200) : '—'}</span>
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-3 text-xs">
                  <div><span className="text-zinc-600">Entry: </span><span className="text-zinc-200">{s.entry_price ? fmtCurrency(s.entry_price) : '—'}</span></div>
                  <div><span className="text-zinc-600">Stop: </span><span className="text-red-400">{s.stop_loss ? fmtCurrency(s.stop_loss) : '—'}</span></div>
                  <div><span className="text-zinc-600">Target: </span><span className="text-emerald-400">{s.target ? fmtCurrency(s.target) : '—'}</span></div>
                  <div>
                    <span className="text-zinc-600">R:R: </span>
                    <span className={`font-semibold ${s.rr_ratio && s.rr_ratio >= 2 ? 'text-emerald-400' : s.rr_ratio && s.rr_ratio >= 1 ? 'text-amber-400' : 'text-zinc-400'}`}>
                      {s.rr_ratio ? `1:${fmt(s.rr_ratio)}` : '—'}
                    </span>
                  </div>
                </div>

                {(s.support_levels || s.resistance_levels) && (
                  <div className="mt-2 flex gap-4 text-xs text-zinc-500">
                    {s.support_levels && <span>Support: <span className="text-emerald-400/80">{s.support_levels}</span></span>}
                    {s.resistance_levels && <span>Resistance: <span className="text-red-400/80">{s.resistance_levels}</span></span>}
                  </div>
                )}

                {s.notes && <div className="mt-2 text-xs text-zinc-500 border-t border-zinc-800 pt-2">{s.notes}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
