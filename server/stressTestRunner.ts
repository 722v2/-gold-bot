import { tradeManagementEngine } from './tradeManagementEngine.js';
import { storage, TradeOutcomeRecord } from './storage.js';
import { evaluateTradeRisk, BrokerContractSpecs } from './riskManager.js';
import { generateMultiStrategyCandidates } from './strategyEngine.js';
import { mt5Bridge } from './mt5Bridge.js';
import { analyzeTechnicals } from './indicators.js';
import { Candle, TechnicalIndicators, TradeSignal, TradeLedgerItem } from '../src/types.js';

interface ScenarioReport {
  scenarioNumber: number;
  name: string;
  passed: boolean;
  assertionsCount: number;
  failures: string[];
  details: Record<string, any>;
}

function generateSyntheticCandles(
  basePrice: number,
  trend: 'UP' | 'DOWN' | 'RANGING',
  count: number = 30
): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  const step = trend === 'UP' ? 0.5 : trend === 'DOWN' ? -0.5 : 0;
  const startPrice = basePrice - (count - 1) * step;

  for (let i = 0; i < count; i++) {
    const timestamp = now - (count - 1 - i) * 300000;
    let delta = step;
    if (trend === 'RANGING') {
      delta = i % 2 === 0 ? 0.2 : -0.2;
    }
    const price = startPrice + i * delta;
    const open = price - delta * 0.5;
    const close = price;
    const high = Math.max(open, close) + 0.4;
    const low = Math.min(open, close) - 0.4;
    candles.push({
      timestamp,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: 1500 + i * 20,
    });
  }
  return candles;
}

function generateMockIndicators(
  currentPrice: number,
  structure: 'BULLISH' | 'BEARISH' | 'RANGING'
): TechnicalIndicators {
  return {
    ema20: structure === 'BULLISH' ? currentPrice - 2.0 : currentPrice + 2.0,
    ema50: structure === 'BULLISH' ? currentPrice - 5.0 : currentPrice + 5.0,
    ema200: structure === 'BULLISH' ? currentPrice - 10.0 : currentPrice + 10.0,
    vwap: currentPrice,
    rsi14: structure === 'BULLISH' ? 58 : structure === 'BEARISH' ? 42 : 50,
    macd: {
      macd: structure === 'BULLISH' ? 1.2 : structure === 'BEARISH' ? -1.2 : 0,
      signal: 0.5,
      histogram: structure === 'BULLISH' ? 0.7 : -0.7,
    },
    atr14: 2.5,
    bollingerBands: {
      upper: currentPrice + 5.0,
      middle: currentPrice,
      lower: currentPrice - 5.0,
    },
    swingHigh: currentPrice + 10.0,
    swingLow: currentPrice - 10.0,
    support: currentPrice - 6.0,
    resistance: currentPrice + 6.0,
    structure,
    trendStructure: structure === 'BULLISH' ? 'HH_HL' : structure === 'BEARISH' ? 'LH_LL' : 'RANGING',
    chochDetected: false,
    bosDetected: true,
    liquiditySweepDetected: false,
    premiumDiscountZone: structure === 'BULLISH' ? 'DISCOUNT' : 'PREMIUM',
    marketRegime: structure === 'BULLISH' ? 'STRONG_UPTREND' : structure === 'BEARISH' ? 'STRONG_DOWNTREND' : 'NORMAL_RANGE',
    regimeContext: {
      regime: structure === 'BULLISH' ? 'STRONG_UPTREND' : structure === 'BEARISH' ? 'STRONG_DOWNTREND' : 'NORMAL_RANGE',
      trendStrength: 75,
      isOverextended: false,
      volatilityRatio: 1.0,
      rangeBoundaries: { high: currentPrice + 10, low: currentPrice - 10, equilibrium: currentPrice },
      recommendedAction: 'TREND_CONTINUATION',
      summaryDescription: 'Test regime',
    },
  };
}

export async function runEndToEndStressTest(): Promise<{
  allPassed: boolean;
  totalScenarios: number;
  passedCount: number;
  failedCount: number;
  reports: ScenarioReport[];
}> {
  const reports: ScenarioReport[] = [];
  const baseSettings = storage.getSettings();

  // Reset starting balance for simulation environment
  const runId = Date.now();

  // ==========================================================================
  // SCENARIO 1: BUY WINNING TRADE
  // ==========================================================================
  {
    const failures: string[] = [];
    let assertions = 0;

    const tradeId = `stress_buy_win_${runId}`;
    const initialSl = 4280.0;
    const entryPrice = 4284.0;
    const tp1 = 4290.0; // 1.5R (6 pts)
    const tp2 = 4296.0; // 3.0R (12 pts)

    const buyTrade: TradeLedgerItem = {
      id: tradeId,
      pl: 0,
      tradeNumber: 1,
      date: new Date().toLocaleDateString('ar-EG'),
      isoTime: new Date().toISOString(),
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: entryPrice,
      sl: initialSl,
      slPoints: 40,
      tp1,
      tp1Points: 60,
      tp2,
      tp2Points: 120,
      rr: '1:1.5 | 1:3.0',
      riskPercent: 1.5,
      riskAmount: 1.5,
      lotSize: 0.01,
      confidence: 82,
      setup: 'Bullish Trend Pullback S1',
      result: 'OPEN',
      balanceAfterTrade: 100,
      isActive: true,
      partialClosed: false,
    };

    storage.saveTrade(buyTrade);

    // Step 1: Reach TP1
    const priceAtTp1 = 4290.5;
    const c5m_tp1 = generateSyntheticCandles(priceAtTp1, 'UP', 20);
    const c15m_tp1 = generateSyntheticCandles(priceAtTp1, 'UP', 20);
    const c1h_tp1 = generateSyntheticCandles(priceAtTp1, 'UP', 20);
    const ind_tp1 = generateMockIndicators(priceAtTp1, 'BULLISH');

    const evalTp1 = await tradeManagementEngine.evaluateSingleTrade(
      buyTrade,
      priceAtTp1,
      c1h_tp1,
      c15m_tp1,
      c5m_tp1,
      [],
      ind_tp1,
      ind_tp1,
      ind_tp1,
      100,
      { ...baseSettings, partialClosePercent: 50 }
    );

    assertions++;
    if (evalTp1.action.actionType !== 'PARTIAL_CLOSE_TP1') {
      failures.push(`Expected PARTIAL_CLOSE_TP1 at $${priceAtTp1}, got ${evalTp1.action.actionType}`);
    }

    assertions++;
    if (evalTp1.action.partialClosePercent !== 50 && (evalTp1.action.partialClosePercent || 50) !== 50) {
      failures.push(`Expected 50% partial close, got ${evalTp1.action.partialClosePercent}%`);
    }

    assertions++;
    if (!evalTp1.action.newSL || evalTp1.action.newSL < entryPrice) {
      failures.push(`Expected newSL >= Entry ($${entryPrice}), got $${evalTp1.action.newSL}`);
    }

    // Step 2: Apply partial close and protect SL, verify no duplicate TP1 trigger
    buyTrade.partialClosed = true;
    buyTrade.sl = evalTp1.action.newSL || (entryPrice + 0.5);

    const evalPostTp1 = await tradeManagementEngine.evaluateSingleTrade(
      buyTrade,
      priceAtTp1 + 0.5,
      c1h_tp1,
      c15m_tp1,
      c5m_tp1,
      [],
      ind_tp1,
      ind_tp1,
      ind_tp1,
      100,
      baseSettings
    );

    assertions++;
    if (evalPostTp1.action.actionType === 'PARTIAL_CLOSE_TP1') {
      failures.push(`Duplicate PARTIAL_CLOSE_TP1 triggered on already partially closed trade`);
    }

    // Step 3: Continue toward TP2 with strong continuation (e.g. $4295) -> Expect Trailing SL or Target Extension
    const priceNearTp2 = 4295.0; // >80% to TP2
    const c5m_tp2 = generateSyntheticCandles(priceNearTp2, 'UP', 25);
    const c15m_tp2 = generateSyntheticCandles(priceNearTp2, 'UP', 25);
    const c1h_tp2 = generateSyntheticCandles(priceNearTp2, 'UP', 25);
    const ind_tp2 = { ...generateMockIndicators(priceNearTp2, 'BULLISH'), rsi14: 68 };

    const evalContinuation = await tradeManagementEngine.evaluateSingleTrade(
      buyTrade,
      priceNearTp2,
      c1h_tp2,
      c15m_tp2,
      c5m_tp2,
      [],
      ind_tp2,
      ind_tp2,
      ind_tp2,
      100,
      baseSettings
    );

    assertions++;
    const isTrailingOrExtension = evalContinuation.action.actionType === 'UPDATE_SL' || evalContinuation.action.actionType === 'UPDATE_TP2';
    if (!isTrailingOrExtension) {
      failures.push(`Expected UPDATE_SL or UPDATE_TP2 near TP2, got ${evalContinuation.action.actionType}`);
    }

    // Step 4: Verify realized P&L is only recorded upon simulated closure
    const balBefore = storage.getCurrentBalance();
    const outcomeRecord: TradeOutcomeRecord = {
      signalId: tradeId,
      tradeId,
      direction: 'BUY NOW',
      orderType: 'MARKET',
      entry: entryPrice,
      stopLoss: initialSl,
      tp1,
      tp2,
      outcome: 'WIN',
      exitPrice: tp2,
      realizedPnl: 12.00, // $12 on 0.01 lot
      source: 'MANUAL',
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
    };

    const outRes = storage.recordTradeOutcome(outcomeRecord);
    const balAfter = storage.getCurrentBalance();
    const balDiff = Number((balAfter - balBefore).toFixed(2));

    assertions++;
    if (!outRes.success || balDiff !== 12.00) {
      failures.push(`Expected balance change of +$12.00 upon closure, got diff +$${balDiff}`);
    }

    reports.push({
      scenarioNumber: 1,
      name: 'BUY WINNING TRADE (Full Lifecycle)',
      passed: failures.length === 0,
      assertionsCount: assertions,
      failures,
      details: {
        evalTp1Action: evalTp1.action.actionType,
        evalTp1Sl: evalTp1.action.newSL,
        postTp1Action: evalPostTp1.action.actionType,
        continuationAction: evalContinuation.action.actionType,
        realizedPnlCredited: balDiff,
      },
    });
  }

  // ==========================================================================
  // SCENARIO 2: SELL WINNING TRADE
  // ==========================================================================
  {
    const failures: string[] = [];
    let assertions = 0;

    const tradeId = `stress_sell_win_${runId}`;
    const initialSl = 4300.0;
    const entryPrice = 4296.0;
    const tp1 = 4290.0; // 6 pts
    const tp2 = 4284.0; // 12 pts

    const sellTrade: TradeLedgerItem = {
      id: tradeId,
      pl: 0,
      tradeNumber: 2,
      date: new Date().toLocaleDateString('ar-EG'),
      isoTime: new Date().toISOString(),
      asset: 'XAU/USD',
      direction: 'SELL NOW',
      entry: entryPrice,
      sl: initialSl,
      slPoints: 40,
      tp1,
      tp1Points: 60,
      tp2,
      tp2Points: 120,
      rr: '1:1.5 | 1:3.0',
      riskPercent: 1.5,
      riskAmount: 1.5,
      lotSize: 0.01,
      confidence: 84,
      setup: 'Bearish Trend Pullback S2',
      result: 'OPEN',
      balanceAfterTrade: 100,
      isActive: true,
      partialClosed: false,
    };

    // Step 1: Reach TP1
    const priceAtTp1 = 4289.5;
    const c5m_tp1 = generateSyntheticCandles(priceAtTp1, 'DOWN', 20);
    const c15m_tp1 = generateSyntheticCandles(priceAtTp1, 'DOWN', 20);
    const c1h_tp1 = generateSyntheticCandles(priceAtTp1, 'DOWN', 20);
    const ind_tp1 = generateMockIndicators(priceAtTp1, 'BEARISH');

    const evalTp1 = await tradeManagementEngine.evaluateSingleTrade(
      sellTrade,
      priceAtTp1,
      c1h_tp1,
      c15m_tp1,
      c5m_tp1,
      [],
      ind_tp1,
      ind_tp1,
      ind_tp1,
      100,
      baseSettings
    );

    assertions++;
    if (evalTp1.action.actionType !== 'PARTIAL_CLOSE_TP1') {
      failures.push(`Expected PARTIAL_CLOSE_TP1 for SELL at $${priceAtTp1}, got ${evalTp1.action.actionType}`);
    }

    assertions++;
    if (!evalTp1.action.newSL || evalTp1.action.newSL > entryPrice) {
      failures.push(`Expected newSL <= Entry ($${entryPrice}) for SELL, got $${evalTp1.action.newSL}`);
    }

    // Step 2: Test anti-widening on SELL
    const mockWidenAction = {
      actionType: 'UPDATE_SL' as const,
      tradeId: sellTrade.id,
      direction: 'SELL' as const,
      currentPrice: 4289.5,
      entryPrice: sellTrade.entry,
      oldSL: sellTrade.sl,
      newSL: 4305.0, // Widened SL above initial 4300.0
      oldTP1: tp1,
      oldTP2: tp2,
      floatingPnl: 6.5,
      currentR: 1.6,
      managementState: 'TRAIL_STOP' as const,
      reason: 'Testing widening',
      confidence: 80,
      timestamp: Date.now(),
      source: 'DETERMINISTIC' as const,
      requiresConfirmation: false,
    };
    const safetyCheck = tradeManagementEngine.validateManagementActionSafety(
      mockWidenAction,
      sellTrade,
      100,
      baseSettings
    );

    assertions++;
    if (safetyCheck.valid) {
      failures.push(`Safety engine failed to block SELL SL widening from 4300 to 4305`);
    }

    reports.push({
      scenarioNumber: 2,
      name: 'SELL WINNING TRADE (Lifecycle & Protection)',
      passed: failures.length === 0,
      assertionsCount: assertions,
      failures,
      details: {
        evalTp1Action: evalTp1.action.actionType,
        protectedSl: evalTp1.action.newSL,
        wideningBlocked: !safetyCheck.valid,
      },
    });
  }

  // ==========================================================================
  // SCENARIO 3: BUY FAILURE → REVERSAL (3-Tier Model)
  // ==========================================================================
  {
    const failures: string[] = [];
    let assertions = 0;

    const tradeId = `stress_buy_rev_${runId}`;
    const initialSl = 4280.0;
    const entryPrice = 4284.0;
    const tp1 = 4290.0;
    const tp2 = 4296.0;

    const buyTrade: TradeLedgerItem = {
      id: tradeId,
      pl: 0,
      tradeNumber: 3,
      date: new Date().toLocaleDateString('ar-EG'),
      isoTime: new Date().toISOString(),
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: entryPrice,
      sl: initialSl,
      slPoints: 40,
      tp1,
      tp1Points: 60,
      tp2,
      tp2Points: 120,
      rr: '1:1.5 | 1:3.0',
      riskPercent: 1.5,
      riskAmount: 1.5,
      lotSize: 0.01,
      confidence: 80,
      setup: 'Bullish Trend S1',
      result: 'OPEN',
      balanceAfterTrade: 100,
      isActive: true,
      partialClosed: false,
    };

    // Stage 1: Minor adverse pullback ($4283.0) with bullish structure -> HOLD
    const price1 = 4283.0;
    const c5m_1 = generateSyntheticCandles(price1, 'RANGING', 20);
    const ind_bullish = generateMockIndicators(price1, 'BULLISH');

    const evalStage1 = await tradeManagementEngine.evaluateSingleTrade(
      buyTrade,
      price1,
      c5m_1,
      c5m_1,
      c5m_1,
      [],
      ind_bullish,
      ind_bullish,
      ind_bullish,
      100,
      baseSettings
    );

    assertions++;
    if (evalStage1.action.actionType !== 'HOLD') {
      failures.push(`Expected HOLD during minor pullback, got ${evalStage1.action.actionType}`);
    }

    // Stage 2: Intermediate counter-pressure (15M flips BEARISH, 5M RSI drops to 38) -> REVERSAL_WATCH
    const price2 = 4282.2;
    const c5m_2 = generateSyntheticCandles(price2, 'DOWN', 20);
    const ind15m_bearish = generateMockIndicators(price2, 'BEARISH');
    const ind5m_pressure = { ...generateMockIndicators(price2, 'BEARISH'), rsi14: 38 };

    const evalStage2 = await tradeManagementEngine.evaluateSingleTrade(
      buyTrade,
      price2,
      c5m_2,
      c5m_2,
      c5m_2,
      [],
      ind_bullish,
      ind15m_bearish,
      ind5m_pressure,
      100,
      baseSettings
    );

    assertions++;
    if (evalStage2.action.actionType !== 'REVERSAL_WATCH') {
      failures.push(`Expected REVERSAL_WATCH on structural counter-pressure, got ${evalStage2.action.actionType}`);
    }

    // Stage 3: Confirmed High-Conviction Reversal (1H + 15M + 5M all BEARISH, RSI < 35, MACD bearish) -> EARLY_EXIT
    const price3 = 4281.5;
    const c5m_3 = generateSyntheticCandles(price3, 'DOWN', 25);
    const ind1h_bearish = generateMockIndicators(price3, 'BEARISH');
    const ind5m_strong_bear = {
      ...generateMockIndicators(price3, 'BEARISH'),
      rsi14: 32,
      macd: { macd: -1.5, signal: -0.5, histogram: -1.0 },
    };

    const evalStage3 = await tradeManagementEngine.evaluateSingleTrade(
      buyTrade,
      price3,
      c5m_3,
      c5m_3,
      c5m_3,
      [],
      ind1h_bearish,
      ind15m_bearish,
      ind5m_strong_bear,
      100,
      baseSettings
    );

    assertions++;
    if (evalStage3.action.actionType !== 'EARLY_EXIT') {
      failures.push(`Expected EARLY_EXIT on confirmed multi-timeframe reversal, got ${evalStage3.action.actionType}`);
    }

    assertions++;
    if (!evalStage3.action.oppositeSetupCandidate || evalStage3.action.oppositeSetupCandidate.direction !== 'SELL') {
      failures.push(`Expected opposite SELL candidate on confirmed reversal`);
    }

    reports.push({
      scenarioNumber: 3,
      name: 'BUY FAILURE → REVERSAL (3-Tier Engine)',
      passed: failures.length === 0,
      assertionsCount: assertions,
      failures,
      details: {
        stage1: evalStage1.action.actionType,
        stage2: evalStage2.action.actionType,
        stage3: evalStage3.action.actionType,
        candidateDirection: evalStage3.action.oppositeSetupCandidate?.direction,
        candidateConfidence: evalStage3.action.oppositeSetupCandidate?.confidence,
      },
    });
  }

  // ==========================================================================
  // SCENARIO 4: SELL FAILURE → REVERSAL (Symmetrical)
  // ==========================================================================
  {
    const failures: string[] = [];
    let assertions = 0;

    const tradeId = `stress_sell_rev_${runId}`;
    const initialSl = 4300.0;
    const entryPrice = 4296.0;
    const tp1 = 4290.0;
    const tp2 = 4284.0;

    const sellTrade: TradeLedgerItem = {
      id: tradeId,
      pl: 0,
      tradeNumber: 4,
      date: new Date().toLocaleDateString('ar-EG'),
      isoTime: new Date().toISOString(),
      asset: 'XAU/USD',
      direction: 'SELL NOW',
      entry: entryPrice,
      sl: initialSl,
      slPoints: 40,
      tp1,
      tp1Points: 60,
      tp2,
      tp2Points: 120,
      rr: '1:1.5 | 1:3.0',
      riskPercent: 1.5,
      riskAmount: 1.5,
      lotSize: 0.01,
      confidence: 82,
      setup: 'Bearish Trend S2',
      result: 'OPEN',
      balanceAfterTrade: 100,
      isActive: true,
      partialClosed: false,
    };

    // Confirmed Bullish Reversal against SELL
    const revPrice = 4298.5;
    const c5m_rev = generateSyntheticCandles(revPrice, 'UP', 25);
    const ind1h_bull = generateMockIndicators(revPrice, 'BULLISH');
    const ind15m_bull = generateMockIndicators(revPrice, 'BULLISH');
    const ind5m_bull = {
      ...generateMockIndicators(revPrice, 'BULLISH'),
      rsi14: 68,
      macd: { macd: 1.8, signal: 0.6, histogram: 1.2 },
    };

    const evalRev = await tradeManagementEngine.evaluateSingleTrade(
      sellTrade,
      revPrice,
      c5m_rev,
      c5m_rev,
      c5m_rev,
      [],
      ind1h_bull,
      ind15m_bull,
      ind5m_bull,
      100,
      baseSettings
    );

    assertions++;
    if (evalRev.action.actionType !== 'EARLY_EXIT') {
      failures.push(`Expected EARLY_EXIT for SELL reversal, got ${evalRev.action.actionType}`);
    }

    assertions++;
    if (!evalRev.action.oppositeSetupCandidate || evalRev.action.oppositeSetupCandidate.direction !== 'BUY') {
      failures.push(`Expected opposite BUY candidate on SELL reversal`);
    }

    reports.push({
      scenarioNumber: 4,
      name: 'SELL FAILURE → REVERSAL (Symmetrical Lifecycle)',
      passed: failures.length === 0,
      assertionsCount: assertions,
      failures,
      details: {
        action: evalRev.action.actionType,
        reversalLevel: evalRev.health.reversalLevel,
        candidateDirection: evalRev.action.oppositeSetupCandidate?.direction,
      },
    });
  }

  // ==========================================================================
  // SCENARIO 5: NORMAL ADVERSE MOVE (No Premature Exit)
  // ==========================================================================
  {
    const failures: string[] = [];
    let assertions = 0;

    const tradeId = `stress_normal_pullback_${runId}`;
    const buyTrade: TradeLedgerItem = {
      id: tradeId,
      pl: 0,
      tradeNumber: 5,
      date: new Date().toLocaleDateString('ar-EG'),
      isoTime: new Date().toISOString(),
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4284.0,
      sl: 4280.0,
      slPoints: 40,
      tp1: 4290.0,
      tp1Points: 60,
      tp2: 4296.0,
      tp2Points: 120,
      rr: '1:1.5 | 1:3.0',
      riskPercent: 1.5,
      riskAmount: 1.5,
      lotSize: 0.01,
      confidence: 80,
      setup: 'Bullish Trend S1',
      result: 'OPEN',
      balanceAfterTrade: 100,
      isActive: true,
      partialClosed: false,
    };

    // Normal pullback in ongoing uptrend (1H bullish, 15M bullish, 5M RSI 48)
    const pullbackPrice = 4282.5;
    const c5m = generateSyntheticCandles(pullbackPrice, 'UP', 20);
    const indBull = generateMockIndicators(pullbackPrice, 'BULLISH');
    const ind5m = { ...indBull, rsi14: 48 };

    const evalRes = await tradeManagementEngine.evaluateSingleTrade(
      buyTrade,
      pullbackPrice,
      c5m,
      c5m,
      c5m,
      [],
      indBull,
      indBull,
      ind5m,
      100,
      baseSettings
    );

    assertions++;
    if (evalRes.action.actionType !== 'HOLD') {
      failures.push(`Expected HOLD during normal pullback, got ${evalRes.action.actionType}`);
    }

    assertions++;
    if (evalRes.health.reversalLevel !== 0) {
      failures.push(`Expected reversalLevel 0 during normal pullback, got ${evalRes.health.reversalLevel}`);
    }

    reports.push({
      scenarioNumber: 5,
      name: 'NORMAL ADVERSE MOVE (Noise Tolerance & HOLD)',
      passed: failures.length === 0,
      assertionsCount: assertions,
      failures,
      details: {
        action: evalRes.action.actionType,
        reversalLevel: evalRes.health.reversalLevel,
      },
    });
  }

  // ==========================================================================
  // SCENARIO 6: STOP-LOSS SAFETY & ANTI-WIDENING
  // ==========================================================================
  {
    const failures: string[] = [];
    let assertions = 0;

    const buyTrade: TradeLedgerItem = {
      id: `safety_buy_${runId}`,
      pl: 0,
      tradeNumber: 6,
      date: new Date().toLocaleDateString('ar-EG'),
      isoTime: new Date().toISOString(),
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4284.0,
      sl: 4280.0,
      slPoints: 40,
      tp1: 4290.0,
      tp1Points: 60,
      tp2: 4296.0,
      tp2Points: 120,
      rr: '1:1.5 | 1:3.0',
      riskPercent: 1.5,
      riskAmount: 1.5,
      lotSize: 0.01,
      confidence: 80,
      setup: 'Bullish Trend S1',
      result: 'OPEN',
      balanceAfterTrade: 100,
      isActive: true,
      partialClosed: false,
    };

    // 1. Attempt to widen BUY SL (from 4280 down to 4275) -> MUST FAIL
    const actionWiden = {
      actionType: 'UPDATE_SL' as const,
      tradeId: buyTrade.id,
      direction: 'BUY' as const,
      currentPrice: 4288.0,
      entryPrice: buyTrade.entry,
      oldSL: buyTrade.sl,
      newSL: 4275.0,
      oldTP1: 4290.0,
      oldTP2: 4296.0,
      floatingPnl: 4.0,
      currentR: 1.0,
      managementState: 'TRAIL_STOP' as const,
      reason: 'Testing widening',
      confidence: 80,
      timestamp: Date.now(),
      source: 'DETERMINISTIC' as const,
      requiresConfirmation: false,
    };
    const buyWidening = tradeManagementEngine.validateManagementActionSafety(actionWiden, buyTrade, 100, baseSettings);
    assertions++;
    if (buyWidening.valid) {
      failures.push('Safety engine allowed BUY SL widening from 4280 to 4275');
    }

    // 2. Attempt to move BUY SL above current price -> MUST FAIL
    const actionAbovePrice = {
      actionType: 'UPDATE_SL' as const,
      tradeId: buyTrade.id,
      direction: 'BUY' as const,
      currentPrice: 4288.0,
      entryPrice: buyTrade.entry,
      oldSL: buyTrade.sl,
      newSL: 4292.0,
      oldTP1: 4290.0,
      oldTP2: 4296.0,
      floatingPnl: 4.0,
      currentR: 1.0,
      managementState: 'TRAIL_STOP' as const,
      reason: 'Testing above price',
      confidence: 80,
      timestamp: Date.now(),
      source: 'DETERMINISTIC' as const,
      requiresConfirmation: false,
    };
    const buyAbovePrice = tradeManagementEngine.validateManagementActionSafety(actionAbovePrice, buyTrade, 100, baseSettings);
    assertions++;
    if (buyAbovePrice.valid) {
      failures.push('Safety engine allowed BUY SL placement above current price');
    }

    // 3. Valid trailing BUY SL (from 4280 up to 4285 below current price 4288) -> MUST PASS
    const actionValidTrail = {
      actionType: 'UPDATE_SL' as const,
      tradeId: buyTrade.id,
      direction: 'BUY' as const,
      currentPrice: 4288.0,
      entryPrice: buyTrade.entry,
      oldSL: buyTrade.sl,
      newSL: 4285.0,
      oldTP1: 4290.0,
      oldTP2: 4296.0,
      floatingPnl: 4.0,
      currentR: 1.0,
      managementState: 'TRAIL_STOP' as const,
      reason: 'Valid trail',
      confidence: 80,
      timestamp: Date.now(),
      source: 'DETERMINISTIC' as const,
      requiresConfirmation: false,
    };
    const validBuyTrail = tradeManagementEngine.validateManagementActionSafety(actionValidTrail, buyTrade, 100, baseSettings);
    assertions++;
    if (!validBuyTrail.valid) {
      failures.push(`Valid BUY trailing SL was rejected: ${validBuyTrail.reason}`);
    }

    reports.push({
      scenarioNumber: 6,
      name: 'STOP-LOSS SAFETY & ANTI-WIDENING VALIDATION',
      passed: failures.length === 0,
      assertionsCount: assertions,
      failures,
      details: {
        buyWideningBlocked: !buyWidening.valid,
        buyAbovePriceBlocked: !buyAbovePrice.valid,
        validBuyTrailPassed: validBuyTrail.valid,
      },
    });
  }

  // ==========================================================================
  // SCENARIO 7: DUPLICATION & IDEMPOTENCY
  // ==========================================================================
  {
    const failures: string[] = [];
    let assertions = 0;

    const tradeId = `idempotency_${runId}`;
    const testTrade: TradeLedgerItem = {
      id: tradeId,
      pl: 0,
      tradeNumber: 7,
      date: new Date().toLocaleDateString('ar-EG'),
      isoTime: new Date().toISOString(),
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4284.0,
      sl: 4280.0,
      slPoints: 40,
      tp1: 4290.0,
      tp1Points: 60,
      tp2: 4296.0,
      tp2Points: 120,
      rr: '1:1.5 | 1:3.0',
      riskPercent: 1.5,
      riskAmount: 1.5,
      lotSize: 0.01,
      confidence: 80,
      setup: 'Bullish Trend S1',
      result: 'OPEN',
      balanceAfterTrade: 100,
      isActive: true,
      partialClosed: false,
    };

    const c5m = generateSyntheticCandles(4290.5, 'UP', 20);
    const ind = generateMockIndicators(4290.5, 'BULLISH');

    // First evaluation: not duplicate
    const eval1 = await tradeManagementEngine.evaluateSingleTrade(
      testTrade,
      4290.5,
      c5m,
      c5m,
      c5m,
      [],
      ind,
      ind,
      ind,
      100,
      baseSettings
    );

    const dup1 = eval1.isDuplicateNotification;
    // Apply management decision to cache notification, but keep partialClosed = false to test duplicate action generation
    await tradeManagementEngine.applyManagementDecision(eval1, { ...testTrade }, baseSettings);

    // Second evaluation with identical trade state: MUST be duplicate
    const eval2 = await tradeManagementEngine.evaluateSingleTrade(
      testTrade,
      4290.5,
      c5m,
      c5m,
      c5m,
      [],
      ind,
      ind,
      ind,
      100,
      baseSettings
    );

    const dup2 = eval2.isDuplicateNotification;

    assertions++;
    if (dup1 !== false) {
      failures.push('First evaluation incorrectly marked as duplicate');
    }

    assertions++;
    if (dup2 !== true) {
      failures.push('Second identical evaluation failed to be detected as duplicate');
    }

    reports.push({
      scenarioNumber: 7,
      name: 'DUPLICATION & IDEMPOTENCY SUPPRESSION',
      passed: failures.length === 0,
      assertionsCount: assertions,
      failures,
      details: {
        firstEvalDuplicate: dup1,
        secondEvalDuplicate: dup2,
      },
    });
  }

  // ==========================================================================
  // SCENARIO 8: REALIZED P&L AUTHORITATIVENESS
  // ==========================================================================
  {
    const failures: string[] = [];
    let assertions = 0;

    const uniqueId = `pnl_test_${runId}_${Math.random().toString(36).substring(2, 6)}`;
    const balBefore = storage.getCurrentBalance();

    storage.saveTrade({
      id: uniqueId,
      tradeNumber: 8888,
      date: new Date().toLocaleDateString('ar-EG'),
      isoTime: new Date().toISOString(),
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: 4284.0,
      sl: 4280.0,
      tp1: 4290.0,
      tp2: 4296.0,
      rr: '1:1.5',
      riskPercent: 1.5,
      riskAmount: 4.0,
      lotSize: 0.01,
      confidence: 80,
      setup: 'Test S8 Setup',
      result: 'OPEN',
      balanceAfterTrade: balBefore,
      isActive: true,
      pl: 0,
    });

    const recordLoss: TradeOutcomeRecord = {
      signalId: uniqueId,
      tradeId: uniqueId,
      direction: 'BUY NOW',
      orderType: 'MARKET',
      entry: 4284.0,
      stopLoss: 4280.0,
      tp1: 4290.0,
      tp2: 4296.0,
      outcome: 'LOSS',
      exitPrice: 4280.0,
      realizedPnl: -4.00,
      source: 'MANUAL',
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
    };

    // First submission
    const res1 = storage.recordTradeOutcome(recordLoss);
    const balAfter1 = storage.getCurrentBalance();
    const diff1 = Number((balAfter1 - balBefore).toFixed(2));

    assertions++;
    if (!res1.success || diff1 !== -4.00) {
      failures.push(`Expected LOSS to reduce balance by -$4.00, got diff $${diff1}`);
    }

    // Duplicate submission of same record: MUST return isDuplicate without changing balance
    const res2 = storage.recordTradeOutcome(recordLoss);
    const balAfter2 = storage.getCurrentBalance();
    const diff2 = Number((balAfter2 - balAfter1).toFixed(2));

    assertions++;
    if (!res2.isDuplicate) {
      failures.push('Duplicate outcome submission was not flagged as isDuplicate');
    }

    assertions++;
    if (diff2 !== 0.00) {
      failures.push(`Duplicate submission altered balance by $${diff2}`);
    }

    reports.push({
      scenarioNumber: 8,
      name: 'REALIZED P&L & IDEMPOTENT ACCOUNTING',
      passed: failures.length === 0,
      assertionsCount: assertions,
      failures,
      details: {
        initialBalanceDiff: diff1,
        duplicateBalanceDiff: diff2,
        isDuplicateFlag: res2.isDuplicate,
      },
    });
  }

  // ==========================================================================
  // SCENARIO 9: AUTO-TRADING SAFETY & EXECUTION ADAPTER GUARDS
  // ==========================================================================
  {
    const failures: string[] = [];
    let assertions = 0;

    const settings = storage.getSettings();

    // 1. Confirm Auto Trading is disabled by default
    assertions++;
    if (settings.autoTradingEnabled !== false) {
      failures.push('Auto trading setting is not false');
    }

    // 2. Attempt direct MT5 bridge execution when disconnected or in DEMO mode without authorization
    const bridgeStatus = await mt5Bridge.getAccountStatus();
    assertions++;
    if (bridgeStatus.connected) {
      // In sandbox/preview, bridge should be DISCONNECTED
      failures.push('MT5 bridge unexpectedly reported CONNECTED in test sandbox');
    }

    // 3. Test Phase 4 execution adapter step generation (preparation only)
    const mockAction = {
      actionType: 'EARLY_EXIT' as const,
      tradeId: 'test_trade_adapter',
      direction: 'BUY' as const,
      currentPrice: 4281.0,
      entryPrice: 4284.0,
      oldSL: 4280.0,
      oldTP1: 4290.0,
      oldTP2: 4296.0,
      floatingPnl: -3.0,
      currentR: -0.75,
      managementState: 'EARLY_EXIT' as const,
      reason: 'Confirmed reversal',
      confidence: 85,
      timestamp: Date.now(),
      source: 'DETERMINISTIC' as const,
      requiresConfirmation: true,
      reversalCandidate: {
        direction: 'SELL' as const,
        entry: 4281.0,
        stopLoss: 4285.0,
        tp1: 4275.0,
        tp2: 4269.0,
        confidence: 85,
        setupName: 'Bearish Reversal Setup',
      },
    };

    const adapterPlan = tradeManagementEngine.prepareFutureAutoTradeExecution(mockAction, baseSettings);
    assertions++;
    if (adapterPlan.autoTradingEnabled !== false) {
      failures.push('Adapter plan incorrectly marked autoTradingEnabled as true');
    }

    assertions++;
    if (adapterPlan.executable !== false) {
      failures.push('Adapter plan incorrectly allowed automated execution');
    }

    reports.push({
      scenarioNumber: 9,
      name: 'AUTO-TRADING SAFETY & EXECUTION ADAPTER GUARDS',
      passed: failures.length === 0,
      assertionsCount: assertions,
      failures,
      details: {
        autoTradingEnabled: settings.autoTradingEnabled,
        bridgeStatus: bridgeStatus.status,
        adapterExecutable: adapterPlan.executable,
        adapterStepsCount: adapterPlan.steps.length,
      },
    });
  }

  // ==========================================================================
  // SCENARIO 10: FULL INTEGRATED PIPELINE (End-to-End)
  // ==========================================================================
  {
    const failures: string[] = [];
    let assertions = 0;

    const currentPrice = 4285.0;
    const c5m = generateSyntheticCandles(currentPrice, 'UP', 30);
    const c15m = generateSyntheticCandles(currentPrice, 'UP', 30);
    const c1h = generateSyntheticCandles(currentPrice, 'UP', 30);
    const ind1h = generateMockIndicators(currentPrice, 'BULLISH');
    const ind15m = generateMockIndicators(currentPrice, 'BULLISH');
    const ind5m = generateMockIndicators(currentPrice, 'BULLISH');

    // 1. Strategy Generation (S1-S9)
    const candidatesResult = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 100,
      currentPrice,
      candles1h: c1h,
      candles15m: c15m,
      candles5m: c5m,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
    });

    assertions++;
    if (!Array.isArray(candidatesResult.allCandidates)) {
      failures.push('Strategy engine did not return candidates array');
    }

    // 2. Risk Evaluation
    const riskEval = evaluateTradeRisk({
      balance: 100,
      entry: currentPrice,
      stopLoss: currentPrice - 4.0,
      tp1: currentPrice + 6.0,
      tp2: currentPrice + 12.0,
      confidence: 82,
      asset: 'XAU/USD',
      brokerSpecs: {
        accountBalance: 100,
        riskPercent: 1.5,
        contractSizeOz: 100,
        minimumLot: 0.01,
        maximumLot: 100,
        lotStep: 0.01,
        maxGoldSlPoints: 50,
        minRr: 1.5,
      },
    });

    assertions++;
    if (!riskEval.valid) {
      failures.push(`Risk evaluation failed on standard 40pt SL setup: ${riskEval.reason}`);
    }

    // 3. Trade Monitor and Phase 4 evaluation pipeline
    const simulatedTrade: TradeLedgerItem = {
      id: `e2e_trade_${runId}`,
      pl: 0,
      tradeNumber: 10,
      date: new Date().toLocaleDateString('ar-EG'),
      isoTime: new Date().toISOString(),
      asset: 'XAU/USD',
      direction: 'BUY NOW',
      entry: currentPrice,
      sl: currentPrice - 4.0,
      slPoints: 40,
      tp1: currentPrice + 6.0,
      tp1Points: 60,
      tp2: currentPrice + 12.0,
      tp2Points: 120,
      rr: '1:1.5 | 1:3.0',
      riskPercent: 1.5,
      riskAmount: 1.5,
      lotSize: 0.01,
      confidence: 82,
      setup: 'Bullish Trend S1',
      result: 'OPEN',
      balanceAfterTrade: 100,
      isActive: true,
      partialClosed: false,
    };

    const evalE2E = await tradeManagementEngine.evaluateSingleTrade(
      simulatedTrade,
      currentPrice + 1.0,
      c1h,
      c15m,
      c5m,
      [],
      ind1h,
      ind15m,
      ind5m,
      100,
      baseSettings
    );

    assertions++;
    if (evalE2E.action.actionType !== 'HOLD') {
      failures.push(`Expected initial HOLD on small profit, got ${evalE2E.action.actionType}`);
    }

    reports.push({
      scenarioNumber: 10,
      name: 'FULL INTEGRATED PIPELINE (Data -> Strategy -> Risk -> Monitor -> Management)',
      passed: failures.length === 0,
      assertionsCount: assertions,
      failures,
      details: {
        candidatesCount: candidatesResult.allCandidates.length,
        riskValid: riskEval.valid,
        initialMonitorAction: evalE2E.action.actionType,
      },
    });
  }

  const passedCount = reports.filter((r) => r.passed).length;
  const failedCount = reports.filter((r) => !r.passed).length;

  return {
    allPassed: failedCount === 0,
    totalScenarios: reports.length,
    passedCount,
    failedCount,
    reports,
  };
}

async function main() {
  console.log('Starting Gold AI Trading System Full End-to-End Stress Test...');
  const result = await runEndToEndStressTest();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('Fatal stress test runner error:', err);
  process.exit(1);
});
