import { AssetType, Candle, SignalDecision, TechnicalIndicators, TradeSignal } from '../src/types.js';
import { BrokerContractSpecs, DEFAULT_BROKER_SPECS, evaluateTradeRisk } from './riskManager.js';
import { calculateDynamicTakeProfits } from './tpEngine.js';

export interface SetupCandidate {
  id: string;
  strategyFamily:
    | 'MARKET_STRUCTURE'
    | 'LIQUIDITY_SWEEP'
    | 'ORDER_BLOCK'
    | 'FVG_IMBALANCE'
    | 'FIBONACCI_OTE'
    | 'BREAK_AND_RETEST'
    | 'COUNTERTREND_SCALP'
    | 'FAILED_BREAKOUT';
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
}

export interface MultiStrategyEngineResult {
  hasValidSignal: boolean;
  selectedCandidate: SetupCandidate | null;
  allCandidates: SetupCandidate[];
  finalSignal: TradeSignal;
  noTradeReason?: string;
}

/**
 * Helper to calculate candle metrics
 */
function analyzeCandle(c: Candle) {
  const isBull = c.close >= c.open;
  const body = Math.abs(c.close - c.open);
  const totalRange = Math.max(0.01, c.high - c.low);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const isTopRejection = upperWick > body * 1.3 && upperWick > totalRange * 0.4;
  const isBottomRejection = lowerWick > body * 1.3 && lowerWick > totalRange * 0.4;
  const isEngulfingBull = isBull && body > totalRange * 0.6;
  const isEngulfingBear = !isBull && body > totalRange * 0.6;
  return {
    isBull,
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

  const candidates: SetupCandidate[] = [];

  const last5m = candles5m[candles5m.length - 1] || { open: currentPrice, high: currentPrice, low: currentPrice, close: currentPrice, volume: 1, timestamp: Date.now() };
  const prev5m = candles5m[candles5m.length - 2] || last5m;
  const c5mMetrics = analyzeCandle(last5m);
  const prev5mMetrics = analyzeCandle(prev5m);

  const last15m = candles15m[candles15m.length - 1] || last5m;
  const c15mMetrics = analyzeCandle(last15m);

  const atr5m = Math.max(1.5, indicators5m.atr14 || 2.5);
  const bufferGold = Math.max(0.3, Math.min(0.8, atr5m * 0.15));

  const h1Trend = indicators1h.structure;
  const m15Structure = indicators15m.structure;
  const m15Zone = indicators15m.premiumDiscountZone;
  const fib15m = calculateFibLevels(indicators15m.swingHigh, indicators15m.swingLow);
  const sessionLevels = extractSessionExtremes(candles5m);

  // Helper to validate and build candidate
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
    baseLocationScore: number
  ): SetupCandidate | null => {
    // 1. Calculate SL with technical buffer
    const entry = Number(proposedEntry.toFixed(2));
    let stopLoss = direction === 'BUY'
      ? Number((rawSl - bufferGold).toFixed(2))
      : Number((rawSl + bufferGold).toFixed(2));

    const slDistance = Math.abs(entry - stopLoss);
    const slPoints = Number((slDistance / 0.1).toFixed(1));

    // SL constraint check: Must be technically meaningful (35 to 65 points on Gold)
    if (slPoints < minSlPoints || slPoints > maxSlPoints) {
      // If close to bounds, adjust to closest safe structural bound if logical
      if (slPoints < minSlPoints && slPoints >= 25) {
        stopLoss = direction === 'BUY'
          ? Number((entry - (minSlPoints * 0.1)).toFixed(2))
          : Number((entry + (minSlPoints * 0.1)).toFixed(2));
      } else if (slPoints > maxSlPoints && slPoints <= 75) {
        stopLoss = direction === 'BUY'
          ? Number((entry - (maxSlPoints * 0.1)).toFixed(2))
          : Number((entry + (maxSlPoints * 0.1)).toFixed(2));
      } else {
        return null; // SL is outside valid scalping boundaries
      }
    }

    const finalSlDistance = Math.abs(entry - stopLoss);
    const finalSlPoints = Number((finalSlDistance / 0.1).toFixed(1));

    // 2. Compute dynamic take profits using structural levels (TP1 >= minRr, TP2 >= 2.5R to 3R)
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
    });

    if (!tpResult.valid || tpResult.tp1Rr < minRr) {
      return null; // Failed minimum RR 1.5R constraint
    }

    // 3. Calculate weighted scoring model
    // Confluences score (EMA, VWAP, RSI, MACD, Volume)
    let technicalScore = 0;
    if (direction === 'BUY') {
      if (entry > indicators5m.vwap) technicalScore += 3;
      if (entry > indicators5m.ema20) technicalScore += 3;
      if (indicators5m.rsi14 >= 40 && indicators5m.rsi14 <= 68) technicalScore += 2;
      if (indicators5m.macd.histogram > 0) technicalScore += 2;
    } else {
      if (entry < indicators5m.vwap) technicalScore += 3;
      if (entry < indicators5m.ema20) technicalScore += 3;
      if (indicators5m.rsi14 <= 60 && indicators5m.rsi14 >= 32) technicalScore += 2;
      if (indicators5m.macd.histogram < 0) technicalScore += 2;
    }

    // HTF Alignment bonus
    let htfBonus = 0;
    if (direction === 'BUY' && h1Trend === 'BULLISH') htfBonus += 5;
    if (direction === 'SELL' && h1Trend === 'BEARISH') htfBonus += 5;
    if (direction === 'BUY' && m15Structure === 'BULLISH') htfBonus += 5;
    if (direction === 'SELL' && m15Structure === 'BEARISH') htfBonus += 5;

    const structureScore = Math.min(25, baseStructureScore + htfBonus);
    const liquidityScore = Math.min(25, baseLiquidityScore);
    const priceActionScore = Math.min(20, basePriceActionScore);
    const locationScore = Math.min(20, baseLocationScore);
    const techScore = Math.min(10, technicalScore);

    const totalScore = structureScore + liquidityScore + priceActionScore + locationScore + techScore;
    const confidence = Math.min(96, Math.max(70, Math.round(totalScore)));

    const invalidation = direction === 'BUY'
      ? `كسر وإغلاق شمعة 5M أدنى مستوى وقف الخسارة $${stopLoss.toFixed(2)}`
      : `اختراق وإغلاق شمعة 5M أعلى مستوى وقف الخسارة $${stopLoss.toFixed(2)}`;

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
      confidence,
      score: totalScore,
      timeframe: '15M / 5M',
      mainReasons: reasons,
      invalidation,
      supportingConfluences: confluences,
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

    // Bullish OB Retest (Demand Zone)
    const bullishOb = ob15m?.type === 'BULLISH' ? ob15m : ob5m?.type === 'BULLISH' ? ob5m : null;
    if (bullishOb && currentPrice >= bullishOb.low - 0.5 && currentPrice <= bullishOb.high + 1.2) {
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

    // Bearish OB Retest (Supply Zone)
    const bearishOb = ob15m?.type === 'BEARISH' ? ob15m : ob5m?.type === 'BEARISH' ? ob5m : null;
    if (bearishOb && currentPrice <= bearishOb.high + 0.5 && currentPrice >= bearishOb.low - 1.2) {
      if (c5mMetrics.isTopRejection || !c5mMetrics.isBull || prev5mMetrics.isTopRejection) {
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
    if (fvg && fvg.type === 'BULLISH' && currentPrice >= fvg.bottom - 0.5 && currentPrice <= fvg.top + 0.8) {
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
    } else if (fvg && fvg.type === 'BEARISH' && currentPrice <= fvg.top + 0.5 && currentPrice >= fvg.bottom - 0.8) {
      if (c5mMetrics.isTopRejection || !c5mMetrics.isBull) {
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
  if (m15Zone === 'DISCOUNT' && currentPrice >= fib15m.fib618 - 1.0 && currentPrice <= fib15m.fib786 + 1.0) {
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
  } else if (m15Zone === 'PREMIUM' && currentPrice <= fib15m.fib786 + 1.0 && currentPrice >= fib15m.fib618 - 1.0) {
    if (c5mMetrics.isTopRejection || !c5mMetrics.isBull) {
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

  // =========================================================================
  // STRATEGY 6: TREND CONTINUATION ON EMA / VWAP PULLBACK
  // =========================================================================
  if (h1Trend === 'BULLISH' && indicators15m.trendStructure === 'HH_HL') {
    const isPullbackToEma = Math.abs(currentPrice - indicators5m.ema50) <= atr5m * 0.8 || Math.abs(currentPrice - indicators5m.vwap) <= atr5m * 0.8;
    if (isPullbackToEma && (c5mMetrics.isBottomRejection || c5mMetrics.isBull)) {
      const cand = evaluateCandidate(
        'MARKET_STRUCTURE',
        'Bullish Trend Continuation (EMA/VWAP Pullback)',
        'BUY',
        'MARKET',
        currentPrice,
        indicators5m.swingLow,
        [
          `اتجاه عام صاعد منتظم (HH/HL) على الفريمات 1H و 15M.`,
          `إعادة اختبار ناجحة لمتوسط EMA50 وخط VWAP وتماسك المشترين.`,
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
  } else if (h1Trend === 'BEARISH' && indicators15m.trendStructure === 'LH_LL') {
    const isPullbackToEma = Math.abs(currentPrice - indicators5m.ema50) <= atr5m * 0.8 || Math.abs(currentPrice - indicators5m.vwap) <= atr5m * 0.8;
    if (isPullbackToEma && (c5mMetrics.isTopRejection || !c5mMetrics.isBull)) {
      const cand = evaluateCandidate(
        'MARKET_STRUCTURE',
        'Bearish Trend Continuation (EMA/VWAP Pullback)',
        'SELL',
        'MARKET',
        currentPrice,
        indicators5m.swingHigh,
        [
          `اتجاه هابط رئيسي قوي (LH/LL) على فريم 1H و 15M.`,
          `رفض سعري عند ملامسة EMA50 / VWAP واستئناف ضغط البيع.`,
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
  // CANDIDATE RANKING AND SELECTION
  // =========================================================================
  // Filter and sort candidates descending by score
  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    // Generate detailed structural blocker explanation
    const noTradeReason = `لا توجد فرصة تداول مؤكدة حالياً: السعر في منطقة تذبذب محايدة (${m15Zone}) بدون كسر هيكلي واضح أو سحب سيولة مكتمل، مع عدم توفر هدف فني يحقق الحد الأدنى لنسبة العائد ${minRr}R بأمان.`;

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

  const winningCandidate = candidates[0];
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

  const finalSignal: TradeSignal = {
    id: `sig_${winningCandidate.direction.toLowerCase()}_${Date.now()}`,
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
    timeframe: winningCandidate.timeframe,
    setup: winningCandidate.setupName,
    mainReasons: winningCandidate.mainReasons,
    invalidation: winningCandidate.invalidation,
  };

  return {
    hasValidSignal: true,
    selectedCandidate: winningCandidate,
    allCandidates: candidates,
    finalSignal,
  };
}
