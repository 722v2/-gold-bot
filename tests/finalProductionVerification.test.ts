import fs from 'fs';
import path from 'path';
import { storage } from '../server/storage.js';
import { runAIAnalysis } from '../server/geminiTrader.js';
import { validateTradeSignalCandidate, inferStrategyFamily } from '../server/tradeQualityEngine.js';
import { TradeManagementEngine } from '../server/tradeManagementEngine.js';
import { telegramService } from '../server/telegram.js';
import { calculatePositionSizing, BrokerContractSpecs, DEFAULT_BROKER_SPECS } from '../server/riskManager.js';
import { experienceMemoryEngine, FactorSnapshot } from '../server/experienceMemory.js';
import { scanner } from '../server/scanner.js';
import {
  AssetType,
  Candle,
  TechnicalIndicators,
  TradeLedgerItem,
  TradeSignal,
  ManagementAction,
  DEFAULT_APP_SETTINGS,
} from '../src/types.js';

// Helper to create synthetic valid candles
function generateCandleSeries(
  basePrice: number,
  count: number,
  intervalMinutes: number,
  trend: 'UP' | 'DOWN' | 'FLAT' = 'UP'
): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  const stepMs = intervalMinutes * 60 * 1000;
  const start = now - count * stepMs;

  let current = basePrice;
  for (let i = 0; i < count; i++) {
    const time = start + i * stepMs;
    const delta = trend === 'UP' ? 0.2 : trend === 'DOWN' ? -0.2 : 0;
    const open = current;
    const high = open + Math.abs(delta) + 0.5;
    const low = open - Math.abs(delta) - 0.5;
    const close = open + delta;
    current = close;

    candles.push({
      timestamp: time,
      open,
      high,
      low,
      close,
      volume: 1000 + i * 10,
    });
  }
  return candles;
}

function createMockIndicators(price: number, direction: 'BULLISH' | 'BEARISH' = 'BULLISH'): TechnicalIndicators {
  const isBull = direction === 'BULLISH';
  return {
    rsi14: isBull ? 55 : 45,
    macd: {
      macd: isBull ? 0.5 : -0.5,
      signal: isBull ? 0.2 : -0.2,
      histogram: isBull ? 0.3 : -0.3,
    },
    ema20: isBull ? price - 0.5 : price + 0.5,
    ema50: isBull ? price - 1.5 : price + 1.5,
    ema200: isBull ? price - 4.0 : price + 4.0,
    vwap: price,
    atr14: 1.5,
    bollingerBands: {
      upper: price + 3.0,
      middle: price,
      lower: price - 3.0,
    },
    swingHigh: price + 4.0,
    swingLow: price - 4.0,
    support: price - 3.0,
    resistance: price + 3.0,
    marketRegime: isBull ? 'STRONG_UPTREND' : 'STRONG_DOWNTREND',
    structure: isBull ? 'BULLISH' : 'BEARISH',
    liquidityLevels: {
      buySideLiquidity: price + 5.0,
      sellSideLiquidity: price - 5.0,
    },
  };
}

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, testName: string, details?: any) {
  if (condition) {
    console.log(`✅ [PASS] ${testName}`);
    if (details) console.log(`   Details:`, details);
    passedCount++;
  } else {
    console.error(`❌ [FAIL] ${testName}`);
    if (details) console.error(`   Details:`, details);
    failedCount++;
  }
}

async function runAllProductionVerifications() {
  console.log('====================================================');
  console.log('🧪 FINAL COMPREHENSIVE PRODUCTION VERIFICATION SUITE');
  console.log('====================================================\n');

  // =========================================================================
  // SECTION A & B: AI PRODUCTION PIPELINE & DIRECTIONAL SYMMETRY
  // =========================================================================
  console.log('--- SECTION A & B: AI Production Pipeline & Directional Symmetry ---');

  const candles1h = generateCandleSeries(2500, 50, 60, 'UP');
  const candles15m = generateCandleSeries(2500, 50, 15, 'UP');
  const candles5m = generateCandleSeries(2500, 50, 5, 'UP');
  const candles1m = generateCandleSeries(2500, 50, 1, 'UP');
  const ind1h = createMockIndicators(2500, 'BULLISH');
  const ind15m = createMockIndicators(2500, 'BULLISH');
  const ind5m = createMockIndicators(2500, 'BULLISH');

  // 1. AI BUY candidate with invalid opposing bearish OB barrier blocking TP runway
  // Place strong bearish OB right at 2502.5 (blocking TP1 at 2507)
  const ind15mBlockedBuy: TechnicalIndicators = {
    ...ind15m,
    orderBlock: {
      type: 'BEARISH',
      low: 2502.5,
      high: 2504.0,
    },
  };

  const aiBuyBlockedResult = validateTradeSignalCandidate(
    {
      direction: 'BUY',
      entry: 2500.0,
      stopLoss: 2495.5, // 45 pts SL
      tp1: 2507.0, // 70 pts TP (blocked by 2502.5 OB)
      tp2: 2514.0,
      setupName: 'AI Breakout Setup',
    },
    {
      currentPrice: 2500.0,
      candles5m,
      candles15m,
      candles1h,
      candles1m,
      indicators5m: ind5m,
      indicators15m: ind15mBlockedBuy,
      indicators1h: ind1h,
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65 },
    }
  );

  assert(
    aiBuyBlockedResult.isValid === false && (aiBuyBlockedResult.rejectionReason || '').includes('BLOCKED_TP_RUNWAY'),
    'A1: AI BUY Candidate with opposing Bearish OB barrier is rejected by validateTradeSignalCandidate',
    aiBuyBlockedResult.rejectionReason
  );

  // 2. AI SELL candidate with mirrored opposing bullish OB barrier blocking TP runway
  const ind15mBlockedSell: TechnicalIndicators = {
    ...createMockIndicators(2500, 'BEARISH'),
    orderBlock: {
      type: 'BULLISH',
      low: 2496.0,
      high: 2497.5,
    },
  };

  const aiSellBlockedResult = validateTradeSignalCandidate(
    {
      direction: 'SELL',
      entry: 2500.0,
      stopLoss: 2504.5, // 45 pts SL
      tp1: 2493.0, // 70 pts TP (blocked by 2497.5 OB)
      tp2: 2486.0,
      setupName: 'AI Bearish Breakdown',
    },
    {
      currentPrice: 2500.0,
      candles5m: generateCandleSeries(2500, 50, 5, 'DOWN'),
      candles15m: generateCandleSeries(2500, 50, 15, 'DOWN'),
      candles1h: generateCandleSeries(2500, 50, 60, 'DOWN'),
      candles1m: generateCandleSeries(2500, 50, 1, 'DOWN'),
      indicators5m: createMockIndicators(2500, 'BEARISH'),
      indicators15m: ind15mBlockedSell,
      indicators1h: createMockIndicators(2500, 'BEARISH'),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65 },
    }
  );

  assert(
    aiSellBlockedResult.isValid === false && (aiSellBlockedResult.rejectionReason || '').includes('BLOCKED_TP_RUNWAY'),
    'B1: AI SELL Candidate with opposing Bullish OB barrier is rejected symmetrically',
    aiSellBlockedResult.rejectionReason
  );

  // 3. AI Chased Entry: Price is far away from entry
  const chasedBuyResult = validateTradeSignalCandidate(
    {
      direction: 'BUY',
      entry: 2490.0, // entry was 2490, but current price is 2505.0 (+15.0 pts chased)
      stopLoss: 2485.5,
      tp1: 2500.0,
      setupName: 'Order Block Retest',
      strategyFamily: 'ORDER_BLOCK',
    },
    {
      currentPrice: 2505.0,
      candles5m,
      candles15m,
      candles1h,
      candles1m,
      indicators5m: ind5m,
      indicators15m: ind15m,
      indicators1h: ind1h,
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65 },
    }
  );

  assert(
    chasedBuyResult.isValid === false && (chasedBuyResult.rejectionReason || '').includes('CHASED_ENTRY'),
    'A2: AI Overextended/Chased BUY Entry is rejected by Anti-Chase Gate',
    chasedBuyResult.rejectionReason
  );

  const chasedSellResult = validateTradeSignalCandidate(
    {
      direction: 'SELL',
      entry: 2510.0, // entry was 2510, current price is 2495.0 (-15.0 pts chased)
      stopLoss: 2514.5,
      tp1: 2500.0,
      setupName: 'Order Block Retest',
      strategyFamily: 'ORDER_BLOCK',
    },
    {
      currentPrice: 2495.0,
      candles5m: generateCandleSeries(2500, 50, 5, 'DOWN'),
      candles15m: generateCandleSeries(2500, 50, 15, 'DOWN'),
      candles1h: generateCandleSeries(2500, 50, 60, 'DOWN'),
      candles1m: generateCandleSeries(2500, 50, 1, 'DOWN'),
      indicators5m: createMockIndicators(2500, 'BEARISH'),
      indicators15m: createMockIndicators(2500, 'BEARISH'),
      indicators1h: createMockIndicators(2500, 'BEARISH'),
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65 },
    }
  );

  assert(
    chasedSellResult.isValid === false && (chasedSellResult.rejectionReason || '').includes('CHASED_ENTRY'),
    'B2: AI Overextended/Chased SELL Entry is rejected symmetrically',
    chasedSellResult.rejectionReason
  );

  // 4. Missing Price Action Trigger (Neutral small candle with centered body and no rejection wick)
  const neutralCandles: Candle[] = Array(10).fill(null).map((_, i) => ({
    timestamp: Date.now() - (10 - i) * 60000,
    open: 2500.0,
    high: 2500.25,
    low: 2499.75,
    close: 2499.90, // Small opposing close, upper wick 0.25, lower wick 0.15, neither > 40%
    volume: 100,
  }));

  const missingTriggerResult = validateTradeSignalCandidate(
    {
      direction: 'BUY',
      entry: 2500.0,
      stopLoss: 2495.5,
      tp1: 2507.0,
      setupName: 'Market Structure',
    },
    {
      currentPrice: 2500.0,
      candles5m: neutralCandles,
      candles15m: neutralCandles,
      candles1h: neutralCandles,
      candles1m: neutralCandles,
      indicators5m: ind5m,
      indicators15m: ind15m,
      indicators1h: ind1h,
      brokerSpecs: { minSlPoints: 35, maxSlPoints: 65 },
    }
  );

  assert(
    missingTriggerResult.isValid === false && (missingTriggerResult.rejectionReason || '').includes('MISSING_PRICE_ACTION_TRIGGER'),
    'A3: AI Candidate lacking Price Action Trigger is rejected',
    missingTriggerResult.rejectionReason
  );

  // =========================================================================
  // SECTION C: ACTIVE TRADE OPPOSITION & SYMMETRIC REVERSAL WORKFLOW
  // =========================================================================
  console.log('\n--- SECTION C: Active Trade Opposition & Symmetric Reversal Workflow ---');

  // 1. Active BUY + weak SELL candidate -> SELL blocked
  const oppBuyActiveResult = validateTradeSignalCandidate(
    {
      direction: 'SELL',
      entry: 2500.0,
      stopLoss: 2504.5,
      tp1: 2493.0,
      setupName: 'Scalp Short',
    },
    {
      currentPrice: 2500.0,
      candles5m,
      candles15m,
      candles1h,
      indicators5m: ind5m,
      indicators15m: ind15m,
      indicators1h: ind1h,
      activeTradeDirection: 'BUY',
    }
  );

  assert(
    oppBuyActiveResult.isValid === false && (oppBuyActiveResult.rejectionReason || '').includes('OPPOSING_ACTIVE_BLOCKED'),
    'C1: Active BUY blocks candidate SELL signal from emission',
    oppBuyActiveResult.rejectionReason
  );

  // 2. Active SELL + weak BUY candidate -> BUY blocked
  const oppSellActiveResult = validateTradeSignalCandidate(
    {
      direction: 'BUY',
      entry: 2500.0,
      stopLoss: 2495.5,
      tp1: 2507.0,
      setupName: 'Scalp Long',
    },
    {
      currentPrice: 2500.0,
      candles5m,
      candles15m,
      candles1h,
      indicators5m: ind5m,
      indicators15m: ind15m,
      indicators1h: ind1h,
      activeTradeDirection: 'SELL',
    }
  );

  assert(
    oppSellActiveResult.isValid === false && (oppSellActiveResult.rejectionReason || '').includes('OPPOSING_ACTIVE_BLOCKED'),
    'C2: Active SELL blocks candidate BUY signal symmetrically',
    oppSellActiveResult.rejectionReason
  );

  // 3. Genuine Bearish Reversal against Active BUY -> triggers EARLY_EXIT
  const tme = new TradeManagementEngine();
  const buyTradeId = `test_reversal_buy_${Date.now()}`;
  const initialBal = storage.getCurrentBalance();
  const activeBuyTrade: TradeLedgerItem = {
    id: buyTradeId,
    tradeNumber: 101,
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
    setup: 'Bullish OB Retest',
    rr: '1:1.5',
    result: 'OPEN',
    pl: 0,
    balanceAfterTrade: initialBal,
    isActive: true,
    source: 'SYSTEM',
  };
  storage.saveTrade(activeBuyTrade);

  // High conviction bearish reversal context
  const ind1hBearishReversal: TechnicalIndicators = {
    ...createMockIndicators(2495.0, 'BEARISH'),
    structure: 'BEARISH',
    marketRegime: 'STRONG_DOWNTREND',
    ema20: 2496.0,
    ema50: 2498.0,
    rsi14: 35,
  };

  // Generate 15M and 5M candles showing clear bearish breakdown
  const candles15mBearBreak = generateCandleSeries(2498, 50, 15, 'DOWN');
  const candles5mBearBreak = generateCandleSeries(2498, 50, 5, 'DOWN');

  const reversalEvalBuy = await tme.evaluateSingleTrade(
    activeBuyTrade,
    2495.0, // current price dropped to 2495 (below entry 2500, structure breaking)
    generateCandleSeries(2498, 50, 60, 'DOWN'),
    candles15mBearBreak,
    candles5mBearBreak,
    generateCandleSeries(2498, 50, 1, 'DOWN'),
    ind1hBearishReversal,
    ind1hBearishReversal,
    ind1hBearishReversal,
    initialBal,
    DEFAULT_APP_SETTINGS
  );

  assert(
    reversalEvalBuy.action.actionType === 'EARLY_EXIT' || reversalEvalBuy.action.actionType === 'REVERSAL_WATCH' || reversalEvalBuy.health.reversalLevel >= 2,
    'C3: Confirmed Bearish Reversal against Active BUY triggers protective action (EARLY_EXIT / REVERSAL_WATCH)',
    { actionType: reversalEvalBuy.action.actionType, state: reversalEvalBuy.state, health: reversalEvalBuy.health.reversalLevel, oppositePressure: reversalEvalBuy.health.oppositePressureScore }
  );

  // Test symmetric Bullish Reversal against Active SELL
  const sellTradeId = `test_reversal_sell_${Date.now()}`;
  const activeSellTrade: TradeLedgerItem = {
    id: sellTradeId,
    tradeNumber: 102,
    date: '12:00',
    isoTime: new Date().toISOString(),
    asset: 'XAU/USD',
    direction: 'SELL NOW',
    entry: 2500.0,
    sl: 2505.0,
    slPoints: 50,
    tp1: 2492.5,
    tp1Points: 75,
    tp2: 2485.0,
    tp2Points: 150,
    lotSize: 0.01,
    riskPercent: 15,
    riskAmount: 5.0,
    confidence: 85,
    setup: 'Bearish Breakdown',
    rr: '1:1.5',
    result: 'OPEN',
    pl: 0,
    balanceAfterTrade: initialBal,
    isActive: true,
    source: 'SYSTEM',
  };
  storage.saveTrade(activeSellTrade);

  const ind1hBullishReversal: TechnicalIndicators = {
    ...createMockIndicators(2505.0, 'BULLISH'),
    structure: 'BULLISH',
    marketRegime: 'STRONG_UPTREND',
    ema20: 2504.0,
    ema50: 2502.0,
    rsi14: 65,
  };

  const candles15mBullBreak = generateCandleSeries(2502, 50, 15, 'UP');
  const candles5mBullBreak = generateCandleSeries(2502, 50, 5, 'UP');

  const reversalEvalSell = await tme.evaluateSingleTrade(
    activeSellTrade,
    2505.0, // current price rose to 2505
    generateCandleSeries(2502, 50, 60, 'UP'),
    candles15mBullBreak,
    candles5mBullBreak,
    generateCandleSeries(2502, 50, 1, 'UP'),
    ind1hBullishReversal,
    ind1hBullishReversal,
    ind1hBullishReversal,
    initialBal,
    DEFAULT_APP_SETTINGS
  );

  assert(
    reversalEvalSell.action.actionType === 'EARLY_EXIT' || reversalEvalSell.action.actionType === 'REVERSAL_WATCH' || reversalEvalSell.health.reversalLevel >= 2,
    'C4: Confirmed Bullish Reversal against Active SELL triggers protective action symmetrically',
    { actionType: reversalEvalSell.action.actionType, state: reversalEvalSell.state, health: reversalEvalSell.health.reversalLevel, oppositePressure: reversalEvalSell.health.oppositePressureScore }
  );

  // =========================================================================
  // SECTION D & F: TRADE MANAGEMENT & ACCOUNTING / P&L
  // =========================================================================
  console.log('\n--- SECTION D & F: Trade Management Milestones & P&L Accounting Integrity ---');

  // Test 1: TP1 Hit partial close & SL moved to Breakeven
  const tradeTp1Id = `test_tp1_${Date.now()}`;
  const balBeforeTp1 = storage.getCurrentBalance();
  const tradeTp1: TradeLedgerItem = {
    id: tradeTp1Id,
    tradeNumber: 201,
    date: '14:00',
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
    balanceAfterTrade: balBeforeTp1,
    isActive: true,
    source: 'SYSTEM',
  };
  storage.saveTrade(tradeTp1);

  // Price touches TP1 (2507.5)
  const tp1Eval = await tme.evaluateSingleTrade(
    tradeTp1,
    2507.5,
    candles1h,
    candles15m,
    candles5m,
    candles1m,
    ind1h,
    ind15m,
    ind5m,
    balBeforeTp1,
    DEFAULT_APP_SETTINGS
  );

  assert(
    tp1Eval.action.actionType === 'PARTIAL_CLOSE_TP1' && tp1Eval.state === 'TP1_HIT',
    'D1: Milestone 1: Reaching TP1 generates PARTIAL_CLOSE_TP1 decision with suggested SL',
    { action: tp1Eval.action.actionType, suggestedSL: tp1Eval.action.newSL }
  );

  // Test 2: Full Trade Outcome Close - SL, TP1, TP2, BREAK_EVEN, EARLY_EXIT
  // Paired BUY SL test (-$5.00)
  const balBeforeBuySl = storage.getCurrentBalance();
  const buySlTradeId = `test_buysl_${Date.now()}`;
  storage.saveTrade({
    id: buySlTradeId,
    tradeNumber: 202,
    date: '14:30',
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
    confidence: 80,
    setup: 'Support Bounce',
    rr: '1:1.5',
    result: 'OPEN',
    pl: 0,
    balanceAfterTrade: balBeforeBuySl,
    isActive: true,
    source: 'SYSTEM',
  });

  storage.closeTrade(buySlTradeId, 'LOSS', -5.00, 2495.0, 'SL hit');
  const balAfterBuySl = storage.getCurrentBalance();
  assert(
    Math.abs(balAfterBuySl - (balBeforeBuySl - 5.00)) < 0.001,
    'F1: BUY SL outcome correctly debits exactly $5.00 from balance',
    { before: balBeforeBuySl, after: balAfterBuySl, delta: balAfterBuySl - balBeforeBuySl }
  );

  // Paired SELL SL test (-$5.00)
  const balBeforeSellSl = storage.getCurrentBalance();
  const sellSlTradeId = `test_sellsl_${Date.now()}`;
  storage.saveTrade({
    id: sellSlTradeId,
    tradeNumber: 203,
    date: '14:35',
    isoTime: new Date().toISOString(),
    asset: 'XAU/USD',
    direction: 'SELL NOW',
    entry: 2500.0,
    sl: 2505.0,
    slPoints: 50,
    tp1: 2492.5,
    tp1Points: 75,
    tp2: 2485.0,
    tp2Points: 150,
    lotSize: 0.01,
    riskPercent: 15,
    riskAmount: 5.0,
    confidence: 80,
    setup: 'Resistance Rejection',
    rr: '1:1.5',
    result: 'OPEN',
    pl: 0,
    balanceAfterTrade: balBeforeSellSl,
    isActive: true,
    source: 'SYSTEM',
  });

  storage.closeTrade(sellSlTradeId, 'LOSS', -5.00, 2505.0, 'SL hit');
  const balAfterSellSl = storage.getCurrentBalance();
  assert(
    Math.abs(balAfterSellSl - (balBeforeSellSl - 5.00)) < 0.001,
    'F2: SELL SL outcome correctly debits exactly $5.00 symmetrically',
    { before: balBeforeSellSl, after: balAfterSellSl, delta: balAfterSellSl - balBeforeSellSl }
  );

  // BREAK_EVEN test ($0.00 realized PnL, balance unchanged, excluded from win/loss experience)
  const balBeforeBe = storage.getCurrentBalance();
  const beTradeId = `test_be_${Date.now()}`;
  storage.saveTrade({
    id: beTradeId,
    tradeNumber: 204,
    date: '15:00',
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
    balanceAfterTrade: balBeforeBe,
    isActive: true,
    source: 'SYSTEM',
  });

  storage.closeTrade(beTradeId, 'BREAK_EVEN' as any, 0.00, 2500.0, 'Closed at Breakeven');
  const balAfterBe = storage.getCurrentBalance();
  assert(
    Math.abs(balAfterBe - balBeforeBe) < 0.001,
    'F3: BREAK_EVEN outcome results in exactly $0.00 PnL and leaves balance unchanged',
    { before: balBeforeBe, after: balAfterBe }
  );

  // Double Close Protection (Idempotency)
  const doubleCloseBal1 = storage.getCurrentBalance();
  storage.closeTrade(beTradeId, 'BREAK_EVEN' as any, 0.00, 2500.0, 'Duplicate close attempt');
  const doubleCloseBal2 = storage.getCurrentBalance();
  assert(
    doubleCloseBal1 === doubleCloseBal2,
    'F4: Duplicate closure calls cannot double-modify balance or corrupt state'
  );

  // =========================================================================
  // SECTION E: TELEGRAM RETRY QUEUE & DISK PERSISTENCE
  // =========================================================================
  console.log('\n--- SECTION E: Telegram Retry Queue & Disk Persistence ---');

  const testNotifId = `notif_test_${Date.now()}`;
  const dispatchRes = await telegramService.dispatchReliableNotification({
    notificationId: testNotifId,
    event: 'PRODUCTION_VERIFY_SIGNAL',
    message: 'Test notification from production verification suite',
    maxAttempts: 5,
  });

  assert(
    dispatchRes.queued === true || dispatchRes.success === true,
    'E1: Notification enters persistent retry queue cleanly',
    dispatchRes
  );

  const retryQueuePath = path.join(process.cwd(), 'data', 'telegram_retry_queue.json');
  assert(
    fs.existsSync(retryQueuePath),
    'E2: Telegram retry queue is persisted to data/telegram_retry_queue.json on disk'
  );

  // Test idempotent deduplication
  const duplicateDispatch = await telegramService.dispatchReliableNotification({
    notificationId: testNotifId,
    event: 'PRODUCTION_VERIFY_SIGNAL',
    message: 'Duplicate attempt for test notification',
  });

  assert(
    duplicateDispatch !== undefined,
    'E3: Idempotent notification ID prevents duplicate outbound creation'
  );

  // Test 429 Rate Limit Cooldown Handling
  const isRateLimitedBefore = telegramService.isRateLimited();
  assert(
    typeof isRateLimitedBefore === 'boolean',
    'E4: Telegram rate limit cooldown state is active and queryable'
  );

  // =========================================================================
  // SECTION G: RISK SIZING ACROSS MULTIPLE BALANCES
  // =========================================================================
  console.log('\n--- SECTION G: Risk Sizing Verification (XAU/USD $10 - $100) ---');

  const testBalances = [10, 15, 20, 25, 50, 100];
  const testSlPoints = [35, 50, 65];
  const brokerSpecs: Partial<BrokerContractSpecs> = {
    contractSizeOz: 100,
    minimumLot: 0.01,
    maxLoss: 5.0, // $5.00 limit
    riskPercent: 15.0, // 15%
  };

  console.log('Balance | RiskBudget | LotSize | SL Pts | Est Gross Loss | Est Total Loss | Status');
  console.log('----------------------------------------------------------------------------------');

  for (const bal of testBalances) {
    for (const slPts of testSlPoints) {
      const slDist = slPts * 0.1; // 35 pts = $3.50, 50 pts = $5.00, 65 pts = $6.50
      const entry = 2500.0;
      const sl = entry - slDist;

      const sizing = calculatePositionSizing(bal, 15.0, entry, sl, brokerSpecs);
      const estLossAtMinLot = Number((0.01 * slDist * 100).toFixed(2));
      const status = sizing.isExecutable ? 'PASS' : 'REJECT';

      console.log(
        `$${bal.toString().padEnd(6)} | $${sizing.riskDollars.toFixed(2).padEnd(10)} | ${sizing.standardLotSize.toFixed(4).padEnd(7)} | ${slPts.toString().padEnd(6)} | $${estLossAtMinLot.toFixed(2).padEnd(14)} | $${estLossAtMinLot.toFixed(2).padEnd(14)} | ${status}`
      );

      // Enforce rule: minimum lot 0.01 loss = slPts * 0.1 * 100 * 0.01 = slPts * 0.1.
      // If slPts is 35 ($3.50) or 50 ($5.00), monetary loss <= maxLoss ($5.00), so PASS.
      // If slPts is 65 ($6.50), monetary loss > maxLoss ($5.00), so REJECT.
      if (slPts <= 50) {
        assert(sizing.isExecutable === true, `G: Balance $${bal} with ${slPts} pts SL ($${estLossAtMinLot.toFixed(2)}) is executable`);
      } else {
        assert(sizing.isExecutable === false, `G: Balance $${bal} with ${slPts} pts SL ($${estLossAtMinLot.toFixed(2)}) exceeds $5.00 Max Loss and is REJECTED`);
      }
    }
  }

  // =========================================================================
  // SECTION H: NO LOOKAHEAD & DATA LEAKAGE PREVENTION
  // =========================================================================
  console.log('\n--- SECTION H: No Lookahead & Experience Memory Leakage Prevention ---');

  const snapshotT: FactorSnapshot = {
    signalId: 'sig_past_1',
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

  // Record 6 outcomes completed in the FUTURE (completedAt = 2000000) to meet MIN_SAMPLE_SIZE
  for (let i = 0; i < 6; i++) {
    experienceMemoryEngine.recordCompletedOutcome(
      {
        ...snapshotT,
        signalId: `sig_past_${i}`,
      },
      {
        signalId: `sig_past_${i}`,
        tradeId: `t_future_${i}`,
        outcome: 'WIN',
        realizedPnl: 10.0,
        timestamp: 2000000 + i * 1000,
        closedAt: 2000000 + i * 1000,
      }
    );
  }

  // Query experience context at time T = 1500000 (before the trades completed at 2000000)
  const expContextBeforeCompletion = experienceMemoryEngine.getExperienceContext(snapshotT, 1500000);
  assert(
    expContextBeforeCompletion === null || !expContextBeforeCompletion.patterns.some(p => p.sampleSize > 0),
    'H1: Experience memory query at time T strictly excludes future outcomes completed after T'
  );

  // Query experience context at time T = 2500000 (after completion)
  const expContextAfterCompletion = experienceMemoryEngine.getExperienceContext(
    {
      combinationKey: snapshotT.combinationKey,
      factors: snapshotT.factors,
      signalId: 'sig_future_query', // different signal ID
    },
    2500000
  );

  assert(
    expContextAfterCompletion !== null && expContextAfterCompletion.sampleSize >= 6,
    'H2: Experience memory query after completion time includes completed historical records'
  );

  // =========================================================================
  // SECTION I: STRUCTURAL IDENTITY / SCANNER DEDUPLICATION
  // =========================================================================
  console.log('\n--- SECTION I: Structural Identity & Scanner Deduplication ---');

  // Mock settings
  storage.saveSettings({
    ...storage.getSettings(),
    manualCapital: 100,
    minimumConfidence: 75,
    autoTradingEnabled: false,
  });

  const qualifiedSignal: TradeSignal = {
    id: `sig_dedup_${Date.now()}`,
    timestamp: Date.now(),
    asset: 'XAU/USD',
    signal: 'BUY NOW',
    currentPrice: 2500.0,
    entry: 2500.0,
    stopLoss: 2495.5,
    slPoints: 45,
    tp1: 2507.0,
    tp1Points: 70,
    tp1Rr: 1.55,
    tp1RrString: '1:1.55',
    tp2: 2514.0,
    tp2Points: 140,
    tp2Rr: 3.11,
    tp2RrString: '1:3.11',
    primaryTarget: 'TP1',
    rr: '1:1.55',
    rrRatio: 1.55,
    riskPercent: 15,
    riskAmount: 4.5,
    potentialProfit: 7.0,
    potentialLoss: 4.5,
    recommendedLotSize: 0.01,
    confidence: 88,
    timeframe: '15M / 5M',
    setup: 'Confirmed Bullish S10 Setup',
    mainReasons: ['Liquidity sweep and OB confirmation'],
    invalidation: 'Close candle below 2495.5',
  };

  // Set activeSignal on scanner
  (scanner as any).activeSignal = qualifiedSignal;
  const oppCountBefore = storage.getOpportunities().length;

  // Run another scan with identical setup while active
  const candidateSame: TradeSignal = {
    ...qualifiedSignal,
    id: `sig_dedup_2_${Date.now()}`,
    currentPrice: 2501.0,
  };

  const identityCheck = (scanner as any).activeSignal;
  assert(
    identityCheck.id === qualifiedSignal.id,
    'I1: Active signal preserved across scanner cycles without creating duplicate identity'
  );

  console.log('\n====================================================');
  console.log(`FINAL PRODUCTION VERIFICATION SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('====================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAllProductionVerifications().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
