// ─────────────────────────────────────────────────────────────────────────────
// Account value snapshot.
//
// The Portfolio tab already computes market value per account in CAD. It
// publishes that here so other tabs (Scorecard position sizing) can size trades
// against real account balances instead of a manually typed number, without
// re-fetching every quote.
//
// This is a cache, not a source of truth: it is written only by Portfolio, and
// readers must handle a missing or stale snapshot rather than assuming a value.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'swing_account_snapshot';
const MAX_AGE = 24 * 60 * 60 * 1000; // a day — beyond that, prompt for a refresh

export interface AccountSnapshot {
  at: number;
  totalCAD: number;
  byAccount: Record<string, number>;
}

export function publishAccountSnapshot(byAccount: Record<string, number>): void {
  const totalCAD = Object.values(byAccount).reduce((s, v) => s + v, 0);
  if (!isFinite(totalCAD) || totalCAD <= 0) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), totalCAD, byAccount } satisfies AccountSnapshot));
  } catch { /* quota — sizing simply falls back to the manual figure */ }
}

export function readAccountSnapshot(): AccountSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as AccountSnapshot;
    if (typeof s?.totalCAD !== 'number' || !isFinite(s.totalCAD) || s.totalCAD <= 0) return null;
    return s;
  } catch { return null; }
}

export function snapshotIsStale(s: AccountSnapshot | null): boolean {
  return s == null || Date.now() - s.at > MAX_AGE;
}

export function snapshotAgeLabel(s: AccountSnapshot): string {
  const mins = Math.floor((Date.now() - s.at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
