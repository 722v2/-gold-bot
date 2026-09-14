import { storage } from './storage.js';
import { fetchCandles, fetchLiveQuote } from './marketData.js';
import { analyzeTechnicals } from './indicators.js';
import { generateMultiStrategyCandidates, MultiStrategyEngineInput } from './strategyEngine.js';
import { Candle } from '../src/types.js';

async function auditRecentMove() {
  console.log('======================================================================');
  console.log('AUDIT INVESTIGATION: 4257 -> 4296.7 -> 4287 XAU/USD MOVE TELEMETRY');
  console.log('======================================================================\n');

  console.log('Waiting for storage hydration...');
  await new Promise((res) => setTimeout(res, 3000));

  const now = Date.now();
  const ninetyMinsAgo = now - 90 * 60 * 1000;

  const appSettings = storage.getSettings();
  console.log(`Settings: minConfidence=${appSettings.minimumConfidence || 75}%, minRr=${appSettings.minTp1RR || 1.5}R, maxSL=${appSettings.maxGoldSlPoints || 50}pt`);

  // 1. Production Firestore Scans
  console.log('\n--- 1. FIRESTORE RECENT SCANS (LAST 90 MIN) ---');
  const allScans = storage.getScans(500);
  const recentScans = allScans.filter((s) => s.timestamp >= ninetyMinsAgo);
  console.log(`Scans in last 90 minutes: ${recentScans.length}`);

  if (recentScans.length > 0) {
    console.log(`First scan in 90m window: ${recentScans[recentScans.length - 1].isoTime} @ $${recentScans[recentScans.length - 1].currentPrice}`);
    console.log(`Most recent scan:         ${recentScans[0].isoTime} @ $${recentScans[0].currentPrice}`);

    const signalsCount: Record<string, number> = {};
    const reasonsCount: Record<string, number> = {};

    for (const scan of recentScans) {
      signalsCount[scan.signal] = (signalsCount[scan.signal] || 0) + 1;
      const reason = scan.noTradeReason || scan.reasons?.[0] || 'N/A';
      reasonsCount[reason] = (reasonsCount[reason] || 0) + 1;
    }

    console.log('Stored Scan Signals:', signalsCount);
    console.log('Top Stored Telemetry Reasons:');
    for (const [r, c] of Object.entries(reasonsCount).slice(0, 10)) {
      console.log(` - [${c}x] ${r}`);
    }
  }

  // 2. Market Data
  console.log('\n--- 2. LIVE CANDLE FEED & RECENT MOVE ANALYSIS ---');
  const quote = await fetchLiveQuote('XAU/USD');
  console.log(`Live Quote: Mid=$${quote.mid}, Bid=$${quote.bid}, Ask=$${quote.ask}`);

  const [c1h, c15m, c5m, c1m] = await Promise.all([
    fetchCandles('XAU/USD', '1h', 200),
    fetchCandles('XAU/USD', '15m', 200),
    fetchCandles('XAU/USD', '5m', 200),
    fetchCandles('XAU/USD', '1m', 200),
  ]);

  console.log(`Fetched candles: 1H=${c1h.length}, 15M=${c15m.length}, 5M=${c5m.length}, 1M=${c1m.length}`);

  // Find range in last 90m
  const recent5m = c5m.filter((c) => c.timestamp >= ninetyMinsAgo);
  const eval5m = recent5m.length >= 6 ? recent5m : c5m.slice(-24);

  const low90m = Math.min(...eval5m.map((c) => c.low));
  const high90m = Math.max(...eval5m.map((c) => c.high));
  const lastClose = eval5m[eval5m.length - 1].close;

  console.log(`90-Min Price Range: Low=$${low90m.toFixed(2)} -> High=$${high90m.toFixed(2)} | Current Close=$${lastClose.toFixed(2)}`);

  // 3. Step-by-Step Candidate Engine Evaluation across 5M candles in the 90m move
  console.log('\n--- 3. STEP-BY-STEP STRATEGY CANDIDATE ENGINE EVALUATION (M5 CANDLES) ---');

  const startIndex = c5m.length - eval5m.length;
  let totalCandidatesCount = 0;

  for (let i = startIndex; i < c5m.length; i++) {
    const candle5mSlice = c5m.slice(0, i + 1);
    const curr5m = c5m[i];
    const currPrice = curr5m.close;
    const timeIso = new Date(curr5m.timestamp).toISOString();

    const candle15mSlice = c15m.filter((c) => c.timestamp <= curr5m.timestamp);
    const candle1hSlice = c1h.filter((c) => c.timestamp <= curr5m.timestamp);
    const candle1mSlice = c1m.filter((c) => c.timestamp <= curr5m.timestamp);

    const ind1h = analyzeTechnicals(candle1hSlice);
    const ind15m = analyzeTechnicals(candle15mSlice);
    const ind5m = analyzeTechnicals(candle5mSlice);

    const engineInput: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 100,
      currentPrice: currPrice,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h: candle1hSlice,
      candles15m: candle15mSlice,
      candles5m: candle5mSlice,
      candles1m: candle1mSlice,
      brokerSpecs: {
        minRr: appSettings.minTp1RR || 1.5,
        minGoldSlPoints: appSettings.minGoldSlPoints || 35,
        maxGoldSlPoints: appSettings.maxGoldSlPoints || 50,
      },
    };

    const result = generateMultiStrategyCandidates(engineInput);
    const cands = result.allCandidates || [];

    console.log(`\n[STEP ${i - startIndex + 1}/${eval5m.length}] Time: ${timeIso} | O=$${curr5m.open} H=$${curr5m.high} L=$${curr5m.low} C=$${curr5m.close}`);
    console.log(`  Regime: 15M=${ind15m.marketRegime} | 1H=${ind1h.marketRegime} | Zone=${ind15m.rangeLocation}`);
    console.log(`  Detected Candidates: ${cands.length}`);

    if (cands.length === 0) {
      console.log(`  Engine Status: NO_STRATEGY_PATTERN_DETECTED (Reason: ${result.noTradeReason || 'No setup pattern matched'})`);
    } else {
      totalCandidatesCount += cands.length;
      for (const cand of cands) {
        console.log(`  Candidate: ${cand.direction} | Setup: ${cand.setupName} (${cand.strategyFamily})`);
        console.log(`    Entry: $${cand.entry} | SL: $${cand.stopLoss} (${cand.slPoints}pt) | TP1: $${cand.tp1} (${cand.tp1Rr.toFixed(2)}R) | TP2: $${cand.tp2}`);
        console.log(`    Confidence: ${cand.confidence}% | StructScore: ${cand.rawScoreBreakdown?.structureScore || 'N/A'} | ExecScore: ${cand.executionQualityScore || 'N/A'}`);
        console.log(`    Freshness: ${cand.setupFreshness} | PullbackQuality: ${cand.pullbackQuality} | EntryTiming: ${cand.entryTiming} | TPRunway: ${cand.tpRunway}`);
      }
    }
  }

  // 4. Detailed 1M Micro-Structure Check around the ~4296.7 High / Rejection
  console.log('\n--- 4. 1M MICRO-STRUCTURE STEP AROUND 4296.7 HIGH & REJECTION ---');
  const recent1m = c1m.filter((c) => c.timestamp >= ninetyMinsAgo);
  console.log(`1M candles evaluated: ${recent1m.length}`);

  let sellCandidates1mCount = 0;
  let buyCandidates1mCount = 0;

  const start1mIndex = c1m.length - Math.min(60, c1m.length);

  for (let j = start1mIndex; j < c1m.length; j++) {
    const candle1mSlice = c1m.slice(0, j + 1);
    const curr1m = c1m[j];
    const timeIso = new Date(curr1m.timestamp).toISOString();

    const candle5mSlice = c5m.filter((c) => c.timestamp <= curr1m.timestamp);
    const candle15mSlice = c15m.filter((c) => c.timestamp <= curr1m.timestamp);
    const candle1hSlice = c1h.filter((c) => c.timestamp <= curr1m.timestamp);

    const ind1h = analyzeTechnicals(candle1hSlice);
    const ind15m = analyzeTechnicals(candle15mSlice);
    const ind5m = analyzeTechnicals(candle5mSlice);

    const engineInput: MultiStrategyEngineInput = {
      asset: 'XAU/USD',
      balance: 100,
      currentPrice: curr1m.close,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h: candle1hSlice,
      candles15m: candle15mSlice,
      candles5m: candle5mSlice,
      candles1m: candle1mSlice,
      brokerSpecs: {
        minRr: appSettings.minTp1RR || 1.5,
        minGoldSlPoints: appSettings.minGoldSlPoints || 35,
        maxGoldSlPoints: appSettings.maxGoldSlPoints || 50,
      },
    };

    const result = generateMultiStrategyCandidates(engineInput);
    const cands = result.allCandidates || [];

    for (const cand of cands) {
      if (cand.direction === 'SELL') sellCandidates1mCount++;
      if (cand.direction === 'BUY') buyCandidates1mCount++;
      console.log(`[1M CHECK at ${timeIso} @ $${curr1m.close}] Candidate=${cand.direction} ${cand.setupName} | Conf=${cand.confidence}% | TP1RR=${cand.tp1Rr.toFixed(2)}R | Runway=${cand.tpRunway}`);
    }
  }

  console.log(`\n1M Micro Checks Total: SELL candidates=${sellCandidates1mCount}, BUY candidates=${buyCandidates1mCount}`);

  console.log('\n======================================================================');
  console.log('AUDIT INVESTIGATION COMPLETE');
  console.log('======================================================================');
}

auditRecentMove().catch((e) => console.error(e));
