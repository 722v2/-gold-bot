import assert from 'node:assert';
import { partition5mCandles, getClosed5mCandleForTrigger } from '../server/candleUtils.js';
import { assessPriceActionTrigger } from '../server/tradeQualityEngine.js';
import { calculateDynamicTakeProfits } from '../server/tpEngine.js';
import { evaluateTradeRisk } from '../server/riskManager.js';
import { TechnicalIndicators, Candle } from '../src/types.js';

function buildMockCandle(timestamp: number, open: number, high: number, low: number, close: number, volume = 1000, isClosed?: boolean): Candle {
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

export async function runSignalQualityFixesSuite() {
  console.log('========================================================================');
  console.log('🧪 RUNNING SIGNAL-QUALITY FIXES TEST SUITE (FIXES 1 TO 5)');
  console.log('========================================================================');

  // =========================================================================
  // FIX 1: CLOSED 5M CANDLE REQUIREMENT
  // =========================================================================
  console.log('\n--- Testing FIX 1: Closed 5M Candle Requirement ---');
  {
    // Test 1.1: Partitioning isolates forming candle from closed candle
    const fiveMinMs = 5 * 60 * 1000;
    const now = 1710000120000; // 2 minutes into a 5-minute candle
    const closedCandleTime = 1710000000000 - fiveMinMs; // Prior 5M window
    const formingCandleTime = 1710000000000; // Current forming 5M window

    const candles: Candle[] = [
      buildMockCandle(closedCandleTime - fiveMinMs, 2640, 2642, 2639, 2641),
      buildMockCandle(closedCandleTime, 2641, 2646, 2640, 2645), // Bullish closed
      buildMockCandle(formingCandleTime, 2645, 2646, 2638, 2638), // Bearish forming!
    ];

    const partition = partition5mCandles(candles, now);
    assert.strictEqual(partition.isValid, true, 'Partitioning should be reliable with valid timestamps');
    assert.ok(partition.lastClosedCandle !== null, 'Last closed candle must not be null');
    assert.strictEqual(partition.lastClosedCandle?.timestamp, closedCandleTime, 'Last closed candle must be the completed candle, not forming');
    assert.strictEqual(partition.formingCandle?.timestamp, formingCandleTime, 'Forming candle correctly identified');

    // Test 1.2: Trigger evaluation uses closed candle, never forming candle
    // The forming candle has a bearish drop, but closed candle was bullish expansion/engulfing.
    // Price action trigger should assess the closed candle!
    const triggerResult = assessPriceActionTrigger('BUY', candles, [], buildMockIndicators(), now);
    assert.strictEqual(triggerResult.hasTrigger, true, 'Bullish trigger should be detected from the closed candle');
    assert.ok(triggerResult.description.includes('Confirmed on closed 5M candle'), 'Trigger must explicitly specify confirmation on closed 5M candle');
    console.log('✅ [PASS] 1.1 & 1.2: Forming candle isolated; trigger confirmed ONLY on closed 5M candle.');

    // Test 1.3: Ambiguous candle timestamps without isClosed flag returns NO TRADE (not guessed)
    const ambiguousCandles: Candle[] = [
      buildMockCandle(0, 2640, 2645, 2640, 2645), // Invalid timestamp 0
    ];
    const ambiguousPartition = partition5mCandles(ambiguousCandles, now);
    assert.strictEqual(ambiguousPartition.isValid, false, 'Should be unreliable when timestamps cannot determine closure');
    const safeTrigger = assessPriceActionTrigger('BUY', ambiguousCandles, [], buildMockIndicators(), now);
    assert.strictEqual(safeTrigger.hasTrigger, false, 'Must return NO TRIGGER if closed state cannot be reliably confirmed');
    console.log('✅ [PASS] 1.3: Unreliable candle closure returns NO TRIGGER instead of guessing.');

    // Test 1.4: Explicit isClosed flag is respected
    const explicitCandles: Candle[] = [
      buildMockCandle(1000, 2640, 2642, 2639, 2641, 1000, true),
      buildMockCandle(2000, 2641, 2646, 2640, 2645, 1000, true), // Closed
      buildMockCandle(3000, 2645, 2650, 2645, 2649, 1000, false), // Explicitly forming
    ];
    const explicitClosed = getClosed5mCandleForTrigger(explicitCandles);
    assert.strictEqual(explicitClosed?.timestamp, 2000, 'Explicit isClosed=true takes precedence over forming candle');
    console.log('✅ [PASS] 1.4: Explicit isClosed flag correctly honored.');
  }

  // =========================================================================
  // FIX 2: REAL STRUCTURAL TP CANDIDATES & BB OUTRANKED
  // =========================================================================
  console.log('\n--- Testing FIX 2: Real Structural TP Candidates & BB Fallback ---');
  {
    // Test 2.1: Opposing Order Blocks and FVGs are prioritized
    const entry = 2650.00;
    const stopLoss = 2645.00; // SL = 5.00
    const indicators15m = buildMockIndicators({
      orderBlock: {
        type: 'BEARISH',
        high: 2657.00,
        low: 2656.00, // 6.00 pts ahead = 1.20R
      },
      // Bollinger Band is at 2654.00 (closer and lower R:R), but BB is NOT structural!
      bollingerBands: { upper: 2654.00, middle: 2650, lower: 2640 },
    });
    const indicators5m = buildMockIndicators({
      bollingerBands: { upper: 2654.00, middle: 2650, lower: 2640 },
    });

    const result = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h: buildMockIndicators(),
      indicators15m,
      indicators5m,
      candles1h: [],
      candles15m: [],
      candles5m: [],
      minRr: 1.0,
    });

    assert.strictEqual(result.valid, true);
    // Structural OB at 2656 MUST outrank Bollinger Bands even though BB is at 2654
    assert.strictEqual(result.tp1, 2656.00, 'TP1 must select genuine structural Order Block over non-structural Bollinger Band');
    assert.strictEqual(result.tp1IsStructural, true, 'TP1 must be flagged as structural');
    assert.ok(result.tp1TargetName.includes('Order Block'), 'Target name must reflect Order Block');
    console.log('✅ [PASS] 2.1: Genuine structural OB correctly outranks non-structural Bollinger Bands.');

    // Test 2.2: Support and Resistance levels as structural targets
    const sellEntry = 2650.00;
    const sellSl = 2655.00; // SL = 5.00
    const sellIndicators = buildMockIndicators({
      support: 2644.00, // 6.00 pts = 1.20R
      bollingerBands: { lower: 2646.00, middle: 2650, upper: 2660 }, // BB closer
    });

    const sellResult = calculateDynamicTakeProfits({
      direction: 'SELL',
      entry: sellEntry,
      stopLoss: sellSl,
      asset: 'XAU/USD',
      indicators1h: buildMockIndicators(),
      indicators15m: sellIndicators,
      indicators5m: sellIndicators,
      candles1h: [],
      candles15m: [],
      candles5m: [],
      minRr: 1.0,
    });

    assert.strictEqual(sellResult.valid, true);
    assert.strictEqual(sellResult.tp1, 2644.00, 'SELL TP1 must select Support Level over Bollinger Bands');
    assert.strictEqual(sellResult.tp1IsStructural, true);
    console.log('✅ [PASS] 2.2: Support & Resistance levels selected as genuine structural targets.');
  }

  // =========================================================================
  // FIX 3: TP2 HANDLING & GEOMETRY
  // =========================================================================
  console.log('\n--- Testing FIX 3: TP2 Handling & Geometry ---');
  {
    // Test 3.1: BUY: TP2 > TP1 > Entry strictly maintained
    const entry = 2650.00;
    const stopLoss = 2645.00;
    const indicators5m = buildMockIndicators({
      swingHigh: 2656.00, // TP1 (1.20R)
      resistance: 2662.00, // TP2 (2.40R)
    });

    const result = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry,
      stopLoss,
      asset: 'XAU/USD',
      indicators1h: indicators5m,
      indicators15m: indicators5m,
      indicators5m,
      candles1h: [],
      candles15m: [],
      candles5m: [],
      minRr: 1.0,
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.tp1, 2656.00);
    assert.strictEqual(result.tp2, 2662.00);
    assert.strictEqual(result.hasValidTp2, true);
    assert.ok(result.tp2 > result.tp1 && result.tp1 > entry, 'BUY geometry must satisfy TP2 > TP1 > Entry');
    console.log('✅ [PASS] 3.1: BUY TP2 geometry satisfied: TP2 (2662) > TP1 (2656) > Entry (2650).');

    // Test 3.2: SELL: TP2 < TP1 < Entry strictly maintained
    const sellIndicators = buildMockIndicators({ swingLow: 2644.00, support: 2638.00 });
    const sellResult = calculateDynamicTakeProfits({
      direction: 'SELL',
      entry: 2650.00,
      stopLoss: 2655.00,
      asset: 'XAU/USD',
      indicators1h: sellIndicators,
      indicators15m: sellIndicators,
      indicators5m: sellIndicators,
      candles1h: [],
      candles15m: [],
      candles5m: [],
      minRr: 1.0,
    });

    assert.strictEqual(sellResult.valid, true);
    assert.strictEqual(sellResult.tp1, 2644.00);
    assert.strictEqual(sellResult.tp2, 2638.00);
    assert.strictEqual(sellResult.hasValidTp2, true);
    assert.ok(sellResult.tp2 < sellResult.tp1 && sellResult.tp1 < 2650.00, 'SELL geometry must satisfy TP2 < TP1 < Entry');
    console.log('✅ [PASS] 3.2: SELL TP2 geometry satisfied: TP2 (2638) < TP1 (2644) < Entry (2650).');

    // Test 3.3: If no second structural target exists, do NOT set TP2 = TP1, do NOT invent fake huge target
    const singleTargetIndicators = buildMockIndicators({
      swingHigh: 2656.00, // Only 1 structural target
      resistance: 2656.00,
      orderBlock: undefined,
      fvg: undefined,
      liquidityLevels: undefined,
    });

    const singleResult = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry: 2650.00,
      stopLoss: 2645.00,
      asset: 'XAU/USD',
      indicators1h: singleTargetIndicators,
      indicators15m: singleTargetIndicators,
      indicators5m: singleTargetIndicators,
      candles1h: [],
      candles15m: [],
      candles5m: [],
      minRr: 1.0,
    });

    assert.strictEqual(singleResult.valid, true);
    assert.strictEqual(singleResult.tp1, 2656.00);
    assert.strictEqual(singleResult.hasValidTp2, false, 'hasValidTp2 must be false when no second structural target exists');
    assert.strictEqual(singleResult.tp2, 0, 'TP2 must be 0 (clearly invalid state), NOT equal to TP1, NOT a fake huge number');
    assert.notStrictEqual(singleResult.tp2, singleResult.tp1, 'TP2 must NOT be set equal to TP1');
    console.log('✅ [PASS] 3.3: No second structural target correctly sets tp2 = 0 and hasValidTp2 = false (not equal to TP1).');

    // Test 3.4: Downstream risk manager handles tp2 = 0 safely as a single-target trade
    const riskCheck = evaluateTradeRisk({
      balance: 10,
      entry: 2650.00,
      stopLoss: 2645.00,
      tp1: 2656.00,
      tp2: 0, // No second target
      confidence: 85,
      direction: 'BUY',
    });
    assert.strictEqual(riskCheck.valid, true, 'Single target trade with tp2=0 must be accepted safely by riskManager');
    console.log('✅ [PASS] 3.4: Single target trade (tp2=0) accepted cleanly by risk manager.');
  }

  // =========================================================================
  // FIX 4 & 5: NATURAL R:R AS OUTPUT METRIC & BUY/SELL SYMMETRY
  // =========================================================================
  console.log('\n--- Testing FIX 4 & 5: Natural R:R Output & Symmetry ---');
  {
    // Test 4.1: Genuine structural target around 1.10R is valid without stretching
    const buyResult = calculateDynamicTakeProfits({
      direction: 'BUY',
      entry: 2650.00,
      stopLoss: 2645.00, // 5.00 SL
      asset: 'XAU/USD',
      indicators1h: buildMockIndicators(),
      indicators15m: buildMockIndicators({ swingHigh: 2655.50 }), // 5.50 pts = 1.10R
      indicators5m: buildMockIndicators({ swingHigh: 2655.50 }),
      candles1h: [],
      candles15m: [],
      candles5m: [],
      minRr: 1.0,
    });

    assert.strictEqual(buyResult.valid, true);
    assert.strictEqual(buyResult.tp1, 2655.50);
    assert.strictEqual(buyResult.tp1Rr, 1.10);
    console.log('✅ [PASS] 4.1: Natural 1.10R structural target valid without stretching.');

    // Test 5.1: Mathematical BUY/SELL Symmetry
    const sellResult = calculateDynamicTakeProfits({
      direction: 'SELL',
      entry: 2650.00,
      stopLoss: 2655.00, // 5.00 SL
      asset: 'XAU/USD',
      indicators1h: buildMockIndicators(),
      indicators15m: buildMockIndicators({ swingLow: 2644.50 }), // 5.50 pts = 1.10R
      indicators5m: buildMockIndicators({ swingLow: 2644.50 }),
      candles1h: [],
      candles15m: [],
      candles5m: [],
      minRr: 1.0,
    });

    assert.strictEqual(sellResult.valid, true);
    assert.strictEqual(sellResult.tp1, 2644.50);
    assert.strictEqual(sellResult.tp1Rr, 1.10);
    assert.strictEqual(buyResult.tp1Distance, sellResult.tp1Distance, 'BUY and SELL distance must be identical (5.50 pts)');
    assert.strictEqual(buyResult.tp1Rr, sellResult.tp1Rr, 'BUY and SELL R:R must be identical (1.10R)');
    console.log('✅ [PASS] 5.1: Strict BUY/SELL symmetry verified.');
  }

  console.log('\n========================================================================');
  console.log('🎉 ALL SIGNAL-QUALITY FIXES (FIX 1 TO 5) VERIFIED SUCCESSFULLY');
  console.log('========================================================================\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSignalQualityFixesSuite()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Test suite failed:', err);
      process.exit(1);
    });
}
