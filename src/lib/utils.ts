import type { Verdict } from '../types';

export function calcWeightedScore(
  technical: number,
  fundamental: number,
  risk: number,
  sentiment: number
): number {
  return +(technical * 0.35 + fundamental * 0.3 + risk * 0.25 + sentiment * 0.1).toFixed(2);
}

export function getVerdict(score: number): Verdict {
  if (score >= 7.5) return 'GO';
  if (score >= 6) return 'CONDITIONAL';
  return 'NO GO';
}

export function verdictColor(verdict: Verdict): string {
  return verdict === 'GO'
    ? 'text-emerald-400'
    : verdict === 'CONDITIONAL'
    ? 'text-amber-400'
    : 'text-red-400';
}

export function verdictBg(verdict: Verdict): string {
  return verdict === 'GO'
    ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-700'
    : verdict === 'CONDITIONAL'
    ? 'bg-amber-900/40 text-amber-300 border border-amber-700'
    : 'bg-red-900/40 text-red-300 border border-red-700';
}

export function changeColor(pct: number): string {
  return pct > 0 ? 'text-emerald-400' : pct < 0 ? 'text-red-400' : 'text-zinc-400';
}

export function fmt(n: number | null | undefined, decimals = 2): string {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtCurrency(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

export function calcRR(entry: number, stop: number, target: number): number {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (risk === 0) return 0;
  return +(reward / risk).toFixed(2);
}
