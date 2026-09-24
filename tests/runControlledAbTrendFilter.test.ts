import test from 'node:test';
import assert from 'node:assert';
import { fetchHistoricalBacktestDataset } from '../server/marketData.js';
import { analyzeTechnicals } from '../server/indicators.js';
import { generateMultiStrategyCandidates } from '../server/strategyEngine.js';
import { globalPoiTracker } from '../server/tradeQualityEngine.js';
import { storage } from '../server/storage.js';
import { Candle } from '../src/types.js';

function calculateWilsonCI(wins: number, total: number): { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 0 };
  const p = wins / total;
  const z = 1.96;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const adjustedStdDev = Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  
  const lower = Math.max(0, (centre - z * adjustedStdDev) / denominator);
  const upper = Math.min(1, (centre + z * adjustedStdDev) / denominator);
  
  return {
    lower: Number((lower * 100).toFixed(1)),
    upper: Number((upper * 100).toFixed(1)),
  };
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export interface CandidateOutcome {
  outcome: 'TP1' | 'TP2' | 'SL' | 'TIMEOUT' | 'AMBIGUOUS';
  realizedR: number;
  mfePts: number;
  mfeR: number;
  maePts: number;
  maeR: number;
  barsToOutcome: number;
  barsToMfe: number;
  barsToSl: number;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2?: number;
  plannedRr: number;
  slDist: number;
  tp1Dist: number;
}

function simulateForwardOutcome(
  candles5mAll: Candle[],
  startIndex: number,
  direction: 'BUY' | 'SELL',
  entryPrice: number,
  stopLoss: number,
  tp1: number,
  tp2?: number,
  tp1Rr?: number,
  tp2Rr?: number
): CandidateOutcome {
  const slDist = Math.abs(entryPrice - stopLoss);
  const tp1Dist = Math.abs(tp1 - entryPrice);
  const plannedRr = tp1Rr || (slDist > 0 ? tp1Dist / slDist : 1.5);

  let outcome: 'TP1' | 'TP2' | 'SL' | 'TIMEOUT' | 'AMBIGUOUS' = 'TIMEOUT';
  let maxMfe = 0;
  let maxMae = 0;
  let barsToMfe = 0;
  let barsToSl = 0;
  let barsToOutcome = 0;
  let exitPrice = entryPrice;

  const maxSimBars = Math.min(288, candles5mAll.length - 1 - startIndex);

  for (let j = 1; j <= maxSimBars; j++) {
    const futureCandle = candles5mAll[startIndex + j];
    if (!futureCandle) break;

    let highExcursion = 0;
    let lowExcursion = 0;

    if (direction === 'BUY') {
      highExcursion = futureCandle.high - entryPrice;
      lowExcursion = entryPrice - futureCandle.low;
    } else {
      highExcursion = entryPrice - futureCandle.low;
      lowExcursion = futureCandle.high - entryPrice;
    }

    if (highExcursion > maxMfe) {
      maxMfe = highExcursion;
      barsToMfe = j;
    }
    if (lowExcursion > maxMae) {
      maxMae = lowExcursion;
    }

    let hitSl = false;
    let hitTp1 = false;

    if (direction === 'BUY') {
      if (futureCandle.low <= stopLoss) hitSl = true;
      if (futureCandle.high >= tp1) hitTp1 = true;
    } else {
      if (futureCandle.high >= stopLoss) hitSl = true;
      if (futureCandle.low <= tp1) hitTp1 = true;
    }

    if (hitSl && hitTp1) {
      const openToSl = Math.abs(futureCandle.open - stopLoss);
      const openToTp1 = Math.abs(futureCandle.open - tp1);
      if (openToSl < openToTp1) {
        outcome = 'SL';
        exitPrice = stopLoss;
      } else if (openToTp1 < openToSl) {
        outcome = 'TP1';
        exitPrice = tp1;
      } else {
        outcome = 'AMBIGUOUS';
        exitPrice = stopLoss;
      }
      barsToOutcome = j;
      barsToSl = j;
      break;
    } else if (hitSl) {
      outcome = 'SL';
      exitPrice = stopLoss;
      barsToOutcome = j;
      barsToSl = j;
      break;
    } else if (hitTp1) {
      outcome = 'TP1';
      exitPrice = tp1;
      barsToOutcome = j;

      let hitTp2 = false;
      if (tp2) {
        for (let k = j + 1; k <= maxSimBars; k++) {
          const cK = candles5mAll[startIndex + k];
          if (!cK) break;
          if (direction === 'BUY') {
            if (cK.low <= stopLoss) break;
            if (cK.high >= tp2) { hitTp2 = true; break; }
          } else {
            if (cK.high >= stopLoss) break;
            if (cK.low <= tp2) { hitTp2 = true; break; }
          }
        }
      }
      if (hitTp2) outcome = 'TP2';
      break;
    }
  }

  if (outcome === 'TIMEOUT') {
    barsToOutcome = maxSimBars;
    exitPrice = candles5mAll[startIndex + maxSimBars]?.close || entryPrice;
  }

  let realizedR = 0;
  if (outcome === 'TP1') realizedR = plannedRr;
  else if (outcome === 'TP2') realizedR = tp2Rr || (plannedRr * 1.5);
  else if (outcome === 'SL' || outcome === 'AMBIGUOUS') realizedR = -1.0;
  else if (outcome === 'TIMEOUT') {
    const pnlPts = direction === 'BUY' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
    realizedR = Number((pnlPts / slDist).toFixed(2));
  }

  return {
    outcome,
    realizedR,
    mfePts: Number((maxMfe * 10).toFixed(1)),
    mfeR: slDist > 0 ? Number((maxMfe / slDist).toFixed(2)) : 0,
    maePts: Number((maxMae * 10).toFixed(1)),
    maeR: slDist > 0 ? Number((maxMae / slDist).toFixed(2)) : 0,
    barsToOutcome,
    barsToMfe,
    barsToSl,
    entryPrice,
    stopLoss,
    tp1,
    tp2,
    plannedRr: Number(plannedRr.toFixed(2)),
    slDist: Number(slDist.toFixed(2)),
    tp1Dist: Number(tp1Dist.toFixed(2)),
  };
}

export interface DispatchedRecord {
  timestamp: number;
  dateStr: string;
  strategyId: string;
  strategyFamily: string;
  setupName: string;
  direction: 'BUY' | 'SELL';
  confidence: number;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2?: number;
  plannedRr: number;
  slDist: number;
  tp1Dist: number;
  ema15m: number;
  ema1h: number;
  last15mClose: number;
  last1hClose: number;
  is15mAligned: boolean;
  is1hAligned: boolean;
  isDualAligned: boolean;
  isAnyAligned: boolean;
  outcome: CandidateOutcome;
}

test('Run Controlled A/B Trend Filter Forensic Counterfactual', async () => {
  console.log('====================================================');
  console.log('STARTING CONTROLLED A/B TREND FILTER EXPERIMENTS');
  console.log('Dataset: XAUUSD (2026-07-16 through 2026-09-24)');
  console.log('====================================================\n');

  // Verify storage isolation: mock savePoi and inspect trade length
  storage.savePoi = () => {};
  const activeTradesBefore = storage.getTrades().length;
  const outcomesBefore = storage.getTradeOutcomes().length;
  globalPoiTracker.setPois([]);

  const startTime = new Date('2026-07-16T00:00:00.000Z').getTime();
  const endTime = new Date('2026-09-24T23:59:59.999Z').getTime();

  console.log('[Dataset] Reconstructing historical candle dataset...');
  const dataset = await fetchHistoricalBacktestDataset({
    symbol: 'XAUUSD',
    timeRange: '90D',
    requestedStartTime: startTime,
    requestedEndTime: endTime,
  });

  const candles5mAll = dataset.candles5m;
  const candles15mAll = dataset.candles15m;
  const candles1hAll = dataset.candles1h;

  let startIndex = candles5mAll.findIndex((c) => c.timestamp >= startTime);
  if (startIndex < 35) startIndex = 35;

  const signals: DispatchedRecord[] = [];

  for (let i = startIndex; i < candles5mAll.length - 1; i++) {
    const current5m = candles5mAll[i];
    if (current5m.timestamp > endTime) break;

    const evalTimestamp = current5m.timestamp + 300000;
    const history5m = candles5mAll.slice(0, i + 1);
    const history15m = candles15mAll.filter((c) => c.timestamp + 900000 <= evalTimestamp);
    const history1h = candles1hAll.filter((c) => c.timestamp + 3600000 <= evalTimestamp);

    if (history15m.length < 20 || history1h.length < 15) continue;

    const ind5m = analyzeTechnicals(history5m);
    const ind15m = analyzeTechnicals(history15m);
    const ind1h = analyzeTechnicals(history1h);

    const engineInput = {
      asset: 'XAU/USD' as const,
      balance: 10000,
      currentPrice: current5m.close,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h: history1h,
      candles15m: history15m,
      candles5m: history5m,
      brokerSpecs: {
        minRr: 1.5,
        minGoldSlPoints: 35,
        maxGoldSlPoints: 85,
      },
    };

    const genResult = generateMultiStrategyCandidates(engineInput);
    if (!genResult.hasValidSignal || !genResult.selectedCandidate) continue;

    const cand = genResult.selectedCandidate;
    const strategyId = cand.patternMetadata?.strategyId || (
      cand.strategyFamily === 'ORDER_BLOCK' ? 'S1' :
      cand.strategyFamily === 'FVG_REVERSAL' || cand.strategyFamily === 'FVG_IMBALANCE' ? 'S2' :
      cand.strategyFamily === 'LIQUIDITY_SWEEP' ? 'S3' :
      cand.strategyFamily === 'MARKET_STRUCTURE' || cand.strategyFamily === 'MARKET_STRUCTURE_SHIFT' ? 'S4' :
      cand.strategyFamily === 'RANGE_BREAKOUT' || cand.strategyFamily === 'RANGE_BREAKOUT_EXPANSION' ? 'S6' :
      cand.strategyFamily === 'RANGE_SFP_REVERSAL' ? 'S7' :
      cand.strategyFamily === 'COUNTERTREND_SCALP' ? 'S8' :
      cand.strategyFamily === 'DOUBLE_TOP_BOTTOM' ? 'S10' :
      cand.strategyFamily === 'BARE_SR' ? 'S11' :
      cand.strategyFamily === 'BREAK_AND_RETEST' ? 'S12' :
      cand.strategyFamily === 'STRUCTURE_ENGULFING' ? 'S13' : 'S1'
    );

    const simOutcome = simulateForwardOutcome(
      candles5mAll,
      i,
      cand.direction,
      cand.entryPrice,
      cand.stopLoss,
      cand.tp1,
      cand.tp2,
      cand.tp1Rr,
      cand.tp2Rr
    );

    const ema15m = ind15m.ema50 || current5m.close;
    const ema1h = ind1h.ema50 || current5m.close;
    const last15mClose = history15m[history15m.length - 1].close;
    const last1hClose = history1h[history1h.length - 1].close;

    // Alignment definitions matching engine semantics:
    // BUY: last closed candle close >= EMA50
    // SELL: last closed candle close <= EMA50
    const is15mAligned = cand.direction === 'BUY' ? last15mClose >= ema15m : last15mClose <= ema15m;
    const is1hAligned = cand.direction === 'BUY' ? last1hClose >= ema1h : last1hClose <= ema1h;
    const isDualAligned = is15mAligned && is1hAligned;
    const isAnyAligned = is15mAligned || is1hAligned;

    signals.push({
      timestamp: current5m.timestamp,
      dateStr: new Date(current5m.timestamp).toISOString().slice(0, 10),
      strategyId,
      strategyFamily: cand.strategyFamily,
      setupName: cand.setupName,
      direction: cand.direction,
      confidence: cand.confidence,
      entryPrice: cand.entryPrice,
      stopLoss: cand.stopLoss,
      tp1: cand.tp1,
      tp2: cand.tp2,
      plannedRr: Number((cand.tp1Rr || 1.5).toFixed(2)),
      slDist: Number(Math.abs(cand.entryPrice - cand.stopLoss).toFixed(2)),
      tp1Dist: Number(Math.abs(cand.tp1 - cand.entryPrice).toFixed(2)),
      ema15m: Number(ema15m.toFixed(2)),
      ema1h: Number(ema1h.toFixed(2)),
      last15mClose: Number(last15mClose.toFixed(2)),
      last1hClose: Number(last1hClose.toFixed(2)),
      is15mAligned,
      is1hAligned,
      isDualAligned,
      isAnyAligned,
      outcome: simOutcome,
    });
  }

  // Verify storage integrity
  const activeTradesAfter = storage.getTrades().length;
  const outcomesAfter = storage.getTradeOutcomes().length;
  console.log('====================================================');
  console.log('STORAGE INTEGRITY VERIFICATION');
  console.log('====================================================');
  console.log(`Active trades before/after : ${activeTradesBefore} / ${activeTradesAfter}`);
  console.log(`Trade outcomes before/after: ${outcomesBefore} / ${outcomesAfter}`);
  assert.strictEqual(activeTradesBefore, activeTradesAfter);
  assert.strictEqual(outcomesBefore, outcomesAfter);
  console.log(`✔ Storage integrity verified: 0 synthetic records created.\n`);

  // Helper function for experiment stats
  const computeExpStats = (expLabel: string, subSigs: DispatchedRecord[], baselineSigs: DispatchedRecord[]) => {
    const N = subSigs.length;
    const baseN = baselineSigs.length;
    
    const wins = subSigs.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2');
    const tp1Wins = subSigs.filter((s) => s.outcome.outcome === 'TP1').length;
    const tp2Wins = subSigs.filter((s) => s.outcome.outcome === 'TP2').length;
    const slLosses = subSigs.filter((s) => s.outcome.outcome === 'SL').length;
    const ambig = subSigs.filter((s) => s.outcome.outcome === 'AMBIGUOUS').length;
    const timeout = subSigs.filter((s) => s.outcome.outcome === 'TIMEOUT').length;

    const winRate = N > 0 ? Number((wins.length / N * 100).toFixed(1)) : 0;
    const ci = calculateWilsonCI(wins.length, N);

    const winsR = wins.reduce((acc, s) => acc + s.outcome.realizedR, 0);
    const lossesR = Math.abs(subSigs.filter((s) => s.outcome.realizedR < 0).reduce((acc, s) => acc + s.outcome.realizedR, 0));
    const pf = lossesR > 0 ? Number((winsR / lossesR).toFixed(2)) : Number(winsR.toFixed(2));
    const totalR = Number((winsR - lossesR).toFixed(2));
    const avgR = N > 0 ? Number((totalR / N).toFixed(2)) : 0;
    const avgPlannedRr = N > 0 ? Number(mean(subSigs.map((s) => s.plannedRr)).toFixed(2)) : 0;

    const signalRetentionPct = Number((N / baseN * 100).toFixed(1));
    const baseLosses = baselineSigs.filter((s) => s.outcome.outcome === 'SL' || s.outcome.outcome === 'AMBIGUOUS').length;
    const baseWins = baselineSigs.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2').length;
    
    const expLosses = slLosses + ambig;
    const lossesEliminated = baseLosses - expLosses;
    const winnersEliminated = baseWins - wins.length;
    const falseNegativeRate = baseWins > 0 ? Number((winnersEliminated / baseWins * 100).toFixed(1)) : 0;

    const baseTotalR = Number(baselineSigs.reduce((acc, s) => acc + s.outcome.realizedR, 0).toFixed(2));
    const relativeRImprovement = Number((totalR - baseTotalR).toFixed(2));

    console.log(`====================================================`);
    console.log(`${expLabel.toUpperCase()}`);
    console.log(`====================================================`);
    console.log(`Total Signals (N)       : ${N} (Retention: ${signalRetentionPct}%)`);
    console.log(`TP1 Wins / TP2 Wins     : ${tp1Wins} / ${tp2Wins} (Total Wins: ${wins.length})`);
    console.log(`SL Losses / Ambiguous   : ${slLosses} / ${ambig}`);
    console.log(`Timeouts                : ${timeout}`);
    console.log(`TP1 Win Rate            : ${winRate}% | Wilson 95% CI: [${ci.lower}%, ${ci.upper}%]`);
    console.log(`Profit Factor           : ${pf}`);
    console.log(`Total Realized R        : ${totalR}R`);
    console.log(`Average Realized R      : ${avgR}R / trade`);
    console.log(`Avg Planned R:R         : ${avgPlannedRr}R`);
    console.log(`Losses Eliminated       : ${lossesEliminated} / ${baseLosses} (${((lossesEliminated / baseLosses) * 100).toFixed(1)}%)`);
    console.log(`Winners Eliminated      : ${winnersEliminated} / ${baseWins} (FN Rate: ${falseNegativeRate}%)`);
    console.log(`Relative R Improvement  : +${relativeRImprovement}R vs Baseline\n`);

    return {
      expLabel,
      N,
      tp1Wins,
      tp2Wins,
      winsCount: wins.length,
      slLosses,
      ambig,
      timeout,
      winRate,
      ci,
      pf,
      totalR,
      avgR,
      avgPlannedRr,
      signalRetentionPct,
      lossesEliminated,
      winnersEliminated,
      falseNegativeRate,
      relativeRImprovement,
    };
  };

  const expAStats = computeExpStats('Baseline (No HTF Alignment)', signals, signals);
  const expBStats = computeExpStats('Experiment B: 15M EMA50 Aligned Only', signals.filter((s) => s.is15mAligned), signals);
  const expCStats = computeExpStats('Experiment C: 1H EMA50 Aligned Only', signals.filter((s) => s.is1hAligned), signals);
  const expDStats = computeExpStats('Experiment D: Dual 15M AND 1H Aligned', signals.filter((s) => s.isDualAligned), signals);

  // Strategy-by-strategy breakdown table
  const stratCodes = ['S1', 'S2', 'S3', 'S4', 'S6', 'S7', 'S8', 'S10', 'S11', 'S12', 'S13'];

  const printStratBreakdown = (expTitle: string, subSigs: DispatchedRecord[]) => {
    console.log(`\n--- STRATEGY BREAKDOWN: ${expTitle} ---`);
    console.log(`Strategy | N   | TP1 | TP2 | SL  | Win % | PF   | Total R  | Avg R  | Power Status`);
    console.log(`----------------------------------------------------------------------------------`);
    for (const code of stratCodes) {
      const sRecs = subSigs.filter((s) => s.strategyId === code);
      const n = sRecs.length;
      if (n === 0) {
        console.log(`${code.padEnd(8)} |   0 |   0 |   0 |   0 |  0.0% | 0.00 |    0.00R |  0.00R | LOW POWER (N=0)`);
        continue;
      }
      const tp1 = sRecs.filter((s) => s.outcome.outcome === 'TP1').length;
      const tp2 = sRecs.filter((s) => s.outcome.outcome === 'TP2').length;
      const sl = sRecs.filter((s) => s.outcome.outcome === 'SL' || s.outcome.outcome === 'AMBIGUOUS').length;
      const wr = ((tp1 + tp2) / n * 100).toFixed(1);
      const wR = sRecs.filter((s) => s.outcome.realizedR > 0).reduce((acc, s) => acc + s.outcome.realizedR, 0);
      const lR = Math.abs(sRecs.filter((s) => s.outcome.realizedR < 0).reduce((acc, s) => acc + s.outcome.realizedR, 0));
      const pf = lR > 0 ? (wR / lR).toFixed(2) : wR.toFixed(2);
      const totR = (wR - lR).toFixed(2);
      const avgR = (Number(totR) / n).toFixed(2);
      const powerStatus = n < 10 ? 'LOW POWER (N<10)' : n < 30 ? 'MODERATE (N<30)' : 'ADEQUATE POWER';

      console.log(`${code.padEnd(8)} | ${String(n).padStart(3)} | ${String(tp1).padStart(3)} | ${String(tp2).padStart(3)} | ${String(sl).padStart(3)} | ${wr.padStart(5)}% | ${pf.padStart(4)} | ${totR.padStart(8)}R | ${avgR.padStart(6)}R | ${powerStatus}`);
    }
  };

  printStratBreakdown('Baseline (Exp A)', signals);
  printStratBreakdown('15M Aligned Only (Exp B)', signals.filter((s) => s.is15mAligned));
  printStratBreakdown('1H Aligned Only (Exp C)', signals.filter((s) => s.is1hAligned));
  printStratBreakdown('Dual 15M + 1H Aligned (Exp D)', signals.filter((s) => s.isDualAligned));

  // Multi-Regime Temporal Breakdown (3 Windows)
  console.log('\n====================================================');
  console.log('TEMPORAL / REGIME MULTI-WINDOW BREAKDOWN');
  console.log('====================================================');

  const minTs = signals[0]?.timestamp || startTime;
  const maxTs = signals[signals.length - 1]?.timestamp || endTime;
  const timeThird = (maxTs - minTs) / 3;

  for (let w = 1; w <= 3; w++) {
    const wStart = minTs + (w - 1) * timeThird;
    const wEnd = minTs + w * timeThird;
    const wBase = signals.filter((s) => s.timestamp >= wStart && s.timestamp < wEnd);
    const w15m = wBase.filter((s) => s.is15mAligned);
    const w1h = wBase.filter((s) => s.is1hAligned);
    const wDual = wBase.filter((s) => s.isDualAligned);

    const getWindowMetrics = (arr: DispatchedRecord[]) => {
      const n = arr.length;
      if (n === 0) return { n: 0, wr: '0.0', pf: '0.00', totR: '0.00' };
      const wCount = arr.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2').length;
      const wr = (wCount / n * 100).toFixed(1);
      const wR = arr.filter((s) => s.outcome.realizedR > 0).reduce((acc, s) => acc + s.outcome.realizedR, 0);
      const lR = Math.abs(arr.filter((s) => s.outcome.realizedR < 0).reduce((acc, s) => acc + s.outcome.realizedR, 0));
      const pf = lR > 0 ? (wR / lR).toFixed(2) : wR.toFixed(2);
      const totR = (wR - lR).toFixed(2);
      return { n, wr, pf, totR };
    };

    const mBase = getWindowMetrics(wBase);
    const m15m = getWindowMetrics(w15m);
    const m1h = getWindowMetrics(w1h);
    const mDual = getWindowMetrics(wDual);

    console.log(`Window ${w} (${new Date(wStart).toISOString().slice(5, 10)} to ${new Date(wEnd).toISOString().slice(5, 10)}):`);
    console.log(`  Baseline (Exp A) : N=${String(mBase.n).padStart(2)} | WinRate=${mBase.wr.padStart(5)}% | PF=${mBase.pf.padStart(4)} | TotalR=${mBase.totR.padStart(7)}R`);
    console.log(`  15M Aligned (B)  : N=${String(m15m.n).padStart(2)} | WinRate=${m15m.wr.padStart(5)}% | PF=${m15m.pf.padStart(4)} | TotalR=${m15m.totR.padStart(7)}R`);
    console.log(`  1H Aligned (C)   : N=${String(m1h.n).padStart(2)} | WinRate=${m1h.wr.padStart(5)}% | PF=${m1h.pf.padStart(4)} | TotalR=${m1h.totR.padStart(7)}R`);
    console.log(`  Dual Aligned (D) : N=${String(mDual.n).padStart(2)} | WinRate=${mDual.wr.padStart(5)}% | PF=${mDual.pf.padStart(4)} | TotalR=${mDual.totR.padStart(7)}R\n`);
  }

  // False Positive / False Negative Analysis
  console.log('====================================================');
  console.log('FALSE POSITIVE / FALSE NEGATIVE TRADEOFF ANALYSIS');
  console.log('====================================================');

  const printFpFnTradeoff = (filterName: string, filteredSigs: DispatchedRecord[]) => {
    const baseWins = signals.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2');
    const baseLosses = signals.filter((s) => s.outcome.outcome === 'SL' || s.outcome.outcome === 'AMBIGUOUS');

    const removedSigs = signals.filter((s) => !filteredSigs.includes(s));
    const removedWins = removedSigs.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2');
    const removedLosses = removedSigs.filter((s) => s.outcome.outcome === 'SL' || s.outcome.outcome === 'AMBIGUOUS');

    const winnerRemovalPct = (removedWins.length / baseWins.length * 100).toFixed(1);
    const loserRemovalPct = (removedLosses.length / baseLosses.length * 100).toFixed(1);

    const rFromRemovedWins = removedWins.reduce((acc, s) => acc + s.outcome.realizedR, 0);
    const rFromRemovedLosses = Math.abs(removedLosses.reduce((acc, s) => acc + s.outcome.realizedR, 0));
    const netRImprovement = (rFromRemovedLosses - rFromRemovedWins).toFixed(2);

    console.log(`--- ${filterName} ---`);
    console.log(`  Baseline Winners Removed (FNs) : ${removedWins.length} / ${baseWins.length} (${winnerRemovalPct}%)`);
    console.log(`  Baseline Losers Removed (FPs)  : ${removedLosses.length} / ${baseLosses.length} (${loserRemovalPct}%)`);
    console.log(`  R Sacrificed from Removed Wins : +${rFromRemovedWins.toFixed(2)}R`);
    console.log(`  R Saved from Removed Losers    : -${rFromRemovedLosses.toFixed(2)}R`);
    console.log(`  Net Realized R Improvement     : +${netRImprovement}R\n`);
  };

  printFpFnTradeoff('Experiment B (15M Aligned Only)', signals.filter((s) => s.is15mAligned));
  printFpFnTradeoff('Experiment C (1H Aligned Only)', signals.filter((s) => s.is1hAligned));
  printFpFnTradeoff('Experiment D (Dual 15M + 1H Aligned)', signals.filter((s) => s.isDualAligned));

  // Confidence Calibration Interaction
  console.log('====================================================');
  console.log('CONFIDENCE CALIBRATION BUCKET BREAKDOWN');
  console.log('====================================================');
  console.log(`Bucket | Baseline (N, Win%, R) | Exp B 15M (N, Win%, R) | Exp C 1H (N, Win%, R) | Exp D Dual (N, Win%, R)`);
  console.log(`---------------------------------------------------------------------------------------------------------`);

  const confBuckets = [
    { label: '75-79%', min: 75, max: 79 },
    { label: '80-84%', min: 80, max: 84 },
    { label: '85-89%', min: 85, max: 89 },
    { label: '90-94%', min: 90, max: 94 },
    { label: '95%+', min: 95, max: 100 },
  ];

  for (const b of confBuckets) {
    const getBucketStats = (arr: DispatchedRecord[]) => {
      const bS = arr.filter((s) => s.confidence >= b.min && s.confidence <= b.max);
      const n = bS.length;
      if (n === 0) return `N= 0 (  0.0%,   0.00R)`;
      const w = bS.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2').length;
      const wr = (w / n * 100).toFixed(1);
      const r = bS.reduce((acc, s) => acc + s.outcome.realizedR, 0).toFixed(2);
      return `N=${String(n).padStart(2)} (${wr.padStart(5)}%, ${r.padStart(7)}R)`;
    };

    const stA = getBucketStats(signals);
    const stB = getBucketStats(signals.filter((s) => s.is15mAligned));
    const stC = getBucketStats(signals.filter((s) => s.is1hAligned));
    const stD = getBucketStats(signals.filter((s) => s.isDualAligned));

    console.log(`${b.label.padEnd(6)} | ${stA} | ${stB} | ${stC} | ${stD}`);
  }
});
