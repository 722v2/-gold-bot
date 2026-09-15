import { fetchLiveQuote, priceCache } from '../server/marketData.js';
import { generateMultiStrategyCandidates } from '../server/strategyEngine.js';
import { storage } from '../server/storage.js';
import { TradeSignal, Candle, TechnicalIndicators } from '../src/types.js';

async function runRegressionSuite() {
  console.log('====================================================');
  console.log('🧪 PRODUCTION REGRESSION VERIFICATION SUITE');
  console.log('   1. Live Price Integrity (P0)');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName}${detail ? ': ' + detail : ''}`);
      failed++;
    }
  }

  await storage.waitUntilReady();

  // =========================================================================
  // 1. LIVE PRICE INTEGRITY (P0)
  // =========================================================================
  console.log('\n--- 1. Live Price Integrity Tests ---');

  // Test 1.1: Missing / invalid bid or ask throws error and does not return synthetic values
  const originalFetch = global.fetch;
  try {
    // Mock fetch returning missing bid/ask
    global.fetch = async () =>
      new Response(JSON.stringify({ bid: 0, ask: 0, price: 0 }), { status: 200 });

    // Clear memory cache
    delete (priceCache as any)['XAUUSD'];

    let threw = false;
    try {
      await fetchLiveQuote('XAU/USD');
    } catch (err: any) {
      threw = true;
      assert(
        err.message.includes('Missing or invalid bid/ask') || err.message.includes('Invalid'),
        '1.1 Missing Bid/Ask throws descriptive error rather than generating synthetic quote',
        err.message
      );
    }
    assert(threw, '1.1 Missing Bid/Ask strictly rejected');
  } finally {
    global.fetch = originalFetch;
  }

  // Test 1.2: Biquote network error / timeout throws rather than returning stale cached quote
  try {
    // Seed priceCache with older quote
    (priceCache as any)['XAUUSD'] = {
      data: {
        symbol: 'XAUUSD',
        bid: 2500.0,
        ask: 2500.2,
        mid: 2500.1,
        last: 2500.1,
        spread: 0.2,
        high: 2510.0,
        low: 2490.0,
        direction: 'FLAT',
        dayDiffPercent: 0,
        marketState: 'open',
        source: 'Biquote MT5 Feed',
        timestamp: new Date().toISOString(),
      },
      cachedAt: Date.now() - 5000, // Expired cache (> 3s TTL)
    };

    // Mock network failure
    global.fetch = async () => {
      throw new Error('Connection timed out to Biquote');
    };

    let threw = false;
    try {
      await fetchLiveQuote('XAU/USD');
    } catch (err: any) {
      threw = true;
      assert(
        err.message.includes('Biquote live quote unavailable') || err.message.includes('timed out'),
        '1.2 Network error throws error and refuses to fall back to stale cache for live signals',
        err.message
      );
    }
    assert(threw, '1.2 Stale cache strictly rejected on network error');
  } finally {
    global.fetch = originalFetch;
    delete (priceCache as any)['XAUUSD'];
  }

  // Test 1.3: Strategy Engine rejects missing / 0.00 current price
  const dummyInd: TechnicalIndicators = {
    rsi14: 50,
    atr14: 3.5,
    ema20: 4300,
    ema50: 4300,
    ema200: 4300,
    vwap: 4300,
    macd: { macd: 0, signal: 0, histogram: 0 },
    bollingerBands: { upper: 4310, middle: 4300, lower: 4290 },
    structure: 'BULLISH',
    marketRegime: 'STRONG_UPTREND',
    trendStructure: 'HH_HL',
    premiumDiscountZone: 'DISCOUNT',
    support: 4290,
    resistance: 4310,
    swingHigh: 4315,
    swingLow: 4285,
  };
  const dummyCandles: Candle[] = [
    { open: 4300, high: 4305, low: 4295, close: 4302, volume: 100, timestamp: Date.now() },
  ];

  const engineResZeroPrice = generateMultiStrategyCandidates({
    asset: 'XAU/USD',
    balance: 1000,
    currentPrice: 0, // INVALID / ZERO PRICE
    indicators1h: dummyInd,
    indicators15m: dummyInd,
    indicators5m: dummyInd,
    candles1h: dummyCandles,
    candles15m: dummyCandles,
    candles5m: dummyCandles,
  });

  assert(
    engineResZeroPrice.hasValidSignal === false && engineResZeroPrice.finalSignal.signal === 'NO TRADE',
    '1.3 Strategy Engine generates 0 trade alerts when live price is 0 or invalid'
  );

  // =========================================================================
  // 3. MANUAL WIN/LOSS OUTCOME ENTRY AND REALIZED P&L RECORDING (P0)
  // =========================================================================
  console.log('\n--- 3. Manual Win/Loss & Realized P&L Tests ---');

  const testSignalId = `sig_test_${Date.now()}`;
  const mockSignal: TradeSignal = {
    id: testSignalId,
    timestamp: Date.now(),
    asset: 'XAU/USD',
    signal: 'BUY NOW',
    currentPrice: 4300,
    entry: 4300,
    stopLoss: 4295,
    tp1: 4310,
    tp2: 4320,
    slPoints: 50,
    tp1Points: 100,
    tp2Points: 200,
    tp1Rr: 2,
    tp2Rr: 4,
    tp1RrString: '1:2.0',
    tp2RrString: '1:4.0',
    setup: 'Bullish Order Block',
    setupId: `setup_S1_${Date.now()}`,
    timeframe: '5M',
    confidence: 80,
    mainReasons: [],
    invalidation: 'Break below swing low',
  } as any;

  storage.saveSignal(mockSignal);
  storage.saveTrade({
    id: testSignalId,
    signalId: testSignalId,
    type: 'BUY',
    entry: 4300.0,
    stopLoss: 4295.0,
    tp1: 4310.0,
    tp2: 4320.0,
    lotSize: 0.01,
    time: new Date().toLocaleTimeString(),
    isoTime: new Date().toISOString(),
    strategy: 'REVERSAL',
    setup: 'Double Bottom Reversal',
    result: 'OPEN',
    isActive: true,
    rr: '1:2.0',
    riskPercent: 15,
    riskAmount: 1.5,
    confidence: 80,
    pl: 0,
    balanceAfterTrade: 25,
  } as any);

  // Record a WIN outcome manually in storage
  const outcomeRes = storage.recordTradeOutcome({
    signalId: testSignalId,
    tradeId: testSignalId,
    direction: 'BUY NOW',
    orderType: 'MARKET',
    entry: 4300,
    stopLoss: 4295,
    tp1: 4310,
    tp2: 4320,
    outcome: 'WIN',
    realizedPnl: 17.78,
    source: 'MANUAL',
    timestamp: Date.now(),
    isoTime: new Date().toISOString(),
  });

  assert(
    outcomeRes.success === true,
    '3.1 Trade outcome recorded manually in storage successfully'
  );

  // Verify trade outcome recorded in storage
  const outcomeHistory = storage.getTradeOutcomes(10);
  const recordedItem = outcomeHistory.find((o) => o.signalId === testSignalId);
  assert(
    recordedItem !== undefined && recordedItem.realizedPnl === 17.78 && recordedItem.outcome === 'WIN',
    '3.2 Trade outcome persisted accurately in storage with realizedPnl: 17.78'
  );

  // Summary
  console.log('\n====================================================');
  console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runRegressionSuite().catch((err) => {
  console.error('Test suite error:', err);
  process.exit(1);
});
