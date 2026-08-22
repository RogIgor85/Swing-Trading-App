// Tiny cross-tab navigation bus. The app has no router — App.tsx owns an
// activeTab state — so tabs communicate via a CustomEvent plus a pending
// payload in sessionStorage that the target tab consumes on mount.

export type AppTab = 'scorecard' | 'watchlist' | 'technical' | 'sectors' | 'portfolio' | 'review' | 'journal' | 'sprint' | 'networth';

const PENDING_SECTOR_KEY = 'swing_pending_sector';
const PENDING_CHART_KEY  = 'swing_pending_chart_ticker';

export function navigateTo(tab: AppTab, payload?: { sector?: string; ticker?: string }): void {
  try {
    if (payload?.sector) sessionStorage.setItem(PENDING_SECTOR_KEY, payload.sector);
    if (payload?.ticker) sessionStorage.setItem(PENDING_CHART_KEY, payload.ticker);
  } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent('swing:navigate', { detail: { tab } }));
}

export function consumePendingSector(): string | null {
  try {
    const v = sessionStorage.getItem(PENDING_SECTOR_KEY);
    if (v) sessionStorage.removeItem(PENDING_SECTOR_KEY);
    return v;
  } catch { return null; }
}

export function consumePendingChartTicker(): string | null {
  try {
    const v = sessionStorage.getItem(PENDING_CHART_KEY);
    if (v) sessionStorage.removeItem(PENDING_CHART_KEY);
    return v;
  } catch { return null; }
}
