import { Candle, TechnicalIndicators, StrategyFamily } from '../src/types.js';

export type EntryLocationClassification = 'PULLBACK_OPTIMAL' | 'PULLBACK_ACCEPTABLE' | 'MID_IMPULSE' | 'LATE' | 'EXHAUSTED';

export interface EntryLocationQuality {
  classification: EntryLocationClassification;
  hardBlocked: boolean;
  rejectionReason?: string;
  impulseExtensionAtr: number;
  consecutiveDirectionalBars: number;
  correctiveBars: number;
  terminalBoundaryDistanceAtr: number;
  retestDisplacementAtr: number;
  scoringPenalty: number;
  reasons: string[];
}

function directionalBar(candle: Candle, direction: 'BUY' | 'SELL'): boolean {
  return direction === 'BUY' ? candle.close > candle.open : candle.close < candle.open;
}

function counterTrendBar(candle: Candle, direction: 'BUY' | 'SELL'): boolean {
  return direction === 'BUY' ? candle.close < candle.open : candle.close > candle.open;
}

/**
 * Entry Location Quality (ELQ)
 *
 * Separates candle/trigger quality from spatial entry quality. It deliberately
 * uses the immediate local impulse, not the age or size of the macro trend.
 */
export function assessEntryLocationQuality(params: {
  direction: 'BUY' | 'SELL';
  family: StrategyFamily | string;
  entry: number;
  currentPrice: number;
  candles5m: Candle[];
  indicators5m: TechnicalIndicators;
  indicators15m: TechnicalIndicators;
  indicators1h: TechnicalIndicators;
  explicitRetestLevel?: number;
}): EntryLocationQuality {
  const {
    direction,
    family,
    entry,
    currentPrice,
    candles5m,
    indicators5m,
    indicators15m,
    indicators1h,
    explicitRetestLevel,
  } = params;

  const atr = Math.max(0.5, indicators5m.atr14 || 2.0);
  const closed = candles5m.filter(c => c.isClosed !== false);
  const recent = closed.slice(-10);
  const reasons: string[] = [];

  if (recent.length < 4) {
    return {
      classification: 'PULLBACK_ACCEPTABLE',
      hardBlocked: false,
      impulseExtensionAtr: 0,
      consecutiveDirectionalBars: 0,
      correctiveBars: 0,
      terminalBoundaryDistanceAtr: 999,
      retestDisplacementAtr: 0,
      scoringPenalty: 0,
      reasons: ['ELQ baseline: insufficient local candle history'],
    };
  }

  // Count the uninterrupted directional run ending at the latest closed candle.
  let consecutiveDirectionalBars = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (!directionalBar(recent[i], direction)) break;
    consecutiveDirectionalBars += 1;
  }

  // Find the local impulse origin immediately before that uninterrupted run.
  const runStartIndex = recent.length - consecutiveDirectionalBars;
  const runOrigin = consecutiveDirectionalBars > 0
    ? recent[Math.max(0, runStartIndex)].open
    : recent[recent.length - 1].open;
  const impulseExtensionAtr = Number((Math.abs(currentPrice - runOrigin) / atr).toFixed(2));

  // A real pullback needs two counter-trend candles in the recent local wave.
  let correctiveBars = 0;
  for (const candle of recent.slice(-5)) {
    if (counterTrendBar(candle, direction)) correctiveBars += 1;
  }
  const hasTwoBarPullback = correctiveBars >= 2;

  // Terminal boundary = the nearest meaningful opposing structure beyond entry.
  const barriers: number[] = [];
  const addBarrier = (price: number | undefined) => {
    if (!price || !Number.isFinite(price)) return;
    if (direction === 'SELL' && price < entry) barriers.push(price);
    if (direction === 'BUY' && price > entry) barriers.push(price);
  };

  if (direction === 'SELL') {
    addBarrier(indicators5m.support);
    addBarrier(indicators5m.swingLow);
    addBarrier(indicators15m.support);
    addBarrier(indicators15m.swingLow);
    addBarrier(indicators1h.support);
    addBarrier(indicators1h.swingLow);
    if (indicators15m.orderBlock?.type === 'BULLISH') addBarrier(indicators15m.orderBlock.high);
    if (indicators15m.fvg?.type === 'BULLISH') addBarrier(indicators15m.fvg.top);
  } else {
    addBarrier(indicators5m.resistance);
    addBarrier(indicators5m.swingHigh);
    addBarrier(indicators15m.resistance);
    addBarrier(indicators15m.swingHigh);
    addBarrier(indicators1h.resistance);
    addBarrier(indicators1h.swingHigh);
    if (indicators15m.orderBlock?.type === 'BEARISH') addBarrier(indicators15m.orderBlock.low);
    if (indicators15m.fvg?.type === 'BEARISH') addBarrier(indicators15m.fvg.bottom);
  }

  const terminalPrice = direction === 'SELL'
    ? Math.max(...barriers.filter(p => p < entry), -Infinity)
    : Math.min(...barriers.filter(p => p > entry), Infinity);
  const terminalDistance = Number.isFinite(terminalPrice)
    ? Math.abs(entry - terminalPrice)
    : Infinity;
  const terminalBoundaryDistanceAtr = Number((terminalDistance / atr).toFixed(2));

  // Breakout/retest chase is only enforceable when the candidate supplied an
  // actual retest level. Never fabricate the entry itself as the retest POI.
  const isBreakoutRetest = family === 'BREAK_AND_RETEST' || family === 'RANGE_BREAKOUT_EXPANSION';
  const retestDisplacementAtr = explicitRetestLevel !== undefined && Number.isFinite(explicitRetestLevel)
    ? Number((Math.abs(entry - explicitRetestLevel) / atr).toFixed(2))
    : 0;

  if (terminalBoundaryDistanceAtr < 1.2) {
    reasons.push(`Terminal boundary only ${terminalBoundaryDistanceAtr} ATR from entry`);
    return {
      classification: 'EXHAUSTED',
      hardBlocked: true,
      rejectionReason: `ENTRY_LOCATION_TERMINAL_BOUNDARY_TOO_CLOSE: opposing structural boundary is ${terminalBoundaryDistanceAtr} ATR from entry (< 1.20 ATR)`,
      impulseExtensionAtr,
      consecutiveDirectionalBars,
      correctiveBars,
      terminalBoundaryDistanceAtr,
      retestDisplacementAtr,
      scoringPenalty: 0,
      reasons,
    };
  }

  if (isBreakoutRetest && explicitRetestLevel !== undefined && retestDisplacementAtr > 1.0) {
    reasons.push(`Breakout/retest entry displaced ${retestDisplacementAtr} ATR from the actual retest level`);
    return {
      classification: 'LATE',
      hardBlocked: true,
      rejectionReason: `ENTRY_LOCATION_BREAKOUT_RETEST_CHASE: entry is ${retestDisplacementAtr} ATR beyond the retest level (> 1.00 ATR)`,
      impulseExtensionAtr,
      consecutiveDirectionalBars,
      correctiveBars,
      terminalBoundaryDistanceAtr,
      retestDisplacementAtr,
      scoringPenalty: 0,
      reasons,
    };
  }

  if (consecutiveDirectionalBars >= 4 && impulseExtensionAtr > 3.5 && !hasTwoBarPullback) {
    reasons.push(`${consecutiveDirectionalBars} consecutive directional bars with ${impulseExtensionAtr} ATR extension and no 2-bar pullback`);
    return {
      classification: 'EXHAUSTED',
      hardBlocked: true,
      rejectionReason: `ENTRY_LOCATION_IMPULSE_EXHAUSTION: ${impulseExtensionAtr} ATR extension after ${consecutiveDirectionalBars} directional bars without a 2-bar pullback`,
      impulseExtensionAtr,
      consecutiveDirectionalBars,
      correctiveBars,
      terminalBoundaryDistanceAtr,
      retestDisplacementAtr,
      scoringPenalty: 0,
      reasons,
    };
  }

  if (impulseExtensionAtr > 3.0 || (isBreakoutRetest && retestDisplacementAtr > 0.75)) {
    const penalty = Math.min(25, Math.round(15 + Math.max(0, impulseExtensionAtr - 2.0) * 10));
    reasons.push(`Late/mature local impulse (${impulseExtensionAtr} ATR)`);
    return {
      classification: 'LATE',
      hardBlocked: false,
      impulseExtensionAtr,
      consecutiveDirectionalBars,
      correctiveBars,
      terminalBoundaryDistanceAtr,
      retestDisplacementAtr,
      scoringPenalty: penalty,
      reasons,
    };
  }

  if (impulseExtensionAtr >= 2.0) {
    const penalty = Math.min(15, Math.max(0, Math.round((impulseExtensionAtr - 2.0) * 10)));
    reasons.push(`Mature local impulse (${impulseExtensionAtr} ATR)`);
    return {
      classification: 'MID_IMPULSE',
      hardBlocked: false,
      impulseExtensionAtr,
      consecutiveDirectionalBars,
      correctiveBars,
      terminalBoundaryDistanceAtr,
      retestDisplacementAtr,
      scoringPenalty: penalty,
      reasons,
    };
  }

  if (hasTwoBarPullback) {
    reasons.push('Local 2+ bar corrective pullback detected before trigger');
    return {
      classification: 'PULLBACK_OPTIMAL',
      hardBlocked: false,
      impulseExtensionAtr,
      consecutiveDirectionalBars,
      correctiveBars,
      terminalBoundaryDistanceAtr,
      retestDisplacementAtr,
      scoringPenalty: 0,
      reasons,
    };
  }

  return {
    classification: 'PULLBACK_ACCEPTABLE',
    hardBlocked: false,
    impulseExtensionAtr,
    consecutiveDirectionalBars,
    correctiveBars,
    terminalBoundaryDistanceAtr,
    retestDisplacementAtr,
    scoringPenalty: 0,
    reasons: ['Local entry location remains within acceptable extension limits'],
  };
}
