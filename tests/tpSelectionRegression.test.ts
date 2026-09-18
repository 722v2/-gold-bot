import assert from 'node:assert';
import { calculateDynamicTakeProfits } from '../server/tpEngine';
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
    resistance: 2660,
    support: 2640,
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
  console.log('=== RUNNING TP SELECTION REGRESSION SUITE ===');

  // Test Case 1: Nearby 1.0R structural target selected over distant 2.0R ATR projection
  {
    console.log('[Test 1] Nearby 1.0R structural target selected over distant 2.0R ATR projection...');
    const entry = 2650.00;
    const stopLoss = 2646.00; // SL distance = 4.00 (40 points)
    const indicators5m = buildMockIndicators({
      swingHigh: 2654.00, // Distance = 4.00 -> 1.0R
    });
    const indicators15m = buildMockIndicators({
      swingHigh: 2670.00, // Macro swing high
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
      minRr: 1.5,
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.tp1, 2654.00);
    assert.ok(Math.abs(result.tp1Rr - 1.0) < 0.05, `Expected TP1 R:R ~ 1.0, got ${result.tp1Rr}`);
    assert.ok(result.tp1TargetName.includes('5M Swing High Pivot'), `Unexpected target name: ${result.tp1TargetName}`);
    console.log(' -> PASS: TP1 = 2654.00 (1.0R)');
  }

  // Test Case 2: Nearby 1.2R structural target selected over distant Fibonacci extension
  {
    console.log('[Test 2] Nearby 1.2R structural target selected over distant Fibonacci extension...');
    const entry = 2650.00;
    const stopLoss = 2645.00; // SL distance = 5.00
    const indicators5m = buildMockIndicators({
      swingHigh: 2656.00, // Distance = 6.00 -> 1.2R
    });
    const indicators15m = buildMockIndicators({
      swingHigh: 2656.00,
      swingLow: 2635.00, // swingRange = 21.0 -> Fib 1.272 = 2661.7, 1.618 = 2668.9
    });
    const indicators1h = buildMockIndicators();

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
    assert.strictEqual(result.tp1, 2656.00);
    assert.ok(Math.abs(result.tp1Rr - 1.2) < 0.05, `Expected TP1 R:R ~ 1.2, got ${result.tp1Rr}`);
    console.log(' -> PASS: TP1 = 2656.00 (1.2R)');
  }

  // Test Case 3: Nearby 1.3R structural target selected over distant macro swing
  {
    console.log('[Test 3] Nearby 1.3R structural target selected over distant macro swing...');
    const entry = 2650.00;
    const stopLoss = 2645.00; // SL distance = 5.00
    const indicators5m = buildMockIndicators({
      swingHigh: 2656.50, // Distance = 6.50 -> 1.3R
    });
    const indicators15m = buildMockIndicators({
      swingHigh: 2670.00, // Distance = 20.00 -> 4.0R
    });
    const indicators1h = buildMockIndicators();

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
    assert.strictEqual(result.tp1, 2656.50);
    assert.ok(Math.abs(result.tp1Rr - 1.3) < 0.05, `Expected TP1 R:R ~ 1.3, got ${result.tp1Rr}`);
    console.log(' -> PASS: TP1 = 2656.50 (1.3R)');
  }

  // Test Case 4: Nearby OB/FVG target < 1.5R is NOT discarded
  {
    console.log('[Test 4] Nearby Bearish OB target < 1.5R is NOT discarded...');
    const entry = 2650.00;
    const stopLoss = 2645.00; // SL distance = 5.00
    const indicators15m = buildMockIndicators({
      swingHigh: 2670.00,
      orderBlock: {
        type: 'BEARISH',
        high: 2658.00,
        low: 2655.50, // Distance = 5.50 -> 1.1R
      },
    });
    const indicators5m = buildMockIndicators({
      swingHigh: 2670.00,
    });
    const indicators1h = buildMockIndicators();

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
    assert.strictEqual(result.tp1, 2655.50);
    assert.ok(Math.abs(result.tp1Rr - 1.1) < 0.05, `Expected TP1 R:R ~ 1.1, got ${result.tp1Rr}`);
    assert.ok(result.tp1TargetName.includes('15M Bearish Order Block Barrier'));
    console.log(' -> PASS: TP1 = 2655.50 (1.1R OB Target)');
  }

  // Test Case 5: Symmetric BUY/SELL behavior
  {
    console.log('[Test 5] Symmetrically selects nearest 1.1R structural target for SELL signals...');
    const entry = 2650.00;
    const stopLoss = 2655.00; // SL distance = 5.00
    const indicators5m = buildMockIndicators({
      swingLow: 2644.50, // Distance = 5.50 -> 1.1R
    });
    const indicators15m = buildMockIndicators({
      swingLow: 2630.00, // Distance = 20.00 -> 4.0R
    });
    const indicators1h = buildMockIndicators();

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

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.tp1, 2644.50);
    assert.ok(Math.abs(result.tp1Rr - 1.1) < 0.05, `Expected TP1 R:R ~ 1.1, got ${result.tp1Rr}`);
    assert.ok(result.tp1TargetName.includes('5M Swing Low Pivot'));
    console.log(' -> PASS: SELL TP1 = 2644.50 (1.1R)');
  }

  // Test Case 6: Opposing barriers respected as realistic target
  {
    console.log('[Test 6] Respects opposing Bullish FVG in SELL setup as realistic target...');
    const entry = 2650.00;
    const stopLoss = 2654.00; // SL distance = 4.00
    const indicators15m = buildMockIndicators({
      swingLow: 2630.00,
      fvg: {
        type: 'BULLISH',
        top: 2645.20, // Distance = 4.80 -> 1.2R
        bottom: 2642.00,
      },
    });
    const indicators5m = buildMockIndicators({
      swingLow: 2630.00,
    });
    const indicators1h = buildMockIndicators();

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

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.tp1, 2645.20);
    assert.ok(Math.abs(result.tp1Rr - 1.2) < 0.05, `Expected TP1 R:R ~ 1.2, got ${result.tp1Rr}`);
    assert.ok(result.tp1TargetName.includes('15M Bullish FVG Barrier'));
    console.log(' -> PASS: SELL TP1 = 2645.20 (1.2R FVG Barrier)');
  }

  // Test Case 7: Exact failure mode reproduction
  {
    console.log('[Test 7] Fixes exact failure mode: selects nearest structural target (1.2R) instead of distant 5.9R ATR target...');
    const entry = 2650.00;
    const stopLoss = 2646.00; // SL distance = 4.00
    const indicators5m = buildMockIndicators({
      swingHigh: 2654.80, // Distance = 4.80 -> 1.2R
    });
    const indicators15m = buildMockIndicators({
      swingHigh: 2654.80,
      atr14: 4.0,
    });
    const indicators1h = buildMockIndicators({
      atr14: 6.0,
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
    assert.strictEqual(result.tp1, 2654.80);
    assert.ok(Math.abs(result.tp1Rr - 1.2) < 0.05, `Expected TP1 R:R ~ 1.2, got ${result.tp1Rr}`);
    assert.ok(!result.tp1TargetName.includes('ATR Projection'), 'TP1 must NOT be ATR Projection when structural target exists');
    console.log(' -> PASS: TP1 = 2654.80 (1.2R structural target selected over distant 5.9R ATR target)');
  }

  console.log('\n=== ALL TP SELECTION REGRESSION TESTS PASSED PERFECTLY ===\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTpSelectionRegressionSuite().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}
