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

test('Run Read-Only Forensic Counterfactual — Global 15M/1H EMA50 Trend Alignment', async () => {
  console.log('====================================================');
  console.log('STARTING READ-ONLY FORENSIC HTF TREND ALIGNMENT EXPERIMENTS');
  console.log('Period: 2026-07-16 through 2026-09-24');
  console.log('====================================================\n');

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
      asset: 'XAU/USD',
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

  // Storage Isolation Verification
  const activeTradesAfter = storage.getTrades().length;
  const outcomesAfter = storage.getTradeOutcomes().length;
  console.log('====================================================');
  console.log('SAFETY & ISOLATION VERIFICATION');
  console.log('====================================================');
  console.log(`Active trades before/after : ${activeTradesBefore} / ${activeTradesAfter}`);
  console.log(`Trade outcomes before/after: ${outcomesBefore} / ${outcomesAfter}`);
  assert.strictEqual(activeTradesBefore, activeTradesAfter);
  assert.strictEqual(outcomesBefore, outcomesAfter);
  console.log(`✔ Storage isolation verified: 0 synthetic records created.\n`);

  // Helper for reporting Experiment results
  const reportExpStats = (expName: string, subSigs: DispatchedRecord[], baselineSigs: DispatchedRecord[]) => {
    const N = subSigs.length;
    const baseN = baselineSigs.length;
    if (N === 0) {
      console.log(`\n=== ${expName} ===\nQualified Signals: 0`);
      return;
    }

    const wins = subSigs.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2');
    const tp1Wins = subSigs.filter((s) => s.outcome.outcome === 'TP1').length;
    const tp2Wins = subSigs.filter((s) => s.outcome.outcome === 'TP2').length;
    const slLosses = subSigs.filter((s) => s.outcome.outcome === 'SL').length;
    const ambig = subSigs.filter((s) => s.outcome.outcome === 'AMBIGUOUS').length;
    const timeout = subSigs.filter((s) => s.outcome.outcome === 'TIMEOUT').length;

    const winRate = Number((wins.length / N * 100).toFixed(1));
    const ci = calculateWilsonCI(wins.length, N);

    const winsR = wins.reduce((acc, s) => acc + s.outcome.realizedR, 0);
    const lossesR = Math.abs(subSigs.filter((s) => s.outcome.realizedR < 0).reduce((acc, s) => acc + s.outcome.realizedR, 0));
    const pf = lossesR > 0 ? Number((winsR / lossesR).toFixed(2)) : Number(winsR.toFixed(2));
    const totalR = Number((winsR - lossesR).toFixed(2));
    const avgR = Number((totalR / N).toFixed(2));
    const avgPlannedRr = Number(mean(subSigs.map((s) => s.plannedRr)).toFixed(2));
    const avgMfe = Number(mean(subSigs.map((s) => s.outcome.mfeR)).toFixed(2));
    const avgMae = Number(mean(subSigs.map((s) => s.outcome.maeR)).toFixed(2));

    const signalReductionPct = Number(((baseN - N) / baseN * 100).toFixed(1));
    const baseLosses = baselineSigs.filter((s) => s.outcome.outcome === 'SL' || s.outcome.outcome === 'AMBIGUOUS').length;
    const expLosses = slLosses + ambig;
    const lossReductionPct = baseLosses > 0 ? Number(((baseLosses - expLosses) / baseLosses * 100).toFixed(1)) : 0;
    const baseTotalR = Number(baselineSigs.reduce((acc, s) => acc + s.outcome.realizedR, 0).toFixed(2));
    const rSaved = Number((totalR - baseTotalR).toFixed(2));

    let status = 'SUPPORTED (POTENTIALLY ROBUST)';
    if (N < 20) status = 'INCONCLUSIVE / N<20 SMALL SAMPLE';
    else if (N < 50) status = 'PROMISING BUT UNDERPOWERED (N<50)';

    console.log(`====================================================`);
    console.log(`${expName.toUpperCase()}`);
    console.log(`====================================================`);
    console.log(`Qualified Signals (N)  : ${N} (Retention: ${(100 - signalReductionPct).toFixed(1)}%)`);
    console.log(`TP1 Wins / TP2 Wins    : ${tp1Wins} / ${tp2Wins}`);
    console.log(`SL Losses / Ambiguous  : ${slLosses} / ${ambig}`);
    console.log(`Timeouts               : ${timeout}`);
    console.log(`TP1 Win Rate           : ${winRate}% | Wilson 95% CI: [${ci.lower}%, ${ci.upper}%]`);
    console.log(`Profit Factor          : ${pf}`);
    console.log(`Total Realized R       : ${totalR}R`);
    console.log(`Average Realized R     : ${avgR}R / trade`);
    console.log(`Avg Planned R:R        : ${avgPlannedRr}R`);
    console.log(`Avg MFE / Avg MAE      : +${avgMfe}R / -${avgMae}R`);
    console.log(`Signal Reduction %     : ${signalReductionPct}%`);
    console.log(`Loss Reduction %       : ${lossReductionPct}% (${baseLosses - expLosses} losses eliminated)`);
    console.log(`Net R Saved vs Baseline: +${rSaved}R`);
    console.log(`Classification Status  : ${status}\n`);

    return { N, winRate, pf, totalR, avgR, ci, rSaved, lossesEliminated: baseLosses - expLosses };
  };

  // Run Experiments A, B, C, D, E
  console.log('--- RUNNING EXPERIMENT COMPARISONS ---');
  const expA = reportExpStats('Experiment A: Baseline (No HTF Alignment Filter)', signals, signals);
  const expB = reportExpStats('Experiment B: 15M EMA50 Alignment Only', signals.filter((s) => s.is15mAligned), signals);
  const expC = reportExpStats('Experiment C: 1H EMA50 Alignment Only', signals.filter((s) => s.is1hAligned), signals);
  const expD = reportExpStats('Experiment D: Dual 15M AND 1H EMA50 Alignment', signals.filter((s) => s.isDualAligned), signals);
  const expE = reportExpStats('Experiment E: At Least One (15M OR 1H) Aligned', signals.filter((s) => s.isAnyAligned), signals);

  // ====================================================
  // STRATEGY-BY-STRATEGY BREAKDOWN
  // ====================================================
  console.log('====================================================');
  console.log('STRATEGY-BY-STRATEGY PERFORMANCE BREAKDOWN');
  console.log('====================================================');

  const stratCodes = ['S1', 'S2', 'S3', 'S4', 'S6', 'S7', 'S8', 'S10', 'S11', 'S12', 'S13'];

  const printStratTable = (expTitle: string, stratSigs: DispatchedRecord[]) => {
    console.log(`\n--- ${expTitle} ---`);
    console.log(`Strategy | N   | TP1 | TP2 | SL  | Win % | PF   | Total R  | Avg R`);
    console.log(`------------------------------------------------------------------`);
    for (const code of stratCodes) {
      const sRecs = stratSigs.filter((s) => s.strategyId === code);
      const n = sRecs.length;
      if (n === 0) {
        console.log(`${code.padEnd(8)} |   0 |   0 |   0 |   0 |  0.0% | 0.00 |    0.00R |  0.00R`);
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

      console.log(`${code.padEnd(8)} | ${String(n).padStart(3)} | ${String(tp1).padStart(3)} | ${String(tp2).padStart(3)} | ${String(sl).padStart(3)} | ${wr.padStart(5)}% | ${pf.padStart(4)} | ${totR.padStart(8)}R | ${avgR.padStart(6)}R`);
    }
  };

  printStratTable('Baseline (Experiment A)', signals);
  printStratTable('15M Aligned Only (Experiment B)', signals.filter((s) => s.is15mAligned));
  printStratTable('Dual 15M + 1H Aligned (Experiment D)', signals.filter((s) => s.isDualAligned));

  // ====================================================
  // MULTI-REGIME / TEMPORAL SPLIT (3 WINDOWS)
  // ====================================================
  console.log('\n====================================================');
  console.log('MULTI-REGIME TEMPORAL WINDOW BREAKDOWN');
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

    const getWStats = (arr: DispatchedRecord[]) => {
      const n = arr.length;
      if (n === 0) return { n: 0, wr: '0.0', pf: '0.00', totR: '0.00' };
      const w = arr.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2').length;
      const wr = (w / n * 100).toFixed(1);
      const wR = arr.filter((s) => s.outcome.realizedR > 0).reduce((acc, s) => acc + s.outcome.realizedR, 0);
      const lR = Math.abs(arr.filter((s) => s.outcome.realizedR < 0).reduce((acc, s) => acc + s.outcome.realizedR, 0));
      const pf = lR > 0 ? (wR / lR).toFixed(2) : wR.toFixed(2);
      const totR = (wR - lR).toFixed(2);
      return { n, wr, pf, totR };
    };

    const stBase = getWStats(wBase);
    const st15m = getWStats(w15m);
    const st1h = getWStats(w1h);
    const stDual = getWStats(wDual);

    console.log(`Window ${w} (${new Date(wStart).toISOString().slice(5, 10)} to ${new Date(wEnd).toISOString().slice(5, 10)}):`);
    console.log(`  Baseline     : N=${String(stBase.n).padStart(2)} | WinRate=${stBase.wr.padStart(5)}% | PF=${stBase.pf.padStart(4)} | TotalR=${stBase.totR.padStart(7)}R`);
    console.log(`  15M Aligned  : N=${String(st15m.n).padStart(2)} | WinRate=${st15m.wr.padStart(5)}% | PF=${st15m.pf.padStart(4)} | TotalR=${st15m.totR.padStart(7)}R`);
    console.log(`  1H Aligned   : N=${String(st1h.n).padStart(2)} | WinRate=${st1h.wr.padStart(5)}% | PF=${st1h.pf.padStart(4)} | TotalR=${st1h.totR.padStart(7)}R`);
    console.log(`  Dual Aligned : N=${String(stDual.n).padStart(2)} | WinRate=${stDual.wr.padStart(5)}% | PF=${stDual.pf.padStart(4)} | TotalR=${stDual.totR.padStart(7)}R\n`);
  }

  // ====================================================
  // FALSE POSITIVE / FALSE NEGATIVE ANALYSIS
  // ====================================================
  console.log('====================================================');
  console.log('FALSE POSITIVE / FALSE NEGATIVE TRADEOFF ANALYSIS');
  console.log('====================================================');

  const baseWins = signals.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2');
  const baseLosses = signals.filter((s) => s.outcome.outcome === 'SL' || s.outcome.outcome === 'AMBIGUOUS');

  const ctSigs = signals.filter((s) => !s.is15mAligned);
  const ctWins = ctSigs.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2');
  const ctLosses = ctSigs.filter((s) => s.outcome.outcome === 'SL' || s.outcome.outcome === 'AMBIGUOUS');

  const ctLossesPct = (ctLosses.length / baseLosses.length * 100).toFixed(1);
  const ctWinsPct = (ctWins.length / baseWins.length * 100).toFixed(1);
  const ctLossR = Math.abs(ctLosses.reduce((acc, s) => acc + s.outcome.realizedR, 0));
  const ctWinR = ctWins.reduce((acc, s) => acc + s.outcome.realizedR, 0);
  const ctNetR = (ctWinR - ctLossR).toFixed(2);

  console.log(`1. % Baseline Losses Counter-Trend (15M) : ${ctLossesPct}% (${ctLosses.length}/${baseLosses.length})`);
  console.log(`2. % Baseline Winners Counter-Trend (15M): ${ctWinsPct}% (${ctWins.length}/${baseWins.length})`);
  console.log(`3. R Lost from Counter-Trend Trades      : -${ctLossR.toFixed(2)}R`);
  console.log(`4. R Generated by Counter-Trend Winners  : +${ctWinR.toFixed(2)}R (Net drag: ${ctNetR}R)`);
  console.log(`5. Baseline Winners Sacrificed (FNs)     : ${ctWins.length} winners (${ctWinsPct}%)`);
  console.log(`6. Baseline Losers Eliminated (FPs)      : ${ctLosses.length} losers (${ctLossesPct}%)`);
  console.log(`7. False Negative Rate                   : ${ctWinsPct}%`);
  console.log(`8. False Positive Reduction Rate         : ${ctLossesPct}%`);
  console.log(`9. Net Realized R Improvement            : +${(Number(ctNetR) * -1).toFixed(2)}R\n`);

  // ====================================================
  // CRITICAL CHECK: 15M ALIGNED VS DUAL (15M + 1H) ALIGNED
  // ====================================================
  console.log('====================================================');
  console.log('CRITICAL CHECK: 15M ALIGNED VS DUAL (15M + 1H) ALIGNED');
  console.log('====================================================');

  const sigs15mOnly = signals.filter((s) => s.is15mAligned);
  const sigsDual = signals.filter((s) => s.isDualAligned);
  const sigs15mNot1h = signals.filter((s) => s.is15mAligned && !s.is1hAligned);

  console.log(`15M Aligned Only (Exp B)       : N=${sigs15mOnly.length} | Realized R=${sigs15mOnly.reduce((acc, s) => acc + s.outcome.realizedR, 0).toFixed(2)}R`);
  console.log(`Dual 15M + 1H Aligned (Exp D)  : N=${sigsDual.length} | Realized R=${sigsDual.reduce((acc, s) => acc + s.outcome.realizedR, 0).toFixed(2)}R`);
  console.log(`15M Aligned BUT 1H Misaligned  : N=${sigs15mNot1h.length} | Realized R=${sigs15mNot1h.reduce((acc, s) => acc + s.outcome.realizedR, 0).toFixed(2)}R`);
  if (sigs15mNot1h.length > 0) {
    const wins15mNot1h = sigs15mNot1h.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2').length;
    console.log(`  -> Win Rate of 15M Aligned / 1H Misaligned: ${(wins15mNot1h / sigs15mNot1h.length * 100).toFixed(1)}% (${wins15mNot1h}/${sigs15mNot1h.length})`);
  }

  // ====================================================
  // CONFIDENCE CALIBRATION BREAKDOWN
  // ====================================================
  console.log('\n====================================================');
  console.log('CONFIDENCE CALIBRATION BREAKDOWN ACROSS EXPERIMENTS');
  console.log('====================================================');
  console.log(`Bucket | Baseline (N, Win%, R) | 15M Aligned (N, Win%, R) | Dual Aligned (N, Win%, R)`);
  console.log(`------------------------------------------------------------------------------------`);

  const confBuckets = [
    { label: '75-79%', min: 75, max: 79 },
    { label: '80-84%', min: 80, max: 84 },
    { label: '85-89%', min: 85, max: 89 },
    { label: '90-94%', min: 90, max: 94 },
    { label: '95%+', min: 95, max: 100 },
  ];

  for (const b of confBuckets) {
    const getBStats = (arr: DispatchedRecord[]) => {
      const bS = arr.filter((s) => s.confidence >= b.min && s.confidence <= b.max);
      const n = bS.length;
      if (n === 0) return `N= 0 (  0.0%,   0.00R)`;
      const w = bS.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2').length;
      const wr = (w / n * 100).toFixed(1);
      const r = bS.reduce((acc, s) => acc + s.outcome.realizedR, 0).toFixed(2);
      return `N=${String(n).padStart(2)} (${wr.padStart(5)}%, ${r.padStart(7)}R)`;
    };

    const stA = getBStats(signals);
    const stB = getBStats(signals.filter((s) => s.is15mAligned));
    const stD = getBStats(signals.filter((s) => s.isDualAligned));

    console.log(`${b.label.padEnd(6)} | ${stA} | ${stB} | ${stD}`);
  }
});
