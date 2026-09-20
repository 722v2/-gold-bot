import { strict as assert } from 'assert';
import {
  evaluateTradeRisk,
  BrokerContractSpecs,
  DEFAULT_BROKER_SPECS,
} from '../server/riskManager.js';
import { calculateDynamicTakeProfits, DynamicTpRequest } from '../server/tpEngine.js';

console.log('====================================================');
console.log('R:R MINIMUM GATE REGRESSION TEST SUITE');
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
// GROUP 1: EXACT R:R SPECTRUM VALIDATION (minTp1RR = 1.0)
// -----------------------------------------------------------------------------

const balance = 100;
const entry = 2650.0;
const slDistance = 5.0; // 50 points -> SL = 2645.0
const sl = entry - slDistance;

const brokerSpecs: BrokerContractSpecs = {
  ...DEFAULT_BROKER_SPECS,
  minRr: 1.0,
  maxLoss: 50.0,
  minGoldSlPoints: 35,
  maxGoldSlPoints: 65,
};

// 0.80R -> TP1 = entry + 4.0 = 2654.0 -> REJECT
runTest('R:R Spectrum: 0.80R is REJECTED when minTp1RR = 1.0', () => {
  const tp1 = entry + 0.8 * slDistance; // 2654.0
  const result = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1,
    brokerSpecs,
  });

  assert.equal(result.valid, false, '0.80R must be rejected');
  assert.equal(result.tp1Rr, 0.8, 'Calculated RR must be 0.80');
  assert.ok(result.reason?.includes('أقل من الحد الأدنى المطلوب'), 'Reason must indicate below required RR');
});

// 0.90R -> TP1 = entry + 4.5 = 2654.5 -> REJECT
runTest('R:R Spectrum: 0.90R is REJECTED when minTp1RR = 1.0', () => {
  const tp1 = entry + 0.9 * slDistance; // 2654.5
  const result = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1,
    brokerSpecs,
  });

  assert.equal(result.valid, false, '0.90R must be rejected');
  assert.equal(result.tp1Rr, 0.9, 'Calculated RR must be 0.90');
  assert.ok(result.reason?.includes('أقل من الحد الأدنى المطلوب'), 'Reason must indicate below required RR');
});

// 0.95R -> TP1 = entry + 4.75 = 2654.75 -> REJECT (Fix 1 verification: no 0.95 clamping)
runTest('R:R Spectrum: 0.95R is REJECTED when minTp1RR = 1.0', () => {
  const tp1 = entry + 0.95 * slDistance; // 2654.75
  const result = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1,
    brokerSpecs,
  });

  assert.equal(result.valid, false, '0.95R must be rejected when minRr is 1.0');
  assert.equal(result.tp1Rr, 0.95, 'Calculated RR must be 0.95');
  assert.ok(result.reason?.includes('أقل من الحد الأدنى المطلوب'), 'Reason must indicate below required RR');
});

// 0.99R -> TP1 = entry + 4.95 = 2654.95 -> REJECT
runTest('R:R Spectrum: 0.99R is REJECTED when minTp1RR = 1.0', () => {
  const tp1 = entry + 0.99 * slDistance; // 2654.95
  const result = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1,
    brokerSpecs,
  });

  assert.equal(result.valid, false, '0.99R must be rejected');
  assert.equal(result.tp1Rr, 0.99, 'Calculated RR must be 0.99');
  assert.ok(result.reason?.includes('أقل من الحد الأدنى المطلوب'), 'Reason must indicate below required RR');
});

// 1.00R -> TP1 = entry + 5.0 = 2655.0 -> ACCEPT
runTest('R:R Spectrum: 1.00R is ACCEPTED when minTp1RR = 1.0', () => {
  const tp1 = entry + 1.0 * slDistance; // 2655.0
  const result = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1,
    brokerSpecs,
  });

  assert.equal(result.valid, true, '1.00R must be accepted');
  assert.equal(result.tp1Rr, 1.0, 'Calculated RR must be exactly 1.00');
});

// 1.10R -> TP1 = entry + 5.5 = 2655.5 -> ACCEPT
runTest('R:R Spectrum: 1.10R is ACCEPTED when minTp1RR = 1.0', () => {
  const tp1 = entry + 1.1 * slDistance; // 2655.5
  const result = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1,
    brokerSpecs,
  });

  assert.equal(result.valid, true, '1.10R must be accepted');
  assert.equal(result.tp1Rr, 1.1, 'Calculated RR must be 1.10');
});

// 1.50R -> TP1 = entry + 7.5 = 2657.5 -> ACCEPT
runTest('R:R Spectrum: 1.50R is ACCEPTED when minTp1RR = 1.0', () => {
  const tp1 = entry + 1.5 * slDistance; // 2657.5
  const result = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1,
    brokerSpecs,
  });

  assert.equal(result.valid, true, '1.50R must be accepted');
  assert.equal(result.tp1Rr, 1.5, 'Calculated RR must be 1.50');
});

// 2.00R -> TP1 = entry + 10.0 = 2660.0 -> ACCEPT
runTest('R:R Spectrum: 2.00R is ACCEPTED when minTp1RR = 1.0', () => {
  const tp1 = entry + 2.0 * slDistance; // 2660.0
  const result = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1,
    brokerSpecs,
  });

  assert.equal(result.valid, true, '2.00R must be accepted');
  assert.equal(result.tp1Rr, 2.0, 'Calculated RR must be 2.00');
});

// -----------------------------------------------------------------------------
// GROUP 2: SELL DIRECTION MIRROR VERIFICATION
// -----------------------------------------------------------------------------

const sellEntry = 2650.0;
const sellSl = sellEntry + slDistance; // 2655.0

runTest('SELL Direction: 0.95R is REJECTED', () => {
  const sellTp1 = sellEntry - 0.95 * slDistance; // 2645.25
  const result = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'SELL',
    entry: sellEntry,
    stopLoss: sellSl,
    tp1: sellTp1,
    brokerSpecs,
  });

  assert.equal(result.valid, false, 'SELL at 0.95R must be rejected');
  assert.equal(result.tp1Rr, 0.95);
});

runTest('SELL Direction: 1.00R is ACCEPTED', () => {
  const sellTp1 = sellEntry - 1.0 * slDistance; // 2645.0
  const result = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'SELL',
    entry: sellEntry,
    stopLoss: sellSl,
    tp1: sellTp1,
    brokerSpecs,
  });

  assert.equal(result.valid, true, 'SELL at 1.00R must be accepted');
  assert.equal(result.tp1Rr, 1.0);
});

// -----------------------------------------------------------------------------
// GROUP 3: CUSTOM MINIMUM R:R CONFIGURATION (e.g. minRr = 1.5)
// -----------------------------------------------------------------------------

const strictBrokerSpecs: BrokerContractSpecs = {
  ...DEFAULT_BROKER_SPECS,
  minRr: 1.5,
  maxLoss: 50.0,
};

runTest('Custom minRr = 1.5 rejects 1.20R and 1.40R, accepts 1.50R and 2.00R', () => {
  const eval120 = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1: entry + 1.2 * slDistance,
    brokerSpecs: strictBrokerSpecs,
  });
  assert.equal(eval120.valid, false, '1.20R must be rejected under minRr 1.5');

  const eval140 = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1: entry + 1.4 * slDistance,
    brokerSpecs: strictBrokerSpecs,
  });
  assert.equal(eval140.valid, false, '1.40R must be rejected under minRr 1.5');

  const eval150 = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1: entry + 1.5 * slDistance,
    brokerSpecs: strictBrokerSpecs,
  });
  assert.equal(eval150.valid, true, '1.50R must be accepted under minRr 1.5');

  const eval200 = evaluateTradeRisk({
    balance,
    asset: 'XAU/USD',
    direction: 'BUY',
    entry,
    stopLoss: sl,
    tp1: entry + 2.0 * slDistance,
    brokerSpecs: strictBrokerSpecs,
  });
  assert.equal(eval200.valid, true, '2.00R must be accepted under minRr 1.5');
});

// -----------------------------------------------------------------------------
// GROUP 4: TP1 STRUCTURAL SELECTION FIRST (NO ARTIFICIAL TP1 EXTENSION)
// -----------------------------------------------------------------------------

runTest('tpEngine selects raw structural target regardless of whether RR is 1.0, 1.2, 1.5 or 3.0', () => {
  const dummyIndicators: any = {
    atr: 2.0,
    support: 2640.0,
    resistance: 2660.0,
    swingHigh: 2658.0,
    swingLow: 2642.0,
    sma20: 2650.0,
    sma50: 2650.0,
    ema9: 2650.0,
    ema21: 2650.0,
    rsi: 50,
    macd: { macd: 0, signal: 0, histogram: 0 },
    bollinger: { upper: 2660, lower: 2640, middle: 2650 },
  };

  const dummyCandles: any[] = [
    { time: 1000, open: 2648, high: 2650, low: 2647, close: 2650, volume: 100 },
  ];

  const req: DynamicTpRequest = {
    direction: 'BUY',
    entry: 2650.0,
    stopLoss: 2646.0, // slDist = 4.0
    asset: 'XAU/USD',
    indicators1h: dummyIndicators,
    indicators15m: dummyIndicators,
    indicators5m: dummyIndicators,
    candles1h: dummyCandles,
    candles15m: dummyCandles,
    candles5m: dummyCandles,
    structuralTargetHint: {
      price: 2655.0, // dist = 5.0 -> 1.25R
      label: 'Local Order Block Upper Limit',
    },
  };

  const tpResult = calculateDynamicTakeProfits(req);
  assert.equal(tpResult.valid, true);
  assert.equal(tpResult.tp1, 2655.0, 'TP1 must match exact structural target (2655.0)');
  assert.equal(tpResult.tp1Rr, 1.25, 'TP1 RR must be natural 1.25R derived from structural target');
  assert.equal(tpResult.isModified, false, 'Target must not be modified or extended');
});

console.log('====================================================');
console.log(`R:R MINIMUM GATE REGRESSION RESULT: ${passedTests} OF ${totalTests} TESTS PASSED`);
console.log('====================================================');
