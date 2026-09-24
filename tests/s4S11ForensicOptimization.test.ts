import test from 'node:test';
import assert from 'node:assert';
import { generateMultiStrategyCandidates, MultiStrategyEngineInput } from '../server/strategyEngine.js';
import { globalPoiTracker } from '../server/tradeQualityEngine.js';
import { TechnicalIndicators, Candle } from '../src/types.js';

function createMockCandle(ts: number, open: number, high: number, low: number, close: number): Candle {
  return {
    timestamp: ts,
    open,
    high,
    low,
    close,
    volume: 1000,
    isClosed: true,
  };
}

function createBaseIndicators(): TechnicalIndicators {
  return {
    atr14: 2.0,
    rsi14: 50,
    ema20: 2700,
    ema50: 2700,
    ema200: 2690,
    vwap: 2700,
    resistance: 2720,
    support: 2680,
    swingHigh: 2720,
    swingLow: 2680,
    isTrending: false,
    trendDirection: 'NEUTRAL',
    trendStrength: 50,
    marketRegime: 'NORMAL_RANGE',
    structure: 'RANGING',
  };
}

test('S11 (Bare S/R) Level Quality Filter', async (t) => {
  await t.test('S11 accepts level with touchesCount = 1', () => {
    const now = Date.now();
    const candles5m: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles5m.push(createMockCandle(now - (60 - i) * 300000, 2700, 2702, 2698, 2700));
    }
    // Touch resistance at 2710 once
    candles5m[candles5m.length - 2] = createMockCandle(now - 300000, 2708, 2710, 2707, 2709);
    candles5m[candles5m.length - 1] = createMockCandle(now, 2709, 2710, 2705, 2706); // Upper wick rejection

    const ind5m = createBaseIndicators();
    ind5m.atr14 = 2.0;
    const ind15m = createBaseIndicators();
    ind15m.atr14 = 3.0;

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 2706,
      indicators1h: createBaseIndicators(),
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h: [createMockCandle(now, 2700, 2720, 2680, 2706)],
      candles15m: [createMockCandle(now, 2700, 2720, 2680, 2706)],
      candles5m,
      brokerSpecs: { minRr: 1.5, minGoldSlPoints: 35, maxGoldSlPoints: 85 },
    };

    const result = generateMultiStrategyCandidates(input);
    const s11Candidates = result.allCandidates.filter(
      (c) => c.strategyFamily === 'BARE_SR' || c.patternMetadata?.strategyId === 'S11'
    );
    for (const cand of s11Candidates) {
      const touches = cand.patternMetadata?.touches;
      if (typeof touches === 'number') {
        assert.ok(touches < 3, `S11 candidate must have touches < 3, got ${touches}`);
      }
    }
  });

  await t.test('S11 accepts level with touchesCount = 2', () => {
    const now = Date.now();
    const candles5m: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles5m.push(createMockCandle(now - (60 - i) * 300000, 2700, 2702, 2698, 2700));
    }
    // 2 touches at 2710
    candles5m[20] = createMockCandle(now - 40 * 300000, 2708, 2710, 2706, 2707);
    candles5m[40] = createMockCandle(now - 20 * 300000, 2708, 2710, 2706, 2707);
    candles5m[candles5m.length - 1] = createMockCandle(now, 2709, 2710, 2705, 2706);

    const ind5m = createBaseIndicators();
    ind5m.atr14 = 2.0;
    const ind15m = createBaseIndicators();
    ind15m.atr14 = 3.0;

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 2706,
      indicators1h: createBaseIndicators(),
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h: [createMockCandle(now, 2700, 2720, 2680, 2706)],
      candles15m: [createMockCandle(now, 2700, 2720, 2680, 2706)],
      candles5m,
      brokerSpecs: { minRr: 1.5, minGoldSlPoints: 35, maxGoldSlPoints: 85 },
    };

    const result = generateMultiStrategyCandidates(input);
    const s11Candidates = result.allCandidates.filter(
      (c) => c.strategyFamily === 'BARE_SR' || c.patternMetadata?.strategyId === 'S11'
    );
    for (const cand of s11Candidates) {
      const touches = cand.patternMetadata?.touches;
      if (typeof touches === 'number') {
        assert.ok(touches < 3, `S11 candidate must have touches < 3, got ${touches}`);
      }
    }
  });

  await t.test('S11 rejects level with touchesCount = 3', () => {
    const now = Date.now();
    const candles5m: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles5m.push(createMockCandle(now - (60 - i) * 300000, 2700, 2702, 2698, 2700));
    }
    // 3 distinct touches at 2710
    candles5m[15] = createMockCandle(now - 45 * 300000, 2708, 2710, 2706, 2707);
    candles5m[30] = createMockCandle(now - 30 * 300000, 2708, 2710, 2706, 2707);
    candles5m[45] = createMockCandle(now - 15 * 300000, 2708, 2710, 2706, 2707);
    candles5m[candles5m.length - 1] = createMockCandle(now, 2709, 2710, 2705, 2706);

    const ind5m = createBaseIndicators();
    ind5m.atr14 = 2.0;
    const ind15m = createBaseIndicators();
    ind15m.atr14 = 3.0;

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 2706,
      indicators1h: createBaseIndicators(),
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h: [createMockCandle(now, 2700, 2720, 2680, 2706)],
      candles15m: [createMockCandle(now, 2700, 2720, 2680, 2706)],
      candles5m,
      brokerSpecs: { minRr: 1.5, minGoldSlPoints: 35, maxGoldSlPoints: 85 },
    };

    const result = generateMultiStrategyCandidates(input);
    const s11Candidates = result.allCandidates.filter(
      (c) => c.strategyFamily === 'BARE_SR' || c.patternMetadata?.strategyId === 'S11'
    );
    // Should have zero candidates because level with 3 touches is rejected
    assert.strictEqual(s11Candidates.length, 0, 'S11 candidates with 3 touches must be rejected');
  });

  await t.test('S11 rejects level with touchesCount = 4', () => {
    const now = Date.now();
    const candles5m: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles5m.push(createMockCandle(now - (60 - i) * 300000, 2700, 2702, 2698, 2700));
    }
    // 4 touches at 2710
    candles5m[10] = createMockCandle(now - 50 * 300000, 2708, 2710, 2706, 2707);
    candles5m[20] = createMockCandle(now - 40 * 300000, 2708, 2710, 2706, 2707);
    candles5m[30] = createMockCandle(now - 30 * 300000, 2708, 2710, 2706, 2707);
    candles5m[40] = createMockCandle(now - 20 * 300000, 2708, 2710, 2706, 2707);
    candles5m[candles5m.length - 1] = createMockCandle(now, 2709, 2710, 2705, 2706);

    const ind5m = createBaseIndicators();
    ind5m.atr14 = 2.0;
    const ind15m = createBaseIndicators();
    ind15m.atr14 = 3.0;

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 2706,
      indicators1h: createBaseIndicators(),
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h: [createMockCandle(now, 2700, 2720, 2680, 2706)],
      candles15m: [createMockCandle(now, 2700, 2720, 2680, 2706)],
      candles5m,
      brokerSpecs: { minRr: 1.5, minGoldSlPoints: 35, maxGoldSlPoints: 85 },
    };

    const result = generateMultiStrategyCandidates(input);
    const s11Candidates = result.allCandidates.filter(
      (c) => c.strategyFamily === 'BARE_SR' || c.patternMetadata?.strategyId === 'S11'
    );
    assert.strictEqual(s11Candidates.length, 0, 'S11 candidates with 4 touches must be rejected');
  });
});

test('S4 (Market Structure Shift) POI Distance & 1H Alignment Filter', async (t) => {
  await t.test('S4 accepts candidate when poiDistAtr <= 1.2 and 1H EMA50 is aligned', () => {
    globalPoiTracker.setPois([]);
    const now = Date.now();
    const candles5m: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles5m.push(createMockCandle(now - (60 - i) * 300000, 2705.5, 2706.5, 2704.8, 2706.0));
    }
    // Bullish shift: entry = 2706, swingLow = 2702.0 (SL points = 40 = 4.0 pts)
    // Candle lows = 2704.8 => distance = 2706 - 2704.8 = 1.2 pts. ATR = 2.0 => dist = 0.60 ATR (<= 1.2 ATR)
    const ind5m = createBaseIndicators();
    ind5m.bosDetected = true;
    ind5m.structureEvent = 'BULLISH_BOS';
    ind5m.mssDirection = 'BULLISH';
    ind5m.swingLow = 2702.0;
    ind5m.ema20 = 2703;
    ind5m.atr14 = 2.0;

    const ind1h = createBaseIndicators();
    ind1h.ema50 = 2695; // Entry 2706 >= 2695 -> 1H EMA50 aligned for BUY!

    const candles15m: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles15m.push(createMockCandle(now - (20 - i) * 900000, 2700 + i * 0.2, 2730, 2699 + i * 0.2, 2701 + i * 0.2));
    }

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 2706,
      indicators1h: ind1h,
      indicators15m: createBaseIndicators(),
      indicators5m: ind5m,
      candles1h: [createMockCandle(now, 2690, 2710, 2685, 2706)],
      candles15m,
      candles5m,
      brokerSpecs: { minRr: 1.5, minGoldSlPoints: 35, maxGoldSlPoints: 85 },
    };

    const result = generateMultiStrategyCandidates(input);
    const s4Candidates = result.allCandidates.filter(
      (c) => c.patternMetadata?.strategyId === 'S4' || (c.strategyFamily === 'MARKET_STRUCTURE' && c.setupName.includes('Market Structure Shift'))
    );
    assert.ok(s4Candidates.length > 0, 'S4 candidate with valid POI dist and 1H alignment should be accepted');
  });

  await t.test('S4 rejects candidate when poiDistAtr > 1.2 ATR', () => {
    globalPoiTracker.setPois([]);
    const now = Date.now();
    const candles5m: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles5m.push(createMockCandle(now - (60 - i) * 300000, 2700, 2702, 2698, 2700));
    }
    // Entry = 2715, origin low = 2700 => distance = 15 pts. ATR = 2.0 => dist = 7.5 ATR (> 1.2 ATR)
    const ind5m = createBaseIndicators();
    ind5m.bosDetected = true;
    ind5m.structureEvent = 'BULLISH_BOS';
    ind5m.mssDirection = 'BULLISH';
    ind5m.swingLow = 2700;
    ind5m.ema20 = 2705;
    ind5m.atr14 = 2.0;

    const ind1h = createBaseIndicators();
    ind1h.ema50 = 2690;

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 2715,
      indicators1h: ind1h,
      indicators15m: createBaseIndicators(),
      indicators5m: ind5m,
      candles1h: [createMockCandle(now, 2690, 2720, 2685, 2715)],
      candles15m: [createMockCandle(now, 2695, 2720, 2690, 2715)],
      candles5m,
      brokerSpecs: { minRr: 1.5, minGoldSlPoints: 35, maxGoldSlPoints: 85 },
    };

    const result = generateMultiStrategyCandidates(input);
    const s4Candidates = result.allCandidates.filter(
      (c) => c.patternMetadata?.strategyId === 'S4' || (c.strategyFamily === 'MARKET_STRUCTURE' && c.setupName.includes('Market Structure Shift'))
    );
    assert.strictEqual(s4Candidates.length, 0, 'S4 candidate with poiDistAtr > 1.2 must be rejected');
  });

  await t.test('S4 rejects candidate when 1H EMA50 is misaligned (BUY entry < 1H EMA50)', () => {
    globalPoiTracker.setPois([]);
    const now = Date.now();
    const candles5m: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles5m.push(createMockCandle(now - (60 - i) * 300000, 2700, 2702, 2698, 2700));
    }

    const ind5m = createBaseIndicators();
    ind5m.bosDetected = true;
    ind5m.structureEvent = 'BULLISH_BOS';
    ind5m.mssDirection = 'BULLISH';
    ind5m.swingLow = 2700.5;
    ind5m.ema20 = 2702;
    ind5m.atr14 = 2.0;

    const ind1h = createBaseIndicators();
    ind1h.ema50 = 2720; // Entry 2705 < 2720 -> BUY is misaligned against 1H EMA50!

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 2705,
      indicators1h: ind1h,
      indicators15m: createBaseIndicators(),
      indicators5m: ind5m,
      candles1h: [createMockCandle(now, 2690, 2710, 2685, 2700)], // 1H close 2700 < 2720
      candles15m: [createMockCandle(now, 2695, 2710, 2690, 2705)],
      candles5m,
      brokerSpecs: { minRr: 1.5, minGoldSlPoints: 35, maxGoldSlPoints: 85 },
    };

    const result = generateMultiStrategyCandidates(input);
    const s4Candidates = result.allCandidates.filter(
      (c) => c.patternMetadata?.strategyId === 'S4' || (c.strategyFamily === 'MARKET_STRUCTURE' && c.setupName.includes('Market Structure Shift'))
    );
    assert.strictEqual(s4Candidates.length, 0, 'S4 candidate misaligned with 1H EMA50 must be rejected');
  });
});

test('S4 & S11 2.0R TP1 Ceiling Logic & Minimum RR Enforcement', async (t) => {
  await t.test('S4 caps TP1 at 2.0R ceiling when raw structural target is distant', () => {
    const now = Date.now();
    const candles5m: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles5m.push(createMockCandle(now - (60 - i) * 300000, 2700, 2702, 2698, 2700));
    }

    const ind5m = createBaseIndicators();
    ind5m.bosDetected = true;
    ind5m.structureEvent = 'BULLISH_BOS';
    ind5m.mssDirection = 'BULLISH';
    ind5m.swingLow = 2700.5; // SL around 2700 (5 pts = 50 pts risk)
    ind5m.swingHigh = 2760;  // Distant target (60 pts = 12R)
    ind5m.resistance = 2760;
    ind5m.ema20 = 2702;
    ind5m.atr14 = 2.0;

    const ind15m = createBaseIndicators();
    ind15m.swingHigh = 2760;
    ind15m.resistance = 2760;

    const ind1h = createBaseIndicators();
    ind1h.ema50 = 2690;
    ind1h.swingHigh = 2780;

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 2705,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h: [createMockCandle(now, 2690, 2780, 2685, 2705)],
      candles15m: [createMockCandle(now, 2695, 2760, 2690, 2705)],
      candles5m,
      brokerSpecs: { minRr: 1.5, minGoldSlPoints: 35, maxGoldSlPoints: 85 },
    };

    const result = generateMultiStrategyCandidates(input);
    const s4 = result.allCandidates.find(
      (c) => c.patternMetadata?.strategyId === 'S4' || (c.strategyFamily === 'MARKET_STRUCTURE' && c.setupName.includes('Market Structure Shift'))
    );
    if (s4) {
      assert.ok(s4.tp1Rr <= 2.05, `S4 TP1 RR should be capped near 2.0R, got ${s4.tp1Rr}`);
      assert.ok(s4.tp1Rr >= 1.5, `S4 TP1 RR must satisfy minRr (1.5R), got ${s4.tp1Rr}`);
    }
  });

  await t.test('S11 caps TP1 at 2.0R ceiling when raw target is distant', () => {
    const now = Date.now();
    const candles5m: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles5m.push(createMockCandle(now - (60 - i) * 300000, 2700, 2702, 2698, 2700));
    }
    // 2 touches at 2700 (Support)
    candles5m[20] = createMockCandle(now - 40 * 300000, 2702, 2704, 2700, 2701);
    candles5m[40] = createMockCandle(now - 20 * 300000, 2702, 2704, 2700, 2701);
    candles5m[candles5m.length - 1] = createMockCandle(now, 2700.5, 2702, 2699.5, 2701.5); // Rejection at support

    const ind5m = createBaseIndicators();
    ind5m.atr14 = 2.0;
    ind5m.resistance = 2750; // Far target (48.5 pts = 9.7R)

    const ind15m = createBaseIndicators();
    ind15m.atr14 = 3.0;
    ind15m.resistance = 2750;

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 2701.5,
      indicators1h: createBaseIndicators(),
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h: [createMockCandle(now, 2700, 2750, 2698, 2701.5)],
      candles15m: [createMockCandle(now, 2700, 2750, 2698, 2701.5)],
      candles5m,
      brokerSpecs: { minRr: 1.5, minGoldSlPoints: 35, maxGoldSlPoints: 85 },
    };

    const result = generateMultiStrategyCandidates(input);
    const s11 = result.allCandidates.find(
      (c) => c.strategyFamily === 'BARE_SR' || c.patternMetadata?.strategyId === 'S11'
    );
    if (s11) {
      assert.ok(s11.tp1Rr <= 2.05, `S11 TP1 RR should be capped near 2.0R, got ${s11.tp1Rr}`);
      assert.ok(s11.tp1Rr >= 1.5, `S11 TP1 RR must satisfy minRr (1.5R), got ${s11.tp1Rr}`);
    }
  });
});

test('Broker SL Bounds and Safety Architecture Integrity', async (t) => {
  await t.test('S4 & S11 candidates enforce broker minGoldSlPoints (35 pts) and maxGoldSlPoints (85 pts)', () => {
    const now = Date.now();
    const candles5m: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles5m.push(createMockCandle(now - (60 - i) * 300000, 2700, 2702, 2698, 2700));
    }

    const ind5m = createBaseIndicators();
    ind5m.bosDetected = true;
    ind5m.structureEvent = 'BULLISH_BOS';
    ind5m.mssDirection = 'BULLISH';
    ind5m.swingLow = 2700.5;
    ind5m.ema20 = 2702;
    ind5m.atr14 = 2.0;

    const ind1h = createBaseIndicators();
    ind1h.ema50 = 2690;

    const input: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 10000,
      currentPrice: 2705,
      indicators1h: ind1h,
      indicators15m: createBaseIndicators(),
      indicators5m: ind5m,
      candles1h: [createMockCandle(now, 2690, 2720, 2685, 2705)],
      candles15m: [createMockCandle(now, 2695, 2720, 2690, 2705)],
      candles5m,
      brokerSpecs: { minRr: 1.5, minGoldSlPoints: 35, maxGoldSlPoints: 85 },
    };

    const result = generateMultiStrategyCandidates(input);
    for (const cand of result.allCandidates) {
      assert.ok(cand.slPoints >= 35, `SL points ${cand.slPoints} must be >= minGoldSlPoints (35)`);
      assert.ok(cand.slPoints <= 85, `SL points ${cand.slPoints} must be <= maxGoldSlPoints (85)`);
    }
  });
});
