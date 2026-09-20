import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAndSanitizeCandles } from '../server/marketData.js';
import { validateTradeSignalCandidate, assessEntryTimingAndAntiChase } from '../server/tradeQualityEngine.js';
import { Candle } from '../src/types.js';

test('Live Data Hardening & Quality Gate Test Suite', async (t) => {
  const baseCandle = (ts: number, o: number, h: number, l: number, c: number, v: number = 100): Candle => ({
    timestamp: ts,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
  });

  await t.test('1. Candle Validation: Clean valid sequence passes with correct count and sorting', () => {
    const rawCandles: Candle[] = [];
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      rawCandles.push(baseCandle(now - (30 - i) * 60000, 2650.0 + i * 0.1, 2651.0 + i * 0.1, 2649.5 + i * 0.1, 2650.5 + i * 0.1));
    }

    const res = validateAndSanitizeCandles(rawCandles, '5m', 15);
    assert.equal(res.isValid, true);
    assert.equal(res.sanitizedCandles.length, 30);
    assert.equal(res.sanitizedCandles[0].timestamp < res.sanitizedCandles[1].timestamp, true);
  });

  await t.test('2. Candle Validation: Deduplicates duplicate timestamps safely', () => {
    const rawCandles: Candle[] = [];
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      rawCandles.push(baseCandle(now - (20 - i) * 60000, 2650.0, 2652.0, 2649.0, 2651.0));
    }
    // Add 5 exact duplicates
    rawCandles.push(baseCandle(rawCandles[5].timestamp, 2650.0, 2652.0, 2649.0, 2651.0));
    rawCandles.push(baseCandle(rawCandles[6].timestamp, 2650.0, 2652.0, 2649.0, 2651.0));

    const res = validateAndSanitizeCandles(rawCandles, '5m', 15);
    assert.equal(res.isValid, true);
    assert.equal(res.sanitizedCandles.length, 20, 'Duplicates should be deduplicated to unique count');
  });

  await t.test('3. Candle Validation: Fails closed on insufficient candle count', () => {
    const rawCandles: Candle[] = [
      baseCandle(Date.now() - 60000, 2650, 2652, 2649, 2651),
      baseCandle(Date.now(), 2651, 2653, 2650, 2652),
    ];
    const res = validateAndSanitizeCandles(rawCandles, '5m', 15);
    assert.equal(res.isValid, false);
    assert.match(res.error || '', /INSUFFICIENT_CANDLES/);
  });

  await t.test('4. Candle Validation: Fails closed on non-positive or NaN values', () => {
    const rawCandles: Candle[] = [];
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      rawCandles.push(baseCandle(now - (20 - i) * 60000, 2650.0, 2652.0, 2649.0, 2651.0));
    }
    rawCandles[10] = baseCandle(now - 10 * 60000, NaN, 2652.0, 2649.0, 2651.0);

    const res = validateAndSanitizeCandles(rawCandles, '5m', 15);
    assert.equal(res.isValid, false);
    assert.match(res.error || '', /CORRUPT_CANDLE_DATA/);
  });

  await t.test('5. Candle Validation: Fails closed on invalid candle geometry (high < low or low > close)', () => {
    const rawCandles: Candle[] = [];
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      rawCandles.push(baseCandle(now - (20 - i) * 60000, 2650.0, 2652.0, 2649.0, 2651.0));
    }
    // High lower than low
    rawCandles[12] = baseCandle(now - 8 * 60000, 2650.0, 2640.0, 2655.0, 2645.0);

    const res = validateAndSanitizeCandles(rawCandles, '5m', 15);
    assert.equal(res.isValid, false);
    assert.match(res.error || '', /INVALID_CANDLE_GEOMETRY/);
  });

  function createMockIndicators(price: number) {
    return {
      rsi14: 52,
      macd: { macd: 0.1, signal: 0.05, histogram: 0.05 },
      ema20: price - 0.2,
      ema50: price - 0.5,
      ema200: price - 2.0,
      vwap: price,
      atr14: 2.0,
      bollingerBands: {
        upper: price + 4.0,
        middle: price,
        lower: price - 4.0,
      },
      swingHigh: price + 4.0,
      swingLow: price - 4.0,
      support: price - 2.5,
      resistance: price + 2.5,
      marketRegime: 'TRENDING_BULLISH',
      structure: 'BULLISH',
      trendStructure: 'HH_HL',
    };
  }

  await t.test('6. Spread Quality Gate: Valid spread (e.g. 2.0 pts = $0.20) passes validation', () => {
    const dummyCandles: Candle[] = [];
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      dummyCandles.push({
        timestamp: now - (30 - i) * 300000,
        open: 2648.0 + i * 0.05,
        high: 2649.0 + i * 0.05,
        low: 2647.5 + i * 0.05,
        close: 2648.5 + i * 0.05,
        volume: 100,
        isClosed: true,
      });
    }
    // Set last closed candle to a strong bullish engulfing and expansion close
    dummyCandles[dummyCandles.length - 2] = {
      timestamp: now - 600000,
      open: 2649.2,
      high: 2649.6,
      low: 2648.8,
      close: 2649.3,
      volume: 100,
      isClosed: true,
    };
    dummyCandles[dummyCandles.length - 1] = {
      timestamp: now - 300000,
      open: 2649.2,
      high: 2651.5,
      low: 2649.0,
      close: 2651.2,
      volume: 500,
      isClosed: true,
    };

    const dummyInd: any = createMockIndicators(2650.0);

    const res = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2650.0,
        stopLoss: 2645.5, // 45 pts SL
        tp1: 2656.0,     // 60 pts TP1 (1.33R)
        tp2: 2662.0,
        setupName: 'Bullish FVG Retest',
        strategyFamily: 'FVG_IMBALANCE',
        confidence: 82,
        poiPrice: 2650.0,
      },
      {
        currentPrice: 2650.0,
        candles5m: dummyCandles,
        candles15m: dummyCandles,
        candles1h: dummyCandles,
        indicators5m: dummyInd,
        indicators15m: dummyInd,
        indicators1h: dummyInd,
        currentSpread: 0.20, // 2.0 pts spread
      }
    );

    if (!res.isValid) {
      console.log('Test 6 rejection reason:', res.rejectionReason);
    }
    assert.equal(res.isValid, true, `Valid spread and valid structure must pass validation (got: ${res.rejectionReason})`);
  });

  await t.test('7. Spread Quality Gate: Non-positive or NaN spread fails closed', () => {
    const dummyCandles: Candle[] = [];
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      dummyCandles.push(baseCandle(now - (30 - i) * 300000, 2650.0 + i * 0.1, 2652.0 + i * 0.1, 2649.0 + i * 0.1, 2651.0 + i * 0.1));
    }

    const dummyInd: any = { atr14: 2.5 };

    const resZero = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2650.0,
        stopLoss: 2645.0,
        tp1: 2656.0,
        tp2: 2662.0,
        setupName: 'Bullish Test',
      },
      {
        currentPrice: 2650.0,
        candles5m: dummyCandles,
        candles15m: dummyCandles,
        candles1h: dummyCandles,
        indicators5m: dummyInd,
        indicators15m: dummyInd,
        indicators1h: dummyInd,
        currentSpread: 0.0, // Invalid non-positive spread
      }
    );

    assert.equal(resZero.isValid, false);
    assert.match(resZero.rejectionReason || '', /SPREAD_INVALID/);

    const resNan = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2650.0,
        stopLoss: 2645.0,
        tp1: 2656.0,
        tp2: 2662.0,
        setupName: 'Bullish Test',
      },
      {
        currentPrice: 2650.0,
        candles5m: dummyCandles,
        candles15m: dummyCandles,
        candles1h: dummyCandles,
        indicators5m: dummyInd,
        indicators15m: dummyInd,
        indicators1h: dummyInd,
        currentSpread: NaN,
      }
    );

    assert.equal(resNan.isValid, false);
    assert.match(resNan.rejectionReason || '', /SPREAD_INVALID/);
  });

  await t.test('8. Spread Quality Gate: Excessive spread (> 12.0 pts or > 20% of SL) fails closed', () => {
    const dummyCandles: Candle[] = [];
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      dummyCandles.push(baseCandle(now - (30 - i) * 300000, 2650.0 + i * 0.1, 2652.0 + i * 0.1, 2649.0 + i * 0.1, 2651.0 + i * 0.1));
    }

    const dummyInd: any = { atr14: 2.5 };

    // Spread = 1.30 ($1.30 = 13.0 pts > 12.0 pts maximum)
    const resExcessive = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2650.0,
        stopLoss: 2645.0, // 50 pts SL
        tp1: 2656.0,
        tp2: 2662.0,
        setupName: 'Bullish Test',
      },
      {
        currentPrice: 2650.0,
        candles5m: dummyCandles,
        candles15m: dummyCandles,
        candles1h: dummyCandles,
        indicators5m: dummyInd,
        indicators15m: dummyInd,
        indicators1h: dummyInd,
        currentSpread: 1.30, // 13 pts
      }
    );

    assert.equal(resExcessive.isValid, false);
    assert.match(resExcessive.rejectionReason || '', /SPREAD_EXCESSIVE/);

    // Spread consumes > 20% of SL (e.g. SL = 4.0 ($4.00 = 40 pts), Spread = 0.90 ($0.90 = 9 pts = 22.5% of SL))
    const resRatio = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2650.0,
        stopLoss: 2646.0, // 40 pts SL ($4.00)
        tp1: 2655.0,
        tp2: 2660.0,
        setupName: 'Bullish Test',
      },
      {
        currentPrice: 2650.0,
        candles5m: dummyCandles,
        candles15m: dummyCandles,
        candles1h: dummyCandles,
        indicators5m: dummyInd,
        indicators15m: dummyInd,
        indicators1h: dummyInd,
        currentSpread: 0.90, // 9.0 pts = 22.5% of 40 pts SL
      }
    );

    assert.equal(resRatio.isValid, false);
    assert.match(resRatio.rejectionReason || '', /SPREAD_EXCESSIVE/);
  });
});
