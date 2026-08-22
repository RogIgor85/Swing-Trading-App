import { describe, it, expect } from 'vitest';
import { PRESSURE_HELP, pressureBand, pressureSentence, arrowFor, describePressure } from './pressureHelp';

describe('pressureBand', () => {
  it('labels the documented scale points', () => {
    expect(pressureBand(100)).toContain('Very strong positive');
    expect(pressureBand(52)).toContain('Strong positive');
    expect(pressureBand(27)).toContain('Moderately positive');
    expect(pressureBand(0)).toContain('Neutral');
    expect(pressureBand(-17)).toContain('Slightly negative');
    expect(pressureBand(-64)).toContain('Strong negative');
    expect(pressureBand(-100)).toContain('Very strong negative');
  });
});

describe('arrowFor', () => {
  it('maps 5-day change to the trend arrow', () => {
    expect(arrowFor(25)).toBe('↑');
    expect(arrowFor(0)).toBe('→');
    expect(arrowFor(-25)).toBe('↓');
    expect(arrowFor(null)).toBe('→');
  });
});

describe('describePressure', () => {
  it('renders the example from the spec', () => {
    const t = describePressure(27, 12);
    expect(t).toContain('Sector Pressure: +27 ↑');
    expect(t).toContain('Moderately positive rotation');
    expect(t).toContain('Participation currently favors this sector');
    expect(t).toContain('improving');
  });

  it('explains the arrow legend and disclaims fund flows', () => {
    const t = describePressure(-64, -30);
    expect(t).toContain('↑ = pressure is improving');
    expect(t).toContain('→ = pressure is relatively stable');
    expect(t).toContain('↓ = pressure is deteriorating');
    expect(t).toContain('Not literal dollar fund flow');
  });

  it('omits the change line when no 5-day delta exists', () => {
    expect(describePressure(10, null)).not.toContain('Change over 5 trading days');
  });

  it('accepts a custom metric label', () => {
    expect(describePressure(5, 0, 'Rotation Pressure')).toContain('Rotation Pressure: +5');
  });
});

describe('PRESSURE_HELP', () => {
  it('states the scale and the fund-flow caveat', () => {
    expect(PRESSURE_HELP).toContain('+100 = very strong rotation-in signal');
    expect(PRESSURE_HELP).toContain('−100 = very strong rotation-out signal');
    expect(PRESSURE_HELP).toContain('not literal dollar fund flow');
  });
});

describe('pressureSentence', () => {
  it('never claims dollars moved', () => {
    for (const p of [100, 50, 27, 0, -27, -50, -100]) {
      expect(pressureSentence(p).toLowerCase()).not.toContain('dollar');
      expect(pressureSentence(p).toLowerCase()).not.toContain('inflow');
    }
  });
});
