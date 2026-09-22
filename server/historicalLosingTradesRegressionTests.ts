import { validateTradeSignalCandidate } from './tradeQualityEngine.js';
import { generateMultiStrategyCandidates } from './strategyEngine.js';
import { Candle, TechnicalIndicators } from '../src/types.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  }
}

console.log('================================================================');
console.log('RUNNING HISTORICAL LOSING TRADES FORENSIC REGRESSION SUITE');
console.log('================================================================\n');

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

function createCandleArray(count: number = 20, basePrice: number = 4320): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const offset = (i % 2 === 0 ? 0.2 : -0.2);
    const p = basePrice + offset;
    return createCandle(i, p, p + 0.8, p - 0.8, p + 0.1, true);
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

// ============================================================================
// TEST 1: Trade #10021 - Double Top Reversal (M-Formation) Gating
// Verify PRE_CONFIRMATION double top (no closed neckline break) generates NO
// signal.
// ============================================================================
console.log('[TEST 1] Trade #10021 Audit: Double Top PRE_CONFIRMATION Gating');
{
  const c1h = createCandleArray(20, 4320);
  const c15m = createCandleArray(20, 4320);
  const c5m = createCandleArray(20, 4320);

  // Peak 1 at 4323.7, Neckline at 4309.1, Peak 2 at 4323.7, Price at 4319.95 (above neckline 4309.1)
  c5m[15] = createCandle(15, 4315, 4323.7, 4314, 4322.0);
  c5m[16] = createCandle(16, 4322, 4322.0, 4309.1, 4312.0);
  c5m[17] = createCandle(17, 4312, 4323.7, 4311.0, 4320.0);
  c5m[18] = createCandle(18, 4320, 4321.0, 4318.0, 4319.95);

  const ind1h: TechnicalIndicators = {
    ema20: 4310, ema50: 4325, ema200: 4340, vwap: 4315, rsi14: 45,
    macd: { macd: -1.0, signal: -0.5, histogram: -0.5 }, atr14: 4.5,
    bollingerBands: { upper: 4335, middle: 4320, lower: 4305 },
    swingHigh: 4335, swingLow: 4305, support: 4305, resistance: 4335,
    structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', structureShift: 'None',
  };
  const ind15m = { ...ind1h, atr14: 3.5 };
  const ind5m = { ...ind15m, atr14: 2.0 };

  const preBreakResult = generateMultiStrategyCandidates({
    asset: 'XAU/USD', balance: 100, currentPrice: 4319.95,
    candles5m: c5m, candles15m: c15m, candles1h: c1h,
    indicators5m: ind5m, indicators15m: ind15m, indicators1h: ind1h,
    brokerSpecs: defaultBrokerSpecs,
  });

  const candidatesPreBreak = preBreakResult.allCandidates || [];
  const doubleTopPreBreak = candidatesPreBreak.find(c => c.setupName.includes('Double Top'));
  assert(
    !doubleTopPreBreak,
    '#10021 PASS: Current logic DOES NOT generate Double Top signal when neckline (4309.02) is unbroken at entry (4319.95)'
  );
}

// ============================================================================
// TEST 2: Trade #10022 - Bare Resistance Rejection Counter-Trend Gating
// Verify counter-trend bare rejection against strong bullish HTF is rejected
// ============================================================================
console.log('\n[TEST 2] Trade #10022 Audit: Bare Resistance Rejection Counter-Trend Gating');
{
  const ind1hBullish: TechnicalIndicators = {
    ema20: 4330, ema50: 4315, ema200: 4290, vwap: 4328, rsi14: 65,
    macd: { macd: 2.0, signal: 1.2, histogram: 0.8 }, atr14: 5.0,
    bollingerBands: { upper: 4345, middle: 4325, lower: 4305 },
    swingHigh: 4345, swingLow: 4310, support: 4310, resistance: 4345,
    structure: 'BULLISH', marketRegime: 'STRONG_UPTREND', trendStructure: 'HH_HL', structureShift: 'None',
  };
  const ind15mBullish = { ...ind1hBullish, atr14: 3.5 };
  const ind5m = { ...ind15mBullish, atr14: 2.0 };

  const c1h = createCandleArray(20, 4330);
  const c15m = createCandleArray(20, 4330);
  const c5m = createCandleArray(20, 4330);

  const sellCandidateCounterTrend = {
    id: 'CAND_10022_CT',
    direction: 'SELL' as const,
    entry: 4331.89,
    stopLoss: 4336.21,
    tp1: 4309.02,
    setupName: 'Bare Resistance Rejection',
    strategyFamily: 'S/R_REJECTION' as const,
    poiPrice: 4335.41,
    poiMeta: { top: 4335.41, bottom: 4334.0, poiPrice: 4335.41, type: 'RESISTANCE' as const },
  };

  const validationCT = validateTradeSignalCandidate(sellCandidateCounterTrend, {
    currentPrice: 4331.89,
    candles5m: c5m, candles15m: c15m, candles1h: c1h,
    indicators5m: ind5m, indicators15m: ind15mBullish, indicators1h: ind1hBullish,
    brokerSpecs: defaultBrokerSpecs,
  });

  assert(
    !validationCT.isValid && (validationCT.rejectionReason || '').includes('HTF_CONTRADICTION'),
    '#10022 PASS: Counter-trend Bare Resistance Rejection against STRONG_UPTREND is REJECTED with HTF_CONTRADICTION'
  );
}

// ============================================================================
// TEST 3: Trade #10023 - Resistance Breakout & Retest Confirmation
// Verify breakout requires closed candle confirmation
// ============================================================================
console.log('\n[TEST 3] Trade #10023 Audit: Breakout & Retest Confirmation Sequence');
{
  const c1h = createCandleArray(20, 4330);
  const c15m = createCandleArray(20, 4330);
  const c5m = createCandleArray(20, 4330);

  // Unclosed forming candle spike above 4334.06
  c5m[19] = createCandle(19, 4332.0, 4338.0, 4331.5, 4333.0, false);

  const ind1h: TechnicalIndicators = {
    ema20: 4325, ema50: 4335, ema200: 4350, vwap: 4328, rsi14: 48,
    macd: { macd: -0.5, signal: -0.2, histogram: -0.3 }, atr14: 4.5,
    bollingerBands: { upper: 4345, middle: 4330, lower: 4315 },
    swingHigh: 4345, swingLow: 4315, support: 4315, resistance: 4334.06,
    structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', trendStructure: 'LH_LL', structureShift: 'None',
  };
  const ind15m = { ...ind1h, atr14: 3.5 };
  const ind5m = { ...ind15m, atr14: 2.0 };

  const formingResult = generateMultiStrategyCandidates({
    asset: 'XAU/USD', balance: 100, currentPrice: 4337.73,
    candles5m: c5m, candles15m: c15m, candles1h: c1h,
    indicators5m: ind5m, indicators15m: ind15m, indicators1h: ind1h,
    brokerSpecs: defaultBrokerSpecs,
  });

  const candidatesForming = formingResult.allCandidates || [];
  const breakoutForming = candidatesForming.find(c => c.setupName.includes('Breakout'));
  assert(
    !breakoutForming,
    '#10023 PASS: Breakout setup IS NOT generated on unclosed forming candle spikes'
  );
}

// ============================================================================
// TEST 4: Trade #10020 - Bearish Trend Continuation R:R Quality Validation
// Verify trend continuation setups require R:R >= 1.0R
// ============================================================================
console.log('\n[TEST 4] Trade #10020 Audit: Trend Continuation R:R Safety');
{
  const c1h = createCandleArray(20, 4340);
  const c15m = createCandleArray(20, 4340);
  const c5m = createCandleArray(20, 4340);

  const ind1h: TechnicalIndicators = {
    ema20: 4340, ema50: 4342, ema200: 4345, vwap: 4341, rsi14: 50,
    macd: { macd: 0.1, signal: 0.1, histogram: 0.0 }, atr14: 4.5,
    bollingerBands: { upper: 4355, middle: 4340, lower: 4325 },
    swingHigh: 4355, swingLow: 4325, support: 4325, resistance: 4355,
    structure: 'NEUTRAL', marketRegime: 'NORMAL_RANGE', trendStructure: 'RANGING', structureShift: 'None',
  };
  const ind15m = { ...ind1h, atr14: 3.5 };
  const ind5m = { ...ind15m, atr14: 2.0 };

  const lowRrCandidate = {
    id: 'CAND_10020_LOW_RR',
    direction: 'SELL' as const,
    entry: 4344.68,
    stopLoss: 4349.19, // 4.51 pts SL
    tp1: 4342.00,      // 2.68 pts TP1 -> 0.59R
    setupName: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
    strategyFamily: 'TREND_CONTINUATION' as const,
    poiPrice: 4345.0,
    poiMeta: { top: 4346.0, bottom: 4344.0, poiPrice: 4345.0, type: 'EMA_VWAP' as const },
  };

  const validationLowRr = validateTradeSignalCandidate(lowRrCandidate, {
    currentPrice: 4344.68,
    candles5m: c5m, candles15m: c15m, candles1h: c1h,
    indicators5m: ind5m, indicators15m: ind15m, indicators1h: ind1h,
    brokerSpecs: defaultBrokerSpecs,
  });

  assert(
    !validationLowRr.isValid && (validationLowRr.rejectionReason || '').includes('INSUFFICIENT_RR'),
    '#10020 PASS: Candidate with R:R < 1.0R is REJECTED as INSUFFICIENT_RR'
  );
}

// ============================================================================
// TEST 5: AI Confidence Bypass Immunity
// Verify high AI confidence (e.g. 95%) CANNOT bypass deterministic safety gates
// ============================================================================
console.log('\n[TEST 5] AI Confidence Bypass Immunity');
{
  const ind1hBullish: TechnicalIndicators = {
    ema20: 4330, ema50: 4315, ema200: 4290, vwap: 4328, rsi14: 68,
    macd: { macd: 2.5, signal: 1.5, histogram: 1.0 }, atr14: 5.0,
    bollingerBands: { upper: 4350, middle: 4325, lower: 4300 },
    swingHigh: 4350, swingLow: 4300, support: 4300, resistance: 4350,
    structure: 'BULLISH', marketRegime: 'STRONG_UPTREND', trendStructure: 'HH_HL', structureShift: 'None',
  };
  const ind15mBullish = { ...ind1hBullish, atr14: 3.5 };
  const ind5m = { ...ind15mBullish, atr14: 2.0 };

  const c1h = createCandleArray(20, 4330);
  const c15m = createCandleArray(20, 4330);
  const c5m = createCandleArray(20, 4330);

  const highConfidenceAiCandidate = {
    id: 'AI_HIGH_CONF_SELL_01',
    direction: 'SELL' as const,
    entry: 4330.0,
    stopLoss: 4334.5,
    tp1: 4315.0,
    setupName: 'AI Model Double Top S/R Rejection',
    strategyFamily: 'AI_DEEP_SEEK' as const,
    confidence: 95, // 95% AI confidence!
    poiPrice: 4332.0,
    poiMeta: { top: 4333.0, bottom: 4331.0, poiPrice: 4332.0, type: 'RESISTANCE' as const },
  };

  const validation = validateTradeSignalCandidate(highConfidenceAiCandidate, {
    currentPrice: 4330.0,
    candles5m: c5m, candles15m: c15m, candles1h: c1h,
    indicators5m: ind5m, indicators15m: ind15mBullish, indicators1h: ind1hBullish,
    brokerSpecs: defaultBrokerSpecs,
  });

  assert(
    !validation.isValid && (validation.rejectionReason || '').includes('HTF_CONTRADICTION'),
    'TEST 5 PASS: 95% AI Confidence CANNOT bypass deterministic HTF_CONTRADICTION safety gate'
  );
}

console.log('\n================================================================');
console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
}
