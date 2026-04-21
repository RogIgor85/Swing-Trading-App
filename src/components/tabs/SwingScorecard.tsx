import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { storage, newId, nowIso } from '../../lib/storage';
import { calcWeightedScore, getVerdict, verdictBg, fmt } from '../../lib/utils';
import type { ScorecardEntry } from '../../types';

const TABLE = 'scorecard_entries';

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

type SortKey = 'trade_date' | 'weighted_score' | 'ticker';

export default function SwingScorecard() {
  const [entries, setEntries] = useState<ScorecardEntry[]>([]);
  const [form, setForm] = useState(defaultForm);
  const [loading, setLoading] = useState(false);
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

  return (
    <div className="space-y-6">
      {/* Score Form */}
      <div className="card">
        <h2 className="text-base font-semibold text-zinc-100 mb-5">New Scorecard Entry</h2>
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Header fields */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="label">Ticker *</label>
              <input
                className="input-base uppercase"
                placeholder="AAPL"
                value={form.ticker}
                onChange={(e) => setForm({ ...form, ticker: e.target.value })}
                required
              />
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
