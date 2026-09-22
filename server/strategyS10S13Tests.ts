import { generateMultiStrategyCandidates } from './strategyEngine.js';
import { analyzeTechnicals, detectDoubleTopBottom } from './indicators.js';
import { globalPoiTracker } from './tradeQualityEngine.js';
import { Candle } from '../src/types.js';

function createRampCandles(
  count: number,
  startPrice: number,
  endPrice: number
): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now() - count * 5 * 60 * 1000;
  const step = (endPrice - startPrice) / Math.max(1, count - 1);

  for (let i = 0; i < count; i++) {
    const timestamp = now + i * 5 * 60 * 1000;
    const open = startPrice + i * step;
    const close = open + step * 0.8;
    const high = Math.max(open, close) + 1.2;
    const low = Math.min(open, close) - 1.2;

    candles.push({
      timestamp,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: 1500,
      isClosed: true,
    });
  }
  return candles;
}

async function runS10S13TestSuite() {
  console.log('================================================================');
  console.log('GOLD AI TRADING SYSTEM — S10-S13 STRATEGY EXPANSION AUDIT & TEST');
  console.log('================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, message: string) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`  ✅ [PASS] ${message}`);
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // TEST 1: S10 Double Top (M-Formation) Reversal Candidate Detection
  // ---------------------------------------------------------------------------
  console.log('TEST 1: S10 Double Top (M-Formation) Reversal candidate detection');
  {
    globalPoiTracker.setPois([]);

    const candles1h = createRampCandles(50, 4270.00, 4295.00);
    candles1h[10] = { ...candles1h[10], low: 4250.00 }; // deep session low for target

    const candles15m = createRampCandles(50, 4275.00, 4295.00);

    // 5M candles with clean Double Top peaks
    const candles5m = createRampCandles(40, 4275.00, 4290.00);
    // Peak 1 at index 15 ($4294.50)
    candles5m[15] = { timestamp: candles5m[15].timestamp, open: 4291.00, high: 4294.50, low: 4290.00, close: 4293.00, volume: 2000, isClosed: true };
    // Dip to Neckline at index 22 ($4280.00)
    candles5m[22] = { timestamp: candles5m[22].timestamp, open: 4282.00, high: 4282.50, low: 4280.00, close: 4280.50, volume: 1500, isClosed: true };
    // Peak 2 at index 33 ($4294.30)
    candles5m[33] = { timestamp: candles5m[33].timestamp, open: 4289.00, high: 4294.30, low: 4288.00, close: 4292.00, volume: 2500, isClosed: true };
    // Last candle rejecting down from Peak 2
    const lastIdx = candles5m.length - 1;
    candles5m[lastIdx] = { timestamp: candles5m[lastIdx].timestamp, open: 4291.00, high: 4292.50, low: 4289.00, close: 4290.00, volume: 2800, isClosed: true };

    const ind5m = analyzeTechnicals(candles5m);
    const ind15m = analyzeTechnicals(candles15m);
    const ind1h = analyzeTechnicals(candles1h);

    ind15m.swingHigh = 4294.50;
    ind15m.swingLow = 4250.00;
    ind15m.support = 4250.00;
    ind15m.ema200 = 4350.00;

    const result = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 4290.00,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h,
      candles15m,
      candles5m,
    });

    const s10Cand = result.allCandidates.find((c) => c.strategyFamily === 'DOUBLE_TOP_BOTTOM');
    assert(s10Cand !== undefined, 'S10 Double Top candidate generated when pattern exists');
    if (s10Cand) {
      assert(s10Cand.direction === 'SELL', `S10 Double Top candidate direction is SELL (got ${s10Cand.direction})`);
      assert(s10Cand.setupName.includes('Double Top'), `Candidate setup name is "${s10Cand.setupName}"`);
      assert(s10Cand.tp1Rr >= 1.5, `Dynamic TP1 RR is ${s10Cand.tp1Rr}R (>= 1.5R requirement)`);
    }
  }

  // ---------------------------------------------------------------------------
  // TEST 2: S11 Bare Resistance Rejection Detection
  // ---------------------------------------------------------------------------
  console.log('\nTEST 2: S11 Bare Resistance Rejection candidate detection');
  {
    globalPoiTracker.setPois([]);

    const candles1h = createRampCandles(50, 4270.00, 4295.00);
    candles1h[10] = { ...candles1h[10], low: 4250.00 };

    const candles15m = createRampCandles(50, 4270.00, 4290.00);
    candles15m[10] = { ...candles15m[10], low: 4250.00, close: 4260.00 };

    // Multi-touch resistance at $4295.00
    candles15m[15] = { timestamp: candles15m[15].timestamp, open: 4290.00, high: 4295.10, low: 4288.00, close: 4292.00, volume: 1500, isClosed: true };
    candles15m[28] = { timestamp: candles15m[28].timestamp, open: 4289.00, high: 4294.90, low: 4287.00, close: 4291.00, volume: 1600, isClosed: true };
    candles15m[40] = { timestamp: candles15m[40].timestamp, open: 4291.00, high: 4295.20, low: 4289.00, close: 4290.00, volume: 1700, isClosed: true };

    const candles5m = createRampCandles(40, 4285.00, 4291.00);
    const lastIdx = candles5m.length - 1;
    candles5m[lastIdx] = { timestamp: candles5m[lastIdx].timestamp, open: 4292.00, high: 4295.10, low: 4289.00, close: 4291.00, volume: 2500, isClosed: true };

    const ind5m = analyzeTechnicals(candles5m);
    const ind15m = analyzeTechnicals(candles15m);
    const ind1h = analyzeTechnicals(candles1h);

    ind15m.swingHigh = 4295.20;
    ind15m.swingLow = 4250.00;
    ind15m.support = 4250.00;
    ind15m.ema200 = 4350.00;

    const result = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 4291.00,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h,
      candles15m,
      candles5m,
    });

    const s11Cand = result.allCandidates.find((c) => c.strategyFamily === 'BARE_SR');
    assert(s11Cand !== undefined, 'S11 Bare Resistance candidate generated on horizontal rejection');
    if (s11Cand) {
      assert(s11Cand.direction === 'SELL', 'S11 Bare Resistance direction is SELL');
      assert(s11Cand.setupName.includes('Bare Resistance'), `Candidate setup name is "${s11Cand.setupName}"`);
    }
  }

  // ---------------------------------------------------------------------------
  // TEST 3: S12 Horizontal Breakout & Retest Detection
  // ---------------------------------------------------------------------------
  console.log('\nTEST 3: S12 Horizontal Breakout & Retest candidate detection');
  {
    globalPoiTracker.setPois([]);

    const candles1h = createRampCandles(50, 4270.00, 4290.00);
    candles1h[10] = { ...candles1h[10], high: 4330.00 };

    const candles15m = createRampCandles(50, 4275.00, 4285.00);
    // 15M resistance touches at $4285.00 (within window slice range)
    candles15m[15] = { timestamp: candles15m[15].timestamp, open: 4280.00, high: 4285.10, low: 4278.00, close: 4282.00, volume: 1500 };
    candles15m[28] = { timestamp: candles15m[28].timestamp, open: 4281.00, high: 4284.90, low: 4279.00, close: 4283.00, volume: 1600 };

    const candles5m = createRampCandles(40, 4275.00, 4284.00);
    // Breakout candle at index 30
    candles5m[30] = { timestamp: candles5m[30].timestamp, open: 4284.00, high: 4289.50, low: 4283.50, close: 4289.00, volume: 2800 };

    // Clean retest candle at last index
    const lastIdx = candles5m.length - 1;
    candles5m[lastIdx] = { timestamp: candles5m[lastIdx].timestamp, open: 4287.00, high: 4289.00, low: 4285.10, close: 4288.50, volume: 2200 };

    const ind5m = analyzeTechnicals(candles5m);
    const ind15m = analyzeTechnicals(candles15m);
    const ind1h = analyzeTechnicals(candles1h);

    ind15m.swingHigh = 4330.00;
    ind15m.resistance = 4330.00;
    ind15m.ema200 = 4200.00;

    const result = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 4288.50,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h,
      candles15m,
      candles5m,
    });

    const s12Cand = result.allCandidates.find((c) => c.strategyFamily === 'BREAK_AND_RETEST');
    assert(s12Cand !== undefined, 'S12 Breakout & Retest candidate generated on clean role-reversal retest');
    if (s12Cand) {
      assert(s12Cand.direction === 'BUY', 'S12 Resistance-turned-Support retest direction is BUY');
      assert(s12Cand.setupName.includes('Breakout & Retest'), `Candidate setup name is "${s12Cand.setupName}"`);
    }
  }

  // ---------------------------------------------------------------------------
  // TEST 4: S13 Bullish Engulfing at Key Support Detection
  // ---------------------------------------------------------------------------
  console.log('\nTEST 4: S13 Bullish Engulfing at Key Support candidate detection');
  {
    globalPoiTracker.setPois([]);

    const candles1h = createRampCandles(50, 4260.00, 4290.00);
    candles1h[10] = { ...candles1h[10], high: 4330.00 };

    const candles15m = createRampCandles(50, 4260.00, 4280.00);
    const candles5m = createRampCandles(40, 4265.00, 4261.00);

    const prevIdx = candles5m.length - 2;
    const lastIdx = candles5m.length - 1;

    // Bearish candle down to support ($4260.00)
    candles5m[prevIdx] = { timestamp: candles5m[prevIdx].timestamp, open: 4263.00, high: 4263.50, low: 4260.00, close: 4260.50, volume: 1500 };
    // Strong Bullish Engulfing candle opening at $4260.20 and closing at $4265.00
    candles5m[lastIdx] = { timestamp: candles5m[lastIdx].timestamp, open: 4260.20, high: 4265.50, low: 4260.00, close: 4265.00, volume: 3200 };

    const ind5m = analyzeTechnicals(candles5m);
    const ind15m = analyzeTechnicals(candles15m);
    const ind1h = analyzeTechnicals(candles1h);

    ind15m.swingHigh = 4330.00;
    ind15m.resistance = 4330.00;
    ind15m.support = 4260.00;
    ind15m.ema200 = 4200.00;

    const result = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 4265.00,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h,
      candles15m,
      candles5m,
    });

    const s13Cand = result.allCandidates.find((c) => c.strategyFamily === 'STRUCTURE_ENGULFING');
    assert(s13Cand !== undefined, 'S13 Structure Engulfing candidate generated at support zone');
    if (s13Cand) {
      assert(s13Cand.direction === 'BUY', 'S13 Bullish Engulfing direction is BUY');
      assert(s13Cand.setupName.includes('Bullish Engulfing'), `Candidate setup name is "${s13Cand.setupName}"`);
    }
  }

  // ---------------------------------------------------------------------------
  // TEST 5: Downstream Risk & Safety Gate Pipeline Enforcement
  // ---------------------------------------------------------------------------
  console.log('\nTEST 5: Downstream Risk & Safety Gate Pipeline Enforcement');
  {
    globalPoiTracker.setPois([]);

    const candles5m = createRampCandles(40, 4270.00, 4290.00);
    // Massive Double Top peak at $4320.00 (SL distance = 300 points from $4290.00 entry)
    candles5m[15] = { timestamp: candles5m[15].timestamp, open: 4310.00, high: 4320.00, low: 4305.00, close: 4315.00, volume: 2000 };
    candles5m[30] = { timestamp: candles5m[30].timestamp, open: 4310.00, high: 4320.00, low: 4305.00, close: 4315.00, volume: 2000 };

    const candles15m = createRampCandles(50, 4280.00, 4290.00);
    const candles1h = createRampCandles(50, 4280.00, 4290.00);

    const ind5m = analyzeTechnicals(candles5m);
    const ind15m = analyzeTechnicals(candles15m);
    const ind1h = analyzeTechnicals(candles1h);

    const result = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 4290.00,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h,
      candles15m,
      candles5m,
    });

    const s10ExcessiveSl = result.allCandidates.find((c) => c.strategyFamily === 'DOUBLE_TOP_BOTTOM' && c.slPoints > 85);
    assert(s10ExcessiveSl === undefined, 'Excessive SL candidate (> 85pt) correctly rejected by evaluateCandidate safety gate');
  }

  // ---------------------------------------------------------------------------
  // TEST 6: S10 Formation Deduplication & Sequential Candle Evaluation
  // ---------------------------------------------------------------------------
  console.log('\nTEST 6: S10 Formation Deduplication & Sequential Candle Evaluation');
  {
    globalPoiTracker.setPois([]);

    const candles1h = createRampCandles(50, 4270.00, 4295.00);
    candles1h[10] = { ...candles1h[10], low: 4250.00 };

    const candles15m = createRampCandles(50, 4275.00, 4295.00);

    // Initial 5M series (34 candles up to Peak 2)
    const base5m = createRampCandles(34, 4280.00, 4290.00);
    base5m[15] = { timestamp: base5m[15].timestamp, open: 4291.00, high: 4294.50, low: 4290.00, close: 4293.00, volume: 2000, isClosed: true };
    base5m[22] = { timestamp: base5m[22].timestamp, open: 4289.00, high: 4289.50, low: 4288.00, close: 4288.50, volume: 1500, isClosed: true };
    base5m[33] = { timestamp: base5m[33].timestamp, open: 4289.00, high: 4294.30, low: 4288.00, close: 4292.00, volume: 2500, isClosed: true };

    const ind15m = analyzeTechnicals(candles15m);
    const ind1h = analyzeTechnicals(candles1h);
    ind15m.swingHigh = 4294.50;
    ind15m.swingLow = 4250.00;
    ind15m.support = 4250.00;
    ind15m.ema200 = 4350.00;

    let totalCandidateOutputs = 0;
    const anchorKeysFound = new Set<string>();

    // Step through 10 consecutive candles after Peak 2
    for (let step = 0; step < 10; step++) {
      const current5m = [...base5m];
      for (let s = 0; s <= step; s++) {
        const nextTime = base5m[33].timestamp + (s + 1) * 5 * 60 * 1000;
        current5m.push({
          timestamp: nextTime,
          open: 4292.00 - s * 0.3,
          high: 4292.50 - s * 0.3,
          low: 4289.00 - s * 0.3,
          close: 4290.00 - s * 0.3,
          volume: 2000,
          isClosed: true,
        });
      }

      const ind5m = analyzeTechnicals(current5m);
      const res = generateMultiStrategyCandidates({
        asset: 'XAU/USD',
        balance: 10000,
        currentPrice: current5m[current5m.length - 1].close,
        indicators1h: ind1h,
        indicators15m: ind15m,
        indicators5m: ind5m,
        candles1h,
        candles15m,
        candles5m: current5m,
      });

      const s10Cands = res.allCandidates.filter((c) => c.strategyFamily === 'DOUBLE_TOP_BOTTOM');
      totalCandidateOutputs += s10Cands.length;

      for (const cand of s10Cands) {
        if (cand.patternMetadata?.patternAnchorKey) {
          anchorKeysFound.add(cand.patternMetadata.patternAnchorKey);
        }
      }
    }

    assert(anchorKeysFound.size >= 1 && anchorKeysFound.size <= 2, `All S10 detections map to unique pattern anchor keys anchored to pivot timestamps (found: ${anchorKeysFound.size})`);
    assert(totalCandidateOutputs < 10, `S10 does not continuously trigger 10 raw candidates on every sequential candle (total outputs: ${totalCandidateOutputs})`);
  }

  console.log('\n================================================================');
  console.log(`SUMMARY: ${passedTests}/${totalTests} TESTS PASSED CLEANLY`);
  console.log('================================================================');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runS10S13TestSuite().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
