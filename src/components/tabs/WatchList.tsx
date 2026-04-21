import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, RefreshCw, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { storage, newId, nowIso } from '../../lib/storage';
import { finnhub } from '../../lib/finnhub';
import { changeColor, fmtCurrency, fmtPct, fmt } from '../../lib/utils';
import type { WatchItem, FinnhubQuote, FinnhubSentiment, Conviction } from '../../types';

const TABLE = 'watchlist';

interface LiveData {
  quote?: FinnhubQuote;
  sentiment?: FinnhubSentiment;
  loading: boolean;
  error?: string;
}

const CONVICTION_ORDER: Conviction[] = ['HIGH', 'MEDIUM', 'LOW'];

const convictionBg: Record<Conviction, string> = {
  HIGH: 'bg-emerald-900/40 text-emerald-300 border border-emerald-700',
  MEDIUM: 'bg-amber-900/40 text-amber-300 border border-amber-700',
  LOW: 'bg-zinc-800 text-zinc-400 border border-zinc-700',
};

export default function WatchList() {
  const [items, setItems] = useState<WatchItem[]>([]);
  const [liveData, setLiveData] = useState<Record<string, LiveData>>({});
  const [ticker, setTicker] = useState('');
  const [conviction, setConviction] = useState<Conviction>('MEDIUM');
  const [notes, setNotes] = useState('');
  const [adding, setAdding] = useState(false);
  const [sortConviction, setSortConviction] = useState(true);

  const load = useCallback(async () => {
    const data = await storage.getAll<WatchItem>(TABLE);
    setItems(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function fetchLive(item: WatchItem) {
    setLiveData((prev) => ({ ...prev, [item.ticker]: { loading: true } }));
    try {
      const [quote, sentiment] = await Promise.all([
        finnhub.quote(item.ticker),
        finnhub.sentiment(item.ticker).catch(() => undefined),
      ]);
      setLiveData((prev) => ({ ...prev, [item.ticker]: { quote, sentiment, loading: false } }));
    } catch (err) {
      setLiveData((prev) => ({
        ...prev,
        [item.ticker]: { loading: false, error: 'Failed to fetch' },
      }));
    }
  }

  useEffect(() => {
    items.forEach((item) => {
      if (!liveData[item.ticker]) fetchLive(item);
    });
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!ticker.trim()) return;
    setAdding(true);
    try {
      const item: WatchItem = {
        id: newId(),
        ticker: ticker.toUpperCase().trim(),
        conviction,
        notes,
        added_at: nowIso(),
      };
      await storage.insert(TABLE, item);
      setTicker('');
      setNotes('');
      setConviction('MEDIUM');
      await load();
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string, t: string) {
    await storage.remove(TABLE, id);
    setLiveData((prev) => { const n = { ...prev }; delete n[t]; return n; });
    await load();
  }

  const sorted = sortConviction
    ? [...items].sort((a, b) =>
        CONVICTION_ORDER.indexOf(a.conviction) - CONVICTION_ORDER.indexOf(b.conviction)
      )
    : items;

  return (
    <div className="space-y-6">
      {/* Add form */}
      <div className="card">
        <h2 className="text-base font-semibold text-zinc-100 mb-4">Add to Watch List</h2>
        <form onSubmit={handleAdd} className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-32">
            <label className="label">Ticker *</label>
            <input
              className="input-base uppercase"
              placeholder="NVDA"
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              required
            />
          </div>
          <div className="w-36">
            <label className="label">Conviction</label>
            <select
              className="select-base"
              value={conviction}
              onChange={(e) => setConviction(e.target.value as Conviction)}
            >
              {CONVICTION_ORDER.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-48">
            <label className="label">Notes</label>
            <input
              className="input-base"
              placeholder="Setup thesis..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <button type="submit" className="btn-primary flex items-center gap-2" disabled={adding}>
            <Plus size={14} />
            {adding ? 'Adding...' : 'Add'}
          </button>
        </form>
      </div>

      {/* Watch list */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-zinc-100">
            Watching <span className="text-zinc-600 text-sm font-normal">({items.length})</span>
          </h2>
          <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
            <input
              type="checkbox"
              checked={sortConviction}
              onChange={(e) => setSortConviction(e.target.checked)}
              className="accent-blue-500"
            />
            Sort by conviction
          </label>
        </div>

        {sorted.length === 0 ? (
          <p className="text-zinc-600 text-sm text-center py-8">No tickers watched yet.</p>
        ) : (
          <div className="space-y-2">
            {sorted.map((item) => {
              const ld = liveData[item.ticker];
              const quote = ld?.quote;
              const sent = ld?.sentiment;
              const pct = quote?.dp ?? null;

              return (
                <div
                  key={item.id}
                  className="flex items-center gap-4 p-4 bg-zinc-800/40 rounded-lg border border-zinc-800 hover:border-zinc-700 transition-colors"
                >
                  {/* Ticker & conviction */}
                  <div className="w-28 flex-shrink-0">
                    <div className="font-mono font-bold text-blue-400 text-base">{item.ticker}</div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${convictionBg[item.conviction]}`}>
                      {item.conviction}
                    </span>
                  </div>

                  {/* Price */}
                  <div className="w-28 flex-shrink-0">
                    {ld?.loading ? (
                      <div className="text-zinc-600 text-xs animate-pulse">Loading...</div>
                    ) : ld?.error ? (
                      <div className="text-red-500 text-xs">{ld.error}</div>
                    ) : quote ? (
                      <>
                        <div className="text-lg font-semibold tabular-nums">{fmtCurrency(quote.c)}</div>
                        <div className={`text-xs font-medium flex items-center gap-1 ${changeColor(pct ?? 0)}`}>
                          {(pct ?? 0) > 0 ? <TrendingUp size={10} /> : (pct ?? 0) < 0 ? <TrendingDown size={10} /> : <Minus size={10} />}
                          {fmtPct(pct)}
                        </div>
                      </>
                    ) : null}
                  </div>

                  {/* Day range */}
                  {quote && (
                    <div className="hidden sm:block w-36 flex-shrink-0 text-xs text-zinc-500">
                      <div>H: {fmtCurrency(quote.h)}</div>
                      <div>L: {fmtCurrency(quote.l)}</div>
                    </div>
                  )}

                  {/* Sentiment */}
                  <div className="hidden md:block w-40 flex-shrink-0">
                    {sent?.sentiment ? (
                      <div className="space-y-0.5">
                        <div className="text-xs text-zinc-500">News Sentiment</div>
                        <div className="flex gap-2 text-xs">
                          <span className="text-emerald-400">▲ {fmt(sent.sentiment.bullishPercent * 100, 0)}%</span>
                          <span className="text-red-400">▼ {fmt(sent.sentiment.bearishPercent * 100, 0)}%</span>
                        </div>
                        <div className="w-full bg-zinc-700 rounded-full h-1.5">
                          <div
                            className="bg-emerald-500 h-1.5 rounded-full"
                            style={{ width: `${sent.sentiment.bullishPercent * 100}%` }}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {/* Notes */}
                  <div className="flex-1 text-xs text-zinc-500 truncate hidden lg:block">{item.notes}</div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => fetchLive(item)}
                      className="btn-ghost p-1.5"
                      title="Refresh"
                    >
                      <RefreshCw size={13} className={ld?.loading ? 'animate-spin' : ''} />
                    </button>
                    <button onClick={() => handleDelete(item.id, item.ticker)} className="btn-danger">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
