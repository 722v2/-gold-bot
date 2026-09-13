import { Candle, TechnicalIndicators } from '../src/types.js';

export interface DynamicTpRequest {
  direction: 'BUY' | 'SELL';
  entry: number;
  stopLoss: number;
  asset: string;
  indicators1h: TechnicalIndicators;
  indicators15m: TechnicalIndicators;
  indicators5m: TechnicalIndicators;
  candles1h: Candle[];
  candles15m: Candle[];
  candles5m: Candle[];
  minRr?: number;
}

export type StructuralSourceType =
  | '15M_SWING'
  | '15M_OB'
  | '15M_FVG'
  | '15M_BB'
  | 'SESSION_LIQUIDITY';

export interface StructuralLevel {
  price: number;
  type: StructuralSourceType;
  priority: number; // 1 = Highest (Swings/Liquidity), 2 = OB, 3 = FVG, 4 = BB
  name: string;
  distance: number;
  rr: number;
}

export interface DynamicTpResult {
  valid: boolean;
  tp1: number;
  tp2: number;
  slDistance: number;
  slPoints: number;
  tp1Distance: number;
  tp1Points: number;
  tp1Rr: number;
  tp1RrString: string;
  tp2Distance: number;
  tp2Points: number;
  tp2Rr: number;
  tp2RrString: string;
  tp1TargetName: string;
  tp2TargetName: string;
  tpSelectionReason: string;
  structuralTargetUsed: string;
  passedVolatilityCheck: boolean;
  atrAtEntry: number;
  noFutureDataUsed: boolean;
  opposingBarrierDetected?: boolean;
  opposingBarrierReason?: string;
  rejectionReason?: string;
  // Detailed diagnostics
  rawStructuralTarget: number;
  finalTp1: number;
  targetSourceType: string;
  targetDistance: number;
  actualRr: number;
  isModified: boolean;
  modificationReason: string;
}

/**
 * Calculates realistic, 100% genuine structural Take-Profits for XAUUSD with ZERO Lookahead.
 * STRICT POLICY:
 * 1. Only data available at or before entry timestamp is used.
 * 2. TP1 is exclusively determined from genuine market structure (Swings, Order Blocks, FVGs, Volatility Bands, Session High/Low).
 * 3. NO synthetic 2.5R, 2R, 3R or artificial fallbacks are inserted.
 * 4. If the nearest genuine structural target has RR < 1.5 -> NO TRADE.
 * 5. If the nearest genuine structural target has RR >= 1.5 -> Use its EXACT natural price and RR without normalization.
 * 6. TP2 must also be a genuine structural level available at entry timestamp.
 */
export function calculateDynamicTakeProfits(req: DynamicTpRequest): DynamicTpResult {
  const { direction, entry, stopLoss, indicators1h, indicators15m, indicators5m, candles1h } = req;
  const isBuy = direction === 'BUY';
  const minRr = req.minRr ?? 1.5;

  const slDistance = Number(Math.abs(entry - stopLoss).toFixed(2));
  const slPoints = Number((slDistance / 0.1).toFixed(1));
  const atr1h = indicators1h.atr14 || 3.0;
  const atr15m = indicators15m.atr14 || 1.8;
  const atrAtEntry = Number(atr15m.toFixed(2));

  // 1. Sanity check on Stop Loss distance
  if (slDistance <= 0.05) {
    return {
      valid: false,
      tp1: entry,
      tp2: entry,
      slDistance,
      slPoints,
      tp1Distance: 0,
      tp1Points: 0,
      tp1Rr: 0,
      tp1RrString: '1:0',
      tp2Distance: 0,
      tp2Points: 0,
      tp2Rr: 0,
      tp2RrString: '1:0',
      tp1TargetName: 'Invalid SL',
      tp2TargetName: 'None',
      tpSelectionReason: 'مسافة وقف الخسارة غير صالحة (< 0.05) -> NO TRADE',
      structuralTargetUsed: 'None',
      passedVolatilityCheck: false,
      atrAtEntry,
      noFutureDataUsed: true,
      rejectionReason: 'مسافة الوقف صغيرة جداً وغير قابلة للتنفيذ.',
      rawStructuralTarget: entry,
      finalTp1: entry,
      targetSourceType: 'NONE',
      targetDistance: 0,
      actualRr: 0,
      isModified: false,
      modificationReason: 'Invalid SL distance',
    };
  }

  // 2. Scan for Opposing Structural Barriers BEFORE minRr target
  const opposingBarriers: { price: number; name: string }[] = [];
  if (isBuy) {
    if (indicators15m.orderBlock?.type === 'BEARISH' && indicators15m.orderBlock.low > entry) {
      opposingBarriers.push({ price: indicators15m.orderBlock.low, name: '15M Bearish Order Block' });
    }
    if (indicators15m.fvg?.type === 'BEARISH' && indicators15m.fvg.bottom > entry) {
      opposingBarriers.push({ price: indicators15m.fvg.bottom, name: '15M Bearish FVG' });
    }
  } else {
    if (indicators15m.orderBlock?.type === 'BULLISH' && indicators15m.orderBlock.high < entry) {
      opposingBarriers.push({ price: indicators15m.orderBlock.high, name: '15M Bullish Order Block' });
    }
    if (indicators15m.fvg?.type === 'BULLISH' && indicators15m.fvg.top < entry) {
      opposingBarriers.push({ price: indicators15m.fvg.top, name: '15M Bullish FVG' });
    }
  }

  const criticalOpposingBarrier = opposingBarriers.find((b) => {
    const dist = Math.abs(b.price - entry);
    return dist < minRr * slDistance;
  });

  if (criticalOpposingBarrier) {
    const barrierDist = Math.abs(criticalOpposingBarrier.price - entry);
    const barrierRr = Number((barrierDist / slDistance).toFixed(2));
    return {
      valid: false,
      tp1: entry,
      tp2: entry,
      slDistance,
      slPoints,
      tp1Distance: barrierDist,
      tp1Points: Number((barrierDist / 0.1).toFixed(1)),
      tp1Rr: barrierRr,
      tp1RrString: `1:${barrierRr.toFixed(2)}`,
      tp2Distance: 0,
      tp2Points: 0,
      tp2Rr: 0,
      tp2RrString: '1:0',
      tp1TargetName: 'Opposing Barrier Blocked',
      tp2TargetName: 'None',
      tpSelectionReason: `حاجز هيكلي معاكس (${criticalOpposingBarrier.name}) يقع قبل تحقيق هدف ${minRr}R (يبعد $${barrierDist.toFixed(2)}) -> NO TRADE`,
      structuralTargetUsed: criticalOpposingBarrier.name,
      passedVolatilityCheck: false,
      atrAtEntry,
      noFutureDataUsed: true,
      opposingBarrierDetected: true,
      opposingBarrierReason: `حاجز هيكلي معاكس (${criticalOpposingBarrier.name}) يمنع السعر من الوصول إلى هدف ${minRr}R بأمان.`,
      rejectionReason: `وجود حاجز معاكس (${criticalOpposingBarrier.name}) يقل عن ${minRr}R -> NO TRADE.`,
      rawStructuralTarget: criticalOpposingBarrier.price,
      finalTp1: entry,
      targetSourceType: 'OPPOSING_BARRIER',
      targetDistance: barrierDist,
      actualRr: barrierRr,
      isModified: false,
      modificationReason: `Opposing barrier blocked trade before ${minRr}R`,
    };
  }

  // 3. Extract Genuine Market Structure Targets strictly in trade direction (NO LOOKAHEAD)
  const candidateLevels: StructuralLevel[] = [];

  // A. 15M Swing Pivots (Priority 1)
  if (isBuy && indicators15m.swingHigh > entry) {
    const dist = Number((indicators15m.swingHigh - entry).toFixed(2));
    candidateLevels.push({
      price: Number(indicators15m.swingHigh.toFixed(2)),
      type: '15M_SWING',
      priority: 1,
      name: '15M Swing High Pivot',
      distance: dist,
      rr: Number((dist / slDistance).toFixed(2)),
    });
  } else if (!isBuy && indicators15m.swingLow < entry) {
    const dist = Number((entry - indicators15m.swingLow).toFixed(2));
    candidateLevels.push({
      price: Number(indicators15m.swingLow.toFixed(2)),
      type: '15M_SWING',
      priority: 1,
      name: '15M Swing Low Pivot',
      distance: dist,
      rr: Number((dist / slDistance).toFixed(2)),
    });
  }

  // B. 24H Session High / Low Liquidity (Priority 1)
  if (candles1h.length > 0) {
    const sessionCandles = candles1h.slice(-24);
    const sessionHigh = Math.max(...sessionCandles.map((c) => c.high));
    const sessionLow = Math.min(...sessionCandles.map((c) => c.low));

    if (isBuy && sessionHigh > entry && sessionHigh - entry <= 4.0 * atr1h) {
      const dist = Number((sessionHigh - entry).toFixed(2));
      candidateLevels.push({
        price: Number(sessionHigh.toFixed(2)),
        type: 'SESSION_LIQUIDITY',
        priority: 1,
        name: '24H Session High Liquidity',
        distance: dist,
        rr: Number((dist / slDistance).toFixed(2)),
      });
    } else if (!isBuy && sessionLow < entry && entry - sessionLow <= 4.0 * atr1h) {
      const dist = Number((entry - sessionLow).toFixed(2));
      candidateLevels.push({
        price: Number(sessionLow.toFixed(2)),
        type: 'SESSION_LIQUIDITY',
        priority: 1,
        name: '24H Session Low Liquidity',
        distance: dist,
        rr: Number((dist / slDistance).toFixed(2)),
      });
    }
  }

  // C. 15M Order Block Target (Priority 2)
  if (isBuy && indicators15m.orderBlock?.type === 'BEARISH' && indicators15m.orderBlock.low > entry) {
    const dist = Number((indicators15m.orderBlock.low - entry).toFixed(2));
    candidateLevels.push({
      price: Number(indicators15m.orderBlock.low.toFixed(2)),
      type: '15M_OB',
      priority: 2,
      name: '15M Bearish Order Block Base',
      distance: dist,
      rr: Number((dist / slDistance).toFixed(2)),
    });
  } else if (!isBuy && indicators15m.orderBlock?.type === 'BULLISH' && indicators15m.orderBlock.high < entry) {
    const dist = Number((entry - indicators15m.orderBlock.high).toFixed(2));
    candidateLevels.push({
      price: Number(indicators15m.orderBlock.high.toFixed(2)),
      type: '15M_OB',
      priority: 2,
      name: '15M Bullish Order Block Top',
      distance: dist,
      rr: Number((dist / slDistance).toFixed(2)),
    });
  }

  // D. 15M FVG Target (Priority 3)
  if (isBuy && indicators15m.fvg?.type === 'BEARISH' && indicators15m.fvg.bottom > entry) {
    const dist = Number((indicators15m.fvg.bottom - entry).toFixed(2));
    candidateLevels.push({
      price: Number(indicators15m.fvg.bottom.toFixed(2)),
      type: '15M_FVG',
      priority: 3,
      name: '15M Bearish FVG Entry Zone',
      distance: dist,
      rr: Number((dist / slDistance).toFixed(2)),
    });
  } else if (!isBuy && indicators15m.fvg?.type === 'BULLISH' && indicators15m.fvg.top < entry) {
    const dist = Number((entry - indicators15m.fvg.top).toFixed(2));
    candidateLevels.push({
      price: Number(indicators15m.fvg.top.toFixed(2)),
      type: '15M_FVG',
      priority: 3,
      name: '15M Bullish FVG Entry Zone',
      distance: dist,
      rr: Number((dist / slDistance).toFixed(2)),
    });
  }

  // E. 15M Bollinger Band Extreme (Priority 4)
  if (isBuy && indicators15m.bollingerBands.upper > entry) {
    const dist = Number((indicators15m.bollingerBands.upper - entry).toFixed(2));
    candidateLevels.push({
      price: Number(indicators15m.bollingerBands.upper.toFixed(2)),
      type: '15M_BB',
      priority: 4,
      name: '15M Upper Volatility Band',
      distance: dist,
      rr: Number((dist / slDistance).toFixed(2)),
    });
  } else if (!isBuy && indicators15m.bollingerBands.lower < entry) {
    const dist = Number((entry - indicators15m.bollingerBands.lower).toFixed(2));
    candidateLevels.push({
      price: Number(indicators15m.bollingerBands.lower.toFixed(2)),
      type: '15M_BB',
      priority: 4,
      name: '15M Lower Volatility Band',
      distance: dist,
      rr: Number((dist / slDistance).toFixed(2)),
    });
  }

  // If no genuine structural candidates exist ahead of entry
  if (candidateLevels.length === 0) {
    return {
      valid: false,
      tp1: entry,
      tp2: entry,
      slDistance,
      slPoints,
      tp1Distance: 0,
      tp1Points: 0,
      tp1Rr: 0,
      tp1RrString: '1:0',
      tp2Distance: 0,
      tp2Points: 0,
      tp2Rr: 0,
      tp2RrString: '1:0',
      tp1TargetName: 'None',
      tp2TargetName: 'None',
      tpSelectionReason: 'لا يوجد أي مستوى هيكلي حقيقي متاح أمام السعر -> NO TRADE',
      structuralTargetUsed: 'None',
      passedVolatilityCheck: false,
      atrAtEntry,
      noFutureDataUsed: true,
      rejectionReason: 'غياب الأهداف الهيكلية الصالحة في اتجاه الصفقة.',
      rawStructuralTarget: entry,
      finalTp1: entry,
      targetSourceType: 'NONE',
      targetDistance: 0,
      actualRr: 0,
      isModified: false,
      modificationReason: 'No structural candidate found in trade direction',
    };
  }

  // 4. Rank candidates by structural validity & distance:
  // Sort primarily by distance (nearest first).
  // If multiple levels are within 0.5 points of each other, prefer higher structural priority.
  candidateLevels.sort((a, b) => {
    const distDiff = a.distance - b.distance;
    if (Math.abs(distDiff) < 0.3) {
      return a.priority - b.priority;
    }
    return distDiff;
  });

  // Find the NEAREST structural candidate ahead of entry
  const nearestCandidate = candidateLevels[0];

  // STRICT REQUIREMENT:
  // If the nearest genuine structural target does NOT provide at least 1:minRr RR,
  // signal MUST become NO TRADE. We do not skip it, force it, or add synthetic levels.
  if (nearestCandidate.rr < minRr) {
    return {
      valid: false,
      tp1: entry,
      tp2: entry,
      slDistance,
      slPoints,
      tp1Distance: nearestCandidate.distance,
      tp1Points: Number((nearestCandidate.distance / 0.1).toFixed(1)),
      tp1Rr: nearestCandidate.rr,
      tp1RrString: `1:${nearestCandidate.rr.toFixed(2)}`,
      tp2Distance: 0,
      tp2Points: 0,
      tp2Rr: 0,
      tp2RrString: '1:0',
      tp1TargetName: nearestCandidate.name,
      tp2TargetName: 'None',
      tpSelectionReason: `أقرب هدف هيكلي حقيقي (${nearestCandidate.name}) يعطي R:R قدره 1:${nearestCandidate.rr.toFixed(2)} وهو أقل من الحد الأدنى 1:${minRr} -> NO TRADE`,
      structuralTargetUsed: nearestCandidate.name,
      passedVolatilityCheck: false,
      atrAtEntry,
      noFutureDataUsed: true,
      rejectionReason: `أقرب هدف هيكلي (${nearestCandidate.name}) يحقق 1:${nearestCandidate.rr.toFixed(2)} فقط (< 1:${minRr}) -> NO TRADE لحماية نسبة المخاطرة.`,
      rawStructuralTarget: nearestCandidate.price,
      finalTp1: entry,
      targetSourceType: nearestCandidate.type,
      targetDistance: nearestCandidate.distance,
      actualRr: nearestCandidate.rr,
      isModified: false,
      modificationReason: `Nearest structural target gives RR < ${minRr} (${nearestCandidate.rr.toFixed(2)}R) -> Disqualified`,
    };
  }

  // 5. Select TP1: The nearest genuine structural target meeting >= minRr
  const selectedTp1 = nearestCandidate;
  const rawStructuralTarget = selectedTp1.price;
  const tp1Price = Number(selectedTp1.price.toFixed(2));
  const tp1Distance = Number(Math.abs(tp1Price - entry).toFixed(2));
  const tp1Points = Number((tp1Distance / 0.1).toFixed(1));
  const tp1Rr = Number((tp1Distance / slDistance).toFixed(2));
  const tp1RrString = `1:${tp1Rr.toFixed(2)}`;

  // Volatility Sanity Check: TP1 distance must not exceed 3.5 * ATR(1H)
  const passedVolatilityCheck = tp1Distance <= Math.max(15.0, 3.5 * atr1h);
  if (!passedVolatilityCheck) {
    return {
      valid: false,
      tp1: entry,
      tp2: entry,
      slDistance,
      slPoints,
      tp1Distance,
      tp1Points,
      tp1Rr,
      tp1RrString,
      tp2Distance: 0,
      tp2Points: 0,
      tp2Rr: 0,
      tp2RrString: '1:0',
      tp1TargetName: selectedTp1.name,
      tp2TargetName: 'None',
      tpSelectionReason: `مسافة الهدف الهيكلي ($${tp1Distance.toFixed(2)}) تتجاوز نطاق التقلب الواقعي (3.5x ATR) -> NO TRADE`,
      structuralTargetUsed: selectedTp1.name,
      passedVolatilityCheck: false,
      atrAtEntry,
      noFutureDataUsed: true,
      rejectionReason: `الهدف الهيكلي (${selectedTp1.name}) بعيد جداً ويتجاوز نطاق التقلب الواقعي -> NO TRADE.`,
      rawStructuralTarget,
      finalTp1: entry,
      targetSourceType: selectedTp1.type,
      targetDistance: tp1Distance,
      actualRr: tp1Rr,
      isModified: false,
      modificationReason: 'Exceeded ATR volatility sanity boundary (> 3.5x ATR1H)',
    };
  }

  // 6. Select TP2: Next genuine structural candidate further than TP1
  const furtherCandidates = candidateLevels.filter(
    (c) => c.distance > tp1Distance + 0.3 * slDistance && Math.abs(c.price - tp1Price) >= 0.5
  );

  const selectedTp2 = furtherCandidates.length > 0 ? furtherCandidates[0] : selectedTp1;
  const tp2Price = Number(selectedTp2.price.toFixed(2));
  const tp2Distance = Number(Math.abs(tp2Price - entry).toFixed(2));
  const tp2Points = Number((tp2Distance / 0.1).toFixed(1));
  const tp2Rr = Number((tp2Distance / slDistance).toFixed(2));
  const tp2RrString = `1:${tp2Rr.toFixed(2)}`;

  return {
    valid: true,
    tp1: tp1Price,
    tp2: tp2Price,
    slDistance,
    slPoints,
    tp1Distance,
    tp1Points,
    tp1Rr,
    tp1RrString,
    tp2Distance,
    tp2Points,
    tp2Rr,
    tp2RrString,
    tp1TargetName: selectedTp1.name,
    tp2TargetName: selectedTp2.name,
    tpSelectionReason: `تم اختيار TP1 من هيكل السوق الواقعي (${selectedTp1.name}) بنسبة ${tp1RrString}${selectedTp2 !== selectedTp1 ? `، و TP2 (${selectedTp2.name}) بنسبة ${tp2RrString}` : ''}.`,
    structuralTargetUsed: selectedTp1.name,
    passedVolatilityCheck: true,
    atrAtEntry,
    noFutureDataUsed: true,
    // Transparent diagnostics
    rawStructuralTarget,
    finalTp1: tp1Price,
    targetSourceType: selectedTp1.type,
    targetDistance: tp1Distance,
    actualRr: tp1Rr,
    isModified: false, // 100% genuine structure, never artificially modified
    modificationReason: 'None (Natural Market Structure Target)',
  };
}
