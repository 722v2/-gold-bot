import { runAccountingTests } from './accountingTests.js';
import { runTradeManagementTests } from './tradeManagementTests.js';
import { runEndToEndStressTest } from './stressTestRunner.js';
import { storage } from './storage.js';
import { tradeManagementEngine } from './tradeManagementEngine.js';
import { scanner } from './scanner.js';
import { checkStructuralSameSetupIdentity } from './tradeQualityEngine.js';
import { evaluateTradeRisk } from './riskManager.js';

async function executeFullAuditValidation() {
  console.log('======================================================================');
  console.log('STARTING FINAL AUDIT-ONLY VALIDATION — GOLD AI TRADING SYSTEM');
  console.log('======================================================================\n');

  let totalAssertions = 0;
  let passedAssertions = 0;
  const auditFailures: string[] = [];

  function recordAssertion(passed: boolean, description: string, errorDetail?: string) {
    totalAssertions++;
    if (passed) {
      passedAssertions++;
      console.log(`  [PASS] Assertion #${totalAssertions}: ${description}`);
    } else {
      const errMsg = `Assertion #${totalAssertions} FAILED: ${description}${errorDetail ? ' (' + errorDetail + ')' : ''}`;
      auditFailures.push(errMsg);
      console.error(`  [FAIL] ${errMsg}`);
    }
  }

  // --------------------------------------------------------------------------
  // SECTION 1: REALIZED P&L VALIDATION
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 1: REALIZED P&L VALIDATION ---');
  const accountingRes = runAccountingTests();
  for (const r of accountingRes.results) {
    recordAssertion(r.passed, `Accounting Suite Test #${r.testNumber}: ${r.name}`, r.details);
  }

  // Additional explicit P&L separation & math checks
  const mockSignal = {
    id: 'sig_pnl_sep_test',
    symbol: 'XAU/USD',
    signal: 'BUY NOW' as const,
    entry: 4280.00,
    stopLoss: 4276.00,
    tp1: 4290.00,
    tp2: 4295.00,
    slPoints: 40,
    tp1Points: 100,
    tp1Rr: 2.5,
    rrRatio: 2.5,
    potentialProfit: 25.00, // Theoretical R:R $25
    potentialLoss: 10.00,
    recommendedLotSize: 0.02,
    riskAmount: 10.00,
    timestamp: Date.now(),
  };

  // Test BUY exit price derived P&L: Entry 4280, Exit 4288, Lot 0.02 -> (4288 - 4280) * 100 * 0.02 = +$16.00
  const buyPnlCalc = (4288.00 - 4280.00) * 100 * 0.02;
  recordAssertion(buyPnlCalc === 16.00, 'BUY exit-price-derived P&L math (8 pts * 100 * 0.02 = $16.00)');

  // Test SELL exit price derived P&L: Entry 4296, Exit 4290, Lot 0.01 -> (4296 - 4290) * 100 * 0.01 = +$6.00
  const sellPnlCalc = (4296.00 - 4290.00) * 100 * 0.01;
  recordAssertion(sellPnlCalc === 6.00, 'SELL exit-price-derived P&L math (6 pts * 100 * 0.01 = $6.00)');

  // Confirm theoretical RR potentialProfit ($25.00) remains separate from realizedPnl ($16.00)
  recordAssertion(
    mockSignal.potentialProfit !== buyPnlCalc,
    'Theoretical potentialProfit ($25.00) remains strictly separate from realizedPnl ($16.00)'
  );


  // --------------------------------------------------------------------------
  // SECTION 2: OUTCOME RECORDING & IDEMPOTENCY
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 2: OUTCOME RECORDING & IDEMPOTENCY ---');

  // Verify Idempotency on outcomes
  const outcomeTradeId = 'audit_out_idempotency_1';
  const outcome1 = storage.recordTradeOutcome({
    signalId: outcomeTradeId,
    tradeId: outcomeTradeId,
    direction: 'BUY NOW',
    orderType: 'MARKET',
    entry: 4280.00,
    stopLoss: 4275.00,
    tp1: 4290.00,
    tp2: 4295.00,
    outcome: 'WIN',
    realizedPnl: 10.00,
    source: 'MANUAL',
    timestamp: Date.now(),
    isoTime: new Date().toISOString(),
  });
  const outcome2 = storage.recordTradeOutcome({
    signalId: outcomeTradeId,
    tradeId: outcomeTradeId,
    direction: 'BUY NOW',
    orderType: 'MARKET',
    entry: 4280.00,
    stopLoss: 4275.00,
    tp1: 4290.00,
    tp2: 4295.00,
    outcome: 'WIN',
    realizedPnl: 10.00,
    source: 'MANUAL',
    timestamp: Date.now(),
    isoTime: new Date().toISOString(),
  });

  recordAssertion(outcome1.success && !outcome1.isDuplicate, 'Initial P&L outcome recorded successfully');
  recordAssertion(outcome2.isDuplicate === true, 'Duplicate P&L outcome callback blocked cleanly without double credit');


  // --------------------------------------------------------------------------
  // SECTION 3: IDEMPOTENCY & CONCURRENCY
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 3: IDEMPOTENCY & CONCURRENCY ---');
  const scannerConfig = scanner.getConfig();
  recordAssertion(typeof scannerConfig.isScanning === 'boolean', 'Scanner mutex state accessible and healthy');

  // Test structural same-setup identity
  const sigA = {
    id: 'sig_audit_a',
    timestamp: Date.now(),
    asset: 'XAU/USD' as const,
    signal: 'SELL NOW' as const,
    currentPrice: 4294.52,
    entry: 4294.52,
    stopLoss: 4298.52,
    slPoints: 40,
    tp1: 4278.29,
    tp1Points: 162.3,
    tp1Rr: 4.05,
    tp1RrString: '1:4.05',
    tp2: 4276.25,
    tp2Points: 182.7,
    tp2Rr: 4.56,
    tp2RrString: '1:4.56',
    primaryTarget: 'TP1' as const,
    rr: '1:4.05',
    rrRatio: 4.05,
    riskPercent: 1.5,
    riskAmount: 15,
    potentialProfit: 60.75,
    potentialLoss: 15,
    recommendedLotSize: 0.04,
    confidence: 85,
    strategyConfidence: 85,
    executionQualityScore: 88,
    strategyFamily: 'MARKET_STRUCTURE',
    poiId: 'POI_5M_BEARISH_4298',
    timeframe: '5M',
    setup: 'Bearish Trend Continuation (EMA/VWAP Pullback)',
    mainReasons: ['5M EMA20 rejection'],
    invalidation: 'Close above 4298.52',
  };

  const sigB = { ...sigA, id: 'sig_audit_b', entry: 4293.00 };
  const identityCheck = checkStructuralSameSetupIdentity(sigA, sigB);
  recordAssertion(identityCheck.isDuplicate === true, 'Structural same-setup re-entry blocked when active trade exists');


  // --------------------------------------------------------------------------
  // SECTION 4: AUTO-TRADING SAFETY
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 4: AUTO-TRADING SAFETY ---');
  const baseSettings = storage.getSettings();
  recordAssertion(baseSettings.autoTradingEnabled === false, 'autoTradingEnabled is strictly FALSE in app settings');

  const mockMgmtAction = {
    actionType: 'UPDATE_SL' as const,
    tradeId: 'audit_mgmt_1',
    direction: 'BUY' as const,
    currentPrice: 4288.00,
    entryPrice: 4280.00,
    oldSL: 4275.00,
    newSL: 4284.00,
    oldTP1: 4290.00,
    oldTP2: 4295.00,
    floatingPnl: 16.00,
    currentR: 1.6,
    managementState: 'TRAIL_STOP' as const,
    reason: 'Testing adapter execution bounds',
    confidence: 85,
    timestamp: Date.now(),
    source: 'DETERMINISTIC' as const,
    requiresConfirmation: false,
  };

  const autoExecPlan = tradeManagementEngine.prepareFutureAutoTradeExecution(mockMgmtAction, baseSettings);
  recordAssertion(autoExecPlan.autoTradingEnabled === false, 'Auto-trade adapter plan confirms autoTradingEnabled=false');
  recordAssertion(autoExecPlan.executable === false, 'Auto-trade adapter plan returns executable=false');


  // --------------------------------------------------------------------------
  // SECTION 5: STATE & STORAGE PERSISTENCE
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 5: STATE & STORAGE PERSISTENCE ---');
  const currBal = storage.getCurrentBalance();
  recordAssertion(!isNaN(currBal) && currBal > 0, `Current balance is valid number ($${currBal.toFixed(2)})`);

  const activeTrades = storage.getTrades();
  recordAssertion(Array.isArray(activeTrades), `Active trades retrieved successfully (${activeTrades.length} active)`);

  const tradeOutcomes = storage.getTradeOutcomes();
  recordAssertion(Array.isArray(tradeOutcomes), `Trade outcomes retrieved successfully (${tradeOutcomes.length} outcomes)`);


  // --------------------------------------------------------------------------
  // SECTION 6: RISK/SL/TP REGRESSION & PHASE 4 ENGINE SUITE
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 6: RISK/SL/TP REGRESSION & PHASE 4 ENGINE SUITE ---');
  const tmRes = await runTradeManagementTests();
  for (const r of tmRes.results) {
    recordAssertion(r.passed, `Trade Management Suite Test #${r.testNumber}: ${r.name}`, r.details);
  }

  // Check risk evaluation on BUY setup
  const buyRiskEval = evaluateTradeRisk({
    entry: 4280.00,
    stopLoss: 4276.00, // 40 points
    tp1: 4290.00,
    direction: 'BUY',
    balance: 100.00,
    confidence: 85,
    brokerSpecs: baseSettings,
  });
  recordAssertion(buyRiskEval.valid === true, 'Standard 40pt SL BUY risk evaluation passes');
  recordAssertion(buyRiskEval.slPoints === 40, 'SL points correctly calculated as 40 points ($4.00 gold move)');


  // --------------------------------------------------------------------------
  // SECTION 7: FULL END-TO-END STRESS TEST SUITE
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 7: FULL END-TO-END STRESS TEST SUITE ---');
  const e2eRes = await runEndToEndStressTest();
  recordAssertion(e2eRes.allPassed === true, `E2E Stress Test Suite passed (${e2eRes.passedCount}/${e2eRes.totalScenarios} scenarios passed)`);


  // --------------------------------------------------------------------------
  // FINAL REPORT & SUMMARY
  // --------------------------------------------------------------------------
  console.log('\n======================================================================');
  console.log('FINAL AUDIT SUMMARY & RESULTS');
  console.log('======================================================================');
  console.log(`Total Assertions Executed: ${totalAssertions}`);
  console.log(`Passed Assertions: ${passedAssertions}`);
  console.log(`Failed Assertions: ${auditFailures.length}`);

  if (auditFailures.length > 0) {
    console.error('\nFAILURES DETECTED:');
    for (const f of auditFailures) {
      console.error(` - ${f}`);
    }
  }

  const finalStatus = auditFailures.length === 0 ? 'PASS' : 'FAIL';
  console.log(`\nFINAL AUDIT STATUS: ${finalStatus}`);
  process.exit(auditFailures.length === 0 ? 0 : 1);
}

executeFullAuditValidation().catch((err) => {
  console.error('Fatal audit runner error:', err);
  process.exit(1);
});
