import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Candle, TechnicalIndicators, StrategyFamily } from '../src/types.js';
import { parseAndValidateAiResponse, XAUUSD_TRADE_SIGNAL_JSON_SCHEMA } from '../server/geminiTrader.js';
import { validateTradeSignalCandidate } from '../server/tradeQualityEngine.js';
import {
  partition1hCandles,
  partition15mCandles,
  partition5mCandles,
  partition1mCandles,
} from '../server/candleUtils.js';

function createMockCandles(count: number, tfMinutes: number, basePrice: number, baseTime: number): Candle[] {
  const candles: Candle[] = [];
  const tfMs = tfMinutes * 60 * 1000;
  for (let i = 0; i < count; i++) {
    const timestamp = baseTime - (count - i) * tfMs;
    candles.push({
      timestamp,
      open: basePrice + (i % 2 === 0 ? 0.2 : -0.2),
      high: basePrice + 0.8,
      low: basePrice - 0.8,
      close: basePrice + (i % 2 === 0 ? 0.4 : -0.4),
      volume: 150 + i * 5,
      isClosed: true,
    });
  }
  return candles;
}

function createMockIndicators(price: number): TechnicalIndicators {
  return {
    structure: 'BULLISH',
    rsi14: 52.4,
    ema20: price - 0.5,
    ema50: price - 1.2,
    ema200: price - 3.5,
    macd: { macd: 0.15, signal: 0.10, histogram: 0.05 },
    atr14: 1.8,
    vwap: price - 0.2,
    bollingerBands: { upper: price + 2.5, middle: price, lower: price - 2.5 },
    swingHigh: price + 4.0,
    swingLow: price - 4.0,
    support: price - 1.5,
    resistance: price + 2.5,
    liquidityLevels: {
      buySideLiquidity: price + 5.0,
      sellSideLiquidity: price - 5.0,
    },
    marketRegime: 'STRONG_UPTREND',
    premiumDiscountZone: 'DISCOUNT',
  };
}

describe('Gemini Autonomous Setup Discovery & Context Verification', () => {
  const now = 1700000000000;
  const currentPrice = 2700.0;

  it('A. Multi-timeframe closed candle partitioning meets required minimum counts', () => {
    const h1Raw = createMockCandles(20, 60, currentPrice, now);
    const m15Raw = createMockCandles(30, 15, currentPrice, now);
    const m5Raw = createMockCandles(45, 5, currentPrice, now);
    const m1Raw = createMockCandles(25, 1, currentPrice, now);

    const closedH1 = partition1hCandles(h1Raw, now).closedCandles;
    const closedM15 = partition15mCandles(m15Raw, now).closedCandles;
    const closedM5 = partition5mCandles(m5Raw, now).closedCandles;
    const closedM1 = partition1mCandles(m1Raw, now).closedCandles;

    assert.ok(closedH1.length >= 10, 'H1 must have at least 10 closed candles');
    assert.ok(closedM15.length >= 20, 'M15 must have at least 20 closed candles');
    assert.ok(closedM5.length >= 30, 'M5 must have at least 30 closed candles');
    assert.ok(closedM1.length >= 15, '1M must have at least 15 closed candles');

    // Verify slicing behavior matches geminiTrader.ts payload
    const slicedH1 = closedH1.slice(-10);
    const slicedM15 = closedM15.slice(-20);
    const slicedM5 = closedM5.slice(-30);
    const slicedM1 = closedM1.slice(-15);

    assert.strictEqual(slicedH1.length, 10, 'H1 sliced window should be 10');
    assert.strictEqual(slicedM15.length, 20, 'M15 sliced window should be 20');
    assert.strictEqual(slicedM5.length, 30, 'M5 sliced window should be 30');
    assert.strictEqual(slicedM1.length, 15, '1M sliced window should be 15');
  });

  it('B. Forming candle is isolated and never sent as a closed candle', () => {
    const closed5m = createMockCandles(20, 5, currentPrice, now - 5 * 60 * 1000);
    // Add an active forming candle with timestamp within current 5m bucket
    const forming5m: Candle = {
      timestamp: now - 60 * 1000,
      open: currentPrice,
      high: currentPrice + 1.0,
      low: currentPrice - 0.5,
      close: currentPrice + 0.5,
      volume: 40,
      isClosed: false,
    };
    const allCandles = [...closed5m, forming5m];

    const partition = partition5mCandles(allCandles, now);
    assert.strictEqual(partition.formingCandle?.timestamp, forming5m.timestamp);
    assert.strictEqual(partition.closedCandles.length, 20);
    assert.strictEqual(partition.closedCandles.some(c => c.timestamp === forming5m.timestamp), false);
  });

  it('C. JSON Schema parser handles valid BUY NOW with local SL (35-65 pts)', () => {
    const rawAiResponse = JSON.stringify({
      signal: 'BUY NOW',
      entry: 2700.0,
      stopLoss: 2695.5, // 45 points ($4.50)
      tp1: 2707.0,      // 70 points (1.55R)
      tp2: 2712.0,
      confidence: 88,
      timeframe: '15M / 5M',
      setup: 'Bullish Order Block Retest & Liquidity Sweep',
      mainReasons: ['M5 sweep of sell-side liquidity into M15 Bullish OB', 'Strong bullish rejection wick on M5'],
      invalidation: 'Close candle below 2695.5',
    });

    const parsed = parseAndValidateAiResponse(rawAiResponse);
    assert.strictEqual(parsed.signal, 'BUY NOW');
    assert.strictEqual(parsed.entry, 2700.0);
    assert.strictEqual(parsed.stopLoss, 2695.5);
    assert.strictEqual(parsed.tp1, 2707.0);
    assert.strictEqual(parsed.confidence, 88);

    const slPoints = Math.round(Math.abs(parsed.entry! - parsed.stopLoss!) / 0.1);
    assert.ok(slPoints >= 35 && slPoints <= 65, `SL points (${slPoints}) must be in [35, 65]`);
  });

  it('D. Deterministic Validation accepts local scalping SL (45 pts) and RR >= 1.0R', () => {
    const candles5m = createMockCandles(35, 5, 2700.0, now);
    const ind5m = createMockIndicators(2700.0);
    const ind15m = createMockIndicators(2700.0);
    const ind1h = createMockIndicators(2700.0);

    const valResult = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2700.0,
        stopLoss: 2695.5, // 45 points
        tp1: 2706.0,      // 60 points -> 1.33R
        setupName: 'Bullish Order Block Retest',
        strategyFamily: 'ORDER_BLOCK',
        confidence: 85,
      },
      {
        currentPrice: 2700.0,
        candles5m,
        candles15m: createMockCandles(25, 15, 2700.0, now),
        candles1h: createMockCandles(15, 60, 2700.0, now),
        candles1m: createMockCandles(20, 1, 2700.0, now),
        indicators5m: ind5m,
        indicators15m: ind15m,
        indicators1h: ind1h,
        brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
        currentSpread: 0.15,
      }
    );

    assert.strictEqual(valResult.isValid, true, `Expected candidate to pass validation, got: ${valResult.rejectionReason}`);
  });

  it('E. Deterministic Validation strictly rejects macro swing SL (350+ pts)', () => {
    const candles5m = createMockCandles(35, 5, 2700.0, now);
    const ind5m = createMockIndicators(2700.0);
    const ind15m = createMockIndicators(2700.0);
    const ind1h = createMockIndicators(2700.0);

    const wideMacroCandidate = {
      direction: 'BUY' as const,
      entry: 2700.0,
      stopLoss: 2665.0, // 350 points ($35.00) away!
      tp1: 2750.0,
      setupName: 'Macro Trend Follow',
      strategyFamily: 'TREND_CONTINUATION' as StrategyFamily,
      confidence: 80,
    };

    const valResult = validateTradeSignalCandidate(
      wideMacroCandidate,
      {
        currentPrice: 2700.0,
        candles5m,
        candles15m: createMockCandles(25, 15, 2700.0, now),
        candles1h: createMockCandles(15, 60, 2700.0, now),
        candles1m: createMockCandles(20, 1, 2700.0, now),
        indicators5m: ind5m,
        indicators15m: ind15m,
        indicators1h: ind1h,
        brokerSpecs: { minSlPoints: 35, maxSlPoints: 65, minRr: 1.0 },
        currentSpread: 0.15,
      }
    );

    assert.strictEqual(valResult.isValid, false);
    assert.ok(valResult.rejectionReason?.includes('INVALID_SL_DISTANCE'), 'Must reject due to SL distance outside [35, 65] pts');
  });

  it('F. JSON parser accurately parses autonomous NO TRADE with detailed reason', () => {
    const rawAiResponse = JSON.stringify({
      signal: 'NO TRADE',
      confidence: 0,
      setup: 'No Setup',
      noTradeReason: 'السعر يتداول داخل منطقة تذبذب عشوائي في منتصف النطاق (Equilibrium) بدون سحب سيولة أو منطقة طلب واضحة.',
    });

    const parsed = parseAndValidateAiResponse(rawAiResponse);
    assert.strictEqual(parsed.signal, 'NO TRADE');
    assert.ok(parsed.noTradeReason?.includes('Equilibrium'));
  });

  it('G. Schema definition matches required signal enum and properties', () => {
    assert.strictEqual(XAUUSD_TRADE_SIGNAL_JSON_SCHEMA.type, 'object');
    assert.deepStrictEqual(XAUUSD_TRADE_SIGNAL_JSON_SCHEMA.properties.signal.enum, [
      'BUY NOW',
      'SELL NOW',
      'BUY LIMIT',
      'SELL LIMIT',
      'NO TRADE',
    ]);
  });
});
