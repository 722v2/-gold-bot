import { storage } from '../server/storage.js';
import { tradeManagementEngine } from '../server/tradeManagementEngine.js';
import { tradeMonitor } from '../server/tradeMonitor.js';
import { TradeLedgerItem, AppSettings, DEFAULT_APP_SETTINGS } from '../src/types.js';

async function runPhase3UnificationTests() {
  console.log('======================================================================');
  console.log('🧪 PHASE 3: TRADE MANAGEMENT UNIFICATION TEST SUITE');
  console.log('======================================================================\n');

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
  const wasTesting = storage.isTestingMode();
  storage.setTestingMode(true);

  try {
    const testSettings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      enableTradeManagement: true,
      autoTradingEnabled: false,
      contractSizeOz: 100,
    };

    // ------------------------------------------------------------------------
    // Test 1: In-Flight Lock Guard (Thread Safety & Concurrency Prevention)
    // ------------------------------------------------------------------------
    console.log('\n--- 1. In-Flight Lock Guard Tests ---');
    const lockTradeId = `test_inflight_lock_${Date.now()}`;
    assert(!tradeManagementEngine.isInFlight(lockTradeId), '1.1 Trade is initially not in-flight');

    const acquired = tradeManagementEngine.acquireInFlight(lockTradeId);
    assert(acquired === true, '1.2 First lock acquisition succeeds');
    assert(tradeManagementEngine.isInFlight(lockTradeId) === true, '1.3 Trade is recognized as in-flight');

    const duplicateAcquire = tradeManagementEngine.acquireInFlight(lockTradeId);
    assert(duplicateAcquire === false, '1.4 Concurrent lock acquisition on same trade fails safely');

    tradeManagementEngine.releaseInFlight(lockTradeId);
    assert(tradeManagementEngine.isInFlight(lockTradeId) === false, '1.5 Lock released cleanly');

    // ------------------------------------------------------------------------
    // Test 2: Terminal Stop Loss Closure via evaluateSingleTrade
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Stop Loss Auto-Closure Tests ---');
    const slTradeId = `test_sl_exit_${Date.now()}`;
    const slTrade: TradeLedgerItem = {
      id: slTradeId,
      tradeNumber: 101,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4290.0,
      sl: 4280.0,
      tp1: 4300.0,
      tp2: 4310.0,
      rr: '1:2.0',
      riskPercent: 1.0,
      riskAmount: 10.0,
      lotSize: 0.01,
      confidence: 85,
      setup: 'Bullish OB',
      result: 'OPEN',
      isActive: true,
      pl: 0,
      balanceAfterTrade: 100,
    };
    storage.saveTrade(slTrade);

    // Current price drops below SL (4279.50 <= 4280.00)
    const slEval = await tradeManagementEngine.evaluateSingleTrade(
      slTrade,
      4279.5,
      [],
      [],
      [],
      [],
      undefined as any,
      undefined as any,
      undefined as any,
      100,
      testSettings
    );

    assert(slEval.state === 'CLOSED', '2.1 evaluateSingleTrade marks trade state as CLOSED on SL hit');
    assert(slTrade.isActive === false, '2.2 slTrade.isActive set to false');
    assert(slTrade.managementState === 'CLOSED', '2.3 slTrade.managementState set to CLOSED');

    const closedSlTrade = storage.getTrade(slTradeId);
    assert(
      closedSlTrade !== undefined && closedSlTrade.result === 'LOSS',
      '2.4 Storage records trade outcome as LOSS with realized P&L'
    );
    assert(
      closedSlTrade !== undefined && closedSlTrade.pl < 0,
      `2.5 Storage records negative realized P&L: $${closedSlTrade?.pl}`
    );

    // ------------------------------------------------------------------------
    // Test 3: Terminal TP2 Target Hit Auto-Closure via evaluateSingleTrade
    // ------------------------------------------------------------------------
    console.log('\n--- 3. Take Profit 2 (TP2) Auto-Closure Tests ---');
    const tp2TradeId = `test_tp2_exit_${Date.now()}`;
    const tp2Trade: TradeLedgerItem = {
      id: tp2TradeId,
      tradeNumber: 102,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4290.0,
      sl: 4280.0,
      tp1: 4300.0,
      tp2: 4310.0,
      rr: '1:2.0',
      riskPercent: 1.0,
      riskAmount: 10.0,
      lotSize: 0.01,
      confidence: 85,
      setup: 'Bullish OB',
      result: 'OPEN',
      isActive: true,
      pl: 0,
      balanceAfterTrade: 100,
    };
    storage.saveTrade(tp2Trade);

    // Current price reaches TP2 (4310.50 >= 4310.00)
    const tp2Eval = await tradeManagementEngine.evaluateSingleTrade(
      tp2Trade,
      4310.5,
      [],
      [],
      [],
      [],
      undefined as any,
      undefined as any,
      undefined as any,
      100,
      testSettings
    );

    assert(tp2Eval.state === 'CLOSED', '3.1 evaluateSingleTrade marks trade state as CLOSED on TP2 hit');
    assert(tp2Trade.isActive === false, '3.2 tp2Trade.isActive set to false');
    assert(tp2Trade.managementState === 'CLOSED', '3.3 tp2Trade.managementState set to CLOSED');

    const closedTp2Trade = storage.getTrade(tp2TradeId);
    assert(
      closedTp2Trade !== undefined && closedTp2Trade.result === 'WIN',
      '3.4 Storage records trade outcome as WIN with realized P&L'
    );
    assert(
      closedTp2Trade !== undefined && closedTp2Trade.pl > 0,
      `3.5 Storage records positive realized P&L: $${closedTp2Trade?.pl}`
    );

    // ------------------------------------------------------------------------
    // Test 4: Extreme Price Deviation Anomaly Auto-Voiding (>30%)
    // ------------------------------------------------------------------------
    console.log('\n--- 4. Price Deviation Anomaly Auto-Voiding Tests ---');
    const voidTradeId = `test_void_anomaly_${Date.now()}`;
    const voidTrade: TradeLedgerItem = {
      id: voidTradeId,
      tradeNumber: 103,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 2500.0, // Legacy/anomalous price compared to 4300 market
      sl: 2490.0,
      tp1: 2520.0,
      tp2: 2550.0,
      rr: '1:2.0',
      riskPercent: 1.0,
      riskAmount: 10.0,
      lotSize: 0.01,
      confidence: 85,
      setup: 'Old S1',
      result: 'OPEN',
      isActive: true,
      pl: 0,
      balanceAfterTrade: 100,
    };
    storage.saveTrade(voidTrade);

    const voidEval = await tradeManagementEngine.evaluateSingleTrade(
      voidTrade,
      4300.0,
      [],
      [],
      [],
      [],
      undefined as any,
      undefined as any,
      undefined as any,
      100,
      testSettings
    );

    assert(voidEval.state === 'CLOSED', '4.1 Anomalous trade (>30% price deviation) marked as CLOSED');
    const closedVoidTrade = storage.getTrade(voidTradeId);
    assert(
      closedVoidTrade !== undefined && closedVoidTrade.result === 'VOID',
      '4.2 Storage records trade result as VOID without monetary loss/gain'
    );

    // ------------------------------------------------------------------------
    // Test 5: Lifecycle State & NotifiedStates Synchronization
    // ------------------------------------------------------------------------
    console.log('\n--- 5. Lifecycle State Synchronization Tests ---');
    const syncTradeId = `test_sync_trade_${Date.now()}`;
    const syncTrade: TradeLedgerItem = {
      id: syncTradeId,
      tradeNumber: 104,
      date: 'Today',
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4290.0,
      sl: 4280.0,
      tp1: 4300.0,
      tp2: 4315.0,
      rr: '1:2.0',
      riskPercent: 1.0,
      riskAmount: 10.0,
      lotSize: 0.01,
      confidence: 85,
      setup: 'Bullish OB',
      result: 'OPEN',
      isActive: true,
      pl: 0,
      balanceAfterTrade: 100,
    };
    storage.saveTrade(syncTrade);

    // When price hits TP1 (4300.5)
    const tp1Eval = await tradeManagementEngine.evaluateSingleTrade(
      syncTrade,
      4300.5,
      [],
      [],
      [],
      [],
      undefined as any,
      undefined as any,
      undefined as any,
      100,
      testSettings
    );

    assert(
      tp1Eval.action.actionType === 'PARTIAL_CLOSE_TP1',
      '5.1 TP1 hit generates PARTIAL_CLOSE_TP1 action'
    );
    await tradeManagementEngine.applyManagementDecision(tp1Eval, syncTrade, testSettings);

    assert(
      syncTrade.managementState === 'TP1_HIT' || syncTrade.managementState === 'TP1_REACHED',
      '5.2 syncTrade.managementState updated to TP1_HIT / TP1_REACHED'
    );
    assert(
      Array.isArray(syncTrade.notifiedStates) &&
        (syncTrade.notifiedStates.includes('TP1_HIT') || syncTrade.notifiedStates.includes('TP1_REACHED')),
      '5.3 syncTrade.notifiedStates includes TP1_HIT / TP1_REACHED'
    );

    // ------------------------------------------------------------------------
    // Test 6: TradeLifecycleMonitor Delegation and Status Query
    // ------------------------------------------------------------------------
    console.log('\n--- 6. TradeLifecycleMonitor Delegation Tests ---');
    const monitorStatus = tradeMonitor.getStatus();
    assert(typeof monitorStatus.isRunning === 'boolean', '6.1 tradeMonitor.getStatus().isRunning is boolean');
    assert(typeof monitorStatus.closedTradesCount === 'number', '6.2 tradeMonitor.getStatus().closedTradesCount is numeric');
    assert(
      monitorStatus.closedTradesCount === tradeManagementEngine.getTotalClosedCount(),
      '6.3 tradeMonitor closedTradesCount aligns with TradeManagementEngine authoritative total'
    );

    // Test evaluatePrice call executes cleanly without thrown exceptions
    let evalPriceThrew = false;
    try {
      await tradeMonitor.evaluatePrice(4295.0);
    } catch (err) {
      evalPriceThrew = true;
    }
    assert(!evalPriceThrew, '6.4 tradeMonitor.evaluatePrice executes without throwing errors');

  } finally {
    storage.setTestingMode(wasTesting);
  }

  // Summary
  console.log('\n======================================================================');
  console.log(`🏁 PHASE 3 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runPhase3UnificationTests().catch((err) => {
  console.error('Phase 3 test suite failed with error:', err);
  process.exit(1);
});
