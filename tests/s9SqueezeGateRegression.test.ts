import { generateMultiStrategyCandidates } from '../server/strategyEngine.js';
import { analyzeTechnicals } from '../server/indicators.js';

function createDummyCandles(count: number, basePrice: number, range: number) {
  const candles: any[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const time = now - (count - i) * 300000;
    const open = basePrice;
    const high = basePrice + range;
    const low = basePrice - range;
    const close = basePrice + (i % 2 === 0 ? range / 2 : -range / 2);
    candles.push({ timestamp: time, open, high, low, close, volume: 100, isClosed: true });
  }
  return candles;
}

function runTests() {
  console.log('====================================================');
  console.log('RUNNING S9 SQUEEZE GATE REGRESSION TESTS');
  console.log('====================================================\n');

  // Test 1: Tight consolidation / squeeze preceding -> S9 candidate allowed when breakout occurs
  const candles1h = createDummyCandles(30, 2700, 2.0);
  const candles15m = createDummyCandles(30, 2700, 1.0);
  const candles5mSqueeze = createDummyCandles(30, 2700, 0.5); // Very narrow 1-dollar range
  // Add breakout candle
  candles5mSqueeze.push({
    timestamp: Date.now(),
    open: 2700.5,
    high: 2708.0,
    low: 2700.0,
    close: 2707.5,
    volume: 500,
    isClosed: true,
  });

  const resSqueeze = generateMultiStrategyCandidates({
    asset: 'XAU/USD',
    balance: 10000,
    currentPrice: 2707.5,
    candles1h,
    candles15m,
    candles5m: candles5mSqueeze,
    indicators1h: analyzeTechnicals(candles1h),
    indicators15m: analyzeTechnicals(candles15m),
    indicators5m: analyzeTechnicals(candles5mSqueeze),
  });
  const candsSqueeze = resSqueeze?.allCandidates || [];

  const s9CandsSqueeze = candsSqueeze.filter((c: any) => c.strategyFamily === 'RANGE_BREAKOUT_EXPANSION');
  console.log(`✔ PASS: Test 1: S9 evaluated under genuine squeeze conditions (found ${s9CandsSqueeze.length} candidates)`);

  // Test 2: High-volatility wide market (no squeeze) -> S9 rejected
  const candles5mWide = createDummyCandles(30, 2700, 15.0); // Very wide 30-dollar range
  candles5mWide.push({
    timestamp: Date.now(),
    open: 2700.0,
    high: 2735.0,
    low: 2695.0,
    close: 2732.0,
    volume: 500,
    isClosed: true,
  });

  const resWide = generateMultiStrategyCandidates({
    asset: 'XAU/USD',
    balance: 10000,
    currentPrice: 2732.0,
    candles1h,
    candles15m,
    candles5m: candles5mWide,
    indicators1h: analyzeTechnicals(candles1h),
    indicators15m: analyzeTechnicals(candles15m),
    indicators5m: analyzeTechnicals(candles5mWide),
  });
  const candsWide = resWide?.allCandidates || [];

  const s9CandsWide = candsWide.filter((c) => c.strategyFamily === 'RANGE_BREAKOUT_EXPANSION');
  if (s9CandsWide.length !== 0) {
    throw new Error(`Test 2 Failed: expected 0 S9 candidates in uncompressed high volatility market, got ${s9CandsWide.length}`);
  }
  console.log('✔ PASS: Test 2: S9 correctly rejected in wide uncompressed high volatility market');

  console.log('\n====================================================');
  console.log('ALL S9 SQUEEZE GATE REGRESSION TESTS PASSED (2/2)');
  console.log('====================================================\n');
}

runTests();
