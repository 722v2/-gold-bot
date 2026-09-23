import { assessEntryTimingAndAntiChase, assessStopLossQuality, validateTradeSignalCandidate } from '../server/tradeQualityEngine.js';
import { evaluateTradeRisk } from '../server/riskManager.js';
import { analyzeTechnicals } from '../server/indicators.js';
import { Candle } from '../src/types.js';

async function runEntrySlQualityRegressionSuite() {
  console.log('======================================================================');
  console.log('🧪 ENTRY QUALITY & STRUCTURAL STOP LOSS REGRESSION TEST SUITE (20 SCENARIOS)');
  console.log('======================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName}${detail ? ': ' + detail : ''}`);
      failed++;
    }
  }

  // Helper to generate a realistic candle series for 5M, 15M, 1H
  function makeCandles(basePrice: number, count: number, step: number = 0.1): Candle[] {
    const candles: Candle[] = [];
    const now = Date.now();
    for (let i = count; i >= 1; i--) {
      const p = basePrice + (count - i) * step;
      candles.push({
        timestamp: now - i * 300000,
        open: p - 0.2,
        high: p + 0.6,
        low: p - 0.6,
        close: p + 0.1,
        volume: 500,
      });
    }
    return candles;
  }

  const baseCandles5m = makeCandles(2500, 30, 0.05);
  const baseCandles15m = makeCandles(2500, 30, 0.15);
  const baseCandles1h = makeCandles(2500, 30, 0.3);
  const indicators5m = analyzeTechnicals(baseCandles5m);
  const indicators15m = analyzeTechnicals(baseCandles15m);
  const indicators1h = analyzeTechnicals(baseCandles1h);

  const baseContext = {
    currentPrice: 2501.5,
    candles5m: baseCandles5m,
    candles15m: baseCandles15m,
    candles1h: baseCandles1h,
    indicators5m,
    indicators15m,
    indicators1h,
    brokerSpecs: {
      minSlPoints: 35,
      maxSlPoints: 65,
      minRr: 1.0,
      contractSizeOz: 100,
      minimumLot: 0.01,
      maxLoss: 5.0,
    },
  };

  // -------------------------------------------------------------------------
  // SCENARIO 1: BUY Entry near Bullish POI (Order Block) -> Valid entry (OPTIMAL/ACCEPTABLE)
  // -------------------------------------------------------------------------
  {
    const poiContext = {
      type: 'ORDER_BLOCK' as const,
      top: 2501.0,
      bottom: 2499.0,
      poiPrice: 2501.0,
    };
    const timing = assessEntryTimingAndAntiChase(
      'BUY',
      'ORDER_BLOCK',
      2501.5, // 0.5 points above OB top (0.25 ATR when ATR=2.0)
      2501.0,
      baseCandles5m,
      indicators5m,
      'RANGE_BOUND',
      poiContext
    );
    assert(
      timing.timing === 'OPTIMAL' && !timing.isChasing,
      'Scenario 1: BUY Entry near Bullish POI is OPTIMAL',
      `Timing=${timing.timing}, distanceAtr=${timing.distanceFromPoiAtr}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 2: SELL Entry near Bearish POI (Order Block) -> Valid entry [Symmetry]
  // -------------------------------------------------------------------------
  {
    const poiContext = {
      type: 'ORDER_BLOCK' as const,
      top: 2505.0,
      bottom: 2503.0,
      poiPrice: 2503.0,
    };
    const timing = assessEntryTimingAndAntiChase(
      'SELL',
      'ORDER_BLOCK',
      2502.5, // 0.5 points below OB bottom (0.25 ATR when ATR=2.0)
      2503.0,
      baseCandles5m,
      indicators5m,
      'RANGE_BOUND',
      poiContext
    );
    assert(
      timing.timing === 'OPTIMAL' && !timing.isChasing,
      'Scenario 2: SELL Entry near Bearish POI is OPTIMAL [Symmetry]',
      `Timing=${timing.timing}, distanceAtr=${timing.distanceFromPoiAtr}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 3: BUY Entry near Bullish FVG -> Valid entry
  // -------------------------------------------------------------------------
  {
    const poiContext = {
      type: 'FVG' as const,
      top: 2502.0,
      bottom: 2500.0,
      poiPrice: 2502.0,
    };
    const timing = assessEntryTimingAndAntiChase(
      'BUY',
      'FVG_IMBALANCE',
      2502.5, // within 0.5 of FVG top (0.25 ATR)
      2502.0,
      baseCandles5m,
      indicators5m,
      'RANGE_BOUND',
      poiContext
    );
    assert(
      timing.timing === 'OPTIMAL' && !timing.isChasing,
      'Scenario 3: BUY Entry near Bullish FVG is OPTIMAL',
      `Timing=${timing.timing}, distanceAtr=${timing.distanceFromPoiAtr}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 4: SELL Entry near Bearish FVG -> Valid entry [Symmetry]
  // -------------------------------------------------------------------------
  {
    const poiContext = {
      type: 'FVG' as const,
      top: 2506.0,
      bottom: 2504.0,
      poiPrice: 2504.0,
    };
    const timing = assessEntryTimingAndAntiChase(
      'SELL',
      'FVG_IMBALANCE',
      2503.5, // within 0.5 of FVG bottom (0.25 ATR)
      2504.0,
      baseCandles5m,
      indicators5m,
      'RANGE_BOUND',
      poiContext
    );
    assert(
      timing.timing === 'OPTIMAL' && !timing.isChasing,
      'Scenario 4: SELL Entry near Bearish FVG is OPTIMAL [Symmetry]',
      `Timing=${timing.timing}, distanceAtr=${timing.distanceFromPoiAtr}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 5: BUY Late displacement away from POI (extended > 2.5 ATR) -> NO TRADE (CHASED_ENTRY)
  // -------------------------------------------------------------------------
  {
    const valResult = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2510.0,
        stopLoss: 2505.5, // 45 pts SL
        tp1: 2516.0,      // 60 pts TP1
        setupName: 'Bullish Order Block Retest & Reaction',
        strategyFamily: 'ORDER_BLOCK',
        poiPrice: 2500.0, // POI was at 2500.0, entry at 2510.0 (+10 pts = 5.0 ATR away!)
        poiMeta: {
          type: 'ORDER_BLOCK',
          top: 2501.0,
          bottom: 2499.0,
        },
      },
      {
        ...baseContext,
        currentPrice: 2510.0,
      }
    );
    assert(
      !valResult.isValid && (valResult.rejectionReason?.includes('CHASED_ENTRY') ?? false),
      'Scenario 5: BUY Late displacement away from POI rejected as CHASED_ENTRY',
      `isValid=${valResult.isValid}, reason=${valResult.rejectionReason}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 6: SELL Late displacement away from POI (extended > 2.5 ATR) -> NO TRADE (CHASED_ENTRY) [Symmetry]
  // -------------------------------------------------------------------------
  {
    const valResult = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2490.0,
        stopLoss: 2494.5, // 45 pts SL
        tp1: 2484.0,      // 60 pts TP1
        setupName: 'Bearish Order Block Retest & Reaction',
        strategyFamily: 'ORDER_BLOCK',
        poiPrice: 2500.0, // POI was at 2500.0, entry at 2490.0 (-10 pts = 5.0 ATR away!)
        poiMeta: {
          type: 'ORDER_BLOCK',
          top: 2501.0,
          bottom: 2499.0,
        },
      },
      {
        ...baseContext,
        currentPrice: 2490.0,
      }
    );
    assert(
      !valResult.isValid && (valResult.rejectionReason?.includes('CHASED_ENTRY') ?? false),
      'Scenario 6: SELL Late displacement away from POI rejected as CHASED_ENTRY [Symmetry]',
      `isValid=${valResult.isValid}, reason=${valResult.rejectionReason}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 7: BUY POI -> Bullish displacement -> Controlled pullback near POI -> Valid entry restored
  // -------------------------------------------------------------------------
  {
    // Candles displaced up, then pulled back to 2501.0 near POI
    const candlesWithPullback = [
      ...baseCandles5m.slice(0, -3),
      { timestamp: Date.now() - 900000, open: 2500.0, high: 2505.0, low: 2500.0, close: 2505.0, volume: 1000 }, // displacement
      { timestamp: Date.now() - 600000, open: 2505.0, high: 2505.5, low: 2502.0, close: 2502.5, volume: 400 },  // pullback 1
      { timestamp: Date.now() - 300000, open: 2502.5, high: 2503.0, low: 2500.8, close: 2501.2, volume: 500 },  // pullback 2 near POI
    ];
    const timing = assessEntryTimingAndAntiChase(
      'BUY',
      'ORDER_BLOCK',
      2501.2, // Pulled back to 0.2 above POI top!
      2501.0,
      candlesWithPullback,
      indicators5m,
      'RANGE_BOUND',
      { top: 2501.0, bottom: 2499.0, poiPrice: 2501.0, type: 'ORDER_BLOCK' }
    );
    assert(
      timing.timing === 'OPTIMAL' && !timing.isChasing,
      'Scenario 7: BUY Controlled pullback near POI restores OPTIMAL entry eligibility',
      `Timing=${timing.timing}, distanceAtr=${timing.distanceFromPoiAtr}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 8: SELL POI -> Bearish displacement -> Controlled pullback near POI -> Valid entry restored [Symmetry]
  // -------------------------------------------------------------------------
  {
    // Candles displaced down, then pulled back to 2499.0 near POI
    const candlesWithPullback = [
      ...baseCandles5m.slice(0, -3),
      { timestamp: Date.now() - 900000, open: 2500.0, high: 2500.0, low: 2495.0, close: 2495.0, volume: 1000 }, // displacement down
      { timestamp: Date.now() - 600000, open: 2495.0, high: 2498.0, low: 2494.5, close: 2497.5, volume: 400 },  // pullback 1 up
      { timestamp: Date.now() - 300000, open: 2497.5, high: 2499.2, low: 2497.0, close: 2498.8, volume: 500 },  // pullback 2 near POI
    ];
    const timing = assessEntryTimingAndAntiChase(
      'SELL',
      'ORDER_BLOCK',
      2498.8, // Pulled back to 0.2 below POI bottom!
      2499.0,
      candlesWithPullback,
      indicators5m,
      'RANGE_BOUND',
      { top: 2501.0, bottom: 2499.0, poiPrice: 2499.0, type: 'ORDER_BLOCK' }
    );
    assert(
      timing.timing === 'OPTIMAL' && !timing.isChasing,
      'Scenario 8: SELL Controlled pullback near POI restores OPTIMAL entry eligibility [Symmetry]',
      `Timing=${timing.timing}, distanceAtr=${timing.distanceFromPoiAtr}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 9: BUY Structural SL placed at genuine swing low / OB boundary (distance 35-65 pts) -> Valid
  // -------------------------------------------------------------------------
  {
    const entry = 2501.0;
    const sl = 2496.5; // 45.0 points distance
    const slQuality = assessStopLossQuality('BUY', entry, sl, indicators5m, 35, 65);
    assert(
      slQuality.isValid && slQuality.slPoints === 45.0,
      'Scenario 9: BUY Structural SL of 45 pts is valid',
      `isValid=${slQuality.isValid}, slPoints=${slQuality.slPoints}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 10: SELL Structural SL placed at genuine swing high / OB boundary (distance 35-65 pts) -> Valid [Symmetry]
  // -------------------------------------------------------------------------
  {
    const entry = 2501.0;
    const sl = 2505.5; // 45.0 points distance
    const slQuality = assessStopLossQuality('SELL', entry, sl, indicators5m, 35, 65);
    assert(
      slQuality.isValid && slQuality.slPoints === 45.0,
      'Scenario 10: SELL Structural SL of 45 pts is valid [Symmetry]',
      `isValid=${slQuality.isValid}, slPoints=${slQuality.slPoints}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 11: BUY Structural SL distance > 65 pts (e.g. 80 pts invalidation) -> Rejected as NO TRADE
  // -------------------------------------------------------------------------
  {
    const entry = 2501.0;
    const sl = 2493.0; // 80.0 points distance
    const slQuality = assessStopLossQuality('BUY', entry, sl, indicators5m, 35, 65);
    const valResult = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry,
        stopLoss: sl,
        tp1: 2510.0,
      },
      baseContext
    );
    assert(
      !slQuality.isValid && !valResult.isValid && (valResult.rejectionReason?.includes('INVALID_SL_DISTANCE') ?? false),
      'Scenario 11: BUY Structural SL of 80 pts rejected as NO TRADE (never artificially compressed)',
      `slQuality.isValid=${slQuality.isValid}, valResult.reason=${valResult.rejectionReason}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 12: SELL Structural SL distance > 65 pts (e.g. 80 pts invalidation) -> Rejected as NO TRADE [Symmetry]
  // -------------------------------------------------------------------------
  {
    const entry = 2501.0;
    const sl = 2509.0; // 80.0 points distance
    const slQuality = assessStopLossQuality('SELL', entry, sl, indicators5m, 35, 65);
    const valResult = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry,
        stopLoss: sl,
        tp1: 2492.0,
      },
      baseContext
    );
    assert(
      !slQuality.isValid && !valResult.isValid && (valResult.rejectionReason?.includes('INVALID_SL_DISTANCE') ?? false),
      'Scenario 12: SELL Structural SL of 80 pts rejected as NO TRADE (never artificially compressed) [Symmetry]',
      `slQuality.isValid=${slQuality.isValid}, valResult.reason=${valResult.rejectionReason}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 13: BUY Structural SL distance < 35 pts (e.g. 20 pts invalidation) -> Rejected as NO TRADE
  // -------------------------------------------------------------------------
  {
    const entry = 2501.0;
    const sl = 2499.0; // 20.0 points distance
    const slQuality = assessStopLossQuality('BUY', entry, sl, indicators5m, 35, 65);
    const valResult = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry,
        stopLoss: sl,
        tp1: 2505.0,
      },
      baseContext
    );
    assert(
      !slQuality.isValid && !valResult.isValid && (valResult.rejectionReason?.includes('INVALID_SL_DISTANCE') ?? false),
      'Scenario 13: BUY Structural SL of 20 pts rejected as NO TRADE (never artificially widened)',
      `slQuality.isValid=${slQuality.isValid}, valResult.reason=${valResult.rejectionReason}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 14: SELL Structural SL distance < 35 pts (e.g. 20 pts invalidation) -> Rejected as NO TRADE [Symmetry]
  // -------------------------------------------------------------------------
  {
    const entry = 2501.0;
    const sl = 2503.0; // 20.0 points distance
    const slQuality = assessStopLossQuality('SELL', entry, sl, indicators5m, 35, 65);
    const valResult = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry,
        stopLoss: sl,
        tp1: 2497.0,
      },
      baseContext
    );
    assert(
      !slQuality.isValid && !valResult.isValid && (valResult.rejectionReason?.includes('INVALID_SL_DISTANCE') ?? false),
      'Scenario 14: SELL Structural SL of 20 pts rejected as NO TRADE (never artificially widened) [Symmetry]',
      `slQuality.isValid=${slQuality.isValid}, valResult.reason=${valResult.rejectionReason}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 15: Executability optimization preserves structural SL without artificial tightening
  // -------------------------------------------------------------------------
  // SCENARIO 15: Trade risk evaluation preserves structural SL without artificial tightening
  // -------------------------------------------------------------------------
  {
    const entry = 2501.0;
    const stopLoss = 2496.0; // 50 pts SL
    const res = evaluateTradeRisk({
      balance: 10,
      riskPercent: 15,
      entry,
      stopLoss,
      tp1: 2507.0,
      tp2: 2512.0,
      direction: 'BUY',
      asset: 'XAU/USD',
      brokerSpecs: {
        accountBalance: 10,
        riskPercent: 15,
        contractSizeOz: 100,
        minimumLot: 0.01,
        maximumLot: 100,
        lotStep: 0.01,
        minGoldSlPoints: 35,
        maxGoldSlPoints: 65,
        minRr: 1.0,
        maxLoss: 5.0,
      },
    });
    assert(
      res.positionSizing.stopLossPrice === stopLoss,
      'Scenario 15: evaluateTradeRisk preserves structural SL without artificial tightening',
      `initialSL=${stopLoss}, evaluatedSL=${res.positionSizing.stopLossPrice}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 16: Trade risk evaluation preserves structural entry without artificial shifting
  // -------------------------------------------------------------------------
  {
    const entry = 2501.0;
    const stopLoss = 2496.0;
    const res = evaluateTradeRisk({
      balance: 10,
      riskPercent: 15,
      entry,
      stopLoss,
      tp1: 2507.0,
      tp2: 2512.0,
      direction: 'BUY',
      asset: 'XAU/USD',
      brokerSpecs: {
        accountBalance: 10,
        riskPercent: 15,
        contractSizeOz: 100,
        minimumLot: 0.01,
        maximumLot: 100,
        lotStep: 0.01,
        minGoldSlPoints: 35,
        maxGoldSlPoints: 65,
        minRr: 1.0,
        maxLoss: 5.0,
      },
    });
    assert(
      res.positionSizing.entryPrice === entry,
      'Scenario 16: evaluateTradeRisk preserves structural entry without artificial shifting',
      `initialEntry=${entry}, evaluatedEntry=${res.positionSizing.entryPrice}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 17: BUY Inverted/invalid geometry (SL >= Entry) -> Rejected as INVALID_GEOMETRY
  // -------------------------------------------------------------------------
  {
    const valResult = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2500.0,
        stopLoss: 2505.0, // SL above entry on BUY!
        tp1: 2515.0,
      },
      baseContext
    );
    assert(
      !valResult.isValid && (valResult.rejectionReason?.includes('INVALID_GEOMETRY') ?? false),
      'Scenario 17: BUY inverted geometry (SL >= Entry) rejected as INVALID_GEOMETRY',
      `reason=${valResult.rejectionReason}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 18: SELL Inverted/invalid geometry (SL <= Entry) -> Rejected as INVALID_GEOMETRY [Symmetry]
  // -------------------------------------------------------------------------
  {
    const valResult = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2500.0,
        stopLoss: 2495.0, // SL below entry on SELL!
        tp1: 2485.0,
      },
      baseContext
    );
    assert(
      !valResult.isValid && (valResult.rejectionReason?.includes('INVALID_GEOMETRY') ?? false),
      'Scenario 18: SELL inverted geometry (SL <= Entry) rejected as INVALID_GEOMETRY [Symmetry]',
      `reason=${valResult.rejectionReason}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 19: BUY Entry + SL Consistency: SL < Entry < TP1, with single-target TP2=0
  // -------------------------------------------------------------------------
  {
    const entry = 2500.0;
    const stopLoss = 2495.5; // 45 pts SL
    const tp1 = 2506.0;      // 60 pts TP1
    const tp2 = 0;           // Single target mode
    const riskResult = evaluateTradeRisk({
      balance: 10,
      riskPercent: 15,
      confidence: 85,
      entry,
      stopLoss,
      tp1,
      tp2,
      direction: 'BUY',
      asset: 'XAU/USD',
      brokerSpecs: {
        accountBalance: 10,
        riskPercent: 15,
        contractSizeOz: 100,
        minimumLot: 0.01,
        maximumLot: 100,
        lotStep: 0.01,
        minGoldSlPoints: 35,
        maxGoldSlPoints: 65,
        minRr: 1.0,
        maxLoss: 5.0,
      },
    });
    assert(
      riskResult.valid && stopLoss < entry && entry < tp1,
      'Scenario 19: BUY Entry + SL Consistency: SL < Entry < TP1 with TP2=0 single-target support',
      `valid=${riskResult.valid}, sl=${stopLoss}, entry=${entry}, tp1=${tp1}`
    );
  }

  // -------------------------------------------------------------------------
  // SCENARIO 20: SELL Entry + SL Consistency: TP1 < Entry < SL, with single-target TP2=0 [Symmetry]
  // -------------------------------------------------------------------------
  {
    const entry = 2500.0;
    const stopLoss = 2504.5; // 45 pts SL
    const tp1 = 2494.0;      // 60 pts TP1
    const tp2 = 0;           // Single target mode
    const riskResult = evaluateTradeRisk({
      balance: 10,
      riskPercent: 15,
      confidence: 85,
      entry,
      stopLoss,
      tp1,
      tp2,
      direction: 'SELL',
      asset: 'XAU/USD',
      brokerSpecs: {
        accountBalance: 10,
        riskPercent: 15,
        contractSizeOz: 100,
        minimumLot: 0.01,
        maximumLot: 100,
        lotStep: 0.01,
        minGoldSlPoints: 35,
        maxGoldSlPoints: 65,
        minRr: 1.0,
        maxLoss: 5.0,
      },
    });
    assert(
      riskResult.valid && tp1 < entry && entry < stopLoss,
      'Scenario 20: SELL Entry + SL Consistency: TP1 < Entry < SL with TP2=0 single-target support [Symmetry]',
      `valid=${riskResult.valid}, tp1=${tp1}, entry=${entry}, sl=${stopLoss}`
    );
  }

  console.log('\n======================================================================');
  console.log(`RESULTS: ${passed} Passed, ${failed} Failed out of 20 Scenarios`);
  console.log('======================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runEntrySlQualityRegressionSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
