// Manual review flags. EXIT is only ever produced by an explicit marker here —
// never inferred from a drawdown. Stored per ticker in localStorage so the
// holdings schema is untouched.

const KEY = 'swing_review_flags';

export interface ReviewFlags { thesis_broken?: boolean; note?: string }

type FlagMap = Record<string, ReviewFlags>;

function readAll(): FlagMap {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as FlagMap; } catch { return {}; }
}
function writeAll(m: FlagMap) {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* quota */ }
}

export function loadReviewFlags(): FlagMap { return readAll(); }

export function setThesisBroken(ticker: string, broken: boolean): FlagMap {
  const all = readAll();
  const t = ticker.toUpperCase();
  if (broken) all[t] = { ...all[t], thesis_broken: true };
  else { delete all[t]; }
  writeAll(all);
  return all;
}
