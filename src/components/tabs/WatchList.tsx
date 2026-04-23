import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, RefreshCw, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { storage, newId, nowIso } from '../../lib/storage';
import { finnhub } from '../../lib/finnhub';
import { fetchYahoo } from '../../lib/yahoo';
import { toYahooTicker } from '../FundamentalsDrawer';
import { changeColor, fmtCurrency, fmtPct, fmt } from '../../lib/utils';
import type { WatchItem, FinnhubQuote, FinnhubSentiment, Conviction } from '../../types';

const TABLE = 'watch_items';

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

function daysSince(dateStr: string): number {
  const then = new Date(dateStr).getTime();
  const now = Date.now();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

export default function WatchList() {
  const [items, setItems] = useState<WatchItem[]>([]);
  const [liveData, setLiveData] = useState<Record<string, LiveData>>({});
  const [ticker, setTicker] = useState('');
  const [conviction, setConviction] = useState<Conviction>('MEDIUM');
  const [notes, setNotes] = useState('');
  const [watchPrice, setWatchPrice] = useState('');
  const [watchDate, setWatchDate] = useState(new Date().toISOString().split('T')[0]);
  const [analystTarget, setAnalystTarget] = useState('');
  const [targetEntry, setTargetEntry] = useState('');
  const [adding, setAdding] = useState(false);
  const [fetchingPrice, setFetchingPrice] = useState(false);
  const [sortConviction, setSortConviction] = useState(true);

  const load = useCallback(async () => {
    const data = await storage.getAll<WatchItem>(TABLE);
    setItems(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-fetch current price when ticker is entered
  async function handleTickerBlur() {
    if (!ticker.trim() || watchPrice) return;
    setFetchingPrice(true);
    try {
      const t = ticker.trim().toUpperCase();
      const q = await finnhub.quote(t);
      if (q.c && q.c > 0) { setWatchPrice(q.c.toFixed(2)); return; }
      // Fallback: Yahoo Finance (handles .TO and other exchange suffixes)
      const yahooTicker = toYahooTicker(t, t.endsWith('.TO') || t.endsWith('.V') ? 'CAD' : 'USD');
      const y = await fetchYahoo(yahooTicker);
      const price = y.price?.regularMarketPrice ?? null;
      if (price && price > 0) setWatchPrice(price.toFixed(2));
    } catch { /* ignore */ } finally {
      setFetchingPrice(false);
    }
  }

  async function fetchLive(item: WatchItem) {
    setLiveData((prev) => ({ ...prev, [item.ticker]: { loading: true } }));
    try {
      // Try Finnhub first
      const q = await finnhub.quote(item.ticker).catch(() => null);
      const sentiment = await finnhub.sentiment(item.ticker).catch(() => undefined);

      if (q && q.c && q.c > 0) {
        setLiveData((prev) => ({ ...prev, [item.ticker]: { quote: q, sentiment, loading: false } }));
        return;
      }

      // Yahoo Finance fallback for TSX and other exchanges
      const isCAD = item.ticker.includes('.TO') || item.ticker.includes('.V') ||
                    item.ticker.includes('.TSX') || item.ticker.includes('.CN');
      const yahooTicker = toYahooTicker(item.ticker, isCAD ? 'CAD' : 'USD');
      const y = await fetchYahoo(yahooTicker);
      const price = y.price?.regularMarketPrice ?? null;

      if (price != null && price > 0) {
        const syntheticQuote: FinnhubQuote = {
          c:  price,
          d:  y.price?.regularMarketChange  ?? 0,
          dp: (y.price?.regularMarketChangePercent ?? 0) * 100,
          h:  y.price?.regularMarketDayHigh ?? price,
          l:  y.price?.regularMarketDayLow  ?? price,
          o:  y.price?.regularMarketOpen    ?? price,
          pc: y.price?.regularMarketPreviousClose ?? price,
        };
        setLiveData((prev) => ({ ...prev, [item.ticker]: { quote: syntheticQuote, sentiment, loading: false } }));
      } else {
        setLiveData((prev) => ({ ...prev, [item.ticker]: { loading: false, error: 'No price data' } }));
      }
    } catch {
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
      // If no price entered, try to fetch it
      let price: number | null = watchPrice ? parseFloat(watchPrice) : null;
      if (!price) {
        try {
          const t = ticker.trim().toUpperCase();
          const q = await finnhub.quote(t);
          if (q.c && q.c > 0) { price = q.c; }
          else {
            const isCAD = t.includes('.TO') || t.includes('.V') || t.includes('.TSX') || t.includes('.CN');
            const yahooTicker = toYahooTicker(t, isCAD ? 'CAD' : 'USD');
            const y = await fetchYahoo(yahooTicker);
            price = y.price?.regularMarketPrice ?? null;
          }
        } catch { /* leave null */ }
      }

      const item: WatchItem = {
        id: newId(),
        ticker: ticker.toUpperCase().trim(),
        conviction,
        notes,
        watch_price: price,
        watch_date: watchDate,
        analyst_target: analystTarget ? parseFloat(analystTarget) : null,
        target_entry: targetEntry ? parseFloat(targetEntry) : null,
        created_at: nowIso(),
      };
      await storage.insert(TABLE, item);
      setTicker('');
      setNotes('');
      setWatchPrice('');
      setWatchDate(new Date().toISOString().split('T')[0]);
      setConviction('MEDIUM');
      setAnalystTarget('');
      setTargetEntry('');
      await load();
    } catch { /* ignore */ } finally {
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
          <div className="w-28">
            <label className="label">Ticker *</label>
            <input
              className="input-base uppercase"
              placeholder="NVDA"
              value={ticker}
              onChange={(e) => { setTicker(e.target.value); setWatchPrice(''); }}
              onBlur={handleTickerBlur}
              required
            />
          </div>
          <div className="w-28">
            <label className="label">
              Watch Price
              {fetchingPrice && <span className="ml-1 text-zinc-600 text-xs">fetching…</span>}
            </label>
            <input
              className="input-base"
              type="number"
              step="0.01"
              placeholder="auto"
              value={watchPrice}
              onChange={(e) => setWatchPrice(e.target.value)}
            />
          </div>
          <div className="w-36">
            <label className="label">Watch Date</label>
            <input
              className="input-base"
              type="date"
              value={watchDate}
              onChange={(e) => setWatchDate(e.target.value)}
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
          <div className="w-28">
            <label className="label">Target Entry</label>
            <input
              className="input-base"
              type="number"
              step="0.01"
              placeholder="e.g. 145.00"
              value={targetEntry}
              onChange={(e) => setTargetEntry(e.target.value)}
            />
          </div>
          <div className="w-28">
            <label className="label">Analyst Target</label>
            <input
              className="input-base"
              type="number"
              step="0.01"
              placeholder="e.g. 200.00"
              value={analystTarget}
              onChange={(e) => setAnalystTarget(e.target.value)}
            />
          </div>
          <div className="flex-1 min-w-40">
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
        <p className="text-xs text-zinc-600 mt-2">
          Watch price auto-fills from Finnhub when you tab out of the ticker field. You can also enter it manually.
        </p>
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
              const currentPrice = quote?.c ?? null;
              const dayPct = quote?.dp ?? null;

              // Performance vs watch price
              const watchPriceDiff =
                currentPrice && item.watch_price
                  ? currentPrice - item.watch_price
                  : null;
              const watchPricePct =
                watchPriceDiff != null && item.watch_price
                  ? (watchPriceDiff / item.watch_price) * 100
                  : null;

              const days = daysSince(item.watch_date);
              const trending =
                watchPricePct == null ? null : watchPricePct > 0.5 ? 'up' : watchPricePct < -0.5 ? 'down' : 'flat';

              return (
                <div
                  key={item.id}
                  className="p-4 bg-zinc-800/40 rounded-lg border border-zinc-800 hover:border-zinc-700 transition-colors"
                >
                  <div className="flex items-center gap-4 flex-wrap">
                    {/* Ticker & conviction */}
                    <div className="w-28 flex-shrink-0">
                      <div className="font-mono font-bold text-blue-400 text-base">{item.ticker}</div>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${convictionBg[item.conviction]}`}>
                        {item.conviction}
                      </span>
                    </div>

                    {/* Watch price → current price */}
                    <div className="flex items-center gap-3 flex-shrink-0">
                      {/* Watch entry */}
                      <div className="text-center">
                        <div className="text-xs text-zinc-600 mb-0.5">Added {item.watch_date}</div>
                        <div className="text-sm text-zinc-400 tabular-nums font-medium">
                          {item.watch_price ? fmtCurrency(item.watch_price) : '—'}
                        </div>
                      </div>

                      {/* Arrow */}
                      <div className="text-zinc-600">
                        {trending === 'up' ? (
                          <TrendingUp size={18} className="text-emerald-400" />
                        ) : trending === 'down' ? (
                          <TrendingDown size={18} className="text-red-400" />
                        ) : (
                          <Minus size={18} className="text-zinc-500" />
                        )}
                      </div>

                      {/* Current price */}
                      <div className="text-center">
                        <div className="text-xs text-zinc-600 mb-0.5">Now</div>
                        {ld?.loading ? (
                          <div className="text-zinc-600 text-xs animate-pulse">Loading…</div>
                        ) : ld?.error ? (
                          <div className="text-red-500 text-xs">{ld.error}</div>
                        ) : currentPrice ? (
                          <div className="text-sm font-semibold tabular-nums">{fmtCurrency(currentPrice)}</div>
                        ) : (
                          <div className="text-zinc-600 text-xs">—</div>
                        )}
                      </div>
                    </div>

                    {/* Since-watch performance */}
                    {watchPricePct != null && (
                      <div className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-center ${
                        watchPricePct > 0
                          ? 'bg-emerald-900/30 border border-emerald-800'
                          : watchPricePct < 0
                          ? 'bg-red-900/30 border border-red-800'
                          : 'bg-zinc-800 border border-zinc-700'
                      }`}>
                        <div className="text-xs text-zinc-500 mb-0.5">Since watch ({days}d)</div>
                        <div className={`text-base font-bold tabular-nums ${
                          watchPricePct > 0 ? 'text-emerald-400' : watchPricePct < 0 ? 'text-red-400' : 'text-zinc-400'
                        }`}>
                          {watchPricePct > 0 ? '+' : ''}{watchPricePct.toFixed(2)}%
                        </div>
                        <div className={`text-xs tabular-nums ${
                          watchPriceDiff! > 0 ? 'text-emerald-500' : watchPriceDiff! < 0 ? 'text-red-500' : 'text-zinc-500'
                        }`}>
                          {watchPriceDiff! > 0 ? '+' : ''}{fmtCurrency(watchPriceDiff!)}
                        </div>
                      </div>
                    )}

                    {/* Today's change */}
                    {dayPct != null && (
                      <div className="flex-shrink-0 text-center">
                        <div className="text-xs text-zinc-600 mb-0.5">Today</div>
                        <div className={`text-sm font-medium flex items-center gap-1 ${changeColor(dayPct)}`}>
                          {dayPct > 0 ? <TrendingUp size={11} /> : dayPct < 0 ? <TrendingDown size={11} /> : <Minus size={11} />}
                          {fmtPct(dayPct)}
                        </div>
                      </div>
                    )}

                    {/* Day range */}
                    {quote && (
                      <div className="hidden sm:block text-xs text-zinc-500">
                        <div>H: {fmtCurrency(quote.h)}</div>
                        <div>L: {fmtCurrency(quote.l)}</div>
                      </div>
                    )}

                    {/* Sentiment */}
                    {sent?.sentiment && (
                      <div className="hidden md:block w-36">
                        <div className="text-xs text-zinc-500 mb-1">Sentiment</div>
                        <div className="flex gap-2 text-xs mb-1">
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
                    )}

                    {/* Target entry / analyst target */}
                    {(item.target_entry || item.analyst_target) && (
                      <div className="hidden sm:flex flex-col gap-1 text-xs flex-shrink-0">
                        {item.target_entry && (
                          <div>
                            <span className="text-zinc-600">Entry: </span>
                            <span className="text-amber-400 font-mono">{fmtCurrency(item.target_entry)}</span>
                          </div>
                        )}
                        {item.analyst_target && (
                          <div>
                            <span className="text-zinc-600">PT: </span>
                            <span className="text-blue-400 font-mono">{fmtCurrency(item.analyst_target)}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Notes */}
                    {item.notes && (
                      <div className="flex-1 text-xs text-zinc-500 truncate hidden lg:block">{item.notes}</div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-2 ml-auto flex-shrink-0">
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
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
