// ─────────────────────────────────────────────────────────────────────────────
// Plain-English explanations for Rotation / Sector Pressure.
// Shared by Sector Rotation and Watch List so the metric is defined the same
// way everywhere it appears.
// ─────────────────────────────────────────────────────────────────────────────

import { PRESSURE_TREND_THRESHOLDS } from '../../config/sectorConfig';

/** Static definition — used in ⓘ tooltips beside the metric label. */
export const PRESSURE_HELP =
`Sector Pressure
Estimates whether market participation appears to be rotating into or out of a sector using relative strength, momentum, breadth, volume and trend.

Scale:
+100 = very strong rotation-in signal
 +50 = strong positive rotation
   0 = neutral
 −50 = strong negative rotation
−100 = very strong rotation-out signal

Positive numbers suggest strengthening participation.
Negative numbers suggest weakening participation.
This is not literal dollar fund flow.`;

/** Explanation of the trend arrow shown beside a pressure value. */
export const PRESSURE_ARROW_HELP =
`↑ = pressure is improving
→ = pressure is relatively stable
↓ = pressure is deteriorating`;

/** Short band label for a pressure value, e.g. "Moderately positive rotation". */
export function pressureBand(p: number): string {
  if (p >= 75)  return 'Very strong positive rotation';
  if (p >= 50)  return 'Strong positive rotation';
  if (p >= 22)  return 'Moderately positive rotation';
  if (p > 5)    return 'Slightly positive rotation';
  if (p >= -5)  return 'Neutral rotation';
  if (p > -22)  return 'Slightly negative rotation';
  if (p > -50)  return 'Moderately negative rotation';
  if (p > -75)  return 'Strong negative rotation';
  return 'Very strong negative rotation';
}

/** One-sentence reading of what a pressure value means for participation. */
export function pressureSentence(p: number): string {
  if (p >= 22)  return 'Participation currently favors this sector.';
  if (p > 5)    return 'Participation leans slightly toward this sector.';
  if (p >= -5)  return 'Participation shows no clear direction for this sector.';
  if (p > -22)  return 'Participation is leaning slightly away from this sector.';
  return 'Participation is currently moving away from this sector.';
}

export function arrowFor(delta5: number | null | undefined): '↑' | '→' | '↓' {
  if (delta5 == null) return '→';
  if (delta5 > PRESSURE_TREND_THRESHOLDS.up) return '↑';
  if (delta5 < PRESSURE_TREND_THRESHOLDS.down) return '↓';
  return '→';
}

function trendClause(delta5: number | null | undefined): string {
  if (delta5 == null) return '';
  if (delta5 > PRESSURE_TREND_THRESHOLDS.up) return ' The signal is improving.';
  if (delta5 < PRESSURE_TREND_THRESHOLDS.down) return ' The signal is deteriorating.';
  return ' The signal is relatively stable.';
}

/**
 * Contextual tooltip for a specific pressure value, e.g.
 *   Sector Pressure: +27 ↑
 *   Moderately positive rotation. Participation currently favors this sector.
 *   The signal is improving.
 */
export function describePressure(
  pressure: number,
  delta5: number | null | undefined,
  label = 'Sector Pressure',
): string {
  const sign = pressure >= 0 ? '+' : '';
  const arrow = arrowFor(delta5);
  const deltaLine = delta5 != null
    ? `\nChange over 5 trading days: ${delta5 >= 0 ? '+' : ''}${delta5}`
    : '';
  return (
    `${label}: ${sign}${pressure} ${arrow}\n` +
    `${pressureBand(pressure)}. ${pressureSentence(pressure)}${trendClause(delta5)}` +
    deltaLine +
    `\n\n${PRESSURE_ARROW_HELP}\n\nScale runs −100 (strong rotation out) to +100 (strong rotation in). Not literal dollar fund flow.`
  );
}
