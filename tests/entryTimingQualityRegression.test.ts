import assert from 'node:assert';
import {
  assessPriceActionTrigger,
  assessTpPathRunway,
  assessStopLossQuality,
  assessEntryTimingAndAntiChase,
  validateTradeSignalCandidate,
} from '../server/tradeQualityEngine.js';
import { optimizeSetupExecutability } from '../server/riskManager.js';
import { Candle, TechnicalIndicators } from '../src/types.js';

function buildMockCandle(
  timestamp: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 1000,
  isClosed = true
): Candle {
  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume,
    isClosed,
  };
}

function makeCandleSeries(basePrice: number, count: number, step: number = 0.1): Candle[] {
  const candles: Candle[] = [];
  const fiveMinMs = 5 * 60 * 1000;
  const now = 1710000000000;
  for (let i = count; i >= 1; i--) {
    const p = basePrice + (count - i) * step;
    candles.push({
      timestamp: now - i * fiveMinMs,
      open: p - 0.2,
      high: p + 0.5,
      low: p - 0.5,
      close: p + 0.2,
      volume: 500,
      isClosed: true,
    });
  }
  return candles;
}

function make1mCandleSeries(basePrice: number, count: number, step: number = 0.05): Candle[] {
  const candles: Candle[] = [];
  const oneMinMs = 60 * 1000;
  const now = 1710000000000;
  for (let i = count; i >= 1; i--) {
    const p = basePrice + (count - i) * step;
    candles.push({
      timestamp: now - i * oneMinMs,
      open: p - 0.1,
      high: p + 0.2,
      low: p - 0.2,
      close: p + 0.1,
      volume: 200,
      isClosed: true,
    });
  }
  return candles;
}

function buildMockIndicators(overrides: Partial<TechnicalIndicators> = {}): TechnicalIndicators {
  const swingHigh = overrides.swingHigh ?? 2660;
  const swingLow = overrides.swingLow ?? 2640;
  return {
    trendStructure: 'HH_HL',
    structure: 'BULLISH',
    marketRegime: 'STRONG_UPTREND',
    atr14: 3.5,
    ema20: 2645,
    ema50: 2640,
    ema200: 2630,
    vwap: 2650,
    rsi14: 60,
    macd: { macd: 1, signal: 0.5, histogram: 0.5 },
    bollingerBands: { upper: swingHigh, middle: 2650, lower: swingLow },
    swingHigh,
    swingLow,
    support: swingLow,
    resistance: swingHigh,
    ...overrides,
  };
}

export async function runEntryTimingQualityRegressionSuite() {
  console.log('========================================================================');
  console.log('🎯 RUNNING ENTRY TIMING & EXECUTION QUALITY REGRESSION SUITE (18 TESTS)');
  console.log('========================================================================');

  let passed = 0;
  let failed = 0;

  function runTest(testName: string, fn: () => void) {
    try {
      fn();
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } catch (err: any) {
      console.error(`❌ [FAIL] ${testName}: ${err.message}`);
      failed++;
    }
  }

  const now = 1710000120000;
  const baseCandles5m = makeCandleSeries(2640, 30, 0.1);
  const baseCandles15m = makeCandleSeries(2640, 30, 0.3);
  const baseCandles1h = makeCandleSeries(2640, 30, 0.5);

  // -------------------------------------------------------------------------
  // TEST 1: Valid BUY Entry Near Structural POI (<= 0.8 ATR)
  // -------------------------------------------------------------------------
  runTest('TEST 1: Valid BUY entry near structural POI (<= 0.8 ATR) -> ACCEPTED (OPTIMAL)', () => {
    // Current price is 2642.0, POI zone is [2640.0, 2642.5], ATR is 3.5
    // Distance from POI top (2642.5) is 0 -> distanceFromPoiAtr = 0.00
    const candles5m = [...baseCandles5m];
    // Closed trigger candle: strong lower rejection wick + bullish close
    candles5m[candles5m.length - 1] = buildMockCandle(now - 300000, 2641.5, 2642.2, 2639.0, 2642.0);

    const context = {
      currentPrice: 2642.0,
      candles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ swingHigh: 2648, swingLow: 2638, atr14: 3.5 }),
      indicators15m: buildMockIndicators({ swingHigh: 2655, swingLow: 2635, atr14: 4.0 }),
      indicators1h: buildMockIndicators({ swingHigh: 2665, swingLow: 2630, atr14: 5.0 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
    };

    const res = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2642.0,
        stopLoss: 2638.0, // 4.0 pts = 40 gold pts (within [35, 65])
        tp1: 2650.0,      // 8.0 pts = 2.0R
        poiPrice: 2641.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Bullish Order Block Entry',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2640.0, top: 2642.5 },
      },
      context
    );

    assert.strictEqual(res.isValid, true, `Candidate should be valid: ${res.rejectionReason}`);
    assert.strictEqual(res.timing, 'OPTIMAL', 'Timing should be OPTIMAL inside or near POI');
  });

  // -------------------------------------------------------------------------
  // TEST 2: Valid SELL Entry Near Structural POI (<= 0.8 ATR)
  // -------------------------------------------------------------------------
  runTest('TEST 2: Valid SELL entry near structural POI (<= 0.8 ATR) -> ACCEPTED (OPTIMAL)', () => {
    // Current price is 2658.0, POI zone is [2657.5, 2660.0], ATR is 3.5
    const sellCandles5m = makeCandleSeries(2660, 30, -0.1);
    // Closed trigger candle: strong upper rejection wick + bearish close
    sellCandles5m[sellCandles5m.length - 1] = buildMockCandle(now - 300000, 2658.5, 2661.0, 2657.8, 2658.0);

    const context = {
      currentPrice: 2658.0,
      candles5m: sellCandles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', swingHigh: 2662, swingLow: 2652, atr14: 3.5 }),
      indicators15m: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', swingHigh: 2665, swingLow: 2645, atr14: 4.0 }),
      indicators1h: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', swingHigh: 2670, swingLow: 2635, atr14: 5.0 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
    };

    const res = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2658.0,
        stopLoss: 2662.0, // 4.0 pts = 40 gold pts (within [35, 65])
        tp1: 2650.0,      // 8.0 pts = 2.0R
        poiPrice: 2659.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Bearish Order Block Entry',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2657.5, top: 2660.0 },
      },
      context
    );

    assert.strictEqual(res.isValid, true, `Candidate should be valid: ${res.rejectionReason}`);
    assert.strictEqual(res.timing, 'OPTIMAL', 'Timing should be OPTIMAL inside or near POI');
  });

  // -------------------------------------------------------------------------
  // TEST 3: Chased BUY Entry Far from POI (> 2.0 ATR away) -> REJECTED
  // -------------------------------------------------------------------------
  runTest('TEST 3: Chased BUY entry far from structural POI (> 2.0 ATR away) -> REJECTED (CHASED_ENTRY)', () => {
    // POI zone is [2640.0, 2642.0], but price has already expanded to 2652.0 (10.0 pts away = 2.85 ATR with ATR=3.5)
    const candles5m = [...baseCandles5m];
    candles5m[candles5m.length - 1] = buildMockCandle(now - 300000, 2649.0, 2652.5, 2648.5, 2652.0);

    const context = {
      currentPrice: 2652.0,
      candles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ atr14: 3.5 }),
      indicators15m: buildMockIndicators({ atr14: 4.0 }),
      indicators1h: buildMockIndicators({ atr14: 5.0 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
    };

    const res = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2652.0,
        stopLoss: 2647.5,
        tp1: 2662.0,
        poiPrice: 2641.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Bullish Order Block Late Entry',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2640.0, top: 2642.0 },
      },
      context
    );

    assert.strictEqual(res.isValid, false, 'Overextended candidate must be rejected');
    assert.ok(res.rejectionReason?.includes('CHASED_ENTRY'), `Rejection reason should be CHASED_ENTRY, got: ${res.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 4: Chased SELL Entry Far from POI (> 2.0 ATR away) -> REJECTED
  // -------------------------------------------------------------------------
  runTest('TEST 4: Chased SELL entry far from structural POI (> 2.0 ATR away) -> REJECTED (CHASED_ENTRY)', () => {
    // POI zone is [2658.0, 2660.0], but price has already collapsed to 2648.0 (10.0 pts away = 2.85 ATR with ATR=3.5)
    const sellCandles5m = makeCandleSeries(2660, 30, -0.1);
    sellCandles5m[sellCandles5m.length - 1] = buildMockCandle(now - 300000, 2651.0, 2651.5, 2647.5, 2648.0);

    const context = {
      currentPrice: 2648.0,
      candles5m: sellCandles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', atr14: 3.5 }),
      indicators15m: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', atr14: 4.0 }),
      indicators1h: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', atr14: 5.0 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
    };

    const res = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2648.0,
        stopLoss: 2652.5,
        tp1: 2638.0,
        poiPrice: 2659.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Bearish Order Block Late Entry',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2658.0, top: 2660.0 },
      },
      context
    );

    assert.strictEqual(res.isValid, false, 'Overextended candidate must be rejected');
    assert.ok(res.rejectionReason?.includes('CHASED_ENTRY'), `Rejection reason should be CHASED_ENTRY, got: ${res.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 5: Large 5M Displacement Candle BUY at the Extreme -> REJECTED (CHASED_ENTRY)
  // -------------------------------------------------------------------------
  runTest('TEST 5: Large 5M displacement candle confirms BUY direction, but price already displaced > 1.2 ATR away -> REJECTED', () => {
    // POI is at 2640.0. A massive 5M displacement candle expanded from 2640 to 2646 (6.0 pts displacement = 1.71 ATR with ATR=3.5)
    // Entering at 2646.0 without a pullback is chasing the impulse!
    const candles5m = [...baseCandles5m];
    candles5m[candles5m.length - 2] = buildMockCandle(now - 600000, 2640.0, 2643.0, 2639.8, 2642.5);
    candles5m[candles5m.length - 1] = buildMockCandle(now - 300000, 2642.5, 2646.2, 2642.0, 2646.0); // 5M displacement close

    const context = {
      currentPrice: 2646.0,
      candles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ atr14: 3.5 }),
      indicators15m: buildMockIndicators({ atr14: 4.0 }),
      indicators1h: buildMockIndicators({ atr14: 5.0 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
    };

    const res = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2646.0,
        stopLoss: 2641.0, // 5.0 pts
        tp1: 2656.0,
        poiPrice: 2640.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Bullish Order Block Chased Displacement',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2639.5, top: 2641.0 },
      },
      context
    );

    assert.strictEqual(res.isValid, false, 'Entering at the extreme tip of a large displacement candle without a pullback must be rejected');
    assert.ok(res.rejectionReason?.includes('CHASED_ENTRY'), `Expected CHASED_ENTRY rejection, got: ${res.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 6: Large 5M Displacement Candle SELL at the Extreme -> REJECTED (CHASED_ENTRY)
  // -------------------------------------------------------------------------
  runTest('TEST 6: Large 5M displacement candle confirms SELL direction, but price already displaced > 1.2 ATR away -> REJECTED', () => {
    // POI is at 2660.0. A massive 5M displacement candle dropped price from 2660 to 2654 (6.0 pts displacement = 1.71 ATR with ATR=3.5)
    // Entering at 2654.0 without a pullback is chasing the impulse!
    const sellCandles5m = makeCandleSeries(2660, 30, -0.1);
    sellCandles5m[sellCandles5m.length - 2] = buildMockCandle(now - 600000, 2660.0, 2660.2, 2657.0, 2657.5);
    sellCandles5m[sellCandles5m.length - 1] = buildMockCandle(now - 300000, 2657.5, 2658.0, 2653.8, 2654.0);

    const context = {
      currentPrice: 2654.0,
      candles5m: sellCandles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', atr14: 3.5 }),
      indicators15m: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', atr14: 4.0 }),
      indicators1h: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', atr14: 5.0 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
    };

    const res = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2654.0,
        stopLoss: 2659.0, // 5.0 pts
        tp1: 2644.0,
        poiPrice: 2660.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Bearish Order Block Chased Displacement',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2659.0, top: 2660.5 },
      },
      context
    );

    assert.strictEqual(res.isValid, false, 'Entering at the extreme tip of a large displacement candle without a pullback must be rejected');
    assert.ok(res.rejectionReason?.includes('CHASED_ENTRY'), `Expected CHASED_ENTRY rejection, got: ${res.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 7: BUY Pullback / Retest Recovery (Orderly retest back to POI) -> ACCEPTED
  // -------------------------------------------------------------------------
  runTest('TEST 7: BUY Pullback/Retest recovery — price pulls back in controlled manner to POI edge (<= 0.8 ATR) -> ACCEPTED', () => {
    // Initial POI at 2640. Price previously displaced up to 2646, but now gently pulled back to 2642.0 (0.57 ATR from POI top 2641.0)
    // with a rejection wick off the POI level on the closed 5M candle!
    const candles5m = [...baseCandles5m];
    candles5m[candles5m.length - 3] = buildMockCandle(now - 900000, 2640.0, 2646.0, 2639.8, 2645.0); // Expansion
    candles5m[candles5m.length - 2] = buildMockCandle(now - 600000, 2645.0, 2645.2, 2642.5, 2643.0); // Orderly pullback
    candles5m[candles5m.length - 1] = buildMockCandle(now - 300000, 2643.0, 2644.0, 2640.8, 2643.5); // Rejection wick off POI!

    const context = {
      currentPrice: 2643.5,
      candles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ swingHigh: 2648, swingLow: 2638, atr14: 3.5 }),
      indicators15m: buildMockIndicators({ swingHigh: 2655, swingLow: 2635, atr14: 4.0 }),
      indicators1h: buildMockIndicators({ swingHigh: 2665, swingLow: 2630, atr14: 5.0 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
    };

    const res = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2643.5,
        stopLoss: 2639.0, // 4.5 pts
        tp1: 2653.0,      // 9.5 pts = 2.1R
        poiPrice: 2641.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Bullish Order Block Pullback Retest',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2639.5, top: 2641.5 },
      },
      context
    );

    assert.strictEqual(res.isValid, true, `Pullback retest candidate should recover and be valid: ${res.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 8: SELL Pullback / Retest Recovery (Orderly retest back to POI) -> ACCEPTED
  // -------------------------------------------------------------------------
  runTest('TEST 8: SELL Pullback/Retest recovery — price pulls back in controlled manner to POI edge (<= 0.8 ATR) -> ACCEPTED', () => {
    // Initial POI at 2660. Price previously dropped to 2654, but now gently pulled back to 2657.5 (0.43 ATR from POI bottom 2659.0)
    // with a rejection wick off the POI level on the closed 5M candle!
    const sellCandles5m = makeCandleSeries(2660, 30, -0.1);
    sellCandles5m[sellCandles5m.length - 3] = buildMockCandle(now - 900000, 2660.0, 2660.2, 2654.0, 2655.0); // Expansion
    sellCandles5m[sellCandles5m.length - 2] = buildMockCandle(now - 600000, 2655.0, 2657.5, 2654.8, 2657.0); // Orderly pullback
    sellCandles5m[sellCandles5m.length - 1] = buildMockCandle(now - 300000, 2657.0, 2659.2, 2656.0, 2656.5); // Rejection wick off POI!

    const context = {
      currentPrice: 2656.5,
      candles5m: sellCandles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', swingHigh: 2662, swingLow: 2652, atr14: 3.5 }),
      indicators15m: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', swingHigh: 2665, swingLow: 2645, atr14: 4.0 }),
      indicators1h: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', swingHigh: 2670, swingLow: 2635, atr14: 5.0 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
    };

    const res = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2656.5,
        stopLoss: 2661.0, // 4.5 pts
        tp1: 2647.0,      // 9.5 pts = 2.1R
        poiPrice: 2659.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Bearish Order Block Pullback Retest',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2658.5, top: 2660.5 },
      },
      context
    );

    assert.strictEqual(res.isValid, true, `Pullback retest candidate should recover and be valid: ${res.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 9: Pullback Breaks Structure / Violates SL Invalidation -> REJECTED
  // -------------------------------------------------------------------------
  runTest('TEST 9: Pullback breaks structure / violates SL invalidation -> REJECTED', () => {
    // In BUY setup, entry is 2642, but price blew right through the POI and SL (2638) down to 2636.
    // Invalid geometry: entry <= stopLoss or stop loss breached
    const candles5m = [...baseCandles5m];
    const context = {
      currentPrice: 2636.0,
      candles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ swingHigh: 2648, swingLow: 2638, atr14: 3.5 }),
      indicators15m: buildMockIndicators({ atr14: 4.0 }),
      indicators1h: buildMockIndicators({ atr14: 5.0 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
    };

    const res = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2636.0,
        stopLoss: 2638.0, // Inverted! SL is above entry for BUY
        tp1: 2645.0,
        poiPrice: 2641.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Broken Pullback',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2640.0, top: 2642.0 },
      },
      context
    );

    assert.strictEqual(res.isValid, false, 'Violated structure/invalidation must be rejected');
  });

  // -------------------------------------------------------------------------
  // TEST 10: Spread-Aware BUY Entry (Normal Spread 0.25 pt) -> ACCEPTED
  // -------------------------------------------------------------------------
  runTest('TEST 10: Spread-aware BUY entry (normal spread 0.25 pt) -> ACCEPTED', () => {
    const candles5m = [...baseCandles5m];
    candles5m[candles5m.length - 1] = buildMockCandle(now - 300000, 2641.5, 2642.2, 2639.0, 2642.0);

    const context = {
      currentPrice: 2642.0,
      candles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ swingHigh: 2648, swingLow: 2638, atr14: 3.5 }),
      indicators15m: buildMockIndicators({ swingHigh: 2655, swingLow: 2635, atr14: 4.0 }),
      indicators1h: buildMockIndicators({ swingHigh: 2665, swingLow: 2630, atr14: 5.0 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      currentSpread: 0.25, // 2.5 gold points (normal)
    };

    const res = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2642.0,
        stopLoss: 2638.0,
        tp1: 2650.0,
        poiPrice: 2641.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Normal Spread BUY',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2640.0, top: 2642.5 },
      },
      context
    );

    assert.strictEqual(res.isValid, true, `Normal spread setup should pass: ${res.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 11: Spread-Aware SELL Entry (Normal Spread 0.25 pt) -> ACCEPTED
  // -------------------------------------------------------------------------
  runTest('TEST 11: Spread-aware SELL entry (normal spread 0.25 pt) -> ACCEPTED', () => {
    const sellCandles5m = makeCandleSeries(2660, 30, -0.1);
    sellCandles5m[sellCandles5m.length - 1] = buildMockCandle(now - 300000, 2658.5, 2661.0, 2657.8, 2658.0);

    const context = {
      currentPrice: 2658.0,
      candles5m: sellCandles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', swingHigh: 2662, swingLow: 2652, atr14: 3.5 }),
      indicators15m: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', swingHigh: 2665, swingLow: 2645, atr14: 4.0 }),
      indicators1h: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', swingHigh: 2670, swingLow: 2635, atr14: 5.0 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      currentSpread: 0.25, // 2.5 gold points (normal)
    };

    const res = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2658.0,
        stopLoss: 2662.0,
        tp1: 2650.0,
        poiPrice: 2659.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Normal Spread SELL',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2657.5, top: 2660.0 },
      },
      context
    );

    assert.strictEqual(res.isValid, true, `Normal spread setup should pass: ${res.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 12: Excessive Spread on BUY -> REJECTED (SPREAD_EXCESSIVE)
  // -------------------------------------------------------------------------
  runTest('TEST 12: Excessive spread on BUY (> 20% of SL or > 12 pts) -> REJECTED (SPREAD_EXCESSIVE)', () => {
    const candles5m = [...baseCandles5m];
    candles5m[candles5m.length - 1] = buildMockCandle(now - 300000, 2641.5, 2642.2, 2639.0, 2642.0);

    const context = {
      currentPrice: 2642.0,
      candles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ swingHigh: 2648, swingLow: 2638, atr14: 3.5 }),
      indicators15m: buildMockIndicators({ atr14: 4.0 }),
      indicators1h: buildMockIndicators({ atr14: 5.0 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      currentSpread: 1.5, // 15 gold points! (e.g. news spike / illiquid session)
    };

    const res = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2642.0,
        stopLoss: 2638.0, // 4.0 pts SL. Spread 1.5 consumes 37.5% of SL
        tp1: 2650.0,
        poiPrice: 2641.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Excessive Spread BUY',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2640.0, top: 2642.5 },
      },
      context
    );

    assert.strictEqual(res.isValid, false, 'Excessive spread setup must be rejected');
    assert.ok(res.rejectionReason?.includes('SPREAD_EXCESSIVE'), `Expected SPREAD_EXCESSIVE rejection, got: ${res.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 13: Excessive Spread on SELL -> REJECTED (SPREAD_EXCESSIVE)
  // -------------------------------------------------------------------------
  runTest('TEST 13: Excessive spread on SELL (> 20% of SL or > 12 pts) -> REJECTED (SPREAD_EXCESSIVE)', () => {
    const sellCandles5m = makeCandleSeries(2660, 30, -0.1);
    sellCandles5m[sellCandles5m.length - 1] = buildMockCandle(now - 300000, 2658.5, 2661.0, 2657.8, 2658.0);

    const context = {
      currentPrice: 2658.0,
      candles5m: sellCandles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', swingHigh: 2662, swingLow: 2652, atr14: 3.5 }),
      indicators15m: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', atr14: 4.0 }),
      indicators1h: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', atr14: 5.0 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      currentSpread: 1.5, // 15 gold points!
    };

    const res = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2658.0,
        stopLoss: 2662.0, // 4.0 pts SL. Spread 1.5 consumes 37.5% of SL
        tp1: 2650.0,
        poiPrice: 2659.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Excessive Spread SELL',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2657.5, top: 2660.0 },
      },
      context
    );

    assert.strictEqual(res.isValid, false, 'Excessive spread setup must be rejected');
    assert.ok(res.rejectionReason?.includes('SPREAD_EXCESSIVE'), `Expected SPREAD_EXCESSIVE rejection, got: ${res.rejectionReason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 14: No Artificial Repair on BUY (SL / Entry / TP Immutable)
  // -------------------------------------------------------------------------
  runTest('TEST 14: No artificial repair on BUY — optimizeSetupExecutability does not shift entry, widen SL, or stretch TP', () => {
    const rawEntry = 2642.0;
    const rawSl = 2634.0; // 8.0 pts = 80 gold pts (> 65 pts ceiling)
    const rawTp1 = 2650.0;

    const opt = optimizeSetupExecutability({
      balance: 100,
      riskPercent: 5.0,
      entry: rawEntry,
      stopLoss: rawSl,
      tp1: rawTp1,
      direction: 'BUY',
      asset: 'XAU/USD',
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
    });

    // Optimizer must NOT artificially compress SL or shift entry to make it pass
    assert.strictEqual(opt.wasOptimized, false, 'wasOptimized must remain false');
    assert.strictEqual(opt.optimizedEntry, rawEntry, 'Entry must NOT be shifted');
    assert.strictEqual(opt.optimizedStopLoss, rawSl, 'Stop Loss must NOT be clamped or tightened');
    assert.strictEqual(opt.optimizedTp1, rawTp1, 'TP1 must NOT be stretched');
    assert.strictEqual(opt.isExecutable, false, 'Setup violating 65 pt ceiling must be marked isExecutable: false');
  });

  // -------------------------------------------------------------------------
  // TEST 15: No Artificial Repair on SELL (SL / Entry / TP Immutable)
  // -------------------------------------------------------------------------
  runTest('TEST 15: No artificial repair on SELL — optimizeSetupExecutability does not shift entry, widen SL, or stretch TP', () => {
    const rawEntry = 2658.0;
    const rawSl = 2666.0; // 8.0 pts = 80 gold pts (> 65 pts ceiling)
    const rawTp1 = 2650.0;

    const opt = optimizeSetupExecutability({
      balance: 100,
      riskPercent: 5.0,
      entry: rawEntry,
      stopLoss: rawSl,
      tp1: rawTp1,
      direction: 'SELL',
      asset: 'XAU/USD',
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
    });

    assert.strictEqual(opt.wasOptimized, false, 'wasOptimized must remain false');
    assert.strictEqual(opt.optimizedEntry, rawEntry, 'Entry must NOT be shifted');
    assert.strictEqual(opt.optimizedStopLoss, rawSl, 'Stop Loss must NOT be clamped or tightened');
    assert.strictEqual(opt.optimizedTp1, rawTp1, 'TP1 must NOT be stretched');
    assert.strictEqual(opt.isExecutable, false, 'Setup violating 65 pt ceiling must be marked isExecutable: false');
  });

  // -------------------------------------------------------------------------
  // TEST 16: 1M Entry Timing Refinement (Micro-retest Confirms Optimal Timing)
  // -------------------------------------------------------------------------
  runTest('TEST 16: 1M entry timing refinement — micro-pullback retest confirms optimal entry timing', () => {
    const candles5m = [...baseCandles5m];
    candles5m[candles5m.length - 1] = buildMockCandle(now - 300000, 2640.5, 2642.5, 2639.0, 2642.0);

    // 1M series stabilizing and retesting POI edge
    const candles1m = make1mCandleSeries(2641.5, 5, 0.02);

    const timing = assessEntryTimingAndAntiChase(
      'BUY',
      'ORDER_BLOCK',
      2642.0,
      2641.0,
      candles5m,
      buildMockIndicators({ atr14: 3.5 }),
      'STRONG_UPTREND',
      { top: 2642.5, bottom: 2640.0, poiPrice: 2641.0 },
      candles1m
    );

    assert.strictEqual(timing.timing, 'OPTIMAL', '1M micro-retest near POI must produce OPTIMAL timing');
    assert.strictEqual(timing.isChasing, false, 'Must not be marked as chasing');
  });

  // -------------------------------------------------------------------------
  // TEST 17: 1M Runaway Expansion Confirms CHASED_ENTRY
  // -------------------------------------------------------------------------
  runTest('TEST 17: 1M runaway expansion — micro-candles accelerating away from POI (> 1.2 ATR) confirms CHASED_ENTRY', () => {
    const candles5m = [...baseCandles5m];
    candles5m[candles5m.length - 1] = buildMockCandle(now - 300000, 2642.0, 2646.0, 2641.5, 2645.5);

    // 1M series expanding aggressively upwards away from POI
    const candles1m = make1mCandleSeries(2641.0, 5, 1.0); // 4.0 pt expansion across 5 candles!

    const timing = assessEntryTimingAndAntiChase(
      'BUY',
      'ORDER_BLOCK',
      2645.5,
      2640.0,
      candles5m,
      buildMockIndicators({ atr14: 3.0 }), // ATR=3.0, distance = 4.5 pts = 1.5 ATR
      'STRONG_UPTREND',
      { top: 2641.0, bottom: 2639.5, poiPrice: 2640.0 },
      candles1m
    );

    assert.strictEqual(timing.timing, 'CHASED', '1M runaway acceleration away from POI must produce CHASED timing');
    assert.strictEqual(timing.isChasing, true, 'isChasing must be true');
    assert.ok(timing.reason.includes('1M micro-structure'), `Reason should cite 1M micro-structure: ${timing.reason}`);
  });

  // -------------------------------------------------------------------------
  // TEST 18: Strict BUY/SELL Symmetry Parity
  // -------------------------------------------------------------------------
  runTest('TEST 18: Strict BUY/SELL Symmetry Parity across all Entry Timing checks', () => {
    // BUY Candidate
    const buyCandles5m = makeCandleSeries(2640, 30, 0.1);
    buyCandles5m[buyCandles5m.length - 1] = buildMockCandle(now - 300000, 2640.5, 2642.5, 2639.0, 2642.0);

    const buyContext = {
      currentPrice: 2642.0,
      candles5m: buyCandles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ swingHigh: 2648, swingLow: 2638, atr14: 3.5 }),
      indicators15m: buildMockIndicators({ swingHigh: 2655, swingLow: 2635, atr14: 4.0 }),
      indicators1h: buildMockIndicators({ swingHigh: 2665, swingLow: 2630, atr14: 5.0 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      currentSpread: 0.25,
    };

    const buyRes = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2642.0,
        stopLoss: 2638.0,
        tp1: 2650.0,
        poiPrice: 2641.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Symmetrical OB BUY',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2640.0, top: 2642.5 },
      },
      buyContext
    );

    // Mirrored SELL Candidate
    const sellCandles5m = makeCandleSeries(2660, 30, -0.1);
    sellCandles5m[sellCandles5m.length - 1] = buildMockCandle(now - 300000, 2659.5, 2661.0, 2657.5, 2658.0);

    const sellContext = {
      currentPrice: 2658.0,
      candles5m: sellCandles5m,
      candles15m: baseCandles15m,
      candles1h: baseCandles1h,
      indicators5m: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', swingHigh: 2662, swingLow: 2652, atr14: 3.5 }),
      indicators15m: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', swingHigh: 2665, swingLow: 2645, atr14: 4.0 }),
      indicators1h: buildMockIndicators({ structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', swingHigh: 2670, swingLow: 2635, atr14: 5.0 }),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
      currentSpread: 0.25,
    };

    const sellRes = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2658.0,
        stopLoss: 2662.0,
        tp1: 2650.0,
        poiPrice: 2659.0,
        strategyFamily: 'ORDER_BLOCK',
        setupName: 'Symmetrical OB SELL',
        poiMeta: { type: 'ORDER_BLOCK', bottom: 2657.5, top: 2660.0 },
      },
      sellContext
    );

    assert.strictEqual(buyRes.isValid, sellRes.isValid, 'BUY and SELL validity must be 100% symmetrically matched');
    assert.strictEqual(buyRes.timing, sellRes.timing, 'BUY and SELL timing must be 100% symmetrically matched');
  });

  console.log('========================================================================');
  console.log(`📊 SUMMARY: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  console.log('========================================================================');

  if (failed > 0) {
    throw new Error(`${failed} test(s) failed in entryTimingQualityRegression suite!`);
  }
}

// Auto-run if executed directly
if (process.argv[1]?.endsWith('entryTimingQualityRegression.test.ts') || process.argv[1]?.endsWith('entryTimingQualityRegression.test.js')) {
  runEntryTimingQualityRegressionSuite().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}
