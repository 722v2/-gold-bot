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
  locationScoreBonus: number;
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
  setupName?: string;
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
    setupName,
  } = params;

  const atr = Math.max(0.5, indicators5m.atr14 || 2.0);
  const closed = candles5m.filter(c => c.isClosed !== false);
  const recent = closed.slice(-12);
  const reasons: string[] = [];

  const familyStr = (family || '').toString().toUpperCase();
  const nameStr = (setupName || '').toUpperCase();
  const isTrendContinuation =
    familyStr === 'TREND_CONTINUATION' ||
    (familyStr === 'MARKET_STRUCTURE' && (nameStr.includes('CONTINUATION') || nameStr.includes('PULLBACK') || nameStr === '')) ||
    nameStr.includes('TREND CONTINUATION') ||
    nameStr.includes('PULLBACK');
  const isBreakoutRetest =
    familyStr === 'BREAK_AND_RETEST' ||
    familyStr === 'RANGE_BREAKOUT_EXPANSION' ||
    nameStr.includes('BREAKOUT') ||
    nameStr.includes('RETEST');

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
      locationScoreBonus: 0,
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

  // Pullback detection: 2+ counter-trend candles OR single strong pullback candle with rejection/retest
  let correctiveBars = 0;
  let hasRejectionPullback = false;
  const recent6 = recent.slice(-6);
  for (let idx = 0; idx < recent6.length; idx++) {
    const candle = recent6[idx];
    const isCounter = counterTrendBar(candle, direction);
    if (isCounter) {
      correctiveBars += 1;
    }
    const totalRange = Math.max(0.01, candle.high - candle.low);
    const body = Math.abs(candle.close - candle.open);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    if (isCounter && direction === 'BUY' && (lowerWick > body * 1.2 || lowerWick > totalRange * 0.35)) {
      hasRejectionPullback = true;
    } else if (isCounter && direction === 'SELL' && (upperWick > body * 1.2 || upperWick > totalRange * 0.35)) {
      hasRejectionPullback = true;
    }
  }
  const hasTwoBarPullback = correctiveBars >= 2;
  const hasValidPullback = hasTwoBarPullback || (correctiveBars >= 1 && hasRejectionPullback);

  // Major opposing barriers beyond entry (opposing unmitigated OBs, FVGs, major HTF levels)
  // NOTE: Local 5M/15M swings are structural targets (TP1), NOT terminal barriers.
  const majorBarriers: number[] = [];
  const addMajorBarrier = (price: number | undefined) => {
    if (!price || !Number.isFinite(price)) return;
    if (
      explicitRetestLevel !== undefined &&
      Number.isFinite(explicitRetestLevel) &&
      Math.abs(price - explicitRetestLevel) < 0.3 * atr
    ) {
      return;
    }
    if (direction === 'SELL' && price < entry - 0.05) majorBarriers.push(price);
    if (direction === 'BUY' && price > entry + 0.05) majorBarriers.push(price);
  };

  // Check if entry is already inside an unmitigated opposing POI structure
  let insideOpposingStructure = false;
  if (direction === 'SELL') {
    if (indicators15m.orderBlock?.type === 'BULLISH') {
      addMajorBarrier(indicators15m.orderBlock.high);
      if (entry <= indicators15m.orderBlock.high + 0.05 && entry >= indicators15m.orderBlock.low - 0.05) {
        insideOpposingStructure = true;
      }
    }
    if (indicators15m.fvg?.type === 'BULLISH') {
      addMajorBarrier(indicators15m.fvg.top);
      if (entry <= indicators15m.fvg.top + 0.05 && entry >= indicators15m.fvg.bottom - 0.05) {
        insideOpposingStructure = true;
      }
    }
    addMajorBarrier(indicators1h.support);
  } else {
    if (indicators15m.orderBlock?.type === 'BEARISH') {
      addMajorBarrier(indicators15m.orderBlock.low);
      if (entry >= indicators15m.orderBlock.low - 0.05 && entry <= indicators15m.orderBlock.high + 0.05) {
        insideOpposingStructure = true;
      }
    }
    if (indicators15m.fvg?.type === 'BEARISH') {
      addMajorBarrier(indicators15m.fvg.bottom);
      if (entry >= indicators15m.fvg.bottom - 0.05 && entry <= indicators15m.fvg.top + 0.05) {
        insideOpposingStructure = true;
      }
    }
    addMajorBarrier(indicators1h.resistance);
  }

  const terminalPrice = direction === 'SELL'
    ? Math.max(...majorBarriers.filter(p => p < entry), -Infinity)
    : Math.min(...majorBarriers.filter(p => p > entry), Infinity);
  let terminalDistance = Number.isFinite(terminalPrice)
    ? Math.abs(entry - terminalPrice)
    : Infinity;

  if (insideOpposingStructure) {
    terminalDistance = 0;
  }

  const terminalBoundaryDistanceAtr = Number((terminalDistance / atr).toFixed(2));

  // Breakout/retest chase is only enforceable when the candidate supplied an
  // actual retest level. Never fabricate the entry itself as the retest POI.
  const retestDisplacementAtr = explicitRetestLevel !== undefined && Number.isFinite(explicitRetestLevel)
    ? Number((Math.abs(entry - explicitRetestLevel) / atr).toFixed(2))
    : 0;

  // HARD BLOCK 1: INSIDE OPPOSING STRUCTURE (entry directly inside unmitigated major opposing OB/FVG)
  if (insideOpposingStructure || terminalBoundaryDistanceAtr < 0.15) {
    reasons.push(insideOpposingStructure ? 'Entry inside opposing major structural POI' : `Major terminal boundary only ${terminalBoundaryDistanceAtr} ATR from entry`);
    return {
      classification: 'EXHAUSTED',
      hardBlocked: true,
      rejectionReason: insideOpposingStructure
        ? 'INSIDE_OPPOSING_STRUCTURE: entry is inside an unmitigated opposing structural POI'
        : `TERMINAL_BOUNDARY_TOO_CLOSE: opposing major boundary is ${terminalBoundaryDistanceAtr} ATR from entry (< 0.15 ATR)`,
      impulseExtensionAtr,
      consecutiveDirectionalBars,
      correctiveBars,
      terminalBoundaryDistanceAtr,
      retestDisplacementAtr,
      scoringPenalty: 0,
      locationScoreBonus: -10,
      reasons,
    };
  }

  // HARD BLOCK 2: BREAKOUT RETEST CHASE (> 2.20 ATR) - Converted moderate displacement into scoring penalty
  if (isBreakoutRetest && explicitRetestLevel !== undefined && retestDisplacementAtr > 2.2) {
    reasons.push(`Breakout/retest entry displaced ${retestDisplacementAtr} ATR from the actual retest level`);
    return {
      classification: 'LATE',
      hardBlocked: true,
      rejectionReason: `BREAKOUT_RETEST_CHASE: entry is ${retestDisplacementAtr} ATR beyond the retest level (> 2.20 ATR)`,
      impulseExtensionAtr,
      consecutiveDirectionalBars,
      correctiveBars,
      terminalBoundaryDistanceAtr,
      retestDisplacementAtr,
      scoringPenalty: 0,
      locationScoreBonus: -10,
      reasons,
    };
  }

  // HARD BLOCK 3: IMPULSE EXHAUSTION CLIMAX (>= 5 directional bars + > 3.8 ATR extension + no pullback)
  if ((consecutiveDirectionalBars >= 5 || isTrendContinuation) && impulseExtensionAtr > 3.8 && !hasValidPullback) {
    reasons.push(`${consecutiveDirectionalBars} consecutive directional bars with ${impulseExtensionAtr} ATR extension and no pullback`);
    return {
      classification: 'EXHAUSTED',
      hardBlocked: true,
      rejectionReason: `LATE_EXHAUSTED_ENTRY: ${impulseExtensionAtr} ATR extension after ${consecutiveDirectionalBars} directional bars without a pullback`,
      impulseExtensionAtr,
      consecutiveDirectionalBars,
      correctiveBars,
      terminalBoundaryDistanceAtr,
      retestDisplacementAtr,
      scoringPenalty: 0,
      locationScoreBonus: -10,
      reasons,
    };
  }

  // HARD BLOCK 4: LATE CONTINUATION (> 3.5 ATR without any pullback)
  if (isTrendContinuation && impulseExtensionAtr > 3.5 && !hasValidPullback) {
    reasons.push(`Late trend continuation: ${impulseExtensionAtr} ATR extension without a pullback`);
    return {
      classification: 'LATE',
      hardBlocked: true,
      rejectionReason: `LATE_EXHAUSTED_ENTRY: trend continuation entry is late (${impulseExtensionAtr} ATR extension > 3.50 ATR) without a pullback`,
      impulseExtensionAtr,
      consecutiveDirectionalBars,
      correctiveBars,
      terminalBoundaryDistanceAtr,
      retestDisplacementAtr,
      scoringPenalty: 0,
      locationScoreBonus: -10,
      reasons,
    };
  }

  // SCORING FACTOR 1: Late / extended impulse
  if (impulseExtensionAtr > 3.0 || (isBreakoutRetest && retestDisplacementAtr > 1.2)) {
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
      locationScoreBonus: -Math.min(5, Math.round(penalty / 3)),
      reasons,
    };
  }

  // SCORING FACTOR 2: Mid-impulse (2.0 - 3.0 ATR)
  if (impulseExtensionAtr >= 2.0) {
    const penalty = Math.min(15, Math.max(5, Math.round((impulseExtensionAtr - 2.0) * 10)));
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
      locationScoreBonus: -Math.min(3, Math.round(penalty / 4)),
      reasons,
    };
  }

  // FRESH PULLBACK: Valid corrective pullback detected
  if (hasValidPullback) {
    reasons.push(hasTwoBarPullback ? 'Local 2+ bar corrective pullback detected before trigger' : 'Local controlled pullback / retest reaction detected');
    return {
      classification: 'PULLBACK_OPTIMAL',
      hardBlocked: false,
      impulseExtensionAtr,
      consecutiveDirectionalBars,
      correctiveBars,
      terminalBoundaryDistanceAtr,
      retestDisplacementAtr,
      scoringPenalty: 0,
      locationScoreBonus: 3,
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
    locationScoreBonus: 0,
    reasons: ['Local entry location remains within acceptable extension limits'],
  };
}
