import {
  AssetType,
  Candle,
  SignalDecision,
  TechnicalIndicators,
  TradeSignal,
  PoiFreshnessState,
  PullbackQuality,
  EntryTiming,
  TpPathRunway,
  CandidateLifecycleState,
  StrategyFamily,
} from '../src/types.js';
import { BrokerContractSpecs, DEFAULT_BROKER_SPECS, evaluateTradeRisk } from './riskManager.js';
import { calculateDynamicTakeProfits } from './tpEngine.js';
import {
  detectDoubleTopBottom,
  detectBareSRLevels,
  detectHorizontalBreakoutRetest,
} from './indicators.js';
import {
  globalPoiTracker,
  globalLifecycleManager,
  assessLiquidityContext,
  assessPullbackQuality,
  assessEntryTimingAndAntiChase,
  assessPriceActionTrigger,
  assessTpPathRunway,
  assessStopLossQuality,
  calculateExecutionQualityScore,
  resolveFinalSignalConflict,
} from './tradeQualityEngine.js';

export interface SetupCandidate {
  id: string;
  strategyFamily: StrategyFamily;
  setupName: string;
  direction: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  entry: number;
  stopLoss: number;
  slPoints: number;
  tp1: number;
  tp1Points: number;
  tp1Rr: number;
  tp2: number;
  tp2Points: number;
  tp2Rr: number;
  confidence: number;
  score: number;
  strategyConfidence?: number;
  executionQualityScore?: number;
  entryTiming?: EntryTiming;
  timingWarning?: string;
  setupFreshness?: PoiFreshnessState;
  pullbackQuality?: PullbackQuality;
  tpRunway?: TpPathRunway;
  lifecycleState?: CandidateLifecycleState;
  poiId?: string;
  triggers?: string[];
  patternMetadata?: Record<string, any>;
  executionBreakdown?: {
    timingScore: number;
    triggerScore: number;
    runwayScore: number;
    pullbackScore: number;
    freshnessScore: number;
    slScore: number;
  };
  timeframe: string;
  mainReasons: string[];
  invalidation: string;
  supportingConfluences: string[];
  rawScoreBreakdown: {
    structureScore: number;
    liquidityScore: number;
    priceActionScore: number;
    locationScore: number;
    technicalScore: number;
  };
}

export interface CandidateEvaluationTelemetry {
  strategyId: string;
  strategyFamily: StrategyFamily;
  setupName: string;
  direction: 'BUY' | 'SELL';
  detected: boolean;
  rejected: boolean;
  rejectionGate?: string;
  rejectionReason?: string;
  candidate?: SetupCandidate;
}


export interface MultiStrategyEngineInput {
  asset: AssetType;
  balance: number;
  currentPrice: number;
  indicators1h: TechnicalIndicators;
  indicators15m: TechnicalIndicators;
  indicators5m: TechnicalIndicators;
  candles1h: Candle[];
  candles15m: Candle[];
  candles5m: Candle[];
  candles1m?: Candle[];
  losingStreak?: number;
  brokerSpecs?: Partial<BrokerContractSpecs>;
  activeTradeDirection?: 'BUY' | 'SELL' | null;
}

export interface MultiStrategyEngineResult {
  hasValidSignal: boolean;
  selectedCandidate: SetupCandidate | null;
  allCandidates: SetupCandidate[];
  finalSignal: TradeSignal;
  noTradeReason?: string;
  telemetryRecords?: CandidateEvaluationTelemetry[];
}

/**
 * Helper to calculate candle metrics
 */
function analyzeCandle(c: Candle) {
  const isBull = c.close > c.open;
  const isBear = c.close < c.open;
  const body = Math.abs(c.close - c.open);
  const totalRange = Math.max(0.01, c.high - c.low);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const isTopRejection = upperWick > body * 1.3 && upperWick > totalRange * 0.4;
  const isBottomRejection = lowerWick > body * 1.3 && lowerWick > totalRange * 0.4;
  const isEngulfingBull = isBull && body > totalRange * 0.6;
  const isEngulfingBear = isBear && body > totalRange * 0.6;
  return {
    isBull,
    isBear,
    body,
    totalRange,
    upperWick,
    lowerWick,
    isTopRejection,
    isBottomRejection,
    isEngulfingBull,
    isEngulfingBear,
  };
}

/**
 * Calculates Fibonacci retracement levels from swing high and swing low
 */
function calculateFibLevels(high: number, low: number) {
  const diff = high - low;
  return {
    fib0: low,
    fib236: low + diff * 0.236,
    fib382: low + diff * 0.382,
    fib50: low + diff * 0.5,
    fib618: low + diff * 0.618,
    fib705: low + diff * 0.705, // OTE level
    fib786: low + diff * 0.786,
    fib100: high,
    // Symmetrical directional OTE bounds:
    // Bullish Retracement (Pullback from High into Discount): 61.8% - 78.6% retracement down from high
    bullishOteLow: low + diff * (1 - 0.786),
    bullishOteHigh: low + diff * (1 - 0.618),
    // Bearish Retracement (Pullback from Low into Premium): 61.8% - 78.6% retracement up from low
    bearishOteLow: low + diff * 0.618,
    bearishOteHigh: low + diff * 0.786,
  };
}

/**
 * Detects session extremes (Asian, London, NY approximations) from candles
 */
function extractSessionExtremes(candles: Candle[]) {
  if (candles.length === 0) return { sessionHigh: 0, sessionLow: 0 };
  const recent24h = candles.slice(-288); // 24h on 5M
  const high = Math.max(...recent24h.map((c) => c.high));
  const low = Math.min(...recent24h.map((c) => c.low));
  return { sessionHigh: high, sessionLow: low };
}

/**
 * Main Multi-Strategy Candidate Engine
 * Detects multiple independent setup families, scores them with weighted matrix,
 * filters hard constraints, and ranks the candidates.
 */
export function generateMultiStrategyCandidates(input: MultiStrategyEngineInput): MultiStrategyEngineResult {
  const {
    asset,
    balance,
    currentPrice,
    indicators1h,
    indicators15m,
    indicators5m,
    candles1h,
    candles15m,
    candles5m,
    brokerSpecs = {},
  } = input;

  const minRr = brokerSpecs.minRr ?? DEFAULT_BROKER_SPECS.minRr ?? 1.5;
  const minSlPoints = brokerSpecs.minGoldSlPoints ?? 35;
  const maxSlPoints = brokerSpecs.maxGoldSlPoints ?? 65;

  if (!currentPrice || currentPrice <= 0 || isNaN(currentPrice)) {
    const fallbackSignal: TradeSignal = {
      id: `sig_notrade_${Date.now()}`,
      timestamp: Date.now(),
      asset,
      signal: 'NO TRADE',
      currentPrice: 0,
      entry: 0,
      stopLoss: 0,
      slPoints: 0,
      tp1: 0,
      tp1Points: 0,
      tp1Rr: 0,
      tp1RrString: '1:0',
      tp2: 0,
      tp2Points: 0,
      tp2Rr: 0,
      tp2RrString: '1:0',
      primaryTarget: 'TP1',
      rr: '1:0',
      rrRatio: 0,
      riskPercent: 0,
      riskAmount: 0,
      potentialProfit: 0,
      potentialLoss: 0,
      recommendedLotSize: 0,
      confidence: 0,
      timeframe: '15M / 5M',
      setup: 'INVALID_LIVE_PRICE',
      mainReasons: ['سعر السوق المباشر غير متوفر أو غير صالح من Biquote MT5.'],
      invalidation: 'N/A',
      noTradeReason: 'سعر السوق المباشر غير متوفر أو غير صالح من Biquote MT5.',
    };
    return {
      hasValidSignal: false,
      selectedCandidate: null,
      allCandidates: [],
      finalSignal: fallbackSignal,
      noTradeReason: 'سعر السوق المباشر غير متوفر أو غير صالح من Biquote MT5.',
    };
  }

  const candidates: SetupCandidate[] = [];

  const last5m = candles5m[candles5m.length - 1] || { open: currentPrice, high: currentPrice, low: currentPrice, close: currentPrice, volume: 1, timestamp: Date.now() };
  const prev5m = candles5m[candles5m.length - 2] || last5m;
  const c5mMetrics = analyzeCandle(last5m);
  const prev5mMetrics = analyzeCandle(prev5m);

  const last15m = candles15m[candles15m.length - 1] || last5m;
  const c15mMetrics = analyzeCandle(last15m);

  const atr5m = Math.max(1.5, indicators5m.atr14 || 2.5);
  const atr15m = Math.max(2.0, indicators15m.atr14 || 3.5);
  const bufferGold = Math.max(0.3, Math.min(0.8, atr5m * 0.15));

  const h1Trend = indicators1h.structure;
  const m15Structure = indicators15m.structure;
  const m15Zone = indicators15m.premiumDiscountZone;
  const fib15m = calculateFibLevels(indicators15m.swingHigh, indicators15m.swingLow);
  const sessionLevels = extractSessionExtremes(candles5m);

  // =========================================================================
  // DIRECTIONAL REGIME CLASSIFICATION (FOR STRATEGY GATING & CONFLICT RESOLUTION)
  // =========================================================================
  const isStrongUptrend =
    indicators15m.marketRegime === 'STRONG_UPTREND' ||
    (indicators1h.marketRegime === 'STRONG_UPTREND' && indicators15m.marketRegime !== 'STRONG_DOWNTREND');

  const isStrongDowntrend =
    indicators15m.marketRegime === 'STRONG_DOWNTREND' ||
    (indicators1h.marketRegime === 'STRONG_DOWNTREND' && indicators15m.marketRegime !== 'STRONG_UPTREND');

  const isUptrendRegime =
    isStrongUptrend ||
    indicators15m.marketRegime === 'WEAK_UPTREND' ||
    (h1Trend === 'BULLISH' && indicators15m.trendStructure === 'HH_HL' && indicators15m.marketRegime !== 'STRONG_DOWNTREND' && indicators15m.marketRegime !== 'WEAK_DOWNTREND');

  const isDowntrendRegime =
    isStrongDowntrend ||
    indicators15m.marketRegime === 'WEAK_DOWNTREND' ||
    (h1Trend === 'BEARISH' && indicators15m.trendStructure === 'LH_LL' && indicators15m.marketRegime !== 'STRONG_UPTREND' && indicators15m.marketRegime !== 'WEAK_UPTREND');

  // Helper to validate and build candidate with Phase 3 Trade Quality & Execution Intelligence
  const evaluateCandidate = (
    family: SetupCandidate['strategyFamily'],
    setupName: string,
    direction: 'BUY' | 'SELL',
    orderType: 'MARKET' | 'LIMIT',
    proposedEntry: number,
    rawSl: number,
    reasons: string[],
    confluences: string[],
    baseStructureScore: number,
    baseLiquidityScore: number,
    basePriceActionScore: number,
    baseLocationScore: number,
    poiMeta?: {
      type?: 'ORDER_BLOCK' | 'FVG' | 'SFP_ZONE' | 'SWING_LEVEL';
      top?: number;
      bottom?: number;
      timeframe?: '1H' | '15M' | '5M';
      createdCandleTime?: number;
      invalidationPrice?: number;
    },
    patternMetadata?: Record<string, any>
  ): SetupCandidate | null => {
    // 1. Calculate SL with technical buffer
    const entry = Number(proposedEntry.toFixed(2));
    let stopLoss = direction === 'BUY'
      ? Number((rawSl - bufferGold).toFixed(2))
      : Number((rawSl + bufferGold).toFixed(2));

    const slDistance = Math.abs(entry - stopLoss);
    const slPoints = Number((slDistance / 0.1).toFixed(1));

    // SL constraint check: Must be technically meaningful (35 to 65 points on Gold)
    // If the structurally correct SL cannot satisfy the broker/risk constraints, reject the setup rather than distorting the SL
    if (slPoints < minSlPoints || slPoints > maxSlPoints) {
      return null; // Reject setup rather than artificially moving SL
    }

    const finalSlDistance = Math.abs(entry - stopLoss);
    const finalSlPoints = Number((finalSlDistance / 0.1).toFixed(1));

    // Evaluate Stop Loss Quality
    const slQuality = assessStopLossQuality(direction, entry, stopLoss, indicators5m, minSlPoints, maxSlPoints);

    // 2. Compute dynamic take profits using structural levels (TP1 >= minRr, TP2 >= 2.5R to 3R)
    let structuralTargetHint: { price: number; label: string } | undefined = undefined;
    if (
      patternMetadata?.neckline !== undefined &&
      patternMetadata?.neckline !== null &&
      typeof patternMetadata.neckline === 'number' &&
      !isNaN(patternMetadata.neckline) &&
      isFinite(patternMetadata.neckline)
    ) {
      structuralTargetHint = {
        price: patternMetadata.neckline,
        label: 'Pattern Neckline',
      };
    }

    const tpResult = calculateDynamicTakeProfits({
      direction,
      entry,
      stopLoss,
      asset,
      indicators1h,
      indicators15m,
      indicators5m,
      candles1h,
      candles15m,
      candles5m,
      minRr,
      structuralTargetHint,
    });

    const minAcceptableRr = 0.95; // Allow natural market targets starting from ~1.0R
    if (!tpResult.valid || tpResult.tp1Rr < minAcceptableRr) {
      return null;
    }

    // 3. Phase 3: TP Path Clearance & Obstacle Runway Assessment
    const tpPathAssessment = assessTpPathRunway(
      direction,
      entry,
      tpResult.tp1,
      tpResult.tp2,
      candles15m,
      candles1h,
      indicators15m,
      indicators1h
    );

    // If runway is blocked by immediate major structural barrier, disqualify setup
    if (tpPathAssessment.runway === 'BLOCKED') {
      console.log(`[StrategyEngine] Disqualified ${setupName} due to blocked TP runway (${tpPathAssessment.description})`);
      return null;
    }

    // 4. Phase 3: Setup Freshness & POI Mitigation
    let poiType = poiMeta?.type || (family === 'ORDER_BLOCK' ? 'ORDER_BLOCK' : family === 'FVG_IMBALANCE' ? 'FVG' : family === 'RANGE_SFP_REVERSAL' ? 'SFP_ZONE' : 'SWING_LEVEL');
    let poiTop = poiMeta?.top ?? (direction === 'BUY' ? Math.max(entry, rawSl) : Math.max(entry, rawSl));
    let poiBottom = poiMeta?.bottom ?? (direction === 'BUY' ? Math.min(entry, rawSl) : Math.min(entry, rawSl));
    const poiTimeframe = poiMeta?.timeframe || '15M';

    const registeredPoi = globalPoiTracker.registerPoi(
      poiType,
      poiTimeframe,
      direction === 'BUY' ? 'BULLISH' : 'BEARISH',
      poiTop,
      poiBottom,
      poiMeta?.createdCandleTime ?? (candles5m[Math.max(0, candles5m.length - 2)]?.timestamp || Date.now() - 300000),
      poiMeta?.invalidationPrice ?? stopLoss
    );

    const poiFreshness = globalPoiTracker.evaluatePoiFreshness(registeredPoi.id, candles5m, currentPrice, atr5m);
    if (!poiFreshness.isTradable) {
      console.log(`[StrategyEngine] Disqualified ${setupName}: ${poiFreshness.reason}`);
      return null;
    }

    // 5. Phase 3: Pullback Quality Assessment
    const pullbackAssessment = assessPullbackQuality(
      direction,
      candles5m,
      indicators5m,
      indicators15m.marketRegime || 'UNCLEAR'
    );

    if (
      pullbackAssessment.quality === 'INVALID' &&
      family !== 'LIQUIDITY_SWEEP' &&
      family !== 'RANGE_SFP_REVERSAL' &&
      family !== 'COUNTERTREND_SCALP' &&
      family !== 'DOUBLE_TOP_BOTTOM' &&
      family !== 'BARE_SR' &&
      family !== 'STRUCTURE_ENGULFING'
    ) {
      console.log(`[StrategyEngine] Disqualified ${setupName} due to invalid pullback structure (${pullbackAssessment.reasons.join(', ')})`);
      return null;
    }

    // 6. Phase 3: Entry Timing & Overextension / Anti-Chase Assessment
    const timingAssessment = assessEntryTimingAndAntiChase(
      direction,
      family,
      currentPrice,
      entry,
      candles5m,
      indicators5m,
      indicators15m.marketRegime || 'UNCLEAR'
    );

    let timingWarning: string | undefined = undefined;
    if (timingAssessment.timing === 'CHASED') {
      timingWarning = `CHASED (${timingAssessment.reason})`;
      console.log(`[StrategyEngine] Candidate ${setupName} tagged with timing penalty/warning (${timingAssessment.reason})`);
    }

    // 7. Phase 3: Price Action Trigger Assessment
    const triggerAssessment = assessPriceActionTrigger(
      direction,
      candles5m,
      input.candles1m || [],
      indicators5m
    );

    // 8. Phase 3: Liquidity Context Analysis
    const liquidityContext = assessLiquidityContext(
      candles5m,
      candles15m,
      candles1h,
      currentPrice,
      direction,
      indicators15m.marketRegime || 'UNCLEAR'
    );

    // 9. Phase 3: Operational Execution Quality Score (0–100)
    const eqResult = calculateExecutionQualityScore({
      timingAssessment,
      triggerAssessment,
      tpPathAssessment,
      pullbackAssessment,
      poiFreshness,
      slQuality,
      liquidityBonus: liquidityContext.liquidityScoreBonus,
    });

    // 10. Calculate Strategy Confidence (Structural Edge: 70–96)
    let technicalScore = 0;
    if (direction === 'BUY') {
      if (entry > indicators5m.vwap) technicalScore += 3;
      if (entry > indicators5m.ema20) technicalScore += 3;
      if (indicators5m.rsi14 >= 40 && indicators5m.rsi14 <= 68) technicalScore += 2;
      if (indicators5m.macd?.histogram && indicators5m.macd.histogram > 0) technicalScore += 2;
    } else {
      if (entry < indicators5m.vwap) technicalScore += 3;
      if (entry < indicators5m.ema20) technicalScore += 3;
      if (indicators5m.rsi14 <= 60 && indicators5m.rsi14 >= 32) technicalScore += 2;
      if (indicators5m.macd?.histogram && indicators5m.macd.histogram < 0) technicalScore += 2;
    }

    // HTF Alignment bonus
    let htfBonus = 0;
    if (direction === 'BUY' && h1Trend === 'BULLISH') htfBonus += 5;
    if (direction === 'SELL' && h1Trend === 'BEARISH') htfBonus += 5;
    if (direction === 'BUY' && m15Structure === 'BULLISH') htfBonus += 5;
    if (direction === 'SELL' && m15Structure === 'BEARISH') htfBonus += 5;

    const structureScore = Math.min(25, baseStructureScore + htfBonus);
    const liquidityScore = Math.min(25, baseLiquidityScore + Math.min(4, liquidityContext.liquidityScoreBonus));
    const priceActionScore = Math.min(20, basePriceActionScore);
    const locationScore = Math.min(20, baseLocationScore);
    const techScore = Math.min(10, technicalScore);

    const baseRawScore = structureScore + liquidityScore + priceActionScore + locationScore + techScore;
    const strategyConfidence = Math.min(96, Math.max(70, Math.round(baseRawScore * poiFreshness.multiplier)));

    // Composite Final Ranking Score combining Strategy Confidence & Execution Quality
    const totalScore = Math.round(strategyConfidence * 0.55 + eqResult.score * 0.45);

    const invalidation = direction === 'BUY'
      ? `كسر وإغلاق شمعة 5M أدنى مستوى وقف الخسارة $${stopLoss.toFixed(2)}`
      : `اختراق وإغلاق شمعة 5M أعلى مستوى وقف الخسارة $${stopLoss.toFixed(2)}`;

    // 11. Phase 3: Setup Lifecycle State Machine
    const lifecycleResult = globalLifecycleManager.updateLifecycle(
      setupName,
      family,
      direction,
      '15M / 5M',
      entry,
      stopLoss,
      tpResult.tp1,
      tpResult.tp2,
      registeredPoi.id,
      timingAssessment,
      triggerAssessment,
      pullbackAssessment,
      poiFreshness.state,
      eqResult.score,
      strategyConfidence
    );

    return {
      id: `cand_${family}_${direction}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      strategyFamily: family,
      setupName,
      direction,
      orderType,
      entry,
      stopLoss,
      slPoints: finalSlPoints,
      tp1: Number(tpResult.tp1.toFixed(2)),
      tp1Points: tpResult.tp1Points,
      tp1Rr: tpResult.tp1Rr,
      tp2: Number(tpResult.tp2.toFixed(2)),
      tp2Points: tpResult.tp2Points,
      tp2Rr: tpResult.tp2Rr,
      confidence: strategyConfidence,
      score: totalScore,
      strategyConfidence,
      executionQualityScore: eqResult.score,
      entryTiming: timingAssessment.timing,
      timingWarning,
      setupFreshness: poiFreshness.state,
      pullbackQuality: pullbackAssessment.quality,
      tpRunway: tpPathAssessment.runway,
      lifecycleState: lifecycleResult.state,
      poiId: registeredPoi.id,
      triggers: triggerAssessment.allTriggers,
      patternMetadata,
      executionBreakdown: eqResult.breakdown,
      timeframe: '15M / 5M',
      mainReasons: reasons,
      invalidation,
      supportingConfluences: [
        ...confluences,
        `جودة التنفيذ: ${eqResult.score}/100 (${timingAssessment.timing})`,
        ...(timingWarning ? [`تنبيه التوقيت: ${timingWarning}`] : []),
        `حالة المنطقة: ${poiFreshness.state}`,
        `مسار الهدف: ${tpPathAssessment.runway}`,
      ],
      rawScoreBreakdown: {
        structureScore,
        liquidityScore,
        priceActionScore,
        locationScore,
        technicalScore: techScore,
      },
    };
  };

  // =========================================================================
  // STRATEGY 1: LIQUIDITY SWEEP + REJECTION (High Priority SMC / Turtle Soup)
  // =========================================================================
  if (indicators15m.liquiditySweepDetected || indicators5m.liquiditySweepDetected) {
    const sweptHigh = (last5m.high > indicators15m.swingHigh && last5m.close < indicators15m.swingHigh) ||
      (prev5m.high > indicators15m.swingHigh && last5m.close < indicators15m.swingHigh);
    const sweptLow = (last5m.low < indicators15m.swingLow && last5m.close > indicators15m.swingLow) ||
      (prev5m.low < indicators15m.swingLow && last5m.close > indicators15m.swingLow);

    // Bullish Sweep of Sell-Side Liquidity (SSL)
    if (sweptLow || (last5m.low < indicators5m.swingLow && c5mMetrics.isBottomRejection)) {
      const swingLowRef = Math.min(last5m.low, prev5m.low, indicators5m.swingLow);
      const cand = evaluateCandidate(
        'LIQUIDITY_SWEEP',
        'Liquidity Sweep Reversal (SSL Sweep + Rejection)',
        'BUY',
        'MARKET',
        currentPrice,
        swingLowRef,
        [
          `سحب سيولة بيعية (SSL Sweep) أسفل $${swingLowRef.toFixed(2)} متبوع برفض سعري قوي.`,
          `إغلاق شمعة الـ5M أعلى قاع السيولة يؤكد فشل الكسر واستعادة المشترين للسيطرة.`,
          `استهداف سيولة القمم المقابلة BSL بنسبة عائد تفوق ${minRr}R.`,
        ],
        ['Liquidity Sweep', 'Bottom Wick Rejection', 'Discount Zone', 'Mean Reversion'],
        18,
        24,
        18,
        16
      );
      if (cand) candidates.push(cand);
    }

    // Bearish Sweep of Buy-Side Liquidity (BSL)
    if (sweptHigh || (last5m.high > indicators5m.swingHigh && c5mMetrics.isTopRejection)) {
      const swingHighRef = Math.max(last5m.high, prev5m.high, indicators5m.swingHigh);
      const cand = evaluateCandidate(
        'LIQUIDITY_SWEEP',
        'Liquidity Sweep Reversal (BSL Sweep + Rejection)',
        'SELL',
        'MARKET',
        currentPrice,
        swingHighRef,
        [
          `سحب سيولة شرائية (BSL Sweep) أعلى $${swingHighRef.toFixed(2)} مع رفض علوي بارز.`,
          `إغلاق شمعة الـ5M أسفل قمة السيولة يؤكد وجود صانع سوق بائع واكتمال فخ الشراء.`,
          `استهداف سيولة القيعان المقابلة SSL بنسبة عائد تفوق ${minRr}R.`,
        ],
        ['Liquidity Sweep', 'Top Wick Rejection', 'Premium Zone', 'Bearish Trap'],
        18,
        24,
        18,
        16
      );
      if (cand) candidates.push(cand);
    }
  }

  // =========================================================================
  // STRATEGY 2: ORDER BLOCK (OB) RETEST & REACTION
  // =========================================================================
  if (indicators15m.orderBlock || indicators5m.orderBlock) {
    const ob15m = indicators15m.orderBlock;
    const ob5m = indicators5m.orderBlock;

    // Bullish OB Retest (Demand Zone) - Gated: Blocked in STRONG_DOWNTREND / WEAK_DOWNTREND
    const bullishOb = ob15m?.type === 'BULLISH' ? ob15m : ob5m?.type === 'BULLISH' ? ob5m : null;
    if (!isDowntrendRegime && bullishOb && currentPrice >= bullishOb.low - 0.5 && currentPrice <= bullishOb.high + 1.2) {
      if (c5mMetrics.isBottomRejection || c5mMetrics.isBull || prev5mMetrics.isBottomRejection) {
        const cand = evaluateCandidate(
          'ORDER_BLOCK',
          'Bullish Order Block Retest & Reaction',
          'BUY',
          'MARKET',
          currentPrice,
          bullishOb.low,
          [
            `ارتداد واختبار منطقة طلب مؤسسية (Bullish Order Block) عند [$${bullishOb.low} - $${bullishOb.high}].`,
            `تأكيد سلوك السعر بظهور ذيل رفض سفلي واحترام نطاق الـOB.`,
            `حماية وقف الخسارة أسفل قاع الـOB واستحقاق عائد استثماري مجزٍ.`,
          ],
          ['Order Block Tap', 'Demand Zone', 'Bullish Reaction', 'Structure Protection'],
          20,
          18,
          16,
          20
        );
        if (cand) candidates.push(cand);
      }
    }

    // Bearish OB Retest (Supply Zone) - Gated: Blocked in STRONG_UPTREND / WEAK_UPTREND
    const bearishOb = ob15m?.type === 'BEARISH' ? ob15m : ob5m?.type === 'BEARISH' ? ob5m : null;
    if (!isUptrendRegime && bearishOb && currentPrice <= bearishOb.high + 0.5 && currentPrice >= bearishOb.low - 1.2) {
      if (c5mMetrics.isTopRejection || c5mMetrics.isBear || prev5mMetrics.isTopRejection) {
        const cand = evaluateCandidate(
          'ORDER_BLOCK',
          'Bearish Order Block Retest & Reaction',
          'SELL',
          'MARKET',
          currentPrice,
          bearishOb.high,
          [
            `اختبار منطقة عرض مؤسسية (Bearish Order Block) عند [$${bearishOb.low} - $${bearishOb.high}].`,
            `ظهور شمعة رفض بيعية واحترام واضح لحدود الـOB.`,
            `وقف خسارة آمن أعلى قمة الـOB مع هدف ربحي ممتاز.`,
          ],
          ['Order Block Tap', 'Supply Zone', 'Bearish Reaction', 'Structure Protection'],
          20,
          18,
          16,
          20
        );
        if (cand) candidates.push(cand);
      }
    }
  }

  // =========================================================================
  // STRATEGY 3: FAIR VALUE GAP (FVG) / IMBALANCE MITIGATION
  // =========================================================================
  if (indicators15m.fvg || indicators5m.fvg) {
    const fvg = indicators15m.fvg || indicators5m.fvg;
    // Bullish FVG - Gated: Blocked in STRONG_DOWNTREND / WEAK_DOWNTREND
    if (!isDowntrendRegime && fvg && fvg.type === 'BULLISH' && currentPrice >= fvg.bottom - 0.5 && currentPrice <= fvg.top + 0.8) {
      if (c5mMetrics.isBottomRejection || c5mMetrics.isBull) {
        const cand = evaluateCandidate(
          'FVG_IMBALANCE',
          'Bullish Fair Value Gap (FVG) Mitigation',
          'BUY',
          'MARKET',
          currentPrice,
          fvg.bottom,
          [
            `تغطية وإعادة توازن فجوة السيولة (Bullish FVG) عند [$${fvg.bottom} - $${fvg.top}].`,
            `تفاعل شرائي إيجابي من مستوى عدم التوازن في اتجاه استمرار الحركة.`,
            `هدف ربحي يتجاوز ${minRr}R نحو السيولة العلوية.`,
          ],
          ['FVG Mitigation', 'Imbalance Filled', 'Discount Alignment', 'Clean Target'],
          19,
          16,
          16,
          19
        );
        if (cand) candidates.push(cand);
      }
    // Bearish FVG - Gated: Blocked in STRONG_UPTREND / WEAK_UPTREND
    } else if (!isUptrendRegime && fvg && fvg.type === 'BEARISH' && currentPrice <= fvg.top + 0.5 && currentPrice >= fvg.bottom - 0.8) {
      if (c5mMetrics.isTopRejection || c5mMetrics.isBear) {
        const cand = evaluateCandidate(
          'FVG_IMBALANCE',
          'Bearish Fair Value Gap (FVG) Mitigation',
          'SELL',
          'MARKET',
          currentPrice,
          fvg.top,
          [
            `إعادة اختبار فجوة سيولة هابطة (Bearish FVG) عند [$${fvg.bottom} - $${fvg.top}].`,
            `تفاعل بيعي هابط ورفض للصعود أعلى الفجوة.`,
            `استهداف قيعان السيولة المقابلة بنسبة عائد تحقق الهدف الأدنى.`,
          ],
          ['FVG Mitigation', 'Imbalance Filled', 'Premium Alignment', 'Clean Target'],
          19,
          16,
          16,
          19
        );
        if (cand) candidates.push(cand);
      }
    }
  }

  // =========================================================================
  // STRATEGY 4: MARKET STRUCTURE BOS / CHOCH CONTINUATION & RETEST
  // =========================================================================
  if (indicators15m.bosDetected || indicators15m.chochDetected || indicators5m.bosDetected || indicators5m.chochDetected) {
    const isBullShift = indicators15m.structureShift?.includes('Bullish') || indicators5m.structureShift?.includes('Bullish');
    const isBearShift = indicators15m.structureShift?.includes('Bearish') || indicators5m.structureShift?.includes('Bearish');

    if (isBullShift && currentPrice > indicators5m.ema20) {
      const recentLow = indicators5m.swingLow;
      const cand = evaluateCandidate(
        'MARKET_STRUCTURE',
        'Bullish Market Structure Shift (BOS / CHOCH)',
        'BUY',
        'MARKET',
        currentPrice,
        recentLow,
        [
          `كسر هيكلي صاعد (Bullish BOS/CHOCH) يؤكد انتقال السيطرة لصالح المشترين.`,
          `استقرار السعر أعلى المتوسطات المتحركة السريعة والـVWAP.`,
          `هدف ربحي يتطابق مع القمة السابقة ومناطق السيولة المقابلة.`,
        ],
        ['BOS Confirmation', 'CHOCH Shift', 'EMA Alignment', 'Trend Momentum'],
        23,
        16,
        17,
        15
      );
      if (cand) candidates.push(cand);
    }

    if (isBearShift && currentPrice < indicators5m.ema20) {
      const recentHigh = indicators5m.swingHigh;
      const cand = evaluateCandidate(
        'MARKET_STRUCTURE',
        'Bearish Market Structure Shift (BOS / CHOCH)',
        'SELL',
        'MARKET',
        currentPrice,
        recentHigh,
        [
          `كسر هيكلي هابط (Bearish BOS/CHOCH) يؤكد استمرار أو تحول المسار الهابط.`,
          `السعر يتداول بانتظام أسفل الـEMA والـVWAP.`,
          `هدف ربحي يحقق نسبة مخاطرة إلى عائد تزيد عن ${minRr}R.`,
        ],
        ['BOS Confirmation', 'CHOCH Shift', 'EMA Alignment', 'Bearish Momentum'],
        23,
        16,
        17,
        15
      );
      if (cand) candidates.push(cand);
    }
  }

  // =========================================================================
  // STRATEGY 5: FIBONACCI OTE (61.8% - 78.6%) IN PREMIUM / DISCOUNT
  // =========================================================================
  if (!isDowntrendRegime && m15Zone === 'DISCOUNT' && currentPrice >= fib15m.bullishOteLow - 1.0 && currentPrice <= fib15m.bullishOteHigh + 1.0) {
    if (c5mMetrics.isBottomRejection || c5mMetrics.isBull) {
      const cand = evaluateCandidate(
        'FIBONACCI_OTE',
        'Fibonacci Optimal Trade Entry (OTE 61.8% - 78.6% Discount)',
        'BUY',
        'MARKET',
        currentPrice,
        indicators15m.swingLow,
        [
          `تراجع السعر لمنطقة الشراء المثالية (OTE 61.8% - 78.6%) في منطقة الخصم (Discount Zone).`,
          `تطابق فيبوناتشي مع ارتداد فني إيجابي يحمي وقف الخسارة.`,
          `استهداف قمة الرينج (Swing High) ونسب التوسع 1.272 / 1.618.`,
        ],
        ['Fibonacci OTE', 'Discount Zone', 'Golden Pocket', 'High RR Target'],
        18,
        17,
        15,
        22
      );
      if (cand) candidates.push(cand);
    }
  } else if (!isUptrendRegime && m15Zone === 'PREMIUM' && currentPrice >= fib15m.bearishOteLow - 1.0 && currentPrice <= fib15m.bearishOteHigh + 1.0) {
    if (c5mMetrics.isTopRejection || c5mMetrics.isBear) {
      const cand = evaluateCandidate(
        'FIBONACCI_OTE',
        'Fibonacci Optimal Trade Entry (OTE 61.8% - 78.6% Premium)',
        'SELL',
        'MARKET',
        currentPrice,
        indicators15m.swingHigh,
        [
          `وصول السعر لمنطقة البيع المثالية (OTE 61.8% - 78.6%) في منطقة العلاوة (Premium Zone).`,
          `رفض سعري من الجولدن بوكيت (Golden Pocket) يؤيد الهبوط.`,
          `استهداف قاع الرينج (Swing Low) بنسبة عائد تتجاوز ${minRr}R.`,
        ],
        ['Fibonacci OTE', 'Premium Zone', 'Golden Pocket', 'High RR Target'],
        18,
        17,
        15,
        22
      );
      if (cand) candidates.push(cand);
    }
  }

  // =========================================================
  // STRATEGY 6: TREND CONTINUATION ON EMA / VWAP PULLBACK
  // =========================================================
  const isTrendUptrend =
    indicators15m.marketRegime === 'STRONG_UPTREND' ||
    indicators15m.marketRegime === 'WEAK_UPTREND' ||
    (h1Trend === 'BULLISH' && indicators15m.trendStructure === 'HH_HL');

  const isTrendDowntrend =
    indicators15m.marketRegime === 'STRONG_DOWNTREND' ||
    indicators15m.marketRegime === 'WEAK_DOWNTREND' ||
    (h1Trend === 'BEARISH' && indicators15m.trendStructure === 'LH_LL');

  if (isTrendUptrend) {
    // In strong trend, pullback can be shallow (to EMA20) or standard (to EMA50 / VWAP)
    const isPullbackToEma =
      Math.abs(currentPrice - indicators5m.ema20) <= atr5m * 1.5 ||
      Math.abs(currentPrice - indicators5m.ema50) <= atr5m * 1.5 ||
      Math.abs(currentPrice - indicators5m.vwap) <= atr5m * 1.5 ||
      currentPrice <= indicators5m.ema20 + atr5m * 1.0;

    if (isPullbackToEma && (c5mMetrics.isBottomRejection || c5mMetrics.isBull || currentPrice >= indicators5m.ema20)) {
      const pullbackSl = Math.min(last5m.low, prev5m.low);
      const cand = evaluateCandidate(
        'MARKET_STRUCTURE',
        'Bullish Trend Continuation (EMA/VWAP Pullback)',
        'BUY',
        'MARKET',
        currentPrice,
        pullbackSl,
        [
          `اتجاه عام صاعد قوي (${indicators15m.marketRegime || 'HH/HL'}) على الفريمات 1H و 15M.`,
          `إعادة اختبار ناجحة للمتوسطات المتحركة والـVWAP مع استئناف زخم المشترين.`,
          `استهداف قمم هيكلية جديدة مع اتجاه السوق الرئيسي.`,
        ],
        ['Trend Following', 'EMA Support', 'VWAP Support', 'Clean Momentum'],
        22,
        15,
        16,
        18
      );
      if (cand) candidates.push(cand);
    }
  } else if (isTrendDowntrend) {
    // In strong trend, pullback can be shallow (to EMA20) or standard (to EMA50 / VWAP)
    const isPullbackToEma =
      Math.abs(currentPrice - indicators5m.ema20) <= atr5m * 1.5 ||
      Math.abs(currentPrice - indicators5m.ema50) <= atr5m * 1.5 ||
      Math.abs(currentPrice - indicators5m.vwap) <= atr5m * 1.5 ||
      currentPrice >= indicators5m.ema20 - atr5m * 1.0;

    if (isPullbackToEma && (c5mMetrics.isTopRejection || c5mMetrics.isBear || currentPrice <= indicators5m.ema20)) {
      const pullbackSl = Math.max(last5m.high, prev5m.high);
      const cand = evaluateCandidate(
        'MARKET_STRUCTURE',
        'Bearish Trend Continuation (EMA/VWAP Pullback)',
        'SELL',
        'MARKET',
        currentPrice,
        pullbackSl,
        [
          `اتجاه هابط رئيسي قوي (${indicators15m.marketRegime || 'LH/LL'}) على فريم 1H و 15M.`,
          `رفض سعري عند إعادة اختبار المتوسطات المتحركة أو VWAP واستئناف ضغط البيع.`,
          `استهداف قيعان جديدة وتحقيق عائد مخاطرة ممتاز.`,
        ],
        ['Trend Following', 'EMA Resistance', 'VWAP Resistance', 'Bearish Momentum'],
        22,
        15,
        16,
        18
      );
      if (cand) candidates.push(cand);
    }
  }

  // =========================================================================
  // STRATEGY 7: COUNTERTREND SCALP (Extreme Extension + Strong Reversal)
  // =========================================================================
  if (indicators5m.rsi14 >= 72 && c5mMetrics.isTopRejection && currentPrice > indicators15m.swingHigh - 1.0) {
    const cand = evaluateCandidate(
      'COUNTERTREND_SCALP',
      'Countertrend Mean-Reversion Scalp (Overbought Rejection)',
      'SELL',
      'MARKET',
      currentPrice,
      Math.max(last5m.high, indicators5m.swingHigh),
      [
        `تشبع شرائي حاد (RSI > 72) مع ذيل رفض علوي قوي عند قمة النطاق.`,
        `فرصة مضاربية سريعة لاستهداف الارتداد نحو خط التوازن (VWAP / 50% Equilibrium).`,
        `وقف خسارة فني محكم أعلى قمة الشمعة الحالية.`,
      ],
      ['Mean Reversion', 'RSI Overbought', 'Top Rejection Wick', 'Tight SL Scalp'],
      14,
      20,
      20,
      17
    );
    if (cand) candidates.push(cand);
  } else if (indicators5m.rsi14 <= 28 && c5mMetrics.isBottomRejection && currentPrice < indicators15m.swingLow + 1.0) {
    const cand = evaluateCandidate(
      'COUNTERTREND_SCALP',
      'Countertrend Mean-Reversion Scalp (Oversold Bounce)',
      'BUY',
      'MARKET',
      currentPrice,
      Math.min(last5m.low, indicators5m.swingLow),
      [
        `تشبع بيعي مفرط (RSI < 28) مع شمعة ارتداد ذات ذيل سفلي واضح.`,
        `صفقة سريعة لاستهداف الارتداد التصحيحي نحو متوسطات الحركة.`,
        `وقف خسارة دقيق أسفل قاع السيولة الأخير.`,
      ],
      ['Mean Reversion', 'RSI Oversold', 'Bottom Rejection Wick', 'Tight SL Scalp'],
      14,
      20,
      20,
      17
    );
    if (cand) candidates.push(cand);
  }

  // =========================================================================
  // STRATEGY 8 (Phase 2): RANGE_SFP_REVERSAL (Swing Failure Pattern at Range Boundaries)
  // =========================================================================
  const isRangeRegime =
    indicators15m.marketRegime === 'NORMAL_RANGE' ||
    indicators15m.marketRegime === 'VOLATILE_RANGE' ||
    indicators15m.structure === 'RANGING';

  if (isRangeRegime) {
    const rangeHigh = indicators15m.regimeContext?.rangeBoundaries?.high ?? Math.max(indicators15m.swingHigh, indicators15m.resistance);
    const rangeLow = indicators15m.regimeContext?.rangeBoundaries?.low ?? Math.min(indicators15m.swingLow, indicators15m.support);
    const rangeSpan = Math.max(2.0, rangeHigh - rangeLow);
    const midZoneThreshold = rangeSpan * 0.35; // Extreme zone is within 35% of high or low
    const sweepTolerance = Math.max(0.6, atr5m * 0.25);

    // 1. Bearish Range SFP (Liquidity sweep above Range High + Rejection back inside)
    const isNearRangeHigh = currentPrice >= (rangeHigh - midZoneThreshold);
    const sweptRangeHigh =
      (last5m.high >= rangeHigh - sweepTolerance || prev5m.high >= rangeHigh - sweepTolerance) &&
      last5m.close <= rangeHigh + sweepTolerance * 0.7;

    const hasBearishRejection =
      c5mMetrics.isTopRejection ||
      c5mMetrics.isBear ||
      prev5mMetrics.isTopRejection ||
      last5m.close < prev5m.close ||
      indicators5m.rsi14 >= 52;

    if (isNearRangeHigh && sweptRangeHigh && hasBearishRejection) {
      const sfpHighPoint = Math.max(last5m.high, prev5m.high, rangeHigh);
      const cand = evaluateCandidate(
        'RANGE_SFP_REVERSAL',
        'Range SFP Reversal (Range High Liquidity Sweep & Rejection)',
        'SELL',
        'MARKET',
        currentPrice,
        sfpHighPoint,
        [
          `سحب سيولة القمة (Range High SFP Sweep) أعلى $${rangeHigh.toFixed(2)} وفشل الاختراق مع عودة السعر داخل النطاق.`,
          `ظهور شمعة رفض بيعية تؤكد فخ الشراء (Bull Trap) عند المقاومة العلوية للرينج.`,
          `استهداف قاع النطاق وخط التوازن (Equilibrium) بنسبة عائد تتجاوز ${minRr}R.`,
        ],
        ['Range High SFP', 'Liquidity Sweep', 'Bull Trap', 'Mean Reversion', 'Range Extreme'],
        21,
        24,
        19,
        20
      );
      if (cand) candidates.push(cand);
    }

    // 2. Bullish Range SFP (Liquidity sweep below Range Low + Rejection back inside)
    const isNearRangeLow = currentPrice <= (rangeLow + midZoneThreshold);
    const sweptRangeLow =
      (last5m.low <= rangeLow + sweepTolerance || prev5m.low <= rangeLow + sweepTolerance) &&
      last5m.close >= rangeLow - sweepTolerance * 0.7;

    const hasBullishRejection =
      c5mMetrics.isBottomRejection ||
      c5mMetrics.isBull ||
      prev5mMetrics.isBottomRejection ||
      last5m.close > prev5m.close ||
      indicators5m.rsi14 <= 48;

    if (isNearRangeLow && sweptRangeLow && hasBullishRejection) {
      const sfpLowPoint = Math.min(last5m.low, prev5m.low, rangeLow);
      const cand = evaluateCandidate(
        'RANGE_SFP_REVERSAL',
        'Range SFP Reversal (Range Low Liquidity Sweep & Rejection)',
        'BUY',
        'MARKET',
        currentPrice,
        sfpLowPoint,
        [
          `سحب سيولة القاع (Range Low SFP Sweep) أسفل $${rangeLow.toFixed(2)} وفشل الكسر الهابط مع استعادة النطاق.`,
          `ظهور شمعة ارتداد شرائية تؤكد فخ البيع (Bear Trap) عند الدعم السفلي للرينج.`,
          `استهداف قمة النطاق وخط التوازن (Equilibrium) بنسبة عائد تتجاوز ${minRr}R.`,
        ],
        ['Range Low SFP', 'Liquidity Sweep', 'Bear Trap', 'Mean Reversion', 'Range Extreme'],
        21,
        24,
        19,
        20
      );
      if (cand) candidates.push(cand);
    }
  }

  // =========================================================================
  // STRATEGY 9 (Phase 2): RANGE_BREAKOUT_EXPANSION (Genuine Range Expansion)
  // =========================================================================
  const rangeHighBoundary = indicators15m.regimeContext?.rangeBoundaries?.high ?? Math.max(indicators15m.swingHigh, indicators15m.resistance);
  const rangeLowBoundary = indicators15m.regimeContext?.rangeBoundaries?.low ?? Math.min(indicators15m.swingLow, indicators15m.support);

  const bb5mWidth = indicators5m.bollingerBands ? (indicators5m.bollingerBands.upper - indicators5m.bollingerBands.lower) : 10.0;
  const isSqueezePreceding =
    bb5mWidth <= Math.max(12.0, atr5m * 5.0) ||
    indicators15m.marketRegime === 'NORMAL_RANGE' ||
    indicators15m.marketRegime === 'VOLATILE_RANGE' ||
    indicators15m.marketRegime === 'TRANSITION' ||
    indicators15m.marketRegime === 'STRONG_UPTREND' ||
    indicators15m.marketRegime === 'STRONG_DOWNTREND' ||
    indicators15m.marketRegime === 'WEAK_UPTREND' ||
    indicators15m.marketRegime === 'WEAK_DOWNTREND';

  const isOverextendedRegime = indicators15m.regimeContext?.isOverextended === true;

  // 1. Bullish Range Breakout & Expansion (BUY)
  // Decisive close ABOVE range high, solid candle body, no excessive upper wick rejection
  const isDecisiveBullClose =
    last5m.close > rangeHighBoundary &&
    c5mMetrics.isBull &&
    c5mMetrics.body >= c5mMetrics.totalRange * 0.40 &&
    c5mMetrics.upperWick <= c5mMetrics.totalRange * 0.45;

  const isNotOverextendedUpside =
    !isOverextendedRegime &&
    currentPrice <= rangeHighBoundary + Math.max(5.0, atr5m * 3.0);

  const hasBullMomentum =
    currentPrice >= indicators5m.ema20 ||
    (indicators5m.macd?.histogram ?? 0) >= 0 ||
    indicators5m.rsi14 >= 50 ||
    (indicators5m.bollingerBands ? last5m.close >= indicators5m.bollingerBands.middle : true);

  if (isSqueezePreceding && isDecisiveBullClose && isNotOverextendedUpside && hasBullMomentum) {
    // Structural SL placed just below broken range high / recent candle low with buffer
    const breakoutSl = Math.min(rangeHighBoundary, last5m.low);
    const cand = evaluateCandidate(
      'RANGE_BREAKOUT_EXPANSION',
      'Range Breakout & Expansion (Bullish Volatility Expansion)',
      'BUY',
      'MARKET',
      currentPrice,
      breakoutSl,
      [
        `اختراق صاعد حاسم لأعلى نطاق التداول ($${rangeHighBoundary.toFixed(2)}) بإغلاق شمعة زخم كاملة فوق النطاق.`,
        `انفجار تقلبات وزخم شرائي (Volatility Expansion) بعد مرحلة ضغط سعري وتجميع.`,
        `استهداف امتدادات فيبوناتشي ومستويات السيولة الصاعدة بنسبة عائد تتجاوز ${minRr}R.`,
      ],
      ['Range Breakout', 'Volatility Expansion', 'Momentum Surge', 'Structural Shift'],
      23,
      17,
      20,
      18
    );
    if (cand) candidates.push(cand);
  }

  // 2. Bearish Range Breakout & Expansion (SELL)
  // Decisive close BELOW range low, solid candle body, no excessive lower wick rejection
  const isDecisiveBearClose =
    last5m.close < rangeLowBoundary &&
    c5mMetrics.isBear &&
    c5mMetrics.body >= c5mMetrics.totalRange * 0.40 &&
    c5mMetrics.lowerWick <= c5mMetrics.totalRange * 0.45;

  const isNotOverextendedDownside =
    !isOverextendedRegime &&
    currentPrice >= rangeLowBoundary - Math.max(5.0, atr5m * 3.0);

  const hasBearMomentum =
    currentPrice <= indicators5m.ema20 ||
    (indicators5m.macd?.histogram ?? 0) <= 0 ||
    indicators5m.rsi14 <= 50 ||
    (indicators5m.bollingerBands ? last5m.close <= indicators5m.bollingerBands.middle : true);

  if (isSqueezePreceding && isDecisiveBearClose && isNotOverextendedDownside && hasBearMomentum) {
    // Structural SL placed just above broken range low / recent candle high with buffer
    const breakoutSl = Math.max(rangeLowBoundary, last5m.high);
    const cand = evaluateCandidate(
      'RANGE_BREAKOUT_EXPANSION',
      'Range Breakout & Expansion (Bearish Volatility Expansion)',
      'SELL',
      'MARKET',
      currentPrice,
      breakoutSl,
      [
        `كسر هابط حاسم لأسفل نطاق التداول ($${rangeLowBoundary.toFixed(2)}) بإغلاق شمعة زخم بيعي كاملة أسفل النطاق.`,
        `انفجار تقلبات وزخم بيعي متسارع (Volatility Expansion) بعد مرحلة ضغط سعري وتصريف.`,
        `استهداف امتدادات فيبوناتشي ومستويات السيولة الهابطة بنسبة عائد تتجاوز ${minRr}R.`,
      ],
      ['Range Breakout', 'Volatility Expansion', 'Bearish Momentum', 'Structural Shift'],
      23,
      17,
      20,
      18
    );
    if (cand) candidates.push(cand);
  }

  // =========================================================================
  // STRATEGY 10 (Phase 2): DOUBLE_TOP_BOTTOM_REVERSAL (M & W Formations)
  // =========================================================================
  const doubleTopBottomPatterns = detectDoubleTopBottom(candles5m, atr5m);
  for (const pat of doubleTopBottomPatterns) {
    if (pat.type === 'DOUBLE_TOP') {
      const cand = evaluateCandidate(
        'DOUBLE_TOP_BOTTOM',
        'Double Top Reversal (M-Formation)',
        'SELL',
        'MARKET',
        currentPrice,
        pat.extremeLevel,
        [
          `رصد نمط قمة مزدوجة (Double Top / M-Formation) عند مستوى $${pat.extremeLevel.toFixed(2)} مع تباعد محوري واضح.`,
          `رفض السعر من القمة الثانية مع تأكيد إغلاق شمعة زخم أسفل القمة وخط العنق عند $${pat.neckline.toFixed(2)}.`,
          `استهداف مستويات السيولة السفلى بنسبة عائد تتجاوز ${minRr}R.`,
        ],
        ['Double Top M-Pattern', 'Bearish Rejection', 'Neckline Breakout', 'Liquidity Target'],
        22,
        20,
        20,
        18,
        {
          type: 'SFP_ZONE',
          top: pat.extremeLevel + 0.3 * atr5m,
          bottom: pat.extremeLevel - 0.5 * atr5m,
          timeframe: '5M',
          createdCandleTime: pat.pivot2Time,
        },
        {
          strategyId: 'S10',
          patternType: 'DOUBLE_TOP',
          pivot1: pat.pivot1,
          pivot2: pat.pivot2,
          pivot1Time: pat.pivot1Time,
          pivot2Time: pat.pivot2Time,
          neckline: pat.neckline,
          extremeLevel: pat.extremeLevel,
          patternAnchorKey: pat.patternAnchorKey,
        }
      );
      if (cand) candidates.push(cand);
    } else if (pat.type === 'DOUBLE_BOTTOM') {
      const cand = evaluateCandidate(
        'DOUBLE_TOP_BOTTOM',
        'Double Bottom Reversal (W-Formation)',
        'BUY',
        'MARKET',
        currentPrice,
        pat.extremeLevel,
        [
          `رصد نمط قاع مزدوج (Double Bottom / W-Formation) عند مستوى $${pat.extremeLevel.toFixed(2)} مع تباعد محوري واضح.`,
          `ارتداد السعر من القاع الثاني مع تأكيد إغلاق شمعة زخم صاعدة أعلاه وخط العنق عند $${pat.neckline.toFixed(2)}.`,
          `استهداف مستويات السيولة العليا بنسبة عائد تتجاوز ${minRr}R.`,
        ],
        ['Double Bottom W-Pattern', 'Bullish Rejection', 'Neckline Breakout', 'Liquidity Target'],
        22,
        20,
        20,
        18,
        {
          type: 'SFP_ZONE',
          top: pat.extremeLevel + 0.5 * atr5m,
          bottom: pat.extremeLevel - 0.3 * atr5m,
          timeframe: '5M',
          createdCandleTime: pat.pivot2Time,
        },
        {
          strategyId: 'S10',
          patternType: 'DOUBLE_BOTTOM',
          pivot1: pat.pivot1,
          pivot2: pat.pivot2,
          pivot1Time: pat.pivot1Time,
          pivot2Time: pat.pivot2Time,
          neckline: pat.neckline,
          extremeLevel: pat.extremeLevel,
          patternAnchorKey: pat.patternAnchorKey,
        }
      );
      if (cand) candidates.push(cand);
    }
  }

  // =========================================================================
  // STRATEGY 11 (Phase 2): BARE_SR_REJECTION (Classic Support / Resistance)
  // =========================================================================
  const bareSrLevels = detectBareSRLevels(candles15m, candles5m, atr15m);
  for (const sr of bareSrLevels) {
    if (sr.type === 'RESISTANCE') {
      const isNearLevel = currentPrice <= sr.level + 0.5 * atr15m && currentPrice >= sr.level - 1.2 * atr15m;
      const recentHighTouched = last5m.high >= sr.level - 0.3 * atr5m;
      const showsRejection = (c5mMetrics.upperWick >= 0.35 * c5mMetrics.totalRange || c5mMetrics.upperWick >= 0.4 * atr5m) && last5m.close < sr.level;

      if (isNearLevel && recentHighTouched && showsRejection) {
        const cand = evaluateCandidate(
          'BARE_SR',
          'Bare Resistance Rejection',
          'SELL',
          'MARKET',
          currentPrice,
          sr.level,
          [
            `ارتطام ورفض مباشر من مستوى مقاومة أفقية رئيسية ($${sr.level.toFixed(2)}) تم اختبارها ${sr.touches} مرات سابقاً.`,
            `تكون فتيل رفض علوي بارز (Upper Wick Rejection) مع إغلاق شمعة 5M أسفل مستوى المقاومة.`,
            `استهداف مستويات الدعم المواجهة والسيولة البيعية بنسبة عائد تتجاوز ${minRr}R.`,
          ],
          ['Bare Resistance', 'Multi-Touch Level', 'Upper Wick Rejection', 'Structural Wall'],
          20,
          18,
          20,
          18,
          {
            type: 'SWING_LEVEL',
            top: sr.level + 0.3 * atr15m,
            bottom: sr.level - 0.3 * atr15m,
            timeframe: '15M',
            createdCandleTime: last5m.timestamp,
          },
          {
            strategyId: 'S11',
            level: sr.level,
            touches: sr.touches,
            strength: sr.strength,
          }
        );
        if (cand) candidates.push(cand);
      }
    } else if (sr.type === 'SUPPORT') {
      const isNearLevel = currentPrice >= sr.level - 0.5 * atr15m && currentPrice <= sr.level + 1.2 * atr15m;
      const recentLowTouched = last5m.low <= sr.level + 0.3 * atr5m;
      const showsRejection = (c5mMetrics.lowerWick >= 0.35 * c5mMetrics.totalRange || c5mMetrics.lowerWick >= 0.4 * atr5m) && last5m.close > sr.level;

      if (isNearLevel && recentLowTouched && showsRejection) {
        const cand = evaluateCandidate(
          'BARE_SR',
          'Bare Support Rejection',
          'BUY',
          'MARKET',
          currentPrice,
          sr.level,
          [
            `ارتطام وارتداد مباشر من مستوى دعم أفقي قوي ($${sr.level.toFixed(2)}) تم اختباره ${sr.touches} مرات سابقاً.`,
            `تكون فتيل رفض سفلي بارز (Lower Wick Rejection) مع إغلاق شمعة 5M أعلى مستوى الدعم.`,
            `استهداف مستويات المقاومة التالية والسيولة الشرائية بنسبة عائد تتجاوز ${minRr}R.`,
          ],
          ['Bare Support', 'Multi-Touch Level', 'Lower Wick Rejection', 'Structural Floor'],
          20,
          18,
          20,
          18,
          {
            type: 'SWING_LEVEL',
            top: sr.level + 0.3 * atr15m,
            bottom: sr.level - 0.3 * atr15m,
            timeframe: '15M',
            createdCandleTime: last5m.timestamp,
          },
          {
            strategyId: 'S11',
            level: sr.level,
            touches: sr.touches,
            strength: sr.strength,
          }
        );
        if (cand) candidates.push(cand);
      }
    }
  }

  // =========================================================================
  // STRATEGY 12 (Phase 2): HORIZONTAL_BREAKOUT_RETEST (Breakout & Retest)
  // =========================================================================
  const retestPatterns = detectHorizontalBreakoutRetest(candles15m, candles5m, atr15m);
  for (const retest of retestPatterns) {
    if (retest.type === 'RESISTANCE_TO_SUPPORT') {
      const cand = evaluateCandidate(
        'BREAK_AND_RETEST',
        'Horizontal Resistance Breakout & Retest',
        'BUY',
        'MARKET',
        currentPrice,
        retest.brokenLevel,
        [
          `إعادة اختبار ناجحة لمستوى مقاومة مخترق سابقاً عند $${retest.brokenLevel.toFixed(2)} تحول إلى دعم هيكلي جديد (Resistance Turned Support).`,
          `تأكيد رفض هابط عند إعادة الاختبار مع استقرار السعر أعلى المستوى المخترق.`,
          `استهداف الامتدادات الصاعدة والسيولة الشرائية المستهدفة بنسبة عائد تتجاوز ${minRr}R.`,
        ],
        ['Breakout & Retest', 'Role Reversal SR', 'Structural Continuation', 'Clean Confirmation'],
        22,
        18,
        19,
        19,
        {
          type: 'SWING_LEVEL',
          top: retest.brokenLevel + 0.3 * atr15m,
          bottom: retest.brokenLevel - 0.3 * atr15m,
          timeframe: '15M',
          createdCandleTime: last5m.timestamp,
        },
        {
          strategyId: 'S12',
          brokenLevel: retest.brokenLevel,
          breakoutCandleClose: retest.breakoutCandleClose,
          retestPrice: retest.retestPrice,
        }
      );
      if (cand) candidates.push(cand);
    } else if (retest.type === 'SUPPORT_TO_RESISTANCE') {
      const cand = evaluateCandidate(
        'BREAK_AND_RETEST',
        'Horizontal Support Breakout & Retest',
        'SELL',
        'MARKET',
        currentPrice,
        retest.brokenLevel,
        [
          `إعادة اختبار ناجحة لمستوى دعم مكسور سابقاً عند $${retest.brokenLevel.toFixed(2)} تحول إلى مقاومة هيكلية جديدة (Support Turned Resistance).`,
          `تأكيد رفض صاعد عند إعادة الاختبار مع استقرار السعر أسفل المستوى المكسور.`,
          `استهداف الامتدادات الهابطة والسيولة البيعية المستهدفة بنسبة عائد تتجاوز ${minRr}R.`,
        ],
        ['Breakout & Retest', 'Role Reversal SR', 'Structural Continuation', 'Clean Confirmation'],
        22,
        18,
        19,
        19,
        {
          type: 'SWING_LEVEL',
          top: retest.brokenLevel + 0.3 * atr15m,
          bottom: retest.brokenLevel - 0.3 * atr15m,
          timeframe: '15M',
          createdCandleTime: last5m.timestamp,
        },
        {
          strategyId: 'S12',
          brokenLevel: retest.brokenLevel,
          breakoutCandleClose: retest.breakoutCandleClose,
          retestPrice: retest.retestPrice,
        }
      );
      if (cand) candidates.push(cand);
    }
  }

  // =========================================================================
  // STRATEGY 13 (Phase 2): STRUCTURE_ENGULFING_REVERSAL (Engulfing Candle at Key Structure)
  // =========================================================================
  if (candles5m.length >= 3) {
    const prevCandle = candles5m[candles5m.length - 2];
    const prevBody = Math.abs(prevCandle.close - prevCandle.open);
    const currBody = Math.abs(last5m.close - last5m.open);

    const isEngulfingSize = currBody >= Math.max(prevBody * 1.2, 0.4 * atr5m);

    // Structural context checks
    const nearResistance = Math.abs(currentPrice - indicators15m.resistance) <= 1.0 * atr15m || currentPrice >= indicators15m.swingHigh - 0.8 * atr15m;
    const nearSupport = Math.abs(currentPrice - indicators15m.support) <= 1.0 * atr15m || currentPrice <= indicators15m.swingLow + 0.8 * atr15m;
    const isDiscount = indicators15m.premiumDiscountZone === 'DISCOUNT';
    const isPremium = indicators15m.premiumDiscountZone === 'PREMIUM';

    // Bullish Engulfing (BUY)
    const isBullEngulfing = prevCandle.close < prevCandle.open && last5m.close > last5m.open && last5m.close > prevCandle.open && isEngulfingSize;
    if (isBullEngulfing && (nearSupport || isDiscount)) {
      const cand = evaluateCandidate(
        'STRUCTURE_ENGULFING',
        'Bullish Engulfing Reversal at Key Structure',
        'BUY',
        'MARKET',
        currentPrice,
        Math.min(last5m.low, prevCandle.low),
        [
          `ظهور شمعة ابتلاعية صاعدة (Bullish Engulfing) عند منطقة هيكلية هامة ($${currentPrice.toFixed(2)}).`,
          `تغلب كامل للمشترين على الشمعة البيعية السابقة مع إغلاق أعلى من سعر افتتاح الشمعة السابقة.`,
          `توافق النمط مع منطقة ${indicators15m.premiumDiscountZone || 'Discount'} بنسبة عائد تتجاوز ${minRr}R.`,
        ],
        ['Bullish Engulfing', 'Structural Reversal', 'Candle Pattern Confirmation', 'Discount Zone'],
        20,
        17,
        22,
        18,
        {
          type: 'SWING_LEVEL',
          top: Math.max(last5m.high, prevCandle.high),
          bottom: Math.min(last5m.low, prevCandle.low),
          timeframe: '5M',
          createdCandleTime: last5m.timestamp,
        },
        {
          strategyId: 'S13',
          direction: 'BUY',
          prevBody,
          currBody,
          engulfingRatio: (currBody / Math.max(0.01, prevBody)).toFixed(2),
        }
      );
      if (cand) candidates.push(cand);
    }

    // Bearish Engulfing (SELL)
    const isBearEngulfing = prevCandle.close > prevCandle.open && last5m.close < last5m.open && last5m.close < prevCandle.open && isEngulfingSize;
    if (isBearEngulfing && (nearResistance || isPremium)) {
      const cand = evaluateCandidate(
        'STRUCTURE_ENGULFING',
        'Bearish Engulfing Reversal at Key Structure',
        'SELL',
        'MARKET',
        currentPrice,
        Math.max(last5m.high, prevCandle.high),
        [
          `ظهور شمعة ابتلاعية بيعية (Bearish Engulfing) عند منطقة هيكلية هامة ($${currentPrice.toFixed(2)}).`,
          `تغلب كامل للبائعين على الشمعة الشرائية السابقة مع إغلاق أدنى من سعر افتتاح الشمعة السابقة.`,
          `توافق النمط مع منطقة ${indicators15m.premiumDiscountZone || 'Premium'} بنسبة عائد تتجاوز ${minRr}R.`,
        ],
        ['Bearish Engulfing', 'Structural Reversal', 'Candle Pattern Confirmation', 'Premium Zone'],
        20,
        17,
        22,
        18,
        {
          type: 'SWING_LEVEL',
          top: Math.max(last5m.high, prevCandle.high),
          bottom: Math.min(last5m.low, prevCandle.low),
          timeframe: '5M',
          createdCandleTime: last5m.timestamp,
        },
        {
          strategyId: 'S13',
          direction: 'SELL',
          prevBody,
          currBody,
          engulfingRatio: (currBody / Math.max(0.01, prevBody)).toFixed(2),
        }
      );
      if (cand) candidates.push(cand);
    }
  }

  // =========================================================================
  // HARD SCORER CONFLICT FILTER: Disqualify candidates directly opposing strong HTF regime
  // =========================================================================
  const regimeFilteredCandidates = candidates.filter((cand) => {
    if (isStrongUptrend && cand.direction === 'SELL') {
      const isAllowedException =
        cand.strategyFamily === 'COUNTERTREND_SCALP' ||
        cand.strategyFamily === 'LIQUIDITY_SWEEP' ||
        cand.strategyFamily === 'RANGE_SFP_REVERSAL' ||
        cand.strategyFamily === 'DOUBLE_TOP_BOTTOM' ||
        cand.strategyFamily === 'BARE_SR' ||
        cand.strategyFamily === 'STRUCTURE_ENGULFING' ||
        (cand.strategyFamily === 'MARKET_STRUCTURE' && cand.setupName.includes('CHOCH'));
      if (!isAllowedException) {
        console.log(`[StrategyEngine] Scorer Conflict Filter: Disqualified ${cand.setupName} (${cand.direction}) opposing STRONG_UPTREND`);
        return false;
      }
    }

    if (isStrongDowntrend && cand.direction === 'BUY') {
      const isAllowedException =
        cand.strategyFamily === 'COUNTERTREND_SCALP' ||
        cand.strategyFamily === 'LIQUIDITY_SWEEP' ||
        cand.strategyFamily === 'RANGE_SFP_REVERSAL' ||
        cand.strategyFamily === 'DOUBLE_TOP_BOTTOM' ||
        cand.strategyFamily === 'BARE_SR' ||
        cand.strategyFamily === 'STRUCTURE_ENGULFING' ||
        (cand.strategyFamily === 'MARKET_STRUCTURE' && cand.setupName.includes('CHOCH'));
      if (!isAllowedException) {
        console.log(`[StrategyEngine] Scorer Conflict Filter: Disqualified ${cand.setupName} (${cand.direction}) opposing STRONG_DOWNTREND`);
        return false;
      }
    }

    return true;
  });


  // =========================================================================
  // ACTIVE TRADE OPPOSITION GUARD: Prevent opposing signals while a trade is in-flight
  // =========================================================================
  let finalCandidates = regimeFilteredCandidates;
  let blockedByActiveTrade = false;
  if (input.activeTradeDirection === 'BUY') {
    finalCandidates = regimeFilteredCandidates.filter((cand) => {
      if (cand.direction === 'SELL') {
        blockedByActiveTrade = true;
        console.log(`[StrategyEngine] Active Trade Guard: Blocked ${cand.setupName} (SELL) due to active in-flight BUY trade`);
        return false;
      }
      return true;
    });
  } else if (input.activeTradeDirection === 'SELL') {
    finalCandidates = regimeFilteredCandidates.filter((cand) => {
      if (cand.direction === 'BUY') {
        blockedByActiveTrade = true;
        console.log(`[StrategyEngine] Active Trade Guard: Blocked ${cand.setupName} (BUY) due to active in-flight SELL trade`);
        return false;
      }
      return true;
    });
  }

  // Filter and sort candidates descending by score
  finalCandidates.sort((a, b) => b.score - a.score);

  if (finalCandidates.length === 0) {
    // Generate detailed structural blocker explanation aware of Market Regime & Active Trade Guard
    const regime = indicators15m.marketRegime || 'UNCLEAR';
    const regimeCtx = indicators15m.regimeContext;
    let noTradeReason = `لا توجد فرصة تداول مؤكدة حالياً: بيئة السوق (${regime}) في منطقة (${m15Zone})، مع عدم توفر هدف فني يحقق الحد الأدنى لنسبة العائد ${minRr}R بأمان.`;

    if (blockedByActiveTrade && input.activeTradeDirection) {
      noTradeReason = `توجد صفقة (${input.activeTradeDirection === 'BUY' ? 'شراء' : 'بيع'}) نشطة جارية حالياً؛ تم حظر الإشارات المعاكسة لمنع تضارب الصفقات حتى إغلاق الصفقة النشطة.`;
    } else if (regimeCtx?.isOverextended && (regime === 'STRONG_UPTREND' || regime === 'STRONG_DOWNTREND')) {
      noTradeReason = `بيئة السوق (${regime}) قوية لكن ${regimeCtx.overextensionReason || 'السعر ممتد حالياً بعيداً عن المتوسطات'}؛ ينبغي انتظار تراجع تصحيحي (Pullback) قبل الدخول.`;
    } else if (regime === 'NORMAL_RANGE' || regime === 'VOLATILE_RANGE') {
      noTradeReason = `السعر يتداول داخل نطاق عرضي (${regime}) بالقرب من منطقة التوازن (${m15Zone}) بدون سحب سيولة عند القمة أو القاع وبدون كسر مؤكد.`;
    } else if (regime === 'TRANSITION') {
      noTradeReason = `السوق يمر بمرحلة تحول هيكلي (${indicators15m.structureShift || 'Transition'})؛ مطلوب تأكيد كسر الهيكل وتماسك الاتجاه الجديد قبل المخاطرة.`;
    }

    const dummyRisk = evaluateTradeRisk({
      balance,
      entry: currentPrice,
      stopLoss: currentPrice,
      tp1: currentPrice,
      confidence: 0,
      asset,
      brokerSpecs,
    });

    const fallbackSignal: TradeSignal = {
      id: `sig_notrade_${Date.now()}`,
      timestamp: Date.now(),
      asset,
      signal: 'NO TRADE',
      currentPrice,
      entry: currentPrice,
      stopLoss: currentPrice,
      slPoints: 0,
      tp1: currentPrice,
      tp1Points: 0,
      tp1Rr: 0,
      tp1RrString: '1:0',
      tp2: currentPrice,
      tp2Points: 0,
      tp2Rr: 0,
      tp2RrString: '1:0',
      primaryTarget: 'TP1',
      rr: '1:0',
      rrRatio: 0,
      riskPercent: 0,
      riskAmount: 0,
      potentialProfit: 0,
      potentialLoss: 0,
      recommendedLotSize: 0,
      confidence: 0,
      timeframe: '15M / 5M',
      setup: 'Market Structure Ranging',
      mainReasons: ['عدم توفر شروط الدخول لأي من استراتيجيات الهيكل والسيولة المعتمدة.'],
      invalidation: 'N/A',
      noTradeReason,
    };

    return {
      hasValidSignal: false,
      selectedCandidate: null,
      allCandidates: [],
      finalSignal: fallbackSignal,
      noTradeReason,
    };
  }

  // Resolve any conflicting candidates (e.g. opposing BUY/SELL signals in same price area)
  const conflictRes = resolveFinalSignalConflict(finalCandidates, null, indicators15m.marketRegime);
  const winningCandidate = conflictRes.winningCandidate || finalCandidates[0];

  const decision: SignalDecision = winningCandidate.direction === 'BUY'
    ? (winningCandidate.orderType === 'LIMIT' ? 'BUY LIMIT' : 'BUY NOW')
    : (winningCandidate.orderType === 'LIMIT' ? 'SELL LIMIT' : 'SELL NOW');

  const riskResult = evaluateTradeRisk({
    balance,
    entry: winningCandidate.entry,
    stopLoss: winningCandidate.stopLoss,
    tp1: winningCandidate.tp1,
    tp2: winningCandidate.tp2,
    confidence: winningCandidate.confidence,
    isVeryStrongSetup: winningCandidate.confidence >= 85,
    losingStreak: input.losingStreak || 0,
    asset,
    brokerSpecs,
  });

  const setupId = winningCandidate.patternMetadata?.patternAnchorKey
    || (winningCandidate.patternMetadata as any)?.setupId
    || `setup_${winningCandidate.strategyFamily}_${winningCandidate.direction}_${Math.round(winningCandidate.entry / 3)}`;

  const finalSignal: TradeSignal = {
    id: `sig_${winningCandidate.direction.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    setupId,
    timestamp: Date.now(),
    asset,
    signal: decision,
    currentPrice,
    entry: winningCandidate.entry,
    stopLoss: winningCandidate.stopLoss,
    slPoints: winningCandidate.slPoints,
    tp1: winningCandidate.tp1,
    tp1Points: winningCandidate.tp1Points,
    tp1Rr: winningCandidate.tp1Rr,
    tp1RrString: `1:${winningCandidate.tp1Rr.toFixed(2)}`,
    tp2: winningCandidate.tp2,
    tp2Points: winningCandidate.tp2Points,
    tp2Rr: winningCandidate.tp2Rr,
    tp2RrString: `1:${winningCandidate.tp2Rr.toFixed(2)}`,
    primaryTarget: 'TP1',
    rr: `1:${winningCandidate.tp1Rr.toFixed(2)}`,
    rrRatio: winningCandidate.tp1Rr,
    riskPercent: riskResult.riskPercent,
    riskAmount: riskResult.riskAmount,
    potentialProfit: riskResult.potentialProfit,
    potentialLoss: riskResult.potentialLoss,
    recommendedLotSize: riskResult.recommendedLotSize,
    confidence: winningCandidate.confidence,
    strategyConfidence: winningCandidate.strategyConfidence,
    executionQualityScore: winningCandidate.executionQualityScore,
    strategyFamily: winningCandidate.strategyFamily,
    entryTiming: winningCandidate.entryTiming,
    setupFreshness: winningCandidate.setupFreshness,
    pullbackQuality: winningCandidate.pullbackQuality,
    tpRunway: winningCandidate.tpRunway,
    lifecycleState: winningCandidate.lifecycleState,
    poiId: winningCandidate.poiId,
    patternMetadata: winningCandidate.patternMetadata,
    structuralAnchorKey: winningCandidate.patternMetadata?.patternAnchorKey,
    setupKey: winningCandidate.patternMetadata?.patternAnchorKey
      ? `key_${winningCandidate.patternMetadata.patternAnchorKey}`
      : `key_${winningCandidate.strategyFamily}_${winningCandidate.direction}_${Math.round(winningCandidate.entry)}`,
    triggers: winningCandidate.triggers,
    executionBreakdown: winningCandidate.executionBreakdown,
    timeframe: winningCandidate.timeframe,
    setup: winningCandidate.setupName,
    mainReasons: winningCandidate.mainReasons,
    invalidation: winningCandidate.invalidation,
  };

  return {
    hasValidSignal: true,
    selectedCandidate: winningCandidate,
    allCandidates: finalCandidates,
    finalSignal,
  };
}
