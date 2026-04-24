import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, RefreshCw, TrendingUp, TrendingDown, Minus, ShoppingCart, X, Check } from 'lucide-react';
import { storage, newId, nowIso } from '../../lib/storage';
import { finnhub } from '../../lib/finnhub';
import { fetchYahoo } from '../../lib/yahoo';
import FundamentalsDrawer from '../FundamentalsDrawer';
import { toYahooTicker } from '../FundamentalsDrawer';
import { changeColor, fmtCurrency, fmtPct, fmt } from '../../lib/utils';
import type { WatchItem, FinnhubQuote, FinnhubSentiment, Conviction } from '../../types';

const HOLDINGS_TABLE = 'holdings';

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
  const [drawer, setDrawer] = useState<{ ticker: string; currency: string } | null>(null);

  // Buy inline form
  const [buyId, setBuyId]         = useState<string | null>(null);
  const [buyShares, setBuyShares] = useState('');
  const [buyPrice, setBuyPrice]   = useState('');
  const [buyAccount, setBuyAccount] = useState('Brokerage');
  const [buyCurrency, setBuyCurrency] = useState('USD');
  const [buyLoading, setBuyLoading] = useState(false);
  const [buyError, setBuyError]   = useState<string | null>(null);

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
        // Backfill missing watch price
        if (!item.watch_price) {
          await storage.update(TABLE, item.id, { watch_price: q.c });
          setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, watch_price: q.c } : i));
        }
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
        // Backfill missing watch price
        if (!item.watch_price) {
          await storage.update(TABLE, item.id, { watch_price: price });
          setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, watch_price: price } : i));
        }
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

  function openBuyForm(item: WatchItem) {
    setBuyId(item.id);
    setBuyError(null);
    setBuyShares('');
    const cp = liveData[item.ticker]?.quote?.c;
    setBuyPrice(cp ? cp.toFixed(2) : item.target_entry ? item.target_entry.toFixed(2) : '');
    const isCAD = item.ticker.includes('.TO') || item.ticker.includes('.V') || item.ticker.includes('.CN');
    setBuyCurrency(isCAD ? 'CAD' : 'USD');
    setBuyAccount('Brokerage');
  }

  async function handleBuy(item: WatchItem) {
    const shares = parseFloat(buyShares);
    const cost   = parseFloat(buyPrice);
    if (!shares || !cost || shares <= 0 || cost <= 0) return;
    setBuyLoading(true);
    setBuyError(null);
    try {
      // Check for existing holding to merge
      const existing = (await storage.getAll<{
        id: string; ticker: string; account: string; currency: string; shares: number; avg_cost: number;
      }>(HOLDINGS_TABLE)).find(
        (h) => h.ticker === item.ticker && h.account === buyAccount && h.currency === buyCurrency
      );

      if (existing) {
        const totalShares = existing.shares + shares;
        const newAvgCost  = (existing.shares * existing.avg_cost + shares * cost) / totalShares;
        await storage.update(HOLDINGS_TABLE, existing.id, {
          shares: totalShares,
          avg_cost: parseFloat(newAvgCost.toFixed(6)),
        });
      } else {
        await storage.insert(HOLDINGS_TABLE, {
          id: newId(),
          ticker: item.ticker,
          shares,
          avg_cost: cost,
          sector: 'Other',
          account: buyAccount,
          currency: buyCurrency,
          liquidity_risk: 'LOW',
          notes: item.notes ?? '',
          created_at: nowIso(),
        });
      }

      // Remove from watchlist
      await storage.remove(TABLE, item.id);
      setLiveData((prev) => { const n = { ...prev }; delete n[item.ticker]; return n; });
      setBuyId(null);
      await load();
    } catch (err) {
      setBuyError(err instanceof Error ? err.message : 'Failed to add to portfolio. Please try again.');
    } finally {
      setBuyLoading(false);
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

              // Trend: use since-watch momentum
              const trending =
                watchPricePct == null ? null : watchPricePct > 0.5 ? 'up' : watchPricePct < -0.5 ? 'down' : 'flat';

              // Entry zone: compare current price vs target entry
              const vsEntry =
                currentPrice && item.target_entry
                  ? currentPrice - item.target_entry
                  : null;
              const entryZone =
                vsEntry == null ? 'neutral' : vsEntry > 0 ? 'above' : 'below';

              const cardBorder =
                entryZone === 'above'
                  ? 'border-red-800/70 bg-red-950/20'
                  : entryZone === 'below'
                  ? 'border-emerald-800/70 bg-emerald-950/20'
                  : 'border-zinc-800 bg-zinc-800/40';

              const isBuying = buyId === item.id;

              return (
                <div
                  key={item.id}
                  className={`p-4 rounded-lg border transition-colors ${cardBorder}`}
                >
                  <div className="flex items-center gap-4 flex-wrap">
                    {/* Ticker & conviction */}
                    <div className="w-28 flex-shrink-0">
                      <button
                        onClick={() => setDrawer({ ticker: item.ticker, currency: 'USD' })}
                        className="font-mono font-bold text-blue-400 hover:text-blue-300 hover:underline underline-offset-2 transition-colors text-base text-left"
                        title={`View fundamentals for ${item.ticker}`}
                      >
                        {item.ticker}
                      </button>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${convictionBg[item.conviction]}`}>
                        {item.conviction}
                      </span>
                    </div>

                    {/* Watch price → current price + trend */}
                    <div className="flex items-center gap-3 flex-shrink-0">
                      {/* Watch entry */}
                      <div className="text-center">
                        <div className="text-xs text-zinc-600 mb-0.5">Added {item.watch_date}</div>
                        <div className="text-sm text-zinc-400 tabular-nums font-medium">
                          {item.watch_price ? fmtCurrency(item.watch_price) : '—'}
                        </div>
                      </div>

                      {/* Trend arrow (since watch) */}
                      <div className="flex flex-col items-center gap-0.5">
                        {trending === 'up' ? (
                          <TrendingUp size={18} className="text-emerald-400" />
                        ) : trending === 'down' ? (
                          <TrendingDown size={18} className="text-red-400" />
                        ) : (
                          <Minus size={18} className="text-zinc-500" />
                        )}
                        <span className={`text-[10px] font-medium ${
                          trending === 'up' ? 'text-emerald-500' : trending === 'down' ? 'text-red-500' : 'text-zinc-600'
                        }`}>
                          {trending === 'up' ? 'UP' : trending === 'down' ? 'DOWN' : 'FLAT'}
                        </span>
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

                    {/* Entry zone badge */}
                    {vsEntry != null && item.target_entry && (
                      <div className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-center border ${
                        entryZone === 'below'
                          ? 'bg-emerald-900/40 border-emerald-700'
                          : 'bg-red-900/40 border-red-800'
                      }`}>
                        <div className={`text-xs font-semibold ${entryZone === 'below' ? 'text-emerald-300' : 'text-red-400'}`}>
                          {entryZone === 'below' ? '✓ BUY ZONE' : '✗ ABOVE ENTRY'}
                        </div>
                        <div className="text-xs text-zinc-500 mt-0.5">
                          Entry: {fmtCurrency(item.target_entry)}
                        </div>
                        <div className={`text-xs font-mono font-bold ${entryZone === 'below' ? 'text-emerald-400' : 'text-red-400'}`}>
                          {vsEntry > 0 ? '+' : ''}{fmtCurrency(vsEntry)}
                        </div>
                      </div>
                    )}

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

                    {/* Analyst target (only if no entry zone badge, or always show) */}
                    {item.analyst_target && (
                      <div className="hidden sm:block text-xs flex-shrink-0">
                        <span className="text-zinc-600">PT: </span>
                        <span className="text-blue-400 font-mono">{fmtCurrency(item.analyst_target)}</span>
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
                      <button
                        onClick={() => isBuying ? setBuyId(null) : openBuyForm(item)}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                          isBuying
                            ? 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                            : 'bg-emerald-700 hover:bg-emerald-600 text-white'
                        }`}
                        title="Buy — move to portfolio"
                      >
                        {isBuying ? <X size={12} /> : <ShoppingCart size={12} />}
                        {isBuying ? 'Cancel' : 'Buy'}
                      </button>
                      <button onClick={() => handleDelete(item.id, item.ticker)} className="btn-danger">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Inline buy form */}
                  {isBuying && (
                    <div className="mt-3 pt-3 border-t border-zinc-700/50 flex flex-wrap gap-3 items-end">
                      <div>
                        <label className="label">Shares *</label>
                        <input
                          className="input-base w-24"
                          type="number"
                          step="0.0001"
                          min="0.0001"
                          placeholder="100"
                          value={buyShares}
                          onChange={(e) => setBuyShares(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <div>
                        <label className="label">Avg Cost *</label>
                        <input
                          className="input-base w-28"
                          type="number"
                          step="0.01"
                          min="0.01"
                          placeholder="0.00"
                          value={buyPrice}
                          onChange={(e) => setBuyPrice(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="label">Account</label>
                        <select className="select-base w-28" value={buyAccount} onChange={(e) => setBuyAccount(e.target.value)}>
                          {['Brokerage', 'RRSP', 'LIRA', 'TSFA', 'HSA', 'Other'].map((a) => (
                            <option key={a} value={a}>{a}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="label">Currency</label>
                        <select className="select-base w-24" value={buyCurrency} onChange={(e) => setBuyCurrency(e.target.value)}>
                          <option>USD</option>
                          <option>CAD</option>
                        </select>
                      </div>
                      <button
                        onClick={() => handleBuy(item)}
                        disabled={buyLoading || !buyShares || !buyPrice}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold rounded transition-colors"
                      >
                        <Check size={13} />
                        {buyLoading ? 'Adding…' : 'Confirm Buy'}
                      </button>
                      <p className="text-xs text-zinc-600 w-full mt-1">
                        This will add {item.ticker} to your Portfolio and remove it from the Watch List.
                      </p>
                      {buyError && (
                        <p className="text-xs text-red-400 w-full">{buyError}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {drawer && (
        <FundamentalsDrawer ticker={drawer.ticker} currency={drawer.currency} onClose={() => setDrawer(null)} />
      )}
    </div>
  );
}
