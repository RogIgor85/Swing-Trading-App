import ExcelJS from 'exceljs';
import { storage } from './storage';
import type { WatchItem, Holding } from '../types';

// ── ARGB colour palette ───────────────────────────────────────────────────────
const NAVY    = 'FF1F3864';
const WHITE   = 'FFFFFFFF';
const BLUE    = 'FF2E75B6';
const SUBTOT  = 'FFDCE6F1';
const TOTAL   = 'FF1F4E3D';
const G_FILL  = 'FFC6EFCE';
const G_FONT  = 'FF375623';
const R_FILL  = 'FFFFC7CE';
const R_FONT  = 'FF9C0006';
const A_FILL  = 'FFFFEB9C';
const A_FONT  = 'FF9C5700';
const MONEY   = '#,##0;(#,##0);"-"';
const USD_CAD = 1.38;

// ── cell helpers ──────────────────────────────────────────────────────────────
function border(cell: ExcelJS.Cell, color = 'FFD0D0D0') {
  const s = { style: 'thin' as ExcelJS.BorderStyle, color: { argb: color } };
  cell.border = { top: s, bottom: s, left: s, right: s };
}

function colHeader(cell: ExcelJS.Cell, label: string) {
  cell.value = label;
  cell.font  = { bold: true, color: { argb: WHITE }, name: 'Arial', size: 10 };
  cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  border(cell, 'FF3A5998');
}

function subtotStyle(cell: ExcelJS.Cell) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUBTOT } };
  cell.font = { bold: true, name: 'Arial', size: 10 };
  cell.numFmt = MONEY;
}

function totalStyle(cell: ExcelJS.Cell) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL } };
  cell.font = { bold: true, color: { argb: WHITE }, name: 'Arial', size: 11 };
  cell.numFmt = MONEY;
}

// ── shared types ──────────────────────────────────────────────────────────────
interface NwRow { id: string; category: string; description: string; value: number; debt: number }

// ── Net Worth sheet ───────────────────────────────────────────────────────────
async function buildNetWorthSheet(wb: ExcelJS.Workbook) {
  const ws = wb.addWorksheet('Net Worth');
  ws.columns = [
    { width: 28 }, // A – Category
    { width: 38 }, // B – Description
    { width: 22 }, // C – Current Value
    { width: 22 }, // D – Outstanding Debt
    { width: 22 }, // E – Net Equity
  ];

  // ── load data ──────────────────────────────────────────────────────────────
  type NwStore = { realProperty: NwRow[]; vehicles: NwRow[]; bankAccounts: NwRow[]; otherAssets: NwRow[]; liabilities: NwRow[] };
  let nw: NwStore;
  try {
    nw = JSON.parse(localStorage.getItem('swing_networth_v1') ?? 'null')
      ?? { realProperty: [], vehicles: [], bankAccounts: [], otherAssets: [], liabilities: [] };
  } catch {
    nw = { realProperty: [], vehicles: [], bankAccounts: [], otherAssets: [], liabilities: [] };
  }

  const holdings = await storage.getAll<Holding>('holdings');
  const manualPrices: Record<string, number> = (() => {
    try { return JSON.parse(localStorage.getItem('swing_manual_prices') ?? '{}'); } catch { return {}; }
  })();

  const acctVal: Record<string, number> = {};
  holdings.forEach(h => {
    const p = manualPrices[h.ticker] ?? h.avg_cost;
    const v = h.shares * p * (h.currency === 'USD' ? USD_CAD : 1);
    acctVal[h.account] = (acctVal[h.account] ?? 0) + v;
  });

  const ACCT_DESC: Record<string, string> = {
    RRSP: 'Registered Retirement Savings Plan', TSFA: 'Tax-Free Savings Account',
    LIRA: 'Locked-In Retirement Account',       Brokerage: 'Investment Account',
    Crypto: 'Crypto & Digital Assets',          HSA: 'Health Savings Account',
    Other: 'Other Investments',
  };
  const regRows:    NwRow[] = ['RRSP','TSFA','LIRA'].filter(a => acctVal[a])
    .map(a => ({ id:'', category: a, description: ACCT_DESC[a], value: Math.round(acctVal[a]), debt: 0 }));
  const nonRegRows: NwRow[] = ['Brokerage','Crypto','HSA','Other'].filter(a => acctVal[a])
    .map(a => ({ id:'', category: a, description: ACCT_DESC[a], value: Math.round(acctVal[a]), debt: 0 }));

  // ── row cursor & subtotal tracker ──────────────────────────────────────────
  const r = { n: 1 };
  const subtotalRows: number[] = [];

  // ── Title ──────────────────────────────────────────────────────────────────
  ws.mergeCells('A1:E1');
  const titleC = ws.getCell('A1');
  titleC.value = '(insert name)  ASSETS';
  titleC.font  = { bold: true, size: 16, color: { argb: WHITE }, name: 'Arial' };
  titleC.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  titleC.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 32;
  r.n = 2;

  // ── Subtitle ───────────────────────────────────────────────────────────────
  ws.mergeCells('A2:E2');
  const sub = ws.getCell('A2');
  sub.value = `Prenuptial Agreement — Asset Disclosure as of ${new Date().toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric' })}`;
  sub.font  = { italic: true, size: 10, name: 'Arial' };
  sub.alignment = { horizontal: 'center' };
  r.n = 4; // skip row 3

  // ── section helper ─────────────────────────────────────────────────────────
  function addSection(num: number, title: string, subtotalLabel: string, rows: NwRow[]) {
    // section header bar
    ws.mergeCells(`A${r.n}:E${r.n}`);
    const sh = ws.getCell(`A${r.n}`);
    sh.value = `${num}. ${title}`;
    sh.font  = { bold: true, size: 11, color: { argb: WHITE }, name: 'Arial' };
    sh.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    sh.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    ws.getRow(r.n).height = 20;
    r.n++;

    // column headers
    ['Category', 'Description', 'Current Value ($)', 'Outstanding Debt ($)', 'Net Equity ($)']
      .forEach((h, i) => colHeader(ws.getCell(r.n, i + 1), h));
    ws.getRow(r.n).height = 30;
    r.n++;

    const dataStart = r.n;

    if (rows.length === 0) {
      ws.getRow(r.n).height = 16;
      r.n++; // one blank placeholder row
    } else {
      for (const row of rows) {
        ws.getCell(`A${r.n}`).value = row.category;
        ws.getCell(`A${r.n}`).font  = { color: { argb: BLUE }, name: 'Arial', size: 10 };
        ws.getCell(`B${r.n}`).value = row.description;
        ws.getCell(`B${r.n}`).font  = { color: { argb: BLUE }, name: 'Arial', size: 10 };

        if (row.value > 0) {
          ws.getCell(`C${r.n}`).value  = row.value;
          ws.getCell(`C${r.n}`).numFmt = MONEY;
        }
        if (row.debt > 0) {
          ws.getCell(`D${r.n}`).value  = row.debt;
          ws.getCell(`D${r.n}`).numFmt = MONEY;
        }
        ws.getCell(`E${r.n}`).value  = { formula: `IFERROR(C${r.n},0)-IFERROR(D${r.n},0)` };
        ws.getCell(`E${r.n}`).numFmt = MONEY;
        ws.getCell(`E${r.n}`).font   = { name: 'Arial', size: 10 };

        ws.getRow(r.n).height = 16;
        r.n++;
      }
    }

    const dataEnd = r.n - 1;

    // subtotal row
    ws.mergeCells(`A${r.n}:B${r.n}`);
    const stA = ws.getCell(`A${r.n}`);
    stA.value = subtotalLabel;
    subtotStyle(stA);
    stA.numFmt = '@';
    stA.alignment = { horizontal: 'left', indent: 1 };

    (['C', 'D', 'E'] as const).forEach(col => {
      const c = ws.getCell(`${col}${r.n}`);
      c.value = { formula: `SUM(${col}${dataStart}:${col}${dataEnd})` };
      subtotStyle(c);
    });

    subtotalRows.push(r.n);
    ws.getRow(r.n).height = 16;
    r.n += 2; // subtotal + blank gap
  }

  // ── add all 7 sections ─────────────────────────────────────────────────────
  addSection(1, 'REAL PROPERTY',                          'Real Property Subtotal',       nw.realProperty);
  addSection(2, 'VEHICLES',                               'Vehicles Subtotal',             nw.vehicles);
  addSection(3, 'REGISTERED INVESTMENT ACCOUNTS',         'Registered Accounts Subtotal', regRows);
  addSection(4, 'NON-REGISTERED INVESTMENTS & BROKERAGE', 'Investments Subtotal',         nonRegRows);
  addSection(5, 'BANK ACCOUNTS',                         'Bank Accounts Subtotal',        nw.bankAccounts);
  addSection(6, 'OTHER ASSETS',                          'Other Assets Subtotal',         nw.otherAssets);
  addSection(7, 'OTHER LIABILITIES',                     'Liabilities Subtotal',          nw.liabilities);

  // ── TOTAL NET WORTH ────────────────────────────────────────────────────────
  r.n++;
  ws.mergeCells(`A${r.n}:B${r.n}`);
  const tnwA = ws.getCell(`A${r.n}`);
  tnwA.value = 'TOTAL NET WORTH';
  tnwA.font  = { bold: true, size: 12, color: { argb: WHITE }, name: 'Arial' };
  tnwA.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL } };
  tnwA.alignment = { horizontal: 'center', vertical: 'middle' };

  const mkSum = (col: string) => subtotalRows.map(n => `${col}${n}`).join('+');
  (['C', 'D', 'E'] as const).forEach(col => {
    const c = ws.getCell(`${col}${r.n}`);
    c.value = { formula: mkSum(col) };
    totalStyle(c);
  });
  ws.getCell(`E${r.n}`).font = { bold: true, size: 13, color: { argb: WHITE }, name: 'Arial' };
  ws.getRow(r.n).height = 28;
}

// ── Portfolio sheet ───────────────────────────────────────────────────────────
async function buildPortfolioSheet(wb: ExcelJS.Workbook) {
  const ws = wb.addWorksheet('Portfolio');
  ws.columns = [
    { width: 10 }, // Ticker
    { width: 20 }, // Account
    { width: 12 }, // Currency
    { width: 10 }, // Shares
    { width: 14 }, // Avg Cost
    { width: 14 }, // Manual Price
    { width: 16 }, // Market Value (CAD)
    { width: 16 }, // Cost Basis (CAD)
    { width: 16 }, // Unrealized P&L
    { width: 14 }, // Sector
    { width: 14 }, // Liquidity Risk
    { width: 30 }, // Notes
  ];

  // Title
  ws.mergeCells('A1:L1');
  const t = ws.getCell('A1');
  t.value = 'PORTFOLIO HOLDINGS';
  t.font  = { bold: true, size: 14, color: { argb: WHITE }, name: 'Arial' };
  t.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  t.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  // Column headers
  const headers = [
    'Ticker', 'Account', 'Currency', 'Shares', 'Avg Cost ($)',
    'Manual Price ($)', 'Market Value (CAD)', 'Cost Basis (CAD)',
    'Unrealized P&L', 'Sector', 'Liquidity Risk', 'Notes',
  ];
  headers.forEach((h, i) => colHeader(ws.getCell(2, i + 1), h));
  ws.getRow(2).height = 28;

  const holdings = await storage.getAll<Holding>('holdings');
  const manualPrices: Record<string, number> = (() => {
    try { return JSON.parse(localStorage.getItem('swing_manual_prices') ?? '{}'); } catch { return {}; }
  })();

  // Sort by account then ticker
  const sorted = [...holdings].sort((a, b) => a.account.localeCompare(b.account) || a.ticker.localeCompare(b.ticker));

  sorted.forEach((h, idx) => {
    const row = idx + 3;
    const alt  = idx % 2 === 1;
    const bg   = alt ? 'FFF2F2F2' : 'FFFFFFFF';
    const manP = manualPrices[h.ticker] ?? null;
    const usedP = manP ?? h.avg_cost;
    const mktCAD  = h.shares * usedP * (h.currency === 'USD' ? USD_CAD : 1);
    const costCAD = h.shares * h.avg_cost * (h.currency === 'USD' ? USD_CAD : 1);
    const pnl     = mktCAD - costCAD;

    const vals: (string | number | null)[] = [
      h.ticker, h.account, h.currency, h.shares,
      h.avg_cost, manP, Math.round(mktCAD), Math.round(costCAD), Math.round(pnl),
      h.sector, h.liquidity_risk, h.notes,
    ];

    vals.forEach((v, i) => {
      const cell = ws.getCell(row, i + 1);
      cell.value = v;
      cell.font  = { name: 'Arial', size: 10 };
      cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      if (i >= 4 && i <= 8) cell.numFmt = MONEY;
    });

    // Colour P&L cell
    const pnlCell = ws.getCell(row, 9);
    pnlCell.font = { name: 'Arial', size: 10, color: { argb: pnl >= 0 ? G_FONT : R_FONT } };
    pnlCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pnl >= 0 ? G_FILL : R_FILL } };

    ws.getRow(row).height = 16;
  });

  // Totals row
  if (sorted.length > 0) {
    const tRow = sorted.length + 3;
    ws.mergeCells(`A${tRow}:F${tRow}`);
    const tA = ws.getCell(`A${tRow}`);
    tA.value = 'TOTAL';
    totalStyle(tA);
    tA.numFmt = '@';
    tA.alignment = { horizontal: 'center' };

    [7, 8, 9].forEach(col => {
      const c = ws.getCell(tRow, col);
      c.value = { formula: `SUM(${String.fromCharCode(64 + col)}3:${String.fromCharCode(64 + col)}${tRow - 1})` };
      totalStyle(c);
    });
    ws.getRow(tRow).height = 20;
  }
}

// ── Watch List sheet ──────────────────────────────────────────────────────────
function buildWatchListSheet(wb: ExcelJS.Workbook, items: WatchItem[]) {
  const ws = wb.addWorksheet('Watch List');
  ws.columns = [
    { width: 10 }, // Ticker
    { width: 14 }, // Conviction / Signal
    { width: 14 }, // Watch Date
    { width: 14 }, // Watch Price
    { width: 14 }, // Target Entry
    { width: 14 }, // Analyst Target
    { width: 40 }, // Notes
  ];

  // Title
  ws.mergeCells('A1:G1');
  const t = ws.getCell('A1');
  t.value = 'WATCH LIST';
  t.font  = { bold: true, size: 14, color: { argb: WHITE }, name: 'Arial' };
  t.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  t.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  // Column headers
  ['Ticker', 'Signal', 'Watch Date', 'Watch Price ($)', 'Target Entry ($)', 'Analyst Target ($)', 'Notes']
    .forEach((h, i) => colHeader(ws.getCell(2, i + 1), h));
  ws.getRow(2).height = 28;

  // Conviction → colour
  const CONV: Record<string, { fill: string; font: string; label: string }> = {
    HIGH:   { fill: G_FILL, font: G_FONT, label: '🟢  BUY'  },
    MEDIUM: { fill: A_FILL, font: A_FONT, label: '🟡  WATCH' },
    LOW:    { fill: R_FILL, font: R_FONT, label: '🔴  WAIT'  },
  };

  items.forEach((item, idx) => {
    const row = idx + 3;
    const cv  = CONV[item.conviction] ?? CONV.MEDIUM;

    const vals = [
      item.ticker,
      cv.label,
      item.watch_date,
      item.watch_price,
      item.target_entry,
      item.analyst_target,
      item.notes,
    ];

    vals.forEach((v, i) => {
      const cell = ws.getCell(row, i + 1);
      cell.value = v ?? null;
      cell.font  = { name: 'Arial', size: 10, bold: i === 1 };
      cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: cv.fill } };
      cell.font  = { name: 'Arial', size: 10, bold: i === 1, color: { argb: i <= 1 ? cv.font : '00000000' } };
      if (i >= 3 && i <= 5) cell.numFmt = MONEY;
    });

    ws.getRow(row).height = 16;
  });
}

// ── main entry ────────────────────────────────────────────────────────────────
export async function exportAllToExcel() {
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'Trading Dashboard';
  wb.created  = new Date();
  wb.modified = new Date();

  await buildNetWorthSheet(wb);
  await buildPortfolioSheet(wb);
  buildWatchListSheet(wb, await storage.getAll<WatchItem>('watch_items'));

  const buffer = await wb.xlsx.writeBuffer();
  const blob   = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href    = url;
  a.download = `trading-dashboard-${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
