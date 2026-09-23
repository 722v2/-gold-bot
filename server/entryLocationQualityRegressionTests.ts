import { assessEntryLocationQuality } from './entryLocationQuality.js';
import { validateTradeSignalCandidate } from './tradeQualityEngine.js';
import { Candle, TechnicalIndicators, StrategyFamily } from '../src/types.js';

console.log('================================================================');
console.log('    ENTRY LOCATION QUALITY (ELQ) REGRESSION TEST SUITE          ');
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
const createClosedCandle = (
  i: number,
  open: number,
  high: number,
  low: number,
  close: number
): Candle => ({
  timestamp: now + i * 300000,
  open,
  high,
  low,
  close,
  volume: 1000,
  isClosed: true,
});

function createCandles(count: number, basePrice: number = 4345.0): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const p = basePrice + (i % 2 === 0 ? 0.2 : -0.2);
    return createClosedCandle(i, p, p + 0.8, p - 0.8, p + 0.1);
  });
}

function createBaseIndicators(overrides: Partial<TechnicalIndicators> = {}): TechnicalIndicators {
  return {
    ema20: 4345.0,
    ema50: 4340.0,
    ema200: 4320.0,
    vwap: 4344.0,
    rsi14: 50,
    macd: { macd: 0.2, signal: 0.1, histogram: 0.1 },
    atr14: 3.0,
    bollingerBands: { upper: 4365, middle: 4345, lower: 4325 },
    swingHigh: 4380.0,
    swingLow: 4310.0,
    support: 4310.0,
    resistance: 4380.0,
    structure: 'BULLISH',
    marketRegime: 'STRONG_UPTREND',
    premiumDiscountZone: 'DISCOUNT',
    ...overrides,
  };
}

// ============================================================================
// TEST 1: Major Terminal Boundary Hard Block (Distance < 0.40 ATR)
// Context: BUY entry at 4348.0, 1H major resistance at 4349.0 (distance 1.0 pt = 0.33 ATR < 0.40 ATR)
// Expected: BLOCKED with TERMINAL_BOUNDARY_TOO_CLOSE
// ============================================================================
{
  const c5m = createCandles(20, 4345.0);
  const ind1h = createBaseIndicators({ resistance: 4349.0 }); // 1 pt above entry (0.33 ATR)
  const ind15m = createBaseIndicators({ resistance: 4350.0 });
  const ind5m = createBaseIndicators({ atr14: 3.0 });

  const elq = assessEntryLocationQuality({
    direction: 'BUY',
    family: 'MARKET_STRUCTURE',
    entry: 4348.0,
    currentPrice: 4348.0,
    candles5m: c5m,
    indicators5m: ind5m,
    indicators15m: ind15m,
    indicators1h: ind1h,
    setupName: 'Bullish Trend Continuation',
  });

  assert(
    elq.hardBlocked && elq.classification === 'EXHAUSTED' && elq.rejectionReason?.includes('TERMINAL_BOUNDARY_TOO_CLOSE'),
    'TEST 1: Major Terminal Boundary Hard Block (< 0.40 ATR) - MUST BE BLOCKED',
    `hardBlocked=${elq.hardBlocked}, reason=${elq.rejectionReason}, distAtr=${elq.terminalBoundaryDistanceAtr}`
  );
}

// ============================================================================
// TEST 2: Terminal Boundary Safe Runway (Distance >= 1.20 ATR)
// Context: BUY entry at 4345.0, 15M resistance at 4360.0 (distance 15 pts = 5.0 ATR >= 1.2 ATR)
// Expected: NOT hard blocked by terminal boundary
// ============================================================================
{
  const c5m = createCandles(20, 4345.0);
  const ind1h = createBaseIndicators({ resistance: 4380.0 });
  const ind15m = createBaseIndicators({ resistance: 4360.0 });
  const ind5m = createBaseIndicators({ atr14: 3.0 });

  const elq = assessEntryLocationQuality({
    direction: 'BUY',
    family: 'MARKET_STRUCTURE',
    entry: 4345.0,
    currentPrice: 4345.0,
    candles5m: c5m,
    indicators5m: ind5m,
    indicators15m: ind15m,
    indicators1h: ind1h,
    setupName: 'Bullish Trend Continuation',
  });

  assert(
    !elq.hardBlocked && elq.terminalBoundaryDistanceAtr >= 1.2,
    'TEST 2: Terminal Boundary Safe Runway (>= 1.20 ATR) - MUST BE ALLOWED',
    `hardBlocked=${elq.hardBlocked}, reason=${elq.rejectionReason}, distAtr=${elq.terminalBoundaryDistanceAtr}`
  );
}

// ============================================================================
// TEST 3: Breakout / Retest Chase Hard Block (> 1.0 ATR)
// Context: BUY Breakout Retest, brokenLevel = 4340.0, entry = 4344.0 (displacement 4.0 pts = 1.33 ATR > 1.0 ATR)
// Expected: BLOCKED with BREAKOUT_RETEST_CHASED
// ============================================================================
{
  const c5m = createCandles(20, 4342.0);
  const ind1h = createBaseIndicators();
  const ind15m = createBaseIndicators();
  const ind5m = createBaseIndicators({ atr14: 3.0 });

  const elq = assessEntryLocationQuality({
    direction: 'BUY',
    family: 'BREAK_AND_RETEST',
    entry: 4344.0,
    currentPrice: 4344.0,
    candles5m: c5m,
    indicators5m: ind5m,
    indicators15m: ind15m,
    indicators1h: ind1h,
    explicitRetestLevel: 4340.0, // 4.0 pts / 3.0 ATR = 1.33 ATR
    setupName: 'Horizontal Resistance Breakout & Retest',
  });

  assert(
    elq.hardBlocked && (elq.classification === 'LATE' || (elq.classification as any) === 'CHASED') && elq.rejectionReason?.includes('BREAKOUT_RETEST_CHASE'),
    'TEST 3: Breakout & Retest Chase (> 1.0 ATR) - MUST BE BLOCKED',
    `hardBlocked=${elq.hardBlocked}, classification=${elq.classification}, reason=${elq.rejectionReason}, retestAtr=${elq.retestDisplacementAtr}`
  );
}

// ============================================================================
// TEST 4: Breakout / Retest Clean Entry (<= 1.0 ATR)
// Context: BUY Breakout Retest, brokenLevel = 4340.0, entry = 4341.5 (displacement 1.5 pts = 0.50 ATR <= 1.0 ATR)
// Expected: NOT hard blocked
// ============================================================================
{
  const c5m = createCandles(20, 4341.0);
  const ind1h = createBaseIndicators();
  const ind15m = createBaseIndicators();
  const ind5m = createBaseIndicators({ atr14: 3.0 });

  const elq = assessEntryLocationQuality({
    direction: 'BUY',
    family: 'BREAK_AND_RETEST',
    entry: 4341.5,
    currentPrice: 4341.5,
    candles5m: c5m,
    indicators5m: ind5m,
    indicators15m: ind15m,
    indicators1h: ind1h,
    explicitRetestLevel: 4340.0,
    setupName: 'Horizontal Resistance Breakout & Retest',
  });

  assert(
    !elq.hardBlocked && (elq.classification === 'PULLBACK_ACCEPTABLE' || elq.classification === 'PULLBACK_OPTIMAL'),
    'TEST 4: Breakout & Retest Clean Entry (<= 1.0 ATR) - MUST BE ALLOWED',
    `hardBlocked=${elq.hardBlocked}, classification=${elq.classification}, retestAtr=${elq.retestDisplacementAtr}`
  );
}

// ============================================================================
// TEST 5: Impulse Exhaustion Hard Block
// Context: BUY Trend Continuation after 5 uninterrupted directional bullish candles expanding 12 pts (4.0 ATR > 3.5 ATR) without a 2-bar pullback
// Expected: BLOCKED with LATE_EXHAUSTED_ENTRY
// ============================================================================
{
  const c5m = createCandles(15, 4330.0);
  // Add 5 consecutive bullish candles
  c5m.push(createClosedCandle(15, 4330.0, 4333.0, 4329.5, 4332.5));
  c5m.push(createClosedCandle(16, 4332.5, 4335.5, 4332.0, 4335.0));
  c5m.push(createClosedCandle(17, 4335.0, 4338.0, 4334.5, 4337.5));
  c5m.push(createClosedCandle(18, 4337.5, 4340.5, 4337.0, 4340.0));
  c5m.push(createClosedCandle(19, 4340.0, 4343.0, 4339.5, 4342.5)); // +12.5 pts extension

  const ind1h = createBaseIndicators({ resistance: 4380.0 });
  const ind15m = createBaseIndicators({ resistance: 4380.0 });
  const ind5m = createBaseIndicators({ atr14: 3.0 });

  const elq = assessEntryLocationQuality({
    direction: 'BUY',
    family: 'MARKET_STRUCTURE',
    entry: 4342.5,
    currentPrice: 4342.5,
    candles5m: c5m,
    indicators5m: ind5m,
    indicators15m: ind15m,
    indicators1h: ind1h,
    setupName: 'Bullish Trend Continuation',
  });

  assert(
    elq.hardBlocked && elq.classification === 'EXHAUSTED' && elq.rejectionReason?.includes('LATE_EXHAUSTED_ENTRY'),
    'TEST 5: Impulse Exhaustion (5 consecutive bars, 4.17 ATR extension, 0 pullback) - MUST BE BLOCKED',
    `hardBlocked=${elq.hardBlocked}, reason=${elq.rejectionReason}, bars=${elq.consecutiveDirectionalBars}, ext=${elq.impulseExtensionAtr}`
  );
}

// ============================================================================
// TEST 6: Legitimate Fresh Pullback (has 2-bar corrective pullback)
// Context: BUY Trend Continuation with clean 2-bar pullback to support before resumption
// Expected: ALLOWED with PULLBACK_OPTIMAL or PULLBACK_ACCEPTABLE
// ============================================================================
{
  const c5m = createCandles(15, 4340.0);
  // Impulse up
  c5m.push(createClosedCandle(15, 4340.0, 4345.0, 4339.5, 4344.0));
  // 2-bar corrective pullback (bearish bars)
  c5m.push(createClosedCandle(16, 4344.0, 4344.5, 4341.5, 4342.0));
  c5m.push(createClosedCandle(17, 4342.0, 4342.5, 4340.0, 4340.5));
  // Bullish reversal trigger
  c5m.push(createClosedCandle(18, 4340.5, 4341.0, 4339.0, 4340.8));
  c5m.push(createClosedCandle(19, 4340.8, 4344.0, 4340.0, 4343.5));

  const ind1h = createBaseIndicators({ resistance: 4380.0 });
  const ind15m = createBaseIndicators({ resistance: 4380.0 });
  const ind5m = createBaseIndicators({ atr14: 3.0 });

  const elq = assessEntryLocationQuality({
    direction: 'BUY',
    family: 'MARKET_STRUCTURE',
    entry: 4343.5,
    currentPrice: 4343.5,
    candles5m: c5m,
    indicators5m: ind5m,
    indicators15m: ind15m,
    indicators1h: ind1h,
    setupName: 'Bullish Trend Continuation (EMA/VWAP Pullback)',
  });

  assert(
    !elq.hardBlocked && (elq.classification === 'PULLBACK_OPTIMAL' || elq.classification === 'PULLBACK_ACCEPTABLE'),
    'TEST 6: Legitimate Fresh Pullback (2-bar corrective pullback) - MUST BE ALLOWED',
    `hardBlocked=${elq.hardBlocked}, classification=${elq.classification}, correctiveBars=${elq.correctiveBars}`
  );
}

// ============================================================================
// TEST 7: Inside Opposing POI Structure
// Context: BUY entered inside opposing 15M Bearish Order Block (4344 - 4350)
// Expected: BLOCKED with TERMINAL_BOUNDARY_TOO_CLOSE (distance 0 ATR)
// ============================================================================
{
  const c5m = createCandles(20, 4345.0);
  const ind1h = createBaseIndicators({ resistance: 4380.0 });
  const ind15m = createBaseIndicators({
    resistance: 4380.0,
    orderBlock: { type: 'BEARISH', high: 4350.0, low: 4344.0 }, // Opposing zone around 4346
  });
  const ind5m = createBaseIndicators({ atr14: 3.0 });

  const elq = assessEntryLocationQuality({
    direction: 'BUY',
    family: 'MARKET_STRUCTURE',
    entry: 4346.0,
    currentPrice: 4346.0,
    candles5m: c5m,
    indicators5m: ind5m,
    indicators15m: ind15m,
    indicators1h: ind1h,
    setupName: 'Bullish Trend Continuation',
  });

  assert(
    elq.hardBlocked && elq.terminalBoundaryDistanceAtr === 0,
    'TEST 7: Inside Opposing POI Structure - MUST BE BLOCKED',
    `hardBlocked=${elq.hardBlocked}, reason=${elq.rejectionReason}, distAtr=${elq.terminalBoundaryDistanceAtr}`
  );
}

// ============================================================================
// TEST 8: Full Pipeline validateTradeSignalCandidate Integration & AI Immunity
// Context: 99% AI confidence candidate entering < 0.4 ATR from major 1H opposing resistance
// Expected: Deterministic rejection through validateTradeSignalCandidate
// ============================================================================
{
  const c5m = createCandles(20, 4345.0);
  c5m[18] = createClosedCandle(18, 4345.0, 4345.5, 4341.0, 4342.0);
  c5m[19] = createClosedCandle(19, 4342.0, 4346.0, 4341.0, 4345.0); // closed bottom rejection

  const ind1h = createBaseIndicators({ structure: 'BULLISH', marketRegime: 'STRONG_UPTREND', resistance: 4346.0 }); // 1 pt (0.33 ATR) from entry
  const ind15m = createBaseIndicators({
    structure: 'BULLISH',
    marketRegime: 'STRONG_UPTREND',
    resistance: 4347.0,
  });
  const ind5m = createBaseIndicators({ atr14: 3.0 });

  const aiCandidate = {
    setupName: 'Bullish Trend Continuation (AI Recommended)',
    strategyFamily: 'MARKET_STRUCTURE' as StrategyFamily,
    direction: 'BUY' as const,
    entry: 4345.0,
    stopLoss: 4341.0,
    tp1: 4355.0,
    confidence: 99, // 99% AI Confidence
    poiPrice: 4344.0,
  };

  const validation = validateTradeSignalCandidate(aiCandidate, {
    currentPrice: 4345.0,
    candles5m: c5m,
    candles15m: createCandles(20, 4345.0),
    candles1h: createCandles(20, 4345.0),
    indicators5m: ind5m,
    indicators15m: ind15m,
    indicators1h: ind1h,
  });

  assert(
    !validation.isValid && validation.rejectionReason?.includes('TERMINAL_BOUNDARY_TOO_CLOSE'),
    'TEST 8: Full Pipeline AI Immunity (99% confidence cannot bypass ELQ hard block)',
    `isValid=${validation.isValid}, rejectionReason=${validation.rejectionReason}`
  );
}

// ============================================================================
// TEST 9: Breakout/Retest Pipeline validateTradeSignalCandidate Integration
// Context: Breakout & Retest candidate with retestDisplacement > 1.0 ATR
// Expected: Rejected by validateTradeSignalCandidate
// ============================================================================
{
  const c5m = createCandles(20, 4345.0);
  c5m[18] = createClosedCandle(18, 4345.0, 4345.5, 4341.0, 4342.0);
  c5m[19] = createClosedCandle(19, 4342.0, 4346.0, 4341.0, 4345.0);

  const ind1h = createBaseIndicators({ structure: 'BULLISH', marketRegime: 'STRONG_UPTREND', resistance: 4390.0 });
  const ind15m = createBaseIndicators({ structure: 'BULLISH', marketRegime: 'STRONG_UPTREND', resistance: 4390.0 });
  const ind5m = createBaseIndicators({ atr14: 3.0 });

  const breakoutCandidate = {
    setupName: 'Horizontal Resistance Breakout & Retest',
    strategyFamily: 'BREAK_AND_RETEST' as StrategyFamily,
    direction: 'BUY' as const,
    entry: 4345.0,
    stopLoss: 4341.0,
    tp1: 4355.0,
    confidence: 88,
    patternMetadata: {
      brokenLevel: 4340.0, // Retest displacement = 5.0 pts / 3.0 = 1.67 ATR > 1.0 ATR
    },
  };

  const validation = validateTradeSignalCandidate(breakoutCandidate, {
    currentPrice: 4345.0,
    candles5m: c5m,
    candles15m: createCandles(20, 4345.0),
    candles1h: createCandles(20, 4345.0),
    indicators5m: ind5m,
    indicators15m: ind15m,
    indicators1h: ind1h,
  });

  assert(
    !validation.isValid && validation.rejectionReason?.includes('BREAKOUT_RETEST_CHASE'),
    'TEST 9: Breakout & Retest Chased Pipeline Enforcement (> 1.0 ATR displacement)',
    `isValid=${validation.isValid}, rejectionReason=${validation.rejectionReason}`
  );
}

console.log('\n================================================================');
console.log(`SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED`);
console.log('================================================================');

if (failedTests > 0) {
  process.exit(1);
}
