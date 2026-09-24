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

export interface DispatchedSignalRecord {
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
  slDist: number;
  tp1Dist: number;
  plannedRr: number;
  // Technical / Location Context
  distFrom15mEma50: number;
  distFrom1hEma50: number;
  is15mEmaAligned: boolean;
  is1hEmaAligned: boolean;
  atr5m: number;
  cBody: number;
  cRange: number;
  bodyToRange: number;
  wickToBody: number;
  hasLiquiditySweep: boolean;
  lossCategory?: string;
  outcome: CandidateOutcome;
}

test('Run Comprehensive Global Loss Mechanism Forensics', async () => {
  console.log('====================================================');
  console.log('STARTING GLOBAL LOSS MECHANISM FORENSIC INVESTIGATION');
  console.log('Period: 2026-07-16 through 2026-09-24');
  console.log('====================================================\n');

  storage.savePoi = () => {};
  const activeTradesBefore = storage.getTrades().length;
  const outcomesBefore = storage.getTradeOutcomes().length;
  globalPoiTracker.setPois([]);

  const startTime = new Date('2026-07-16T00:00:00.000Z').getTime();
  const endTime = new Date('2026-09-24T23:59:59.999Z').getTime();

  console.log('[Dataset] Fetching real historical candles...');
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

  const signals: DispatchedSignalRecord[] = [];

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

    const atr5m = ind5m.atr14 || 2.0;
    const cBody = Math.abs(current5m.close - current5m.open);
    const cRange = Math.max(0.01, current5m.high - current5m.low);
    const uWick = current5m.high - Math.max(current5m.open, current5m.close);
    const lWick = Math.min(current5m.open, current5m.close) - current5m.low;
    const rejWick = cand.direction === 'BUY' ? lWick : uWick;

    const ema50_15m = ind15m.ema50 || current5m.close;
    const ema50_1h = ind1h.ema50 || current5m.close;

    const is15mEmaAligned = cand.direction === 'BUY' ? current5m.close >= ema50_15m : current5m.close <= ema50_15m;
    const is1hEmaAligned = cand.direction === 'BUY' ? current5m.close >= ema50_1h : current5m.close <= ema50_1h;

    // Categorize Loss Cause
    let lossCategory: string | undefined = undefined;
    if (simOutcome.outcome === 'SL' || simOutcome.outcome === 'AMBIGUOUS') {
      if (simOutcome.mfeR >= 1.0) {
        lossCategory = 'A. Target Unreachable (MFE >= 1.0R hit before SL)';
      } else if (simOutcome.maeR >= 1.0 && simOutcome.mfeR < 0.3 && !is1hEmaAligned) {
        lossCategory = 'C. HTF Trend Conflict (Opposing 1H Trend)';
      } else if (simOutcome.barsToSl <= 2) {
        lossCategory = 'B. Immediate Adverse Movement (SL hit within 2 bars)';
      } else if (rejWick / cRange < 0.2 && cBody / cRange > 0.7) {
        lossCategory = 'D. Entry Exhaustion (Chased momentum candle)';
      } else if (simOutcome.maeR > 1.2 && simOutcome.mfeR >= 0.3) {
        lossCategory = 'E. Liquidity Fakeout / Deep Sweep';
      } else {
        lossCategory = 'F. Poor Structural Location / Choppy Noise';
      }
    }

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
      slDist: Number(Math.abs(cand.entryPrice - cand.stopLoss).toFixed(2)),
      tp1Dist: Number(Math.abs(cand.tp1 - cand.entryPrice).toFixed(2)),
      plannedRr: Number((cand.tp1Rr || 1.5).toFixed(2)),
      distFrom15mEma50: Number((Math.abs(cand.entryPrice - ema50_15m) / atr5m).toFixed(2)),
      distFrom1hEma50: Number((Math.abs(cand.entryPrice - ema50_1h) / atr5m).toFixed(2)),
      is15mEmaAligned,
      is1hEmaAligned,
      atr5m: Number(atr5m.toFixed(2)),
      cBody: Number(cBody.toFixed(2)),
      cRange: Number(cRange.toFixed(2)),
      bodyToRange: Number((cBody / cRange).toFixed(2)),
      wickToBody: Number((rejWick / Math.max(0.01, cBody)).toFixed(2)),
      hasLiquiditySweep: ind5m.liquiditySweepDetected === true || ind15m.liquiditySweepDetected === true,
      lossCategory,
      outcome: simOutcome,
    });
  }

  // Storage Isolation Verification
  const activeTradesAfter = storage.getTrades().length;
  const outcomesAfter = storage.getTradeOutcomes().length;
  console.log('====================================================');
  console.log('STORAGE ISOLATION CHECK');
  console.log('====================================================');
  console.log(`Active trades before/after: ${activeTradesBefore} / ${activeTradesAfter}`);
  console.log(`Trade outcomes before/after: ${outcomesBefore} / ${outcomesAfter}`);
  assert.strictEqual(activeTradesBefore, activeTradesAfter);
  assert.strictEqual(outcomesBefore, outcomesAfter);
  console.log(`✔ Storage isolation verified: 0 synthetic records saved.\n`);

  const totalSigs = signals.length;
  const wins = signals.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2');
  const losses = signals.filter((s) => s.outcome.outcome === 'SL' || s.outcome.outcome === 'AMBIGUOUS');
  const winRate = totalSigs > 0 ? (wins.length / totalSigs * 100).toFixed(1) : '0.0';

  const winsR = wins.reduce((acc, s) => acc + s.outcome.realizedR, 0);
  const lossesR = Math.abs(losses.reduce((acc, s) => acc + s.outcome.realizedR, 0));
  const profitFactor = lossesR > 0 ? (winsR / lossesR).toFixed(2) : winsR.toFixed(2);
  const totalRealizedR = (winsR - lossesR).toFixed(2);
  const ci = calculateWilsonCI(wins.length, totalSigs);

  console.log('====================================================');
  console.log('RESTORED BASELINE OVERALL PERFORMANCE SUMMARY');
  console.log('====================================================');
  console.log(`Total Dispatched Signals : ${totalSigs}`);
  console.log(`TP1/TP2 Wins             : ${wins.length}`);
  console.log(`SL Losses                : ${losses.length}`);
  console.log(`TP1 Win Rate             : ${winRate}%`);
  console.log(`Wilson 95% CI            : [${ci.lower}%, ${ci.upper}%]`);
  console.log(`Profit Factor            : ${profitFactor}`);
  console.log(`Total Realized R         : ${totalRealizedR}R\n`);

  // ====================================================
  // B. GLOBAL LOSS DECOMPOSITION
  // ====================================================
  console.log('====================================================');
  console.log('GLOBAL LOSS MECHANISM DECOMPOSITION');
  console.log('====================================================');
  console.log(`Loss Category                                        | Count | % Losses | Total R Loss | Avg MFE | Avg MAE`);
  console.log(`---------------------------------------------------------------------------------------------------------`);

  const lossCats = [
    'A. Target Unreachable (MFE >= 1.0R hit before SL)',
    'B. Immediate Adverse Movement (SL hit within 2 bars)',
    'C. HTF Trend Conflict (Opposing 1H Trend)',
    'D. Entry Exhaustion (Chased momentum candle)',
    'E. Liquidity Fakeout / Deep Sweep',
    'F. Poor Structural Location / Choppy Noise',
  ];

  for (const cat of lossCats) {
    const catSigs = losses.filter((s) => s.lossCategory === cat);
    const catCount = catSigs.length;
    const catPct = losses.length > 0 ? (catCount / losses.length * 100).toFixed(1) : '0.0';
    const catRLoss = catSigs.reduce((acc, s) => acc + s.outcome.realizedR, 0).toFixed(2);
    const avgMfe = catCount > 0 ? mean(catSigs.map((s) => s.outcome.mfeR)).toFixed(2) : '0.00';
    const avgMae = catCount > 0 ? mean(catSigs.map((s) => s.outcome.maeR)).toFixed(2) : '0.00';

    console.log(`${cat.padEnd(52)} | ${String(catCount).padStart(5)} | ${catPct.padStart(7)}% | ${catRLoss.padStart(11)}R | +${avgMfe.padStart(4)}R | -${avgMae.padStart(4)}R`);
  }

  // ====================================================
  // C. CROSS-STRATEGY FACTOR ANALYSIS & CONFLUENCE
  // ====================================================
  console.log('\n====================================================');
  console.log('CROSS-STRATEGY CONFLUENCE FACTORS');
  console.log('====================================================');

  const printConfluenceRow = (label: string, subSigs: DispatchedSignalRecord[]) => {
    const n = subSigs.length;
    if (n === 0) {
      console.log(`${label.padEnd(48)} | N=  0 | WinRate= 0.0% | PF=0.00 | TotalR=   0.00R | [N<20 SMALL SAMPLE]`);
      return;
    }
    const w = subSigs.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2').length;
    const wr = (w / n * 100).toFixed(1);
    const wR = subSigs.filter((s) => s.outcome.realizedR > 0).reduce((acc, s) => acc + s.outcome.realizedR, 0);
    const lR = Math.abs(subSigs.filter((s) => s.outcome.realizedR < 0).reduce((acc, s) => acc + s.outcome.realizedR, 0));
    const pf = lR > 0 ? (wR / lR).toFixed(2) : wR.toFixed(2);
    const totR = (wR - lR).toFixed(2);
    const wCi = calculateWilsonCI(w, n);

    let tag = 'POTENTIALLY ROBUST';
    if (n < 20) tag = 'STATISTICALLY WEAK / N<20';
    else if (n < 50) tag = 'LOW POWER / N<50';

    console.log(`${label.padEnd(48)} | N=${String(n).padStart(3)} | WinRate=${wr.padStart(5)}% | PF=${pf.padStart(4)} | TotalR=${totR.padStart(7)}R | CI=[${wCi.lower}%, ${wCi.upper}%] | ${tag}`);
  };

  // Factor 1: 1H Trend Alignment
  printConfluenceRow('Factor 1: 1H EMA50 Trend Aligned', signals.filter((s) => s.is1hEmaAligned));
  printConfluenceRow('Factor 1: 1H EMA50 Trend Misaligned', signals.filter((s) => !s.is1hEmaAligned));

  // Factor 2: 15M Trend Alignment
  printConfluenceRow('Factor 2: 15M EMA50 Trend Aligned', signals.filter((s) => s.is15mEmaAligned));
  printConfluenceRow('Factor 2: 15M EMA50 Trend Misaligned', signals.filter((s) => !s.is15mEmaAligned));

  // Factor 3: Dual HTF Alignment (15M + 1H Agreed)
  printConfluenceRow('Factor 3: Dual HTF Aligned (15M & 1H Agreed)', signals.filter((s) => s.is15mEmaAligned && s.is1hEmaAligned));

  // Factor 4: Target Distance / Capping (Planned RR <= 2.2R)
  printConfluenceRow('Factor 4: Moderate Target (Planned RR <= 2.2R)', signals.filter((s) => s.plannedRr <= 2.2));
  printConfluenceRow('Factor 4: Distant Target (Planned RR > 2.2R)', signals.filter((s) => s.plannedRr > 2.2));

  // Factor 5: Liquidity Sweep Detected
  printConfluenceRow('Factor 5: Liquidity Sweep Detected', signals.filter((s) => s.hasLiquiditySweep));
  printConfluenceRow('Factor 5: No Liquidity Sweep Detected', signals.filter((s) => !s.hasLiquiditySweep));

  // Factor 6: Rejection Wick Quality (Wick / Body >= 1.2)
  printConfluenceRow('Factor 6: Strong Rejection Wick (Wick/Body >= 1.2)', signals.filter((s) => s.wickToBody >= 1.2));
  printConfluenceRow('Factor 6: Weak Rejection Wick (Wick/Body < 1.2)', signals.filter((s) => s.wickToBody < 1.2));

  // Confluence Combo: Dual HTF Aligned + Moderate Target (RR <= 2.2R)
  printConfluenceRow('Combo A: Dual HTF Aligned + RR <= 2.2R', signals.filter((s) => s.is15mEmaAligned && s.is1hEmaAligned && s.plannedRr <= 2.2));

  // Confluence Combo: Liquidity Sweep + Rejection Wick >= 1.2
  printConfluenceRow('Combo B: Liquidity Sweep + Wick/Body >= 1.2', signals.filter((s) => s.hasLiquiditySweep && s.wickToBody >= 1.2));

  // ====================================================
  // E. CONFIDENCE CALIBRATION AUDIT
  // ====================================================
  console.log('\n====================================================');
  console.log('CONFIDENCE CALIBRATION BREAKDOWN');
  console.log('====================================================');
  console.log(`Bucket | Count | Wins | Losses | Win Rate | PF   | Total Realized R | Avg MFE | Avg MAE`);
  console.log(`--------------------------------------------------------------------------------------`);

  const confBuckets = [
    { label: '75-79%', min: 75, max: 79 },
    { label: '80-84%', min: 80, max: 84 },
    { label: '85-89%', min: 85, max: 89 },
    { label: '90-94%', min: 90, max: 94 },
    { label: '95%+', min: 95, max: 100 },
  ];

  for (const b of confBuckets) {
    const bSigs = signals.filter((s) => s.confidence >= b.min && s.confidence <= b.max);
    const count = bSigs.length;
    if (count === 0) continue;
    const bWins = bSigs.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2').length;
    const bLosses = bSigs.filter((s) => s.outcome.outcome === 'SL' || s.outcome.outcome === 'AMBIGUOUS').length;
    const bWinRate = (bWins / count * 100).toFixed(1);
    const bWinsR = bSigs.filter((s) => s.outcome.realizedR > 0).reduce((acc, s) => acc + s.outcome.realizedR, 0);
    const bLossesR = Math.abs(bSigs.filter((s) => s.outcome.realizedR < 0).reduce((acc, s) => acc + s.outcome.realizedR, 0));
    const bPf = bLossesR > 0 ? (bWinsR / bLossesR).toFixed(2) : bWinsR.toFixed(2);
    const bTotR = (bWinsR - bLossesR).toFixed(2);
    const bMfe = mean(bSigs.map((s) => s.outcome.mfeR)).toFixed(2);
    const bMae = mean(bSigs.map((s) => s.outcome.maeR)).toFixed(2);

    console.log(`${b.label.padEnd(6)} | ${String(count).padStart(5)} | ${String(bWins).padStart(4)} | ${String(bLosses).padStart(6)} | ${bWinRate.padStart(7)}% | ${bPf.padStart(4)} | ${bTotR.padStart(15)}R | +${bMfe}R | -${bMae}R`);
  }

  // ====================================================
  // D. MULTI-REGIME / TEMPORAL SPLIT (3 WINDOWS)
  // ====================================================
  console.log('\n====================================================');
  console.log('MULTI-REGIME TEMPORAL VALIDATION (3 CHRONOLOGICAL WINDOWS)');
  console.log('====================================================');

  const minTs = signals[0]?.timestamp || startTime;
  const maxTs = signals[signals.length - 1]?.timestamp || endTime;
  const timeThird = (maxTs - minTs) / 3;

  for (let w = 1; w <= 3; w++) {
    const wStart = minTs + (w - 1) * timeThird;
    const wEnd = minTs + w * timeThird;
    const wSigs = signals.filter((s) => s.timestamp >= wStart && s.timestamp < wEnd);
    const wCount = wSigs.length;
    const wWins = wSigs.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2').length;
    const wWinRate = wCount > 0 ? (wWins / wCount * 100).toFixed(1) : '0.0';
    const wWinsR = wSigs.filter((s) => s.outcome.realizedR > 0).reduce((acc, s) => acc + s.outcome.realizedR, 0);
    const wLossesR = Math.abs(wSigs.filter((s) => s.outcome.realizedR < 0).reduce((acc, s) => acc + s.outcome.realizedR, 0));
    const wPf = wLossesR > 0 ? (wWinsR / wLossesR).toFixed(2) : wWinsR.toFixed(2);
    const wTotR = (wWinsR - wLossesR).toFixed(2);

    const w15mAligned = wSigs.filter((s) => s.is15mEmaAligned);
    const w15mWins = w15mAligned.filter((s) => s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2').length;
    const w15mRate = w15mAligned.length > 0 ? (w15mWins / w15mAligned.length * 100).toFixed(1) : '0.0';

    console.log(`Window ${w} (${new Date(wStart).toISOString().slice(5, 10)} to ${new Date(wEnd).toISOString().slice(5, 10)}):`);
    console.log(`  All Signals      : N=${String(wCount).padStart(3)} | WinRate=${wWinRate}% | PF=${wPf} | TotalR=${wTotR}R`);
    console.log(`  15M EMA Aligned  : N=${String(w15mAligned.length).padStart(3)} | WinRate=${w15mRate}%\n`);
  }

  // ====================================================
  // I. READ-ONLY COUNTERFACTUAL EXPERIMENTS
  // ====================================================
  console.log('====================================================');
  console.log('READ-ONLY COUNTERFACTUAL SIMULATION EXPERIMENTS');
  console.log('====================================================');

  // Experiment 1: Require 15M EMA Trend Alignment
  const exp1Sigs = signals.filter((s) => s.is15mEmaAligned);
  printConfluenceRow('Exp 1: Require 15M EMA Trend Alignment', exp1Sigs);

  // Experiment 2: Limit Planned RR Ceiling to 2.2R Across All Strategies
  const exp2Sigs = signals.map((s) => {
    if (s.plannedRr > 2.2) {
      const newTp1Dist = s.slDist * 2.2;
      const newTp1 = s.direction === 'BUY' ? s.entryPrice + newTp1Dist : s.entryPrice - newTp1Dist;
      const sim = simulateForwardOutcome(candles5mAll, candles5mAll.findIndex((c) => c.timestamp === s.timestamp), s.direction, s.entryPrice, s.stopLoss, newTp1, undefined, 2.2);
      return { ...s, outcome: sim };
    }
    return s;
  });
  printConfluenceRow('Exp 2: Universal 2.2R Target Cap', exp2Sigs);

  // Experiment 3: Require Liquidity Sweep + Rejection Wick >= 1.0 Ratio
  const exp3Sigs = signals.filter((s) => s.hasLiquiditySweep && s.wickToBody >= 1.0);
  printConfluenceRow('Exp 3: Liquidity Sweep + Rejection Wick >= 1.0', exp3Sigs);
});
