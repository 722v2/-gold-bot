process.env.IS_TESTING = 'true';
import fs from 'fs';
import path from 'path';
import { storage } from '../server/storage.js';
import { validateTradeSignalCandidate } from '../server/tradeQualityEngine.js';
import { tradeManagementEngine } from '../server/tradeManagementEngine.js';
import { telegramService, QueuedTelegramNotification } from '../server/telegram.js';
import { Candle, TechnicalIndicators, TradeLedgerItem } from '../src/types.js';

function createMockCandles(basePrice: number, count: number, trend: 'UP' | 'DOWN' | 'FLAT' = 'FLAT'): Candle[] {
  const candles: Candle[] = [];
  let current = basePrice;
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const time = now - (count - i) * 5 * 60 * 1000;
    const delta = trend === 'UP' ? 0.3 : trend === 'DOWN' ? -0.3 : (i % 2 === 0 ? 0.1 : -0.1);
    const open = current;
    const close = current + delta;
    const high = Math.max(open, close) + 0.4;
    const low = Math.min(open, close) - 0.4;
    candles.push({ timestamp: time, open, high, low, close, volume: 100 });
    current = close;
  }
  return candles;
}

function createMockIndicators(price: number): TechnicalIndicators {
  return {
    rsi14: 50,
    macd: { macd: 0, signal: 0, histogram: 0 },
    ema20: price - 0.2,
    ema50: price - 0.5,
    ema200: price - 2.0,
    vwap: price,
    atr14: 1.2,
    bollingerBands: {
      upper: price + 2.0,
      middle: price,
      lower: price - 2.0,
    },
    swingHigh: price + 2.0,
    swingLow: price - 2.0,
    support: price - 1.5,
    resistance: price + 1.5,
    marketRegime: 'STRONG_UPTREND',
    structure: 'BULLISH',
  };
}

async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING PRODUCTION PIPELINE & TELEGRAM RETRY TESTS');
  console.log('====================================================\n');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, testName: string, details: string) {
    total++;
    if (condition) {
      passed++;
      console.log(`✅ [PASS] Test ${total}: ${testName}`);
      console.log(`   ${details}`);
    } else {
      console.error(`❌ [FAIL] Test ${total}: ${testName}`);
      console.error(`   ${details}`);
    }
  }

  // TEST 1: Reject AI candidate with invalid SL distance
  {
    const price = 2500.0;
    const candles5m = createMockCandles(price, 30, 'UP');
    const ind5m = createMockIndicators(price);
    const ind15m = createMockIndicators(price);
    const ind1h = createMockIndicators(price);

    // AI proposed BUY with only 10 pts SL (invalid, min is 35)
    const resultInvalidSL = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2500.0,
        stopLoss: 2499.0, // 10 pts
        tp1: 2508.0,
        setupName: 'AI Breakout',
      },
      {
        currentPrice: price,
        candles5m,
        candles15m: candles5m,
        candles1h: candles5m,
        indicators5m: ind5m,
        indicators15m: ind15m,
        indicators1h: ind1h,
      }
    );

    assert(
      !resultInvalidSL.isValid && resultInvalidSL.rejectionReason?.includes('INVALID_SL_DISTANCE'),
      'AI Candidate Invalid SL Distance Rejection',
      `Result: isValid=${resultInvalidSL.isValid}, reason=${resultInvalidSL.rejectionReason}`
    );
  }

  // TEST 2: Reject AI candidate with opposing active trade
  {
    const price = 2500.0;
    const candles5m = createMockCandles(price, 30, 'UP');
    const ind5m = createMockIndicators(price);
    const ind15m = createMockIndicators(price);
    const ind1h = createMockIndicators(price);

    const resultOpposing = validateTradeSignalCandidate(
      {
        direction: 'SELL',
        entry: 2500.0,
        stopLoss: 2504.5,
        tp1: 2490.0,
        setupName: 'AI Counter Scalp',
      },
      {
        currentPrice: price,
        candles5m,
        candles15m: candles5m,
        candles1h: candles5m,
        indicators5m: ind5m,
        indicators15m: ind15m,
        indicators1h: ind1h,
        activeTradeDirection: 'BUY', // active trade is BUY
      }
    );

    assert(
      !resultOpposing.isValid && resultOpposing.rejectionReason?.includes('OPPOSING_ACTIVE_BLOCKED'),
      'AI Candidate Opposing Active Trade Block',
      `Result: isValid=${resultOpposing.isValid}, reason=${resultOpposing.rejectionReason}`
    );
  }

  // TEST 3: Symmetrical active trade opposition for SELL
  {
    const price = 2500.0;
    const candles5m = createMockCandles(price, 30, 'DOWN');
    const ind5m = createMockIndicators(price);
    const ind15m = createMockIndicators(price);
    const ind1h = createMockIndicators(price);

    const resultOpposingBuy = validateTradeSignalCandidate(
      {
        direction: 'BUY',
        entry: 2500.0,
        stopLoss: 2495.5,
        tp1: 2510.0,
        setupName: 'AI Buy Dip',
      },
      {
        currentPrice: price,
        candles5m,
        candles15m: candles5m,
        candles1h: candles5m,
        indicators5m: ind5m,
        indicators15m: ind15m,
        indicators1h: ind1h,
        activeTradeDirection: 'SELL', // active trade is SELL
      }
    );

    assert(
      !resultOpposingBuy.isValid && resultOpposingBuy.rejectionReason?.includes('OPPOSING_ACTIVE_BLOCKED'),
      'AI Candidate Opposing Active SELL Trade Block (Directional Symmetry)',
      `Result: isValid=${resultOpposingBuy.isValid}, reason=${resultOpposingBuy.rejectionReason}`
    );
  }

  // TEST 4: Confirmed Reversal Level 3 (BUY trade -> Bearish Reversal EARLY_EXIT)
  {
    const buyTradeId = `test_reversal_buy_${Date.now()}`;
    const initialBalance = storage.getCurrentBalance();
    const buyTrade: TradeLedgerItem = {
      id: buyTradeId,
      tradeNumber: 1,
      date: '12:00',
      isoTime: new Date().toISOString(),
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 2500.0,
      sl: 2495.5,
      slPoints: 45,
      tp1: 2508.0,
      tp1Points: 80,
      tp2: 2520.0,
      tp2Points: 200,
      lotSize: 0.01,
      riskPercent: 1.5,
      riskAmount: 4.5,
      confidence: 85,
      setup: 'Test Bullish Setup',
      rr: '1:1.7',
      result: 'OPEN',
      pl: 0,
      balanceAfterTrade: 100,
      isActive: true,
      source: 'SYSTEM',
    };
    storage.saveTrade(buyTrade);

    // Create bearish reversal market structure
    const candles15mReversal: Candle[] = [
      { timestamp: Date.now() - 45 * 60000, open: 2505, high: 2506, low: 2498, close: 2499, volume: 100 },
      { timestamp: Date.now() - 30 * 60000, open: 2499, high: 2500, low: 2494, close: 2495, volume: 100 },
      { timestamp: Date.now() - 15 * 60000, open: 2495, high: 2496, low: 2490, close: 2491, volume: 100 },
      { timestamp: Date.now(), open: 2491, high: 2492, low: 2486, close: 2487, volume: 100 },
    ];
    const ind1hOpposing: TechnicalIndicators = {
      rsi14: 30,
      macd: { macd: -1.5, signal: -1.0, histogram: -0.5 },
      ema20: 2490,
      ema50: 2495,
      ema200: 2500,
      vwap: 2495,
      atr14: 1.5,
      bollingerBands: { upper: 2505, middle: 2495, lower: 2485 },
      swingHigh: 2505,
      swingLow: 2485,
      support: 2485,
      resistance: 2505,
      marketRegime: 'STRONG_DOWNTREND',
      structure: 'BEARISH',
    };

    const action = tradeManagementEngine.determineManagementAction(
      buyTrade,
      {
        tradeId: buyTrade.id,
        direction: 'BUY',
        currentPrice: 2487.0,
        entryPrice: 2500.0,
        slPrice: 2495.5,
        tp1Price: 2508.0,
        tp2Price: 2520.0,
        lotSize: 0.01,
        floatingPnl: -13.0,
        currentR: -1.0,
        distanceToSlPoints: -85,
        distanceToTp1Points: 210,
        distanceToTp2Points: 330,
        tp1ProgressPct: 0,
        tp2ProgressPct: 0,
        regimeAlignment: 'OPPOSING',
        structureHealth: 'REVERSED',
        pullbackQuality: 'DEEP_DANGEROUS',
        oppositePressureScore: 90,
        reversalLevel: 3,
        isOriginalThesisValid: false,
        notes: ['Confirmed Bearish Reversal'],
      },
      2487.0,
      2500.0,
      2495.5,
      2508.0,
      2520.0,
      candles15mReversal,
      candles15mReversal,
      ind1hOpposing,
      ind1hOpposing,
      {} as any
    );

    assert(
      action.actionType === 'EARLY_EXIT' && action.managementState === 'EARLY_EXIT',
      'Confirmed Bearish Reversal generates EARLY_EXIT action',
      `Action: ${action.actionType}, State: ${action.managementState}`
    );
  }

  // TEST 5: Confirmed Reversal Level 3 (SELL trade -> Bullish Reversal EARLY_EXIT)
  {
    const sellTradeId = `test_reversal_sell_${Date.now()}`;
    const sellTrade: TradeLedgerItem = {
      id: sellTradeId,
      tradeNumber: 2,
      date: '12:00',
      isoTime: new Date().toISOString(),
      asset: 'XAU/USD',
      direction: 'SELL NOW',
      entry: 2500.0,
      sl: 2504.5,
      slPoints: 45,
      tp1: 2492.0,
      tp1Points: 80,
      tp2: 2480.0,
      tp2Points: 200,
      lotSize: 0.01,
      riskPercent: 1.5,
      riskAmount: 4.5,
      confidence: 85,
      setup: 'Test Bearish Setup',
      rr: '1:1.7',
      result: 'OPEN',
      pl: 0,
      balanceAfterTrade: 100,
      isActive: true,
      source: 'SYSTEM',
    };
    storage.saveTrade(sellTrade);

    const ind1hBullish: TechnicalIndicators = {
      rsi14: 70,
      macd: { macd: 1.5, signal: 1.0, histogram: 0.5 },
      ema20: 2510,
      ema50: 2505,
      ema200: 2500,
      vwap: 2505,
      atr14: 1.5,
      bollingerBands: { upper: 2515, middle: 2505, lower: 2495 },
      swingHigh: 2515,
      swingLow: 2495,
      support: 2495,
      resistance: 2515,
      marketRegime: 'STRONG_UPTREND',
      structure: 'BULLISH',
    };

    const candles15mBullishReversal: Candle[] = [
      { timestamp: Date.now() - 45 * 60000, open: 2495, high: 2506, low: 2494, close: 2505, volume: 100 },
      { timestamp: Date.now() - 30 * 60000, open: 2505, high: 2510, low: 2504, close: 2509, volume: 100 },
      { timestamp: Date.now() - 15 * 60000, open: 2509, high: 2515, low: 2508, close: 2513, volume: 100 },
      { timestamp: Date.now(), open: 2513, high: 2516, low: 2512, close: 2515, volume: 100 },
    ];

    const action = tradeManagementEngine.determineManagementAction(
      sellTrade,
      {
        tradeId: sellTrade.id,
        direction: 'SELL',
        currentPrice: 2513.0,
        entryPrice: 2500.0,
        slPrice: 2504.5,
        tp1Price: 2492.0,
        tp2Price: 2480.0,
        lotSize: 0.01,
        floatingPnl: -13.0,
        currentR: -1.0,
        distanceToSlPoints: -85,
        distanceToTp1Points: 210,
        distanceToTp2Points: 330,
        tp1ProgressPct: 0,
        tp2ProgressPct: 0,
        regimeAlignment: 'OPPOSING',
        structureHealth: 'REVERSED',
        pullbackQuality: 'DEEP_DANGEROUS',
        oppositePressureScore: 90,
        reversalLevel: 3,
        isOriginalThesisValid: false,
        notes: ['Confirmed Bullish Reversal'],
      },
      2513.0,
      2500.0,
      2504.5,
      2492.0,
      2480.0,
      candles15mBullishReversal,
      candles15mBullishReversal,
      ind1hBullish,
      ind1hBullish,
      {} as any
    );

    assert(
      action.actionType === 'EARLY_EXIT' && action.managementState === 'EARLY_EXIT',
      'Confirmed Bullish Reversal generates EARLY_EXIT action (Directional Symmetry)',
      `Action: ${action.actionType}, State: ${action.managementState}`
    );
  }

  // TEST 6: Telegram Reliable Queue Idempotent Deduplication
  {
    telegramService.clearRetryQueue();
    const testNotifId = `test_idempotent_${Date.now()}`;
    
    // First dispatch
    const res1 = await telegramService.dispatchReliableNotification({
      notificationId: testNotifId,
      tradeId: 't1',
      event: 'SIGNAL_NEW',
      message: 'Test Signal Message 1',
    });

    // Check queue
    const queue = telegramService.getNotificationQueue();
    const item = queue.find(q => q.notificationId === testNotifId);
    assert(
      item !== undefined,
      'Notification successfully registered in persistent retry queue',
      `Queue size=${queue.length}, Item status=${item?.status}`
    );

    // Second dispatch of same notificationId
    const res2 = await telegramService.dispatchReliableNotification({
      notificationId: testNotifId,
      tradeId: 't1',
      event: 'SIGNAL_NEW',
      message: 'Test Signal Message Duplicate',
    });

    const queueAfter = telegramService.getNotificationQueue();
    const duplicates = queueAfter.filter(q => q.notificationId === testNotifId);
    assert(
      duplicates.length === 1,
      'Idempotent duplicate prevention ensures exactly one entry per notificationId',
      `Entries found=${duplicates.length}`
    );
  }

  // TEST 7: Telegram Queue Persistence to disk
  {
    const queuePath = path.join(process.cwd(), 'data', 'telegram_retry_queue.json');
    const exists = fs.existsSync(queuePath);
    assert(
      exists,
      'Telegram retry queue persists to data/telegram_retry_queue.json on disk',
      `File exists: ${exists}`
    );
  }

  // TEST 8: Balance integrity & single liquidation
  {
    const balanceBefore = storage.getCurrentBalance();
    const testTradeId = `test_balance_protect_${Date.now()}`;
    const testTrade: TradeLedgerItem = {
      id: testTradeId,
      tradeNumber: 3,
      date: '12:00',
      isoTime: new Date().toISOString(),
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 2500.0,
      sl: 2495.0,
      slPoints: 50,
      tp1: 2510.0,
      tp1Points: 100,
      tp2: 2520.0,
      tp2Points: 200,
      lotSize: 0.01,
      riskPercent: 1.5,
      riskAmount: 5.0,
      confidence: 85,
      setup: 'Test Trade',
      rr: '1:2',
      result: 'OPEN',
      pl: 0,
      balanceAfterTrade: balanceBefore,
      isActive: true,
      source: 'SYSTEM',
    };
    storage.saveTrade(testTrade);

    // Close trade first time
    storage.closeTrade(testTradeId, 'WIN', 10.0, 2510.0, 'Closed TP1');
    const balanceAfter1 = storage.getCurrentBalance();

    // Attempt closing second time
    storage.closeTrade(testTradeId, 'WIN', 10.0, 2510.0, 'Duplicate Close Attempt');
    const balanceAfter2 = storage.getCurrentBalance();

    assert(
      balanceAfter1 === balanceAfter2 && balanceAfter1 === Number((balanceBefore + 10.0).toFixed(2)),
      'Account balance cannot be double-credited or modified twice on duplicate close',
      `Before: $${balanceBefore}, After 1: $${balanceAfter1}, After 2: $${balanceAfter2}`
    );
  }

  console.log('\n====================================================');
  console.log(`SUMMARY: ${passed}/${total} PASSED`);
  console.log('====================================================\n');

  if (passed !== total) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
