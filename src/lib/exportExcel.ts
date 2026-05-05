import * as XLSX from 'xlsx';
import { storage } from './storage';
import type {
  ScorecardEntry,
  WatchItem,
  TechnicalSetup,
  Holding,
  FundamentalNote,
  TradeJournalEntry,
} from '../types';

// ── helpers ────────────────────────────────────────────────────────────────

function colWidths(data: Record<string, unknown>[], keys: string[]) {
  return keys.map((k) => ({
    wch: Math.max(
      k.length,
      ...data.map((r) => String(r[k] ?? '').length)
    ) + 2,
  }));
}

function makeSheet<T extends Record<string, unknown>>(
  rows: T[],
  colMap: { key: keyof T; label: string }[]
) {
  const header = colMap.map((c) => c.label);
  const body   = rows.map((r) => colMap.map((c) => r[c.key] ?? ''));
  const ws     = XLSX.utils.aoa_to_sheet([header, ...body]);
  ws['!cols']  = header.map((h, i) => ({
    wch: Math.max(h.length, ...body.map((r) => String(r[i]).length)) + 2,
  }));
  return ws;
}

// ── column maps ────────────────────────────────────────────────────────────

const SCORECARD_COLS: { key: keyof ScorecardEntry; label: string }[] = [
  { key: 'trade_date',           label: 'Date'           },
  { key: 'ticker',               label: 'Ticker'         },
  { key: 'company_name',         label: 'Company'        },
  { key: 'technical_score',      label: 'Technical'      },
  { key: 'fundamental_score',    label: 'Fundamental'    },
  { key: 'risk_liquidity_score', label: 'Risk/Liquidity' },
  { key: 'sentiment_score',      label: 'Sentiment'      },
  { key: 'weighted_score',       label: 'Weighted Score' },
  { key: 'verdict',              label: 'Verdict'        },
  { key: 'notes',                label: 'Notes'          },
];

const WATCHLIST_COLS: { key: keyof WatchItem; label: string }[] = [
  { key: 'watch_date',     label: 'Date'            },
  { key: 'ticker',         label: 'Ticker'          },
  { key: 'conviction',     label: 'Conviction'      },
  { key: 'watch_price',    label: 'Watch Price'     },
  { key: 'target_entry',   label: 'Target Entry'    },
  { key: 'analyst_target', label: 'Analyst Target'  },
  { key: 'notes',          label: 'Notes'           },
];

const TECHNICAL_COLS: { key: keyof TechnicalSetup; label: string }[] = [
  { key: 'created_at',        label: 'Date'           },
  { key: 'ticker',            label: 'Ticker'         },
  { key: 'trend_daily',       label: 'Daily Trend'    },
  { key: 'trend_weekly',      label: 'Weekly Trend'   },
  { key: 'trend_monthly',     label: 'Monthly Trend'  },
  { key: 'ma_50',             label: 'MA 50'          },
  { key: 'ma_200',            label: 'MA 200'         },
  { key: 'rsi',               label: 'RSI'            },
  { key: 'entry_price',       label: 'Entry Price'    },
  { key: 'stop_loss',         label: 'Stop Loss'      },
  { key: 'target',            label: 'Target'         },
  { key: 'rr_ratio',          label: 'R/R Ratio'      },
  { key: 'confidence',        label: 'Confidence'     },
  { key: 'chart_pattern',     label: 'Chart Pattern'  },
  { key: 'support_levels',    label: 'Support'        },
  { key: 'resistance_levels', label: 'Resistance'     },
  { key: 'macd',              label: 'MACD'           },
  { key: 'notes',             label: 'Notes'          },
];

const HOLDINGS_COLS: { key: keyof Holding; label: string }[] = [
  { key: 'ticker',         label: 'Ticker'         },
  { key: 'shares',         label: 'Shares'         },
  { key: 'avg_cost',       label: 'Avg Cost'       },
  { key: 'sector',         label: 'Sector'         },
  { key: 'account',        label: 'Account'        },
  { key: 'currency',       label: 'Currency'       },
  { key: 'liquidity_risk', label: 'Liquidity Risk' },
  { key: 'notes',          label: 'Notes'          },
];

const JOURNAL_COLS: { key: keyof TradeJournalEntry; label: string }[] = [
  { key: 'sr_no',              label: '#'              },
  { key: 'date_of_buy',        label: 'Date of Buy'    },
  { key: 'account',            label: 'Account'        },
  { key: 'ticker',             label: 'Ticker'         },
  { key: 'company',            label: 'Company'        },
  { key: 'industry',           label: 'Industry'       },
  { key: 'period',             label: 'Period'         },
  { key: 'currency',           label: 'Currency'       },
  { key: 'qty',                label: 'Qty'            },
  { key: 'entry_price',        label: 'Entry Price'    },
  { key: 'stop_loss',          label: 'Stop Loss'      },
  { key: 'position_size',      label: 'Position Size'  },
  { key: 'date_of_sale',       label: 'Date of Sale'   },
  { key: 'exit_qty',           label: 'Exit Qty'       },
  { key: 'exit_price',         label: 'Exit Price'     },
  { key: 'net_qty',            label: 'Net Qty'        },
  { key: 'avg_exit_price',     label: 'Avg Exit Price' },
  { key: 'realized_pnl',       label: 'Realized P&L'  },
  { key: 'realized_pnl_pct',   label: 'P&L %'         },
  { key: 'win_loss',           label: 'Win/Loss'       },
  { key: 'status',             label: 'Status'         },
  { key: 'notes',              label: 'Notes'          },
];

const FUNDAMENTALS_COLS: { key: keyof FundamentalNote; label: string }[] = [
  { key: 'ticker',     label: 'Ticker'     },
  { key: 'bull_case',  label: 'Bull Case'  },
  { key: 'bear_case',  label: 'Bear Case'  },
  { key: 'notes',      label: 'Notes'      },
];

// ── net worth ──────────────────────────────────────────────────────────────

interface NwRow { id: string; category: string; description: string; value: number; debt: number }
interface NwStore {
  realProperty: NwRow[];
  vehicles:     NwRow[];
  bankAccounts: NwRow[];
  otherAssets:  NwRow[];
  liabilities:  NwRow[];
}

const NW_COLS = [
  { key: 'section'     as const, label: 'Section'     },
  { key: 'category'    as const, label: 'Category'    },
  { key: 'description' as const, label: 'Description' },
  { key: 'value'       as const, label: 'Value (CAD)' },
  { key: 'debt'        as const, label: 'Debt (CAD)'  },
];

function flattenNetWorth(): Record<string, unknown>[] {
  try {
    const raw = localStorage.getItem('swing_networth_v1');
    if (!raw) return [];
    const store: NwStore = JSON.parse(raw);
    const sections: [string, NwRow[]][] = [
      ['Real Property', store.realProperty ?? []],
      ['Vehicles',      store.vehicles      ?? []],
      ['Bank Accounts', store.bankAccounts  ?? []],
      ['Other Assets',  store.otherAssets   ?? []],
      ['Liabilities',   store.liabilities   ?? []],
    ];
    return sections.flatMap(([section, rows]) =>
      rows.map((r) => ({ section, category: r.category, description: r.description, value: r.value, debt: r.debt }))
    );
  } catch {
    return [];
  }
}

// ── main export ────────────────────────────────────────────────────────────

export async function exportAllToExcel() {
  const [scorecard, watchItems, technical, holdings, journal, fundamentals] = await Promise.all([
    storage.getAll<ScorecardEntry>('scorecard'),
    storage.getAll<WatchItem>('watch_items'),
    storage.getAll<TechnicalSetup>('technical_setups'),
    storage.getAll<Holding>('holdings'),
    storage.getAll<TradeJournalEntry>('trade_journal'),
    storage.getAll<FundamentalNote>('fundamentals'),
  ]);

  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, makeSheet(scorecard as unknown as Record<string, unknown>[], SCORECARD_COLS as { key: string; label: string }[]),    'Scorecard');
  XLSX.utils.book_append_sheet(wb, makeSheet(watchItems as unknown as Record<string, unknown>[], WATCHLIST_COLS as { key: string; label: string }[]),   'Watch List');
  XLSX.utils.book_append_sheet(wb, makeSheet(technical  as unknown as Record<string, unknown>[], TECHNICAL_COLS as { key: string; label: string }[]),   'Chart Analysis');
  XLSX.utils.book_append_sheet(wb, makeSheet(holdings   as unknown as Record<string, unknown>[], HOLDINGS_COLS as { key: string; label: string }[]),    'Portfolio');
  XLSX.utils.book_append_sheet(wb, makeSheet(journal    as unknown as Record<string, unknown>[], JOURNAL_COLS as { key: string; label: string }[]),      'Trade Journal');
  XLSX.utils.book_append_sheet(wb, makeSheet(fundamentals as unknown as Record<string, unknown>[], FUNDAMENTALS_COLS as { key: string; label: string }[]), 'Fundamentals');

  // Net Worth
  const nwRows = flattenNetWorth();
  XLSX.utils.book_append_sheet(wb, makeSheet(nwRows, NW_COLS as { key: string; label: string }[]), 'Net Worth');

  // Download
  const date = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `trading-dashboard-${date}.xlsx`);
}
