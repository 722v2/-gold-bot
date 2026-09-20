import { strict as assert } from 'assert';
import {
  calculatePositionSizing,
  evaluateTradeRisk,
  BrokerContractSpecs,
  DEFAULT_BROKER_SPECS,
} from '../server/riskManager.js';

console.log('====================================================');
console.log('RISK CONSISTENCY REGRESSION TEST SUITE');
console.log('====================================================');

let passedTests = 0;
let totalTests = 0;

function runTest(name: string, fn: () => void) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`✅ [PASS] Test ${totalTests}: ${name}`);
  } catch (error: any) {
    console.error(`❌ [FAIL] Test ${totalTests}: ${name}`);
    console.error(`   Error: ${error.message}`);
    throw error;
  }
}

// -----------------------------------------------------------------------------
// GROUP 1: STRUCTURAL STOP LOSS INTEGRITY & NO ARTIFICIAL DISTORTION (FIX 1 & 9)
// -----------------------------------------------------------------------------

runTest('Fix 1 & 9: BUY trade does not distort or shift Entry / SL to fit lot sizes', () => {
  const entry = 2650.0;
  const sl = 2645.5; // 45 points ($4.50 distance)
  const tp1 = 2659.0; // 90 points (1:2.0 RR)
  const balance = 10;
  const brokerSpecs: BrokerContractSpecs = {
    ...DEFAULT_BROKER_SPECS,
    maxLoss: 5.0,
    minGoldSlPoints: 35,
    maxGoldSlPoints: 65,
  };

  const riskResult = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1,
    brokerSpecs,
  });

  assert.equal(riskResult.valid, true, 'Trade should be valid');
  assert.equal(riskResult.priceDistance, 4.5, 'Price distance must be exactly 4.50');
  assert.equal(riskResult.slPoints, 45, 'SL points must remain exactly 45.0');
  assert.equal(riskResult.adjustedEntry, undefined, 'Adjusted entry must not exist');
  assert.equal(riskResult.adjustedStopLoss, undefined, 'Adjusted stop loss must not exist');
  assert.equal(riskResult.positionSizing.entryPrice, entry, 'Position sizing entry must match exact input');
  assert.equal(riskResult.positionSizing.stopLossPrice, sl, 'Position sizing SL must match exact input');
});

runTest('Fix 1 & 9: SELL trade does not distort or shift Entry / SL to fit lot sizes', () => {
  const entry = 2650.0;
  const sl = 2654.5; // 45 points ($4.50 distance)
  const tp1 = 2641.0; // 90 points (1:2.0 RR)
  const balance = 10;
  const brokerSpecs: BrokerContractSpecs = {
    ...DEFAULT_BROKER_SPECS,
    maxLoss: 5.0,
    minGoldSlPoints: 35,
    maxGoldSlPoints: 65,
  };

  const riskResult = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'SELL',
    entry,
    stopLoss: sl,
    tp1,
    brokerSpecs,
  });

  assert.equal(riskResult.valid, true, 'Trade should be valid');
  assert.equal(riskResult.priceDistance, 4.5, 'Price distance must be exactly 4.50');
  assert.equal(riskResult.slPoints, 45, 'SL points must remain exactly 45.0');
  assert.equal(riskResult.adjustedEntry, undefined, 'Adjusted entry must not exist');
  assert.equal(riskResult.adjustedStopLoss, undefined, 'Adjusted stop loss must not exist');
  assert.equal(riskResult.positionSizing.entryPrice, entry, 'Position sizing entry must match exact input');
  assert.equal(riskResult.positionSizing.stopLossPrice, sl, 'Position sizing SL must match exact input');
});

// -----------------------------------------------------------------------------
// GROUP 2: MINIMUM BROKER LOT (0.01) & ABSOLUTE LOSS CAP (FIX 2 & 3)
// -----------------------------------------------------------------------------

runTest('Fix 2 & 3: $10 balance with 35 pt SL ($3.50 monetary risk) is allowed on 0.01 lot under $5.00 Max Loss', () => {
  const sizing = calculatePositionSizing(10, 15.0, 2650.0, 2646.5, {
    contractSizeOz: 100,
    minimumLot: 0.01,
    maxLoss: 5.0,
  });

  assert.equal(sizing.isExecutable, true, 'Should be executable at min lot');
  assert.equal(sizing.standardLotSize, 0.01, 'Standard lot size must be 0.01');
  assert.equal(sizing.estimatedMaxLoss, 3.5, 'Estimated max loss must be $3.50');
  assert.ok(sizing.estimatedMaxLoss <= 5.0, 'Loss must not exceed $5.00 max loss cap');
});

runTest('Fix 2 & 3: $10 balance with 50 pt SL ($5.00 monetary risk) is allowed on 0.01 lot at exact $5.00 Max Loss', () => {
  const sizing = calculatePositionSizing(10, 15.0, 2650.0, 2645.0, {
    contractSizeOz: 100,
    minimumLot: 0.01,
    maxLoss: 5.0,
  });

  assert.equal(sizing.isExecutable, true, 'Should be executable at min lot');
  assert.equal(sizing.standardLotSize, 0.01, 'Standard lot size must be 0.01');
  assert.equal(sizing.estimatedMaxLoss, 5.0, 'Estimated max loss must be $5.00');
  assert.ok(sizing.estimatedMaxLoss <= 5.0, 'Loss must not exceed $5.00 max loss cap');
});

runTest('Fix 2 & 3: $10 balance with 65 pt SL ($6.50 monetary risk) is REJECTED under $5.00 Max Loss', () => {
  const sizing = calculatePositionSizing(10, 15.0, 2650.0, 2643.5, {
    contractSizeOz: 100,
    minimumLot: 0.01,
    maxLoss: 5.0,
  });

  assert.equal(sizing.isExecutable, false, 'Must be rejected because $6.50 > $5.00 maxLoss');
  assert.ok(
    sizing.nonExecutableReason?.includes('exceeds configured Max Loss limit'),
    'Reason must explain max loss limit breach'
  );
});

// -----------------------------------------------------------------------------
// GROUP 3: RISK PERCENTAGE SINGLE-APPLICATION (FIX 4)
// -----------------------------------------------------------------------------

runTest('Fix 4: Risk percentage is applied exactly once to calculate risk budget', () => {
  const balance = 100;
  const riskPercent = 15.0; // 15% -> $15.00
  const sizing = calculatePositionSizing(balance, riskPercent, 2650.0, 2645.0, {
    contractSizeOz: 100,
    minimumLot: 0.01,
    maxLoss: 50.0,
  });

  assert.equal(sizing.riskDollars, 15.0, 'Risk dollars must be exactly $15.00 on $100 at 15%');
  // priceDistance = 5.0, riskPerLot = 500, standardLot = 15 / 500 = 0.03
  assert.equal(sizing.standardLotSize, 0.03, 'Lot size must be 0.03 lots');
  assert.equal(sizing.estimatedMaxLoss, 15.0, 'Estimated max loss must be $15.00');
});

// -----------------------------------------------------------------------------
// GROUP 4: SINGLE-TARGET TP2 = 0 HANDLING (FIX 5)
// -----------------------------------------------------------------------------

runTest('Fix 5: Single-target trade with tp2=0 has hasValidTp2=false and clean target strings', () => {
  const entry = 2650.0;
  const sl = 2645.0; // 50 pts
  const tp1 = 2657.5; // 75 pts (1:1.50)
  const tp2 = 0; // single target

  const evalResult = evaluateTradeRisk({
    balance: 100,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1,
    tp2,
  });

  assert.equal(evalResult.valid, true, 'Trade must be valid');
  assert.equal(evalResult.hasValidTp2, false, 'hasValidTp2 must be false');
  assert.equal(evalResult.tp2Points, 0, 'tp2Points must be 0');
  assert.equal(evalResult.tp2Distance, 0, 'tp2Distance must be 0');
  assert.equal(evalResult.tp2Rr, 0, 'tp2Rr must be 0');
  assert.equal(evalResult.tp2RrString, 'N/A', 'tp2RrString must be N/A');
  assert.ok(!evalResult.rrString.includes('TP2'), 'rrString should only describe TP1');
});

runTest('Fix 5: Dual-target trade with valid tp2 has hasValidTp2=true and both targets formatted', () => {
  const entry = 2650.0;
  const sl = 2645.0; // 50 pts
  const tp1 = 2657.5; // 75 pts (1:1.50)
  const tp2 = 2665.0; // 150 pts (1:3.00)

  const evalResult = evaluateTradeRisk({
    balance: 100,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1,
    tp2,
  });

  assert.equal(evalResult.valid, true, 'Trade must be valid');
  assert.equal(evalResult.hasValidTp2, true, 'hasValidTp2 must be true');
  assert.equal(evalResult.tp2Points, 150, 'tp2Points must be 150');
  assert.equal(evalResult.tp2Rr, 3.0, 'tp2Rr must be 3.0');
  assert.ok(evalResult.rrString.includes('TP1:') && evalResult.rrString.includes('TP2:'), 'rrString must describe both targets');
});

// -----------------------------------------------------------------------------
// GROUP 5: R:R AS OUTPUT METRIC ONLY (FIX 6)
// -----------------------------------------------------------------------------

runTest('Fix 6: Position sizing is independent of R:R ratio (varies TP without changing lot size)', () => {
  const balance = 100;
  const entry = 2650.0;
  const sl = 2646.0; // 40 pts -> $4.00 price distance, $400/lot
  const brokerSpecs = { contractSizeOz: 100, minimumLot: 0.01, maxLoss: 50.0 };

  // Trade A: TP1 = 2654 (1:1.0 RR)
  const evalA = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1: 2654.0,
    brokerSpecs,
  });

  // Trade B: TP1 = 2666 (1:4.0 RR)
  const evalB = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1: 2666.0,
    brokerSpecs,
  });

  assert.equal(evalA.valid, true);
  assert.equal(evalB.valid, true);
  assert.equal(
    evalA.positionSizing.standardLotSize,
    evalB.positionSizing.standardLotSize,
    'Lot size must be identical regardless of whether RR is 1.0 or 4.0'
  );
  assert.equal(
    evalA.positionSizing.estimatedMaxLoss,
    evalB.positionSizing.estimatedMaxLoss,
    'Estimated loss must be identical regardless of RR'
  );
});

// -----------------------------------------------------------------------------
// GROUP 6: BUY / SELL MIRROR SYMMETRY TEST (FIX 7)
// -----------------------------------------------------------------------------

runTest('Fix 7: BUY and SELL mirror trades produce identical sizing, points, and risk metrics', () => {
  const balance = 50;
  const distance = 4.2; // 42 points
  const targetDistance = 8.4; // 84 points (1:2.0 RR)

  const buyEntry = 2650.0;
  const buySl = buyEntry - distance;
  const buyTp1 = buyEntry + targetDistance;

  const sellEntry = 2650.0;
  const sellSl = sellEntry + distance;
  const sellTp1 = sellEntry - targetDistance;

  const brokerSpecs = { ...DEFAULT_BROKER_SPECS, maxLoss: 10.0 };

  const buyEval = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry: buyEntry,
    stopLoss: buySl,
    tp1: buyTp1,
    brokerSpecs,
  });

  const sellEval = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'SELL',
    entry: sellEntry,
    stopLoss: sellSl,
    tp1: sellTp1,
    brokerSpecs,
  });

  assert.equal(buyEval.valid, true);
  assert.equal(sellEval.valid, true);
  assert.equal(buyEval.slPoints, sellEval.slPoints, 'SL points must match');
  assert.equal(buyEval.priceDistance, sellEval.priceDistance, 'Price distance must match');
  assert.equal(buyEval.tp1Points, sellEval.tp1Points, 'TP1 points must match');
  assert.equal(buyEval.tp1Rr, sellEval.tp1Rr, 'TP1 RR must match');
  assert.equal(buyEval.recommendedLotSize, sellEval.recommendedLotSize, 'Lot size must match');
  assert.equal(buyEval.potentialLoss, sellEval.potentialLoss, 'Potential loss must match');
  assert.equal(buyEval.potentialProfit, sellEval.potentialProfit, 'Potential profit must match');
});

// -----------------------------------------------------------------------------
// GROUP 7: ROUNDING SAFETY (FIX 8)
// -----------------------------------------------------------------------------

runTest('Fix 8: Fractional lot size rounds down to step size and never rounds up beyond maxLoss', () => {
  // Balance $100, risk 15% ($15.00), price distance $3.70 (37 pts)
  // riskPerLot = 370. raw lot = 15 / 370 = 0.0405405... lots.
  // Step size 0.01 -> should be 0.04 lots, loss = 0.04 * 370 = $14.80 <= $15.00
  const sizing = calculatePositionSizing(100, 15.0, 2650.0, 2646.3, {
    contractSizeOz: 100,
    minimumLot: 0.01,
    lotStep: 0.01,
    maxLoss: 15.0,
  });

  assert.equal(sizing.standardLotSize, 0.04, 'Must round down to 0.04, not up to 0.05');
  assert.ok(sizing.estimatedMaxLoss <= 15.0, 'Estimated loss must be <= $15.00');
  assert.equal(sizing.estimatedMaxLoss, 14.8, 'Estimated loss must be $14.80');
});

// -----------------------------------------------------------------------------
// GROUP 8: 24 SCENARIOS MATRIX ($10 - $100 BALANCES x 35-65 PT SL MATRIX)
// -----------------------------------------------------------------------------

const testBalances = [10, 15, 20, 25, 50, 100];
const testSlPoints = [35, 40, 50, 65];

for (const bal of testBalances) {
  for (const slPts of testSlPoints) {
    const slDist = slPts * 0.1;
    const testName = `Scenario Matrix: Balance $${bal}, SL ${slPts} pts ($${slDist.toFixed(2)} dist)`;

    runTest(testName, () => {
      const brokerSpecs: BrokerContractSpecs = {
        ...DEFAULT_BROKER_SPECS,
        maxLoss: 5.0,
        minGoldSlPoints: 35,
        maxGoldSlPoints: 65,
      };

      const entry = 2600.0;
      const sl = entry - slDist;
      const tp1 = entry + slDist * 1.5; // 1:1.5 RR

      const sizing = calculatePositionSizing(bal, 15.0, entry, sl, brokerSpecs);
      const evalResult = evaluateTradeRisk({
        balance: bal,
        asset: 'XAU/USD',
        direction: 'BUY',
        entry,
        stopLoss: sl,
        tp1,
        brokerSpecs,
      });

      const monetaryLossAtMinLot = Number((0.01 * slDist * 100).toFixed(2));

      // 35 pts = $3.50 <= $5.00 -> executable
      // 40 pts = $4.00 <= $5.00 -> executable
      // 50 pts = $5.00 <= $5.00 -> executable
      // 65 pts = $6.50 > $5.00 -> rejected by max loss cap
      if (slPts <= 50) {
        assert.equal(sizing.isExecutable, true, `Should be executable for SL ${slPts} pts`);
        assert.equal(evalResult.valid, true, `EvalResult should be valid for SL ${slPts} pts`);
        assert.ok(sizing.estimatedMaxLoss <= 5.0001, 'Estimated max loss must not exceed $5.00');
        assert.equal(sizing.priceDistance, Number(slDist.toFixed(2)));
        assert.equal(evalResult.slPoints, slPts);
      } else {
        assert.equal(sizing.isExecutable, false, `Should be rejected for SL ${slPts} pts ($${monetaryLossAtMinLot.toFixed(2)} > $5.00)`);
        assert.equal(evalResult.valid, false, `EvalResult should be invalid for SL ${slPts} pts`);
      }
    });
  }
}

// -----------------------------------------------------------------------------
// SUMMARY
// -----------------------------------------------------------------------------
console.log('====================================================');
console.log(`RISK CONSISTENCY REGRESSION RESULT: ${passedTests} OF ${totalTests} TESTS PASSED`);
console.log('====================================================');
