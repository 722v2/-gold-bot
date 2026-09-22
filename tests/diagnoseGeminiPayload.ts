import { fetchCandles, fetchLiveQuote } from '../server/marketData.js';
import { analyzeTechnicals } from '../server/indicators.js';
import { partition5mCandles } from '../server/candleUtils.js';
import { generateMultiStrategyCandidates } from '../server/strategyEngine.js';
import { experienceMemoryEngine } from '../server/experienceMemory.js';
import { XAUUSD_TRADE_SIGNAL_JSON_SCHEMA } from '../server/geminiTrader.js';
import * as fs from 'fs';

async function runDiagnosis() {
  console.log('Fetching live MT5/Biquote data...');
  const asset = 'XAU/USD';
  const quote = await fetchLiveQuote(asset);
  const currentPrice = Number(quote.mid.toFixed(2));
  const liveSpread = typeof quote.spread === 'number' ? quote.spread : Number(quote.spread);

  const [candles1h, candles15m, candles5m, candles1m] = await Promise.all([
    fetchCandles(asset, '1h', 500),
    fetchCandles(asset, '15m', 500),
    fetchCandles(asset, '5m', 500),
    fetchCandles(asset, '1m', 100),
  ]);

  console.log(`Fetched: 1h=${candles1h.length}, 15m=${candles15m.length}, 5m=${candles5m.length}, 1m=${candles1m.length}`);

  const cycles = [];

  // Generate 20 consecutive historical cycles by stepping back through the 5m candles
  for (let offset = 19; offset >= 0; offset--) {
    const cycleIndex = 20 - offset;
    const sliceEnd5m = candles5m.length - offset;
    const current5mSlice = candles5m.slice(0, sliceEnd5m);
    const last5m = current5mSlice[current5mSlice.length - 1];
    const cycleTime = last5m.timestamp;
    const cyclePrice = last5m.close;

    // Filter corresponding 1h and 15m candles
    const current1hSlice = candles1h.filter(c => c.timestamp <= cycleTime);
    const current15mSlice = candles15m.filter(c => c.timestamp <= cycleTime);
    const current1mSlice = candles1m.filter(c => c.timestamp <= cycleTime);

    // Compute indicators
    const partition5m = partition5mCandles(current5mSlice, cycleTime);
    const closed5m = partition5m.isValid && partition5m.closedCandles.length > 0 ? partition5m.closedCandles : current5mSlice;

    const ind1h = analyzeTechnicals(current1hSlice);
    const ind15m = analyzeTechnicals(current15mSlice);
    const ind5m = analyzeTechnicals(closed5m);

    // Candidates
    const brokerSpecs = {
      accountBalance: 50,
      riskPercent: 15,
      contractSizeOz: 100,
      minimumLot: 0.01,
      maximumLot: 10,
      lotStep: 0.01,
      minGoldSlPoints: 40,
      maxGoldSlPoints: 50,
      minRr: 1.0,
      maxLoss: 5.0,
    };

    const candidatesContext = generateMultiStrategyCandidates({
      asset: 'XAU/USD',
      balance: 50,
      currentPrice: cyclePrice,
      indicators1h: ind1h,
      indicators15m: ind15m,
      indicators5m: ind5m,
      candles1h: current1hSlice,
      candles15m: current15mSlice,
      candles5m: current5mSlice,
      candles1m: current1mSlice,
      losingStreak: 0,
      brokerSpecs,
      activeTradeDirection: null,
      currentSpread: liveSpread,
    });

    // Exact TechnicalContext sent to Gemini
    const technicalContext: any = {
      asset: 'XAU/USD',
      balance: 50,
      currentPrice: cyclePrice,
      detectedCandidatesCount: candidatesContext.allCandidates.length,
      topCandidates: candidatesContext.allCandidates.slice(0, 3).map((c) => ({
        family: c.strategyFamily,
        name: c.setupName,
        direction: c.direction,
        orderType: c.orderType,
        entry: c.entry,
        stopLoss: c.stopLoss,
        slPoints: c.slPoints,
        tp1: c.tp1,
        tp1Rr: c.tp1Rr,
        confidence: c.confidence,
        score: c.score,
      })),
      h1: {
        trend: ind1h.structure,
        ema20: ind1h.ema20,
        ema50: ind1h.ema50,
        ema200: ind1h.ema200,
        rsi: ind1h.rsi14,
        range: `${ind1h.swingLow} - ${ind1h.swingHigh}`,
        bsl: ind1h.liquidityLevels?.buySideLiquidity || ind1h.swingHigh,
        ssl: ind1h.liquidityLevels?.sellSideLiquidity || ind1h.swingLow,
      },
      m15: {
        marketRegime: ind15m.marketRegime,
        regimeContext: ind15m.regimeContext,
        structure: ind15m.structure,
        structureShift: ind15m.structureShift || 'None',
        premiumDiscount: ind15m.premiumDiscountZone,
        orderBlock: ind15m.orderBlock ? `${ind15m.orderBlock.type} [${ind15m.orderBlock.low} - ${ind15m.orderBlock.high}]` : 'None',
        fvg: ind15m.fvg ? `${ind15m.fvg.type} [${ind15m.fvg.bottom} - ${ind15m.fvg.top}]` : 'None',
        support: ind15m.support,
        resistance: ind15m.resistance,
        bsl: ind15m.liquidityLevels?.buySideLiquidity || ind15m.swingHigh,
        ssl: ind15m.liquidityLevels?.sellSideLiquidity || ind15m.swingLow,
        sessionHigh: ind15m.swingHigh,
        sessionLow: ind15m.swingLow,
        sweep: ind15m.liquiditySweepDetected ? 'YES' : 'NO'
      },
      m5: {
        ema20: ind5m.ema20,
        ema50: ind5m.ema50,
        vwap: ind5m.vwap,
        rsi: ind5m.rsi14,
        macd: ind5m.macd,
        atr: ind5m.atr14,
        bollinger: ind5m.bollingerBands
      },
      recent5mCandlesSummary: current5mSlice.slice(-5).map(c => ({
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
        v: c.volume
      }))
    };

    const prompt = `حلل بيانات السوق والمرشحات الاستراتيجية المرفقة للذهب وقدم قرارك النهائي بصيغة JSON:\n${JSON.stringify(technicalContext, null, 2)}`;

    cycles.push({
      cycleIndex,
      cycleTime: new Date(cycleTime).toISOString(),
      cyclePrice,
      h1CandlesProvided: current1hSlice.length,
      m15CandlesProvided: current15mSlice.length,
      m5CandlesProvided: current5mSlice.length,
      latestH1Candle: current1hSlice[current1hSlice.length - 1],
      latestM15Candle: current15mSlice[current15mSlice.length - 1],
      latestM5Candle: last5m,
      calculatedIndicators: {
        h1: ind1h,
        m15: ind15m,
        m5: ind5m,
      },
      candidatesCount: candidatesContext.allCandidates.length,
      topCandidates: technicalContext.topCandidates,
      technicalContext,
      prompt,
    });
  }

  fs.writeFileSync('diagnostic_payload_20_cycles.json', JSON.stringify(cycles, null, 2));
  console.log('Saved 20 cycles diagnostic payload to diagnostic_payload_20_cycles.json');
}

runDiagnosis().catch(console.error);
