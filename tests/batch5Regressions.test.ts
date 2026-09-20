process.env.IS_TESTING = 'true';
import assert from 'node:assert';
import { partition15mCandles, partition1hCandles } from '../server/candleUtils.js';
import { analyzeTechnicals } from '../server/indicators.js';
import { tradeManagementEngine } from '../server/tradeManagementEngine.js';
import { Candle, TradeLedgerItem } from '../src/types.js';

async function runBatch5RegressionTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING BATCH 5 REGRESSION TESTS');
  console.log('====================================================\n');

  // Test 1: Partition 15M candles
  {
    const now = 1700000000000;
    const tf15mMs = 15 * 60 * 1000;
    const candles15m: Candle[] = [
      { open: 2650, high: 2655, low: 2648, close: 2652, volume: 100, timestamp: now - 2 * tf15mMs, isClosed: true },
      { open: 2652, high: 2658, low: 2650, close: 2656, volume: 120, timestamp: now - 1 * tf15mMs, isClosed: true },
      { open: 2656, high: 2670, low: 2655, close: 2668, volume: 50, timestamp: now, isClosed: false },
    ];

    const partition = partition15mCandles(candles15m, now + 5000);
    assert.strictEqual(partition.isValid, true);
    assert.notStrictEqual(partition.formingCandle, null);
    assert.strictEqual(partition.formingCandle?.close, 2668);
    assert.strictEqual(partition.closedCandles.length, 2);
    assert.strictEqual(partition.lastClosedCandle?.close, 2656);
    console.log('✅ [PASS] Test 1: Partition 15M candle correctly isolates forming candle');
  }

  // Test 2: Infer 1H candle from timestamp
  {
    const now = 1700000000000;
    const tf1hMs = 60 * 60 * 1000;
    const candles1h: Candle[] = [
      { open: 2640, high: 2650, low: 2638, close: 2648, volume: 500, timestamp: now - tf1hMs },
      { open: 2648, high: 2660, low: 2645, close: 2658, volume: 200, timestamp: now },
    ];

    const refTime = now + 10 * 60 * 1000;
    const partition = partition1hCandles(candles1h, refTime);
    assert.strictEqual(partition.isValid, true);
    assert.notStrictEqual(partition.formingCandle, null);
    assert.strictEqual(partition.formingCandle?.close, 2658);
    assert.strictEqual(partition.closedCandles.length, 1);
    assert.strictEqual(partition.lastClosedCandle?.close, 2648);
    console.log('✅ [PASS] Test 2: Infers forming 1H candle from timestamp when isClosed is omitted');
  }

  // Test 3: Single-Target Trade Evaluation with tp2 = 0
  {
    const singleTargetTrade: TradeLedgerItem = {
      id: 'trade_single_001',
      tradeNumber: 1,
      date: '2026-09-19',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 2650.0,
      sl: 2646.0,
      tp1: 2656.0,
      tp2: 0,
      lotSize: 0.01,
      rr: '1:1.5',
      riskPercent: 1,
      riskAmount: 5,
      confidence: 85,
      setup: 'Bare SR',
      result: 'OPEN',
      managementState: 'ACTIVE',
      pl: 0,
      balanceAfterTrade: 100,
      isActive: true,
    };

    const evalResult = await tradeManagementEngine.evaluateSingleTrade(
      singleTargetTrade,
      2652.0,
      [], [], [], [], undefined, undefined, undefined, 1000
    );

    assert.strictEqual(evalResult.health.tp2Price, 0);
    assert.strictEqual(evalResult.health.distanceToTp2Points, 0);
    assert.strictEqual(evalResult.health.tp2ProgressPct, 0);
    console.log('✅ [PASS] Test 3: TradeManagementEngine evaluates single-target trade without tp2 cloning');
  }

  // Test 4: Single target trade closes as WIN when reaching TP1
  {
    const singleTargetTrade: TradeLedgerItem = {
      id: 'trade_single_002',
      tradeNumber: 2,
      date: '2026-09-19',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 2650.0,
      sl: 2646.0,
      tp1: 2656.0,
      tp2: 0,
      lotSize: 0.01,
      rr: '1:1.5',
      riskPercent: 1,
      riskAmount: 5,
      confidence: 85,
      setup: 'Bare SR',
      result: 'OPEN',
      managementState: 'ACTIVE',
      pl: 0,
      balanceAfterTrade: 100,
      isActive: true,
    };

    const evalResult = await tradeManagementEngine.evaluateSingleTrade(
      singleTargetTrade,
      2656.0,
      [], [], [], [], undefined, undefined, undefined, 1000
    );

    assert.strictEqual(evalResult.state, 'CLOSED');
    assert.ok(evalResult.action.reason.includes('TP1'));
    console.log('✅ [PASS] Test 4: Single target trade closes as WIN when reaching TP1');
  }

  console.log('\n====================================================');
  console.log('ALL BATCH 5 REGRESSION TESTS PASSED CLEANLY');
  console.log('====================================================\n');
}

runBatch5RegressionTests().catch((err) => {
  console.error('Fatal Batch 5 test runner crash:', err);
  process.exit(1);
});
