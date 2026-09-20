process.env.IS_TESTING = 'true';
import assert from 'node:assert';
import { evaluateTradeRisk } from '../server/riskManager.js';

async function runRrTelemetryTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING R:R TELEMETRY CONSISTENCY REGRESSION TESTS');
  console.log('====================================================\n');

  // Test 1
  {
    const riskResult = evaluateTradeRisk({
      balance: 100,
      entry: 2650.0,
      stopLoss: 2645.0, // 50 pts SL
      tp1: 2656.0,      // 60 pts = 1.20R
      tp2: 0,           // single target
      confidence: 85,
      asset: 'XAU/USD',
      direction: 'BUY',
    });

    assert.strictEqual(riskResult.valid, true);
    assert.strictEqual(riskResult.tp1Rr, 1.20);
    assert.strictEqual(riskResult.tp1RrString, '1:1.20');
    assert.strictEqual(riskResult.tp2Rr, 0);
    assert.strictEqual(riskResult.tp2RrString, 'N/A');

    const tp1RrLabel = riskResult.tp1RrString || (riskResult.tp1Rr ? `1:${Number(riskResult.tp1Rr).toFixed(2)}` : 'N/A');
    const tp2RrLabel = riskResult.hasValidTp2
      ? (riskResult.tp2RrString || (riskResult.tp2Rr ? `1:${Number(riskResult.tp2Rr).toFixed(2)}` : 'N/A'))
      : 'N/A';

    assert.strictEqual(tp1RrLabel, '1:1.20');
    assert.strictEqual(tp2RrLabel, 'N/A');
    console.log('✅ [PASS] Test 1: Single-target telemetry correctly formats TP2 as N/A');
  }

  // Test 2
  {
    const riskResult = evaluateTradeRisk({
      balance: 100,
      entry: 2650.0,
      stopLoss: 2645.0, // 50 pts SL
      tp1: 2656.0,      // 60 pts = 1.20R
      tp2: 2660.5,      // 105 pts = 2.10R
      confidence: 85,
      asset: 'XAU/USD',
      direction: 'BUY',
    });

    assert.strictEqual(riskResult.valid, true);
    assert.strictEqual(riskResult.tp2Rr, 2.10);
    assert.strictEqual(riskResult.tp2RrString, '1:2.10');

    const tp2RrLabel = riskResult.hasValidTp2
      ? (riskResult.tp2RrString || (riskResult.tp2Rr ? `1:${riskResult.tp2Rr.toFixed(2)}` : 'N/A'))
      : 'N/A';

    assert.strictEqual(tp2RrLabel, '1:2.10');
    console.log('✅ [PASS] Test 2: Dynamic TP2 telemetry correctly displays exact ratio (1:2.10)');
  }

  // Test 3
  {
    const riskResult = evaluateTradeRisk({
      balance: 100,
      entry: 2650.0,
      stopLoss: 2645.0,
      tp1: 2656.0,
      tp2: 0,
      confidence: 85,
      asset: 'XAU/USD',
      direction: 'BUY',
    });

    assert.strictEqual(riskResult.valid, true);
    assert.strictEqual(riskResult.tp1Rr, 1.20);
    assert.strictEqual(riskResult.tp1RrString, '1:1.20');
    console.log('✅ [PASS] Test 3: TP1 telemetry correctly displays exact ratio (1:1.20)');
  }

  // Test 4
  {
    const buyResult = evaluateTradeRisk({
      balance: 100,
      entry: 2650.0,
      stopLoss: 2645.0,
      tp1: 2656.0,
      tp2: 2662.5,
      confidence: 85,
      asset: 'XAU/USD',
      direction: 'BUY',
    });

    const sellResult = evaluateTradeRisk({
      balance: 100,
      entry: 2650.0,
      stopLoss: 2655.0,
      tp1: 2644.0,
      tp2: 2637.5,
      confidence: 85,
      asset: 'XAU/USD',
      direction: 'SELL',
    });

    assert.strictEqual(buyResult.valid, true);
    assert.strictEqual(sellResult.valid, true);
    assert.strictEqual(buyResult.tp1Rr, sellResult.tp1Rr);
    assert.strictEqual(buyResult.tp1RrString, sellResult.tp1RrString);
    assert.strictEqual(buyResult.tp2Rr, sellResult.tp2Rr);
    assert.strictEqual(buyResult.tp2RrString, sellResult.tp2RrString);
    console.log('✅ [PASS] Test 4: BUY/SELL symmetry verified for identical distances');
  }

  console.log('\n====================================================');
  console.log('ALL R:R TELEMETRY CONSISTENCY TESTS PASSED CLEANLY');
  console.log('====================================================\n');
}

runRrTelemetryTests().catch((err) => {
  console.error('Fatal R:R telemetry test error:', err);
  process.exit(1);
});
