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
  TradeOpportunity,
} from '../src/types.js';
import { storage } from './storage.js';
import { partition5mCandles } from './candleUtils.js';
import { hasConfirmedReversalStructure } from './indicators.js';

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

  public clear(): void {
    this.pois.clear();
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
    const isBull = c.close > c.open;
    const isBear = c.close < c.open;
    const body = Math.abs(c.close - c.open);
    const range = Math.max(0.01, c.high - c.low);
    avgPullbackBody += body;

    const isCounterTrend = direction === 'BUY' ? isBear : isBull;
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
  regime: string,
  poiContext?: {
    top?: number;
    bottom?: number;
    poiPrice?: number;
    invalidationPrice?: number;
    type?: string;
  },
  candles1m?: Candle[],
  currentSpread?: number
): EntryTimingAssessment {
  const atr = Math.max(0.5, indicators5m.atr14 || 2.0);

  // Calculate distance from structural POI
  let distanceFromPoi = Math.abs(currentPrice - idealEntry);
  if (poiContext) {
    const poiTop = poiContext.top ?? poiContext.poiPrice ?? idealEntry;
    const poiBottom = poiContext.bottom ?? poiContext.poiPrice ?? idealEntry;

    if (direction === 'BUY') {
      if (currentPrice >= poiBottom && currentPrice <= poiTop) {
        distanceFromPoi = 0;
      } else if (currentPrice > poiTop) {
        distanceFromPoi = currentPrice - poiTop;
      } else {
        distanceFromPoi = poiBottom - currentPrice;
      }
    } else {
      // SELL
      if (currentPrice >= poiBottom && currentPrice <= poiTop) {
        distanceFromPoi = 0;
      } else if (currentPrice < poiBottom) {
        distanceFromPoi = poiBottom - currentPrice;
      } else {
        distanceFromPoi = currentPrice - poiTop;
      }
    }
  }

  const distanceFromPoiAtr = Number((distanceFromPoi / atr).toFixed(2));

  // Evaluate displacement over last 1-3 candles
  const recent3 = candles5m.slice(-3);
  let totalDisplacement = 0;
  let netDisplacementDirection: 'UP' | 'DOWN' | 'NONE' = 'NONE';
  if (recent3.length >= 1) {
    const lastC = recent3[recent3.length - 1];
    const prevC = recent3.length >= 2 ? recent3[recent3.length - 2] : lastC;
    const startC = recent3[0];

    const disp1 = Math.abs(lastC.close - lastC.open);
    const disp2 = Math.abs(lastC.close - prevC.open);
    const disp3 = Math.abs(lastC.close - startC.open);
    totalDisplacement = Math.max(disp1, disp2, disp3);

    if (lastC.close > startC.open + 0.1 || lastC.close > prevC.open + 0.1) netDisplacementDirection = 'UP';
    else if (lastC.close < startC.open - 0.1 || lastC.close < prevC.open - 0.1) netDisplacementDirection = 'DOWN';
  }
  const displacementAtr = Number((totalDisplacement / atr).toFixed(2));

  let timing: EntryTiming = 'OPTIMAL';
  let isChasing = false;
  let timingPenalty = 0;
  let reason = 'Optimal entry proximity to structural POI';

  // Strategy-aware tolerances
  const isBreakout = strategyFamily === 'RANGE_BREAKOUT_EXPANSION' || strategyFamily === 'BREAK_AND_RETEST';
  const isSfp =
    strategyFamily === 'RANGE_SFP_REVERSAL' ||
    strategyFamily === 'LIQUIDITY_SWEEP' ||
    strategyFamily === 'DOUBLE_TOP_BOTTOM' ||
    strategyFamily === 'BARE_SR';

  // Check for late displacement entry:
  // A strong displacement candle/move confirmed direction, but price has already expanded away from the POI without a pullback
  const isDisplacementInTradeDirection =
    (direction === 'BUY' && netDisplacementDirection === 'UP') ||
    (direction === 'SELL' && netDisplacementDirection === 'DOWN');

  if (isBreakout || isSfp) {
    // Breakouts and SFP / Liquidity sweeps tolerate slightly larger confirmation displacement
    if (distanceFromPoiAtr <= 1.2) {
      timing = 'OPTIMAL';
      reason = `Optimal ${isBreakout ? 'breakout expansion' : 'sweep reversal'} entry (within ${distanceFromPoiAtr} ATR of trigger)`;
    } else if (distanceFromPoiAtr <= 2.2) {
      timing = 'ACCEPTABLE';
      timingPenalty = 8;
      reason = `Acceptable ${isBreakout ? 'breakout' : 'sweep reversal'} entry (${distanceFromPoiAtr} ATR from trigger)`;
    } else if (distanceFromPoiAtr <= 3.2) {
      timing = 'LATE';
      timingPenalty = 20;
      isChasing = true;
      reason = `Late ${isBreakout ? 'breakout' : 'sweep reversal'} entry (${distanceFromPoiAtr} ATR from trigger) - Risk of pullback retest`;
    } else {
      timing = 'CHASED';
      timingPenalty = 40;
      isChasing = true;
      reason = `Chased ${isBreakout ? 'breakout expansion' : 'sweep reversal'} (${distanceFromPoiAtr} ATR displacement) - Disqualified`;
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
    } else if (distanceFromPoiAtr <= 2.0) {
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

    // FIX 2: If recent candles exhibited strong displacement in trade direction and price is extended (> 1.2 ATR away without pullback)
    if (isDisplacementInTradeDirection && displacementAtr >= 1.2 && distanceFromPoiAtr > 1.2) {
      timing = 'CHASED';
      isChasing = true;
      timingPenalty = Math.max(timingPenalty, 30);
      reason = `Late displacement entry: Price displaced ${displacementAtr} ATR away from POI without a pullback (${distanceFromPoiAtr} ATR from POI)`;
    }
  }

  // FIX 6: 1M micro-structure timing refinement vs runaway expansion confirmation
  if (candles1m && candles1m.length >= 5) {
    const recent5_1m = candles1m.slice(-5);
    const m1Start = recent5_1m[0].open;
    const m1End = recent5_1m[recent5_1m.length - 1].close;
    const m1Displacement = Math.abs(m1End - m1Start);
    const m1DisplacementAtr = m1Displacement / atr;

    if (direction === 'BUY') {
      const isRunaway1m = m1End > m1Start + 0.1 && m1DisplacementAtr >= 1.0 && distanceFromPoiAtr > 1.2;
      if (isRunaway1m) {
        timing = 'CHASED';
        isChasing = true;
        timingPenalty = Math.max(timingPenalty, 35);
        reason = `1M micro-structure confirms active runaway expansion away from POI (${m1DisplacementAtr.toFixed(1)} ATR) - Chased entry`;
      } else if (distanceFromPoiAtr <= 0.8 && timing !== 'CHASED') {
        timing = 'OPTIMAL';
        reason = `Optimal entry: 1M micro-pullback retest confirmed near structural POI (${distanceFromPoiAtr} ATR)`;
      }
    } else {
      // SELL
      const isRunaway1m = m1End < m1Start - 0.1 && m1DisplacementAtr >= 1.0 && distanceFromPoiAtr > 1.2;
      if (isRunaway1m) {
        timing = 'CHASED';
        isChasing = true;
        timingPenalty = Math.max(timingPenalty, 35);
        reason = `1M micro-structure confirms active runaway expansion away from POI (${m1DisplacementAtr.toFixed(1)} ATR) - Chased entry`;
      } else if (distanceFromPoiAtr <= 0.8 && timing !== 'CHASED') {
        timing = 'OPTIMAL';
        reason = `Optimal entry: 1M micro-pullback retest confirmed near structural POI (${distanceFromPoiAtr} ATR)`;
      }
    }
  }

  // FIX 4: Spread impact on entry quality
  if (currentSpread !== undefined) {
    if (isNaN(currentSpread) || currentSpread <= 0) {
      timing = 'CHASED';
      isChasing = true;
      timingPenalty = Math.max(timingPenalty, 40);
      reason = 'SPREAD_INVALID: Spread value is non-positive or invalid';
    } else {
      const spreadPts = currentSpread / 0.1;
      if (spreadPts > 12.0 || currentSpread / atr > 0.45) {
        timing = 'CHASED';
        isChasing = true;
        timingPenalty = Math.max(timingPenalty, 35);
        reason = `SPREAD_EXCESSIVE: Spread (${spreadPts.toFixed(1)} pts) degrades structural entry quality beyond acceptable limit`;
      }
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
  indicators5m: TechnicalIndicators,
  referenceTime?: number
): TriggerAssessment {
  const allTriggers: PriceActionTriggerType[] = [];
  let confirmationScore = 0;

  // FIX 1: Enforce closed 5M candle requirement. NEVER evaluate trigger on forming candle.
  const partition = partition5mCandles(candles5m, referenceTime);
  if (!partition.isValid || !partition.lastClosedCandle) {
    return {
      hasTrigger: false,
      primaryTrigger: null,
      allTriggers: [],
      triggerTimeframe: '5M',
      confirmationScore: 0,
      description: partition.unreliableReason || 'Cannot reliably confirm closed 5M candle for price-action trigger',
    };
  }

  const last5m = partition.lastClosedCandle;
  const prev5m = partition.prevClosedCandle;

  const isBull = last5m.close > last5m.open;
  const isBear = last5m.close < last5m.open;
  const body = Math.abs(last5m.close - last5m.open);
  const totalRange = Math.max(0.01, last5m.high - last5m.low);
  const upperWick = last5m.high - Math.max(last5m.open, last5m.close);
  const lowerWick = Math.min(last5m.open, last5m.close) - last5m.low;

  // 1. Rejection Wick (Dominant wick relative to body, range, and opposing wick)
  let rejectionRatio = 0;
  let wickScore = 0;
  if (direction === 'BUY') {
    rejectionRatio = lowerWick / totalRange;
    if (lowerWick > body * 1.3 && lowerWick > totalRange * 0.40 && lowerWick > upperWick * 1.4) {
      allTriggers.push('REJECTION_WICK');
      wickScore = 12;
    }
  } else {
    rejectionRatio = upperWick / totalRange;
    if (upperWick > body * 1.3 && upperWick > totalRange * 0.40 && upperWick > lowerWick * 1.4) {
      allTriggers.push('REJECTION_WICK');
      wickScore = 12;
    }
  }

  // 2. Body Expansion & Displacement (Unified category to prevent double/triple counting the same 5M candle)
  let bodyScore = 0;
  const isAtrDisplacement = body > (indicators5m?.atr14 || 2.0) * 0.8;
  if (direction === 'BUY') {
    const isEngulfing = isBull && body > totalRange * 0.60;
    const isExpansionClose = prev5m && last5m.close > prev5m.high;
    const isDisplacement = isAtrDisplacement && isBull;

    if (isEngulfing) allTriggers.push('ENGULFING');
    if (isExpansionClose) allTriggers.push('STRONG_EXPANSION_CLOSE');
    if (isDisplacement) allTriggers.push('DISPLACEMENT_CANDLE');

    // Prevent duplicate counting: single candle body expansion contributes once
    if (isDisplacement && isEngulfing) {
      bodyScore = 12;
    } else if (isEngulfing || isDisplacement) {
      bodyScore = 10;
    } else if (isExpansionClose) {
      bodyScore = 8;
    }
  } else {
    const isEngulfing = isBear && body > totalRange * 0.60;
    const isExpansionClose = prev5m && last5m.close < prev5m.low;
    const isDisplacement = isAtrDisplacement && isBear;

    if (isEngulfing) allTriggers.push('ENGULFING');
    if (isExpansionClose) allTriggers.push('STRONG_EXPANSION_CLOSE');
    if (isDisplacement) allTriggers.push('DISPLACEMENT_CANDLE');

    // Prevent duplicate counting: single candle body expansion contributes once
    if (isDisplacement && isEngulfing) {
      bodyScore = 12;
    } else if (isEngulfing || isDisplacement) {
      bodyScore = 10;
    } else if (isExpansionClose) {
      bodyScore = 8;
    }
  }

  // 3. Micro-BOS / Micro-CHOCH (distinct multi-candle structure shift)
  let microBosScore = 0;
  if (candles1m && candles1m.length >= 5) {
    const recent1m = candles1m.slice(-5);
    const prev1mHigh = Math.max(...recent1m.slice(0, -1).map((c) => c.high));
    const prev1mLow = Math.min(...recent1m.slice(0, -1).map((c) => c.low));
    const current1m = recent1m[recent1m.length - 1];

    if (direction === 'BUY' && current1m.close > prev1mHigh) {
      allTriggers.push('MICRO_BOS');
      microBosScore = 6;
    } else if (direction === 'SELL' && current1m.close < prev1mLow) {
      allTriggers.push('MICRO_BOS');
      microBosScore = 6;
    }
  }

  // Confluence score combines independent factors (Wick + Body + Micro-structure)
  confirmationScore = Math.min(30, wickScore + bodyScore + microBosScore);
  const hasTrigger = allTriggers.length > 0;
  const primaryTrigger = allTriggers[0] ?? null;

  const description = hasTrigger
    ? `Confirmed on closed 5M candle: ${allTriggers.join(' + ')} (Score: ${confirmationScore}/30)`
    : 'No active execution trigger confirmed on closed 5M candle';

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
  private terminalFailedKeys: Set<string> = new Set();

  constructor(initialRecords: CandidateLifecycleRecord[] = []) {
    for (const r of initialRecords) {
      this.lifecycles.set(r.id, r);
      if (r.state === 'FAILED' || r.state === 'INVALIDATED') {
        this.terminalFailedKeys.add(r.id);
      }
    }
  }

  public clear(): void {
    this.lifecycles.clear();
    this.terminalFailedKeys.clear();
  }

  public generateCandidateKey(
    setupName: string,
    direction: 'BUY' | 'SELL',
    entryPrice: number,
    patternMetadata?: any,
    poiId?: string
  ): string {
    if (patternMetadata?.patternAnchorKey) {
      return `cand_${patternMetadata.patternAnchorKey}`;
    }
    if (patternMetadata?.pivot1Time) {
      return `cand_s10_${direction}_${patternMetadata.pivot1Time}`;
    }
    if (poiId) {
      return `cand_poi_${poiId}`;
    }
    const cleanSetup = setupName.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const clusterPrice = Math.round(entryPrice * 0.2) / 0.2; // 5 pt cluster
    return `cand_${cleanSetup}_${direction}_${clusterPrice}`;
  }

  /**
   * Updates or registers candidate lifecycle state:
   * IDENTIFIED -> WATCHING -> DEVELOPING -> READY -> TRIGGERED -> ACTIVE -> COMPLETED / FAILED / INVALIDATED
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
    strategyConfidence: number,
    patternMetadata?: any
  ): { state: CandidateLifecycleState; record: CandidateLifecycleRecord; isExecutableNow: boolean } {
    const key = this.generateCandidateKey(setupName, direction, entryProposed, patternMetadata, poiId);
    const existing = this.lifecycles.get(key);
    const now = Date.now();

    // If previously marked FAILED or INVALIDATED, preserve terminal state
    if (existing && (existing.state === 'FAILED' || existing.state === 'INVALIDATED')) {
      return { state: existing.state, record: existing, isExecutableNow: false };
    }

    let state: CandidateLifecycleState = 'WATCHING';
    let rejectionReason: string | undefined = undefined;

    if (poiFreshnessState === 'INVALIDATED' || pullbackAssessment.quality === 'INVALID') {
      state = 'INVALIDATED';
      rejectionReason = poiFreshnessState === 'INVALIDATED' ? 'POI Invalidated' : 'Pullback Structure Invalid';
      this.terminalFailedKeys.add(key);
    } else if (timingAssessment.timing === 'CHASED') {
      state = 'INVALIDATED';
      rejectionReason = 'Chased entry - Disqualified';
      this.terminalFailedKeys.add(key);
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

  public markSetupFailed(keyOrSignal: string | any, reason = 'Stopped out / Setup Failed'): void {
    let key = typeof keyOrSignal === 'string' ? keyOrSignal : '';
    let setupName = 'Setup';
    let direction: 'BUY' | 'SELL' = 'SELL';
    let entry = 0;
    let patternMetadata: any = undefined;
    let poiId: string | undefined = undefined;

    if (typeof keyOrSignal === 'object' && keyOrSignal !== null) {
      setupName = keyOrSignal.setup || keyOrSignal.setupName || 'Setup';
      direction = keyOrSignal.signal?.includes('BUY') || keyOrSignal.direction?.includes('BUY') ? 'BUY' : 'SELL';
      entry = keyOrSignal.entry || keyOrSignal.entryProposed || 0;
      patternMetadata = keyOrSignal.patternMetadata;
      poiId = keyOrSignal.poiId;
      key = this.generateCandidateKey(setupName, direction, entry, patternMetadata, poiId);
    }

    if (!key) return;

    this.terminalFailedKeys.add(key);
    storage.saveTerminalSetup(key);
    const anchorKey = patternMetadata?.patternAnchorKey || (keyOrSignal as any)?.structuralAnchorKey;
    if (anchorKey) {
      this.terminalFailedKeys.add(`cand_${anchorKey}`);
      this.terminalFailedKeys.add(anchorKey);
      storage.saveTerminalSetup(`cand_${anchorKey}`);
      storage.saveTerminalSetup(anchorKey);
    }
    const now = Date.now();
    const existing = this.lifecycles.get(key);
    if (existing) {
      existing.state = 'FAILED';
      existing.rejectionReason = reason;
      existing.lastUpdatedTime = now;
      this.lifecycles.set(key, existing);
    } else {
      const record: CandidateLifecycleRecord = {
        id: key,
        setupName,
        strategyFamily: patternMetadata?.strategyFamily || 'DOUBLE_TOP_BOTTOM',
        direction,
        timeframe: keyOrSignal?.timeframe || '15M / 5M',
        poiId,
        state: 'FAILED',
        firstObservedTime: now,
        lastUpdatedTime: now,
        entryProposed: entry,
        stopLoss: keyOrSignal?.stopLoss || keyOrSignal?.sl || 0,
        tp1: keyOrSignal?.tp1 || 0,
        tp2: keyOrSignal?.tp2 || 0,
        triggersDetected: [],
        rejectionReason: reason,
        executionQualityScore: 0,
        strategyConfidence: keyOrSignal?.confidence || 0,
      };
      this.lifecycles.set(key, record);
    }
  }

  public markSetupCompleted(keyOrSignal: string | any, reason = 'Target Hit / Setup Completed'): void {
    let key = typeof keyOrSignal === 'string' ? keyOrSignal : '';
    let setupName = 'Setup';
    let direction: 'BUY' | 'SELL' = 'SELL';
    let entry = 0;
    let patternMetadata: any = undefined;
    let poiId: string | undefined = undefined;

    if (typeof keyOrSignal === 'object' && keyOrSignal !== null) {
      setupName = keyOrSignal.setup || keyOrSignal.setupName || 'Setup';
      direction = keyOrSignal.signal?.includes('BUY') || keyOrSignal.direction?.includes('BUY') ? 'BUY' : 'SELL';
      entry = keyOrSignal.entry || keyOrSignal.entryProposed || 0;
      patternMetadata = keyOrSignal.patternMetadata;
      poiId = keyOrSignal.poiId;
      key = this.generateCandidateKey(setupName, direction, entry, patternMetadata, poiId);
    }

    if (!key) return;

    this.terminalFailedKeys.add(key);
    storage.saveTerminalSetup(key);
    const anchorKey = patternMetadata?.patternAnchorKey || (keyOrSignal as any)?.structuralAnchorKey;
    if (anchorKey) {
      this.terminalFailedKeys.add(`cand_${anchorKey}`);
      this.terminalFailedKeys.add(anchorKey);
      storage.saveTerminalSetup(`cand_${anchorKey}`);
      storage.saveTerminalSetup(anchorKey);
    }
    const now = Date.now();
    const existing = this.lifecycles.get(key);
    if (existing) {
      existing.state = 'COMPLETED';
      existing.rejectionReason = reason;
      existing.lastUpdatedTime = now;
      this.lifecycles.set(key, existing);
    }
  }

  public isSetupTerminal(keyOrSignal: string | any): boolean {
    let key = typeof keyOrSignal === 'string' ? keyOrSignal : '';
    if (typeof keyOrSignal === 'object' && keyOrSignal !== null) {
      key = this.generateCandidateKey(
        keyOrSignal.setup || keyOrSignal.setupName || '',
        keyOrSignal.signal?.includes('BUY') ? 'BUY' : 'SELL',
        keyOrSignal.entry || keyOrSignal.entryProposed || 0,
        keyOrSignal.patternMetadata,
        keyOrSignal.poiId
      );

      // Check patternAnchorKey directly if present
      const anchorKey = keyOrSignal.patternMetadata?.patternAnchorKey || keyOrSignal.structuralAnchorKey;
      if (anchorKey && (this.terminalFailedKeys.has(`cand_${anchorKey}`) || this.terminalFailedKeys.has(anchorKey) || storage.isTerminalSetup(`cand_${anchorKey}`) || storage.isTerminalSetup(anchorKey))) {
        return true;
      }
    }

    if (this.terminalFailedKeys.has(key) || storage.isTerminalSetup(key)) return true;
    const existing = this.lifecycles.get(key);
    return existing ? existing.state === 'FAILED' || existing.state === 'INVALIDATED' : false;
  }

  public getAllLifecycles(): CandidateLifecycleRecord[] {
    return Array.from(this.lifecycles.values());
  }

  public setLifecycles(records: CandidateLifecycleRecord[]) {
    this.lifecycles.clear();
    for (const r of records) {
      this.lifecycles.set(r.id, r);
      if (r.state === 'FAILED' || r.state === 'INVALIDATED') {
        this.terminalFailedKeys.add(r.id);
      }
    }
  }

  /**
   * Prunes stale candidate lifecycle records older than 4 hours
   */
  public pruneStaleRecords(maxAgeMs = 4 * 3600 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, r] of this.lifecycles.entries()) {
      if (r.lastUpdatedTime < cutoff && r.state !== 'FAILED') {
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
  if (s.includes('BREAK AND RETEST') || s.includes('BREAK & RETEST') || s.includes('HORIZONTAL RESISTANCE BREAKOUT') || s.includes('HORIZONTAL SUPPORT BREAKOUT')) return 'BREAK_AND_RETEST';
  if (s.includes('COUNTERTREND') || s.includes('PULLBACK SCALP')) return 'COUNTERTREND_SCALP';
  if (s.includes('FAILED BREAKOUT') || s.includes('TRAP')) return 'FAILED_BREAKOUT';
  if (s.includes('RANGE SFP') || s.includes('SWING FAILURE')) return 'RANGE_SFP_REVERSAL';
  if (s.includes('RANGE BREAKOUT') || s.includes('EXPANSION')) return 'RANGE_BREAKOUT_EXPANSION';
  if (s.includes('DOUBLE TOP') || s.includes('DOUBLE BOTTOM') || s.includes('M-FORMATION') || s.includes('W-FORMATION')) return 'DOUBLE_TOP_BOTTOM';
  if (s.includes('BARE RESISTANCE') || s.includes('BARE SUPPORT') || s.includes('BARE SR')) return 'BARE_SR';
  if (s.includes('ENGULFING')) return 'STRUCTURE_ENGULFING';
  return 'MARKET_STRUCTURE';
}

/**
 * Evaluates structural same-setup identity between an active trade and a new candidate signal.
 * Determines if the candidate is a genuine independent setup, an identical duplicate, or a re-entry on the same structural leg.
 */
export function generateOpportunityId(signal: TradeSignal): string {
  const meta = (signal as any).patternMetadata;
  const anchorKey = meta?.patternAnchorKey || (signal as any).structuralAnchorKey;
  if (anchorKey) {
    return `opp_${anchorKey}`;
  }
  if (meta?.pivot1Time) {
    return `opp_s10_${(signal.signal || '').toUpperCase().includes('BUY') ? 'BUY' : 'SELL'}_${meta.pivot1Time}`;
  }
  if (meta?.extremeLevel !== undefined && meta?.neckline !== undefined) {
    const dir = (signal.signal || '').toUpperCase().includes('BUY') ? 'BUY' : 'SELL';
    const fam = signal.strategyFamily || inferStrategyFamily(signal.setup);
    return `opp_${fam}_${dir}_${meta.extremeLevel.toFixed(1)}_${meta.neckline.toFixed(1)}`;
  }
  if (signal.poiId) {
    return `opp_poi_${signal.poiId}`;
  }
  const cleanSetup = (signal.setup || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
  const direction = (signal.signal || '').toUpperCase().includes('BUY') ? 'BUY' : 'SELL';
  const roundedPrice = Math.round(signal.entry / 5.0) * 5.0;
  return `opp_${cleanSetup}_${direction}_${roundedPrice.toFixed(0)}`;
}

export function rankCandidate(cand: any, htfRegime?: string): number {
  let score = cand.score || 0;

  // 1. Structural quality
  const structureScore = cand.rawScoreBreakdown?.structureScore || 0;
  score += structureScore * 1.5;

  // 2. Execution quality
  const execScore = cand.executionQualityScore || 0;
  score += execScore * 1.2;

  // 3. HTF regime alignment
  const dir = cand.direction || (cand.signal?.includes('BUY') ? 'BUY' : 'SELL');
  const regime = (htfRegime || '').toUpperCase();
  if (dir === 'BUY' && (regime.includes('UPTREND') || regime.includes('BULLISH'))) {
    score += 15;
  } else if (dir === 'SELL' && (regime.includes('DOWNTREND') || regime.includes('BEARISH'))) {
    score += 15;
  }

  // 4. Liquidity quality
  const liqScore = cand.rawScoreBreakdown?.liquidityScore || 0;
  score += liqScore * 1.0;

  // 5. Entry quality / timing
  const timing = cand.entryTiming || 'ACCEPTABLE';
  if (timing === 'OPTIMAL') score += 10;
  else if (timing === 'ACCEPTABLE') score += 5;
  else if (timing === 'LATE') score -= 10;
  else if (timing === 'CHASED') score -= 30;

  // 6. SL quality
  const slScore = cand.executionBreakdown?.slScore || 0;
  score += slScore * 0.8;

  // 7. TP Runway
  const runway = cand.tpRunway || 'CLEAR';
  if (runway === 'CLEAR') score += 10;
  else if (runway === 'MINOR_OBSTACLE') score += 5;
  else if (runway === 'MAJOR_OBSTACLE') score -= 10;
  else if (runway === 'BLOCKED') score -= 25;

  // 8. Confidence
  score += (cand.confidence || 50) * 0.5;

  // 9. RR
  const rr = cand.tp1Rr || 1.0;
  score += rr * 5.0;

  return score;
}

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
  const candIsBuy = (candidateSignal.signal || (candidateSignal as any).direction || '').toUpperCase().includes('BUY');
  const candStrategyFamily = candidateSignal.strategyFamily || inferStrategyFamily(candidateSignal.setup);
  const metaCand = (candidateSignal as any).patternMetadata;

  // A. HARD TERMINAL CHECK: Setup flagged as failed in lifecycle manager
  if (globalLifecycleManager.isSetupTerminal(candidateSignal)) {
    const details: DuplicateDetails = {
      duplicateReason: 'DUPLICATE_ACTIVE_REENTRY',
      activeSignalId: 'TERMINAL_BLOCK',
      candidateSignalId: candidateSignal.id,
      activeStrategyFamily: candStrategyFamily,
      candidateStrategyFamily: candStrategyFamily,
      samePoi: true,
      sameStructuralOrigin: true,
      sameTargetObjective: true,
      sameLifecycle: true,
      entryDistance: 0,
    };
    return {
      isDuplicate: true,
      isReentry: true,
      status: 'DUPLICATE_ACTIVE_REENTRY',
      details,
      reason: `حظر إعادة الدخول الصارم: هذه التشكيلة الهيكلية (${candidateSignal.setup}) تم ضرب وقف خسارتها سابقاً ومُعلمة كـ FAILED. يُمحو إعادة الدخول منها نهائياً بغض النظر عن تغير السعر أو الثقة.`,
    };
  }

  // B. PERSISTENT OPPORTUNITY CHECK: Check stored opportunities in storage
  const storedOpps = storage.getOpportunities();
  const candOppId = generateOpportunityId(candidateSignal);

  for (const opp of storedOpps) {
    if (!opp) continue;
    const oppIsBuy = opp.direction === 'BUY';
    const oppStrategyFamily = opp.strategyFamily || inferStrategyFamily(opp.setupName);

    // Check failed re-entry block (only for the exact same structural formation/anchor, never for cluster IDs)
    if (opp.status === 'FAILED') {
      const isOppSameFam = oppStrategyFamily === candStrategyFamily;
      const isOppSameDir = oppIsBuy === candIsBuy;
      const isOppSameAnchor =
        Boolean(opp.patternAnchorKey && metaCand?.patternAnchorKey && opp.patternAnchorKey === metaCand.patternAnchorKey) ||
        Boolean(opp.pivot1Time && metaCand?.pivot1Time && opp.pivot1Time === metaCand.pivot1Time) ||
        Boolean(opp.poiId && candidateSignal.poiId && opp.poiId === candidateSignal.poiId);

      if (isOppSameFam && isOppSameDir && isOppSameAnchor) {
        const details: DuplicateDetails = {
          duplicateReason: 'DUPLICATE_ACTIVE_REENTRY',
          activeSignalId: opp.id,
          candidateSignalId: candidateSignal.id,
          activeStrategyFamily: opp.strategyFamily,
          candidateStrategyFamily: candStrategyFamily,
          samePoi: true,
          sameStructuralOrigin: true,
          sameTargetObjective: true,
          sameLifecycle: true,
          entryDistance: 0,
        };
        return {
          isDuplicate: true,
          isReentry: true,
          status: 'DUPLICATE_ACTIVE_REENTRY',
          details,
          reason: `حظر إعادة الدخول الصارم: فرصة التداول المخزنة (${candidateSignal.setup}) تندرج تحت معرّف فرصة تداول مكررة تم فشلها مسبقاً (FAILED). تم حظر إعادة الدخول لمنع تكرار الخسارة.`,
        };
      }
    } else if (opp.status === 'ACTIVE' || opp.status === 'DISPATCHED') {
      // Must be same direction and same strategy family
      if (oppIsBuy !== candIsBuy) continue;
      if (oppStrategyFamily !== candStrategyFamily && opp.setupName !== candidateSignal.setup) continue;

      let sameStructure = false;
      if (opp.id === candOppId) {
        sameStructure = true;
      } else if (opp.patternAnchorKey && metaCand?.patternAnchorKey && opp.patternAnchorKey === metaCand.patternAnchorKey) {
        sameStructure = true;
      } else if (opp.pivot1Time && metaCand?.pivot1Time && opp.pivot1Time === metaCand.pivot1Time) {
        sameStructure = true;
      } else if (
        opp.extremeLevel !== undefined &&
        metaCand?.extremeLevel !== undefined &&
        Math.abs(opp.extremeLevel - metaCand.extremeLevel) <= 3.0 &&
        Math.abs((opp.neckline || 0) - (metaCand.neckline || 0)) <= 3.0
      ) {
        sameStructure = true;
      } else if (candStrategyFamily === 'DOUBLE_TOP_BOTTOM') {
        const entryDiff = Math.abs(opp.entry - candidateSignal.entry);
        const slDiff = Math.abs(opp.stopLoss - candidateSignal.stopLoss);
        if (entryDiff <= 5.0 || slDiff <= 4.0) {
          sameStructure = true;
        }
      } else if (opp.poiId && candidateSignal.poiId && opp.poiId === candidateSignal.poiId) {
        sameStructure = true;
      } else if (
        Math.abs(opp.entry - candidateSignal.entry) <= 6.0 &&
        Math.abs(opp.stopLoss - candidateSignal.stopLoss) <= 5.0 &&
        Math.abs(Date.now() - opp.lastUpdatedTime) < 45 * 60 * 1000
      ) {
        sameStructure = true;
      }

      if (sameStructure) {
        const details: DuplicateDetails = {
          duplicateReason: 'DUPLICATE_ACTIVE',
          activeSignalId: opp.id,
          candidateSignalId: candidateSignal.id,
          activeStrategyFamily: opp.strategyFamily,
          candidateStrategyFamily: candStrategyFamily,
          samePoi: true,
          sameStructuralOrigin: true,
          sameTargetObjective: true,
          sameLifecycle: false,
          entryDistance: Number(Math.abs(opp.entry - candidateSignal.entry).toFixed(2)),
        };
        return {
          isDuplicate: true,
          isReentry: false,
          status: 'DUPLICATE_ACTIVE',
          details,
          reason: `تم رصد نفس الفرصة الهيكلية الجارية والمخزنة (${opp.setupName}). تم حظر التكرار على السعر المتطور ($${candidateSignal.entry}) لمنع السخام وضوضاء الإشارات المتكررة.`,
        };
      }
    }
  }

  // C. COMPREHENSIVE STRUCTURAL-PROXIMITY SCAN ACROSS RECENT SIGNALS
  const recentSignals = storage.getSignals(40);
  for (const prev of recentSignals) {
    if (!prev || !prev.signal || prev.signal === 'NO TRADE' || prev.id === candidateSignal.id) {
      continue;
    }

    const prevIsBuy = (prev.signal || (prev as any).direction || '').toUpperCase().includes('BUY');
    if (prevIsBuy !== candIsBuy) continue;

    const prevStrategyFamily = prev.strategyFamily || inferStrategyFamily(prev.setup);
    if (prevStrategyFamily !== candStrategyFamily && prev.setup !== candidateSignal.setup) continue;

    const timeElapsedMs = Math.abs(Date.now() - prev.timestamp);
    if (timeElapsedMs < 45 * 60 * 1000) {
      const entryDistance = Math.abs(prev.entry - candidateSignal.entry);
      const slDistance = Math.abs(prev.stopLoss - candidateSignal.stopLoss);
      const metaPrev = (prev as any).patternMetadata;

      let isSameLocalStructure = false;
      let reasonMessage = '';

      // S10 (Double Top/Bottom)
      if (candStrategyFamily === 'DOUBLE_TOP_BOTTOM') {
        if (
          (metaPrev?.patternAnchorKey && metaCand?.patternAnchorKey && metaPrev.patternAnchorKey === metaCand.patternAnchorKey) ||
          (metaPrev?.pivot1Time && metaCand?.pivot1Time && metaPrev.pivot1Time === metaCand.pivot1Time) ||
          (metaPrev?.extremeLevel !== undefined && metaCand?.extremeLevel !== undefined &&
            Math.abs(metaPrev.extremeLevel - metaCand.extremeLevel) <= 3.0 &&
            Math.abs((metaPrev.neckline || 0) - (metaCand.neckline || 0)) <= 3.0) ||
          entryDistance <= 5.0 ||
          slDistance <= 4.0
        ) {
          isSameLocalStructure = true;
          reasonMessage = `تكرار في التشكيل الهيكلي القريب (S10 Double Top/Bottom): تم إصدار إشارة مشابهة مؤخراً بفارق سعر دخول $${entryDistance.toFixed(2)} ووقف خسارة $${slDistance.toFixed(2)} قبل ${Math.round(timeElapsedMs / 60000)} دقيقة. تم منع التكرار لضمان دقة الإشارات وحظر الإسبام.`;
        }
      }
      // Order Block (S11/S12)
      else if (candStrategyFamily === 'ORDER_BLOCK') {
        if (entryDistance <= 6.0 || slDistance <= 5.0 || (prev.poiId && candidateSignal.poiId && prev.poiId === candidateSignal.poiId)) {
          isSameLocalStructure = true;
          reasonMessage = `تكرار في التشكيل الهيكلي القريب (Order Block): تم رصد تداخل كبير في منطقة الـ POI أو مستويات الدخول/الوقف مع صفقة تم إصدارها قبل ${Math.round(timeElapsedMs / 60000)} دقيقة. تم منع التكرار لمنع تشتيت رأس المال.`;
        }
      }
      // FVG (S13)
      else if (candStrategyFamily === 'FVG_IMBALANCE') {
        if (entryDistance <= 6.0 || slDistance <= 5.0) {
          isSameLocalStructure = true;
          reasonMessage = `تكرار في التشكيل الهيكلي القريب (FVG Imbalance): توجد إشارة جارية في الفجوة السعرية ذاتها تم إصدارها قبل ${Math.round(timeElapsedMs / 60000)} دقيقة. تم منع التكرار لضمان دقة المتابعة الفنية.`;
        }
      }
      // General fallbacks
      else {
        if (entryDistance <= 6.0 && slDistance <= 5.0) {
          isSameLocalStructure = true;
          reasonMessage = `تكرار قريب في بنية السعر المحلية (بفارق دخول $${entryDistance.toFixed(2)}): تم إصدار إشارة في نفس المنطقة الجغرافية للسعر قبل ${Math.round(timeElapsedMs / 60000)} دقيقة. تم منع التكرار لضمان جودة الاختيار.`;
        }
      }

      if (isSameLocalStructure) {
        const dupDetails: DuplicateDetails = {
          duplicateReason: 'DUPLICATE_ACTIVE',
          activeSignalId: prev.id,
          candidateSignalId: candidateSignal.id,
          activeStrategyFamily: prevStrategyFamily,
          candidateStrategyFamily: candStrategyFamily,
          samePoi: prev.poiId === candidateSignal.poiId,
          sameStructuralOrigin: slDistance <= 4.0,
          sameTargetObjective: Math.abs(prev.tp1 - candidateSignal.tp1) <= 4.0,
          sameLifecycle: false,
          entryDistance: Number(entryDistance.toFixed(2)),
        };
        return {
          isDuplicate: true,
          isReentry: false,
          status: 'DUPLICATE_ACTIVE',
          details: dupDetails,
          reason: reasonMessage,
        };
      }
    }
  }

  // D. ACTIVE SIGNAL IN-MEMORY CHECK
  let currentActive = activeSignal;
  if (!currentActive) {
    const recent = storage.getSignals(10);
    const foundActive = recent.find(
      (s) => s && s.signal && s.signal !== 'NO TRADE' && (s.signal || (s as any).direction || '').toUpperCase().includes(candIsBuy ? 'BUY' : 'SELL')
    );
    if (foundActive) {
      currentActive = foundActive;
    }
  }

  const candSignalStr = candidateSignal.signal || (candidateSignal as any).direction;
  const activeSignalStr = currentActive?.signal || (currentActive as any)?.direction;

  if (!currentActive || !activeSignalStr || activeSignalStr === 'NO TRADE' || !candSignalStr || candSignalStr === 'NO TRADE') {
    return { isDuplicate: false, isReentry: false, status: 'QUALIFIED_SIGNAL' };
  }

  activeSignal = currentActive;

  // Check if both signals are in the SAME direction
  const activeIsBuy = (activeSignalStr || '').toUpperCase().includes('BUY');
  if (activeIsBuy !== candIsBuy) {
    return { isDuplicate: false, isReentry: false, status: 'QUALIFIED_SIGNAL' };
  }

  const activeStrategyFamily = (activeSignal.strategyFamily as string) || inferStrategyFamily(activeSignal.setup || (activeSignal as any).setupName);
  const candidateStrategyFamily = (candidateSignal.strategyFamily as string) || inferStrategyFamily(candidateSignal.setup || (candidateSignal as any).setupName);
  const sameStrategyFamily = activeStrategyFamily === candidateStrategyFamily || (activeSignal.setup && candidateSignal.setup && activeSignal.setup === candidateSignal.setup) || ((activeSignal as any).setupName && (candidateSignal as any).setupName && (activeSignal as any).setupName === (candidateSignal as any).setupName);

  const activeSetup = (activeSignal.setup || (activeSignal as any).setupName || '').toLowerCase();
  const candSetup = (candidateSignal.setup || (candidateSignal as any).setupName || '').toLowerCase();

  const isS10Active = activeStrategyFamily === 'DOUBLE_TOP_BOTTOM' || activeSetup.includes('double top') || activeSetup.includes('double bottom') || activeSetup.includes('m-formation') || activeSetup.includes('w-formation');
  const isS10Cand = candidateStrategyFamily === 'DOUBLE_TOP_BOTTOM' || candSetup.includes('double top') || candSetup.includes('double bottom') || candSetup.includes('m-formation') || candSetup.includes('w-formation');

  const metaActive = (activeSignal as any).patternMetadata;

  let sameS10Structure = false;
  if (isS10Active && isS10Cand) {
    if (metaActive?.patternAnchorKey && metaCand?.patternAnchorKey && metaActive.patternAnchorKey === metaCand.patternAnchorKey) {
      sameS10Structure = true;
    } else if (metaActive?.pivot1Time && metaCand?.pivot1Time && metaActive.pivot1Time === metaCand.pivot1Time) {
      sameS10Structure = true;
    } else {
      const neckActive = metaActive?.neckline ?? activeSignal.tp1;
      const neckCand = metaCand?.neckline ?? candidateSignal.tp1;
      const peakActive = metaActive?.extremeLevel ?? activeSignal.stopLoss;
      const peakCand = metaCand?.extremeLevel ?? candidateSignal.stopLoss;

      const neckDiff = Math.abs(neckActive - neckCand);
      const peakDiff = Math.abs(peakActive - peakCand);
      const slDiff = Math.abs(activeSignal.stopLoss - candidateSignal.stopLoss);

      if (neckDiff <= 3.0 || peakDiff <= 3.0 || slDiff <= 3.0) {
        sameS10Structure = true;
      }
    }
  }

  const samePoi = !!(
    (activeSignal.poiId && candidateSignal.poiId && activeSignal.poiId === candidateSignal.poiId) ||
    sameS10Structure ||
    (activeSignal.setup === candidateSignal.setup && Math.abs(activeSignal.stopLoss - candidateSignal.stopLoss) <= Math.max(tolerance, 3.0))
  );

  const sameStructuralOrigin = sameS10Structure || Math.abs(activeSignal.stopLoss - candidateSignal.stopLoss) <= Math.max(tolerance, 3.0);

  const sameTargetObjective =
    Math.abs(activeSignal.tp1 - candidateSignal.tp1) <= Math.max(tolerance, 3.0) ||
    Math.abs(activeSignal.tp2 - candidateSignal.tp2) <= Math.max(tolerance, 3.0) ||
    sameS10Structure;

  const sameLifecycle = !!(
    activeSignal.lifecycleState &&
    candidateSignal.lifecycleState &&
    activeSignal.lifecycleState === candidateSignal.lifecycleState
  );

  const entryDistance = Number(Math.abs(activeSignal.entry - candidateSignal.entry).toFixed(2));

  const details: DuplicateDetails = {
    duplicateReason: sameS10Structure ? 'DUPLICATE_ACTIVE' : 'DUPLICATE_ACTIVE',
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

  if (sameS10Structure) {
    details.duplicateReason = 'DUPLICATE_ACTIVE';
    return {
      isDuplicate: true,
      isReentry: false,
      status: 'DUPLICATE_ACTIVE',
      details,
      reason: `تم رصد نفس التشكيلة الهيكلية (S10 Double Top/Bottom) الجارية (${activeSignal.setup}). تم حظر التكرار على السعر المتطور ($${candidateSignal.entry}) مع ثقة ${candidateSignal.confidence}%.`,
    };
  }

  const activeSetupName = activeSignal.setup || (activeSignal as any).setupName;
  const candSetupName = candidateSignal.setup || (candidateSignal as any).setupName;

  if (activeSetupName === candSetupName && entryDistance <= tolerance) {
    details.duplicateReason = 'DUPLICATE_ACTIVE';
    return {
      isDuplicate: true,
      isReentry: false,
      status: 'DUPLICATE_ACTIVE',
      details,
      reason: `تم رصد نفس الصفقة النشطة (${activeSetupName}) بفارق سعر دخول ضئيل ($${entryDistance}). تم منع تكرار الإشارة.`,
    };
  }

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

  return { isDuplicate: false, isReentry: false, status: 'QUALIFIED_SIGNAL', details };
}

export function resolveFinalSignalConflict(
  candidates: any[],
  activeTrade?: any,
  htfRegime?: string
): {
  winningCandidate: any | null;
  suppressedCandidates: { candidate: any; reason: string }[];
} {
  const validCandidates = (candidates || []).filter(
    (c) => c && (c.direction || c.signal) && c.signal !== 'NO TRADE'
  );

  if (validCandidates.length === 0) {
    return { winningCandidate: null, suppressedCandidates: [] };
  }

  // 1. STRUCTURAL CLUSTERING / OPPORTUNITY AGGREGATION
  // We group all candidates by their opportunityId (which clusters identical POIs, double tops, close levels, etc.)
  const clusters = new Map<string, any[]>();
  for (const cand of validCandidates) {
    const oppId = generateOpportunityId(cand);
    if (!clusters.has(oppId)) {
      clusters.set(oppId, []);
    }
    clusters.get(oppId)!.push(cand);
  }

  // 2. BEST-CANDIDATE SELECTION within each cluster
  const clusterRepresentatives: any[] = [];
  const clusterSuppressed: { candidate: any; reason: string }[] = [];

  for (const [oppId, list] of clusters.entries()) {
    // Sort candidates in this cluster by our 9-criteria rankCandidate score
    const rankedList = list.map(c => ({ candidate: c, score: rankCandidate(c, htfRegime) }))
                           .sort((a, b) => b.score - a.score);

    const best = rankedList[0].candidate;
    clusterRepresentatives.push(best);

    // Suppress other candidates in the same cluster
    for (let i = 1; i < rankedList.length; i++) {
      clusterSuppressed.push({
        candidate: rankedList[i].candidate,
        reason: `SUPPRESSED_BY_BETTER_OPPORTUNITY: تم إلغاء هذه الإشارة لصالح الإشارة الأفضل الجودة والأعلى رتبة (${best.setupName || best.setup}) في نفس معرّف فرصة التداول (${oppId}).`,
      });
    }
  }

  // 2.5 ARBITRATE AGAINST ACTIVE IN-FLIGHT TRADE (if present)
  if (activeTrade && (activeTrade.signal || activeTrade.direction) && activeTrade.signal !== 'NO TRADE') {
    const activeIsBuy = (activeTrade.signal || activeTrade.direction || '').toUpperCase().includes('BUY');
    const activeScore = rankCandidate(activeTrade, htfRegime);
    const nonOpposedReps: any[] = [];

    for (const cand of clusterRepresentatives) {
      const candIsBuy = (cand.direction || cand.signal || '').toUpperCase().includes('BUY');
      if (candIsBuy !== activeIsBuy) {
        // Candidate opposes active trade
        const candScore = rankCandidate(cand, htfRegime);
        if (candScore <= activeScore + 5.0) {
          clusterSuppressed.push({
            candidate: cand,
            reason: `OPPOSING_ACTIVE_BLOCKED: صفقة ${activeIsBuy ? 'BUY' : 'SELL'} جارية حالياً (${activeTrade.setup || 'Active Trade'}). تم حظر إشارة ${cand.signal || cand.direction} (${cand.setup || cand.setupName}) المعارضة لمنع التضارب حتى اكتمال الصفقة الجارية.`,
          });
          continue;
        }
      }
      nonOpposedReps.push(cand);
    }

    if (nonOpposedReps.length === 0) {
      return { winningCandidate: null, suppressedCandidates: clusterSuppressed };
    }

    // Replace cluster representatives with filtered list
    clusterRepresentatives.length = 0;
    clusterRepresentatives.push(...nonOpposedReps);
  }

  if (clusterRepresentatives.length === 1) {
    return { winningCandidate: clusterRepresentatives[0], suppressedCandidates: clusterSuppressed };
  }

  // 3. OPPOSING SIGNALS RESOLUTION across representatives
  const buys = clusterRepresentatives.filter((c) => c.direction === 'BUY' || c.signal?.includes('BUY'));
  const sells = clusterRepresentatives.filter((c) => c.direction === 'SELL' || c.signal?.includes('SELL'));

  // If all are BUYs or all are SELLs, we simply select the single best representative based on rank score
  if (buys.length === 0 || sells.length === 0) {
    const sortedReps = clusterRepresentatives.map(c => ({ candidate: c, score: rankCandidate(c, htfRegime) }))
                                             .sort((a, b) => b.score - a.score);
    const winner = sortedReps[0].candidate;

    for (let i = 1; i < sortedReps.length; i++) {
      clusterSuppressed.push({
        candidate: sortedReps[i].candidate,
        reason: `SUPPRESSED_BY_BETTER_OPPORTUNITY: تم التفضيل لصالح إشارة ${winner.signal || winner.direction} (${winner.setup || winner.setupName}) الجودة والأعلى ترتيباً في هذا المسح المجمع.`,
      });
    }
    return { winningCandidate: winner, suppressedCandidates: clusterSuppressed };
  }

  // We have both BUY and SELL representatives. Check if they belong to the same structural context (overlap)
  let structuralOverlap = false;
  for (const buy of buys) {
    for (const sell of sells) {
      const entryDiff = Math.abs((buy.entry || 0) - (sell.entry || 0));
      const slOverlap = (buy.stopLoss <= sell.entry && buy.entry >= sell.stopLoss) || entryDiff <= 15.0;
      if (slOverlap || entryDiff <= 15.0) {
        structuralOverlap = true;
        break;
      }
    }
    if (structuralOverlap) break;
  }

  // If they don't overlap structurally, they are genuinely independent opportunities in opposite directions.
  // Still, to avoid double alerting and spam, we pick the highest quality one as winningCandidate and suppress the other.
  if (!structuralOverlap) {
    const sortedReps = clusterRepresentatives.map(c => ({ candidate: c, score: rankCandidate(c, htfRegime) }))
                                             .sort((a, b) => b.score - a.score);
    const winner = sortedReps[0].candidate;
    for (const rep of clusterRepresentatives) {
      if (rep !== winner) {
        clusterSuppressed.push({
          candidate: rep,
          reason: `SUPPRESSED_BY_BETTER_OPPORTUNITY: تم تفضيل إشارة ${winner.signal || winner.direction} (${winner.setup || winner.setupName}) لتجنب تعدد الإشارات المتزامنة في نفس اللحظة.`,
        });
      }
    }
    return { winningCandidate: winner, suppressedCandidates: clusterSuppressed };
  }

  // Genuinely overlapping opposing signals: Compare the top BUY vs the top SELL representatives
  const scoredBuys = buys.map((c) => ({ candidate: c, score: rankCandidate(c, htfRegime) })).sort((a, b) => b.score - a.score);
  const scoredSells = sells.map((c) => ({ candidate: c, score: rankCandidate(c, htfRegime) })).sort((a, b) => b.score - a.score);

  const topBuy = scoredBuys[0];
  const topSell = scoredSells[0];

  // If neither clearly dominates (e.g. score difference <= 5.0), then NO TRADE!
  const scoreDiff = Math.abs(topBuy.score - topSell.score);
  if (scoreDiff <= 5.0) {
    // Both are suppressed as OPPOSING_STRUCTURAL_BLOCKED, and we return null (NO TRADE)
    for (const rep of clusterRepresentatives) {
      clusterSuppressed.push({
        candidate: rep,
        reason: `OPPOSING_STRUCTURAL_BLOCKED: تعارض هيكلي مباشر متعادل القوة والوضوح (الفارق ${scoreDiff.toFixed(2)} ≤ 5.0). تم إلغاء كلي الإشارتين لعدم وضوح الاتجاه الحاسم (NO TRADE).`,
      });
    }
    return { winningCandidate: null, suppressedCandidates: clusterSuppressed };
  }

  const winner = topBuy.score > topSell.score ? topBuy.candidate : topSell.candidate;

  for (const rep of clusterRepresentatives) {
    if (rep !== winner) {
      clusterSuppressed.push({
        candidate: rep,
        reason: `OPPOSING_STRUCTURAL_BLOCKED: تم حظر إشارة ${rep.signal || rep.direction} (${rep.setup || rep.setupName}) لمنع التعارض الهيكلي المباشر مع إشارة ${winner.signal || winner.direction} (${winner.setup || winner.setupName}) الأقوى دليلاً وتوافقاً بفارق تفوق حاسم (${scoreDiff.toFixed(2)} > 5.0).`,
      });
    }
  }

  return { winningCandidate: winner, suppressedCandidates: clusterSuppressed };
}

/**
 * Deterministic Candidate Technical Validation Gate
 * 
 * Validates any candidate (deterministic or AI-generated) against the full suite of
 * technical quality gates: SL distance, TP path runway, pullback quality, anti-chase timing,
 * price action trigger confirmation, and active-trade opposition.
 */
export function validateTradeSignalCandidate(
  cand: {
    direction: 'BUY' | 'SELL';
    entry: number;
    stopLoss: number;
    tp1: number;
    tp2?: number;
    setupName?: string;
    strategyFamily?: StrategyFamily;
    confidence?: number;
    poiOriginPrice?: number;
    poiPrice?: number;
    idealEntry?: number;
    poiMeta?: {
      type?: 'ORDER_BLOCK' | 'FVG' | 'SFP_ZONE' | 'SWING_LEVEL';
      top?: number;
      bottom?: number;
      timeframe?: '1H' | '15M' | '5M';
      createdCandleTime?: number;
      invalidationPrice?: number;
    };
  },
  context: {
    currentPrice: number;
    candles5m: Candle[];
    candles15m: Candle[];
    candles1h: Candle[];
    candles1m?: Candle[];
    indicators5m: TechnicalIndicators;
    indicators15m: TechnicalIndicators;
    indicators1h: TechnicalIndicators;
    brokerSpecs?: Partial<any>;
    activeTradeDirection?: 'BUY' | 'SELL' | null;
    currentSpread?: number;
  }
): {
  isValid: boolean;
  rejectionReason?: string;
  pullbackQuality?: PullbackQuality;
  timing?: EntryTiming;
  runway?: TpPathRunway;
  triggerType?: PriceActionTriggerType;
  qualityScore?: number;
} {
  const { direction, entry, stopLoss, tp1, tp2, setupName, strategyFamily } = cand;
  const { currentPrice, candles5m, candles15m, candles1h, candles1m, indicators5m, indicators15m, indicators1h, brokerSpecs, activeTradeDirection, currentSpread } = context;

  // 0. Insufficient candle data check (minimum 15 candles required for 14-period ATR/RSI and multi-timeframe structure)
  if (
    !candles5m || !Array.isArray(candles5m) || candles5m.length < 15 ||
    !candles15m || !Array.isArray(candles15m) || candles15m.length < 15 ||
    !candles1h || !Array.isArray(candles1h) || candles1h.length < 15
  ) {
    return {
      isValid: false,
      rejectionReason: 'INSUFFICIENT_MARKET_DATA: Insufficient candle history across required timeframes (minimum 15 candles each)',
    };
  }

  // 1. Basic Direction and SL/TP Geometry
  if (direction !== 'BUY' && direction !== 'SELL') {
    return { isValid: false, rejectionReason: 'INVALID_DIRECTION: Direction must be strictly BUY or SELL' };
  }

  const isBuy = direction === 'BUY';
  if (isBuy && entry <= stopLoss) {
    return { isValid: false, rejectionReason: 'INVALID_GEOMETRY: BUY entry must be strictly greater than stop loss' };
  }
  if (!isBuy && entry >= stopLoss) {
    return { isValid: false, rejectionReason: 'INVALID_GEOMETRY: SELL entry must be strictly less than stop loss' };
  }

  if (isBuy && tp1 <= entry) {
    return { isValid: false, rejectionReason: 'INVALID_GEOMETRY: BUY TP1 must be strictly greater than entry' };
  }
  if (!isBuy && tp1 >= entry) {
    return { isValid: false, rejectionReason: 'INVALID_GEOMETRY: SELL TP1 must be strictly less than entry' };
  }
  if (tp2 !== undefined && tp2 !== null && !isNaN(tp2) && tp2 > 0) {
    if (isBuy && tp2 <= tp1) {
      return { isValid: false, rejectionReason: 'INVALID_GEOMETRY: BUY TP2 must be strictly greater than TP1' };
    }
    if (!isBuy && tp2 >= tp1) {
      return { isValid: false, rejectionReason: 'INVALID_GEOMETRY: SELL TP2 must be strictly less than TP1' };
    }
  }

  const slDistance = Math.abs(entry - stopLoss);
  const slPoints = Math.round(slDistance / 0.1);
  const minSlPoints = Number(brokerSpecs?.minGoldSlPoints ?? brokerSpecs?.minSlPoints ?? 35);
  const maxSlPoints = Number(brokerSpecs?.maxGoldSlPoints ?? brokerSpecs?.maxSlPoints ?? 65);

  if (slPoints < minSlPoints || slPoints > maxSlPoints) {
    return { isValid: false, rejectionReason: `INVALID_SL_DISTANCE: Stop loss distance (${slPoints} pts) outside allowed range [${minSlPoints}, ${maxSlPoints}] pts` };
  }

  const tp1Distance = Math.abs(tp1 - entry);
  const rrToTp1 = slDistance > 0 ? tp1Distance / slDistance : 0;
  const minRequiredRr = Number(brokerSpecs?.minRr ?? 1.0);
  if (rrToTp1 < minRequiredRr - 0.0001) {
    return { isValid: false, rejectionReason: `INSUFFICIENT_RR: R:R to TP1 (${rrToTp1.toFixed(2)}R) is below minimum required ${minRequiredRr.toFixed(2)}R` };
  }

  // FIX 4: Spread-aware Entry Quality (Check before active gate or timing)
  if (currentSpread !== undefined) {
    if (isNaN(currentSpread) || currentSpread <= 0) {
      return {
        isValid: false,
        rejectionReason: 'SPREAD_INVALID: Live market spread is non-positive or invalid',
      };
    }
  }

  const effSpread = currentSpread ?? (brokerSpecs as any)?.spread;
  if (effSpread !== undefined && effSpread !== null && effSpread > 0) {
    const spreadPoints = Number((effSpread / 0.1).toFixed(1));
    if (spreadPoints > 12.0 || (slDistance > 0 && effSpread / slDistance > 0.20)) {
      return {
        isValid: false,
        rejectionReason: `SPREAD_EXCESSIVE: Spread (${spreadPoints} pts) exceeds executable quality limit for ${direction} entry (consumes > 20% of SL)`,
      };
    }
  }

  // 2. Active In-Flight Trade Opposition Gate
  if (activeTradeDirection && activeTradeDirection !== direction) {
    return { isValid: false, rejectionReason: `OPPOSING_ACTIVE_BLOCKED: Candidate ${direction} opposes active in-flight ${activeTradeDirection} trade` };
  }

  const family = strategyFamily || inferStrategyFamily(setupName || 'Market Structure');

  // 3. Single-Factor Indicator Rejection & POI Confluence (Fix 2 & Fix 6)
  const normalizedSetupName = (setupName || '').toUpperCase();
  const isSingleFactorIndicatorOnly =
    normalizedSetupName.includes('RSI_ONLY') ||
    normalizedSetupName.includes('MACD_ONLY') ||
    normalizedSetupName.includes('EMA_CROSS_ONLY') ||
    normalizedSetupName.includes('ISOLATED_CANDLE') ||
    normalizedSetupName.includes('DISPLACEMENT_ONLY') ||
    normalizedSetupName.includes('ENGULFING_ONLY');

  if (isSingleFactorIndicatorOnly) {
    return {
      isValid: false,
      rejectionReason: 'SINGLE_FACTOR_REJECTED: Signal is based solely on an isolated indicator without required structural POI and trigger confluence',
    };
  }

  // Check structural POI presence
  const poiRef = cand.poiPrice ?? cand.poiOriginPrice ?? cand.idealEntry ??
    (cand.direction === 'BUY'
      ? (cand.poiMeta?.top ?? cand.poiMeta?.bottom)
      : (cand.poiMeta?.bottom ?? cand.poiMeta?.top));

  const hasStructuralContext =
    poiRef !== undefined ||
    cand.poiMeta !== undefined ||
    cand.poiPrice !== undefined ||
    cand.poiOriginPrice !== undefined ||
    cand.idealEntry !== undefined ||
    family === 'ORDER_BLOCK' ||
    family === 'FVG_IMBALANCE' ||
    family === 'LIQUIDITY_SWEEP' ||
    family === 'RANGE_SFP_REVERSAL' ||
    family === 'DOUBLE_TOP_BOTTOM' ||
    family === 'BREAK_AND_RETEST' ||
    family === 'BARE_SR' ||
    family === 'FIBONACCI_OTE' ||
    family === 'COUNTERTREND_SCALP' ||
    family === 'RANGE_BREAKOUT_EXPANSION';

  if (!hasStructuralContext) {
    return {
      isValid: false,
      rejectionReason: 'MISSING_POI_CONTEXT: Signal lacks a meaningful structural Point of Interest (POI)',
    };
  }

  // 4. Entry Timing & Anti-Chase Assessment (Reject chased setups early before deeper analysis)
  const poiContext = cand.poiMeta || (poiRef !== undefined ? {
    top: cand.direction === 'BUY' ? poiRef : Math.max(poiRef, cand.stopLoss),
    bottom: cand.direction === 'BUY' ? Math.min(poiRef, cand.stopLoss) : poiRef,
    poiPrice: poiRef,
  } : undefined);

  const timingAssessment = assessEntryTimingAndAntiChase(
    direction,
    family,
    currentPrice,
    poiRef !== undefined ? poiRef : entry,
    candles5m || [],
    indicators5m,
    indicators15m?.marketRegime || 'UNCLEAR',
    poiContext,
    candles1m,
    effSpread
  );

  const isBreakoutOrReversal =
    family === 'RANGE_BREAKOUT_EXPANSION' ||
    family === 'BREAK_AND_RETEST' ||
    family === 'RANGE_SFP_REVERSAL' ||
    family === 'LIQUIDITY_SWEEP' ||
    family === 'DOUBLE_TOP_BOTTOM' ||
    family === 'BARE_SR';

  const isDisqualifiedChase =
    timingAssessment.timing === 'CHASED' ||
    (!isBreakoutOrReversal && timingAssessment.isChasing && timingAssessment.distanceFromPoiAtr > 1.8);

  if (isDisqualifiedChase) {
    return {
      isValid: false,
      rejectionReason: `CHASED_ENTRY: Entry is overextended beyond acceptable POI tolerance (${timingAssessment.reason})`,
      timing: timingAssessment.timing,
    };
  }

  // 5. Multi-Timeframe Structure Alignment
  if (direction === 'BUY') {
    const isH1Bearish =
      indicators1h.marketRegime === 'STRONG_DOWNTREND' ||
      (indicators1h.structure === 'BEARISH' && indicators1h.trendStructure === 'LH_LL');
    const isM15Bearish =
      indicators15m.marketRegime === 'STRONG_DOWNTREND' ||
      (indicators15m.structure === 'BEARISH' && indicators15m.trendStructure === 'LH_LL');

    if (isH1Bearish && isM15Bearish) {
      const isConfirmedReversal = hasConfirmedReversalStructure(
        'BUY',
        indicators15m,
        indicators5m,
        candles15m || [],
        candles5m || [],
        indicators15m.atr14
      );
      if (!isConfirmedReversal) {
        return {
          isValid: false,
          rejectionReason: 'HTF_CONTRADICTION: 1H/15M structure is strongly bearish and contradicts BUY setup without confirmed structural reversal',
        };
      }
    }
  } else {
    // SELL direction
    const isH1Bullish =
      indicators1h.marketRegime === 'STRONG_UPTREND' ||
      (indicators1h.structure === 'BULLISH' && indicators1h.trendStructure === 'HH_HL');
    const isM15Bullish =
      indicators15m.marketRegime === 'STRONG_UPTREND' ||
      (indicators15m.structure === 'BULLISH' && indicators15m.trendStructure === 'HH_HL');

    if (isH1Bullish && isM15Bullish) {
      const isConfirmedReversal = hasConfirmedReversalStructure(
        'SELL',
        indicators15m,
        indicators5m,
        candles15m || [],
        candles5m || [],
        indicators15m.atr14
      );
      if (!isConfirmedReversal) {
        return {
          isValid: false,
          rejectionReason: 'HTF_CONTRADICTION: 1H/15M structure is strongly bullish and contradicts SELL setup without confirmed structural reversal',
        };
      }
    }
  }

  // 6. TP Runway Assessment
  const runwayAssessment = assessTpPathRunway(
    direction,
    entry,
    tp1,
    tp2,
    candles15m || [],
    candles1h || [],
    indicators15m,
    indicators1h
  );

  if (runwayAssessment.runway === 'BLOCKED') {
    return {
      isValid: false,
      rejectionReason: `BLOCKED_TP_RUNWAY: TP path is blocked by opposing structural barrier (${runwayAssessment.description})`,
      runway: runwayAssessment.runway,
    };
  }

  // 7. Pullback Quality Assessment
  const pullbackAssessment = assessPullbackQuality(
    direction,
    candles5m || [],
    indicators5m,
    indicators15m?.marketRegime || 'UNCLEAR'
  );

  if (
    pullbackAssessment.quality === 'INVALID' &&
    family !== 'LIQUIDITY_SWEEP' &&
    family !== 'RANGE_SFP_REVERSAL' &&
    family !== 'COUNTERTREND_SCALP' &&
    family !== 'DOUBLE_TOP_BOTTOM' &&
    family !== 'BARE_SR' &&
    family !== 'STRUCTURE_ENGULFING' &&
    family !== 'MARKET_STRUCTURE'
  ) {
    return {
      isValid: false,
      rejectionReason: `INVALID_PULLBACK: Counter-trend impulse violates pullback structure (${pullbackAssessment.reasons.join(', ')})`,
      pullbackQuality: pullbackAssessment.quality,
    };
  }

  // 8. Price Action Trigger Assessment
  const triggerAssessment = assessPriceActionTrigger(
    direction,
    candles5m || [],
    candles1m || [],
    indicators5m
  );

  if (!triggerAssessment.hasTrigger || triggerAssessment.confirmationScore < 8) {
    return {
      isValid: false,
      rejectionReason: `MISSING_PRICE_ACTION_TRIGGER: Insufficient price action confirmation trigger on closed 5M candle`,
      triggerType: triggerAssessment.primaryTrigger,
    };
  }

  return {
    isValid: true,
    pullbackQuality: pullbackAssessment.quality,
    timing: timingAssessment.timing,
    runway: runwayAssessment.runway,
    triggerType: triggerAssessment.primaryTrigger,
  };
}


