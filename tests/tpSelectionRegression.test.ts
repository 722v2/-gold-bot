import assert from 'node:assert';
import { calculateDynamicTakeProfits } from '../server/tpEngine';
import {
  assessStopLossQuality,
  assessEntryTimingAndAntiChase,
  validateTradeSignalCandidate,
} from '../server/tradeQualityEngine';
import { calculatePositionSizing } from '../server/riskManager';
import { TechnicalIndicators, Candle } from '../src/types';

function buildMockIndicators(overrides: Partial<TechnicalIndicators> = {}): TechnicalIndicators {
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
    bollingerBands: { upper: 2660, middle: 2650, lower: 2640 },
    swingHigh: 2660,
    swingLow: 2640,
    support: 2640,
    resistance: 2660,
    ...overrides,
  };
}

function buildMockCandles(count = 50, basePrice = 2650): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    candles.push({
      timestamp: now - (count - i) * 300000,
      open: basePrice + Math.sin(i / 5) * 2,
      high: basePrice + Math.sin(i / 5) * 2 + 1,
      low: basePrice + Math.sin(i / 5) * 2 - 1,
      close: basePrice + Math.sin(i / 5) * 2 + 0.5,
      volume: 1000,
    });
  }
  return candles;
}

export async function runTpSelectionRegressionSuite() {
  console.log('========================================================================');
  console.log('🎯 RUNNING DEDICATED XAU/USD STRUCTURE & TP REGRESSION SUITE (TESTS A - L)');
  console.log('========================================================================');

  // -------------------------------------------------------------------------
  // TEST A: BUY with nearby 1.1R structural TP1 vs distant 3R projection
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST A] BUY with nearby 1.1R structural TP1 vs distant 3R projection...');
    const entry = 2650.00;
    const stopLoss = 2645.00; // SL distance = 5.00 (50 pts)
    const indicators5m = buildMockIndicators({
      swingHigh: 2655.50, // Distance = 5.50 -> 1.1R
    });
    const indicators15m = buildMockIndicators({
      swingHigh: 2665.00, // Distance = 15.00 -> 3.0R
    });
    const indicators1h = buildMockIndicators({
      swingHigh: 2680.00,
    });

    const result = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h,
      indicators15m,
      indicators5m,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
      minRr: 1.5, // Even if minRr is passed as 1.5, nearby 1.1R must be chosen
    });

    assert.strictEqual(result.valid, true, 'Result must be valid');
    assert.strictEqual(result.tp1, 2655.50, 'TP1 must select the nearby 1.1R structural target (2655.50)');
    assert.ok(Math.abs(result.tp1Rr - 1.1) < 0.05, `Expected TP1 R:R ~ 1.1, got ${result.tp1Rr}`);
    assert.ok(result.tp1 < 2665.00, 'TP1 must not be the distant 3R projection');
    console.log(`✅ [PASS] TEST A: Nearby 1.1R structural target selected (TP1: ${result.tp1}, R:R: ${result.tp1Rr}R)`);
  }

  // -------------------------------------------------------------------------
  // TEST B: SELL with nearby 1.2R structural TP1 vs distant ATR target
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST B] SELL with nearby 1.2R structural TP1 vs distant ATR target...');
    const entry = 2650.00;
    const stopLoss = 2655.00; // SL distance = 5.00 (50 pts)
    const indicators5m = buildMockIndicators({
      swingLow: 2644.00, // Distance = 6.00 -> 1.2R
      structure: 'BEARISH',
    });
    const indicators15m = buildMockIndicators({
      swingLow: 2644.00,
      atr14: 6.0,
      structure: 'BEARISH',
    });
    const indicators1h = buildMockIndicators({
      atr14: 8.0,
      structure: 'BEARISH',
    });

    const result = calculateDynamicTakeProfits({
      direction: 'SELL',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h,
      indicators15m,
      indicators5m,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
      minRr: 1.5,
    });

    assert.strictEqual(result.valid, true, 'Result must be valid');
    assert.strictEqual(result.tp1, 2644.00, 'TP1 must select the nearby 1.2R structural swing low');
    assert.ok(Math.abs(result.tp1Rr - 1.2) < 0.05, `Expected TP1 R:R ~ 1.2, got ${result.tp1Rr}`);
    assert.ok(!result.tp1TargetName.includes('ATR Projection'), 'TP1 must not be replaced by distant ATR projection');
    console.log(`✅ [PASS] TEST B: Nearby 1.2R structural target selected over ATR (TP1: ${result.tp1}, R:R: ${result.tp1Rr}R)`);
  }

  // -------------------------------------------------------------------------
  // TEST C: BUY with nearby opposing OB before distant TP -> OB becomes TP1
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST C] BUY with nearby opposing OB before distant TP (OB becomes TP1)...');
    const entry = 2650.00;
    const stopLoss = 2645.00; // SL distance = 5.00 (50 pts)
    const indicators15m = buildMockIndicators({
      swingHigh: 2670.00, // Distant macro target (4.0R)
      resistance: 2670.00,
      bollingerBands: { upper: 2675.00, middle: 2650, lower: 2640 },
      orderBlock: {
        type: 'BEARISH',
        high: 2658.00,
        low: 2655.50, // Opposing OB barrier (Distance = 5.50 -> 1.1R)
      },
    });
    const indicators5m = buildMockIndicators({
      swingHigh: 2670.00,
      resistance: 2670.00,
      bollingerBands: { upper: 2675.00, middle: 2650, lower: 2640 },
    });
    const indicators1h = buildMockIndicators({
      swingHigh: 2670.00,
      resistance: 2670.00,
      bollingerBands: { upper: 2675.00, middle: 2650, lower: 2640 },
    });

    const result = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h,
      indicators15m,
      indicators5m,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
      minRr: 1.5,
    });

    assert.strictEqual(result.valid, true, 'Result must be valid');
    assert.strictEqual(result.tp1, 2655.50, 'TP1 must be anchored to the opposing 15M Bearish Order Block');
    assert.ok(result.tp1TargetName.includes('15M Bearish Order Block Barrier'), 'TP1 name must identify OB barrier');
    assert.strictEqual(result.tp2, 2670.00, 'TP2 must be the next structural objective beyond the OB');
    console.log(`✅ [PASS] TEST C: Opposing Order Block becomes TP1 at ${result.tp1}, TP2 remains next objective at ${result.tp2}`);
  }

  // -------------------------------------------------------------------------
  // TEST D: SELL with nearby opposing FVG before distant TP -> FVG becomes TP1
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST D] SELL with nearby opposing FVG before distant TP (FVG becomes TP1)...');
    const entry = 2650.00;
    const stopLoss = 2654.00; // SL distance = 4.00 (40 pts)
    const indicators15m = buildMockIndicators({
      swingLow: 2630.00, // Distant macro target (5.0R)
      support: 2630.00,
      bollingerBands: { upper: 2660, middle: 2650, lower: 2625 },
      fvg: {
        type: 'BULLISH',
        top: 2645.20, // Opposing FVG top barrier (Distance = 4.80 -> 1.2R)
        bottom: 2642.00,
      },
    });
    const indicators5m = buildMockIndicators({
      swingLow: 2630.00,
      support: 2630.00,
      bollingerBands: { upper: 2660, middle: 2650, lower: 2625 },
    });
    const indicators1h = buildMockIndicators({
      swingLow: 2630.00,
      support: 2630.00,
      bollingerBands: { upper: 2660, middle: 2650, lower: 2625 },
    });

    const result = calculateDynamicTakeProfits({
      direction: 'SELL',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h,
      indicators15m,
      indicators5m,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
      minRr: 1.5,
    });

    assert.strictEqual(result.valid, true, 'Result must be valid');
    assert.strictEqual(result.tp1, 2645.20, 'TP1 must be anchored to the opposing 15M Bullish FVG Barrier');
    assert.ok(result.tp1TargetName.includes('15M Bullish FVG Barrier'), 'TP1 name must identify FVG barrier');
    assert.strictEqual(result.tp2, 2630.00, 'TP2 must be the next structural objective beyond the FVG');
    console.log(`✅ [PASS] TEST D: Opposing FVG becomes TP1 at ${result.tp1}, TP2 remains next objective at ${result.tp2}`);
  }

  // -------------------------------------------------------------------------
  // TEST E: Valid setup where structural SL is 55 points -> Executable
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST E] Valid setup where structural SL is 55 points (Executable)...');
    const entry = 2650.00;
    const stopLoss = 2644.50; // 55 points SL
    const indicators5m = buildMockIndicators({ swingLow: 2644.80 });

    const slAssessment = assessStopLossQuality('BUY', entry, stopLoss, indicators5m, 35, 65);
    assert.strictEqual(slAssessment.isValid, true, '55 points SL must be valid within 35-65 boundaries');
    assert.strictEqual(slAssessment.slPoints, 55.0, 'SL points must equal exactly 55.0');

    // Position sizing test with broker specs allowing maxLoss 6.0
    const sizing = calculatePositionSizing(100, 15.0, entry, stopLoss, {
      contractSizeOz: 100,
      minimumLot: 0.01,
      minGoldSlPoints: 35,
      maxGoldSlPoints: 65,
      maxLoss: 6.0,
    });
    assert.strictEqual(sizing.isExecutable, true, '55-point SL must be executable when maxLoss allows ($5.50 <= $6.00)');
    console.log(`✅ [PASS] TEST E: 55-point structural SL is valid and executable (Points: ${slAssessment.slPoints})`);
  }

  // -------------------------------------------------------------------------
  // TEST F: Setup requiring 70-point structural SL -> Rejected (not moved)
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST F] Setup requiring 70-point structural SL -> Rejected without artificial distortion...');
    const entry = 2650.00;
    const stopLoss = 2643.00; // 70 points SL (> 65 pts ceiling)
    const indicators5m = buildMockIndicators({ swingLow: 2643.30 });

    const slAssessment = assessStopLossQuality('BUY', entry, stopLoss, indicators5m, 35, 65);
    assert.strictEqual(slAssessment.isValid, false, '70 points SL must be rejected as exceeding max 65 points');
    assert.ok(slAssessment.reason.includes('too wide'), 'Rejection reason must state SL is too wide');
    console.log(`✅ [PASS] TEST F: 70-point SL rejected deterministically (${slAssessment.reason})`);
  }

  // -------------------------------------------------------------------------
  // TEST G: Chased BUY -> Rejected / Downgraded
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST G] Chased BUY entry (overextended past POI) -> Rejected / Downgraded...');
    const idealPoiEntry = 2645.00;
    const currentPrice = 2655.00; // 10.0 pts displacement (~2.85 ATR above POI)
    const indicators5m = buildMockIndicators({ atr14: 3.5 });
    const candles5m = buildMockCandles(50, 2650);

    const timingAssessment = assessEntryTimingAndAntiChase(
      'BUY',
      'ORDER_BLOCK',
      currentPrice,
      idealPoiEntry,
      candles5m,
      indicators5m,
      'STRONG_UPTREND'
    );

    assert.strictEqual(timingAssessment.isChasing, true, 'Anti-Chase gate must detect chasing');
    assert.strictEqual(timingAssessment.timing, 'CHASED', 'Timing status must be CHASED');
    assert.ok(timingAssessment.timingPenalty >= 35, 'Timing penalty must be high');
    console.log(`✅ [PASS] TEST G: Chased BUY disqualified with timing=${timingAssessment.timing} (Penalty: ${timingAssessment.timingPenalty})`);
  }

  // -------------------------------------------------------------------------
  // TEST H: Chased SELL -> Rejected / Downgraded
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST H] Chased SELL entry (overextended past POI) -> Rejected / Downgraded...');
    const idealPoiEntry = 2655.00;
    const currentPrice = 2645.00; // 10.0 pts displacement (~2.85 ATR below POI)
    const indicators5m = buildMockIndicators({ atr14: 3.5, structure: 'BEARISH' });
    const candles5m = buildMockCandles(50, 2650);

    const timingAssessment = assessEntryTimingAndAntiChase(
      'SELL',
      'ORDER_BLOCK',
      currentPrice,
      idealPoiEntry,
      candles5m,
      indicators5m,
      'STRONG_DOWNTREND'
    );

    assert.strictEqual(timingAssessment.isChasing, true, 'Anti-Chase gate must detect chasing');
    assert.strictEqual(timingAssessment.timing, 'CHASED', 'Timing status must be CHASED');
    assert.ok(timingAssessment.timingPenalty >= 35, 'Timing penalty must be high');
    console.log(`✅ [PASS] TEST H: Chased SELL disqualified with timing=${timingAssessment.timing} (Penalty: ${timingAssessment.timingPenalty})`);
  }

  // -------------------------------------------------------------------------
  // TEST I: BUY/SELL Mirrored Scenarios -> Symmetrical Structural Behavior
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST I] BUY/SELL Mirrored Scenarios -> Symmetrical Structural Behavior...');
    const buyEntry = 2650.00;
    const buySl = 2646.00; // 4.00 distance
    const buyIndicators = buildMockIndicators({ swingHigh: 2654.80 }); // 4.80 distance -> 1.20R

    const sellEntry = 2650.00;
    const sellSl = 2654.00; // 4.00 distance
    const sellIndicators = buildMockIndicators({ swingLow: 2645.20, structure: 'BEARISH' }); // 4.80 distance -> 1.20R

    const buyResult = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry: buyEntry,
      stopLoss: buySl,
      asset: 'XAU/USD',
      indicators1h: buyIndicators,
      indicators15m: buyIndicators,
      indicators5m: buyIndicators,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
      minRr: 1.5,
    });

    const sellResult = calculateDynamicTakeProfits({
      direction: 'SELL',
      entry: sellEntry,
      stopLoss: sellSl,
      asset: 'XAU/USD',
      indicators1h: sellIndicators,
      indicators15m: sellIndicators,
      indicators5m: sellIndicators,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
      minRr: 1.5,
    });

    assert.strictEqual(buyResult.valid, true);
    assert.strictEqual(sellResult.valid, true);
    assert.strictEqual(buyResult.tp1Rr, sellResult.tp1Rr, 'BUY and SELL R:R must be mathematically identical');
    assert.strictEqual(buyResult.tp1Points, sellResult.tp1Points, 'BUY and SELL TP1 points must be mathematically identical');
    console.log(`✅ [PASS] TEST I: Mirrored BUY and SELL produced identical R:R (${buyResult.tp1Rr}R) and points (${buyResult.tp1Points} pts)`);
  }

  // -------------------------------------------------------------------------
  // TEST J: TP2 must be the next meaningful structural objective (not a multiplier)
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST J] TP2 is next meaningful structural objective, not a distance multiplier...');
    const entry = 2650.00;
    const stopLoss = 2645.00; // SL distance = 5.00
    const indicators5m = buildMockIndicators({
      swingHigh: 2655.50, // TP1 structural candidate: 1.1R (dist: 5.50)
      resistance: 2664.00,
      bollingerBands: { upper: 2670.00, middle: 2650, lower: 2640 },
    });
    const indicators15m = buildMockIndicators({
      swingHigh: 2664.00, // TP2 structural candidate: 2.8R (dist: 14.00)
      resistance: 2664.00,
      bollingerBands: { upper: 2670.00, middle: 2650, lower: 2640 },
    });
    const indicators1h = buildMockIndicators({
      swingHigh: 2664.00,
      resistance: 2664.00,
      bollingerBands: { upper: 2670.00, middle: 2650, lower: 2640 },
    });

    const result = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h,
      indicators15m,
      indicators5m,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
      minRr: 1.5,
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.tp1, 2655.50, 'TP1 must be 5M swing pivot');
    assert.strictEqual(result.tp2, 2664.00, 'TP2 must be the 15M Swing High (2664.00), not an arbitrary multiple');
    const arbitraryDoubleDistance = entry + 2 * (result.tp1 - entry); // 2650 + 11 = 2661.00
    assert.notStrictEqual(result.tp2, arbitraryDoubleDistance, 'TP2 must NOT be a naive 2x distance multiplier');
    console.log(`✅ [PASS] TEST J: TP2 anchored to structural 15M Swing at ${result.tp2} (not naive multiplier ${arbitraryDoubleDistance})`);
  }

  // -------------------------------------------------------------------------
  // TEST K: No artificial minRr >= 1.5 filter may reject TP1
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST K] No artificial minRr >= 1.5 filter may reject TP1...');
    const entry = 2650.00;
    const stopLoss = 2646.00; // SL distance = 4.00 (40 pts)
    const indicators5m = buildMockIndicators({
      swingHigh: 2654.40, // Distance = 4.40 -> 1.10R (< 1.5R)
    });
    const indicators15m = buildMockIndicators({
      swingHigh: 2670.00,
    });

    const result = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h: buildMockIndicators(),
      indicators15m,
      indicators5m,
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
      minRr: 1.5, // Caller explicitly requested 1.5
    });

    assert.strictEqual(result.valid, true, 'Setup must be valid');
    assert.strictEqual(result.tp1, 2654.40, 'TP1 must be selected at 2654.40 despite being 1.10R (< 1.5R)');
    assert.ok(result.tp1Rr < 1.5, 'TP1 R:R must be naturally preserved below 1.5R');
    console.log(`✅ [PASS] TEST K: Realistic 1.10R target accepted without being rejected by minRr=1.5 (TP1: ${result.tp1})`);
  }

  // -------------------------------------------------------------------------
  // TEST L: Malformed / NaN / undefined candidate data fails safely without crashing
  // -------------------------------------------------------------------------
  {
    console.log('\n[TEST L] Malformed / NaN / undefined candidate data fails safely without crashing...');

    // 1. NaN entry
    const nanResult = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry: NaN,
      stopLoss: 2645.00,
      asset: 'XAU/USD',
      indicators1h: buildMockIndicators(),
      indicators15m: buildMockIndicators(),
      indicators5m: buildMockIndicators(),
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
    });
    assert.strictEqual(nanResult.valid, false, 'NaN entry must fail safely to valid=false');

    // 2. undefined stopLoss
    const undefinedSlResult = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry: 2650.00,
      stopLoss: undefined as unknown as number,
      asset: 'XAU/USD',
      indicators1h: buildMockIndicators(),
      indicators15m: buildMockIndicators(),
      indicators5m: buildMockIndicators(),
      candles1h: buildMockCandles(),
      candles15m: buildMockCandles(),
      candles5m: buildMockCandles(),
    });
    assert.strictEqual(undefinedSlResult.valid, false, 'undefined stopLoss must fail safely to valid=false');

    // 3. validateTradeSignalCandidate with malformed candidate
    const brokenCandidateValidation = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: NaN,
        stopLoss: 2495.0,
        tp1: 2505.0,
      },
      {
        currentPrice: 2500.0,
        candles5m: buildMockCandles(),
        candles15m: buildMockCandles(),
        candles1h: buildMockCandles(),
        indicators5m: buildMockIndicators(),
        indicators15m: buildMockIndicators(),
        indicators1h: buildMockIndicators(),
      }
    );
    assert.strictEqual(brokenCandidateValidation.isValid, false, 'validateTradeSignalCandidate must return isValid=false on NaN');
    assert.ok(brokenCandidateValidation.rejectionReason, 'Must provide clear rejection reason');

    console.log('✅ [PASS] TEST L: System gracefully handled all NaN/undefined candidate data without uncaught errors');
  }

  console.log('\n========================================================================');
  console.log('🎉 ALL 12 REGRESSION TESTS (A - L) COMPLETED AND PASSED WITH 100% SUCCESS');
  console.log('========================================================================\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTpSelectionRegressionSuite().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}
