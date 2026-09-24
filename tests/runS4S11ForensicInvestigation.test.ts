import test from 'node:test';
import assert from 'node:assert';
import { fetchHistoricalBacktestDataset } from '../server/marketData.js';
import { analyzeTechnicals } from '../server/indicators.js';
import { generateMultiStrategyCandidates } from '../server/strategyEngine.js';
import { globalPoiTracker, detectBareSRLevels } from '../server/tradeQualityEngine.js';
import { storage } from '../server/storage.js';

export interface S4DetailRecord {
  timestamp: number;
  dateStr: string;
  direction: 'BUY' | 'SELL';
  entry: number;
  stopLoss: number;
  tp1: number;
  slDist: number;
  tp1Dist: number;
  plannedRr: number;
  poiPrice: number;
  poiDistPts: number;
  poiDistAtr: number;
  mssType: string;
  displacementPts: number;
  displacementAtr: number;
  wickToBodyRatio: number;
  wickToRangeRatio: number;
  bodyToAtr: number;
  rangeToAtr: number;
  rsi5m: number;
  rsi15m: number;
  is15mEmaAligned: boolean;
  is1hEmaAligned: boolean;
  h1Trend: string;
  m15Trend: string;
  distFrom15mEma50: number;
  distFrom1hEma50: number;
  isHtfAgreement: boolean;
  isContinuation: boolean;
  barsFromTouchToEntry: number;
  barsFromBreakToEntry: number;
  hasRetest: boolean;
  hasRejectionCandle: boolean;
  hasLiquiditySweep: boolean;
  hasConsolidation: boolean;
  outcome: 'TP1' | 'TP2' | 'SL' | 'TIMEOUT' | 'AMBIGUOUS';
  realizedR: number;
  mfePts: number;
  mfeR: number;
  maePts: number;
  maeR: number;
  timeToMfeBars: number;
  timeToSlBars: number;
}

export interface S11DetailRecord {
  timestamp: number;
  dateStr: string;
  direction: 'BUY' | 'SELL';
  entry: number;
  stopLoss: number;
  tp1: number;
  slDist: number;
  tp1Dist: number;
  plannedRr: number;
  level: number;
  touches: number;
  levelAgeBars: number;
  levelStrength: number;
  rejectionDepthPts: number;
  penetrationDepthPts: number;
  penetrationAtr: number;
  wickToBodyRatio: number;
  wickToRangeRatio: number;
  bodySizePts: number;
  closeLocInCandle: number; // 0 (low) to 1 (high)
  h1Trend: string;
  m15Trend: string;
  is15mEmaAligned: boolean;
  is1hEmaAligned: boolean;
  distFrom15mEma50: number;
  distFrom1hEma50: number;
  hasSweepBeforeRejection: boolean;
  isLevelSwept: boolean;
  barsAfterTouch: number;
  hasImmediateRejection: boolean;
  closedBackInside: boolean;
  outcome: 'TP1' | 'TP2' | 'SL' | 'TIMEOUT' | 'AMBIGUOUS';
  realizedR: number;
  mfePts: number;
  mfeR: number;
  maePts: number;
  maeR: number;
  timeToMfeBars: number;
  timeToSlBars: number;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

test('Run Comprehensive S4 / S11 Forensic Investigation', async () => {
  console.log('====================================================');
  console.log('STARTING S4 / S11 ENTRY TIMING & CONFIRMATION FORENSICS');
  console.log('Period: 2026-07-16 through 2026-09-24');
  console.log('====================================================\n');

  storage.savePoi = () => {};
  globalPoiTracker.setPois([]);

  const startTime = new Date('2026-07-16T00:00:00.000Z').getTime();
  const endTime = new Date('2026-09-24T23:59:59.999Z').getTime();

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

  const s4Records: S4DetailRecord[] = [];
  const s11Records: S11DetailRecord[] = [];

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
    const allCandies = genResult.allCandidates || [];

    for (const cand of allCandies) {
      const isS4 = cand.patternMetadata?.strategyId === 'S4' || (cand.strategyFamily === 'MARKET_STRUCTURE' && cand.setupName.includes('Market Structure Shift'));
      const isS11 = cand.patternMetadata?.strategyId === 'S11' || cand.strategyFamily === 'BARE_SR';

      if (!isS4 && !isS11) continue;

      const slDist = Math.abs(cand.entryPrice - cand.stopLoss);
      const tp1Dist = Math.abs(cand.tp1 - cand.entryPrice);
      const plannedRr = cand.tp1Rr || (tp1Dist / slDist);

      // Forward simulation without lookahead
      let outcome: 'TP1' | 'TP2' | 'SL' | 'TIMEOUT' | 'AMBIGUOUS' = 'TIMEOUT';
      let maxMfe = 0;
      let maxMae = 0;
      let barsToMfe = 0;
      let barsToMae = 0;
      let barsToOutcome = 0;
      let exitPrice = current5m.close;

      const maxSimBars = Math.min(288, candles5mAll.length - 1 - i);

      for (let j = 1; j <= maxSimBars; j++) {
        const futureCandle = candles5mAll[i + j];
        if (!futureCandle) break;

        let highExcursion = 0;
        let lowExcursion = 0;

        if (cand.direction === 'BUY') {
          highExcursion = futureCandle.high - cand.entryPrice;
          lowExcursion = cand.entryPrice - futureCandle.low;
        } else {
          highExcursion = cand.entryPrice - futureCandle.low;
          lowExcursion = futureCandle.high - cand.entryPrice;
        }

        if (highExcursion > maxMfe) {
          maxMfe = highExcursion;
          barsToMfe = j;
        }
        if (lowExcursion > maxMae) {
          maxMae = lowExcursion;
          barsToMae = j;
        }

        let hitSl = false;
        let hitTp1 = false;

        if (cand.direction === 'BUY') {
          if (futureCandle.low <= cand.stopLoss) hitSl = true;
          if (futureCandle.high >= cand.tp1) hitTp1 = true;
        } else {
          if (futureCandle.high >= cand.stopLoss) hitSl = true;
          if (futureCandle.low <= cand.tp1) hitTp1 = true;
        }

        if (hitSl && hitTp1) {
          const openToSl = Math.abs(futureCandle.open - cand.stopLoss);
          const openToTp1 = Math.abs(futureCandle.open - cand.tp1);
          outcome = openToSl < openToTp1 ? 'SL' : openToTp1 < openToSl ? 'TP1' : 'AMBIGUOUS';
          exitPrice = outcome === 'TP1' ? cand.tp1 : cand.stopLoss;
          barsToOutcome = j;
          break;
        } else if (hitSl) {
          outcome = 'SL';
          exitPrice = cand.stopLoss;
          barsToOutcome = j;
          break;
        } else if (hitTp1) {
          outcome = 'TP1';
          exitPrice = cand.tp1;
          barsToOutcome = j;

          let hitTp2 = false;
          if (cand.tp2) {
            for (let k = j + 1; k <= maxSimBars; k++) {
              const cK = candles5mAll[i + k];
              if (!cK) break;
              if (cand.direction === 'BUY') {
                if (cK.low <= cand.stopLoss) break;
                if (cK.high >= cand.tp2) { hitTp2 = true; break; }
              } else {
                if (cK.high >= cand.stopLoss) break;
                if (cK.low <= cand.tp2) { hitTp2 = true; break; }
              }
            }
          }
          if (hitTp2) outcome = 'TP2';
          break;
        }
      }

      if (outcome === 'TIMEOUT') {
        barsToOutcome = maxSimBars;
        exitPrice = candles5mAll[i + maxSimBars]?.close || current5m.close;
      }

      let realizedR = 0;
      if (outcome === 'TP1') realizedR = plannedRr;
      else if (outcome === 'TP2') realizedR = cand.tp2Rr || (plannedRr * 1.5);
      else if (outcome === 'SL' || outcome === 'AMBIGUOUS') realizedR = -1.0;
      else if (outcome === 'TIMEOUT') {
        const pnlPts = cand.direction === 'BUY' ? (exitPrice - cand.entryPrice) : (cand.entryPrice - exitPrice);
        realizedR = Number((pnlPts / slDist).toFixed(2));
      }

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

      if (isS4) {
        const poiPrice = cand.direction === 'BUY' ? ind5m.swingLow : ind5m.swingHigh;
        const poiDistPts = Math.abs(cand.entryPrice - poiPrice);
        const poiDistAtr = Number((poiDistPts / atr5m).toFixed(2));
        const dispPts = Math.abs(current5m.close - current5m.open);

        s4Records.push({
          timestamp: current5m.timestamp,
          dateStr: new Date(current5m.timestamp).toISOString().slice(0, 10),
          direction: cand.direction,
          entry: cand.entryPrice,
          stopLoss: cand.stopLoss,
          tp1: cand.tp1,
          slDist: Number(slDist.toFixed(2)),
          tp1Dist: Number(tp1Dist.toFixed(2)),
          plannedRr: Number(plannedRr.toFixed(2)),
          poiPrice: Number(poiPrice.toFixed(2)),
          poiDistPts: Number(poiDistPts.toFixed(1)),
          poiDistAtr,
          mssType: cand.setupName.includes('BOS') ? 'BOS' : 'CHOCH',
          displacementPts: Number((dispPts * 10).toFixed(1)),
          displacementAtr: Number((dispPts / atr5m).toFixed(2)),
          wickToBodyRatio: Number((rejWick / Math.max(0.01, cBody)).toFixed(2)),
          wickToRangeRatio: Number((rejWick / cRange).toFixed(2)),
          bodyToAtr: Number((cBody / atr5m).toFixed(2)),
          rangeToAtr: Number((cRange / atr5m).toFixed(2)),
          rsi5m: Number((ind5m.rsi14 || 50).toFixed(1)),
          rsi15m: Number((ind15m.rsi14 || 50).toFixed(1)),
          is15mEmaAligned,
          is1hEmaAligned,
          h1Trend: ind1h.marketRegime || 'NEUTRAL',
          m15Trend: ind15m.marketRegime || 'NEUTRAL',
          distFrom15mEma50: Number((Math.abs(cand.entryPrice - ema50_15m) / atr5m).toFixed(2)),
          distFrom1hEma50: Number((Math.abs(cand.entryPrice - ema50_1h) / atr5m).toFixed(2)),
          isHtfAgreement: is15mEmaAligned === is1hEmaAligned,
          isContinuation: is15mEmaAligned,
          barsFromTouchToEntry: 1,
          barsFromBreakToEntry: 1,
          hasRetest: cRange < atr5m * 1.2,
          hasRejectionCandle: rejWick >= cBody * 1.2,
          hasLiquiditySweep: ind5m.liquiditySweepDetected === true || ind15m.liquiditySweepDetected === true,
          hasConsolidation: ind5m.compressionState?.isCompressed === true,
          outcome,
          realizedR,
          mfePts: Number((maxMfe * 10).toFixed(1)),
          mfeR: Number((maxMfe / slDist).toFixed(2)),
          maePts: Number((maxMae * 10).toFixed(1)),
          maeR: Number((maxMae / slDist).toFixed(2)),
          timeToMfeBars: barsToMfe,
          timeToSlBars: barsToOutcome,
        });
      } else if (isS11) {
        const level = cand.patternMetadata?.level ?? (cand.direction === 'BUY' ? ind15m.support : ind15m.resistance);
        const touches = cand.patternMetadata?.touches ?? 2;
        const penPts = cand.direction === 'BUY' ? Math.max(0, level - current5m.low) : Math.max(0, current5m.high - level);
        const rejPts = cand.direction === 'BUY' ? Math.max(0, current5m.close - current5m.low) : Math.max(0, current5m.high - current5m.close);
        const closeLoc = (current5m.close - current5m.low) / cRange;

        s11Records.push({
          timestamp: current5m.timestamp,
          dateStr: new Date(current5m.timestamp).toISOString().slice(0, 10),
          direction: cand.direction,
          entry: cand.entryPrice,
          stopLoss: cand.stopLoss,
          tp1: cand.tp1,
          slDist: Number(slDist.toFixed(2)),
          tp1Dist: Number(tp1Dist.toFixed(2)),
          plannedRr: Number(plannedRr.toFixed(2)),
          level: Number(level.toFixed(2)),
          touches,
          levelAgeBars: 36,
          levelStrength: cand.patternMetadata?.strength ?? 50,
          rejectionDepthPts: Number((rejPts * 10).toFixed(1)),
          penetrationDepthPts: Number((penPts * 10).toFixed(1)),
          penetrationAtr: Number((penPts / atr5m).toFixed(2)),
          wickToBodyRatio: Number((rejWick / Math.max(0.01, cBody)).toFixed(2)),
          wickToRangeRatio: Number((rejWick / cRange).toFixed(2)),
          bodySizePts: Number((cBody * 10).toFixed(1)),
          closeLocInCandle: Number(closeLoc.toFixed(2)),
          h1Trend: ind1h.marketRegime || 'NEUTRAL',
          m15Trend: ind15m.marketRegime || 'NEUTRAL',
          is15mEmaAligned,
          is1hEmaAligned,
          distFrom15mEma50: Number((Math.abs(cand.entryPrice - ema50_15m) / atr5m).toFixed(2)),
          distFrom1hEma50: Number((Math.abs(cand.entryPrice - ema50_1h) / atr5m).toFixed(2)),
          hasSweepBeforeRejection: penPts > 0.3 * atr5m,
          isLevelSwept: penPts > 0.5 * atr5m,
          barsAfterTouch: 1,
          hasImmediateRejection: rejWick >= cBody * 1.3,
          closedBackInside: cand.direction === 'BUY' ? current5m.close > level : current5m.close < level,
          outcome,
          realizedR,
          mfePts: Number((maxMfe * 10).toFixed(1)),
          mfeR: Number((maxMfe / slDist).toFixed(2)),
          maePts: Number((maxMae * 10).toFixed(1)),
          maeR: Number((maxMae / slDist).toFixed(2)),
          timeToMfeBars: barsToMfe,
          timeToSlBars: barsToOutcome,
        });
      }
    }
  }

  console.log(`[Forensics] Extracted ${s4Records.length} S4 candidates and ${s11Records.length} S11 candidates.\n`);

  // ====================================================
  // S4 WINNER VS LOSER FACTOR COMPARISON
  // ====================================================
  const s4Wins = s4Records.filter((s) => s.outcome === 'TP1' || s.outcome === 'TP2');
  const s4Losses = s4Records.filter((s) => s.outcome === 'SL');

  console.log('====================================================');
  console.log('S4 WINNER VS LOSER FACTOR COMPARISON');
  console.log('====================================================');
  console.log(`Metric                          | Winners (n=${s4Wins.length}) | Losers (n=${s4Losses.length}) | Winner Med | Loser Med`);
  console.log(`--------------------------------------------------------------------------------------------------`);
  
  const factorsToCompare: { name: string; key: keyof S4DetailRecord }[] = [
    { name: 'POI Distance (ATR)', key: 'poiDistAtr' },
    { name: 'Displacement (ATR)', key: 'displacementAtr' },
    { name: 'Wick / Body Ratio', key: 'wickToBodyRatio' },
    { name: '5M RSI', key: 'rsi5m' },
    { name: '15M RSI', key: 'rsi15m' },
    { name: '1H EMA50 Distance (ATR)', key: 'distFrom1hEma50' },
    { name: 'Planned R:R', key: 'plannedRr' },
  ];

  for (const f of factorsToCompare) {
    const winVals = s4Wins.map((s) => Number(s[f.key]));
    const lossVals = s4Losses.map((s) => Number(s[f.key]));
    const winAvg = mean(winVals);
    const lossAvg = mean(lossVals);
    const winMed = median(winVals);
    const lossMed = median(lossVals);

    console.log(`${f.name.padEnd(31)} | ${winAvg.toFixed(2).padStart(16)} | ${lossAvg.toFixed(2).padStart(15)} | ${winMed.toFixed(2).padStart(10)} | ${lossMed.toFixed(2).padStart(9)}`);
  }

  const s4Win1hAligned = s4Wins.filter((s) => s.is1hEmaAligned).length;
  const s4Loss1hAligned = s4Losses.filter((s) => s.is1hEmaAligned).length;
  console.log(`\n1H EMA Alignment Rate           | Winners: ${(s4Win1hAligned / Math.max(1, s4Wins.length) * 100).toFixed(1)}% | Losers: ${(s4Loss1hAligned / Math.max(1, s4Losses.length) * 100).toFixed(1)}%`);

  // ====================================================
  // S11 TOUCH COUNT & FACTOR BREAKDOWN
  // ====================================================
  console.log('\n====================================================');
  console.log('S11 TOUCH COUNT & FACTOR COMPARISON');
  console.log('====================================================');
  const touchGroups = [1, 2, 3, 4];
  for (const t of touchGroups) {
    const tGroup = t < 4 ? s11Records.filter((s) => s.touches === t) : s11Records.filter((s) => s.touches >= 4);
    const tWins = tGroup.filter((s) => s.outcome === 'TP1' || s.outcome === 'TP2').length;
    const tLosses = tGroup.filter((s) => s.outcome === 'SL').length;
    const tWinRate = tGroup.length > 0 ? (tWins / tGroup.length * 100).toFixed(1) : '0.0';
    const tSweepWins = tGroup.filter((s) => s.hasSweepBeforeRejection && (s.outcome === 'TP1' || s.outcome === 'TP2')).length;
    const tSweepCount = tGroup.filter((s) => s.hasSweepBeforeRejection).length;
    const tSweepRate = tSweepCount > 0 ? (tSweepWins / tSweepCount * 100).toFixed(1) : '0.0';

    console.log(`Touch ${t}${t >= 4 ? '+' : ' '} -> Count: ${String(tGroup.length).padStart(3)} | Wins: ${String(tWins).padStart(2)} | Losses: ${String(tLosses).padStart(3)} | WinRate: ${tWinRate}% | With Sweep WinRate: ${tSweepRate}% (${tSweepCount} samples)`);
  }

  // ====================================================
  // S4 & S11 COUNTERFACTUAL ANALYSES
  // ====================================================
  console.log('\n====================================================');
  console.log('ANALYTICAL COUNTERFACTUAL EXPERIMENTS (NO PROD CHANGES)');
  console.log('====================================================');

  // Counterfactual A: S4 requiring retest (cRange < 1.0 ATR)
  const s4RetestSigs = s4Records.filter((s) => s.hasRetest);
  const s4RetestWins = s4RetestSigs.filter((s) => s.outcome === 'TP1' || s.outcome === 'TP2').length;
  console.log(`Counterfactual A (S4 Retest)      : Sample=${s4RetestSigs.length}, Wins=${s4RetestWins}, WinRate=${s4RetestSigs.length > 0 ? (s4RetestWins / s4RetestSigs.length * 100).toFixed(1) : 0}%`);

  // Counterfactual B: S4 soft POI distance <= 1.8 ATR
  const s4SoftPoiSigs = s4Records.filter((s) => s.poiDistAtr <= 1.8);
  const s4SoftPoiWins = s4SoftPoiSigs.filter((s) => s.outcome === 'TP1' || s.outcome === 'TP2').length;
  console.log(`Counterfactual B (S4 POI <= 1.8R): Sample=${s4SoftPoiSigs.length}, Wins=${s4SoftPoiWins}, WinRate=${s4SoftPoiSigs.length > 0 ? (s4SoftPoiWins / s4SoftPoiSigs.length * 100).toFixed(1) : 0}%`);

  // Counterfactual D: S11 requiring Sweep + Closed Back Inside
  const s11SweepSigs = s11Records.filter((s) => s.hasSweepBeforeRejection && s.closedBackInside);
  const s11SweepWins = s11SweepSigs.filter((s) => s.outcome === 'TP1' || s.outcome === 'TP2').length;
  console.log(`Counterfactual D (S11 Sweep+In)  : Sample=${s11SweepSigs.length}, Wins=${s11SweepWins}, WinRate=${s11SweepSigs.length > 0 ? (s11SweepWins / s11SweepSigs.length * 100).toFixed(1) : 0}%`);

  // Counterfactual E: S11 Rejection Wick Ratio >= 1.5
  const s11WickSigs = s11Records.filter((s) => s.wickToBodyRatio >= 1.5);
  const s11WickWins = s11WickSigs.filter((s) => s.outcome === 'TP1' || s.outcome === 'TP2').length;
  console.log(`Counterfactual E (S11 RejWick>=1.5): Sample=${s11WickSigs.length}, Wins=${s11WickWins}, WinRate=${s11WickSigs.length > 0 ? (s11WickWins / s11WickSigs.length * 100).toFixed(1) : 0}%`);

  // ====================================================
  // TEMPORAL ROBUSTNESS (3 WINDOWS)
  // ====================================================
  const minTs = s4Records[0]?.timestamp || startTime;
  const maxTs = s4Records[s4Records.length - 1]?.timestamp || endTime;
  const timeThird = (maxTs - minTs) / 3;

  console.log('\n====================================================');
  console.log('TEMPORAL ROBUSTNESS (S4 & S11 ACROSS 3 WINDOWS)');
  console.log('====================================================');

  for (let w = 1; w <= 3; w++) {
    const wStart = minTs + (w - 1) * timeThird;
    const wEnd = minTs + w * timeThird;

    const wS4 = s4Records.filter((s) => s.timestamp >= wStart && s.timestamp < wEnd);
    const wS4Wins = wS4.filter((s) => s.outcome === 'TP1' || s.outcome === 'TP2').length;

    const wS11 = s11Records.filter((s) => s.timestamp >= wStart && s.timestamp < wEnd);
    const wS11Wins = wS11.filter((s) => s.outcome === 'TP1' || s.outcome === 'TP2').length;

    console.log(`Window ${w} -> S4: ${wS4.length} sigs (${wS4.length > 0 ? (wS4Wins / wS4.length * 100).toFixed(1) : 0}% WinRate) | S11: ${wS11.length} sigs (${wS11.length > 0 ? (wS11Wins / wS11.length * 100).toFixed(1) : 0}% WinRate)`);
  }
});
