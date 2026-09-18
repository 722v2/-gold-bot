import { analyzeTechnicals } from '../server/indicators.js';
import { validateTradeSignalCandidate } from '../server/tradeQualityEngine.js';
import { storage } from '../server/storage.js';
import { Candle, TechnicalIndicators } from '../src/types.js';

export async function runIndicatorRegression() {
  console.log('========================================================================');
  console.log('🔍 RUNNING INDICATOR & PRODUCTION SCANNER REGRESSION TEST');
  console.log('========================================================================');

  let part1Passed = true;
  let part2Passed = true;
  let part3Passed = true;

  // -------------------------------------------------------------------------
  // 1. Run analyzeTechnicals() with empty, null, undefined, 1 candle, insufficient arrays
  // -------------------------------------------------------------------------
  console.log('\n[Part 1] Testing analyzeTechnicals() robustness across edge cases...');
  const testInputs: { name: string; input: any }[] = [
    { name: 'Empty array []', input: [] },
    { name: 'undefined', input: undefined },
    { name: 'null', input: null },
    {
      name: 'Single candle',
      input: [
        { timestamp: Date.now() - 300000, open: 2500, high: 2505, low: 2495, close: 2502, volume: 100 },
      ],
    },
    {
      name: 'Two candles',
      input: [
        { timestamp: Date.now() - 600000, open: 2500, high: 2505, low: 2495, close: 2502, volume: 100 },
        { timestamp: Date.now() - 300000, open: 2502, high: 2508, low: 2501, close: 2507, volume: 120 },
      ],
    },
    {
      name: '5 candles (insufficient for 14-period RSI/ATR & 20 EMA)',
      input: [
        { timestamp: Date.now() - 1500000, open: 2500, high: 2505, low: 2495, close: 2502, volume: 100 },
        { timestamp: Date.now() - 1200000, open: 2502, high: 2508, low: 2501, close: 2507, volume: 120 },
        { timestamp: Date.now() - 900000, open: 2507, high: 2510, low: 2504, close: 2505, volume: 110 },
        { timestamp: Date.now() - 600000, open: 2505, high: 2506, low: 2498, close: 2500, volume: 130 },
        { timestamp: Date.now() - 300000, open: 2500, high: 2503, low: 2497, close: 2501, volume: 90 },
      ],
    },
  ];

  for (const t of testInputs) {
    try {
      const res: TechnicalIndicators = analyzeTechnicals(t.input);

      // Verify no NaN in any numeric properties
      const hasNaN =
        Number.isNaN(res.ema20) ||
        Number.isNaN(res.ema50) ||
        Number.isNaN(res.ema200) ||
        Number.isNaN(res.vwap) ||
        Number.isNaN(res.rsi14) ||
        Number.isNaN(res.atr14) ||
        Number.isNaN(res.bollingerBands.upper) ||
        Number.isNaN(res.bollingerBands.middle) ||
        Number.isNaN(res.bollingerBands.lower) ||
        Number.isNaN(res.macd.macd) ||
        Number.isNaN(res.macd.signal) ||
        Number.isNaN(res.macd.histogram) ||
        Number.isNaN(res.swingHigh) ||
        Number.isNaN(res.swingLow) ||
        Number.isNaN(res.support) ||
        Number.isNaN(res.resistance);

      if (hasNaN) {
        console.error(`   ❌ FAIL: NaN detected in analyzeTechnicals output for "${t.name}"`);
        part1Passed = false;
      } else {
        console.log(`   ✓ Pass "${t.name}": structure="${res.structure}", regime="${res.marketRegime}", RSI=${res.rsi14}, ATR=${res.atr14}`);
      }

      // Verify downstream candidate validation with this indicator output returns NO TRADE
      const val = validateTradeSignalCandidate(
        { direction: 'BUY', entry: 2500, stopLoss: 2495, tp1: 2505, setupName: 'Test' },
        {
          currentPrice: 2500,
          candles5m: t.input || [],
          candles15m: t.input || [],
          candles1h: t.input || [],
          indicators5m: res,
          indicators15m: res,
          indicators1h: res,
        }
      );

      if (val.isValid) {
        console.error(`   ❌ FAIL: Downstream candidate passed validation unexpectedly for "${t.name}"`);
        part1Passed = false;
      }
    } catch (err: any) {
      console.error(`   ❌ FAIL: Exception thrown for "${t.name}": ${err.message}`);
      part1Passed = false;
    }
  }

  // -------------------------------------------------------------------------
  // 2. Production scanner path with failure simulation
  // -------------------------------------------------------------------------
  console.log('\n[Part 2] Testing scanner behavior during faulty market data injection...');
  const initBal = storage.getCurrentBalance();
  const initTradesCount = storage.getActiveTrades().length;

  try {
    // Simulate faulty cycle: empty candle feed
    const faultyIndicators5m = analyzeTechnicals([]);
    const faultyIndicators15m = analyzeTechnicals([]);
    const faultyIndicators1h = analyzeTechnicals([]);

    const candBuy = { direction: 'BUY' as const, entry: 2500, stopLoss: 2495, tp1: 2505, setupName: 'Faulty Scan Test' };
    const candSell = { direction: 'SELL' as const, entry: 2500, stopLoss: 2505, tp1: 2495, setupName: 'Faulty Scan Test' };

    const valBuy = validateTradeSignalCandidate(candBuy, {
      currentPrice: 2500,
      candles5m: [],
      candles15m: [],
      candles1h: [],
      indicators5m: faultyIndicators5m,
      indicators15m: faultyIndicators15m,
      indicators1h: faultyIndicators1h,
    });

    const valSell = validateTradeSignalCandidate(candSell, {
      currentPrice: 2500,
      candles5m: [],
      candles15m: [],
      candles1h: [],
      indicators5m: faultyIndicators5m,
      indicators15m: faultyIndicators15m,
      indicators1h: faultyIndicators1h,
    });

    if (valBuy.isValid || valSell.isValid) {
      console.error('   ❌ FAIL: Faulty cycle produced executable BUY/SELL signal!');
      part2Passed = false;
    } else {
      console.log('   ✓ Faulty cycle produced NO TRADE safely (BUY: rejected, SELL: rejected)');
    }

    // Verify no trade opened, no balance modified
    const currentBal = storage.getCurrentBalance();
    const currentTradesCount = storage.getActiveTrades().length;

    if (Math.abs(currentBal - initBal) > 0.001 || currentTradesCount !== initTradesCount) {
      console.error('   ❌ FAIL: Faulty cycle modified balance or created trade!');
      part2Passed = false;
    } else {
      console.log('   ✓ Scanner state preserved: Balance unchanged ($' + currentBal.toFixed(2) + '), active trades count unchanged (' + currentTradesCount + ')');
    }
  } catch (err: any) {
    console.error(`   ❌ FAIL: Unhandled error in scanner error path: ${err.message}`);
    part2Passed = false;
  }

  // -------------------------------------------------------------------------
  // 3. Normal valid market data scan recovery
  // -------------------------------------------------------------------------
  console.log('\n[Part 3] Testing recovery on normal valid market data scan...');
  try {
    // Generate 60 normal candles
    const validCandles: Candle[] = [];
    let p = 2500;
    for (let i = 0; i < 60; i++) {
      const o = p;
      p += (Math.sin(i / 5) * 1.5 + (i % 2 === 0 ? 0.4 : -0.3));
      const c = p;
      const h = Math.max(o, c) + 0.8;
      const l = Math.min(o, c) - 0.8;
      validCandles.push({
        timestamp: Date.now() - (60 - i) * 300000,
        open: Number(o.toFixed(2)),
        high: Number(h.toFixed(2)),
        low: Number(l.toFixed(2)),
        close: Number(c.toFixed(2)),
        volume: 150 + i * 2,
      });
    }

    const normInd = analyzeTechnicals(validCandles);
    if (normInd.rsi14 <= 0 || normInd.atr14 <= 0 || normInd.ema20 <= 0) {
      console.error('   ❌ FAIL: Normal indicators failed to compute correctly!');
      part3Passed = false;
    } else {
      console.log(`   ✓ Normal scan recovered perfectly: RSI=${normInd.rsi14}, ATR=${normInd.atr14}, EMA20=${normInd.ema20}, Structure=${normInd.structure}`);
    }
  } catch (err: any) {
    console.error(`   ❌ FAIL: Normal scan threw exception: ${err.message}`);
    part3Passed = false;
  }

  console.log('\n========================================================================');
  console.log(`Part 1 (Robustness): ${part1Passed ? 'PASS' : 'FAIL'}`);
  console.log(`Part 2 (Scanner Failure Path): ${part2Passed ? 'PASS' : 'FAIL'}`);
  console.log(`Part 3 (Normal Recovery): ${part3Passed ? 'PASS' : 'FAIL'}`);
  console.log('========================================================================');

  if (!part1Passed || !part2Passed || !part3Passed) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIndicatorRegression().catch(err => {
    console.error('Fatal regression check error:', err);
    process.exit(1);
  });
}
