import {
  Candle,
  TechnicalIndicators,
  PoiRecord,
  PoiFreshnessState,
  PullbackQuality,
  PullbackAssessment,
  EntryTiming,
  EntryTimingAssessment,
  PriceActionTriggerType,
  TriggerAssessment,
  TpPathRunway,
  TpObstacle,
  TpPathAssessment,
  LiquidityContextInfo,
  CandidateLifecycleState,
  CandidateLifecycleRecord,
  TradeSignal,
  DuplicateDetails,
  StrategyFamily,
} from '../src/types.js';

// ============================================================================
// 1. SETUP FRESHNESS & POI MITIGATION ENGINE
// ============================================================================

export class PoiFreshnessTracker {
  private pois: Map<string, PoiRecord> = new Map();

  constructor(initialPois: PoiRecord[] = []) {
    for (const poi of initialPois) {
      this.pois.set(poi.id, poi);
    }
  }

  /**
   * Generates a deterministic POI ID based on type, timeframe, direction, and price boundaries
   */
  public generatePoiId(
    type: PoiRecord['type'],
    timeframe: PoiRecord['timeframe'],
    direction: PoiRecord['direction'],
    top: number,
    bottom: number
  ): string {
    const roundTop = Math.round(top * 10) / 10;
    const roundBottom = Math.round(bottom * 10) / 10;
    return `poi_${type.toLowerCase()}_${timeframe.toLowerCase()}_${direction.toLowerCase()}_${roundTop}_${roundBottom}`;
  }

  /**
   * Registers a newly identified POI or retrieves existing one
   */
  public registerPoi(
    type: PoiRecord['type'],
    timeframe: PoiRecord['timeframe'],
    direction: PoiRecord['direction'],
    top: number,
    bottom: number,
    createdCandleTime: number,
    invalidationPrice?: number
  ): PoiRecord {
    const id = this.generatePoiId(type, timeframe, direction, top, bottom);
    const existing = this.pois.get(id);
    if (existing) {
      return existing;
    }

    const newPoi: PoiRecord = {
      id,
      type,
      timeframe,
      direction,
      top: Math.max(top, bottom),
      bottom: Math.min(top, bottom),
      createdTimestamp: Date.now(),
      createdCandleTime,
      tapCount: 0,
      state: 'FRESH',
      invalidationPrice,
    };

    this.pois.set(id, newPoi);
    return newPoi;
  }

  /**
   * Updates interactions for a POI against recent candles.
   * Ensures:
   * - Does NOT count the creation candle as a tap.
   * - Does NOT count repeated scans of the same candle as multiple taps.
   * - Does NOT count trivial proximity (requires actual touch/entry into [bottom, top]).
   * - Identifies decisive invalidation when candle closes beyond the POI.
   */
  public evaluatePoiFreshness(
    poiId: string,
    candles: Candle[],
    currentPrice: number,
    atr: number = 2.0
  ): { state: PoiFreshnessState; tapCount: number; isTradable: boolean; multiplier: number; reason: string } {
    const poi = this.pois.get(poiId);
    if (!poi) {
      return {
        state: 'FRESH',
        tapCount: 0,
        isTradable: true,
        multiplier: 1.0,
        reason: 'Fresh POI (Initial Test)',
      };
    }

    if (poi.state === 'INVALIDATED') {
      return {
        state: 'INVALIDATED',
        tapCount: poi.tapCount,
        isTradable: false,
        multiplier: 0.0,
        reason: 'POI invalidated by structural closure through zone',
      };
    }

    // Evaluate candles that occurred strictly AFTER createdCandleTime
    for (const c of candles) {
      const candleTime = c.timestamp;
      if (poi.createdCandleTime && candleTime <= poi.createdCandleTime) {
        continue;
      }

      // Check for decisive invalidation (candle closing beyond zone)
      if (poi.direction === 'BULLISH') {
        // Bullish OB invalidated if candle closes below bottom by > 0.2 ATR
        const invalidationLevel = poi.invalidationPrice ?? poi.bottom - Math.min(0.5, atr * 0.2);
        if (c.close < invalidationLevel) {
          poi.state = 'INVALIDATED';
          return {
            state: 'INVALIDATED',
            tapCount: poi.tapCount,
            isTradable: false,
            multiplier: 0.0,
            reason: `Decisive invalidation: 5M candle closed ($${c.close.toFixed(2)}) below zone bottom ($${poi.bottom.toFixed(2)})`,
          };
        }
      } else {
        // Bearish OB invalidated if candle closes above top by > 0.2 ATR
        const invalidationLevel = poi.invalidationPrice ?? poi.top + Math.min(0.5, atr * 0.2);
        if (c.close > invalidationLevel) {
          poi.state = 'INVALIDATED';
          return {
            state: 'INVALIDATED',
            tapCount: poi.tapCount,
            isTradable: false,
            multiplier: 0.0,
            reason: `Decisive invalidation: 5M candle closed ($${c.close.toFixed(2)}) above zone top ($${poi.top.toFixed(2)})`,
          };
        }
      }

      // Check for meaningful touch/entry into the zone:
      // High must reach into the zone from below, or Low must reach into the zone from above
      const enteredZone = c.high >= poi.bottom && c.low <= poi.top;
      if (enteredZone) {
        // Ensure we only count each distinct candle timestamp once
        if (!poi.lastTestedCandleTime || candleTime > poi.lastTestedCandleTime) {
          poi.tapCount += 1;
          poi.lastTestedCandleTime = candleTime;

          if (poi.tapCount === 1) {
            poi.state = 'TESTED_ONCE';
          } else if (poi.tapCount === 2) {
            poi.state = 'TESTED_TWICE';
          } else if (poi.tapCount >= 3) {
            poi.state = 'EXHAUSTED';
          }
        }
      }
    }

    // Determine tradability and scoring multiplier
    let isTradable = true;
    let multiplier = 1.0;
    let reason = 'Fresh zone (0 previous mitigations)';

    const currentState = poi.state;
    if (currentState === 'TESTED_ONCE') {
      multiplier = 0.85;
      reason = 'First retest mitigation (Healthy)';
    } else if (currentState === 'TESTED_TWICE') {
      multiplier = 0.60;
      reason = 'Second retest mitigation (Moderate quality degradation)';
    } else if (currentState === 'EXHAUSTED') {
      isTradable = false;
      multiplier = 0.10;
      reason = `Exhausted POI (${poi.tapCount} tests). High probability of failure/break.`;
    }

    return {
      state: poi.state,
      tapCount: poi.tapCount,
      isTradable,
      multiplier,
      reason,
    };
  }

  public getAllPois(): PoiRecord[] {
    return Array.from(this.pois.values());
  }

  public getPoi(id: string): PoiRecord | undefined {
    return this.pois.get(id);
  }

  public setPois(records: PoiRecord[]) {
    this.pois.clear();
    for (const r of records) {
      this.pois.set(r.id, r);
    }
  }
}

// Global instance for persistent scanner use
export const globalPoiTracker = new PoiFreshnessTracker();

// ============================================================================
// 2. LIQUIDITY CONTEXT ENGINE
// ============================================================================

/**
 * Evaluates Equal Highs (EQH), Equal Lows (EQL), BSL, SSL, internal vs external liquidity
 */
export function assessLiquidityContext(
  candles5m: Candle[],
  candles15m: Candle[],
  candles1h: Candle[],
  currentPrice: number,
  direction: 'BUY' | 'SELL',
  regime: string
): LiquidityContextInfo {
  const equalHighs: { price: number; touches: number; spread: number }[] = [];
  const equalLows: { price: number; touches: number; spread: number }[] = [];

  // 1. Identify swing peaks/troughs in 15M / 5M to detect Equal Highs / Equal Lows
  const recentCandles = candles5m.slice(-40);
  const highs: number[] = [];
  const lows: number[] = [];

  for (let i = 2; i < recentCandles.length - 2; i++) {
    const c = recentCandles[i];
    const isPeak =
      c.high >= recentCandles[i - 1].high &&
      c.high >= recentCandles[i - 2].high &&
      c.high >= recentCandles[i + 1].high &&
      c.high >= recentCandles[i + 2].high;

    const isTrough =
      c.low <= recentCandles[i - 1].low &&
      c.low <= recentCandles[i - 2].low &&
      c.low <= recentCandles[i + 1].low &&
      c.low <= recentCandles[i + 2].low;

    if (isPeak) highs.push(c.high);
    if (isTrough) lows.push(c.low);
  }

  // Detect EQH (within 0.15% or 0.8 pts on Gold)
  for (let i = 0; i < highs.length; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      const diff = Math.abs(highs[i] - highs[j]);
      if (diff <= 0.8 && diff > 0.01) {
        const avgPrice = (highs[i] + highs[j]) / 2;
        if (!equalHighs.some((eq) => Math.abs(eq.price - avgPrice) <= 0.8)) {
          equalHighs.push({ price: avgPrice, touches: 2, spread: diff });
        }
      }
    }
  }

  // Detect EQL (within 0.15% or 0.8 pts on Gold)
  for (let i = 0; i < lows.length; i++) {
    for (let j = i + 1; j < lows.length; j++) {
      const diff = Math.abs(lows[i] - lows[j]);
      if (diff <= 0.8 && diff > 0.01) {
        const avgPrice = (lows[i] + lows[j]) / 2;
        if (!equalLows.some((eq) => Math.abs(eq.price - avgPrice) <= 0.8)) {
          equalLows.push({ price: avgPrice, touches: 2, spread: diff });
        }
      }
    }
  }

  // 2. Check for recent liquidity sweep in last 5 candles
  let recentSweptLevel: LiquidityContextInfo['recentSweptLevel'] = null;
  const last5 = candles5m.slice(-5);
  for (const c of last5) {
    // Check if swept any EQH / BSL
    for (const eq of equalHighs) {
      if (c.high > eq.price && c.close < eq.price) {
        recentSweptLevel = {
          type: 'BSL',
          price: eq.price,
          sweptBy: c.high - eq.price,
          timestamp: c.timestamp,
        };
        break;
      }
    }
    // Check if swept any EQL / SSL
    for (const eq of equalLows) {
      if (c.low < eq.price && c.close > eq.price) {
        recentSweptLevel = {
          type: 'SSL',
          price: eq.price,
          sweptBy: eq.price - c.low,
          timestamp: c.timestamp,
        };
        break;
      }
    }
  }

  // 3. Targets (Internal vs External liquidity)
  const externalHigh = Math.max(...candles15m.slice(-30).map((c) => c.high));
  const externalLow = Math.min(...candles15m.slice(-30).map((c) => c.low));
  const externalLiquidityTarget = direction === 'BUY' ? externalHigh : externalLow;

  const internalLiquidityTarget =
    direction === 'BUY'
      ? (equalHighs.find((h) => h.price > currentPrice)?.price ?? (externalHigh + externalLow) / 2)
      : (equalLows.find((l) => l.price < currentPrice)?.price ?? (externalHigh + externalLow) / 2);

  // 4. Calculate bonus score
  let liquidityScoreBonus = 0;
  if (direction === 'BUY') {
    if (recentSweptLevel?.type === 'SSL') liquidityScoreBonus += 8; // Bullish sweep confluence
    if (equalHighs.some((h) => h.price > currentPrice)) liquidityScoreBonus += 4; // Magnet EQH target
  } else {
    if (recentSweptLevel?.type === 'BSL') liquidityScoreBonus += 8; // Bearish sweep confluence
    if (equalLows.some((l) => l.price < currentPrice)) liquidityScoreBonus += 4; // Magnet EQL target
  }

  const summary = [
    equalHighs.length > 0 ? `EQH (${equalHighs.length} pools at $${equalHighs[0].price.toFixed(2)})` : '',
    equalLows.length > 0 ? `EQL (${equalLows.length} pools at $${equalLows[0].price.toFixed(2)})` : '',
    recentSweptLevel ? `Recent ${recentSweptLevel.type} Sweep ($${recentSweptLevel.price.toFixed(2)})` : '',
  ]
    .filter(Boolean)
    .join(' | ') || 'Standard Liquidity Distribution';

  return {
    equalHighs,
    equalLows,
    recentSweptLevel,
    internalLiquidityTarget,
    externalLiquidityTarget,
    liquidityScoreBonus,
    summary,
  };
}

// ============================================================================
// 3. PULLBACK QUALITY ENGINE
// ============================================================================

/**
 * Assesses pullback health: retracement depth, speed, candle bodies, wicks, counter-trend momentum.
 * Works symmetrically for both bullish and bearish trends.
 */
export function assessPullbackQuality(
  direction: 'BUY' | 'SELL',
  candles5m: Candle[],
  indicators5m: TechnicalIndicators,
  regime: string
): PullbackAssessment {
  const reasons: string[] = [];
  const recent10 = candles5m.slice(-10);
  if (recent10.length < 5) {
    return {
      quality: 'ACCEPTABLE',
      retracementDepth: 0.5,
      speedRating: 'CONTROLLED',
      momentumContrast: 'NEUTRAL',
      candleCount: 3,
      volumeBehavior: 'AVERAGE',
      reasons: ['Default baseline pullback assessment (limited candle history)'],
    };
  }

  const swingHigh = indicators5m.swingHigh;
  const swingLow = indicators5m.swingLow;
  const swingRange = Math.max(1.0, swingHigh - swingLow);
  const currentPrice = recent10[recent10.length - 1].close;

  // Calculate retracement depth (0.0 to 1.0+)
  let retracementDepth = 0.5;
  if (direction === 'BUY') {
    // In an uptrend, pullback is downward from swingHigh towards swingLow
    retracementDepth = (swingHigh - currentPrice) / swingRange;
  } else {
    // In a downtrend, pullback is upward from swingLow towards swingHigh
    retracementDepth = (currentPrice - swingLow) / swingRange;
  }
  retracementDepth = Math.max(0, Math.min(1.5, retracementDepth));

  // Analyze the corrective candles (last 4–6 candles)
  const pullbackCandles = recent10.slice(-5);
  let counterTrendImpulseCount = 0;
  let correctiveCandleCount = 0;
  let avgPullbackBody = 0;

  for (const c of pullbackCandles) {
    const isBull = c.close >= c.open;
    const body = Math.abs(c.close - c.open);
    const range = Math.max(0.01, c.high - c.low);
    avgPullbackBody += body;

    const isCounterTrend = direction === 'BUY' ? !isBull : isBull;
    if (isCounterTrend && body > range * 0.65 && body > indicators5m.atr14 * 0.8) {
      counterTrendImpulseCount += 1;
    } else {
      correctiveCandleCount += 1;
    }
  }
  avgPullbackBody /= pullbackCandles.length;

  // Evaluate momentum & speed
  let speedRating: PullbackAssessment['speedRating'] = 'CONTROLLED';
  let momentumContrast: PullbackAssessment['momentumContrast'] = 'CORRECTIVE';

  if (counterTrendImpulseCount >= 3) {
    speedRating = 'FAST_IMPULSIVE';
    momentumContrast = 'COUNTER_IMPULSE';
    reasons.push('Aggressive counter-trend momentum impulse (3+ strong opposing bars)');
  } else if (avgPullbackBody < indicators5m.atr14 * 0.6) {
    speedRating = 'CONTROLLED';
    momentumContrast = 'CORRECTIVE';
    reasons.push('Controlled low-momentum corrective pullback (small candle bodies)');
  } else {
    speedRating = 'CONTROLLED';
    momentumContrast = 'NEUTRAL';
  }

  // Determine overall quality
  let quality: PullbackQuality = 'HEALTHY';

  if (retracementDepth >= 0.35 && retracementDepth <= 0.68 && momentumContrast === 'CORRECTIVE') {
    quality = 'HEALTHY';
    reasons.push(`Optimal Fibonacci retracement depth (${(retracementDepth * 100).toFixed(1)}%) with controlled deceleration`);
  } else if (retracementDepth >= 0.20 && retracementDepth <= 0.78 && momentumContrast !== 'COUNTER_IMPULSE') {
    quality = 'ACCEPTABLE';
    reasons.push(`Acceptable retracement depth (${(retracementDepth * 100).toFixed(1)}%)`);
  } else if (retracementDepth > 0.85 || momentumContrast === 'COUNTER_IMPULSE') {
    quality = 'INVALID';
    reasons.push(`Invalid pullback: Excessive retracement depth (${(retracementDepth * 100).toFixed(1)}%) or opposing impulse breaking structure`);
  } else {
    quality = 'WEAK';
    reasons.push(`Weak pullback: Shallow or over-extended (${(retracementDepth * 100).toFixed(1)}%)`);
  }

  return {
    quality,
    retracementDepth,
    speedRating,
    momentumContrast,
    candleCount: pullbackCandles.length,
    volumeBehavior: 'DECLINING_CORRECTIVE',
    reasons,
  };
}

// ============================================================================
// 4. ENTRY TIMING & OVEREXTENSION / ANTI-CHASE ENGINE
// ============================================================================

/**
 * Assesses entry timing relative to POI, ATR distance, and overextension
 */
export function assessEntryTimingAndAntiChase(
  direction: 'BUY' | 'SELL',
  strategyFamily: string,
  currentPrice: number,
  idealEntry: number,
  candles5m: Candle[],
  indicators5m: TechnicalIndicators,
  regime: string
): EntryTimingAssessment {
  const atr = Math.max(0.5, indicators5m.atr14 || 2.0);
  const distance = Math.abs(currentPrice - idealEntry);
  const distanceFromPoiAtr = Number((distance / atr).toFixed(2));

  // Evaluate displacement over last 3 candles
  const recent3 = candles5m.slice(-3);
  let totalDisplacement = 0;
  if (recent3.length >= 2) {
    const startPrice = recent3[0].open;
    const endPrice = recent3[recent3.length - 1].close;
    totalDisplacement = Math.abs(endPrice - startPrice);
  }
  const displacementAtr = Number((totalDisplacement / atr).toFixed(2));

  let timing: EntryTiming = 'OPTIMAL';
  let isChasing = false;
  let timingPenalty = 0;
  let reason = 'Optimal entry proximity to structural POI';

  // Strategy-aware tolerances
  const isBreakout = strategyFamily === 'RANGE_BREAKOUT_EXPANSION';
  const isSfp = strategyFamily === 'RANGE_SFP_REVERSAL' || strategyFamily === 'LIQUIDITY_SWEEP';

  if (isBreakout) {
    // Breakouts tolerate slightly larger displacement upon confirmation
    if (distanceFromPoiAtr <= 1.2) {
      timing = 'OPTIMAL';
      reason = `Optimal breakout expansion entry (within ${distanceFromPoiAtr} ATR of breakout level)`;
    } else if (distanceFromPoiAtr <= 2.2) {
      timing = 'ACCEPTABLE';
      timingPenalty = 8;
      reason = `Acceptable breakout entry (${distanceFromPoiAtr} ATR from trigger)`;
    } else if (distanceFromPoiAtr <= 3.2) {
      timing = 'LATE';
      timingPenalty = 20;
      isChasing = true;
      reason = `Late breakout entry (${distanceFromPoiAtr} ATR from trigger) - Risk of pullback retest`;
    } else {
      timing = 'CHASED';
      timingPenalty = 40;
      isChasing = true;
      reason = `Chased breakout expansion (${distanceFromPoiAtr} ATR displacement) - Disqualified`;
    }
  } else {
    // Pullback / Order Block / FVG / OTE setups demand tight execution near the POI
    if (distanceFromPoiAtr <= 0.8) {
      timing = 'OPTIMAL';
      reason = `Optimal entry at structural POI edge (${distanceFromPoiAtr} ATR)`;
    } else if (distanceFromPoiAtr <= 1.5) {
      timing = 'ACCEPTABLE';
      timingPenalty = 6;
      reason = `Acceptable entry near POI (${distanceFromPoiAtr} ATR)`;
    } else if (distanceFromPoiAtr <= 2.5) {
      timing = 'LATE';
      timingPenalty = 18;
      isChasing = true;
      reason = `Late entry: Price has displaced ${distanceFromPoiAtr} ATR away from ideal POI`;
    } else {
      timing = 'CHASED';
      timingPenalty = 35;
      isChasing = true;
      reason = `Chased entry (${distanceFromPoiAtr} ATR from POI) - Disqualified to prevent chasing`;
    }
  }

  // Check if market is strongly trending but overextended -> WAIT_FOR_PULLBACK
  if (indicators5m.regimeContext?.isOverextended && !isSfp && timing !== 'OPTIMAL') {
    isChasing = true;
    timingPenalty = Math.max(timingPenalty, 25);
    reason = `Market regime is overextended (${indicators5m.regimeContext.overextensionReason || 'Price far from EMA20'}). WAIT_FOR_PULLBACK recommended.`;
  }

  return {
    timing,
    distanceFromPoiAtr,
    displacementAtr,
    isChasing,
    timingPenalty,
    reason,
  };
}

// ============================================================================
// 5. PRICE ACTION TRIGGER ENGINE
// ============================================================================

/**
 * Detects concrete price action triggers:
 * Rejection wick, engulfing, displacement, micro-BOS, micro-CHOCH, pullback break
 */
export function assessPriceActionTrigger(
  direction: 'BUY' | 'SELL',
  candles5m: Candle[],
  candles1m: Candle[] = [],
  indicators5m: TechnicalIndicators
): TriggerAssessment {
  const allTriggers: PriceActionTriggerType[] = [];
  let confirmationScore = 0;
  const last5m = candles5m[candles5m.length - 1];
  const prev5m = candles5m[candles5m.length - 2];

  if (!last5m) {
    return {
      hasTrigger: false,
      primaryTrigger: null,
      allTriggers: [],
      triggerTimeframe: '5M',
      confirmationScore: 0,
      description: 'No candle data available for trigger validation',
    };
  }

  const isBull = last5m.close >= last5m.open;
  const body = Math.abs(last5m.close - last5m.open);
  const totalRange = Math.max(0.01, last5m.high - last5m.low);
  const upperWick = last5m.high - Math.max(last5m.open, last5m.close);
  const lowerWick = Math.min(last5m.open, last5m.close) - last5m.low;

  // 1. Rejection Wick
  let rejectionRatio = 0;
  if (direction === 'BUY') {
    rejectionRatio = lowerWick / totalRange;
    if (lowerWick > body * 1.3 && lowerWick > totalRange * 0.40) {
      allTriggers.push('REJECTION_WICK');
      confirmationScore += 12;
    }
  } else {
    rejectionRatio = upperWick / totalRange;
    if (upperWick > body * 1.3 && upperWick > totalRange * 0.40) {
      allTriggers.push('REJECTION_WICK');
      confirmationScore += 12;
    }
  }

  // 2. Engulfing / Strong Close
  if (direction === 'BUY') {
    if (isBull && body > totalRange * 0.60) {
      allTriggers.push('ENGULFING');
      confirmationScore += 10;
    }
    if (prev5m && last5m.close > prev5m.high) {
      allTriggers.push('STRONG_EXPANSION_CLOSE');
      confirmationScore += 8;
    }
  } else {
    if (!isBull && body > totalRange * 0.60) {
      allTriggers.push('ENGULFING');
      confirmationScore += 10;
    }
    if (prev5m && last5m.close < prev5m.low) {
      allTriggers.push('STRONG_EXPANSION_CLOSE');
      confirmationScore += 8;
    }
  }

  // 3. Displacement Candle (large body > 1.4x ATR or > 1.4x previous body)
  if (body > (indicators5m.atr14 || 2.0) * 0.8 && ((direction === 'BUY' && isBull) || (direction === 'SELL' && !isBull))) {
    allTriggers.push('DISPLACEMENT_CANDLE');
    confirmationScore += 8;
  }

  // 4. Micro-BOS / Micro-CHOCH (optional 1M or 5M minor structure shift)
  if (candles1m && candles1m.length >= 5) {
    const recent1m = candles1m.slice(-5);
    const prev1mHigh = Math.max(...recent1m.slice(0, -1).map((c) => c.high));
    const prev1mLow = Math.min(...recent1m.slice(0, -1).map((c) => c.low));
    const current1m = recent1m[recent1m.length - 1];

    if (direction === 'BUY' && current1m.close > prev1mHigh) {
      allTriggers.push('MICRO_BOS');
      confirmationScore += 6;
    } else if (direction === 'SELL' && current1m.close < prev1mLow) {
      allTriggers.push('MICRO_BOS');
      confirmationScore += 6;
    }
  }

  confirmationScore = Math.min(30, confirmationScore);
  const hasTrigger = allTriggers.length > 0;
  const primaryTrigger = allTriggers[0] ?? null;

  const description = hasTrigger
    ? `Confirmed price action trigger: ${allTriggers.join(' + ')} (Score: ${confirmationScore}/30)`
    : 'No active execution trigger confirmed on 5M candle';

  return {
    hasTrigger,
    primaryTrigger,
    allTriggers,
    triggerTimeframe: '5M',
    triggerCandleTime: last5m.timestamp,
    rejectionRatio: Number(rejectionRatio.toFixed(2)),
    confirmationScore,
    description,
  };
}

// ============================================================================
// 6. TP PATH CLEARANCE & OBSTACLE RUNWAY ENGINE
// ============================================================================

/**
 * Scans the price vector between Entry and TP1/TP2 for opposing obstacles
 */
export function assessTpPathRunway(
  direction: 'BUY' | 'SELL',
  entry: number,
  tp1: number,
  tp2: number,
  candles15m: Candle[],
  candles1h: Candle[],
  indicators15m: TechnicalIndicators,
  indicators1h: TechnicalIndicators
): TpPathAssessment {
  const obstacles: TpObstacle[] = [];
  const totalTargetDistance = Math.abs(tp1 - entry);
  if (totalTargetDistance <= 0.1) {
    return {
      runway: 'CLEAR',
      clearRunwayRatio: 1.0,
      obstacles: [],
      runwayScore: 20,
      description: 'Clear structural runway to target',
    };
  }

  // 1. Check opposing 15M / 1H Swing levels
  if (direction === 'BUY') {
    const swingHigh15m = indicators15m.swingHigh;
    if (swingHigh15m > entry && swingHigh15m < tp1) {
      const distance = swingHigh15m - entry;
      obstacles.push({
        type: '15M Swing High Resistance',
        price: swingHigh15m,
        distancePoints: Number((distance / 0.1).toFixed(1)),
        severity: distance < totalTargetDistance * 0.5 ? 'HIGH' : 'MEDIUM',
      });
    }

    // Check EMA200 obstacle
    if (indicators15m.ema200 > entry && indicators15m.ema200 < tp1) {
      const dist = indicators15m.ema200 - entry;
      obstacles.push({
        type: '15M EMA200 Barrier',
        price: indicators15m.ema200,
        distancePoints: Number((dist / 0.1).toFixed(1)),
        severity: 'HIGH',
      });
    }

    // Check opposing Bearish Order Block
    if (indicators15m.orderBlock?.type === 'BEARISH' && indicators15m.orderBlock.low > entry && indicators15m.orderBlock.low < tp1) {
      const dist = indicators15m.orderBlock.low - entry;
      obstacles.push({
        type: 'Opposing 15M Bearish Order Block',
        price: indicators15m.orderBlock.low,
        distancePoints: Number((dist / 0.1).toFixed(1)),
        severity: 'HIGH',
      });
    }
  } else {
    // SELL direction
    const swingLow15m = indicators15m.swingLow;
    if (swingLow15m < entry && swingLow15m > tp1) {
      const distance = entry - swingLow15m;
      obstacles.push({
        type: '15M Swing Low Support',
        price: swingLow15m,
        distancePoints: Number((distance / 0.1).toFixed(1)),
        severity: distance < totalTargetDistance * 0.5 ? 'HIGH' : 'MEDIUM',
      });
    }

    // Check EMA200 obstacle
    if (indicators15m.ema200 < entry && indicators15m.ema200 > tp1) {
      const dist = entry - indicators15m.ema200;
      obstacles.push({
        type: '15M EMA200 Barrier',
        price: indicators15m.ema200,
        distancePoints: Number((dist / 0.1).toFixed(1)),
        severity: 'HIGH',
      });
    }

    // Check opposing Bullish Order Block
    if (indicators15m.orderBlock?.type === 'BULLISH' && indicators15m.orderBlock.high < entry && indicators15m.orderBlock.high > tp1) {
      const dist = entry - indicators15m.orderBlock.high;
      obstacles.push({
        type: 'Opposing 15M Bullish Order Block',
        price: indicators15m.orderBlock.high,
        distancePoints: Number((dist / 0.1).toFixed(1)),
        severity: 'HIGH',
      });
    }
  }

  // Calculate clear runway ratio
  let clearRunwayRatio = 1.0;
  if (obstacles.length > 0) {
    const closestObstacleDist = Math.min(...obstacles.map((o) => o.distancePoints * 0.1));
    clearRunwayRatio = Number((closestObstacleDist / totalTargetDistance).toFixed(2));
  }

  let runway: TpPathRunway = 'CLEAR';
  let runwayScore = 20;
  let description = 'Clear runway to TP1 without major structural barriers';

  if (obstacles.some((o) => o.severity === 'HIGH' && o.distancePoints * 0.1 < totalTargetDistance * 0.45)) {
    runway = 'BLOCKED';
    runwayScore = 3;
    description = `Blocked TP runway: Major opposing obstacle (${obstacles[0].type} at $${obstacles[0].price.toFixed(2)}) lies directly before TP1`;
  } else if (obstacles.length >= 2 || clearRunwayRatio < 0.65) {
    runway = 'MAJOR_OBSTACLE';
    runwayScore = 8;
    description = `Major obstacle in TP path (${obstacles[0].type} at $${obstacles[0].price.toFixed(2)}) limiting runway`;
  } else if (obstacles.length === 1) {
    runway = 'MINOR_OBSTACLE';
    runwayScore = 14;
    description = `Minor obstacle near target (${obstacles[0].type} at $${obstacles[0].price.toFixed(2)})`;
  }

  return {
    runway,
    clearRunwayRatio,
    obstacles,
    runwayScore,
    description,
  };
}

// ============================================================================
// 7. STOP LOSS QUALITY CHECKER
// ============================================================================

export function assessStopLossQuality(
  direction: 'BUY' | 'SELL',
  entry: number,
  stopLoss: number,
  indicators5m: TechnicalIndicators,
  minSlPoints: number = 35,
  maxSlPoints: number = 65
): { isValid: boolean; slPoints: number; slQualityScore: number; reason: string } {
  const slDistance = Math.abs(entry - stopLoss);
  const slPoints = Number((slDistance / 0.1).toFixed(1));

  let isValid = true;
  let slQualityScore = 10;
  let reason = 'Solid structural stop loss placement beyond invalidation level';

  if (slPoints < minSlPoints) {
    isValid = false;
    slQualityScore = 2;
    reason = `SL too tight (${slPoints} pts < minimum ${minSlPoints} pts floor) - Vulnerable to spread/noise`;
  } else if (slPoints > maxSlPoints) {
    isValid = false;
    slQualityScore = 3;
    reason = `SL too wide (${slPoints} pts > maximum ${maxSlPoints} pts ceiling) - Inefficient R:R`;
  } else {
    // Check if SL sits correctly beyond the swing extreme
    if (direction === 'BUY' && stopLoss >= entry) {
      isValid = false;
      slQualityScore = 0;
      reason = 'Invalid SL: Stop loss is above buy entry';
    } else if (direction === 'SELL' && stopLoss <= entry) {
      isValid = false;
      slQualityScore = 0;
      reason = 'Invalid SL: Stop loss is below sell entry';
    }
  }

  return { isValid, slPoints, slQualityScore, reason };
}

// ============================================================================
// 8. FINAL EXECUTION QUALITY SCORE (0–100)
// ============================================================================

export interface ExecutionQualityInputs {
  timingAssessment: EntryTimingAssessment;
  triggerAssessment: TriggerAssessment;
  tpPathAssessment: TpPathAssessment;
  pullbackAssessment: PullbackAssessment;
  poiFreshness: { multiplier: number; state: PoiFreshnessState };
  slQuality: { isValid: boolean; slQualityScore: number };
  liquidityBonus: number;
}

/**
 * Calculates the operational Execution Quality Score (0–100)
 * Evaluates the quality of executing the trade NOW, separate from the structural Strategy Confidence.
 */
export function calculateExecutionQualityScore(inputs: ExecutionQualityInputs): {
  score: number;
  breakdown: {
    timingScore: number;
    triggerScore: number;
    runwayScore: number;
    pullbackScore: number;
    freshnessScore: number;
    slScore: number;
  };
  summary: string;
} {
  const { timingAssessment, triggerAssessment, tpPathAssessment, pullbackAssessment, poiFreshness, slQuality, liquidityBonus } = inputs;

  // Timing (0–25 pts)
  let timingScore = 25;
  if (timingAssessment.timing === 'OPTIMAL') timingScore = 25;
  else if (timingAssessment.timing === 'ACCEPTABLE') timingScore = 18;
  else if (timingAssessment.timing === 'LATE') timingScore = 10;
  else if (timingAssessment.timing === 'CHASED') timingScore = 0;
  timingScore = Math.max(0, timingScore - timingAssessment.timingPenalty);

  // Trigger Confirmation (0–25 pts)
  const triggerScore = Math.min(25, triggerAssessment.confirmationScore * 0.85);

  // TP Runway (0–20 pts)
  const runwayScore = tpPathAssessment.runwayScore;

  // Pullback Quality (0–15 pts)
  let pullbackScore = 15;
  if (pullbackAssessment.quality === 'HEALTHY') pullbackScore = 15;
  else if (pullbackAssessment.quality === 'ACCEPTABLE') pullbackScore = 11;
  else if (pullbackAssessment.quality === 'WEAK') pullbackScore = 5;
  else if (pullbackAssessment.quality === 'INVALID') pullbackScore = 0;

  // Setup Freshness (0–10 pts)
  const freshnessScore = Math.round(10 * poiFreshness.multiplier);

  // Stop Loss Quality (0–5 pts)
  const slScore = Math.min(5, Math.round(slQuality.slQualityScore * 0.5));

  const totalRaw = timingScore + triggerScore + runwayScore + pullbackScore + freshnessScore + slScore + Math.min(5, liquidityBonus);
  const finalScore = Math.max(0, Math.min(100, Math.round(totalRaw)));

  const summary = `Execution Quality: ${finalScore}/100 | Timing: ${timingAssessment.timing} | Trigger: ${triggerAssessment.primaryTrigger ?? 'None'} | Runway: ${tpPathAssessment.runway} | Freshness: ${poiFreshness.state}`;

  return {
    score: finalScore,
    breakdown: {
      timingScore,
      triggerScore,
      runwayScore,
      pullbackScore,
      freshnessScore,
      slScore,
    },
    summary,
  };
}

// ============================================================================
// 9. SETUP LIFECYCLE STATE MACHINE
// ============================================================================

export class CandidateLifecycleManager {
  private lifecycles: Map<string, CandidateLifecycleRecord> = new Map();

  constructor(initialRecords: CandidateLifecycleRecord[] = []) {
    for (const r of initialRecords) {
      this.lifecycles.set(r.id, r);
    }
  }

  public generateCandidateKey(setupName: string, direction: 'BUY' | 'SELL', entryPrice: number): string {
    const roundEntry = Math.round(entryPrice * 2) / 2; // Cluster within 0.5 pts
    return `cand_${setupName.replace(/\s+/g, '_').toLowerCase()}_${direction}_${roundEntry}`;
  }

  /**
   * Updates or registers candidate lifecycle state:
   * WATCHING -> DEVELOPING -> READY -> TRIGGERED -> INVALIDATED
   */
  public updateLifecycle(
    setupName: string,
    strategyFamily: string,
    direction: 'BUY' | 'SELL',
    timeframe: string,
    entryProposed: number,
    stopLoss: number,
    tp1: number,
    tp2: number,
    poiId: string | undefined,
    timingAssessment: EntryTimingAssessment,
    triggerAssessment: TriggerAssessment,
    pullbackAssessment: PullbackAssessment,
    poiFreshnessState: PoiFreshnessState,
    executionQualityScore: number,
    strategyConfidence: number
  ): { state: CandidateLifecycleState; record: CandidateLifecycleRecord; isExecutableNow: boolean } {
    const key = this.generateCandidateKey(setupName, direction, entryProposed);
    const existing = this.lifecycles.get(key);
    const now = Date.now();

    let state: CandidateLifecycleState = 'WATCHING';
    let rejectionReason: string | undefined = undefined;

    if (poiFreshnessState === 'INVALIDATED' || pullbackAssessment.quality === 'INVALID') {
      state = 'INVALIDATED';
      rejectionReason = poiFreshnessState === 'INVALIDATED' ? 'POI Invalidated' : 'Pullback Structure Invalid';
    } else if (timingAssessment.timing === 'CHASED') {
      state = 'INVALIDATED';
      rejectionReason = 'Chased entry - Disqualified';
    } else if (!triggerAssessment.hasTrigger) {
      if (timingAssessment.timing === 'OPTIMAL' || timingAssessment.timing === 'ACCEPTABLE') {
        state = 'READY'; // All conditions ready, waiting for 5M execution trigger
      } else {
        state = 'DEVELOPING'; // Setup forming, approaching zone
      }
    } else {
      // Trigger is present!
      if (executionQualityScore >= 60 && strategyConfidence >= 70 && poiFreshnessState !== 'EXHAUSTED') {
        state = 'TRIGGERED'; // Fully qualified live execution candidate
      } else {
        state = 'DEVELOPING';
        rejectionReason = `Execution quality (${executionQualityScore}) or confidence (${strategyConfidence}) below threshold`;
      }
    }

    const record: CandidateLifecycleRecord = {
      id: key,
      setupName,
      strategyFamily,
      direction,
      timeframe,
      poiId,
      state,
      firstObservedTime: existing ? existing.firstObservedTime : now,
      lastUpdatedTime: now,
      entryProposed,
      stopLoss,
      tp1,
      tp2,
      triggersDetected: triggerAssessment.allTriggers,
      rejectionReason,
      executionQualityScore,
      strategyConfidence,
    };

    this.lifecycles.set(key, record);
    const isExecutableNow = state === 'TRIGGERED';

    return { state, record, isExecutableNow };
  }

  public getAllLifecycles(): CandidateLifecycleRecord[] {
    return Array.from(this.lifecycles.values());
  }

  public setLifecycles(records: CandidateLifecycleRecord[]) {
    this.lifecycles.clear();
    for (const r of records) {
      this.lifecycles.set(r.id, r);
    }
  }

  /**
   * Prunes stale candidate lifecycle records older than 4 hours
   */
  public pruneStaleRecords(maxAgeMs = 4 * 3600 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, r] of this.lifecycles.entries()) {
      if (r.lastUpdatedTime < cutoff) {
        this.lifecycles.delete(id);
      }
    }
  }
}

export const globalLifecycleManager = new CandidateLifecycleManager();

/**
 * Infers strategy family from setup name if not explicitly set
 */
export function inferStrategyFamily(setupName: string): StrategyFamily {
  const s = (setupName || '').toUpperCase();
  if (s.includes('ORDER BLOCK') || s.includes('OB ')) return 'ORDER_BLOCK';
  if (s.includes('FAIR VALUE GAP') || s.includes('FVG')) return 'FVG_IMBALANCE';
  if (s.includes('LIQUIDITY SWEEP') || s.includes('BSL') || s.includes('SSL')) return 'LIQUIDITY_SWEEP';
  if (s.includes('OTE') || s.includes('FIBONACCI')) return 'FIBONACCI_OTE';
  if (s.includes('BREAK AND RETEST') || s.includes('BREAK & RETEST')) return 'BREAK_AND_RETEST';
  if (s.includes('COUNTERTREND') || s.includes('PULLBACK SCALP')) return 'COUNTERTREND_SCALP';
  if (s.includes('FAILED BREAKOUT') || s.includes('TRAP')) return 'FAILED_BREAKOUT';
  if (s.includes('RANGE SFP') || s.includes('SWING FAILURE')) return 'RANGE_SFP_REVERSAL';
  if (s.includes('RANGE BREAKOUT') || s.includes('EXPANSION')) return 'RANGE_BREAKOUT_EXPANSION';
  return 'MARKET_STRUCTURE';
}

/**
 * Evaluates structural same-setup identity between an active trade and a new candidate signal.
 * Determines if the candidate is a genuine independent setup, an identical duplicate, or a re-entry on the same structural leg.
 */
export function checkStructuralSameSetupIdentity(
  activeSignal: TradeSignal | null,
  candidateSignal: TradeSignal,
  tolerance = 1.5
): {
  isDuplicate: boolean;
  isReentry: boolean;
  status: 'QUALIFIED_SIGNAL' | 'DUPLICATE_ACTIVE' | 'DUPLICATE_ACTIVE_REENTRY';
  details?: DuplicateDetails;
  reason?: string;
} {
  if (!activeSignal || activeSignal.signal === 'NO TRADE' || candidateSignal.signal === 'NO TRADE') {
    return { isDuplicate: false, isReentry: false, status: 'QUALIFIED_SIGNAL' };
  }

  // Check if both signals are in the SAME direction
  const activeIsBuy = activeSignal.signal.toUpperCase().includes('BUY');
  const candIsBuy = candidateSignal.signal.toUpperCase().includes('BUY');
  if (activeIsBuy !== candIsBuy) {
    // Opposite direction is handled by the Active Trade Opposition Guard
    return { isDuplicate: false, isReentry: false, status: 'QUALIFIED_SIGNAL' };
  }

  const activeStrategyFamily = (activeSignal.strategyFamily as string) || inferStrategyFamily(activeSignal.setup);
  const candidateStrategyFamily = (candidateSignal.strategyFamily as string) || inferStrategyFamily(candidateSignal.setup);
  const sameStrategyFamily = activeStrategyFamily === candidateStrategyFamily || activeSignal.setup === candidateSignal.setup;

  const samePoi = !!(
    (activeSignal.poiId && candidateSignal.poiId && activeSignal.poiId === candidateSignal.poiId) ||
    (activeSignal.setup === candidateSignal.setup && Math.abs(activeSignal.stopLoss - candidateSignal.stopLoss) <= tolerance)
  );

  const sameStructuralOrigin = Math.abs(activeSignal.stopLoss - candidateSignal.stopLoss) <= tolerance;

  const sameTargetObjective =
    Math.abs(activeSignal.tp1 - candidateSignal.tp1) <= tolerance ||
    Math.abs(activeSignal.tp2 - candidateSignal.tp2) <= tolerance;

  const sameLifecycle = !!(
    activeSignal.lifecycleState &&
    candidateSignal.lifecycleState &&
    activeSignal.lifecycleState === candidateSignal.lifecycleState
  );

  const entryDistance = Number(Math.abs(activeSignal.entry - candidateSignal.entry).toFixed(2));

  const details: DuplicateDetails = {
    duplicateReason: 'DUPLICATE_ACTIVE',
    activeSignalId: activeSignal.id,
    candidateSignalId: candidateSignal.id,
    activeStrategyFamily,
    candidateStrategyFamily,
    samePoi,
    sameStructuralOrigin,
    sameTargetObjective,
    sameLifecycle,
    entryDistance,
  };

  // 1. Literal exact duplicate (same setup name and entry within tolerance)
  if (activeSignal.setup === candidateSignal.setup && entryDistance <= tolerance) {
    details.duplicateReason = 'DUPLICATE_ACTIVE';
    return {
      isDuplicate: true,
      isReentry: false,
      status: 'DUPLICATE_ACTIVE',
      details,
      reason: `تم رصد نفس الصفقة النشطة (${activeSignal.setup}) بفارق سعر دخول ضئيل ($${entryDistance}). تم منع تكرار الإشارة.`,
    };
  }

  // 2. Structural same-setup re-entry (Same strategy family + same POI or structural origin + same target objective)
  // Even if entry distance > $1.50 (e.g. price retraced away and re-tested the same zone), this is part of the same trade lifecycle
  if (sameStrategyFamily && (samePoi || sameStructuralOrigin) && sameTargetObjective) {
    details.duplicateReason = 'DUPLICATE_ACTIVE_REENTRY';
    return {
      isDuplicate: true,
      isReentry: true,
      status: 'DUPLICATE_ACTIVE_REENTRY',
      details,
      reason: `تم رصد إعادة دخول (Re-entry) لنفس الصفقة النشطة الجارية (${activeSignal.setup}) بنفس الأهداف ($${activeSignal.tp1}/$${activeSignal.tp2}) ونفس الأصل الهيكلي ($${activeSignal.stopLoss}). تم حظر التكرار حتى اكتمال الصفقة الأصلية.`,
    };
  }

  // Genuinely independent setup in same direction
  return { isDuplicate: false, isReentry: false, status: 'QUALIFIED_SIGNAL', details };
}

