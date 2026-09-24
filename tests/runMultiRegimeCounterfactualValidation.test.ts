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

export interface S4CandidateRecord {
  timestamp: number;
  dateStr: string;
  direction: 'BUY' | 'SELL';
  mssLevel: number;
  atr5m: number;
  candleIndex: number;
  group: 'IMMEDIATE' | 'RETEST_NO_REJECT' | 'RETEST_REJECT_CONFIRMED' | 'NO_RETEST';
  retestQuality?: 'CLEAN' | 'DEEP' | 'FAILED' | 'IMMEDIATE_1_2_BARS' | 'DELAYED_3_PLUS';
  barsToRetest?: number;
  retestDepthPts?: number;
  retestDepthAtr?: number;
  rejectionWickRatio?: number;
  rejectionCandleRangeAtr?: number;
  outcome: CandidateOutcome;
}

export interface S11CandidateRecord {
  timestamp: number;
  dateStr: string;
  direction: 'BUY' | 'SELL';
  level: number;
  atr5m: number;
  candleIndex: number;
  touches: number;
  group: 'BARE_TOUCH' | 'SWEEP_NO_RECLAIM' | 'SWEEP_CLOSE_INSIDE' | 'DEEP_SWEEP_RECLAIM' | 'FAILED_BREAKOUT';
  sweepDepthPts: number;
  sweepDepthAtr: number;
  sweepCategory: 'SHALLOW' | 'MEDIUM' | 'DEEP';
  rejectionWickRatio: number;
  hasFollowThrough: boolean;
  outcome: CandidateOutcome;
}

test('Run Multi-Regime Counterfactual Validation — S4 Retest & S11 Sweep', async () => {
  console.log('====================================================');
  console.log('MULTI-REGIME COUNTERFACTUAL VALIDATION (S4 & S11)');
  console.log('Period: 2026-07-16 through 2026-09-24');
  console.log('====================================================\n');

  storage.savePoi = () => {};
  const activeTradesBefore = storage.getTrades().length;
  const outcomesBefore = storage.getTradeOutcomes().length;
  globalPoiTracker.setPois([]);

  const startTime = new Date('2026-07-16T00:00:00.000Z').getTime();
  const endTime = new Date('2026-09-24T23:59:59.999Z').getTime();

  console.log('[Dataset] Loading 90D XAUUSD dataset...');
  const dataset = await fetchHistoricalBacktestDataset({
    symbol: 'XAUUSD',
    timeRange: '90D',
    requestedStartTime: startTime,
    requestedEndTime: endTime,
  });

  const candles5mAll = dataset.candles5m;
  const candles15mAll = dataset.candles15m;
  const candles1hAll = dataset.candles1h;

  console.log(`[Dataset] Total 5M candles: ${candles5mAll.length}`);

  let startIndex = candles5mAll.findIndex((c) => c.timestamp >= startTime);
  if (startIndex < 35) startIndex = 35;

  const s4Candidates: S4CandidateRecord[] = [];
  const s11Candidates: S11CandidateRecord[] = [];

  // Window boundaries
  const w1Start = new Date('2026-07-16T00:00:00Z').getTime();
  const w1End = new Date('2026-08-08T23:59:59Z').getTime();
  const w2Start = new Date('2026-08-09T00:00:00Z').getTime();
  const w2End = new Date('2026-08-31T23:59:59Z').getTime();
  const w3Start = new Date('2026-09-01T00:00:00Z').getTime();
  const w3End = new Date('2026-09-24T23:59:59Z').getTime();

  for (let i = startIndex; i < candles5mAll.length - 20; i++) {
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
    const allCandies = genResult.allCandidates || [];

    for (const cand of allCandies) {
      const isS4 = cand.patternMetadata?.strategyId === 'S4' || (cand.strategyFamily === 'MARKET_STRUCTURE' && cand.setupName.includes('Market Structure Shift'));
      const isS11 = cand.patternMetadata?.strategyId === 'S11' || cand.strategyFamily === 'BARE_SR';

      if (!isS4 && !isS11) continue;

      const atr5m = ind5m.atr14 || 2.0;

      if (isS4) {
        const mssLevel = cand.direction === 'BUY' ? ind5m.swingLow : ind5m.swingHigh;

        // Observe future 5M bars (up to 12 bars = 1 hour) for retest behavior
        let retestFound = false;
        let retestBarIndex = -1;
        let retestDepthPts = 0;
        let retestQuality: 'CLEAN' | 'DEEP' | 'FAILED' | 'IMMEDIATE_1_2_BARS' | 'DELAYED_3_PLUS' = 'CLEAN';
        let isRejectionConfirmed = false;
        let rejectionWickRatio = 0;
        let rejectionCandleRangeAtr = 0;

        for (let b = 1; b <= 12; b++) {
          const cSub = candles5mAll[i + b];
          if (!cSub) break;

          const isNearLevel = cand.direction === 'BUY'
            ? (cSub.low <= mssLevel + 0.3 * atr5m)
            : (cSub.high >= mssLevel - 0.3 * atr5m);

          if (isNearLevel) {
            retestFound = true;
            retestBarIndex = b;
            const cBody = Math.abs(cSub.close - cSub.open);
            const cRange = Math.max(0.01, cSub.high - cSub.low);
            const uWick = cSub.high - Math.max(cSub.open, cSub.close);
            const lWick = Math.min(cSub.open, cSub.close) - cSub.low;
            const rejWick = cand.direction === 'BUY' ? lWick : uWick;

            rejectionWickRatio = Number((rejWick / Math.max(0.01, cBody)).toFixed(2));
            rejectionCandleRangeAtr = Number((cRange / atr5m).toFixed(2));

            if (cand.direction === 'BUY') {
              retestDepthPts = Math.max(0, mssLevel - cSub.low);
            } else {
              retestDepthPts = Math.max(0, cSub.high - mssLevel);
            }

            const isReclaimed = cand.direction === 'BUY' ? cSub.close > mssLevel - 0.1 * atr5m : cSub.close < mssLevel + 0.1 * atr5m;

            if (retestDepthPts / atr5m > 0.8 && !isReclaimed) {
              retestQuality = 'FAILED';
            } else if (retestDepthPts / atr5m > 0.4) {
              retestQuality = 'DEEP';
            } else {
              retestQuality = b <= 2 ? 'IMMEDIATE_1_2_BARS' : 'CLEAN';
            }

            if (rejWick >= cBody * 1.0 && isReclaimed) {
              isRejectionConfirmed = true;
            }
            break;
          }
        }

        let group: 'IMMEDIATE' | 'RETEST_NO_REJECT' | 'RETEST_REJECT_CONFIRMED' | 'NO_RETEST' = 'IMMEDIATE';
        let entrySimIndex = i;
        let entryPx = cand.entryPrice;
        let slPx = cand.stopLoss;
        let tp1Px = cand.tp1;

        if (retestFound) {
          if (isRejectionConfirmed) {
            group = 'RETEST_REJECT_CONFIRMED';
            entrySimIndex = i + retestBarIndex;
            const confirmCandle = candles5mAll[entrySimIndex];
            if (confirmCandle) {
              entryPx = confirmCandle.close;
              const newSlDist = Math.abs(entryPx - slPx);
              tp1Px = cand.direction === 'BUY' ? entryPx + newSlDist * cand.tp1Rr : entryPx - newSlDist * cand.tp1Rr;
            }
          } else {
            group = 'RETEST_NO_REJECT';
            entrySimIndex = i + retestBarIndex;
          }
        } else {
          group = 'NO_RETEST';
        }

        const simOutcome = simulateForwardOutcome(
          candles5mAll,
          entrySimIndex,
          cand.direction,
          entryPx,
          slPx,
          tp1Px,
          cand.tp2,
          cand.tp1Rr,
          cand.tp2Rr
        );

        s4Candidates.push({
          timestamp: current5m.timestamp,
          dateStr: new Date(current5m.timestamp).toISOString().slice(0, 10),
          direction: cand.direction,
          mssLevel: Number(mssLevel.toFixed(2)),
          atr5m: Number(atr5m.toFixed(2)),
          candleIndex: i,
          group,
          retestQuality: retestFound ? retestQuality : undefined,
          barsToRetest: retestFound ? retestBarIndex : undefined,
          retestDepthPts: retestFound ? Number((retestDepthPts * 10).toFixed(1)) : undefined,
          retestDepthAtr: retestFound ? Number((retestDepthPts / atr5m).toFixed(2)) : undefined,
          rejectionWickRatio: retestFound ? rejectionWickRatio : undefined,
          rejectionCandleRangeAtr: retestFound ? rejectionCandleRangeAtr : undefined,
          outcome: simOutcome,
        });
      } else if (isS11) {
        const srLevel = cand.patternMetadata?.level ?? (cand.direction === 'BUY' ? ind15m.support : ind15m.resistance);
        const touches = cand.patternMetadata?.touches ?? 2;

        const cBody = Math.abs(current5m.close - current5m.open);
        const cRange = Math.max(0.01, current5m.high - current5m.low);
        const uWick = current5m.high - Math.max(current5m.open, current5m.close);
        const lWick = Math.min(current5m.open, current5m.close) - current5m.low;
        const rejWick = cand.direction === 'BUY' ? lWick : uWick;

        let sweepDepthPts = 0;
        if (cand.direction === 'BUY') {
          sweepDepthPts = Math.max(0, srLevel - current5m.low);
        } else {
          sweepDepthPts = Math.max(0, current5m.high - srLevel);
        }
        const sweepDepthAtr = Number((sweepDepthPts / atr5m).toFixed(2));

        let sweepCategory: 'SHALLOW' | 'MEDIUM' | 'DEEP' = 'SHALLOW';
        if (sweepDepthAtr >= 0.8) sweepCategory = 'DEEP';
        else if (sweepDepthAtr >= 0.3) sweepCategory = 'MEDIUM';

        const isClosedBackInside = cand.direction === 'BUY'
          ? current5m.close >= srLevel - 0.1 * atr5m
          : current5m.close <= srLevel + 0.1 * atr5m;

        let hasFollowThrough = false;
        const nextCandle = candles5mAll[i + 1];
        if (nextCandle) {
          hasFollowThrough = cand.direction === 'BUY' ? nextCandle.close > current5m.close : nextCandle.close < current5m.close;
        }

        let group: 'BARE_TOUCH' | 'SWEEP_NO_RECLAIM' | 'SWEEP_CLOSE_INSIDE' | 'DEEP_SWEEP_RECLAIM' | 'FAILED_BREAKOUT' = 'BARE_TOUCH';

        if (sweepDepthAtr < 0.2) {
          group = 'BARE_TOUCH';
        } else if (sweepDepthAtr >= 0.2 && !isClosedBackInside) {
          group = 'SWEEP_NO_RECLAIM';
        } else if (sweepDepthAtr >= 0.8 && isClosedBackInside) {
          group = 'DEEP_SWEEP_RECLAIM';
        } else if (sweepDepthAtr >= 0.2 && isClosedBackInside) {
          group = 'SWEEP_CLOSE_INSIDE';
        } else {
          group = 'FAILED_BREAKOUT';
        }

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

        s11Candidates.push({
          timestamp: current5m.timestamp,
          dateStr: new Date(current5m.timestamp).toISOString().slice(0, 10),
          direction: cand.direction,
          level: Number(srLevel.toFixed(2)),
          atr5m: Number(atr5m.toFixed(2)),
          candleIndex: i,
          touches,
          group,
          sweepDepthPts: Number((sweepDepthPts * 10).toFixed(1)),
          sweepDepthAtr,
          sweepCategory,
          rejectionWickRatio: Number((rejWick / Math.max(0.01, cBody)).toFixed(2)),
          hasFollowThrough,
          outcome: simOutcome,
        });
      }
    }
  }

  // Storage Isolation Verification
  const activeTradesAfter = storage.getTrades().length;
  const outcomesAfter = storage.getTradeOutcomes().length;
  console.log('====================================================');
  console.log('STORAGE PARTITION INTEGRITY');
  console.log('====================================================');
  console.log(`Active trades before/after: ${activeTradesBefore} / ${activeTradesAfter}`);
  console.log(`Trade outcomes before/after: ${outcomesBefore} / ${outcomesAfter}`);
  assert.strictEqual(activeTradesBefore, activeTradesAfter);
  assert.strictEqual(outcomesBefore, outcomesAfter);
  console.log(`✔ Storage isolation verified: 0 synthetic records saved.\n`);

  // Helper printer for candidate sets
  const printSetStats = (name: string, recs: { outcome: CandidateOutcome }[]) => {
    const N = recs.length;
    if (N === 0) {
      console.log(`${name.padEnd(38)} | N=  0 | WinRate= 0.0% | CI=[ 0.0%,  0.0%] | PF=0.00 | TotalR=   0.00R | Status: N<20 SMALL SAMPLE`);
      return { N, winRate: 0, pf: 0, totalR: 0, ciLower: 0, ciUpper: 0 };
    }
    const wins = recs.filter((r) => r.outcome.outcome === 'TP1' || r.outcome.outcome === 'TP2').length;
    const losses = recs.filter((r) => r.outcome.outcome === 'SL' || r.outcome.outcome === 'AMBIGUOUS').length;
    const winRate = Number((wins / N * 100).toFixed(1));
    const winsR = recs.filter((r) => r.outcome.realizedR > 0).reduce((s, r) => s + r.outcome.realizedR, 0);
    const lossesR = Math.abs(recs.filter((r) => r.outcome.realizedR < 0).reduce((s, r) => s + r.outcome.realizedR, 0));
    const pf = lossesR > 0 ? Number((winsR / lossesR).toFixed(2)) : Number(winsR.toFixed(2));
    const totalR = Number(recs.reduce((s, r) => s + r.outcome.realizedR, 0).toFixed(2));
    const ci = calculateWilsonCI(wins, N);

    let status = 'N>=50 POTENTIALLY USEFUL';
    if (N < 20) status = 'N<20 SMALL SAMPLE - EXPLORATORY ONLY';
    else if (N < 50) status = 'N<50 LOW POWER - INSUFFICIENT';

    console.log(`${name.padEnd(38)} | N=${String(N).padStart(3)} | WinRate=${winRate.toFixed(1).padStart(5)}% | CI=[${ci.lower.toFixed(1).padStart(5)}%, ${ci.upper.toFixed(1).padStart(5)}%] | PF=${pf.toFixed(2).padStart(4)} | TotalR=${totalR.toFixed(2).padStart(7)}R | ${status}`);
    return { N, winRate, pf, totalR, ciLower: ci.lower, ciUpper: ci.upper };
  };

  // ====================================================
  // PHASE 2 & 3 — S4 RETEST COUNTERFACTUAL RESULTS
  // ====================================================
  console.log('====================================================');
  console.log('PHASE 2 & 3: S4 RETEST COUNTERFACTUAL RESULTS');
  console.log('====================================================');
  printSetStats('S4 Immediate Entry (Baseline)', s4Candidates.filter((s) => s.group === 'IMMEDIATE'));
  printSetStats('S4 Retest (Any Retest)', s4Candidates.filter((s) => s.group === 'RETEST_NO_REJECT' || s.group === 'RETEST_REJECT_CONFIRMED'));
  printSetStats('S4 Retest + Rejection Confirmed', s4Candidates.filter((s) => s.group === 'RETEST_REJECT_CONFIRMED'));
  printSetStats('S4 No Retest Occurred', s4Candidates.filter((s) => s.group === 'NO_RETEST'));

  console.log('\n--- S4 Retest Quality Breakdown ---');
  printSetStats('Clean Retest', s4Candidates.filter((s) => s.retestQuality === 'CLEAN'));
  printSetStats('Immediate Retest (1-2 bars)', s4Candidates.filter((s) => s.retestQuality === 'IMMEDIATE_1_2_BARS'));
  printSetStats('Deep Retest', s4Candidates.filter((s) => s.retestQuality === 'DEEP'));
  printSetStats('Failed Retest', s4Candidates.filter((s) => s.retestQuality === 'FAILED'));

  // ====================================================
  // PHASE 4 — S4 MULTI-REGIME / TEMPORAL SPLIT
  // ====================================================
  console.log('\n====================================================');
  console.log('PHASE 4: S4 MULTI-REGIME / TEMPORAL WINDOW SPLIT');
  console.log('====================================================');

  const s4W1_Imm = s4Candidates.filter((s) => s.timestamp >= w1Start && s.timestamp <= w1End && s.group === 'IMMEDIATE');
  const s4W1_Ret = s4Candidates.filter((s) => s.timestamp >= w1Start && s.timestamp <= w1End && s.group === 'RETEST_REJECT_CONFIRMED');
  const s4W2_Imm = s4Candidates.filter((s) => s.timestamp >= w2Start && s.timestamp <= w2End && s.group === 'IMMEDIATE');
  const s4W2_Ret = s4Candidates.filter((s) => s.timestamp >= w2Start && s.timestamp <= w2End && s.group === 'RETEST_REJECT_CONFIRMED');
  const s4W3_Imm = s4Candidates.filter((s) => s.timestamp >= w3Start && s.timestamp <= w3End && s.group === 'IMMEDIATE');
  const s4W3_Ret = s4Candidates.filter((s) => s.timestamp >= w3Start && s.timestamp <= w3End && s.group === 'RETEST_REJECT_CONFIRMED');

  console.log('Window 1 (Jul 16 - Aug 08) [TRAIN]:');
  printSetStats('  S4 Immediate', s4W1_Imm);
  printSetStats('  S4 Retest Confirmed', s4W1_Ret);

  console.log('Window 2 (Aug 09 - Aug 31) [TRAIN]:');
  printSetStats('  S4 Immediate', s4W2_Imm);
  printSetStats('  S4 Retest Confirmed', s4W2_Ret);

  console.log('Window 3 (Sep 01 - Sep 24) [TEST - OUT OF SAMPLE]:');
  printSetStats('  S4 Immediate', s4W3_Imm);
  printSetStats('  S4 Retest Confirmed', s4W3_Ret);

  // ====================================================
  // PHASE 5 & 6 — S11 SWEEP COUNTERFACTUAL RESULTS
  // ====================================================
  console.log('\n====================================================');
  console.log('PHASE 5 & 6: S11 SWEEP COUNTERFACTUAL RESULTS');
  console.log('====================================================');
  printSetStats('S11 Bare Touch (Baseline)', s11Candidates.filter((s) => s.group === 'BARE_TOUCH'));
  printSetStats('S11 Sweep Without Reclaim', s11Candidates.filter((s) => s.group === 'SWEEP_NO_RECLAIM'));
  printSetStats('S11 Sweep + Close Back Inside', s11Candidates.filter((s) => s.group === 'SWEEP_CLOSE_INSIDE'));
  printSetStats('S11 Deep Sweep + Reclaim', s11Candidates.filter((s) => s.group === 'DEEP_SWEEP_RECLAIM'));
  printSetStats('S11 Sweep + Reclaim + FollowThrough', s11Candidates.filter((s) => (s.group === 'SWEEP_CLOSE_INSIDE' || s.group === 'DEEP_SWEEP_RECLAIM') && s.hasFollowThrough));

  console.log('\n--- S11 Sweep Depth Breakdown ---');
  printSetStats('Shallow Sweep (<0.3 ATR)', s11Candidates.filter((s) => s.sweepCategory === 'SHALLOW'));
  printSetStats('Medium Sweep (0.3 - 0.8 ATR)', s11Candidates.filter((s) => s.sweepCategory === 'MEDIUM'));
  printSetStats('Deep Sweep (>0.8 ATR)', s11Candidates.filter((s) => s.sweepCategory === 'DEEP'));

  // ====================================================
  // PHASE 7 — S11 MULTI-REGIME / TEMPORAL SPLIT
  // ====================================================
  console.log('\n====================================================');
  console.log('PHASE 7: S11 MULTI-REGIME / TEMPORAL WINDOW SPLIT');
  console.log('====================================================');

  const s11W1_Bare = s11Candidates.filter((s) => s.timestamp >= w1Start && s.timestamp <= w1End && s.group === 'BARE_TOUCH');
  const s11W1_Sweep = s11Candidates.filter((s) => s.timestamp >= w1Start && s.timestamp <= w1End && (s.group === 'SWEEP_CLOSE_INSIDE' || s.group === 'DEEP_SWEEP_RECLAIM'));
  const s11W2_Bare = s11Candidates.filter((s) => s.timestamp >= w2Start && s.timestamp <= w2End && s.group === 'BARE_TOUCH');
  const s11W2_Sweep = s11Candidates.filter((s) => s.timestamp >= w2Start && s.timestamp <= w2End && (s.group === 'SWEEP_CLOSE_INSIDE' || s.group === 'DEEP_SWEEP_RECLAIM'));
  const s11W3_Bare = s11Candidates.filter((s) => s.timestamp >= w3Start && s.timestamp <= w3End && s.group === 'BARE_TOUCH');
  const s11W3_Sweep = s11Candidates.filter((s) => s.timestamp >= w3Start && s.timestamp <= w3End && (s.group === 'SWEEP_CLOSE_INSIDE' || s.group === 'DEEP_SWEEP_RECLAIM'));

  console.log('Window 1 (Jul 16 - Aug 08) [TRAIN]:');
  printSetStats('  S11 Bare Touch', s11W1_Bare);
  printSetStats('  S11 Sweep + Reclaim', s11W1_Sweep);

  console.log('Window 2 (Aug 09 - Aug 31) [TRAIN]:');
  printSetStats('  S11 Bare Touch', s11W2_Bare);
  printSetStats('  S11 Sweep + Reclaim', s11W2_Sweep);

  console.log('Window 3 (Sep 01 - Sep 24) [TEST - OUT OF SAMPLE]:');
  printSetStats('  S11 Bare Touch', s11W3_Bare);
  printSetStats('  S11 Sweep + Reclaim', s11W3_Sweep);

  // ====================================================
  // PHASE 8 — FALSE POSITIVE / FALSE NEGATIVE ANALYSIS
  // ====================================================
  console.log('\n====================================================');
  console.log('PHASE 8: FALSE POSITIVE / FALSE NEGATIVE ANALYSIS');
  console.log('====================================================');

  const s4ImmWins = s4Candidates.filter((s) => s.group === 'IMMEDIATE' && (s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2')).length;
  const s4ImmLosses = s4Candidates.filter((s) => s.group === 'IMMEDIATE' && (s.outcome.outcome === 'SL' || s.outcome.outcome === 'AMBIGUOUS')).length;
  const s4RetWins = s4Candidates.filter((s) => s.group === 'RETEST_REJECT_CONFIRMED' && (s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2')).length;

  console.log(`S4 Immediate Baseline Losses       : ${s4ImmLosses}`);
  console.log(`S4 Immediate Baseline Wins         : ${s4ImmWins}`);
  console.log(`S4 Retest Confirmed Wins           : ${s4RetWins}`);
  console.log(`S4 False Positives Removed (Losses): ${s4ImmLosses} immediate losses avoided`);
  console.log(`S4 False Negatives (Winners Lost)  : ${s4ImmWins} immediate winners traded off`);

  const s11BareWins = s11Candidates.filter((s) => s.group === 'BARE_TOUCH' && (s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2')).length;
  const s11BareLosses = s11Candidates.filter((s) => s.group === 'BARE_TOUCH' && (s.outcome.outcome === 'SL' || s.outcome.outcome === 'AMBIGUOUS')).length;
  const s11SweepWins = s11Candidates.filter((s) => (s.group === 'SWEEP_CLOSE_INSIDE' || s.group === 'DEEP_SWEEP_RECLAIM') && (s.outcome.outcome === 'TP1' || s.outcome.outcome === 'TP2')).length;

  console.log(`\nS11 Bare Touch Baseline Losses     : ${s11BareLosses}`);
  console.log(`S11 Bare Touch Baseline Wins       : ${s11BareWins}`);
  console.log(`S11 Sweep + Reclaim Wins           : ${s11SweepWins}`);
  console.log(`S11 False Positives Removed        : ${s11BareLosses} bare losses avoided`);
  console.log(`S11 False Negatives (Winners Lost) : ${s11BareWins} bare winners traded off`);
});
