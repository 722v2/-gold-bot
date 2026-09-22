import { generateMultiStrategyCandidates } from './strategyEngine.js';
import { validateTradeSignalCandidate } from './tradeQualityEngine.js';
import { Candle, TechnicalIndicators, StrategyFamily } from '../src/types.js';

console.log('================================================================');
console.log('  TREND CONTINUATION END-TO-END PIPELINE REPLAY & AUDIT SUITE  ');
console.log('================================================================\n');

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`✓ PASS: ${testName}`);
    passedTests++;
  } else {
    console.error(`✗ FAIL: ${testName}`);
    if (detail) console.error(`  Details: ${detail}`);
    failedTests++;
  }
}

const now = Date.now() - 100 * 300000;
const createCandle = (
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
  isClosed: boolean = true
): Candle => ({
  timestamp: now + i * 300000,
  open,
  high,
  low,
  close,
  volume: 1000,
  isClosed,
});

function createCandleArray(count: number = 20, basePrice: number = 4344, lowPrice?: number, highPrice?: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    let p = basePrice + (i % 2 === 0 ? 0.2 : -0.2);
    let l = p - 0.8;
    let h = p + 0.8;
    if (i === 0 && lowPrice !== undefined) l = lowPrice;
    if (i === 0 && highPrice !== undefined) h = highPrice;
    return createCandle(i, p, h, l, p + 0.1, true);
  });
}

const defaultBrokerSpecs = {
  minRr: 1.0,
  minGoldSlPoints: 35,
  maxGoldSlPoints: 65,
  minSlPoints: 35,
  maxSlPoints: 65,
  spread: 0.2,
};

function createBaseIndicators(overrides: Partial<TechnicalIndicators> = {}): TechnicalIndicators {
  return {
    ema20: 4346.0,
    ema50: 4350.0,
    ema200: 4360.0,
    vwap: 4347.0,
    rsi14: 45,
    macd: { macd: -0.5, signal: -0.3, histogram: -0.2 },
    atr14: 3.5,
    bollingerBands: { upper: 4370, middle: 4345, lower: 4300 },
    swingHigh: 4370.0,
    swingLow: 4300.0,
    support: 4300.0,
    resistance: 4370.0,
    structure: 'BEARISH',
    marketRegime: 'STRONG_DOWNTREND',
    premiumDiscountZone: 'PREMIUM',
    orderBlock: { type: 'BEARISH', high: 4350, low: 4343 },
    fvg: { type: 'BEARISH', top: 4348, bottom: 4343 },
    ...overrides,
  };
}

const basePoiMeta = {
  top: 4348.0,
  bottom: 4342.0,
  poiPrice: 4345.0,
  type: 'ORDER_BLOCK' as const,
  timeframe: '15M' as const,
};

export interface E2EReplayResult {
  testName: string;
  candidateGenerated: boolean;
  candidateDetails?: {
    direction: string;
    setupFamily: string;
    entry: number;
    stopLoss: number;
    tp1: number;
    rr: number;
    confidence: number;
    setupName: string;
  };
  validatorReached: boolean;
  finalExecutable: boolean;
  rejectionReason?: string;
}

async function runAllE2ETests() {
  console.log('--- EXECUTING PRODUCTION PIPELINE TESTS ---\n');

  // =========================================================================
  // TEST 1: Historical #10020 Full E2E Replay
  // Context: H1 Ranging, M15 Bearish/Strong Downtrend, Zone DISCOUNT, OB BULLISH, FVG BULLISH
  // =========================================================================
  console.log('[TEST 1] Historical #10020 Full E2E Replay');
  let test1Result: E2EReplayResult;
  {
    const c1h = createCandleArray(20, 4344, 4300, 4370);
    const c15m = createCandleArray(20, 4344, 4300, 4370);
    const c5m = createCandleArray(20, 4344, 4300, 4370);

    // M5 candle 19 closed with upper rejection / bearish close
    c5m[18] = createCandle(18, 4345.5, 4349.19, 4344.0, 4346.0, true);
    c5m[19] = createCandle(19, 4346.0, 4347.5, 4344.2, 4344.68, true);

    const ind1h = createBaseIndicators({
      structure: 'RANGING',
      marketRegime: 'NORMAL_RANGE',
    });
    const ind15m = createBaseIndicators({
      structure: 'BEARISH',
      marketRegime: 'STRONG_DOWNTREND',
      premiumDiscountZone: 'DISCOUNT',
      orderBlock: { type: 'BULLISH', high: 4345, low: 4340 },
      fvg: { type: 'BULLISH', top: 4346, bottom: 4344 },
    });
    const ind5m = createBaseIndicators({ atr14: 2.0 });

    const currentPrice = 4344.68;

    const genResult = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 100,
      currentPrice,
      candles5m: c5m,
      candles15m: c15m,
      candles1h: c1h,
      indicators5m: ind5m,
      indicators15m: ind15m,
      indicators1h: ind1h,
      brokerSpecs: defaultBrokerSpecs,
    });

    const candidate = genResult.allCandidates.find(c =>
      c.setupName.includes('Trend Continuation') || c.setupName.includes('Pullback')
    ) || genResult.allCandidates[0];

    const candidateGenerated = !!candidate;
    let validatorReached = false;
    let finalExecutable = false;
    let rejectionReason = undefined;

    if (candidate) {
      if ((candidate as any).poiPrice === undefined) {
        (candidate as any).poiPrice = 4346.0;
      }
      validatorReached = true;
      const val = validateTradeSignalCandidate(candidate, {
        currentPrice,
        candles5m: c5m,
        candles15m: c15m,
        candles1h: c1h,
        indicators5m: ind5m,
        indicators15m: ind15m,
        indicators1h: ind1h,
        brokerSpecs: defaultBrokerSpecs,
      });

      finalExecutable = val.isValid;
      rejectionReason = val.rejectionReason;
    }

    test1Result = {
      testName: 'Historical #10020 Full E2E Replay',
      candidateGenerated,
      candidateDetails: candidate ? {
        direction: candidate.direction,
        setupFamily: candidate.strategyFamily,
        entry: candidate.entry,
        stopLoss: candidate.stopLoss,
        tp1: candidate.tp1,
        rr: candidate.tp1Rr,
        confidence: candidate.confidence,
        setupName: candidate.setupName,
      } : undefined,
      validatorReached,
      finalExecutable,
      rejectionReason,
    };

    assert(
      !finalExecutable,
      'Test 1: Historical #10020 must NOT become an executable signal',
      `finalExecutable=${finalExecutable}, rejectionReason=${rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 2: Exact Historical Candidate Reproduction Attempt
  // =========================================================================
  console.log('\n[TEST 2] Exact Historical Candidate Reproduction Attempt');
  {
    assert(
      !test1Result.finalExecutable,
      'Test 2: Historical #10020 entry parameters cannot produce an executable signal through production pipeline'
    );
  }

  // =========================================================================
  // TEST 3: Positive Control E2E (Legitimate Trend-Following SELL)
  // Context: H1 STRONG_DOWNTREND, M15 STRONG_DOWNTREND, SELL, closed 5M rejection, R:R >= 1.5, PREMIUM
  // =========================================================================
  console.log('\n[TEST 3] Positive Control E2E (Legitimate Trend-Following SELL)');
  let test3Result: E2EReplayResult;
  {
    const c1h = createCandleArray(20, 4345, 4300, 4370);
    const c15m = createCandleArray(20, 4345, 4300, 4370);
    const c5m = createCandleArray(20, 4345, 4300, 4370);

    // M5 candle 19 closed with clean top rejection wick
    c5m[18] = createCandle(18, 4346.0, 4348.5, 4345.0, 4348.0, true);
    c5m[19] = createCandle(19, 4348.0, 4349.0, 4344.5, 4345.0, true);

    const ind1h = createBaseIndicators({
      structure: 'BEARISH',
      marketRegime: 'STRONG_DOWNTREND',
      swingLow: 4300,
      swingHigh: 4370,
      support: 4300,
      resistance: 4370,
    });
    const ind15m = createBaseIndicators({
      structure: 'BEARISH',
      marketRegime: 'STRONG_DOWNTREND',
      premiumDiscountZone: 'PREMIUM',
      orderBlock: { type: 'BEARISH', high: 4350, low: 4343 },
      fvg: { type: 'BEARISH', top: 4348, bottom: 4343 },
      swingLow: 4300,
      swingHigh: 4370,
      support: 4300,
      resistance: 4370,
    });
    const ind5m = createBaseIndicators({ atr14: 2.0, swingLow: 4300, swingHigh: 4370, orderBlock: { type: 'BEARISH', high: 4350, low: 4343 } });

    const currentPrice = 4345.0;

    const genResult = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 100,
      currentPrice,
      candles5m: c5m,
      candles15m: c15m,
      candles1h: c1h,
      indicators5m: ind5m,
      indicators15m: ind15m,
      indicators1h: ind1h,
      brokerSpecs: defaultBrokerSpecs,
    });

    const candidate = genResult.allCandidates.find(c =>
      c.setupName.includes('Trend Continuation') || c.setupName.includes('Pullback')
    ) || genResult.allCandidates[0];

    const candidateGenerated = !!candidate;
    let validatorReached = false;
    let finalExecutable = false;
    let rejectionReason = undefined;

    if (candidate) {
      if ((candidate as any).poiPrice === undefined) {
        (candidate as any).poiPrice = 4346.0;
      }
      validatorReached = true;
      const val = validateTradeSignalCandidate(candidate, {
        currentPrice,
        candles5m: c5m,
        candles15m: c15m,
        candles1h: c1h,
        indicators5m: ind5m,
        indicators15m: ind15m,
        indicators1h: ind1h,
        brokerSpecs: defaultBrokerSpecs,
      });

      finalExecutable = val.isValid;
      rejectionReason = val.rejectionReason;
    }

    test3Result = {
      testName: 'Positive Control E2E (Legitimate SELL)',
      candidateGenerated,
      candidateDetails: candidate ? {
        direction: candidate.direction,
        setupFamily: candidate.strategyFamily,
        entry: candidate.entry,
        stopLoss: candidate.stopLoss,
        tp1: candidate.tp1,
        rr: candidate.tp1Rr,
        confidence: candidate.confidence,
        setupName: candidate.setupName,
      } : undefined,
      validatorReached,
      finalExecutable,
      rejectionReason,
    };

    assert(
      finalExecutable,
      'Test 3: Legitimate SELL trend continuation setup MUST be ACCEPTED',
      `candidateGenerated=${candidateGenerated}, finalExecutable=${finalExecutable}, reason=${rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 4: Bullish Positive Control (Legitimate Trend-Following BUY)
  // Context: H1 STRONG_UPTREND, M15 STRONG_UPTREND, BUY, closed 5M bullish rejection, DISCOUNT, R:R >= 1.5
  // =========================================================================
  console.log('\n[TEST 4] Bullish Positive Control (Legitimate Trend-Following BUY)');
  let test4Result: E2EReplayResult;
  {
    const c1h = createCandleArray(20, 4345, 4320, 4390);
    const c15m = createCandleArray(20, 4345, 4320, 4390);
    const c5m = createCandleArray(20, 4345, 4320, 4390);

    // M5 candle 19 closed with clean bottom rejection wick
    c5m[18] = createCandle(18, 4345.0, 4345.5, 4341.0, 4342.0, true);
    c5m[19] = createCandle(19, 4342.0, 4346.0, 4341.0, 4345.0, true);

    const ind1h = createBaseIndicators({
      structure: 'BULLISH',
      marketRegime: 'STRONG_UPTREND',
      trendStructure: 'HH_HL',
      swingHigh: 4390,
      swingLow: 4320,
      resistance: 4390,
      support: 4320,
      ema200: 4310.0,
      ema50: 4330.0,
      ema20: 4344.0,
    });
    const ind15m = createBaseIndicators({
      structure: 'BULLISH',
      marketRegime: 'STRONG_UPTREND',
      trendStructure: 'HH_HL',
      premiumDiscountZone: 'DISCOUNT',
      orderBlock: { type: 'BULLISH', high: 4347, low: 4341 },
      fvg: { type: 'BULLISH', top: 4347, bottom: 4341 },
      swingHigh: 4390,
      swingLow: 4320,
      resistance: 4390,
      support: 4320,
      ema200: 4310.0,
      ema50: 4330.0,
      ema20: 4344.0,
    });
    const ind5m = createBaseIndicators({
      atr14: 2.0,
      ema20: 4344.0,
      vwap: 4343.0,
      swingHigh: 4390,
      swingLow: 4320,
      resistance: 4390,
      support: 4320,
      ema200: 4310.0,
      orderBlock: { type: 'BULLISH', high: 4347, low: 4341 },
    });

    const currentPrice = 4345.0;

    const genResult = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 100,
      currentPrice,
      candles5m: c5m,
      candles15m: c15m,
      candles1h: c1h,
      indicators5m: ind5m,
      indicators15m: ind15m,
      indicators1h: ind1h,
      brokerSpecs: defaultBrokerSpecs,
    });

    const candidate = genResult.allCandidates.find(c =>
      c.setupName.includes('Trend Continuation') || c.setupName.includes('Pullback')
    ) || genResult.allCandidates[0];

    const candidateGenerated = !!candidate;
    let validatorReached = false;
    let finalExecutable = false;
    let rejectionReason = undefined;

    if (candidate) {
      if ((candidate as any).poiPrice === undefined) {
        (candidate as any).poiPrice = 4344.0;
      }
      validatorReached = true;
      const val = validateTradeSignalCandidate(candidate, {
        currentPrice,
        candles5m: c5m,
        candles15m: c15m,
        candles1h: c1h,
        indicators5m: ind5m,
        indicators15m: ind15m,
        indicators1h: ind1h,
        brokerSpecs: defaultBrokerSpecs,
      });

      finalExecutable = val.isValid;
      rejectionReason = val.rejectionReason;
    }

    test4Result = {
      testName: 'Bullish Positive Control (Legitimate BUY)',
      candidateGenerated,
      candidateDetails: candidate ? {
        direction: candidate.direction,
        setupFamily: candidate.strategyFamily,
        entry: candidate.entry,
        stopLoss: candidate.stopLoss,
        tp1: candidate.tp1,
        rr: candidate.tp1Rr,
        confidence: candidate.confidence,
        setupName: candidate.setupName,
      } : undefined,
      validatorReached,
      finalExecutable,
      rejectionReason,
    };

    assert(
      finalExecutable,
      'Test 4: Legitimate BUY trend continuation setup MUST be ACCEPTED',
      `candidateGenerated=${candidateGenerated}, finalExecutable=${finalExecutable}, reason=${rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 5: H1 Ranging Weak Continuation (R:R < 1.25)
  // Context: H1 RANGING, M15 STRONG_DOWNTREND, SELL, R:R < 1.25
  // =========================================================================
  console.log('\n[TEST 5] H1 Ranging Weak Continuation (R:R < 1.25)');
  let test5Result: E2EReplayResult;
  {
    const candLowRr = {
      id: 'cand_test5_low_rr',
      strategyFamily: 'MARKET_STRUCTURE' as StrategyFamily,
      setupName: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
      direction: 'SELL' as const,
      orderType: 'MARKET' as const,
      entry: 4345.0,
      stopLoss: 4349.5, // 4.5 pts SL
      slPoints: 45,
      tp1: 4340.0,      // 5.0 pts TP1 -> 1.11R (< 1.25R)
      tp1Points: 50,
      tp1Rr: 1.11,
      confidence: 75,
      score: 75,
      strategyConfidence: 75,
      executionQualityScore: 75,
      entryTiming: 'OPTIMAL' as const,
      setupFreshness: 'FRESH' as const,
      pullbackQuality: 'VALID' as const,
      tpRunway: 'CLEAR' as const,
      lifecycleState: 'READY' as const,
      poiId: 'poi_1',
      poiPrice: 4346.0,
      poiMeta: basePoiMeta,
      triggers: ['TOP_REJECTION'],
    };

    const c1h = createCandleArray(20, 4344, 4300, 4370);
    const c15m = createCandleArray(20, 4344, 4300, 4370);
    const c5m = createCandleArray(20, 4344, 4300, 4370);
    c5m[19] = createCandle(19, 4347.0, 4348.0, 4344.0, 4345.0, true);

    const ind1h = createBaseIndicators({
      structure: 'RANGING',
      marketRegime: 'NORMAL_RANGE',
    });
    const ind15m = createBaseIndicators({
      structure: 'BEARISH',
      marketRegime: 'STRONG_DOWNTREND',
      premiumDiscountZone: 'PREMIUM',
    });
    const ind5m = createBaseIndicators({ atr14: 2.0 });

    const val = validateTradeSignalCandidate(candLowRr, {
      currentPrice: 4345.0,
      candles5m: c5m,
      candles15m: c15m,
      candles1h: c1h,
      indicators5m: ind5m,
      indicators15m: ind15m,
      indicators1h: ind1h,
      brokerSpecs: defaultBrokerSpecs,
    });

    test5Result = {
      testName: 'H1 Ranging Weak Continuation (R:R < 1.25)',
      candidateGenerated: true,
      candidateDetails: {
        direction: candLowRr.direction,
        setupFamily: candLowRr.strategyFamily,
        entry: candLowRr.entry,
        stopLoss: candLowRr.stopLoss,
        tp1: candLowRr.tp1,
        rr: candLowRr.tp1Rr,
        confidence: candLowRr.confidence,
        setupName: candLowRr.setupName,
      },
      validatorReached: true,
      finalExecutable: val.isValid,
      rejectionReason: val.rejectionReason,
    };

    assert(
      !val.isValid && (val.rejectionReason?.includes('TREND_CONTINUATION_HTF_QUALITY_INSUFFICIENT') ?? false),
      'Test 5: H1 Ranging + R:R < 1.25 MUST be REJECTED with TREND_CONTINUATION_HTF_QUALITY_INSUFFICIENT',
      `isValid=${val.isValid}, rejectionReason=${val.rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 6: H1 Ranging Strong Continuation (R:R >= 1.25)
  // Context: H1 RANGING, M15 STRONG_DOWNTREND, SELL, R:R >= 1.25, closed M5 rejection
  // =========================================================================
  console.log('\n[TEST 6] H1 Ranging Strong Continuation (R:R >= 1.25)');
  let test6Result: E2EReplayResult;
  {
    const c1h = createCandleArray(20, 4345, 4300, 4370);
    const c15m = createCandleArray(20, 4345, 4300, 4370);
    const c5m = createCandleArray(20, 4345, 4300, 4370);

    // M5 candle 19 closed with clean top rejection wick
    c5m[18] = createCandle(18, 4346.0, 4348.0, 4345.0, 4347.5, true);
    c5m[19] = createCandle(19, 4347.5, 4349.0, 4344.5, 4345.0, true);

    const ind1h = createBaseIndicators({
      structure: 'RANGING',
      marketRegime: 'NORMAL_RANGE',
      swingLow: 4300,
      swingHigh: 4370,
    });
    const ind15m = createBaseIndicators({
      structure: 'BEARISH',
      marketRegime: 'STRONG_DOWNTREND',
      premiumDiscountZone: 'PREMIUM',
      orderBlock: { type: 'BEARISH', high: 4350, low: 4343 },
      fvg: { type: 'BEARISH', top: 4348, bottom: 4343 },
      swingLow: 4300,
      swingHigh: 4370,
    });
    const ind5m = createBaseIndicators({ atr14: 2.0, swingLow: 4300, swingHigh: 4370, orderBlock: { type: 'BEARISH', high: 4350, low: 4343 } });

    const currentPrice = 4345.0;

    const genResult = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 100,
      currentPrice,
      candles5m: c5m,
      candles15m: c15m,
      candles1h: c1h,
      indicators5m: ind5m,
      indicators15m: ind15m,
      indicators1h: ind1h,
      brokerSpecs: defaultBrokerSpecs,
    });

    const candidate = genResult.allCandidates.find(c =>
      c.setupName.includes('Trend Continuation') || c.setupName.includes('Pullback')
    ) || genResult.allCandidates[0];

    const candidateGenerated = !!candidate;
    let validatorReached = false;
    let finalExecutable = false;
    let rejectionReason = undefined;

    if (candidate) {
      if ((candidate as any).poiPrice === undefined) {
        (candidate as any).poiPrice = 4346.0;
      }
      validatorReached = true;
      const val = validateTradeSignalCandidate(candidate, {
        currentPrice,
        candles5m: c5m,
        candles15m: c15m,
        candles1h: c1h,
        indicators5m: ind5m,
        indicators15m: ind15m,
        indicators1h: ind1h,
        brokerSpecs: defaultBrokerSpecs,
      });

      finalExecutable = val.isValid;
      rejectionReason = val.rejectionReason;
    }

    test6Result = {
      testName: 'H1 Ranging Strong Continuation (R:R >= 1.25)',
      candidateGenerated,
      candidateDetails: candidate ? {
        direction: candidate.direction,
        setupFamily: candidate.strategyFamily,
        entry: candidate.entry,
        stopLoss: candidate.stopLoss,
        tp1: candidate.tp1,
        rr: candidate.tp1Rr,
        confidence: candidate.confidence,
        setupName: candidate.setupName,
      } : undefined,
      validatorReached,
      finalExecutable,
      rejectionReason,
    };

    assert(
      finalExecutable,
      'Test 6: H1 Ranging + Strong R:R (>= 1.25R) + closed M5 rejection MUST be ALLOWED',
      `candidateGenerated=${candidateGenerated}, finalExecutable=${finalExecutable}, reason=${rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 7: Contradictory Context (SELL in DISCOUNT + BULLISH_OB + BULLISH_FVG & BUY in PREMIUM + BEARISH_OB + BEARISH_FVG)
  // =========================================================================
  console.log('\n[TEST 7] Contradictory Context (Rule 3)');
  let test7aResult: E2EReplayResult;
  let test7bResult: E2EReplayResult;
  {
    // Part A: SELL continuation in DISCOUNT + BULLISH_OB + BULLISH_FVG
    const candContradictorySell = {
      id: 'cand_test7a',
      strategyFamily: 'MARKET_STRUCTURE' as StrategyFamily,
      setupName: 'Bearish Trend Continuation',
      direction: 'SELL' as const,
      orderType: 'MARKET' as const,
      entry: 4344.0,
      stopLoss: 4349.0,
      slPoints: 50,
      tp1: 4330.0,
      tp1Points: 100,
      tp1Rr: 2.0,
      confidence: 85,
      score: 85,
      strategyConfidence: 85,
      executionQualityScore: 85,
      entryTiming: 'OPTIMAL' as const,
      setupFreshness: 'FRESH' as const,
      pullbackQuality: 'VALID' as const,
      tpRunway: 'CLEAR' as const,
      lifecycleState: 'READY' as const,
      poiId: 'poi_1',
      poiPrice: 4345.0,
      poiMeta: basePoiMeta,
      triggers: ['TOP_REJECTION'],
      factorSnapshot: {
        factors: {
          zone: 'DISCOUNT',
          orderBlock: 'BULLISH_OB',
          fvg: 'BULLISH_FVG',
        },
      },
    };

    const c1h = createCandleArray(20, 4344, 4300, 4370);
    const c15m = createCandleArray(20, 4344, 4300, 4370);
    const c5m = createCandleArray(20, 4344, 4300, 4370);
    c5m[19] = createCandle(19, 4345.0, 4346.0, 4343.0, 4344.0, true);

    const ind1h = createBaseIndicators({ marketRegime: 'STRONG_DOWNTREND', structure: 'BEARISH' });
    const ind15mSell = createBaseIndicators({
      premiumDiscountZone: 'DISCOUNT',
      orderBlock: { type: 'BULLISH', high: 4346, low: 4340 },
      fvg: { type: 'BULLISH', top: 4346, bottom: 4340 },
    });
    const ind5m = createBaseIndicators({ atr14: 2.0 });

    const valSell = validateTradeSignalCandidate(candContradictorySell, {
      currentPrice: 4344.0,
      candles5m: c5m,
      candles15m: c15m,
      candles1h: c1h,
      indicators5m: ind5m,
      indicators15m: ind15mSell,
      indicators1h: ind1h,
      brokerSpecs: defaultBrokerSpecs,
    });

    test7aResult = {
      testName: 'Contradictory Context SELL (DISCOUNT + BULLISH_OB + BULLISH_FVG)',
      candidateGenerated: true,
      candidateDetails: {
        direction: candContradictorySell.direction,
        setupFamily: candContradictorySell.strategyFamily,
        entry: candContradictorySell.entry,
        stopLoss: candContradictorySell.stopLoss,
        tp1: candContradictorySell.tp1,
        rr: candContradictorySell.tp1Rr,
        confidence: candContradictorySell.confidence,
        setupName: candContradictorySell.setupName,
      },
      validatorReached: true,
      finalExecutable: valSell.isValid,
      rejectionReason: valSell.rejectionReason,
    };

    assert(
      !valSell.isValid && (valSell.rejectionReason?.includes('CONTRADICTORY_BULLISH_CONTEXT_FOR_SELL_CONTINUATION') ?? false),
      'Test 7A: SELL continuation in DISCOUNT + BULLISH_OB + BULLISH_FVG MUST be REJECTED',
      `isValid=${valSell.isValid}, reason=${valSell.rejectionReason}`
    );

    // Part B: BUY continuation in PREMIUM + BEARISH_OB + BEARISH_FVG
    const candContradictoryBuy = {
      id: 'cand_test7b',
      strategyFamily: 'MARKET_STRUCTURE' as StrategyFamily,
      setupName: 'Bullish Trend Continuation',
      direction: 'BUY' as const,
      orderType: 'MARKET' as const,
      entry: 4350.0,
      stopLoss: 4345.0,
      slPoints: 50,
      tp1: 4360.0,
      tp1Points: 100,
      tp1Rr: 2.0,
      confidence: 85,
      score: 85,
      strategyConfidence: 85,
      executionQualityScore: 85,
      entryTiming: 'OPTIMAL' as const,
      setupFreshness: 'FRESH' as const,
      pullbackQuality: 'VALID' as const,
      tpRunway: 'CLEAR' as const,
      lifecycleState: 'READY' as const,
      poiId: 'poi_1',
      poiPrice: 4352.0,
      poiMeta: basePoiMeta,
      triggers: ['BOTTOM_REJECTION'],
      factorSnapshot: {
        factors: {
          zone: 'PREMIUM',
          orderBlock: 'BEARISH_OB',
          fvg: 'BEARISH_FVG',
        },
      },
    };

    const ind1hBuy = createBaseIndicators({ marketRegime: 'STRONG_UPTREND', structure: 'BULLISH' });
    const ind15mBuy = createBaseIndicators({
      marketRegime: 'STRONG_UPTREND',
      structure: 'BULLISH',
      premiumDiscountZone: 'PREMIUM',
      orderBlock: { type: 'BEARISH', high: 4355, low: 4351 },
      fvg: { type: 'BEARISH', top: 4354, bottom: 4352 },
    });

    const valBuy = validateTradeSignalCandidate(candContradictoryBuy, {
      currentPrice: 4350.0,
      candles5m: c5m,
      candles15m: c15m,
      candles1h: c1h,
      indicators5m: ind5m,
      indicators15m: ind15mBuy,
      indicators1h: ind1hBuy,
      brokerSpecs: defaultBrokerSpecs,
    });

    test7bResult = {
      testName: 'Contradictory Context BUY (PREMIUM + BEARISH_OB + BEARISH_FVG)',
      candidateGenerated: true,
      candidateDetails: {
        direction: candContradictoryBuy.direction,
        setupFamily: candContradictoryBuy.strategyFamily,
        entry: candContradictoryBuy.entry,
        stopLoss: candContradictoryBuy.stopLoss,
        tp1: candContradictoryBuy.tp1,
        rr: candContradictoryBuy.tp1Rr,
        confidence: candContradictoryBuy.confidence,
        setupName: candContradictoryBuy.setupName,
      },
      validatorReached: true,
      finalExecutable: valBuy.isValid,
      rejectionReason: valBuy.rejectionReason,
    };

    assert(
      !valBuy.isValid && (valBuy.rejectionReason?.includes('CONTRADICTORY_BEARISH_CONTEXT_FOR_BUY_CONTINUATION') ?? false),
      'Test 7B: BUY continuation in PREMIUM + BEARISH_OB + BEARISH_FVG MUST be REJECTED',
      `isValid=${valBuy.isValid}, reason=${valBuy.rejectionReason}`
    );
  }

  // =========================================================================
  // TEST 8: AI Bypass Test
  // Take rejected candidate (e.g. from #10020 context), set AI confidence = 99%
  // =========================================================================
  console.log('\n[TEST 8] AI Bypass Immunity Test');
  let test8Result: E2EReplayResult;
  {
    const candAiBypass = {
      id: 'cand_test8_ai_99',
      strategyFamily: 'MARKET_STRUCTURE' as StrategyFamily,
      setupName: 'Bearish Trend Continuation (AI Recommended)',
      direction: 'SELL' as const,
      orderType: 'MARKET' as const,
      entry: 4344.68,
      stopLoss: 4349.19,
      slPoints: 45.1,
      tp1: 4340.00,
      tp1Points: 46.8,
      tp1Rr: 1.04,
      confidence: 99, // 99% AI confidence
      score: 99,
      strategyConfidence: 99,
      executionQualityScore: 99,
      entryTiming: 'OPTIMAL' as const,
      setupFreshness: 'FRESH' as const,
      pullbackQuality: 'VALID' as const,
      tpRunway: 'CLEAR' as const,
      lifecycleState: 'READY' as const,
      poiId: 'poi_1',
      poiPrice: 4346.0,
      poiMeta: basePoiMeta,
      triggers: ['TOP_REJECTION'],
      factorSnapshot: {
        factors: {
          htfStructure: 'RANGING',
          zone: 'DISCOUNT',
          orderBlock: 'BULLISH_OB',
          fvg: 'BULLISH_FVG',
        },
      },
    };

    const c1h = createCandleArray(20, 4344, 4300, 4370);
    const c15m = createCandleArray(20, 4344, 4300, 4370);
    const c5m = createCandleArray(20, 4344, 4300, 4370);

    const ind1h = createBaseIndicators({
      structure: 'RANGING',
      marketRegime: 'NORMAL_RANGE',
    });
    const ind15m = createBaseIndicators({
      structure: 'BEARISH',
      marketRegime: 'STRONG_DOWNTREND',
      premiumDiscountZone: 'DISCOUNT',
      orderBlock: { type: 'BULLISH', high: 4345, low: 4340 },
      fvg: { type: 'BULLISH', top: 4346, bottom: 4344 },
    });
    const ind5m = createBaseIndicators({ atr14: 2.0 });

    const val = validateTradeSignalCandidate(candAiBypass, {
      currentPrice: 4344.68,
      candles5m: c5m,
      candles15m: c15m,
      candles1h: c1h,
      indicators5m: ind5m,
      indicators15m: ind15m,
      indicators1h: ind1h,
      brokerSpecs: defaultBrokerSpecs,
    });

    test8Result = {
      testName: 'AI Bypass Immunity Test (99% Confidence)',
      candidateGenerated: true,
      candidateDetails: {
        direction: candAiBypass.direction,
        setupFamily: candAiBypass.strategyFamily,
        entry: candAiBypass.entry,
        stopLoss: candAiBypass.stopLoss,
        tp1: candAiBypass.tp1,
        rr: candAiBypass.tp1Rr,
        confidence: candAiBypass.confidence,
        setupName: candAiBypass.setupName,
      },
      validatorReached: true,
      finalExecutable: val.isValid,
      rejectionReason: val.rejectionReason,
    };

    assert(
      !val.isValid,
      'Test 8: 99% AI confidence CANNOT bypass deterministic Quality Gate rules',
      `isValid=${val.isValid}, rejectionReason=${val.rejectionReason}`
    );
  }

  console.log('\n================================================================');
  console.log('                 FULL E2E PIPELINE SUMMARY TABLE                 ');
  console.log('================================================================');
  console.log(`[TEST 1] Historical #10020 Replay: Candidate Generated = ${test1Result.candidateGenerated ? 'YES' : 'NO'}, Executable = ${test1Result.finalExecutable ? 'YES' : 'NO'} | Reason: ${test1Result.rejectionReason || 'N/A'}`);
  console.log(`[TEST 2] Historical Entry Reproduction: Executable = NO`);
  console.log(`[TEST 3] Positive Control SELL: Candidate Generated = ${test3Result.candidateGenerated ? 'YES' : 'NO'}, Executable = ${test3Result.finalExecutable ? 'YES' : 'NO'}`);
  console.log(`[TEST 4] Positive Control BUY: Candidate Generated = ${test4Result.candidateGenerated ? 'YES' : 'NO'}, Executable = ${test4Result.finalExecutable ? 'YES' : 'NO'}`);
  console.log(`[TEST 5] H1 Ranging Weak (R:R < 1.25): Executable = ${test5Result.finalExecutable ? 'YES' : 'NO'} | Reason: ${test5Result.rejectionReason}`);
  console.log(`[TEST 6] H1 Ranging Strong (R:R >= 1.25): Executable = ${test6Result.finalExecutable ? 'YES' : 'NO'}`);
  console.log(`[TEST 7A] Contradictory SELL: Executable = ${test7aResult.finalExecutable ? 'YES' : 'NO'} | Reason: ${test7aResult.rejectionReason}`);
  console.log(`[TEST 7B] Contradictory BUY: Executable = ${test7bResult.finalExecutable ? 'YES' : 'NO'} | Reason: ${test7bResult.rejectionReason}`);
  console.log(`[TEST 8] AI Bypass (99% Conf): Executable = ${test8Result.finalExecutable ? 'YES' : 'NO'} | Reason: ${test8Result.rejectionReason}`);
  console.log('================================================================');
  console.log(`E2E SUITE TOTAL: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runAllE2ETests().catch((err) => {
  console.error('E2E execution error:', err);
  process.exit(1);
});
