import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus, X, Check, Settings, ChevronDown, ChevronUp, RefreshCw,
  AlertTriangle, Target, Clock, BarChart2, BookOpen, Edit2, Trash2,
  TrendingUp, TrendingDown, Trophy, ShieldAlert, Zap,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LineChart, Line, ReferenceLine,
} from 'recharts';
import { newId, nowIso } from '../../lib/storage';
import { fmt, fmtCurrency, fmtPct } from '../../lib/utils';

// ─── Sprint localStorage helpers ─────────────────────────────────────────────
// Using localStorage directly — Supabase tables for sprint don't exist yet.
// All keys prefixed "sprint_" to avoid collisions with swing_ trading data.
function sGet<T>(key: string, def: T): T {
  try { const r = localStorage.getItem(key); return r ? (JSON.parse(r) as T) : def; }
  catch { return def; }
}
function sSet(key: string, val: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ }
}

const SK = {
  settings : 'sprint_settings',
  positions: 'sprint_positions',
  trades   : 'sprint_trades',
  plans    : 'sprint_plans',
};

// ─── Types ───────────────────────────────────────────────────────────────────
interface SprintSettings {
  starting_capital      : number;
  target_multiplier     : number;
  duration_days         : number;
  sprint_start_date     : string;
  current_cash          : number;   // cash not in positions
  peak_equity           : number;
  drawdown_halt_pct     : number;
  derisk_milestone_pct  : number;
  stop_loss_pct         : number;
  is_active             : boolean;
}

interface SprintPosition {
  id               : string;
  ticker           : string;
  entry_date       : string;
  entry_price      : number;
  shares           : number;
  position_size_usd: number;
  stop_price       : number;
  target_price     : number;
  setup_type       : string;
  week_number      : number;
  notes            : string;
  created_at       : string;
}

interface SprintTrade extends SprintPosition {
  exit_date      : string;
  exit_price     : number;
  pnl_usd        : number;
  pnl_pct        : number;
  r_multiple     : number;
  exit_reason    : string;
  plan_adherence : string;
}

interface WeeklyPlan {
  id           : string;
  week_number  : number;
  date_received: string;
  plan_text    : string;
  setups       : Array<{
    ticker     : string;
    entry      : number;
    stop       : number;
    target     : number;
    score      : string;
    taken      : boolean;
    skip_reason: string;
  }>;
  created_at: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────
const SETUP_TYPES  = ['Breakout', 'Pullback', 'Catalyst', 'Reversal'];
const EXIT_REASONS = ['Target', 'Trailing Stop', 'Stop Loss', 'Time Stop', 'Manual', 'Drawdown Halt'];
const ADHERENCE    = ['Followed', 'Minor Deviation', 'Broke Rules'];

const DEFAULT_SETTINGS: SprintSettings = {
  starting_capital    : 0,
  target_multiplier   : 2.0,
  duration_days       : 60,
  sprint_start_date   : new Date().toISOString().split('T')[0],
  current_cash        : 0,
  peak_equity         : 0,
  drawdown_halt_pct   : 15,
  derisk_milestone_pct: 50,
  stop_loss_pct       : 8,
  is_active           : false,
};

type InnerView = 'dashboard' | 'positions' | 'trades' | 'plans' | 'analytics' | 'settings';

// ─── Modal backdrop ───────────────────────────────────────────────────────────
function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function SprintTracker() {
  const [view, setView] = useState<InnerView>('dashboard');

  // Sprint data
  const [settings,  setSettings ] = useState<SprintSettings>(() => sGet(SK.settings,  DEFAULT_SETTINGS));
  const [positions, setPositions] = useState<SprintPosition[]>(() => sGet(SK.positions, []));
  const [trades,    setTrades   ] = useState<SprintTrade[]>   (() => sGet(SK.trades,    []));
  const [plans,     setPlans    ] = useState<WeeklyPlan[]>    (() => sGet(SK.plans,     []));

  // Live prices { AAPL: 213.5, ... }
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [priceLoading, setPriceLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Modals
  const [addPosOpen,  setAddPosOpen ] = useState(false);
  const [editPos,     setEditPos    ] = useState<SprintPosition | null>(null);
  const [closePos,    setClosePos   ] = useState<SprintPosition | null>(null);
  const [addPlanOpen, setAddPlanOpen] = useState(false);
  const [expandedPlan,setExpandedPlan] = useState<string | null>(null);

  // Sort/filter for trades table
  const [tradeSort, setTradeSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'exit_date', dir: 'desc' });
  const [tradeFilter, setTradeFilter] = useState({ setup: '', outcome: '', adherence: '' });

  // ── Persist whenever data changes ──────────────────────────────────────────
  useEffect(() => { sSet(SK.settings,  settings);  }, [settings]);
  useEffect(() => { sSet(SK.positions, positions); }, [positions]);
  useEffect(() => { sSet(SK.trades,    trades);    }, [trades]);
  useEffect(() => { sSet(SK.plans,     plans);     }, [plans]);

  // ── Fetch live prices ──────────────────────────────────────────────────────
  const fetchPrices = useCallback(async () => {
    if (!positions.length) return;
    setPriceLoading(true);
    const results: Record<string, number> = {};
    await Promise.allSettled(
      positions.map(async (p) => {
        try {
          const res = await fetch(`/api/yahoo?ticker=${p.ticker}`);
          const d   = await res.json();
          const price = d?.price?.regularMarketPrice ?? null;
          if (price) results[p.ticker] = price;
        } catch { /* keep previous */ }
      })
    );
    setLivePrices((prev) => ({ ...prev, ...results }));
    setPriceLoading(false);
  }, [positions]);

  useEffect(() => {
    fetchPrices();
    intervalRef.current = setInterval(fetchPrices, 60_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchPrices]);

  // ── Computed equity metrics ────────────────────────────────────────────────
  const openValue = positions.reduce((s, p) => {
    const px = livePrices[p.ticker] ?? p.entry_price;
    return s + p.shares * px;
  }, 0);
  const currentEquity  = settings.current_cash + openValue;
  const startingCap    = settings.starting_capital;
  const target         = startingCap * settings.target_multiplier;
  const pctToGoal      = startingCap > 0 ? ((currentEquity - startingCap) / (target - startingCap)) * 100 : 0;
  const drawdownFromPeak = settings.peak_equity > 0
    ? ((currentEquity - settings.peak_equity) / settings.peak_equity) * 100 : 0;
  const haltThreshold  = settings.peak_equity * (1 - settings.drawdown_halt_pct / 100);
  const deRiskTarget   = startingCap * (1 + settings.derisk_milestone_pct / 100);
  const isHalted       = drawdownFromPeak <= -settings.drawdown_halt_pct;
  const isDeRisk       = currentEquity >= deRiskTarget && startingCap > 0;
  const isTargetHit    = currentEquity >= target && startingCap > 0;

  // Closed trade stats
  const wins = trades.filter((t) => t.pnl_usd > 0);
  const losses = trades.filter((t) => t.pnl_usd <= 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const avgWin  = wins.length ? wins.reduce((s, t) => s + t.pnl_usd, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl_usd, 0) / losses.length : 0;
  const grossWins = wins.reduce((s, t) => s + t.pnl_usd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl_usd, 0));
  const profitFactor = grossLoss > 0 ? grossWins / grossLoss : grossWins > 0 ? Infinity : 0;
  const avgR = trades.length ? trades.reduce((s, t) => s + t.r_multiple, 0) / trades.length : 0;

  // Sprint day tracking
  const today = new Date();
  const startDate = settings.sprint_start_date ? new Date(settings.sprint_start_date) : today;
  const dayNum = Math.max(1, Math.floor((today.getTime() - startDate.getTime()) / 86_400_000) + 1);
  const daysRemaining = Math.max(0, settings.duration_days - dayNum + 1);

  // Update peak equity whenever equity rises
  useEffect(() => {
    if (!settings.is_active || !startingCap) return;
    if (currentEquity > settings.peak_equity) {
      setSettings((s) => ({ ...s, peak_equity: currentEquity }));
    }
  }, [currentEquity]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Setup sprint ───────────────────────────────────────────────────────────
  const [setupForm, setSetupForm] = useState({
    starting_capital : '',
    target_multiplier: '2.0',
    duration_days    : '60',
    sprint_start_date: new Date().toISOString().split('T')[0],
  });

  function handleStartSprint() {
    const cap = parseFloat(setupForm.starting_capital);
    if (!cap || cap <= 0) return;
    const s: SprintSettings = {
      ...DEFAULT_SETTINGS,
      starting_capital   : cap,
      target_multiplier  : parseFloat(setupForm.target_multiplier) || 2.0,
      duration_days      : parseInt(setupForm.duration_days)       || 60,
      sprint_start_date  : setupForm.sprint_start_date,
      current_cash       : cap,
      peak_equity        : cap,
      is_active          : true,
    };
    setSettings(s);
  }

  // ── Position helpers ───────────────────────────────────────────────────────
  const emptyPosForm = {
    ticker: '', entry_date: today.toISOString().split('T')[0],
    entry_price: '', shares: '', position_size_usd: '',
    stop_price: '', target_price: '',
    setup_type: 'Breakout', week_number: '1', notes: '',
  };
  const [posForm, setPosForm] = useState(emptyPosForm);

  function calcPosForm(field: string, value: string) {
    const f = { ...posForm, [field]: value };
    const ep = parseFloat(f.entry_price);
    if (!isNaN(ep) && ep > 0) {
      if (field === 'shares') {
        const sh = parseFloat(value);
        if (!isNaN(sh)) f.position_size_usd = (sh * ep).toFixed(2);
      } else if (field === 'position_size_usd') {
        const ps = parseFloat(value);
        if (!isNaN(ps)) f.shares = (ps / ep).toFixed(4);
      }
    }
    setPosForm(f);
  }

  function savePosition() {
    const ep = parseFloat(posForm.entry_price);
    const sh = parseFloat(posForm.shares);
    const sp = parseFloat(posForm.stop_price);
    const tp = parseFloat(posForm.target_price);
    if (!posForm.ticker || !ep || !sh || !sp || !tp) return;
    if (editPos) {
      const updated = positions.map((p) => p.id === editPos.id
        ? { ...p, ticker: posForm.ticker.toUpperCase(), entry_date: posForm.entry_date,
            entry_price: ep, shares: sh, position_size_usd: sh * ep,
            stop_price: sp, target_price: tp, setup_type: posForm.setup_type,
            week_number: parseInt(posForm.week_number), notes: posForm.notes }
        : p);
      setPositions(updated);
      setEditPos(null);
    } else {
      const pos: SprintPosition = {
        id: newId(), ticker: posForm.ticker.toUpperCase(), entry_date: posForm.entry_date,
        entry_price: ep, shares: sh, position_size_usd: sh * ep,
        stop_price: sp, target_price: tp, setup_type: posForm.setup_type,
        week_number: parseInt(posForm.week_number), notes: posForm.notes,
        created_at: nowIso(),
      };
      setPositions((prev) => [pos, ...prev]);
      // Deduct from cash
      setSettings((s) => ({ ...s, current_cash: Math.max(0, s.current_cash - pos.position_size_usd) }));
    }
    setAddPosOpen(false);
    setPosForm(emptyPosForm);
  }

  // ── Close position ─────────────────────────────────────────────────────────
  const [closeForm, setCloseForm] = useState({
    exit_date: today.toISOString().split('T')[0],
    exit_price: '', exit_reason: 'Target', plan_adherence: 'Followed', notes: '',
  });

  function handleClosePosition() {
    if (!closePos) return;
    const ep  = parseFloat(closeForm.exit_price);
    if (!ep) return;
    const pnl_usd = (ep - closePos.entry_price) * closePos.shares;
    const pnl_pct = ((ep - closePos.entry_price) / closePos.entry_price) * 100;
    const risk    = closePos.entry_price - closePos.stop_price;
    const r_mult  = risk > 0 ? (ep - closePos.entry_price) / risk : 0;

    const trade: SprintTrade = {
      ...closePos, exit_date: closeForm.exit_date, exit_price: ep,
      pnl_usd, pnl_pct, r_multiple: r_mult,
      exit_reason: closeForm.exit_reason,
      plan_adherence: closeForm.plan_adherence,
      notes: closeForm.notes || closePos.notes,
    };
    setTrades((prev) => [trade, ...prev]);
    setPositions((prev) => prev.filter((p) => p.id !== closePos.id));
    setSettings((s) => ({ ...s, current_cash: s.current_cash + ep * closePos.shares }));
    setClosePos(null);
    setCloseForm({ exit_date: today.toISOString().split('T')[0], exit_price: '', exit_reason: 'Target', plan_adherence: 'Followed', notes: '' });
  }

  // ── Weekly plan helpers ────────────────────────────────────────────────────
  const [planForm, setPlanForm] = useState({ week_number: '1', date_received: today.toISOString().split('T')[0], plan_text: '' });

  function savePlan() {
    if (!planForm.plan_text.trim()) return;
    const plan: WeeklyPlan = {
      id: newId(), week_number: parseInt(planForm.week_number),
      date_received: planForm.date_received, plan_text: planForm.plan_text,
      setups: [], created_at: nowIso(),
    };
    setPlans((prev) => [plan, ...prev]);
    setAddPlanOpen(false);
    setPlanForm({ week_number: '1', date_received: today.toISOString().split('T')[0], plan_text: '' });
  }

  // ── Trade sort/filter ─────────────────────────────────────────────────────
  function sortTrades(key: string) {
    setTradeSort((s) => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' });
  }
  const filteredTrades = [...trades]
    .filter((t) => (!tradeFilter.setup || t.setup_type === tradeFilter.setup)
      && (!tradeFilter.outcome || (tradeFilter.outcome === 'WIN' ? t.pnl_usd > 0 : t.pnl_usd <= 0))
      && (!tradeFilter.adherence || t.plan_adherence === tradeFilter.adherence))
    .sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[tradeSort.key];
      const bv = (b as unknown as Record<string, unknown>)[tradeSort.key];
      const cmp = typeof av === 'string' ? String(av).localeCompare(String(bv)) : (Number(av) - Number(bv));
      return tradeSort.dir === 'asc' ? cmp : -cmp;
    });

  // ── Analytics data ────────────────────────────────────────────────────────
  const bySetup = SETUP_TYPES.map((st) => {
    const subset = trades.filter((t) => t.setup_type === st);
    const w = subset.filter((t) => t.pnl_usd > 0);
    return {
      name: st, count: subset.length,
      winRate: subset.length ? Math.round((w.length / subset.length) * 100) : 0,
      avgR: subset.length ? +(subset.reduce((s, t) => s + t.r_multiple, 0) / subset.length).toFixed(2) : 0,
      pnl: +subset.reduce((s, t) => s + t.pnl_usd, 0).toFixed(2),
    };
  }).filter((d) => d.count > 0);

  const maxWeek = Math.max(...trades.map((t) => t.week_number), 0);
  const byWeek = Array.from({ length: maxWeek }, (_, i) => {
    const w = i + 1;
    const subset = trades.filter((t) => t.week_number === w);
    return { name: `W${w}`, pnl: +subset.reduce((s, t) => s + t.pnl_usd, 0).toFixed(2) };
  });

  // ── Settings form ─────────────────────────────────────────────────────────
  const [settingsForm, setSettingsForm] = useState({ ...settings,
    starting_capital   : String(settings.starting_capital),
    target_multiplier  : String(settings.target_multiplier),
    duration_days      : String(settings.duration_days),
    drawdown_halt_pct  : String(settings.drawdown_halt_pct),
    derisk_milestone_pct: String(settings.derisk_milestone_pct),
    stop_loss_pct      : String(settings.stop_loss_pct),
    current_cash       : String(settings.current_cash),
  });

  function saveSettings() {
    setSettings((s) => ({
      ...s,
      starting_capital    : parseFloat(settingsForm.starting_capital)    || s.starting_capital,
      target_multiplier   : parseFloat(settingsForm.target_multiplier)   || s.target_multiplier,
      duration_days       : parseInt(settingsForm.duration_days)         || s.duration_days,
      sprint_start_date   : settingsForm.sprint_start_date,
      drawdown_halt_pct   : parseFloat(settingsForm.drawdown_halt_pct)   || s.drawdown_halt_pct,
      derisk_milestone_pct: parseFloat(settingsForm.derisk_milestone_pct)|| s.derisk_milestone_pct,
      stop_loss_pct       : parseFloat(settingsForm.stop_loss_pct)       || s.stop_loss_pct,
      current_cash        : parseFloat(settingsForm.current_cash)        ?? s.current_cash,
    }));
  }

  function resetSprint() {
    if (!window.confirm('Reset entire sprint? This will delete all positions and trades.')) return;
    setSettings(DEFAULT_SETTINGS);
    setPositions([]);
    setTrades([]);
    setPlans([]);
    setLivePrices({});
    setView('dashboard');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  // ── Setup card (no sprint started) ────────────────────────────────────────
  if (!settings.is_active) {
    return (
      <div className="flex items-start justify-center min-h-[60vh] pt-12">
        <div className="card w-full max-w-md">
          <div className="flex items-center gap-2 mb-5">
            <Zap size={20} className="text-amber-400" />
            <h2 className="text-lg font-bold">Start a New Sprint</h2>
          </div>
          <div className="space-y-3">
            <div>
              <label className="label">Starting Capital (USD) *</label>
              <input className="input-base" type="number" placeholder="e.g. 5000"
                value={setupForm.starting_capital}
                onChange={(e) => setSetupForm({ ...setupForm, starting_capital: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Target Multiplier</label>
                <select className="select-base" value={setupForm.target_multiplier}
                  onChange={(e) => setSetupForm({ ...setupForm, target_multiplier: e.target.value })}>
                  <option value="1.5">1.5× (+50%)</option>
                  <option value="2.0">2.0× (+100%)</option>
                  <option value="3.0">3.0× (+200%)</option>
                </select>
              </div>
              <div>
                <label className="label">Duration (days)</label>
                <input className="input-base" type="number" value={setupForm.duration_days}
                  onChange={(e) => setSetupForm({ ...setupForm, duration_days: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="label">Sprint Start Date</label>
              <input className="input-base" type="date" value={setupForm.sprint_start_date}
                onChange={(e) => setSetupForm({ ...setupForm, sprint_start_date: e.target.value })} />
            </div>
            <button className="btn-primary w-full flex items-center justify-center gap-2 mt-2"
              onClick={handleStartSprint} disabled={!setupForm.starting_capital}>
              <Zap size={15} /> Start Sprint
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Inner nav ─────────────────────────────────────────────────────────────
  const NAV: { id: InnerView; label: string; icon: React.ElementType }[] = [
    { id: 'dashboard', label: 'Dashboard',     icon: BarChart2 },
    { id: 'positions', label: 'Open Positions', icon: TrendingUp },
    { id: 'trades',    label: 'Closed Trades',  icon: TrendingDown },
    { id: 'plans',     label: 'Week Plans',      icon: BookOpen },
    { id: 'analytics', label: 'Analytics',      icon: Target },
    { id: 'settings',  label: 'Settings',        icon: Settings },
  ];

  return (
    <div className="space-y-4">
      {/* Alert Banners */}
      {isHalted && (
        <div className="bg-red-900/60 border border-red-500 rounded-xl p-3 flex items-center gap-2 animate-pulse">
          <ShieldAlert size={18} className="text-red-300 flex-shrink-0" />
          <span className="font-bold text-red-200">🛑 DRAWDOWN LIMIT HIT — HALT ALL NEW TRADES</span>
        </div>
      )}
      {isTargetHit && (
        <div className="bg-emerald-900/60 border border-emerald-500 rounded-xl p-3 flex items-center gap-2">
          <Trophy size={18} className="text-emerald-300 flex-shrink-0" />
          <span className="font-bold text-emerald-200">🏆 TARGET HIT — WITHDRAW AND CLOSE SPRINT</span>
        </div>
      )}
      {!isTargetHit && isDeRisk && (
        <div className="bg-amber-900/60 border border-amber-500 rounded-xl p-3 flex items-center gap-2">
          <AlertTriangle size={18} className="text-amber-300 flex-shrink-0" />
          <span className="font-bold text-amber-200">🎯 +{settings.derisk_milestone_pct}% MILESTONE — DE-RISK TO 50% CASH</span>
        </div>
      )}

      {/* Inner navigation */}
      <div className="flex gap-1 flex-wrap border-b border-zinc-800 pb-1">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setView(id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              view === id ? 'bg-blue-600/20 text-blue-400 border border-blue-700' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {/* ── DASHBOARD ────────────────────────────────────────────────────── */}
      {view === 'dashboard' && (
        <div className="space-y-4">
          {/* Progress bar */}
          <div className="card py-3">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <div>
                <span className="text-2xl font-black text-zinc-100">DAY {dayNum}</span>
                <span className="text-zinc-500 font-medium ml-2">of {settings.duration_days}</span>
                <span className="text-xs text-zinc-600 ml-3">{daysRemaining} days remaining</span>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold text-emerald-400">{fmtCurrency(currentEquity)}</div>
                <div className="text-xs text-zinc-500">Target: {fmtCurrency(target)}</div>
              </div>
            </div>
            <div className="w-full bg-zinc-800 rounded-full h-3 overflow-hidden">
              <div className={`h-3 rounded-full transition-all ${pctToGoal >= 100 ? 'bg-emerald-400' : pctToGoal > 0 ? 'bg-blue-500' : 'bg-zinc-600'}`}
                style={{ width: `${Math.min(Math.max(pctToGoal, 0), 100)}%` }} />
            </div>
            <div className="text-xs text-zinc-500 mt-1">{fmt(pctToGoal, 1)}% to goal</div>
          </div>

          {/* Metrics grid + Rules sidebar */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Metrics */}
            <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[
                { label: 'Starting Capital', value: fmtCurrency(startingCap), sub: '' },
                { label: 'Current Equity',   value: fmtCurrency(currentEquity), sub: `Cash: ${fmtCurrency(settings.current_cash)}`, color: currentEquity >= startingCap ? 'text-emerald-400' : 'text-red-400' },
                { label: 'Open Positions',   value: String(positions.length),   sub: `Value: ${fmtCurrency(openValue)}` },
                { label: 'Drawdown from Peak', value: `${fmt(drawdownFromPeak, 1)}%`,
                  color: drawdownFromPeak >= 0 ? 'text-emerald-400' : drawdownFromPeak >= -settings.drawdown_halt_pct / 2 ? 'text-amber-400' : 'text-red-400',
                  sub: `Halt at: ${fmtCurrency(haltThreshold)}` },
                { label: 'Closed Trades',   value: String(trades.length),       sub: `Wins: ${wins.length} · Losses: ${losses.length}` },
                { label: 'Win Rate',         value: trades.length ? `${fmt(winRate, 1)}%` : '—', color: winRate >= 50 ? 'text-emerald-400' : 'text-red-400', sub: '' },
                { label: 'Avg R-Multiple',   value: trades.length ? `${fmt(avgR, 2)}R` : '—', color: avgR >= 1 ? 'text-emerald-400' : 'text-red-400', sub: '' },
                { label: 'Profit Factor',    value: trades.length ? (profitFactor === Infinity ? '∞' : fmt(profitFactor, 2)) : '—', color: profitFactor >= 1.5 ? 'text-emerald-400' : 'text-amber-400', sub: '' },
                { label: 'Avg Win / Avg Loss', value: `${fmtCurrency(avgWin)} / ${fmtCurrency(Math.abs(avgLoss))}`, sub: '' },
              ].map(({ label, value, sub, color }) => (
                <div key={label} className="bg-zinc-800/50 rounded-lg p-3">
                  <div className="text-xs text-zinc-500 mb-0.5">{label}</div>
                  <div className={`text-lg font-bold tabular-nums ${color ?? 'text-zinc-100'}`}>{value}</div>
                  {sub && <div className="text-xs text-zinc-600 mt-0.5">{sub}</div>}
                </div>
              ))}
            </div>

            {/* Hard Rules Sidebar */}
            <div className="card space-y-3 text-xs">
              <div className="flex items-center gap-1.5 text-amber-400 font-bold text-sm">
                <ShieldAlert size={15} /> HARD RULES
              </div>

              <div>
                <div className="text-zinc-400 font-semibold mb-1.5">Per-Trade</div>
                <ul className="space-y-1 text-zinc-400">
                  <li>• Stop loss: <span className="text-red-400 font-mono">-{settings.stop_loss_pct}%</span> from entry</li>
                  <li>• Trail to breakeven at <span className="text-emerald-400 font-mono">+1R</span></li>
                  <li>• Take profit: <span className="text-emerald-400 font-mono">2R–3R</span> (~+15–25%)</li>
                  <li>• Time stop: <span className="text-amber-400 font-mono">20 days</span> no movement</li>
                  <li>• Max <span className="text-blue-400 font-mono">4</span> open positions</li>
                  <li>• Min position: <span className="text-blue-400 font-mono">20%</span> of starting capital</li>
                  <li>• Min target: <span className="text-emerald-400 font-mono">2:1 R/R</span> (2× your stop risk)</li>
                </ul>
              </div>

              <div className="border-t border-zinc-700 pt-2">
                <div className="text-zinc-400 font-semibold mb-1.5">Account-Level</div>
                <ul className="space-y-1.5 text-zinc-400">
                  <li>• Drawdown halt: <span className={`font-mono ${isHalted ? 'text-red-400 font-bold' : 'text-red-400'}`}>-{settings.drawdown_halt_pct}%</span> from peak
                    <div className="text-zinc-600 ml-2">Threshold: {fmtCurrency(haltThreshold)}</div>
                  </li>
                  <li>• De-risk milestone: <span className="text-amber-400 font-mono">+{settings.derisk_milestone_pct}%</span>
                    <div className="text-zinc-600 ml-2">Threshold: {fmtCurrency(deRiskTarget)}</div>
                  </li>
                  <li>• Target: <span className="text-emerald-400 font-mono">+{Math.round((settings.target_multiplier - 1) * 100)}%</span>
                    <div className="text-zinc-600 ml-2">Threshold: {fmtCurrency(target)}</div>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── OPEN POSITIONS ───────────────────────────────────────────────── */}
      {view === 'positions' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-base font-semibold">Open Positions ({positions.length})</h2>
            <div className="flex gap-2">
              <button onClick={fetchPrices} disabled={priceLoading}
                className="btn-ghost flex items-center gap-1.5 text-xs">
                <RefreshCw size={12} className={priceLoading ? 'animate-spin' : ''} /> Refresh
              </button>
              <button onClick={() => { setEditPos(null); setPosForm(emptyPosForm); setAddPosOpen(true); }}
                className="btn-primary flex items-center gap-1.5 text-sm">
                <Plus size={14} /> Add Position
              </button>
            </div>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400">
                  {['Ticker','Entry Date','Days','Entry $','Current $','Stop | Dist','Target | Dist','Size $','Value $','P&L','R','Setup','Wk',''].map((h) => (
                    <th key={h} className="th whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {positions.length === 0 && (
                  <tr><td colSpan={14} className="td text-center text-zinc-600 py-8">No open positions. Add one above.</td></tr>
                )}
                {positions.map((p) => {
                  const px       = livePrices[p.ticker] ?? p.entry_price;
                  const unrlz    = (px - p.entry_price) * p.shares;
                  const unrlzPct = ((px - p.entry_price) / p.entry_price) * 100;
                  const risk     = p.entry_price - p.stop_price;
                  const rMult    = risk > 0 ? (px - p.entry_price) / risk : 0;
                  const stopDist = ((px - p.stop_price) / px) * 100;
                  const tgtDist  = ((p.target_price - px) / px) * 100;
                  const daysHeld = Math.floor((today.getTime() - new Date(p.entry_date).getTime()) / 86_400_000);
                  const daysColor = daysHeld >= 20 ? 'text-red-400 font-bold' : daysHeld >= 15 ? 'text-amber-400 font-bold' : '';

                  return (
                    <tr key={p.id} className="tr-hover">
                      <td className="td font-mono font-bold text-blue-400">{p.ticker}</td>
                      <td className="td text-zinc-500">{p.entry_date}</td>
                      <td className={`td tabular-nums ${daysColor}`}>{daysHeld}</td>
                      <td className="td tabular-nums">{fmtCurrency(p.entry_price)}</td>
                      <td className="td tabular-nums font-medium">{fmtCurrency(px)}</td>
                      <td className="td tabular-nums">
                        <div>{fmtCurrency(p.stop_price)}</div>
                        <div className={`text-zinc-500 ${stopDist < 3 ? 'text-red-400' : ''}`}>{fmt(stopDist, 1)}%</div>
                      </td>
                      <td className="td tabular-nums">
                        <div>{fmtCurrency(p.target_price)}</div>
                        <div className="text-zinc-500">{fmt(tgtDist, 1)}%</div>
                      </td>
                      <td className="td tabular-nums">{fmtCurrency(p.position_size_usd)}</td>
                      <td className="td tabular-nums">{fmtCurrency(px * p.shares)}</td>
                      <td className={`td tabular-nums font-medium ${unrlz >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        <div>{unrlz >= 0 ? '+' : ''}{fmtCurrency(unrlz)}</div>
                        <div className="text-xs">{fmtPct(unrlzPct)}</div>
                      </td>
                      <td className={`td tabular-nums font-bold ${rMult >= 1 ? 'text-emerald-400' : rMult >= 0 ? 'text-zinc-300' : 'text-red-400'}`}>
                        {fmt(rMult, 2)}R
                      </td>
                      <td className="td text-zinc-400">{p.setup_type}</td>
                      <td className="td text-zinc-500">W{p.week_number}</td>
                      <td className="td">
                        <div className="flex gap-1">
                          <button onClick={() => { setEditPos(p); setPosForm({ ticker: p.ticker, entry_date: p.entry_date, entry_price: String(p.entry_price), shares: String(p.shares), position_size_usd: String(p.position_size_usd), stop_price: String(p.stop_price), target_price: String(p.target_price), setup_type: p.setup_type, week_number: String(p.week_number), notes: p.notes }); setAddPosOpen(true); }}
                            className="btn-ghost p-1" title="Edit"><Edit2 size={12} /></button>
                          <button onClick={() => { setClosePos(p); setCloseForm({ ...closeForm, exit_price: String(livePrices[p.ticker] ?? p.entry_price) }); }}
                            className="text-xs px-2 py-1 rounded border border-amber-700 text-amber-400 hover:bg-amber-900/30 transition-colors font-medium">
                            Close
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Add/Edit Position Modal */}
          {(addPosOpen || editPos) && (
            <Modal onClose={() => { setAddPosOpen(false); setEditPos(null); }}>
              <div className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-zinc-100">{editPos ? 'Edit Position' : 'Add Position'}</h3>
                  <button onClick={() => { setAddPosOpen(false); setEditPos(null); }}><X size={16} className="text-zinc-400" /></button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="label">Ticker *</label>
                    <input className="input-base uppercase" placeholder="AAPL" value={posForm.ticker}
                      onChange={(e) => setPosForm({ ...posForm, ticker: e.target.value.toUpperCase() })} />
                  </div>
                  <div><label className="label">Entry Date</label><input type="date" className="input-base" value={posForm.entry_date} onChange={(e) => setPosForm({ ...posForm, entry_date: e.target.value })} /></div>
                  <div><label className="label">Entry Price *</label><input type="number" step="0.01" className="input-base" value={posForm.entry_price} onChange={(e) => calcPosForm('entry_price', e.target.value)} /></div>
                  <div><label className="label">Shares</label><input type="number" step="0.001" className="input-base" placeholder="auto-calc" value={posForm.shares} onChange={(e) => calcPosForm('shares', e.target.value)} /></div>
                  <div><label className="label">Position Size $</label><input type="number" step="0.01" className="input-base" placeholder="auto-calc" value={posForm.position_size_usd} onChange={(e) => calcPosForm('position_size_usd', e.target.value)} /></div>
                  <div>
                    <label className="label">Stop Price *</label>
                    <input type="number" step="0.01" className="input-base" value={posForm.stop_price} onChange={(e) => setPosForm({ ...posForm, stop_price: e.target.value })} />
                    {posForm.stop_price && posForm.entry_price && (() => {
                      const pct = ((parseFloat(posForm.entry_price) - parseFloat(posForm.stop_price)) / parseFloat(posForm.entry_price)) * 100;
                      if (Math.abs(pct - settings.stop_loss_pct) > 3) return <p className="text-amber-400 text-xs mt-0.5">⚠️ Stop is {fmt(pct, 1)}% away (rule: {settings.stop_loss_pct}%)</p>;
                    })()}
                  </div>
                  <div>
                    <label className="label">Target Price *</label>
                    <input type="number" step="0.01" className="input-base" value={posForm.target_price} onChange={(e) => setPosForm({ ...posForm, target_price: e.target.value })} />
                    {posForm.target_price && posForm.entry_price && (() => {
                      const ep  = parseFloat(posForm.entry_price);
                      const sp  = parseFloat(posForm.stop_price);
                      const tp  = parseFloat(posForm.target_price);
                      if (!ep || !tp) return null;
                      const tgtPct = ((tp - ep) / ep) * 100;
                      // Use actual stop for R/R if available, else use stop_loss_pct setting
                      const riskPct = (sp > 0 && sp < ep) ? ((ep - sp) / ep) * 100 : settings.stop_loss_pct;
                      const rr = tgtPct / riskPct;
                      if (rr < 2) return (
                        <p className="text-amber-400 text-xs mt-0.5">
                          ⚠️ Only {fmt(rr, 1)}:1 R/R ({fmt(tgtPct, 1)}%) — aim for 2:1 minimum
                        </p>
                      );
                      return <p className="text-emerald-400 text-xs mt-0.5">✓ {fmt(rr, 1)}:1 R/R ({fmt(tgtPct, 1)}%)</p>;
                    })()}
                  </div>
                  <div><label className="label">Setup Type</label>
                    <select className="select-base" value={posForm.setup_type} onChange={(e) => setPosForm({ ...posForm, setup_type: e.target.value })}>
                      {SETUP_TYPES.map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div><label className="label">Week #</label>
                    <select className="select-base" value={posForm.week_number} onChange={(e) => setPosForm({ ...posForm, week_number: e.target.value })}>
                      {Array.from({ length: Math.ceil(settings.duration_days / 7) }, (_, i) => (
                        <option key={i + 1} value={i + 1}>W{i + 1}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-2"><label className="label">Notes</label>
                    <textarea className="input-base h-16 resize-none" value={posForm.notes} onChange={(e) => setPosForm({ ...posForm, notes: e.target.value })} />
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <button className="btn-ghost" onClick={() => { setAddPosOpen(false); setEditPos(null); }}>Cancel</button>
                  <button className="btn-primary" onClick={savePosition}>
                    <Check size={14} /> {editPos ? 'Update' : 'Add Position'}
                  </button>
                </div>
              </div>
            </Modal>
          )}

          {/* Close Position Modal */}
          {closePos && (
            <Modal onClose={() => setClosePos(null)}>
              <div className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold">Close {closePos.ticker}</h3>
                  <button onClick={() => setClosePos(null)}><X size={16} className="text-zinc-400" /></button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="label">Exit Date</label><input type="date" className="input-base" value={closeForm.exit_date} onChange={(e) => setCloseForm({ ...closeForm, exit_date: e.target.value })} /></div>
                  <div><label className="label">Exit Price *</label><input type="number" step="0.01" className="input-base" value={closeForm.exit_price} onChange={(e) => setCloseForm({ ...closeForm, exit_price: e.target.value })} /></div>
                  <div><label className="label">Exit Reason</label>
                    <select className="select-base" value={closeForm.exit_reason} onChange={(e) => setCloseForm({ ...closeForm, exit_reason: e.target.value })}>
                      {EXIT_REASONS.map((r) => <option key={r}>{r}</option>)}
                    </select>
                  </div>
                  <div><label className="label">Plan Adherence</label>
                    <select className="select-base" value={closeForm.plan_adherence} onChange={(e) => setCloseForm({ ...closeForm, plan_adherence: e.target.value })}>
                      {ADHERENCE.map((a) => <option key={a}>{a}</option>)}
                    </select>
                  </div>
                  <div className="col-span-2"><label className="label">Notes / Lessons</label>
                    <textarea className="input-base h-16 resize-none" value={closeForm.notes} onChange={(e) => setCloseForm({ ...closeForm, notes: e.target.value })} />
                  </div>
                  {closeForm.exit_price && (() => {
                    const ep = parseFloat(closeForm.exit_price);
                    const pnl = (ep - closePos.entry_price) * closePos.shares;
                    const r   = closePos.entry_price - closePos.stop_price;
                    const rm  = r > 0 ? (ep - closePos.entry_price) / r : 0;
                    return (
                      <div className="col-span-2 bg-zinc-800/60 rounded-lg p-3 text-sm flex gap-4">
                        <div><span className="text-zinc-500">P&L: </span><span className={pnl >= 0 ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>{pnl >= 0 ? '+' : ''}{fmtCurrency(pnl)}</span></div>
                        <div><span className="text-zinc-500">R: </span><span className={`font-bold ${rm >= 1 ? 'text-emerald-400' : rm >= 0 ? 'text-zinc-300' : 'text-red-400'}`}>{fmt(rm, 2)}R</span></div>
                      </div>
                    );
                  })()}
                </div>
                <div className="flex gap-2 justify-end">
                  <button className="btn-ghost" onClick={() => setClosePos(null)}>Cancel</button>
                  <button className="btn-primary" onClick={handleClosePosition}><Check size={14} /> Close Position</button>
                </div>
              </div>
            </Modal>
          )}
        </div>
      )}

      {/* ── CLOSED TRADES ────────────────────────────────────────────────── */}
      {view === 'trades' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-base font-semibold">Closed Trades ({trades.length})</h2>
            <div className="flex gap-2 flex-wrap">
              <select className="select-base text-xs w-32" value={tradeFilter.setup} onChange={(e) => setTradeFilter({ ...tradeFilter, setup: e.target.value })}>
                <option value="">All Setups</option>{SETUP_TYPES.map((s) => <option key={s}>{s}</option>)}
              </select>
              <select className="select-base text-xs w-28" value={tradeFilter.outcome} onChange={(e) => setTradeFilter({ ...tradeFilter, outcome: e.target.value })}>
                <option value="">All</option><option value="WIN">Wins</option><option value="LOSS">Losses</option>
              </select>
              <select className="select-base text-xs w-36" value={tradeFilter.adherence} onChange={(e) => setTradeFilter({ ...tradeFilter, adherence: e.target.value })}>
                <option value="">All Adherence</option>{ADHERENCE.map((a) => <option key={a}>{a}</option>)}
              </select>
            </div>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400">
                  {[['#',''],['Wk','week_number'],['Ticker','ticker'],['Setup','setup_type'],['Entry','entry_date'],['Exit','exit_date'],['Days',''],['Entry $','entry_price'],['Exit $','exit_price'],['P&L $','pnl_usd'],['P&L %','pnl_pct'],['R','r_multiple'],['Reason','exit_reason'],['Adherence','plan_adherence']].map(([label, key]) => (
                    <th key={label} className={`th whitespace-nowrap ${key ? 'cursor-pointer hover:text-zinc-200' : ''}`}
                      onClick={() => key && sortTrades(key)}>
                      {label} {tradeSort.key === key ? (tradeSort.dir === 'asc' ? '↑' : '↓') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {filteredTrades.length === 0 && (
                  <tr><td colSpan={14} className="td text-center text-zinc-600 py-8">No closed trades yet.</td></tr>
                )}
                {filteredTrades.map((t, i) => {
                  const daysHeld = Math.floor((new Date(t.exit_date).getTime() - new Date(t.entry_date).getTime()) / 86_400_000);
                  const isWin = t.pnl_usd > 0;
                  return (
                    <tr key={t.id} className={`tr-hover ${isWin ? 'bg-emerald-950/20' : 'bg-red-950/20'}`}>
                      <td className="td text-zinc-600">{filteredTrades.length - i}</td>
                      <td className="td text-zinc-500">W{t.week_number}</td>
                      <td className="td font-mono font-bold text-blue-400">{t.ticker}</td>
                      <td className="td text-zinc-400">{t.setup_type}</td>
                      <td className="td text-zinc-500">{t.entry_date}</td>
                      <td className="td text-zinc-500">{t.exit_date}</td>
                      <td className="td tabular-nums">{daysHeld}</td>
                      <td className="td tabular-nums">{fmtCurrency(t.entry_price)}</td>
                      <td className="td tabular-nums">{fmtCurrency(t.exit_price)}</td>
                      <td className={`td tabular-nums font-bold ${isWin ? 'text-emerald-400' : 'text-red-400'}`}>
                        {t.pnl_usd >= 0 ? '+' : ''}{fmtCurrency(t.pnl_usd)}
                      </td>
                      <td className={`td tabular-nums ${isWin ? 'text-emerald-400' : 'text-red-400'}`}>
                        {fmtPct(t.pnl_pct)}
                      </td>
                      <td className={`td tabular-nums font-bold ${t.r_multiple >= 1 ? 'text-emerald-400' : t.r_multiple >= 0 ? 'text-zinc-300' : 'text-red-400'}`}>
                        {fmt(t.r_multiple, 2)}R
                      </td>
                      <td className="td text-zinc-400">{t.exit_reason}</td>
                      <td className="td">
                        <span className={`text-xs font-medium ${t.plan_adherence === 'Followed' ? 'text-emerald-400' : t.plan_adherence === 'Minor Deviation' ? 'text-amber-400' : 'text-red-400'}`}>
                          {t.plan_adherence === 'Followed' ? '✅' : t.plan_adherence === 'Minor Deviation' ? '⚠️' : '❌'} {t.plan_adherence}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── WEEKLY PLANS ─────────────────────────────────────────────────── */}
      {view === 'plans' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Week Plans ({plans.length})</h2>
            <button onClick={() => setAddPlanOpen(true)} className="btn-primary flex items-center gap-1.5 text-sm">
              <Plus size={14} /> Add Week Plan
            </button>
          </div>

          {plans.length === 0 && (
            <div className="card text-center py-12 text-zinc-600">No week plans yet. Paste in your Sunday plan each week.</div>
          )}

          {plans.map((plan) => {
            const weekTrades = trades.filter((t) => t.week_number === plan.week_number);
            const weekPnl = weekTrades.reduce((s, t) => s + t.pnl_usd, 0);
            const isExpanded = expandedPlan === plan.id;
            return (
              <div key={plan.id} className="card">
                <button className="w-full flex items-center justify-between text-left gap-2"
                  onClick={() => setExpandedPlan(isExpanded ? null : plan.id)}>
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-bold text-blue-400">W{plan.week_number}</span>
                    <span className="text-zinc-500 text-sm">{plan.date_received}</span>
                    <span className="text-zinc-400 text-xs">{weekTrades.length} trades</span>
                    {weekTrades.length > 0 && (
                      <span className={`text-xs font-semibold ${weekPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {weekPnl >= 0 ? '+' : ''}{fmtCurrency(weekPnl)}
                      </span>
                    )}
                  </div>
                  {isExpanded ? <ChevronUp size={16} className="text-zinc-500" /> : <ChevronDown size={16} className="text-zinc-500" />}
                </button>
                {isExpanded && (
                  <div className="mt-4 border-t border-zinc-800 pt-4">
                    <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono bg-zinc-800/40 rounded-lg p-3 max-h-96 overflow-y-auto">
                      {plan.plan_text}
                    </pre>
                    <button className="btn-danger mt-3 text-xs flex items-center gap-1"
                      onClick={() => { if (window.confirm('Delete this week plan?')) setPlans((p) => p.filter((x) => x.id !== plan.id)); }}>
                      <Trash2 size={11} /> Delete Plan
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {addPlanOpen && (
            <Modal onClose={() => setAddPlanOpen(false)}>
              <div className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold">Add Week Plan</h3>
                  <button onClick={() => setAddPlanOpen(false)}><X size={16} className="text-zinc-400" /></button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="label">Week #</label>
                    <select className="select-base" value={planForm.week_number} onChange={(e) => setPlanForm({ ...planForm, week_number: e.target.value })}>
                      {Array.from({ length: Math.ceil(settings.duration_days / 7) }, (_, i) => (
                        <option key={i + 1} value={i + 1}>W{i + 1}</option>
                      ))}
                    </select>
                  </div>
                  <div><label className="label">Date Received</label>
                    <input type="date" className="input-base" value={planForm.date_received}
                      onChange={(e) => setPlanForm({ ...planForm, date_received: e.target.value })} />
                  </div>
                </div>
                <div>
                  <label className="label">Plan Text (paste from Claude)</label>
                  <textarea className="input-base h-48 resize-none font-mono text-xs"
                    placeholder="Paste your Sunday week plan here..."
                    value={planForm.plan_text}
                    onChange={(e) => setPlanForm({ ...planForm, plan_text: e.target.value })} />
                </div>
                <div className="flex gap-2 justify-end">
                  <button className="btn-ghost" onClick={() => setAddPlanOpen(false)}>Cancel</button>
                  <button className="btn-primary" onClick={savePlan}><Check size={14} /> Save Plan</button>
                </div>
              </div>
            </Modal>
          )}
        </div>
      )}

      {/* ── ANALYTICS ────────────────────────────────────────────────────── */}
      {view === 'analytics' && (
        <div className="space-y-4">
          <h2 className="text-base font-semibold">Analytics</h2>
          {trades.length === 0 && <div className="card text-center py-12 text-zinc-600">No closed trades yet — analytics will appear here.</div>}

          {trades.length > 0 && (
            <>
              {/* By Setup Type */}
              <div className="card">
                <h3 className="text-sm font-semibold mb-3">Performance by Setup Type</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="border-b border-zinc-800 text-zinc-400">
                      {['Setup','Trades','Win Rate','Avg R','Total P&L'].map((h) => <th key={h} className="th">{h}</th>)}
                    </tr></thead>
                    <tbody className="divide-y divide-zinc-800/50">
                      {bySetup.map((d) => (
                        <tr key={d.name} className="tr-hover">
                          <td className="td font-medium">{d.name}</td>
                          <td className="td tabular-nums">{d.count}</td>
                          <td className={`td tabular-nums font-bold ${d.winRate >= 50 ? 'text-emerald-400' : 'text-red-400'}`}>{d.winRate}%</td>
                          <td className={`td tabular-nums font-bold ${d.avgR >= 1 ? 'text-emerald-400' : d.avgR >= 0 ? 'text-zinc-300' : 'text-red-400'}`}>{fmt(d.avgR, 2)}R</td>
                          <td className={`td tabular-nums font-bold ${d.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{d.pnl >= 0 ? '+' : ''}{fmtCurrency(d.pnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {bySetup.length > 0 && (
                  <ResponsiveContainer width="100%" height={160} className="mt-4">
                    <BarChart data={bySetup} barSize={28}>
                      <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }} labelStyle={{ color: '#fff' }} itemStyle={{ color: '#fff' }} />
                      <Bar dataKey="avgR" name="Avg R" radius={[4, 4, 0, 0]}>
                        {bySetup.map((d, i) => <Cell key={i} fill={d.avgR >= 1 ? '#34d399' : d.avgR >= 0 ? '#94a3b8' : '#f87171'} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>

              {/* Week P&L */}
              {byWeek.length > 0 && (
                <div className="card">
                  <h3 className="text-sm font-semibold mb-3">P&L by Week</h3>
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={byWeek} barSize={32}>
                      <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <Tooltip formatter={(v: number) => [fmtCurrency(v), 'P&L']} contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }} labelStyle={{ color: '#fff' }} itemStyle={{ color: '#fff' }} />
                      <ReferenceLine y={0} stroke="#3f3f46" />
                      <Bar dataKey="pnl" name="P&L" radius={[4, 4, 0, 0]}>
                        {byWeek.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? '#34d399' : '#f87171'} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Plan Adherence stats */}
              <div className="card">
                <h3 className="text-sm font-semibold mb-3">Plan Adherence vs Win Rate</h3>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  {ADHERENCE.map((a) => {
                    const subset = trades.filter((t) => t.plan_adherence === a);
                    const w = subset.filter((t) => t.pnl_usd > 0);
                    const wr = subset.length ? Math.round((w.length / subset.length) * 100) : null;
                    return (
                      <div key={a} className="bg-zinc-800/50 rounded-lg p-3 text-center">
                        <div className="text-zinc-500 mb-1">{a}</div>
                        <div className="text-lg font-bold">{subset.length}</div>
                        <div className={`text-sm font-semibold ${wr != null && wr >= 50 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {wr != null ? `${wr}% WR` : '—'}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── SETTINGS ─────────────────────────────────────────────────────── */}
      {view === 'settings' && (
        <div className="space-y-4 max-w-lg">
          <h2 className="text-base font-semibold">Sprint Settings</h2>
          <div className="card space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Starting Capital ($)</label>
                <input type="number" className="input-base" value={settingsForm.starting_capital}
                  onChange={(e) => setSettingsForm({ ...settingsForm, starting_capital: e.target.value })} /></div>
              <div><label className="label">Current Cash ($)</label>
                <input type="number" className="input-base" value={settingsForm.current_cash}
                  onChange={(e) => setSettingsForm({ ...settingsForm, current_cash: e.target.value })} />
                <p className="text-xs text-zinc-600 mt-0.5">Adjust for deposits/withdrawals</p>
              </div>
              <div><label className="label">Target Multiplier</label>
                <select className="select-base" value={settingsForm.target_multiplier}
                  onChange={(e) => setSettingsForm({ ...settingsForm, target_multiplier: e.target.value })}>
                  <option value="1.5">1.5×</option><option value="2.0">2.0×</option><option value="3.0">3.0×</option>
                </select></div>
              <div><label className="label">Duration (days)</label>
                <input type="number" className="input-base" value={settingsForm.duration_days}
                  onChange={(e) => setSettingsForm({ ...settingsForm, duration_days: e.target.value })} /></div>
              <div><label className="label">Sprint Start Date</label>
                <input type="date" className="input-base" value={settingsForm.sprint_start_date}
                  onChange={(e) => setSettingsForm({ ...settingsForm, sprint_start_date: e.target.value })} /></div>
              <div><label className="label">Drawdown Halt %</label>
                <input type="number" className="input-base" value={settingsForm.drawdown_halt_pct}
                  onChange={(e) => setSettingsForm({ ...settingsForm, drawdown_halt_pct: e.target.value })} /></div>
              <div><label className="label">De-Risk Milestone %</label>
                <input type="number" className="input-base" value={settingsForm.derisk_milestone_pct}
                  onChange={(e) => setSettingsForm({ ...settingsForm, derisk_milestone_pct: e.target.value })} /></div>
              <div><label className="label">Stop Loss % (per trade)</label>
                <input type="number" className="input-base" value={settingsForm.stop_loss_pct}
                  onChange={(e) => setSettingsForm({ ...settingsForm, stop_loss_pct: e.target.value })} /></div>
            </div>
            <div className="flex gap-2 pt-2">
              <button className="btn-primary" onClick={saveSettings}><Check size={14} /> Save Settings</button>
              <button className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-red-900 text-red-500 hover:bg-red-950/40 transition-colors"
                onClick={resetSprint}>
                <Trash2 size={12} /> Reset Sprint
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
