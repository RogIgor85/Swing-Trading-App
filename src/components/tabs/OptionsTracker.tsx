import { useState, useEffect } from 'react';
import { Plus, X, Check, Trash2, Pencil, ChevronDown, ChevronUp, Clock, AlertTriangle, Target, ExternalLink, ShieldAlert, Trophy } from 'lucide-react';
import { storage, newId, nowIso } from '../../lib/storage';
import { fmtCurrency } from '../../lib/utils';
import type { Account, Currency } from '../../types';

// ─── Types ────────────────────────────────────────────────────────────────────
type OptionType    = 'CALL' | 'PUT';
type OptionStatus  = 'OPEN' | 'CLOSED' | 'EXPIRED' | 'ASSIGNED';
type OptionStrategy =
  | 'Long Call' | 'Long Put'
  | 'Covered Call' | 'Cash-Secured Put'
  | 'Bull Call Spread' | 'Bear Put Spread'
  | 'Bull Put Spread'  | 'Bear Call Spread'
  | 'Iron Condor' | 'Iron Butterfly'
  | 'Straddle' | 'Strangle'
  | 'LEAPS' | 'Other';

interface OptionTrade {
  id:             string;
  underlying:     string;          // ticker
  option_type:    OptionType;
  strategy:       OptionStrategy;
  strike:         number;
  expiration:     string;          // YYYY-MM-DD
  contracts:      number;
  premium_paid:   number;          // per share (×100 per contract)
  current_premium:number | null;   // manually updated
  iv:             number | null;   // implied volatility %
  delta:          number | null;
  theta:          number | null;   // daily decay $
  account:        Account;
  currency:       Currency;
  entry_date:     string;
  exit_date:      string | null;
  exit_premium:   number | null;
  status:         OptionStatus;
  notes:          string;
  created_at:     string;
}

const TABLE = 'option_trades';
const ACCOUNTS: Account[]  = ['Brokerage', 'RRSP', 'LIRA', 'TSFA', 'HSA', 'Crypto', 'Other'];
const CURRENCIES: Currency[] = ['USD', 'CAD'];

const STRATEGIES: OptionStrategy[] = [
  'Long Call', 'Long Put',
  'Covered Call', 'Cash-Secured Put',
  'Bull Call Spread', 'Bear Put Spread',
  'Bull Put Spread', 'Bear Call Spread',
  'Iron Condor', 'Iron Butterfly',
  'Straddle', 'Strangle',
  'LEAPS', 'Other',
];

// ─── Golden Rules ─────────────────────────────────────────────────────────────
const SELL_STRATEGIES: OptionStrategy[] = [
  'Covered Call', 'Cash-Secured Put',
  'Bull Put Spread', 'Bear Call Spread',
  'Iron Condor', 'Iron Butterfly',
];

const GOLDEN_RULES = [
  { num: '01', title: 'Never sell naked options', desc: 'Only buy options (Long Call / Long Put / LEAPS) unless you have the capital or shares to back a sell strategy.' },
  { num: '02', title: 'Know your break-even before entering', desc: 'The stock must move beyond break-even by expiry for your trade to be profitable. Verify this before entry.' },
  { num: '03', title: 'Take profit at +100%', desc: 'When the option doubles in value (current premium ≥ 2× paid), consider closing — do not get greedy.' },
  { num: '04', title: 'Cut losses at −45%', desc: 'If the option loses ~45% of premium paid, exit to preserve capital rather than riding it to zero.' },
  { num: '05', title: 'Watch DTE ≤ 7 — theta decay accelerates', desc: 'Inside one week to expiry, time decay is at its fastest. Re-evaluate or close the position.' },
  { num: '06', title: 'Start with 1 contract', desc: 'Until you are consistently profitable, limit each trade to 1 contract to manage risk.' },
];

interface RuleAlert { rule: string; message: string; color: 'green' | 'red' | 'amber' }

function getRuleAlerts(t: OptionTrade): RuleAlert[] {
  const alerts: RuleAlert[] = [];
  const cp = t.current_premium;

  // Rule 03 — +100% profit target
  if (cp != null && cp >= t.premium_paid * 2) {
    alerts.push({ rule: '03', message: 'Up +100% — consider taking profit', color: 'green' });
  }
  // Rule 04 — −45% stop loss
  if (cp != null && cp <= t.premium_paid * 0.55) {
    alerts.push({ rule: '04', message: 'Down −45% — consider cutting loss', color: 'red' });
  }
  // Rule 05 — DTE ≤ 7
  if (t.status === 'OPEN' && daysToExpiry(t.expiration) <= 7) {
    alerts.push({ rule: '05', message: 'DTE ≤ 7 — theta decay accelerating', color: 'amber' });
  }
  return alerts;
}

const STATUS_COLORS: Record<OptionStatus, string> = {
  OPEN:     'bg-blue-900/40 text-blue-300 border border-blue-700',
  CLOSED:   'bg-zinc-800 text-zinc-400 border border-zinc-600',
  EXPIRED:  'bg-red-900/40 text-red-300 border border-red-700',
  ASSIGNED: 'bg-purple-900/40 text-purple-300 border border-purple-700',
};

const TYPE_COLORS: Record<OptionType, string> = {
  CALL: 'text-emerald-400',
  PUT:  'text-red-400',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function daysToExpiry(exp: string): number {
  return Math.ceil((new Date(exp).getTime() - Date.now()) / 86_400_000);
}

function totalCost(t: OptionTrade): number {
  return t.premium_paid * t.contracts * 100;
}

function currentValue(t: OptionTrade): number | null {
  if (t.current_premium == null) return null;
  return t.current_premium * t.contracts * 100;
}

function unrealizedPnl(t: OptionTrade): number | null {
  const cv = currentValue(t);
  if (cv == null) return null;
  return cv - totalCost(t);
}

function realizedPnl(t: OptionTrade): number | null {
  if (t.exit_premium == null) return null;
  return (t.exit_premium - t.premium_paid) * t.contracts * 100;
}

function breakEven(t: OptionTrade): number {
  return t.option_type === 'CALL'
    ? t.strike + t.premium_paid
    : t.strike - t.premium_paid;
}

function barchartUrl(ticker: string): string {
  const clean = ticker.replace(/\.TO$/i, '');
  return `https://www.barchart.com/stocks/quotes/${clean}/options`;
}

// Build OCC option symbol for Massive API: O:AAPL260117C00200000
function occSymbol(t: OptionTrade): string {
  const root = t.underlying.replace(/\.TO$/i, '');
  const [year, month, day] = t.expiration.split('-');
  const cp = t.option_type === 'CALL' ? 'C' : 'P';
  const strikePadded = Math.round(t.strike * 1000).toString().padStart(8, '0');
  return `O:${root}${year.slice(2)}${month}${day}${cp}${strikePadded}`;
}

function fmt$(n: number) {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 }).format(n);
}

function fmtPnl(n: number) {
  const s = n >= 0 ? '+' : '';
  return s + fmt$(n);
}

// ─── Empty form ───────────────────────────────────────────────────────────────
const emptyForm = (): Partial<OptionTrade> => ({
  underlying:      '',
  option_type:     'CALL',
  strategy:        'Long Call',
  strike:          undefined,
  expiration:      '',
  contracts:       1,
  premium_paid:    undefined,
  current_premium: null,
  iv:              null,
  delta:           null,
  theta:           null,
  account:         'Brokerage',
  currency:        'USD',
  entry_date:      new Date().toISOString().slice(0, 10),
  exit_date:       null,
  exit_premium:    null,
  status:          'OPEN',
  notes:           '',
});

// ─── Close form ───────────────────────────────────────────────────────────────
interface CloseForm { exit_premium: string; exit_date: string; status: OptionStatus }

// ─── Component ────────────────────────────────────────────────────────────────
export default function OptionsTracker() {
  const [trades, setTrades]   = useState<OptionTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState<Partial<OptionTrade>>(emptyForm());
  const [editId, setEditId]     = useState<string | null>(null);
  const [saving, setSaving]     = useState(false);
  const [closeId, setCloseId]   = useState<string | null>(null);
  const [closeForm, setCloseForm] = useState<CloseForm>({ exit_premium: '', exit_date: new Date().toISOString().slice(0, 10), status: 'CLOSED' });
  const [expandId, setExpandId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<'ALL' | OptionStatus>('OPEN');
  const [updateId, setUpdateId]   = useState<string | null>(null);
  const [updatePremium, setUpdatePremium] = useState('');
  const [error, setError]         = useState<string | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);

  // ── Massive API auto-pricing ───────────────────────────────────────────────
  const [apiKey, setApiKey]           = useState<string>(() => localStorage.getItem('massive_api_key') ?? '');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [livePrices, setLivePrices]   = useState<Record<string, number>>({});
  const [fetchingPrices, setFetchingPrices] = useState(false);
  const [lastRefreshed, setLastRefreshed]   = useState<string | null>(null);
  const [priceErrors, setPriceErrors] = useState<Record<string, string>>({});

  async function load() {
    try {
      const data = await storage.getAll<OptionTrade>(TABLE);
      setTrades(data.sort((a, b) => new Date(b.entry_date).getTime() - new Date(a.entry_date).getTime()));
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  // Apply live price override to a trade for P&L / alert calculations
  function withLive(t: OptionTrade): OptionTrade {
    return livePrices[t.id] != null ? { ...t, current_premium: livePrices[t.id] } : t;
  }

  // Save Massive API key to localStorage
  function saveApiKey() {
    const trimmed = apiKeyDraft.trim();
    localStorage.setItem('massive_api_key', trimmed);
    setApiKey(trimmed);
    setApiKeyDraft('');
    setShowKeyInput(false);
  }

  // Fetch live option premiums from Massive API for all open trades
  async function fetchAllPrices() {
    if (!apiKey) return;
    setFetchingPrices(true);
    const openTrades = trades.filter(t => t.status === 'OPEN');
    const results: Record<string, number> = {};
    const errors: Record<string, string> = {};

    await Promise.allSettled(openTrades.map(async t => {
      try {
        const sym  = occSymbol(t);
        const root = t.underlying.replace(/\.TO$/i, '');
        // Try Massive first, fall back to Polygon (same API, transition period)
        let res = await fetch(
          `https://api.massive.com/v3/snapshot/options/${root}/${sym}`,
          { headers: { Authorization: `Bearer ${apiKey}` } },
        ).catch(() => null);
        if (!res || res.status === 401 || res.status === 403) {
          res = await fetch(
            `https://api.polygon.io/v3/snapshot/options/${root}/${sym}`,
            { headers: { Authorization: `Bearer ${apiKey}` } },
          ).catch(() => null);
        }
        if (!res) { errors[t.id] = 'Network error'; return; }
        if (res.status === 401 || res.status === 403) { errors[t.id] = 'Invalid API key'; return; }
        if (res.status === 403) { errors[t.id] = 'Plan does not include options'; return; }
        if (res.status === 404) { errors[t.id] = 'Contract not found'; return; }
        if (!res.ok) { errors[t.id] = `HTTP ${res.status}`; return; }
        const d = await res.json();
        const q  = d.results?.last_quote;
        const price =
          q?.midpoint ??
          (q?.bid != null && q?.ask != null ? (q.bid + q.ask) / 2 : null) ??
          d.results?.last_trade?.price ?? null;
        if (price != null) results[t.id] = price;
        else errors[t.id] = 'No price data';
      } catch {
        errors[t.id] = 'Network error';
      }
    }));

    setLivePrices(prev => ({ ...prev, ...results }));
    setPriceErrors(errors);
    setLastRefreshed(new Date().toLocaleTimeString());
    setFetchingPrices(false);
  }

  // Auto-fetch when key is set and trades finish loading
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (apiKey && !loading) fetchAllPrices(); }, [apiKey, loading]);

  // ── Summary stats ──────────────────────────────────────────────────────────
  const open   = trades.filter(t => t.status === 'OPEN');
  const closed = trades.filter(t => t.status !== 'OPEN');

  const totalAtRisk     = open.reduce((s, t) => s + totalCost(t), 0);
  const totalUnrealized = open.reduce((s, t) => s + (unrealizedPnl(withLive(t)) ?? 0), 0);
  const totalRealized   = closed.reduce((s, t) => s + (realizedPnl(t) ?? 0), 0);
  const wins   = closed.filter(t => (realizedPnl(t) ?? 0) > 0).length;
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : null;

  // ── Filtered list ──────────────────────────────────────────────────────────
  const filtered = filterStatus === 'ALL' ? trades : trades.filter(t => t.status === filterStatus);

  // ── Submit new / edit ──────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Explicit validation with feedback
    const missing: string[] = [];
    if (!form.underlying?.trim()) missing.push('Underlying ticker');
    if (!form.expiration)          missing.push('Expiration date');
    if (!form.strike)              missing.push('Strike price');
    if (!form.premium_paid)        missing.push('Premium paid');
    if (missing.length > 0) {
      setError(`Missing required fields: ${missing.join(', ')}`);
      return;
    }

    setSaving(true);
    try {
      const trade: OptionTrade = {
        id:              editId ?? newId(),
        underlying:      form.underlying!.toUpperCase().trim(),
        option_type:     form.option_type ?? 'CALL',
        strategy:        form.strategy    ?? 'Long Call',
        strike:          Number(form.strike),
        expiration:      form.expiration!,
        contracts:       Number(form.contracts ?? 1),
        premium_paid:    Number(form.premium_paid),
        current_premium: form.current_premium ?? null,
        iv:              form.iv    ?? null,
        delta:           form.delta ?? null,
        theta:           form.theta ?? null,
        account:         form.account   ?? 'Brokerage',
        currency:        form.currency  ?? 'USD',
        entry_date:      form.entry_date ?? new Date().toISOString().slice(0, 10),
        exit_date:       form.exit_date    ?? null,
        exit_premium:    form.exit_premium ?? null,
        status:          'OPEN',
        notes:           form.notes ?? '',
        created_at:      nowIso(),
      };
      if (editId) {
        await storage.update(TABLE, editId, trade);
      } else {
        await storage.insert(TABLE, trade);
      }
      setShowForm(false);
      setEditId(null);
      setForm(emptyForm());
      await load();
    } catch (err: unknown) {
      // Supabase throws a PostgrestError object (not a standard Error)
      let msg = 'Unknown error';
      if (err instanceof Error) {
        msg = err.message;
      } else if (typeof err === 'object' && err !== null && 'message' in err) {
        msg = String((err as { message: unknown }).message);
      } else {
        msg = JSON.stringify(err);
      }
      if (msg.includes('does not exist') || msg.includes('relation') || msg.includes('42P01')) {
        setError('The option_trades table does not exist in Supabase yet. Please run the SQL setup in the Supabase SQL Editor.');
      } else {
        setError(`Save failed: ${msg}`);
      }
    } finally { setSaving(false); }
  }

  // ── Close a trade ──────────────────────────────────────────────────────────
  async function handleClose(trade: OptionTrade) {
    setSaving(true);
    try {
      const ep = parseFloat(closeForm.exit_premium) || 0;
      await storage.update(TABLE, trade.id, {
        status:       closeForm.status,
        exit_date:    closeForm.exit_date,
        exit_premium: ep,
      });
      setCloseId(null);
      await load();
    } finally { setSaving(false); }
  }

  // ── Update current premium ─────────────────────────────────────────────────
  async function handleUpdatePremium(id: string) {
    const p = parseFloat(updatePremium);
    if (isNaN(p)) return;
    await storage.update(TABLE, id, { current_premium: p });
    setUpdateId(null);
    setUpdatePremium('');
    await load();
  }

  // ── Delete ─────────────────────────────────────────────────────────────────
  async function handleDelete(id: string) {
    if (!window.confirm('Delete this option trade?')) return;
    await storage.remove(TABLE, id);
    await load();
  }

  // ── Start edit ─────────────────────────────────────────────────────────────
  function startEdit(t: OptionTrade) {
    setForm({ ...t });
    setEditId(t.id);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (loading) return (
    <div className="flex items-center justify-center py-20 text-zinc-500 text-sm gap-2">
      <Clock size={14} className="animate-spin" /> Loading options…
    </div>
  );

  return (
    <div className="space-y-5">

      {/* ── Golden Rules panel ─────────────────────────────────────────────── */}
      <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 overflow-hidden">
        <button
          onClick={() => setRulesOpen(o => !o)}
          className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-amber-950/30 transition-colors"
        >
          <Trophy size={14} className="text-amber-400 flex-shrink-0" />
          <span className="text-sm font-semibold text-amber-300">Golden Rules of Options Trading</span>
          <span className="text-xs text-amber-700 ml-1">— live alerts are active on every trade</span>
          <span className="ml-auto text-amber-600">{rulesOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
        </button>
        {rulesOpen && (
          <div className="border-t border-amber-800/40 px-4 py-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {GOLDEN_RULES.map(r => (
              <div key={r.num} className="flex gap-2.5 text-xs">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-amber-900/60 border border-amber-700 text-amber-300 flex items-center justify-center font-bold text-[10px]">{r.num}</span>
                <div>
                  <div className="font-semibold text-amber-200 mb-0.5">{r.title}</div>
                  <div className="text-zinc-500 leading-relaxed">{r.desc}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Summary ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="card py-3">
          <div className="text-xs text-zinc-500 mb-1">Open Positions</div>
          <div className="text-2xl font-bold text-zinc-100">{open.length}</div>
        </div>
        <div className="card py-3">
          <div className="text-xs text-zinc-500 mb-1">Capital at Risk</div>
          <div className="text-xl font-bold text-red-400">{fmt$(totalAtRisk)}</div>
        </div>
        <div className="card py-3">
          <div className="text-xs text-zinc-500 mb-1">Unrealized P&L</div>
          <div className={`text-xl font-bold ${totalUnrealized >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {fmtPnl(totalUnrealized)}
          </div>
        </div>
        <div className="card py-3">
          <div className="text-xs text-zinc-500 mb-1">Realized P&L</div>
          <div className={`text-xl font-bold ${totalRealized >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {closed.length ? fmtPnl(totalRealized) : '—'}
          </div>
        </div>
        <div className="card py-3">
          <div className="text-xs text-zinc-500 mb-1">Win Rate</div>
          <div className={`text-xl font-bold ${(winRate ?? 0) >= 50 ? 'text-emerald-400' : 'text-amber-400'}`}>
            {winRate != null ? `${winRate.toFixed(0)}%` : '—'}
          </div>
          {closed.length > 0 && <div className="text-xs text-zinc-600">{wins}/{closed.length} closed</div>}
        </div>
      </div>

      {/* ── New Option button / form ────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-zinc-100">
            {showForm ? (editId ? 'Edit Option Trade' : 'New Option Trade') : 'Option Trades'}
          </h2>
          {showForm ? (
            <button onClick={() => { setShowForm(false); setEditId(null); setForm(emptyForm()); }} className="btn-ghost flex items-center gap-1.5">
              <X size={13} /> Cancel
            </button>
          ) : (
            <button onClick={() => setShowForm(true)} className="btn-primary flex items-center gap-2">
              <Plus size={14} /> New Option
            </button>
          )}
        </div>

        {showForm && (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Row 1 — Core option details */}
            <div className="flex flex-wrap gap-3 items-end">
              <div className="w-24">
                <label className="label">Underlying *</label>
                <input className="input-base uppercase" placeholder="AAPL" value={form.underlying ?? ''} onChange={e => setForm(f => ({ ...f, underlying: e.target.value }))} required />
              </div>
              <div className="w-24">
                <label className="label">Type *</label>
                <select className="select-base" value={form.option_type} onChange={e => setForm(f => ({ ...f, option_type: e.target.value as OptionType }))}>
                  <option value="CALL">CALL</option>
                  <option value="PUT">PUT</option>
                </select>
              </div>
              <div className="w-44">
                <label className="label">Strategy *</label>
                <select className="select-base" value={form.strategy} onChange={e => setForm(f => ({ ...f, strategy: e.target.value as OptionStrategy }))}>
                  {STRATEGIES.map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div className="w-28">
                <label className="label">Strike Price *</label>
                <input className="input-base" type="number" step="0.5" placeholder="150.00" value={form.strike ?? ''} onChange={e => setForm(f => ({ ...f, strike: parseFloat(e.target.value) || undefined }))} required />
              </div>
              <div className="w-36">
                <label className="label">Expiration Date *</label>
                <input className="input-base" type="date" value={form.expiration ?? ''} onChange={e => setForm(f => ({ ...f, expiration: e.target.value }))} required />
              </div>
              <div className="w-24">
                <label className="label">Contracts *</label>
                <input className="input-base" type="number" min="1" step="1" placeholder="1" value={form.contracts ?? 1} onChange={e => setForm(f => ({ ...f, contracts: parseInt(e.target.value) || 1 }))} required />
              </div>
            </div>

            {/* Row 2 — Pricing & Greeks */}
            <div className="flex flex-wrap gap-3 items-end">
              <div className="w-28">
                <label className="label">Premium Paid * <span className="text-zinc-600">(per share)</span></label>
                <input className="input-base" type="number" step="0.01" placeholder="3.50" value={form.premium_paid ?? ''} onChange={e => setForm(f => ({ ...f, premium_paid: parseFloat(e.target.value) || undefined }))} required />
              </div>
              <div className="w-28">
                <label className="label">IV % <span className="text-zinc-600">(optional)</span></label>
                <input className="input-base" type="number" step="0.1" placeholder="45.0" value={form.iv ?? ''} onChange={e => setForm(f => ({ ...f, iv: parseFloat(e.target.value) || null }))} />
              </div>
              <div className="w-24">
                <label className="label">Delta <span className="text-zinc-600">(optional)</span></label>
                <input className="input-base" type="number" step="0.01" placeholder="0.45" value={form.delta ?? ''} onChange={e => setForm(f => ({ ...f, delta: parseFloat(e.target.value) || null }))} />
              </div>
              <div className="w-24">
                <label className="label">Theta/day <span className="text-zinc-600">(optional)</span></label>
                <input className="input-base" type="number" step="0.01" placeholder="-0.05" value={form.theta ?? ''} onChange={e => setForm(f => ({ ...f, theta: parseFloat(e.target.value) || null }))} />
              </div>
              <div className="w-36">
                <label className="label">Entry Date</label>
                <input className="input-base" type="date" value={form.entry_date ?? ''} onChange={e => setForm(f => ({ ...f, entry_date: e.target.value }))} />
              </div>
              <div className="w-28">
                <label className="label">Account</label>
                <select className="select-base" value={form.account} onChange={e => setForm(f => ({ ...f, account: e.target.value as Account }))}>
                  {ACCOUNTS.map(a => <option key={a}>{a}</option>)}
                </select>
              </div>
              <div className="w-20">
                <label className="label">Currency</label>
                <select className="select-base" value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value as Currency }))}>
                  {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="flex-1 min-w-40">
                <label className="label">Thesis / Notes</label>
                <input className="input-base" placeholder="Why you're in this trade, catalyst, setup..." value={form.notes ?? ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
            </div>

            {/* ── Golden Rule warnings ── */}
            {form.strategy && SELL_STRATEGIES.includes(form.strategy as OptionStrategy) && (
              <div className="flex items-start gap-2 bg-red-950/40 border border-red-800/60 rounded-lg px-3 py-2 text-xs text-red-300">
                <ShieldAlert size={13} className="flex-shrink-0 mt-0.5 text-red-400" />
                <span><strong className="text-red-200">Rule 01 — Selling strategy detected.</strong> "{form.strategy}" requires you to own the underlying shares or have sufficient cash to take assignment. Make sure you have the capital or shares to back this position.</span>
              </div>
            )}
            {(form.contracts ?? 1) > 1 && (
              <div className="flex items-start gap-2 bg-amber-950/40 border border-amber-800/60 rounded-lg px-3 py-2 text-xs text-amber-300">
                <ShieldAlert size={13} className="flex-shrink-0 mt-0.5 text-amber-400" />
                <span><strong className="text-amber-200">Rule 06 — Multiple contracts.</strong> Until consistently profitable, consider limiting to 1 contract. You have entered <strong>{form.contracts}</strong> contracts (capital at risk: {fmt$(Number(form.premium_paid || 0) * Number(form.contracts) * 100)}).</span>
              </div>
            )}

            {/* Cost summary */}
            {form.premium_paid && form.contracts && (
              <div className="flex gap-6 text-xs text-zinc-500 bg-zinc-900/60 rounded-lg px-4 py-2 border border-zinc-800">
                <span>Total cost: <strong className="text-zinc-200">{fmt$(Number(form.premium_paid) * Number(form.contracts) * 100)}</strong></span>
                {form.strike && form.option_type && (
                  <span>Break-even: <strong className="text-zinc-200">
                    {form.option_type === 'CALL'
                      ? `$${(Number(form.strike) + Number(form.premium_paid)).toFixed(2)}`
                      : `$${(Number(form.strike) - Number(form.premium_paid)).toFixed(2)}`}
                  </strong></span>
                )}
                {form.strike && form.option_type && (
                  <span>Max loss: <strong className="text-red-400">{fmt$(Number(form.premium_paid) * Number(form.contracts) * 100)}</strong></span>
                )}
                {form.expiration && (
                  <span>DTE: <strong className="text-zinc-200">{daysToExpiry(form.expiration)}d</strong></span>
                )}
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 bg-red-950/50 border border-red-800 rounded-lg px-3 py-2 text-sm text-red-300">
                <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                {error}
              </div>
            )}
            <button type="submit" className="btn-primary flex items-center gap-2" disabled={saving}>
              <Check size={14} />
              {saving ? 'Saving…' : editId ? 'Update Trade' : 'Add Option Trade'}
            </button>
          </form>
        )}
      </div>

      {/* ── Trades list ─────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <h2 className="text-base font-semibold text-zinc-100 mr-auto">
            Positions <span className="text-zinc-600 text-sm font-normal">({filtered.length})</span>
          </h2>

          {/* ── Auto-pricing controls ── */}
          <div className="flex items-center gap-2">
            {apiKey ? (
              <>
                {lastRefreshed && (
                  <span className="text-xs text-zinc-600">Live · {lastRefreshed}</span>
                )}
                <button
                  onClick={fetchAllPrices}
                  disabled={fetchingPrices}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-emerald-800 text-emerald-400 hover:bg-emerald-900/30 transition-colors disabled:opacity-50"
                  title="Refresh live option premiums from Massive"
                >
                  <Clock size={11} className={fetchingPrices ? 'animate-spin' : ''} />
                  {fetchingPrices ? 'Fetching…' : 'Refresh'}
                </button>
                <button
                  onClick={() => setShowKeyInput(v => !v)}
                  className="text-xs px-2 py-1 rounded-lg border border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition-colors"
                  title="Change API key"
                >
                  🔑
                </button>
              </>
            ) : (
              <button
                onClick={() => setShowKeyInput(v => !v)}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-zinc-700 text-zinc-400 hover:text-emerald-400 hover:border-emerald-700 transition-colors"
              >
                🔑 Enable auto-pricing
              </button>
            )}
          </div>

          {/* Status filter */}
          <div className="flex gap-1">
            {(['ALL', 'OPEN', 'CLOSED', 'EXPIRED', 'ASSIGNED'] as const).map(s => (
              <button key={s} onClick={() => setFilterStatus(s)}
                className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                  filterStatus === s
                    ? 'bg-blue-900/50 text-blue-300 border-blue-600'
                    : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-500'
                }`}>
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* ── API key input ── */}
        {showKeyInput && (
          <div className="flex items-center gap-2 mb-4 p-3 rounded-lg bg-zinc-900/60 border border-zinc-700">
            <span className="text-xs text-zinc-400 flex-shrink-0">Massive API Key:</span>
            <input
              type="password"
              className="flex-1 bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-blue-500"
              placeholder={apiKey ? '••••••••••••••••' : 'Paste your key from massive.com/dashboard'}
              value={apiKeyDraft}
              onChange={e => setApiKeyDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveApiKey(); if (e.key === 'Escape') setShowKeyInput(false); }}
              autoFocus
            />
            <button onClick={saveApiKey} className="btn-primary text-xs px-3 py-1" disabled={!apiKeyDraft.trim()}>Save</button>
            {apiKey && (
              <button onClick={() => { localStorage.removeItem('massive_api_key'); setApiKey(''); setLivePrices({}); setShowKeyInput(false); }}
                className="text-xs text-red-400 hover:text-red-300 px-2 py-1">
                Remove
              </button>
            )}
            <button onClick={() => setShowKeyInput(false)} className="text-zinc-600 hover:text-zinc-300"><X size={13} /></button>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="text-center py-10 text-zinc-600">
            <Target size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">No option trades yet. Click <strong className="text-zinc-400">New Option</strong> to add your first trade.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(t => {
              const et     = withLive(t);                  // trade with live price applied
              const isLive = livePrices[t.id] != null;
              const dte    = daysToExpiry(t.expiration);
              const pnl    = t.status === 'OPEN' ? unrealizedPnl(et) : realizedPnl(et);
              const cost   = totalCost(t);
              const pnlPct = pnl != null ? (pnl / cost) * 100 : null;
              const isExpanded = expandId === t.id;
              const dteColor = dte <= 7 ? 'text-red-400' : dte <= 21 ? 'text-amber-400' : 'text-zinc-400';
              const alerts = t.status === 'OPEN' ? getRuleAlerts(et) : [];

              return (
                <div key={t.id} className={`rounded-lg border transition-colors ${
                  t.status === 'OPEN'
                    ? (pnl != null && pnl >= 0 ? 'border-emerald-800/60 bg-emerald-950/10' : 'border-zinc-800 bg-zinc-800/30')
                    : 'border-zinc-800/50 bg-zinc-900/20'
                }`}>
                  {/* ── Rule alert badges ── */}
                  {alerts.length > 0 && (
                    <div className="flex flex-wrap gap-2 px-4 pt-3 pb-0">
                      {alerts.map(a => (
                        <span key={a.rule} className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium border ${
                          a.color === 'green' ? 'bg-emerald-950/60 text-emerald-300 border-emerald-700' :
                          a.color === 'red'   ? 'bg-red-950/60 text-red-300 border-red-700' :
                                               'bg-amber-950/60 text-amber-300 border-amber-700'
                        }`}>
                          <Trophy size={10} className={a.color === 'green' ? 'text-emerald-400' : a.color === 'red' ? 'text-red-400' : 'text-amber-400'} />
                          <span className="font-bold">Rule {a.rule}</span> — {a.message}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* ── Main card content ── */}
                  <div className="p-4 space-y-3">

                    {/* Row 1: Ticker / type / DTE pill / status / actions */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <a href={barchartUrl(t.underlying)} target="_blank" rel="noopener noreferrer"
                        className="font-mono font-bold text-blue-400 hover:text-blue-300 hover:underline underline-offset-2 flex items-center gap-1 group"
                        title={`View ${t.underlying} options chain on Barchart`}>
                        {t.underlying}
                        <ExternalLink size={10} className="opacity-0 group-hover:opacity-60 transition-opacity" />
                      </a>
                      <span className={`text-xs font-bold ${TYPE_COLORS[t.option_type]}`}>{t.option_type}</span>
                      <span className="text-xs text-zinc-500">{t.strategy}</span>
                      {t.status === 'OPEN' && (
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full border tabular-nums ${
                          dte <= 7  ? 'bg-red-950/40 border-red-700 text-red-400' :
                          dte <= 21 ? 'bg-amber-950/40 border-amber-700 text-amber-400' :
                                      'bg-zinc-800 border-zinc-700 text-zinc-400'
                        }`}>{dte}d DTE</span>
                      )}
                      {/* Status + actions pushed right */}
                      <div className="ml-auto flex items-center gap-1.5">
                        <span className="hidden sm:inline text-xs text-zinc-600">{t.account} · {t.currency}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[t.status]}`}>{t.status}</span>
                        <button onClick={() => setExpandId(isExpanded ? null : t.id)} className="btn-ghost p-1.5" title="Details">
                          {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                        </button>
                        {t.status === 'OPEN' && (
                          <button onClick={() => { setCloseId(t.id); setCloseForm({ exit_premium: '', exit_date: new Date().toISOString().slice(0,10), status: 'CLOSED' }); }}
                            className="text-xs px-2 py-1 rounded border border-amber-700 text-amber-400 hover:bg-amber-900/30 transition-colors">
                            Close
                          </button>
                        )}
                        <button onClick={() => startEdit(t)} className="btn-ghost p-1.5" title="Edit"><Pencil size={11} /></button>
                        <button onClick={() => handleDelete(t.id)} className="btn-danger p-1.5" title="Delete"><Trash2 size={11} /></button>
                      </div>
                    </div>

                    {/* Row 2: Data grid — wraps on mobile */}
                    <div className="flex flex-wrap gap-x-5 gap-y-2">

                      {/* Strike · Expiry · Contracts */}
                      <div>
                        <div className="text-xs text-zinc-500">Strike · Expiry</div>
                        <div className="text-sm font-mono text-zinc-200">${t.strike} · {t.expiration}</div>
                        <div className="text-xs text-zinc-500">{t.contracts} contract{t.contracts !== 1 ? 's' : ''}</div>
                      </div>

                      {/* Capital at Risk */}
                      <div>
                        <div className="text-xs text-zinc-500">Capital at Risk</div>
                        <div className="text-sm font-mono text-red-400 font-semibold">{fmt$(cost)}</div>
                        <div className="text-xs text-zinc-600">${t.premium_paid.toFixed(2)}/sh paid</div>
                      </div>

                      {/* Current option premium */}
                      {t.status === 'OPEN' && (
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs text-zinc-500">Curr. Premium</span>
                            {isLive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-900/60 text-emerald-400 border border-emerald-800 font-semibold leading-none">LIVE</span>}
                          </div>
                          {updateId === t.id ? (
                            <div className="flex items-center gap-1">
                              <input type="number" step="0.01"
                                className="w-20 bg-zinc-700 border border-blue-500 rounded px-1.5 py-0.5 text-xs text-zinc-100 tabular-nums focus:outline-none"
                                value={updatePremium}
                                onChange={e => setUpdatePremium(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') handleUpdatePremium(t.id); if (e.key === 'Escape') setUpdateId(null); }}
                                placeholder="e.g. 12.50" autoFocus />
                              <button onClick={() => handleUpdatePremium(t.id)} className="text-emerald-400 p-0.5"><Check size={12} /></button>
                              <button onClick={() => { storage.update(TABLE, t.id, { current_premium: null }).then(load); setUpdateId(null); }} className="text-zinc-500 hover:text-red-400 p-0.5"><X size={12} /></button>
                            </div>
                          ) : (
                            <button
                              onClick={() => { setUpdateId(t.id); setUpdatePremium((et.current_premium ?? t.current_premium)?.toString() ?? ''); }}
                              className={`text-sm font-mono transition-colors ${isLive ? 'text-emerald-400 hover:text-emerald-300' : 'text-blue-400 hover:text-blue-300'}`}
                              title="Tap to update option premium">
                              {et.current_premium != null ? `$${et.current_premium.toFixed(2)}/sh` : <span className="text-zinc-600 text-xs italic">tap to set</span>}
                            </button>
                          )}
                          {priceErrors[t.id] && !isLive && <div className="text-[10px] text-amber-600 mt-0.5">{priceErrors[t.id]}</div>}
                        </div>
                      )}

                      {/* P&L */}
                      <div>
                        <div className="text-xs text-zinc-500">{t.status === 'OPEN' ? 'Unrealized' : 'Realized'} P&L</div>
                        {pnl != null && (t.status !== 'OPEN' || et.current_premium != null) ? (
                          <div className={`text-sm font-bold tabular-nums ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {fmtPnl(pnl)}
                            {pnlPct != null && <span className="text-xs ml-1 font-normal">({pnl >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%)</span>}
                          </div>
                        ) : (
                          <div className="text-xs text-zinc-600">{t.status === 'OPEN' ? 'set premium →' : '—'}</div>
                        )}
                      </div>

                      {/* Break-even */}
                      <div>
                        <div className="text-xs text-zinc-500">Break-even</div>
                        <div className="text-sm font-mono text-zinc-300">${breakEven(t).toFixed(2)}</div>
                      </div>

                      {/* Greeks — hidden on mobile */}
                      {(t.iv != null || t.delta != null || t.theta != null) && (
                        <div className="hidden sm:flex gap-3 text-xs items-end">
                          {t.iv    != null && <span className="text-zinc-500">IV <strong className="text-amber-400">{t.iv.toFixed(1)}%</strong></span>}
                          {t.delta != null && <span className="text-zinc-500">Δ <strong className="text-zinc-200">{t.delta.toFixed(2)}</strong></span>}
                          {t.theta != null && <span className="text-zinc-500">Θ <strong className="text-red-400">${t.theta.toFixed(2)}/d</strong></span>}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* ── Close form ── */}
                  {closeId === t.id && (
                    <div className="border-t border-zinc-800 px-4 py-3 bg-zinc-900/40 flex flex-wrap items-end gap-3">
                      <div className="text-xs font-semibold text-amber-400 w-full mb-1">Close Trade</div>
                      <div className="w-28">
                        <label className="label">Exit Premium</label>
                        <input className="input-base" type="number" step="0.01" placeholder="1.20" value={closeForm.exit_premium} onChange={e => setCloseForm(f => ({ ...f, exit_premium: e.target.value }))} autoFocus />
                      </div>
                      <div className="w-36">
                        <label className="label">Exit Date</label>
                        <input className="input-base" type="date" value={closeForm.exit_date} onChange={e => setCloseForm(f => ({ ...f, exit_date: e.target.value }))} />
                      </div>
                      <div className="w-32">
                        <label className="label">Result</label>
                        <select className="select-base" value={closeForm.status} onChange={e => setCloseForm(f => ({ ...f, status: e.target.value as OptionStatus }))}>
                          <option value="CLOSED">Closed (sold)</option>
                          <option value="EXPIRED">Expired worthless</option>
                          <option value="ASSIGNED">Assigned</option>
                        </select>
                      </div>
                      {closeForm.exit_premium && (
                        <div className="text-xs text-zinc-500">
                          P&L: <strong className={((parseFloat(closeForm.exit_premium) - t.premium_paid) * t.contracts * 100) >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                            {fmtPnl((parseFloat(closeForm.exit_premium) - t.premium_paid) * t.contracts * 100)}
                          </strong>
                        </div>
                      )}
                      {closeForm.status === 'EXPIRED' && (
                        <div className="text-xs text-zinc-500">
                          Max loss: <strong className="text-red-400">{fmt$(totalCost(t))}</strong>
                        </div>
                      )}
                      <button onClick={() => handleClose(t)} className="btn-primary text-xs" disabled={saving}>
                        <Check size={12} /> Confirm
                      </button>
                      <button onClick={() => setCloseId(null)} className="btn-ghost text-xs"><X size={12} /> Cancel</button>
                    </div>
                  )}

                  {/* ── Expanded details ── */}
                  {isExpanded && (
                    <div className="border-t border-zinc-800/60 px-4 py-3 bg-zinc-900/20 grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                      <div>
                        <div className="text-zinc-600 mb-1">Total Cost Basis</div>
                        <div className="font-mono text-zinc-200">{fmt$(cost)}</div>
                      </div>
                      <div>
                        <div className="text-zinc-600 mb-1">Break-even at Expiry</div>
                        <div className="font-mono text-zinc-200">${breakEven(t).toFixed(2)}</div>
                      </div>
                      <div>
                        <div className="text-zinc-600 mb-1">Max Loss</div>
                        <div className="font-mono text-red-400">{fmt$(cost)}</div>
                      </div>
                      <div>
                        <div className="text-zinc-600 mb-1">Entry Date</div>
                        <div className="text-zinc-300">{t.entry_date}</div>
                      </div>
                      {t.exit_date && (
                        <div>
                          <div className="text-zinc-600 mb-1">Exit Date</div>
                          <div className="text-zinc-300">{t.exit_date}</div>
                        </div>
                      )}
                      {t.exit_premium != null && (
                        <div>
                          <div className="text-zinc-600 mb-1">Exit Premium</div>
                          <div className="font-mono text-zinc-200">${t.exit_premium.toFixed(2)}</div>
                        </div>
                      )}
                      {t.notes && (
                        <div className="col-span-2 md:col-span-4">
                          <div className="text-zinc-600 mb-1">Thesis / Notes</div>
                          <div className="text-zinc-300 leading-relaxed">{t.notes}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
