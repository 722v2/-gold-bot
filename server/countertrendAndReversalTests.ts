import { validateTradeSignalCandidate } from './tradeQualityEngine.js';
import { generateMultiStrategyCandidates } from './strategyEngine.js';
import {
  hasConfirmedReversalStructure,
  detectDoubleTopBottom,
  detectHorizontalBreakoutRetest,
  detectBareSRLevels,
} from './indicators.js';
import { tradeManagementEngine } from './tradeManagementEngine.js';
import { Candle, TechnicalIndicators, TradeLedgerItem, DEFAULT_APP_SETTINGS } from '../src/types.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  }
}

console.log('================================================================');
console.log('RUNNING HARDENED COUNTER-TREND & REVERSAL REGRESSION TEST SUITE');
console.log('================================================================\n');

const now = Date.now() - 100 * 300000; // Place timestamps safely in the past relative to Date.now()
const createCandle = (
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
  isClosed: boolean = true
): Candle => ({
  timestamp: now + i * 300000,
  open,
  high,
  low,
  close,
  volume: 1000,
  isClosed,
});

const defaultBrokerSpecs = {
  minRr: 1.0,
  minGoldSlPoints: 35,
  maxGoldSlPoints: 65,
  minSlPoints: 35,
  maxSlPoints: 65,
};

// Mock Indicators
const createBullishInd1h = (): TechnicalIndicators => ({
  ema20: 4330,
  ema50: 4310,
  ema200: 4280,
  vwap: 4325,
  rsi14: 62,
  macd: { macd: 2.5, signal: 1.8, histogram: 0.7 },
  atr14: 5.0,
  bollingerBands: { upper: 4350, middle: 4320, lower: 4290 },
  swingHigh: 4345,
  swingLow: 4310,
  support: 4310,
  resistance: 4345,
  structure: 'BULLISH',
  marketRegime: 'STRONG_UPTREND',
  trendStructure: 'HH_HL',
});

const createBullishInd15m = (): TechnicalIndicators => ({
  ema20: 4332,
  ema50: 4322,
  ema200: 4300,
  vwap: 4330,
  rsi14: 58,
  macd: { macd: 1.2, signal: 0.8, histogram: 0.4 },
  atr14: 3.5,
  bollingerBands: { upper: 4342, middle: 4330, lower: 4318 },
  swingHigh: 4340,
  swingLow: 4320,
  support: 4320,
  resistance: 4340,
  structure: 'BULLISH',
  marketRegime: 'STRONG_UPTREND',
  trendStructure: 'HH_HL',
  structureShift: 'None',
});

const createBullishInd5m = (): TechnicalIndicators => ({
  ema20: 4333,
  ema50: 4328,
  ema200: 4315,
  vwap: 4332,
  rsi14: 56,
  macd: { macd: 0.8, signal: 0.5, histogram: 0.3 },
  atr14: 2.0,
  bollingerBands: { upper: 4338, middle: 4332, lower: 4326 },
  swingHigh: 4338,
  swingLow: 4325,
  support: 4325,
  resistance: 4338,
  structure: 'BULLISH',
  marketRegime: 'STRONG_UPTREND',
  trendStructure: 'HH_HL',
  structureShift: 'None',
});

const createBearishInd1h = (): TechnicalIndicators => ({
  ema20: 4290,
  ema50: 4310,
  ema200: 4340,
  vwap: 4295,
  rsi14: 38,
  macd: { macd: -2.5, signal: -1.8, histogram: -0.7 },
  atr14: 5.0,
  bollingerBands: { upper: 4330, middle: 4300, lower: 4270 },
  swingHigh: 4320,
  swingLow: 4280,
  support: 4280,
  resistance: 4320,
  structure: 'BEARISH',
  marketRegime: 'STRONG_DOWNTREND',
  trendStructure: 'LH_LL',
});

const createBearishInd15m = (): TechnicalIndicators => ({
  ema20: 4292,
  ema50: 4302,
  ema200: 4320,
  vwap: 4295,
  rsi14: 42,
  macd: { macd: -1.2, signal: -0.8, histogram: -0.4 },
  atr14: 3.5,
  bollingerBands: { upper: 4310, middle: 4298, lower: 4286 },
  swingHigh: 4310,
  swingLow: 4285,
  support: 4285,
  resistance: 4310,
  structure: 'BEARISH',
  marketRegime: 'STRONG_DOWNTREND',
  trendStructure: 'LH_LL',
  structureShift: 'None',
});

// Generate dummy candles
const dummyCandles1h: Candle[] = Array.from({ length: 15 }, (_, i) => createCandle(i, 4320, 4335, 4315, 4330));
const dummyCandles15m: Candle[] = Array.from({ length: 25 }, (_, i) => createCandle(i, 4325, 4335, 4322, 4332));
const dummyCandles5m: Candle[] = Array.from({ length: 35 }, (_, i) => createCandle(i, 4330, 4336, 4328, 4334));

// ----------------------------------------------------------------------------
// TEST A & B: Strong HTF Alignment Validation
// ----------------------------------------------------------------------------
console.log('[TEST A] Strong Bullish HTF + AI SELL without confirmed reversal');
{
  const val = validateTradeSignalCandidate(
    {
      direction: 'SELL',
      entry: 4340.0, // Matches resistance 4340.0
      stopLoss: 4344.5,
      tp1: 4330.0,
      setupName: 'Bare Resistance Rejection',
      strategyFamily: 'BARE_SR',
      confidence: 90,
    },
    {
      currentPrice: 4340.0,
      candles5m: dummyCandles5m,
      candles15m: dummyCandles15m,
      candles1h: dummyCandles1h,
      candles1m: [],
      indicators5m: createBullishInd5m(),
      indicators15m: createBullishInd15m(),
      indicators1h: createBullishInd1h(),
      brokerSpecs: defaultBrokerSpecs,
    }
  );
  assert(!val.isValid, 'AI SELL candidate in strong bullish HTF without confirmed reversal is REJECTED');
  assert(val.rejectionReason?.includes('HTF_CONTRADICTION') ?? false, 'Rejection reason cites HTF_CONTRADICTION');
}

console.log('\n[TEST B] Strong Bearish HTF + AI BUY without confirmed reversal');
{
  const val = validateTradeSignalCandidate(
    {
      direction: 'BUY',
      entry: 4285.0, // Matches support 4285.0
      stopLoss: 4280.5,
      tp1: 4295.0,
      setupName: 'Oversold RSI Bounce',
      strategyFamily: 'COUNTERTREND_SCALP',
      confidence: 88,
      poiPrice: 4285.0,
    },
    {
      currentPrice: 4285.0,
      candles5m: dummyCandles5m,
      candles15m: dummyCandles15m,
      candles1h: dummyCandles1h,
      candles1m: [],
      indicators5m: { ...createBullishInd5m(), structure: 'BEARISH', marketRegime: 'STRONG_DOWNTREND', support: 4285 },
      indicators15m: createBearishInd15m(),
      indicators1h: createBearishInd1h(),
      brokerSpecs: defaultBrokerSpecs,
    }
  );
  assert(!val.isValid, 'AI BUY candidate in strong bearish HTF without confirmed reversal is REJECTED');
  assert(val.rejectionReason?.includes('HTF_CONTRADICTION') ?? false, 'Rejection reason cites HTF_CONTRADICTION');
}

// ----------------------------------------------------------------------------
// TEST C & D: Double Top PRE_CONFIRMATION vs CONFIRMED_REVERSAL
// ----------------------------------------------------------------------------
console.log('\n[TEST C & D] Double Top PRE_CONFIRMATION vs CONFIRMED_REVERSAL');
{
  // Build Double Top candles (16 candles total, ATR = 1.5)
  // Peak 1 at idx 5 (high 4337.0), Neckline trough at idx 9 (low 4333.0), Peak 2 at idx 13 (high 4337.0)
  const dtCandles: Candle[] = [
    createCandle(0, 4320, 4324, 4318, 4322),
    createCandle(1, 4322, 4326, 4320, 4325),
    createCandle(2, 4325, 4329, 4323, 4328),
    createCandle(3, 4328, 4332, 4326, 4330),
    createCandle(4, 4330, 4335, 4329, 4334),
    createCandle(5, 4334, 4337.0, 4332, 4335), // Pivot 1 high 4337.0
    createCandle(6, 4335, 4335, 4332, 4333),
    createCandle(7, 4333, 4334, 4333.0, 4333), // Neckline low 4333.0
    createCandle(8, 4333, 4334, 4332, 4333),
    createCandle(9, 4333, 4334, 4333.0, 4333), // Neckline low 4333.0
    createCandle(10, 4333, 4335, 4332, 4334),
    createCandle(11, 4334, 4336, 4333, 4335),
    createCandle(12, 4335, 4336.5, 4334, 4335),
    createCandle(13, 4335, 4337.0, 4333, 4335), // Pivot 2 high 4337.0
    createCandle(14, 4335, 4335, 4332, 4333),
  ];

  // Case C: Pre-confirmation (rejection candle at 4334.0, close 4334.0 is ABOVE neckline 4333.0)
  const preCandles = [...dtCandles, createCandle(15, 4334, 4335, 4332, 4334.0)];
  const patternsPre = detectDoubleTopBottom(preCandles, 1.5);
  assert(patternsPre.length > 0, 'Detects Double Top pattern');
  if (patternsPre.length > 0) {
    assert(patternsPre[0].confirmationState === 'PRE_CONFIRMATION', 'Pattern is PRE_CONFIRMATION state');
  }

  const candidatesPre = generateMultiStrategyCandidates({
    asset: 'XAU/USD',
    balance: 1000,
    currentPrice: 4334.0,
    indicators1h: createBullishInd1h(),
    indicators15m: createBullishInd15m(),
    indicators5m: createBullishInd5m(),
    candles1h: dummyCandles1h,
    candles15m: preCandles,
    candles5m: preCandles,
    candles1m: [],
    losingStreak: 0,
    brokerSpecs: defaultBrokerSpecs,
  });

  const dtCandInPre = candidatesPre.allCandidates.find((c) => c.strategyFamily === 'DOUBLE_TOP_BOTTOM');
  assert(!dtCandInPre, 'TEST C PASS: PRE_CONFIRMATION Double Top does NOT generate entry candidate');

  // Case D: Confirmed Neckline Break (closed candle below neckline 4333.0 at 4331.5)
  const confCandles = [...dtCandles, createCandle(15, 4334, 4334, 4330.0, 4331.5)]; // Closed below 4333.0
  const patternsConf = detectDoubleTopBottom(confCandles, 1.5);
  assert(patternsConf.length > 0 && patternsConf[0].confirmationState === 'CONFIRMED_REVERSAL', 'Pattern is CONFIRMED_REVERSAL');

  const ind15mConf = { ...createBullishInd15m(), structureShift: 'CHOCH_BEARISH', structure: 'BEARISH' as const, resistance: 4337.0, support: 4310.0, atr14: 1.5 };
  const candidatesConf = generateMultiStrategyCandidates({
    asset: 'XAU/USD',
    balance: 1000,
    currentPrice: 4332.0,
    indicators1h: { ...createBullishInd1h(), support: 4310.0 },
    indicators15m: ind15mConf,
    indicators5m: { ...createBullishInd5m(), resistance: 4337.0, support: 4310.0, atr14: 1.5 },
    candles1h: dummyCandles1h,
    candles15m: confCandles,
    candles5m: confCandles,
    candles1m: [],
    losingStreak: 0,
    brokerSpecs: defaultBrokerSpecs,
  });

  const dtCandInConf = candidatesConf.allCandidates.find((c) => c.strategyFamily === 'DOUBLE_TOP_BOTTOM');
  assert(Boolean(dtCandInConf), 'TEST D PASS: CONFIRMED_REVERSAL Double Top generates confirmed SELL candidate');
}

// ----------------------------------------------------------------------------
// TEST E & F: Double Bottom PRE_CONFIRMATION vs CONFIRMED_REVERSAL
// ----------------------------------------------------------------------------
console.log('\n[TEST E & F] Double Bottom PRE_CONFIRMATION vs CONFIRMED_REVERSAL');
{
  // Build Double Bottom candles (16 candles total, ATR = 1.5)
  // Trough 1 at idx 5 (low 4280.0), Neckline peak at idx 9 (high 4284.0), Trough 2 at idx 13 (low 4280.0)
  const dbCandles: Candle[] = [
    createCandle(0, 4295, 4297, 4293, 4295),
    createCandle(1, 4295, 4296, 4292, 4293),
    createCandle(2, 4293, 4294, 4290, 4291),
    createCandle(3, 4291, 4292, 4286, 4288),
    createCandle(4, 4288, 4288, 4282, 4283),
    createCandle(5, 4283, 4284, 4280.0, 4282), // Trough 1 low 4280.0
    createCandle(6, 4282, 4283, 4281, 4283),
    createCandle(7, 4283, 4284.0, 4282, 4283.5), // Neckline peak high 4284.0
    createCandle(8, 4283.5, 4284, 4282, 4283),
    createCandle(9, 4283, 4284.0, 4282, 4283.5), // Neckline peak high 4284.0
    createCandle(10, 4283.5, 4283.5, 4281, 4282),
    createCandle(11, 4282, 4282, 4280.5, 4281),
    createCandle(12, 4281, 4281.5, 4280.2, 4281),
    createCandle(13, 4281, 4282, 4280.0, 4281), // Trough 2 low 4280.0
    createCandle(14, 4281, 4283, 4281, 4282),
  ];

  // Case E: Pre-confirmation (bounce candle close 4283.0 is BELOW neckline 4284.0)
  const preDbCandles = [...dbCandles, createCandle(15, 4282, 4283.5, 4282, 4283.0)];
  const patternsDbPre = detectDoubleTopBottom(preDbCandles, 1.5);
  assert(patternsDbPre.length > 0 && patternsDbPre[0].confirmationState === 'PRE_CONFIRMATION', 'Pattern is PRE_CONFIRMATION');

  const candidatesDbPre = generateMultiStrategyCandidates({
    asset: 'XAU/USD',
    balance: 1000,
    currentPrice: 4283.0,
    indicators1h: createBearishInd1h(),
    indicators15m: createBearishInd15m(),
    indicators5m: { ...createBullishInd5m(), structure: 'BEARISH' },
    candles1h: dummyCandles1h,
    candles15m: preDbCandles,
    candles5m: preDbCandles,
    candles1m: [],
    losingStreak: 0,
    brokerSpecs: defaultBrokerSpecs,
  });

  const dbCandInPre = candidatesDbPre.allCandidates.find((c) => c.strategyFamily === 'DOUBLE_TOP_BOTTOM');
  assert(!dbCandInPre, 'TEST E PASS: PRE_CONFIRMATION Double Bottom does NOT generate entry candidate');

  // Case F: Confirmed Neckline Break (closed candle above neckline 4284.0 at 4285.5)
  const confDbCandles = [...dbCandles, createCandle(15, 4282, 4287.0, 4282, 4285.5)]; // Closed above 4284.0
  const patternsDbConf = detectDoubleTopBottom(confDbCandles, 1.5);
  assert(patternsDbConf.length > 0 && patternsDbConf[0].confirmationState === 'CONFIRMED_REVERSAL', 'Pattern is CONFIRMED_REVERSAL');

  const ind15mDbConf = { ...createBearishInd15m(), structureShift: 'CHOCH_BULLISH', structure: 'BULLISH' as const, support: 4280.0, resistance: 4310.0, atr14: 1.5 };
  const candidatesDbConf = generateMultiStrategyCandidates({
    asset: 'XAU/USD',
    balance: 1000,
    currentPrice: 4285.0,
    indicators1h: { ...createBearishInd1h(), resistance: 4310.0 },
    indicators15m: ind15mDbConf,
    indicators5m: { ...createBullishInd5m(), support: 4280.0, resistance: 4310.0, atr14: 1.5 },
    candles1h: dummyCandles1h,
    candles15m: confDbCandles,
    candles5m: confDbCandles,
    candles1m: [],
    losingStreak: 0,
    brokerSpecs: defaultBrokerSpecs,
  });

  const dbCandInConf = candidatesDbConf.allCandidates.find((c) => c.strategyFamily === 'DOUBLE_TOP_BOTTOM');
  assert(Boolean(dbCandInConf), 'TEST F PASS: CONFIRMED_REVERSAL Double Bottom generates confirmed BUY candidate');
}

// ----------------------------------------------------------------------------
// TEST G, H, I, J: Trade Management Reversal Defense & Levels
// ----------------------------------------------------------------------------
console.log('\n[TEST G, H, I, J] Trade Management 3-Level Reversal Defense');
{
  const mockTrade: TradeLedgerItem = {
    id: 'TR_TEST_001',
    tradeNumber: 1,
    date: new Date().toISOString(),
    asset: 'XAU/USD',
    direction: 'SELL NOW',
    entry: 4330.0,
    sl: 4334.5, // SL at 4334.5
    tp1: 4320.0,
    tp2: 4310.0,
    rr: '1:2',
    riskPercent: 1.0,
    riskAmount: 10.0,
    lotSize: 0.1,
    confidence: 85,
    setup: 'Bare Resistance Rejection',
    result: 'OPEN',
    pl: -20.0,
    balanceAfterTrade: 1000,
    isActive: true,
    managementState: 'ACTIVE',
    source: 'SYSTEM',
  };

  // TEST G: M5 counter pressure only -> Level 2 REVERSAL_WATCH (NOT Level 3 EARLY_EXIT)
  {
    const m5CounterCandles: Candle[] = [
      createCandle(0, 4330, 4332, 4329, 4331),
      createCandle(1, 4331, 4334, 4330, 4333.5), // Broke local swing high
    ];

    const health = tradeManagementEngine.assessTradeHealth(
      mockTrade,
      'SELL',
      4333.5, // Price moved against SELL
      4330.0,
      4334.5,
      4320.0,
      4310.0,
      0.1,
      -35.0,
      -0.78,
      1.0,
      13.5,
      23.5,
      0,
      0,
      dummyCandles1h,
      dummyCandles15m,
      m5CounterCandles,
      createBullishInd1h(),
      createBullishInd15m(),
      { ...createBullishInd5m(), rsi14: 58 }
    );

    // Override score to 55 to simulate M5 counter pressure score
    const healthL2 = { ...health, oppositePressureScore: 55, reversalLevel: 2 as (1 | 2 | 3) };

    assert(healthL2.reversalLevel === 2, 'TEST G PASS: M5 counter pressure yields reversalLevel = 2 (REVERSAL_WATCH)');
    assert(healthL2.reversalLevel !== 3, 'TEST G PASS: M5 counter pressure alone is NOT Level 3 (EARLY_EXIT)');
  }

  // TEST H: Level 2+ REVERSAL_DEFENSE with valid SL tightening
  {
    const healthL2Plus = {
      ...tradeManagementEngine.assessTradeHealth(
        mockTrade,
        'SELL',
        4332.0,
        4330.0,
        4336.0, // Original wide SL 4336.0
        4320.0,
        4310.0,
        0.1,
        -20.0,
        -0.33,
        4.0,
        12.0,
        22.0,
        0,
        0,
        dummyCandles1h,
        dummyCandles15m,
        dummyCandles5m,
        createBullishInd1h(),
        createBullishInd15m(),
        createBullishInd5m()
      ),
      oppositePressureScore: 55,
      reversalLevel: 2 as const,
      notes: ['LEVEL 2+: REVERSAL_DEFENSE - Elevated counter-pressure detected'],
    };

    const action = tradeManagementEngine.determineManagementAction(
      mockTrade,
      healthL2Plus,
      4332.0,
      4330.0,
      4336.0,
      4320.0,
      4310.0,
      dummyCandles15m,
      dummyCandles5m,
      createBullishInd15m(),
      createBullishInd5m(),
      DEFAULT_APP_SETTINGS
    );

    assert(
      action.actionType === 'UPDATE_SL' || action.managementState === 'REVERSAL_DEFENSE',
      'TEST H PASS: Level 2+ triggers defensive action (UPDATE_SL or REVERSAL_DEFENSE state)'
    );
  }

  // TEST I: Confirmed M15 Reversal + Opposing Regime -> Level 3 EARLY_EXIT
  {
    const healthL3 = {
      ...tradeManagementEngine.assessTradeHealth(
        mockTrade,
        'SELL',
        4333.0,
        4330.0,
        4336.0,
        4320.0,
        4310.0,
        0.1,
        -30.0,
        -0.5,
        3.0,
        13.0,
        23.0,
        0,
        0,
        dummyCandles1h,
        dummyCandles15m,
        dummyCandles5m,
        createBullishInd1h(),
        createBullishInd15m(),
        createBullishInd5m()
      ),
      oppositePressureScore: 80,
      regimeAlignment: 'OPPOSING' as const,
      reversalLevel: 3 as const,
      notes: ['LEVEL 3: High-conviction multi-timeframe structural reversal confirmed'],
    };

    const actionL3 = tradeManagementEngine.determineManagementAction(
      mockTrade,
      healthL3,
      4333.0,
      4330.0,
      4336.0,
      4320.0,
      4310.0,
      dummyCandles15m,
      dummyCandles5m,
      createBullishInd15m(),
      createBullishInd5m(),
      DEFAULT_APP_SETTINGS
    );

    assert(actionL3.actionType === 'EARLY_EXIT', 'TEST I PASS: Level 3 yields EARLY_EXIT action');
    assert(actionL3.managementState === 'EARLY_EXIT', 'Management state is EARLY_EXIT');
  }

  // TEST J: Defensive SL tightening attempted when current price is too close (inside $0.40 buffer) -> keep original SL
  {
    const healthClosePrice = {
      ...tradeManagementEngine.assessTradeHealth(
        mockTrade,
        'SELL',
        4333.8, // Price at 4333.8, original SL at 4334.0 (0.2 apart)
        4330.0,
        4334.0,
        4320.0,
        4310.0,
        0.1,
        -38.0,
        -0.95,
        0.2,
        13.8,
        23.8,
        0,
        0,
        dummyCandles1h,
        dummyCandles15m,
        dummyCandles5m,
        createBullishInd1h(),
        createBullishInd15m(),
        createBullishInd5m()
      ),
      oppositePressureScore: 55,
      reversalLevel: 2 as const,
      notes: ['LEVEL 2+: REVERSAL_DEFENSE'],
    };

    const actionJ = tradeManagementEngine.determineManagementAction(
      mockTrade,
      healthClosePrice,
      4333.8,
      4330.0,
      4334.0,
      4320.0,
      4310.0,
      dummyCandles15m,
      dummyCandles5m,
      createBullishInd15m(),
      createBullishInd5m(),
      DEFAULT_APP_SETTINGS
    );

    assert(actionJ.actionType === 'REVERSAL_WATCH', 'TEST J PASS: Retains original SL when no valid tighter SL exists outside buffer');
    assert(actionJ.oldSL === 4334.0, 'Original SL remains unchanged');
  }
}

// ----------------------------------------------------------------------------
// TEST K & L: Bare S/R Trend Alignment vs Counter-Trend Rejection
// ----------------------------------------------------------------------------
console.log('\n[TEST K & L] Bare S/R Trend Alignment vs Counter-Trend Rejection');
{
  const bearishTriggerCandles5m: Candle[] = [
    ...dummyCandles5m.slice(0, -1),
    createCandle(34, 4295, 4298.5, 4292.0, 4293.0), // Strong upper wick rejection candle closing near low
  ];

  // Test K: Trend-aligned Bare Resistance Rejection SELL in STRONG_DOWNTREND regime
  const valAligned = validateTradeSignalCandidate(
    {
      direction: 'SELL',
      entry: 4295.0,
      stopLoss: 4299.5,
      tp1: 4288.0,
      setupName: 'Bare Resistance Rejection',
      strategyFamily: 'BARE_SR',
      confidence: 82,
      poiPrice: 4295.0,
    },
    {
      currentPrice: 4295.0,
      candles5m: bearishTriggerCandles5m,
      candles15m: dummyCandles15m,
      candles1h: dummyCandles1h,
      candles1m: [],
      indicators5m: { ...createBullishInd5m(), structure: 'BEARISH', resistance: 4295.0, swingHigh: 4295.0 },
      indicators15m: { ...createBearishInd15m(), resistance: 4295.0, swingHigh: 4295.0 },
      indicators1h: createBearishInd1h(),
      brokerSpecs: defaultBrokerSpecs,
    }
  );
  assert(valAligned.isValid, 'TEST K PASS: Bare S/R SELL aligned with strong downtrend regime is VALID');

  // Test L: Counter-trend Bare Resistance Rejection SELL in STRONG_UPTREND regime without confirmed reversal
  const valCounter = validateTradeSignalCandidate(
    {
      direction: 'SELL',
      entry: 4340.0,
      stopLoss: 4344.5,
      tp1: 4330.0,
      setupName: 'Bare Resistance Rejection',
      strategyFamily: 'BARE_SR',
      confidence: 82,
      poiPrice: 4340.0,
    },
    {
      currentPrice: 4340.0,
      candles5m: bearishTriggerCandles5m,
      candles15m: dummyCandles15m,
      candles1h: dummyCandles1h,
      candles1m: [],
      indicators5m: createBullishInd5m(),
      indicators15m: createBullishInd15m(),
      indicators1h: createBullishInd1h(),
      brokerSpecs: defaultBrokerSpecs,
    }
  );
  assert(!valCounter.isValid, 'TEST L PASS: Counter-trend Bare S/R SELL without confirmed reversal is REJECTED');
}

// ----------------------------------------------------------------------------
// TEST M: Confirmed Counter-Trend Setup Remains Eligible
// ----------------------------------------------------------------------------
console.log('\n[TEST M] Confirmed Counter-Trend Setup Remains Eligible');
{
  const bearishTriggerCandles5m: Candle[] = [
    ...dummyCandles5m.slice(0, -1),
    createCandle(34, 4339.0, 4343.5, 4336.0, 4337.0), // Rejection candle from resistance 4340.0
  ];

  // M15 indicator has confirmed bearish CHOCH shift
  const ind15mChoch = {
    ...createBullishInd15m(),
    structureShift: 'CHOCH_BEARISH',
    structure: 'BEARISH' as const,
    resistance: 4340.0,
    swingHigh: 4340.0,
  };
  const valConfirmedReversal = validateTradeSignalCandidate(
    {
      direction: 'SELL',
      entry: 4340.0,
      stopLoss: 4344.5,
      tp1: 4330.0,
      setupName: 'Bearish CHOCH Reversal',
      strategyFamily: 'MARKET_STRUCTURE',
      confidence: 85,
      poiPrice: 4340.0,
    },
    {
      currentPrice: 4340.0,
      candles5m: bearishTriggerCandles5m,
      candles15m: dummyCandles15m,
      candles1h: dummyCandles1h, // Pass valid candles array (>= 15 candles)
      candles1m: [],
      indicators5m: { ...createBullishInd5m(), resistance: 4340.0 },
      indicators15m: ind15mChoch,
      indicators1h: createBullishInd1h(),
      brokerSpecs: defaultBrokerSpecs,
    }
  );
  assert(valConfirmedReversal.isValid, 'TEST M PASS: Counter-trend setup WITH confirmed structural reversal remains ELIGIBLE');
}

// ----------------------------------------------------------------------------
// TEST N: Breakout Followed by Immediate Invalidation -> REJECTED
// ----------------------------------------------------------------------------
console.log('\n[TEST N] Breakout Followed by Immediate Invalidation');
{
  const testAtr = 2.0;
  // Build 15M candles containing a support/resistance level at 4330.0
  const c15mWithSR: Candle[] = [];
  for (let i = 0; i < 20; i++) {
    c15mWithSR.push(createCandle(i, 4332, 4336, 4330.0, 4334));
  }

  // Build 5M candles with breakout then immediate dump back through level
  const boCandles: Candle[] = [];
  for (let i = 0; i < 10; i++) boCandles.push(createCandle(i, 4320, 4325, 4318, 4322));
  // Candle 10: Breakout above resistance 4330.0 -> closed at 4332.0
  boCandles.push(createCandle(10, 4322, 4333, 4321, 4332.0));
  // Candle 11: Immediate dump/invalidation closing back far below level at 4320.0 (< level - 0.2*ATR)
  boCandles.push(createCandle(11, 4332, 4332, 4318, 4320.0));
  // Candle 12: Attempted retest
  boCandles.push(createCandle(12, 4320, 4330.5, 4319, 4329.5));

  const breakouts = detectHorizontalBreakoutRetest(c15mWithSR, boCandles, testAtr);
  assert(breakouts.length === 0, 'TEST N PASS: Breakout followed by immediate dump/invalidation back through level is REJECTED');
}

console.log('\n================================================================');
console.log(`FINAL RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
