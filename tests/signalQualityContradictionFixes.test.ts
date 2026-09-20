import assert from 'node:assert';
import { partition5mCandles } from '../server/candleUtils.js';
import { analyzeTechnicals } from '../server/indicators.js';
import { validateTradeSignalCandidate } from '../server/tradeQualityEngine.js';
import { evaluateTradeRisk } from '../server/riskManager.js';
import { Candle, TechnicalIndicators } from '../src/types.js';
import fs from 'node:fs';
import path from 'node:path';

function buildMockCandle(
  timestamp: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 1000,
  isClosed?: boolean
): Candle {
  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume,
    ...(isClosed !== undefined ? { isClosed } : {}),
  };
}

export async function runContradictionFixesTestSuite() {
  console.log('========================================================================');
  console.log('🧪 RUNNING SIGNAL QUALITY CONTRADICTION FIXES TEST SUITE (FIXES 1 TO 6)');
  console.log('========================================================================');

  // =========================================================================
  // FIX 1 & FIX 2: Strategy 13 Distinct Closed Candles & Pattern Detectors
  // =========================================================================
  console.log('\n--- Testing FIX 1: Strategy 13 Closed-Candle Comparison ---');
  {
    const fiveMinMs = 5 * 60 * 1000;
    const now = 1710000120000; // 2 mins into forming candle
    const t0 = 1710000000000 - 3 * fiveMinMs;
    const t1 = 1710000000000 - 2 * fiveMinMs; // prevClosedCandle
    const t2 = 1710000000000 - 1 * fiveMinMs; // lastClosedCandle
    const t3 = 1710000000000; // forming candle

    const candles: Candle[] = [
      buildMockCandle(t0, 2640, 2642, 2639, 2641),
      buildMockCandle(t1, 2641, 2642, 2635, 2636), // Bearish candle
      buildMockCandle(t2, 2636, 2646, 2635, 2645), // Bullish engulfing candle
      buildMockCandle(t3, 2645, 2649, 2644, 2648), // Forming candle
    ];

    const partition = partition5mCandles(candles, now);
    assert.strictEqual(partition.isValid, true, 'Partition must be valid');
    assert.ok(partition.lastClosedCandle, 'Must have last closed candle');
    assert.ok(partition.prevClosedCandle, 'Must have prev closed candle');

    // Prove last closed candle and prev closed candle are distinct
    assert.notStrictEqual(
      partition.lastClosedCandle.timestamp,
      partition.prevClosedCandle.timestamp,
      'lastClosedCandle and prevClosedCandle must have distinct timestamps'
    );
    assert.strictEqual(partition.lastClosedCandle.timestamp, t2, 'lastClosedCandle timestamp must match t2');
    assert.strictEqual(partition.prevClosedCandle.timestamp, t1, 'prevClosedCandle timestamp must match t1');

    // Verify Strategy 13 file code contains prevClosedCandle comparison, not candles5m.length - 2
    const strategyEngineCode = fs.readFileSync(path.join(process.cwd(), 'server/strategyEngine.ts'), 'utf8');
    assert.ok(
      strategyEngineCode.includes('partition5m.closedCandles.length >= 2 && partition5m.prevClosedCandle'),
      'Strategy 13 must check partition5m.closedCandles.length >= 2 && partition5m.prevClosedCandle'
    );
    assert.ok(
      strategyEngineCode.includes('const prevCandle = partition5m.prevClosedCandle;'),
      'Strategy 13 must assign prevCandle = partition5m.prevClosedCandle'
    );
    assert.ok(
      !strategyEngineCode.includes('const prevCandle = candles5m[candles5m.length - 2];'),
      'Strategy 13 must NOT use raw candles5m[candles5m.length - 2]'
    );
    console.log('✅ [PASS] FIX 1: Strategy 13 compares distinct closed 5M candles (lastClosed vs prevClosed).');
  }

  // =========================================================================
  // FIX 2: Pattern Detector Inputs (detectDoubleTopBottom, detectBareSRLevels, detectHorizontalBreakoutRetest)
  // =========================================================================
  console.log('\n--- Testing FIX 2: Pattern Detector Inputs Receive Closed 5M Candles ---');
  {
    const strategyEngineCode = fs.readFileSync(path.join(process.cwd(), 'server/strategyEngine.ts'), 'utf8');
    assert.ok(
      strategyEngineCode.includes('detectDoubleTopBottom(partition5m.closedCandles, atr5m)'),
      'detectDoubleTopBottom must receive partition5m.closedCandles'
    );
    assert.ok(
      strategyEngineCode.includes('detectBareSRLevels(candles15m, partition5m.closedCandles, atr15m)'),
      'detectBareSRLevels must receive partition5m.closedCandles'
    );
    assert.ok(
      strategyEngineCode.includes('detectHorizontalBreakoutRetest(candles15m, partition5m.closedCandles, atr15m)'),
      'detectHorizontalBreakoutRetest must receive partition5m.closedCandles'
    );
    console.log('✅ [PASS] FIX 2: All 3 pattern detectors receive partition5m.closedCandles.');
  }

  // =========================================================================
  // FIX 3: Closed 5M Input to Technical Indicators
  // =========================================================================
  console.log('\n--- Testing FIX 3: Forming 5M Spikes Cannot Cause 5M BOS/CHOCH/latestClose ---');
  {
    // Generate established trend candles (bullish)
    const baseCandles: Candle[] = [];
    let price = 2600;
    const baseTime = 1710000000000;
    for (let i = 0; i < 30; i++) {
      baseCandles.push(
        buildMockCandle(
          baseTime + i * 300000,
          price,
          price + 2,
          price - 1,
          price + 1,
          1000,
          true
        )
      );
      price += 1; // gentle uptrend
    }

    const closedTechs = analyzeTechnicals(baseCandles);
    assert.strictEqual(closedTechs.bosDetected, false, 'No BOS initially');
    assert.strictEqual(closedTechs.chochDetected, false, 'No CHOCH initially');

    // Now append a massive spike candle that is still forming (isClosed: false)
    const formingSpikeCandle = buildMockCandle(
      baseTime + 30 * 300000,
      price,
      price + 100, // huge spike above swingHigh
      price - 50,
      price + 90,
      5000,
      false // Forming / unclosed!
    );

    const candlesWithFormingSpike = [...baseCandles, formingSpikeCandle];
    const techWithForming = analyzeTechnicals(candlesWithFormingSpike);

    // Assert that analyzeTechnicals filtered out the unclosed candle
    assert.strictEqual(
      techWithForming.ema20,
      closedTechs.ema20,
      'ema20 must remain identical to closed candle analysis, ignoring forming spike'
    );
    assert.strictEqual(
      techWithForming.swingHigh,
      closedTechs.swingHigh,
      'swingHigh must remain identical to closed candle analysis, ignoring forming spike'
    );
    assert.strictEqual(
      techWithForming.bosDetected,
      false,
      'Forming spike must NOT cause premature BOS'
    );
    assert.strictEqual(
      techWithForming.chochDetected,
      false,
      'Forming spike must NOT cause premature CHOCH'
    );

    // Verify scanner.ts partitions before analyzeTechnicals
    const scannerCode = fs.readFileSync(path.join(process.cwd(), 'server/scanner.ts'), 'utf8');
    assert.ok(
      scannerCode.includes('const closedCandles5m = partition5m.isValid && partition5m.closedCandles.length > 0'),
      'scanner.ts must partition 5M candles into closedCandles5m'
    );
    assert.ok(
      scannerCode.includes('const ind5m = analyzeTechnicals(closedCandles5m);'),
      'scanner.ts must pass closedCandles5m to analyzeTechnicals'
    );

    console.log('✅ [PASS] FIX 3: Forming 5M candle spike cannot create 5M BOS/CHOCH/latestClose.');
  }

  // =========================================================================
  // FIX 4: TP2 = 0 Must Represent Single-Target Setup Without Geometric Error
  // =========================================================================
  console.log('\n--- Testing FIX 4: validateTradeSignalCandidate with tp2 = 0 ---');
  {
    const mockCandles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      mockCandles.push(buildMockCandle(1710000000000 + i * 300000, 2650, 2652, 2648, 2650, 1000, true));
    }
    const mockIndicators: TechnicalIndicators = {
      ema20: 2650,
      ema50: 2648,
      ema200: 2640,
      vwap: 2650,
      rsi14: 55,
      macd: { macd: 0.5, signal: 0.2, histogram: 0.3 },
      atr14: 2.0,
      bollingerBands: { upper: 2660, middle: 2650, lower: 2640 },
      swingHigh: 2665,
      swingLow: 2635,
      support: 2645,
      resistance: 2665,
      structure: 'BULLISH',
      marketRegime: 'STRONG_UPTREND',
      trendStructure: 'HH_HL',
      chochDetected: false,
      bosDetected: false,
    };

    const mockContext = {
      currentPrice: 2650.0,
      candles5m: mockCandles,
      candles15m: mockCandles,
      candles1h: mockCandles,
      indicators5m: mockIndicators,
      indicators15m: mockIndicators,
      indicators1h: mockIndicators,
      brokerSpecs: {
        minSlPoints: 35,
        maxSlPoints: 65,
        maxSpreadPoints: 30,
        minRr: 1.0,
      },
    };

    // BUY setup with tp2 = 0 (single target)
    const buyResult = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2650.0,
        stopLoss: 2645.0, // 50 pts SL
        tp1: 2658.0,      // 80 pts TP1 (> entry)
        tp2: 0,           // Single target!
        setupName: 'TEST_SINGLE_TARGET',
      },
      mockContext
    );

    assert.ok(
      !buyResult.rejectionReason?.includes('INVALID_GEOMETRY: BUY TP2'),
      `BUY setup with tp2 = 0 must NOT be rejected for TP2 geometry, got: ${buyResult.rejectionReason}`
    );

    // SELL setup with tp2 = 0 (single target)
    const sellResult = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2650.0,
        stopLoss: 2655.0, // 50 pts SL
        tp1: 2642.0,      // 80 pts TP1 (< entry)
        tp2: 0,           // Single target!
        setupName: 'TEST_SINGLE_TARGET',
      },
      mockContext
    );

    assert.ok(
      !sellResult.rejectionReason?.includes('INVALID_GEOMETRY: SELL TP2'),
      `SELL setup with tp2 = 0 must NOT be rejected for TP2 geometry, got: ${sellResult.rejectionReason}`
    );

    console.log('✅ [PASS] FIX 4: Single-target setup (tp2 = 0) does not produce INVALID_GEOMETRY: TP2.');
  }

  // =========================================================================
  // FIX 5: Telemetry for Single-Target TP2 (tp2 = 0)
  // =========================================================================
  console.log('\n--- Testing FIX 5: evaluateTradeRisk Telemetry When tp2 = 0 ---');
  {
    const riskResult = evaluateTradeRisk({
      balance: 100,
      entry: 2650.0,
      stopLoss: 2645.0,
      tp1: 2657.5,
      tp2: 0, // Single target
      confidence: 80,
      isVeryStrongSetup: false,
      losingStreak: 0,
      asset: 'XAU/USD',
      direction: 'BUY',
    });

    assert.strictEqual(riskResult.valid, true, 'Risk result must be valid');
    assert.strictEqual(riskResult.tp2Distance, 0, 'tp2Distance must be 0 when tp2 === 0');
    assert.strictEqual(riskResult.tp2Points, 0, 'tp2Points must be 0 when tp2 === 0');
    assert.strictEqual(riskResult.tp2Rr, 0, 'tp2Rr must be 0 when tp2 === 0');
    assert.strictEqual(riskResult.tp2RrString, 'N/A', 'tp2RrString must be "N/A" when tp2 === 0');
    assert.ok(
      !riskResult.rrString.includes('TP2: 1:'),
      `rrString must not report a fake TP2 ratio, got: ${riskResult.rrString}`
    );
    console.log('✅ [PASS] FIX 5: Telemetry correctly sets tp2Distance=0, tp2Points=0, tp2Rr=0, tp2RrString="N/A".');
  }

  // =========================================================================
  // FIX 6: No Remaining 1.5R Hardcoded Fallbacks in geminiTrader.ts
  // =========================================================================
  console.log('\n--- Testing FIX 6: Removal of 1.5R Fallback Policy in geminiTrader.ts ---');
  {
    const geminiCode = fs.readFileSync(path.join(process.cwd(), 'server/geminiTrader.ts'), 'utf8');

    // Check line 125 fallback minRr
    assert.ok(
      geminiCode.includes('const minRr = input.brokerSpecs?.minRr ?? 1.0;'),
      'geminiTrader.ts must use fallback minRr ?? 1.0 at line 125'
    );

    // Check line 515 fallback minRr
    assert.ok(
      geminiCode.includes('const minRr = brokerSpecs?.minRr ?? 1.0;'),
      'geminiTrader.ts must use fallback minRr ?? 1.0 at line 515'
    );

    // Ensure no hardcoded "1.5R" remains in geminiTrader
    assert.ok(
      !geminiCode.includes('1.5R'),
      'geminiTrader.ts must NOT contain any remaining hardcoded 1.5R'
    );

    // Ensure no "RR >= 1.5" remains in geminiTrader
    assert.ok(
      !geminiCode.includes('RR >= 1.5'),
      'geminiTrader.ts must NOT contain "RR >= 1.5"'
    );

    console.log('✅ [PASS] FIX 6: All hardcoded 1.5R defaults and strings removed from geminiTrader.ts.');
  }

  console.log('\n========================================================================');
  console.log('🎉 ALL SIX CONTRADICTION FIXES VERIFIED AND PASSING SUCCESSFULLY');
  console.log('========================================================================');
}

// Auto-run if directly invoked
if (process.argv[1]?.includes('signalQualityContradictionFixes')) {
  runContradictionFixesTestSuite().catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
  });
}
