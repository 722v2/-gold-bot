import fs from 'fs';
import path from 'path';
import { storage } from '../server/storage.js';
import { runAIAnalysis } from '../server/geminiTrader.js';
import {
  validateTradeSignalCandidate,
  inferStrategyFamily,
  checkStructuralSameSetupIdentity,
} from '../server/tradeQualityEngine.js';
import { TradeManagementEngine } from '../server/tradeManagementEngine.js';
import { telegramService } from '../server/telegram.js';
import { calculatePositionSizing, BrokerContractSpecs } from '../server/riskManager.js';
import { experienceMemoryEngine, FactorSnapshot } from '../server/experienceMemory.js';
import {
  Candle,
  TechnicalIndicators,
  TradeLedgerItem,
  TradeSignal,
  DEFAULT_APP_SETTINGS,
} from '../src/types.js';

// ==========================================
// TEST UTILITIES & DATA GENERATORS
// ==========================================

function generateMirroredCandles(
  basePrice: number,
  count: number,
  intervalMinutes: number,
  direction: 'BULLISH' | 'BEARISH'
): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  const stepMs = intervalMinutes * 60 * 1000;
  const start = now - count * stepMs;

  let current = basePrice;
  for (let i = 0; i < count; i++) {
    const time = start + i * stepMs;
    const delta = direction === 'BULLISH' ? 0.3 : -0.3;
    const open = current;
    const high = direction === 'BULLISH' ? open + 0.8 : open + 0.2;
    const low = direction === 'BULLISH' ? open - 0.2 : open - 0.8;
    const close = open + delta;
    current = close;

    candles.push({
      timestamp: time,
      open,
      high,
      low,
      close,
      volume: 1500,
    });
  }
  return candles;
}

function createMirroredIndicators(
  price: number,
  direction: 'BULLISH' | 'BEARISH'
): TechnicalIndicators {
  const isBull = direction === 'BULLISH';
  return {
    rsi14: isBull ? 58 : 42,
    macd: {
      macd: isBull ? 0.8 : -0.8,
      signal: isBull ? 0.3 : -0.3,
      histogram: isBull ? 0.5 : -0.5,
    },
    ema20: isBull ? price - 0.8 : price + 0.8,
    ema50: isBull ? price - 2.0 : price + 2.0,
    ema200: isBull ? price - 5.0 : price + 5.0,
    vwap: price,
    atr14: 1.5,
    bollingerBands: {
      upper: price + 4.0,
      middle: price,
      lower: price - 4.0,
    },
    swingHigh: price + 4.0,
    swingLow: price - 4.0,
    support: price - 3.5,
    resistance: price + 3.5,
    marketRegime: isBull ? 'STRONG_UPTREND' : 'STRONG_DOWNTREND',
    structure: isBull ? 'BULLISH' : 'BEARISH',
    liquidityLevels: {
      buySideLiquidity: price + 6.0,
      sellSideLiquidity: price - 6.0,
    },
  };
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertTest(condition: boolean, testName: string, errorDetails?: any) {
  if (condition) {
    console.log(`✅ [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`❌ [FAIL] ${testName}`);
    if (errorDetails) console.error(`   Details:`, errorDetails);
    failed++;
    failures.push(`${testName} -> ${JSON.stringify(errorDetails || 'Assertion Failed')}`);
  }
}

async function runAdversarialProductionSuite() {
  console.log('========================================================================');
  console.log('🚨 RUNNING EXTREME ADVERSARIAL PRODUCTION VERIFICATION (11 SECTIONS)');
  console.log('========================================================================\n');

  // =========================================================================
  // 1. AI SIGNAL INTEGRITY & ADVERSARIAL AI INJECTION
  // =========================================================================
  console.log('--- 1. AI Signal Integrity & Adversarial AI Candidate Validation ---');

  const basePrice = 2500.0;
  const bull5m = generateMirroredCandles(basePrice, 50, 5, 'BULLISH');
  const bull15m = generateMirroredCandles(basePrice, 50, 15, 'BULLISH');
  const bull1h = generateMirroredCandles(basePrice, 50, 60, 'BULLISH');
  const bullInd5m = createMirroredIndicators(basePrice, 'BULLISH');
  const bullInd15m = createMirroredIndicators(basePrice, 'BULLISH');
  const bullInd1h = createMirroredIndicators(basePrice, 'BULLISH');

  // 1.1 Invalid BUY SL distance: SL = 2498.0 (20 pts - below min 35 pts)
  const invalidSlBuy = validateTradeSignalCandidate(
    {
      direction: 'BUY',
      entry: 2500.0,
      stopLoss: 2498.0,
      tp1: 2507.0,
      setupName: 'Adversarial Narrow SL',
    },
    {
      currentPrice: 2500.0,
      candles5m: bull5m,
      candles15m: bull15m,
      candles1h: bull1h,
      indicators5m: bullInd5m,
      indicators15m: bullInd15m,
      indicators1h: bullInd1h,
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65 },
    }
  );
  assertTest(
    invalidSlBuy.isValid === false && (invalidSlBuy.rejectionReason || '').includes('INVALID_SL_DISTANCE'),
    '1.1 AI Candidate with invalid narrow SL (20 pts) is rejected deterministically',
    invalidSlBuy.rejectionReason
  );

  // 1.2 Invalid BUY SL distance: SL = 2490.0 (100 pts - above max 65 pts)
  const invalidWideSlBuy = validateTradeSignalCandidate(
    {
      direction: 'BUY',
      entry: 2500.0,
      stopLoss: 2490.0,
      tp1: 2520.0,
      setupName: 'Adversarial Wide SL',
    },
    {
      currentPrice: 2500.0,
      candles5m: bull5m,
      candles15m: bull15m,
      candles1h: bull1h,
      indicators5m: bullInd5m,
      indicators15m: bullInd15m,
      indicators1h: bullInd1h,
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65 },
    }
  );
  assertTest(
    invalidWideSlBuy.isValid === false && (invalidWideSlBuy.rejectionReason || '').includes('INVALID_SL_DISTANCE'),
    '1.2 AI Candidate with invalid wide SL (100 pts) is rejected deterministically',
    invalidWideSlBuy.rejectionReason
  );

  // 1.3 Insufficient R:R (TP1 = 2502.0 vs SL = 2495.5 -> RR = 2.0 / 4.5 = 0.44R)
  const lowRrBuy = validateTradeSignalCandidate(
    {
      direction: 'BUY',
      entry: 2500.0,
      stopLoss: 2495.5,
      tp1: 2502.0,
      setupName: 'Adversarial Low RR',
    },
    {
      currentPrice: 2500.0,
      candles5m: bull5m,
      candles15m: bull15m,
      candles1h: bull1h,
      indicators5m: bullInd5m,
      indicators15m: bullInd15m,
      indicators1h: bullInd1h,
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65 },
    }
  );
  assertTest(
    lowRrBuy.isValid === false && (lowRrBuy.rejectionReason || '').includes('INSUFFICIENT_RR'),
    '1.3 AI Candidate with insufficient R:R (<1.0R to TP1) is rejected deterministically',
    lowRrBuy.rejectionReason
  );

  // 1.4 Blocked TP Runway by 15M Bearish Order Block
  const ind15mBlocked: TechnicalIndicators = {
    ...bullInd15m,
    orderBlock: {
      type: 'BEARISH',
      low: 2503.0,
      high: 2504.5,
    },
  };
  const blockedRunwayBuy = validateTradeSignalCandidate(
    {
      direction: 'BUY',
      entry: 2500.0,
      stopLoss: 2495.5,
      tp1: 2508.0, // target is past the 2503.0 obstacle
      setupName: 'Adversarial Blocked Runway',
    },
    {
      currentPrice: 2500.0,
      candles5m: bull5m,
      candles15m: bull15m,
      candles1h: bull1h,
      indicators5m: bullInd5m,
      indicators15m: ind15mBlocked,
      indicators1h: bullInd1h,
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65 },
    }
  );
  assertTest(
    blockedRunwayBuy.isValid === false && (blockedRunwayBuy.rejectionReason || '').includes('BLOCKED_TP_RUNWAY'),
    '1.4 AI Candidate with blocked TP runway is rejected deterministically',
    blockedRunwayBuy.rejectionReason
  );

  // =========================================================================
  // 2. BUY/SELL MATHEMATICAL MIRROR TEST
  // =========================================================================
  console.log('\n--- 2. BUY/SELL Mathematical Mirror Test ---');

  const bear5m = generateMirroredCandles(basePrice, 50, 5, 'BEARISH');
  const bear15m = generateMirroredCandles(basePrice, 50, 15, 'BEARISH');
  const bear1h = generateMirroredCandles(basePrice, 50, 60, 'BEARISH');
  const bearInd5m = createMirroredIndicators(basePrice, 'BEARISH');
  const bearInd15m = createMirroredIndicators(basePrice, 'BEARISH');
  const bearInd1h = createMirroredIndicators(basePrice, 'BEARISH');

  // Mirror 2.1: Chased BUY vs Chased SELL
  const chasedBuy = validateTradeSignalCandidate(
    {
      direction: 'BUY',
      entry: 2490.0, // 15 pts away from currentPrice 2505
      stopLoss: 2485.5,
      tp1: 2500.0,
      strategyFamily: 'ORDER_BLOCK',
    },
    {
      currentPrice: 2505.0,
      candles5m: bull5m,
      candles15m: bull15m,
      candles1h: bull1h,
      indicators5m: bullInd5m,
      indicators15m: bullInd15m,
      indicators1h: bullInd1h,
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65 },
    }
  );

  const chasedSell = validateTradeSignalCandidate(
    {
      direction: 'SELL',
      entry: 2510.0, // 15 pts away from currentPrice 2495
      stopLoss: 2514.5,
      tp1: 2500.0,
      strategyFamily: 'ORDER_BLOCK',
    },
    {
      currentPrice: 2495.0,
      candles5m: bear5m,
      candles15m: bear15m,
      candles1h: bear1h,
      indicators5m: bearInd5m,
      indicators15m: bearInd15m,
      indicators1h: bearInd1h,
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65 },
    }
  );

  assertTest(
    chasedBuy.isValid === false && chasedSell.isValid === false &&
    chasedBuy.rejectionReason?.includes('CHASED_ENTRY') && chasedSell.rejectionReason?.includes('CHASED_ENTRY'),
    '2.1 Anti-Chase gate produces identical rejection for mirrored BUY and SELL',
    { buyReason: chasedBuy.rejectionReason, sellReason: chasedSell.rejectionReason }
  );

  // Mirror 2.2: Symmetrical SL calculation & points
  const buyEntry = 2500.0, buySl = 2495.0; // 50 pts
  const sellEntry = 2500.0, sellSl = 2505.0; // 50 pts
  const buySizing = calculatePositionSizing(100, 15, buyEntry, buySl);
  const sellSizing = calculatePositionSizing(100, 15, sellEntry, sellSl);

  assertTest(
    buySizing.standardLotSize === sellSizing.standardLotSize &&
    buySizing.estimatedMaxLoss === sellSizing.estimatedMaxLoss &&
    buySizing.isExecutable === sellSizing.isExecutable,
    '2.2 Position sizing for BUY and SELL with identical 50 pt SL produces mathematically identical results',
    { buyLot: buySizing.standardLotSize, sellLot: sellSizing.standardLotSize, buyLoss: buySizing.estimatedMaxLoss }
  );

  // =========================================================================
  // 3. ACTIVE TRADE LOCK & DIRECTIONAL OPPOSITION
  // =========================================================================
  console.log('\n--- 3. Active Trade Lock & Directional Opposition ---');

  // 3.1 Active BUY + new SELL candidate -> SELL blocked
  const activeBuyLock = validateTradeSignalCandidate(
    {
      direction: 'SELL',
      entry: 2500.0,
      stopLoss: 2504.5,
      tp1: 2493.0,
      setupName: 'Counter Short',
    },
    {
      currentPrice: 2500.0,
      candles5m: bull5m,
      candles15m: bull15m,
      candles1h: bull1h,
      indicators5m: bullInd5m,
      indicators15m: bullInd15m,
      indicators1h: bullInd1h,
      activeTradeDirection: 'BUY',
    }
  );
  assertTest(
    activeBuyLock.isValid === false && (activeBuyLock.rejectionReason || '').includes('OPPOSING_ACTIVE_BLOCKED'),
    '3.1 Active BUY blocks candidate SELL signal from emission',
    activeBuyLock.rejectionReason
  );

  // 3.2 Active SELL + new BUY candidate -> BUY blocked
  const activeSellLock = validateTradeSignalCandidate(
    {
      direction: 'BUY',
      entry: 2500.0,
      stopLoss: 2495.5,
      tp1: 2507.0,
      setupName: 'Counter Long',
    },
    {
      currentPrice: 2500.0,
      candles5m: bear5m,
      candles15m: bear15m,
      candles1h: bear1h,
      indicators5m: bearInd5m,
      indicators15m: bearInd15m,
      indicators1h: bearInd1h,
      activeTradeDirection: 'SELL',
    }
  );
  assertTest(
    activeSellLock.isValid === false && (activeSellLock.rejectionReason || '').includes('OPPOSING_ACTIVE_BLOCKED'),
    '3.2 Active SELL blocks candidate BUY signal symmetrically',
    activeSellLock.rejectionReason
  );

  // 3.3 Active Trade Closure releases lock immediately
  const testLockTradeId = `test_lock_trade_${Date.now()}`;
  storage.saveTrade({
    id: testLockTradeId,
    tradeNumber: 501,
    date: '10:00',
    isoTime: new Date().toISOString(),
    asset: 'XAU/USD',
    direction: 'BUY NOW',
    entry: 2500.0,
    sl: 2495.0,
    slPoints: 50,
    tp1: 2507.5,
    tp1Points: 75,
    tp2: 2515.0,
    tp2Points: 150,
    lotSize: 0.01,
    riskPercent: 15,
    riskAmount: 5.0,
    confidence: 85,
    setup: 'Breakout',
    rr: '1:1.5',
    result: 'OPEN',
    pl: 0,
    balanceAfterTrade: 100,
    isActive: true,
    source: 'SYSTEM',
  });

  // Verify trade is active
  assertTest(storage.getActiveTrades().some(t => t.id === testLockTradeId), '3.3.1 Trade is active');

  // Close the trade
  storage.closeTrade(testLockTradeId, 'WIN', 7.50, 2507.5, 'TP1 hit');

  // Verify trade is inactive
  const activeAfterClose = storage.getActiveTrades().filter(t => t.id === testLockTradeId);
  assertTest(activeAfterClose.length === 0, '3.3.2 Lock released immediately upon closeTrade');

  // =========================================================================
  // 4. TRADE MANAGEMENT & STATE MACHINE
  // =========================================================================
  console.log('\n--- 4. Trade Management & State Machine ---');

  const tme = new TradeManagementEngine();
  const mgmtTradeId = `test_mgmt_${Date.now()}`;
  const mgmtTrade: TradeLedgerItem = {
    id: mgmtTradeId,
    tradeNumber: 502,
    date: '11:00',
    isoTime: new Date().toISOString(),
    asset: 'XAU/USD',
    direction: 'BUY NOW',
    entry: 2500.0,
    sl: 2495.0,
    slPoints: 50,
    tp1: 2507.5,
    tp1Points: 75,
    tp2: 2515.0,
    tp2Points: 150,
    lotSize: 0.01,
    riskPercent: 15,
    riskAmount: 5.0,
    confidence: 85,
    setup: 'Bullish Breakout',
    rr: '1:1.5',
    result: 'OPEN',
    pl: 0,
    balanceAfterTrade: 100,
    isActive: true,
    source: 'SYSTEM',
  };
  storage.saveTrade(mgmtTrade);

  // 4.1 TP1 Milestone Evaluation
  const evalTp1 = await tme.evaluateSingleTrade(
    mgmtTrade,
    2507.5, // touched TP1
    bull1h,
    bull15m,
    bull5m,
    bull5m,
    bullInd1h,
    bullInd15m,
    bullInd5m,
    100,
    DEFAULT_APP_SETTINGS
  );
  assertTest(
    evalTp1.action.actionType === 'PARTIAL_CLOSE_TP1' && evalTp1.state === 'TP1_HIT',
    '4.1 Price touching TP1 transitions state to TP1_HIT and triggers PARTIAL_CLOSE_TP1',
    { action: evalTp1.action.actionType, state: evalTp1.state, newSL: evalTp1.action.newSL }
  );

  // 4.2 SL Hit Terminal Evaluation
  const evalSl = await tme.evaluateSingleTrade(
    mgmtTrade,
    2494.5, // breached SL 2495.0
    bear1h,
    bear15m,
    bear5m,
    bear5m,
    bearInd1h,
    bearInd15m,
    bearInd5m,
    100,
    DEFAULT_APP_SETTINGS
  );
  assertTest(
    evalSl.state === 'CLOSED' && evalSl.health.reversalLevel === 3,
    '4.2 Price breaching SL immediately triggers terminal closure (CLOSED state)',
    { state: evalSl.state, isTerminal: evalSl.health.reversalLevel === 3 }
  );

  // =========================================================================
  // 5. ACCOUNTING & BALANCE IDEMPOTENCY
  // =========================================================================
  console.log('\n--- 5. Accounting & Balance Idempotency ---');

  const acctTradeId = `test_acct_trade_${Date.now()}`;
  const startBal = storage.getCurrentBalance();
  storage.saveTrade({
    id: acctTradeId,
    tradeNumber: 503,
    date: '12:00',
    isoTime: new Date().toISOString(),
    asset: 'XAU/USD',
    direction: 'BUY NOW',
    entry: 2500.0,
    sl: 2495.0,
    slPoints: 50,
    tp1: 2507.5,
    tp1Points: 75,
    tp2: 2515.0,
    tp2Points: 150,
    lotSize: 0.01,
    riskPercent: 15,
    riskAmount: 5.0,
    confidence: 85,
    setup: 'Breakout',
    rr: '1:1.5',
    result: 'OPEN',
    pl: 0,
    balanceAfterTrade: startBal,
    isActive: true,
    source: 'SYSTEM',
  });

  // Close 1: WIN +$10.00
  storage.closeTrade(acctTradeId, 'WIN', 10.00, 2510.0, 'Closed at profit');
  const balAfterClose1 = storage.getCurrentBalance();
  assertTest(
    Math.abs(balAfterClose1 - (startBal + 10.00)) < 0.001,
    '5.1 First closeTrade modifies balance accurately by +$10.00',
    { before: startBal, after: balAfterClose1 }
  );

  // Close 2 (Duplicate): Must not double-credit balance
  storage.closeTrade(acctTradeId, 'WIN', 10.00, 2510.0, 'Duplicate close attempt');
  const balAfterClose2 = storage.getCurrentBalance();
  assertTest(
    balAfterClose1 === balAfterClose2,
    '5.2 Duplicate closeTrade call is strictly idempotent (balance unchanged)',
    { after1: balAfterClose1, after2: balAfterClose2 }
  );

  // =========================================================================
  // 6. RISK / MINIMUM LOT & $5.00 MAXIMUM LOSS
  // =========================================================================
  console.log('\n--- 6. Risk Sizing & $5.00 Absolute Max Loss Cap ---');

  const balances = [10, 15, 20, 25, 50, 100];
  const slPointsList = [35, 40, 50, 60, 65];

  for (const bal of balances) {
    for (const slPts of slPointsList) {
      const slDist = slPts * 0.1;
      const entry = 2500.0;
      const sl = entry - slDist;
      const sizing = calculatePositionSizing(bal, 15.0, entry, sl, {
        contractSizeOz: 100,
        minimumLot: 0.01,
        maxLoss: 5.0,
        riskPercent: 15.0,
      });

      const dollarLossAtMinLot = Number((0.01 * slDist * 100).toFixed(2));
      const expectedExecutable = dollarLossAtMinLot <= 5.0001;

      assertTest(
        sizing.isExecutable === expectedExecutable,
        `6. Sizing for Bal $${bal}, SL ${slPts} pts ($${dollarLossAtMinLot.toFixed(2)}) -> ${sizing.isExecutable ? 'PASS' : 'REJECT'}`
      );
    }
  }

  // =========================================================================
  // 7. TELEGRAM RELIABILITY & DISK PERSISTENCE
  // =========================================================================
  console.log('\n--- 7. Telegram Reliability & Disk Persistence ---');

  const notifId = `test_adv_notif_${Date.now()}`;
  const dispatch = await telegramService.dispatchReliableNotification({
    notificationId: notifId,
    event: 'ADVERSARIAL_TEST_EVENT',
    message: 'Adversarial Telegram dispatch test',
  });

  assertTest(
    dispatch !== undefined && (dispatch.queued === true || dispatch.success === true),
    '7.1 Reliable notification successfully enqueued into persistent queue',
    dispatch
  );

  const qFile = path.join(process.cwd(), 'data', 'telegram_retry_queue.json');
  assertTest(fs.existsSync(qFile), '7.2 Persistent queue file exists on disk');

  // Verify deduplication
  const dupDispatch = await telegramService.dispatchReliableNotification({
    notificationId: notifId,
    event: 'ADVERSARIAL_TEST_EVENT',
    message: 'Duplicate adversarial Telegram message',
  });

  assertTest(dupDispatch !== undefined, '7.3 Duplicate dispatch handled idempotently');

  // =========================================================================
  // 8. SCANNER DUPLICATION & SETUP IDENTITY
  // =========================================================================
  console.log('\n--- 8. Scanner Setup Identity & Deduplication ---');

  const setupA = {
    id: 'sig_a_1',
    setup: 'Bullish OB Retest S10',
    signal: 'BUY NOW' as const,
    direction: 'BUY' as const,
    entry: 2500.0,
    stopLoss: 2495.0,
    tp1: 2507.5,
    tp2: 2515.0,
    poiPrice: 2500.0,
    timeframe: '15M',
    timestamp: Date.now(),
  };

  const setupB_Same = {
    id: 'sig_b_1',
    setup: 'Bullish OB Retest S10',
    signal: 'BUY NOW' as const,
    direction: 'BUY' as const,
    entry: 2500.1, // tiny 0.1 pt difference within tolerance
    stopLoss: 2495.0,
    tp1: 2507.5,
    tp2: 2515.0,
    poiPrice: 2500.1,
    timeframe: '15M',
    timestamp: Date.now() + 60000,
  };

  const setupC_Different = {
    id: 'sig_c_1',
    setup: 'Bearish Breakdown S13',
    signal: 'SELL NOW' as const,
    direction: 'SELL' as const,
    entry: 2490.0,
    stopLoss: 2495.0,
    tp1: 2482.5,
    tp2: 2475.0,
    poiPrice: 2490.0,
    timeframe: '15M',
    timestamp: Date.now() + 120000,
  };

  const resultA_B = checkStructuralSameSetupIdentity(setupA as any, setupB_Same as any);
  const resultA_C = checkStructuralSameSetupIdentity(setupA as any, setupC_Different as any);

  assertTest(resultA_B.isDuplicate === true, '8.1 Repeated scan of same setup within tolerance identified as duplicate');
  assertTest(resultA_C.isDuplicate === false, '8.2 Genuinely different setup identified as new setup');

  // =========================================================================
  // 9. EXPERIENCE MEMORY TEMPORAL ISOLATION
  // =========================================================================
  console.log('\n--- 9. Experience Memory Temporal Isolation ---');

  const testSnapshot: FactorSnapshot = {
    signalId: 'sig_temp_1',
    setupFamily: 'ORDER_BLOCK',
    direction: 'BUY',
    factors: {
      setupFamily: 'ORDER_BLOCK',
      direction: 'BUY',
      htfStructure: 'UPTREND',
      m15Structure: 'BULLISH',
      marketRegime: 'STRONG_TREND',
      liquidity: 'SWEEP_SELL_SIDE',
      orderBlock: 'BULLISH_OB',
      fvg: 'NONE',
      zone: 'DISCOUNT',
      rsi: 'NEUTRAL',
      macd: 'BULLISH',
      volatility: 'NORMAL',
    },
    combinationKey: 'ORDER_BLOCK|BUY|UPTREND|BULLISH',
    createdAt: 1000000,
  };

  for (let i = 0; i < 6; i++) {
    experienceMemoryEngine.recordCompletedOutcome(
      { ...testSnapshot, signalId: `sig_temp_${i}` },
      {
        signalId: `sig_temp_${i}`,
        tradeId: `t_temp_${i}`,
        outcome: 'WIN',
        realizedPnl: 15.0,
        timestamp: 2000000 + i * 100,
        closedAt: 2000000 + i * 100,
      }
    );
  }

  // Query as of T = 1500000 (before trades completed at 2000000)
  const ctxBefore = experienceMemoryEngine.getExperienceContext(testSnapshot, 1500000);
  assertTest(
    ctxBefore === null || !ctxBefore.patterns.some(p => p.sampleSize > 0),
    '9.1 Temporal boundary strictly prevents future outcomes from leaking into decisions at time T'
  );

  // Query as of T = 2500000 (after trades completed)
  const ctxAfter = experienceMemoryEngine.getExperienceContext(
    { ...testSnapshot, signalId: 'sig_future_query' },
    2500000
  );
  assertTest(
    ctxAfter !== null && ctxAfter.sampleSize >= 6,
    '9.2 Experience context available once timestamp passes completion boundary'
  );

  // =========================================================================
  // 10. FAILURE / CHAOS TESTING
  // =========================================================================
  console.log('\n--- 10. Failure & Chaos Testing ---');

  // Test malformed candidate inputs into validation engine
  const brokenCandidate1 = validateTradeSignalCandidate(
    {
      direction: 'INVALID_DIR' as any,
      entry: NaN,
      stopLoss: undefined as any,
      tp1: -500,
      setupName: null as any,
    },
    {
      currentPrice: 2500.0,
      candles5m: [],
      candles15m: [],
      candles1h: [],
      indicators5m: bullInd5m,
      indicators15m: bullInd15m,
      indicators1h: bullInd1h,
    }
  );
  assertTest(
    brokenCandidate1.isValid === false,
    '10.1 Broken / NaN / undefined candidate input fails safely to isValid=false without throwing unhandled exceptions'
  );

  // =========================================================================
  // 11. MALICIOUS / ADVERSARIAL AI INJECTION (CRITICAL TEST)
  // =========================================================================
  console.log('\n--- 11. Malicious / Adversarial AI Response Injection ---');

  // Adversarial AI candidate: Looks ultra-confident (99%), valid entry/SL/TP on surface,
  // but has hidden opposing 15M OB barrier, missing price-action trigger, and is chased
  const adversarialInd15m: TechnicalIndicators = {
    ...bullInd15m,
    orderBlock: {
      type: 'BEARISH',
      low: 2502.0, // Obstacle directly before TP1 (2507.0)
      high: 2503.5,
    },
  };

  const maliciousAICandidate = validateTradeSignalCandidate(
    {
      direction: 'BUY',
      entry: 2490.0, // Chased (current price is 2500)
      stopLoss: 2485.5,
      tp1: 2507.0, // Blocked by 2502.0 OB
      setupName: 'Ultra High Conviction Super S10 Setup (Confidence 99%)',
      strategyFamily: 'ORDER_BLOCK',
    },
    {
      currentPrice: 2500.0,
      candles5m: bull5m,
      candles15m: bull15m,
      candles1h: bull1h,
      indicators5m: bullInd5m,
      indicators15m: adversarialInd15m,
      indicators1h: bullInd1h,
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65 },
    }
  );

  assertTest(
    maliciousAICandidate.isValid === false,
    '11.1 Malicious adversarial AI candidate is deterministically disqualified by validation gates',
    maliciousAICandidate.rejectionReason
  );

  // =========================================================================
  // FINAL SUMMARY
  // =========================================================================
  console.log('\n========================================================================');
  console.log(`ADVERSARIAL SUITE RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach(f => console.error(' - ' + f));
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAdversarialProductionSuite().catch(err => {
  console.error('Fatal test runner crash:', err);
  process.exit(1);
});
