import OpenAI from 'openai';
import { AssetType, Candle, SignalDecision, TechnicalIndicators, TradeSignal } from '../src/types.js';
import { BrokerContractSpecs, evaluateTradeRisk } from './riskManager.js';
import { calculateDynamicTakeProfits } from './tpEngine.js';
import { generateMultiStrategyCandidates } from './strategyEngine.js';

let nvidiaClient: OpenAI | null = null;
let lastTestedApiKey: string | null = null;
let isKeyUnauthenticated: boolean = false;
let aiCooldownUntil: number = 0;
let isAiCallRunning: boolean = false;
let lastAnalyzed5mTimestamp: number = 0;
let lastAnalyzedPrice: number = 0;
let lastAnalyzedSignal: TradeSignal | null = null;

function getNvidiaClient(): OpenAI | null {
  const rawKey = process.env.NVIDIA_API_KEY;
  const apiKey = rawKey ? rawKey.trim() : '';

  // If no valid key or placeholder or too short
  if (!apiKey || apiKey === 'MY_NVIDIA_API_KEY' || apiKey.length < 10 || apiKey.includes('YOUR_API_KEY')) {
    return null;
  }

  // If key changed from previous, reset authentication status
  if (apiKey !== lastTestedApiKey) {
    lastTestedApiKey = apiKey;
    isKeyUnauthenticated = false;
    nvidiaClient = null;
  }

  // If previously determined as unauthenticated/invalid in this session, return null to use algorithmic screener
  if (isKeyUnauthenticated) {
    return null;
  }

  if (!nvidiaClient) {
    try {
      nvidiaClient = new OpenAI({
        apiKey,
        baseURL: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
        timeout: 10000,
        maxRetries: 0,
      });
    } catch {
      isKeyUnauthenticated = true;
      return null;
    }
  }
  return nvidiaClient;
}

export interface MarketAnalysisInput {
  asset: AssetType;
  balance: number;
  currentPrice: number;
  indicators1h: TechnicalIndicators;
  indicators15m: TechnicalIndicators;
  indicators5m: TechnicalIndicators;
  recent5mCandles: Candle[];
  recent1mCandles: Candle[];
  candles1h?: Candle[];
  candles15m?: Candle[];
  losingStreak: number;
  brokerSpecs?: Partial<BrokerContractSpecs>;
  activeTradeDirection?: 'BUY' | 'SELL' | null;
}

/**
 * High-performance Multi-Strategy Algorithmic Technical Engine
 * Evaluates 7 strategy families across structure, liquidity sweeps, OB/FVG,
 * Fibonacci OTE, and Price Action with weighted scoring.
 */
export function algorithmicScreening(input: MarketAnalysisInput): {
  decision: SignalDecision;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  confidence: number;
  timeframe: string;
  setup: string;
  mainReasons: string[];
  invalidation: string;
  noTradeReason?: string;
} {
  const candidateResult = generateMultiStrategyCandidates({
    asset: input.asset,
    balance: input.balance,
    currentPrice: input.currentPrice,
    indicators1h: input.indicators1h,
    indicators15m: input.indicators15m,
    indicators5m: input.indicators5m,
    candles1h: input.candles1h || [],
    candles15m: input.candles15m || [],
    candles5m: input.recent5mCandles || [],
    candles1m: input.recent1mCandles || [],
    losingStreak: input.losingStreak,
    brokerSpecs: input.brokerSpecs,
    activeTradeDirection: input.activeTradeDirection,
  });

  if (candidateResult.hasValidSignal && candidateResult.selectedCandidate) {
    const cand = candidateResult.selectedCandidate;
    const decision: SignalDecision = cand.direction === 'BUY'
      ? (cand.orderType === 'LIMIT' ? 'BUY LIMIT' : 'BUY NOW')
      : (cand.orderType === 'LIMIT' ? 'SELL LIMIT' : 'SELL NOW');

    return {
      decision,
      entry: cand.entry,
      stopLoss: cand.stopLoss,
      tp1: cand.tp1,
      tp2: cand.tp2,
      confidence: cand.confidence,
      timeframe: cand.timeframe,
      setup: cand.setupName,
      mainReasons: cand.mainReasons,
      invalidation: cand.invalidation,
    };
  }

  const minRr = input.brokerSpecs?.minRr ?? 1.5;
  return {
    decision: 'NO TRADE',
    entry: input.currentPrice,
    stopLoss: input.currentPrice,
    tp1: input.currentPrice,
    tp2: input.currentPrice,
    confidence: 50,
    timeframe: '15M / 5M',
    setup: 'None',
    mainReasons: [],
    invalidation: 'N/A',
    noTradeReason: candidateResult.noTradeReason || `السوق حالياً في نطاق تذبذب وتجميع عرضي في منتصف الرينج، أو لا يوجد هدف هيكلي واقعي يحقق نسبة عائد ${minRr}R دون حواجز معارضة. الأفضل انتظار تكوّن فرصة واضحة لحماية رأس المال.`
  };
}

/**
 * Main AI Analysis Engine using NVIDIA NIM DeepSeek V4 Pro with Multi-Strategy candidates
 */
export async function runAIAnalysis(input: MarketAnalysisInput): Promise<TradeSignal> {
  const { asset, balance, currentPrice, indicators1h, indicators15m, indicators5m, losingStreak } = input;

  // Run the multi-strategy candidate engine first
  const candidatesContext = generateMultiStrategyCandidates({
    asset: input.asset,
    balance: input.balance,
    currentPrice: input.currentPrice,
    indicators1h: input.indicators1h,
    indicators15m: input.indicators15m,
    indicators5m: input.indicators5m,
    candles1h: input.candles1h || [],
    candles15m: input.candles15m || [],
    candles5m: input.recent5mCandles || [],
    candles1m: input.recent1mCandles || [],
    losingStreak: input.losingStreak,
    brokerSpecs: input.brokerSpecs,
  });

  // 1. Check if in 429 rate-limit cooldown
  const now = Date.now();
  if (now < aiCooldownUntil) {
    const remainingSec = Math.ceil((aiCooldownUntil - now) / 1000);
    console.log(`[NVIDIA AI] In 429 rate-limit cooldown (${remainingSec}s remaining). Using multi-strategy candidate engine.`);
    const fallback = algorithmicScreening(input);
    return buildFinalSignal(fallback, input);
  }

  // 2. Prevent concurrent AI analysis requests
  if (isAiCallRunning) {
    console.log('[NVIDIA AI] Another AI analysis call is currently running. Using multi-strategy algorithmic engine.');
    const fallback = algorithmicScreening(input);
    return buildFinalSignal(fallback, input);
  }

  // 3. Avoid redundant AI calls if 5M candle has not closed and price is unchanged
  const latest5m = input.recent5mCandles[input.recent5mCandles.length - 1];
  const latest5mTime = latest5m?.timestamp || 0;
  if (
    lastAnalyzedSignal &&
    latest5mTime > 0 &&
    latest5mTime === lastAnalyzed5mTimestamp &&
    Math.abs(currentPrice - lastAnalyzedPrice) < 0.05
  ) {
    console.log('[NVIDIA AI] Market state and 5M candle unchanged. Re-using latest signal context.');
    return lastAnalyzedSignal;
  }

  const ai = getNvidiaClient();

  // If NVIDIA NIM client is unavailable, use the multi-strategy candidate engine directly
  if (!ai) {
    const screened = algorithmicScreening(input);
    return buildFinalSignal(screened, input);
  }

  const technicalContext = {
    asset,
    balance,
    currentPrice,
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
      trend: indicators1h.structure,
      ema20: indicators1h.ema20,
      ema50: indicators1h.ema50,
      ema200: indicators1h.ema200,
      rsi: indicators1h.rsi14,
      range: `${indicators1h.swingLow} - ${indicators1h.swingHigh}`,
      bsl: indicators1h.liquidityLevels?.buySideLiquidity || indicators1h.swingHigh,
      ssl: indicators1h.liquidityLevels?.sellSideLiquidity || indicators1h.swingLow,
    },
    m15: {
      marketRegime: indicators15m.marketRegime,
      regimeContext: indicators15m.regimeContext,
      structure: indicators15m.structure,
      structureShift: indicators15m.structureShift || 'None',
      premiumDiscount: indicators15m.premiumDiscountZone,
      orderBlock: indicators15m.orderBlock ? `${indicators15m.orderBlock.type} [${indicators15m.orderBlock.low} - ${indicators15m.orderBlock.high}]` : 'None',
      fvg: indicators15m.fvg ? `${indicators15m.fvg.type} [${indicators15m.fvg.bottom} - ${indicators15m.fvg.top}]` : 'None',
      support: indicators15m.support,
      resistance: indicators15m.resistance,
      bsl: indicators15m.liquidityLevels?.buySideLiquidity || indicators15m.swingHigh,
      ssl: indicators15m.liquidityLevels?.sellSideLiquidity || indicators15m.swingLow,
      sessionHigh: indicators15m.swingHigh,
      sessionLow: indicators15m.swingLow,
      sweep: indicators15m.liquiditySweepDetected ? 'YES' : 'NO'
    },
    m5: {
      ema20: indicators5m.ema20,
      ema50: indicators5m.ema50,
      vwap: indicators5m.vwap,
      rsi: indicators5m.rsi14,
      macd: indicators5m.macd,
      atr: indicators5m.atr14,
      bollinger: indicators5m.bollingerBands
    },
    recent5mCandlesSummary: input.recent5mCandles.slice(-5).map(c => ({
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
      v: c.volume
    }))
  };

  const minRr = input.brokerSpecs?.minRr ?? 1.5;

  const systemInstruction = `أنت AI Trading Agent فائق الذكاء ومحترف للغاية متخصص في تداول الذهب XAU/USD بنظام Scalping على حساب صغير (يبدأ من $10).
القواعد الصارمة لمحرك التداول والأهداف الربحية:
1. الهدف الأساسي: حماية رأس المال واختيار صفقات نوعية عالية الجودة بناءً على حالة السوق (Market Regime)، واستراتيجيات الهيكل (Structure)، والسيولة (Liquidity Sweeps)، وOrder Blocks، وFVG، وFibonacci OTE، واستمرار الترند (Trend Continuation)، واستراتيجيات النطاق (Range SFP Reversal & Breakout Expansion).
2. تقييم بيئة السوق (Market Regime Awareness):
   - STRONG_UPTREND / STRONG_DOWNTREND: ابحث عن فرص استمرار الترند مع التصحيح (Pullbacks).
   - إذا كان السعر ممتداً بشكل مفرط (isOverextended=true)، لا تطارد السعر بالدخول المباشر؛ بل اختر انتظار التصحيح السطحي أو اعطِ قرار NO TRADE مؤقت لحين انتهاء التمدد.
   - NORMAL_RANGE / VOLATILE_RANGE: النطاق العرضي لا يعني تلقائياً NO TRADE؛ ابحث عن سحب السيولة عند أطراف الرينج (Range High/Low sweeps & SFP) أو الكسر التوسعي الحقيقي (Breakout Expansion)، وتجنب الدخول العشوائي في منتصف النطاق (Equilibrium).
   - TRANSITION: يتطلب تأكيد كسر الهيكل واستقراره قبل اتخاذ اتجاه جديد.
   - UNCLEAR: لا توجد ميزة إحصائية واضحة؛ اختر NO TRADE لحماية رأس المال.
3. القرارات المسموحة فقط: "BUY NOW" أو "SELL NOW" أو "BUY LIMIT" أو "SELL LIMIT" أو "NO TRADE". قرار واحد حصرياً.
4. حساب وقف الخسارة (SL):
   - للذهب: 1 point = 0.10$ حركة سعر (abs(Entry - SL) / 0.10).
   - نطاق الـStop Loss الفني المسموح به هو من 35 إلى 65 نقطة.
5. قواعد محرك الأهداف الهيكلية والامتدادية (Dynamic TP Engine Rules):
   - الهدف الأول (TP1): يجب أن يحقق نسبة عائد لا تقل عن ${minRr}R (حيث R = مسافة الـSL)، سواء تم تحديده من مستويات هيكلية سابقة أو امتدادات فيبوناتشي / ATR في حال كسر القمم/القيعان التاريخية.
   - الهدف الثاني (TP2): 2.5R أو 3R فما فوق لاستهداف سيولة هيكلية أو امتدادية أبعد.
   - إذا تم توفير مرشحات استراتيجية صالحة في "topCandidates"، قم بتقييمها واختيار الأقوى أو تأكيدها.
6. الثقة (Confidence): من 70 إلى 96 للصفقات الصالحة.
7. في حال عدم وجود فرصة حقيقية أو تذبذب في منتصف الرينج، اختر "NO TRADE" واذكر السبب بالتفصيل.`;

  isAiCallRunning = true;
  try {
    const prompt = `حلل بيانات السوق والمرشحات الاستراتيجية المرفقة للذهب وقدم قرارك النهائي بصيغة JSON:\n${JSON.stringify(technicalContext, null, 2)}`;

    const model = process.env.NVIDIA_MODEL || 'deepseek-ai/deepseek-v4-pro-0813';
    const completion = await ai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 1024,
      response_format: { type: 'json_object' }
    }, {
      timeout: 10000,
    });

    const responseContent = completion.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(responseContent.trim());
    if (!parsed.signal) {
      throw new Error('Invalid response format from NVIDIA DeepSeek model');
    }

    const decision = String(parsed.signal).toUpperCase() as SignalDecision;
    const finalSignal = buildFinalSignal({
      decision: ['BUY NOW', 'SELL NOW', 'BUY LIMIT', 'SELL LIMIT', 'NO TRADE'].includes(decision) ? decision : 'NO TRADE',
      entry: Number(parsed.entry || currentPrice),
      stopLoss: Number(parsed.stopLoss || currentPrice),
      tp1: Number(parsed.tp1 || currentPrice),
      tp2: Number(parsed.tp2 || currentPrice),
      confidence: Math.min(100, Math.max(0, Number(parsed.confidence || 75))),
      timeframe: parsed.timeframe || '15M / 5M',
      setup: parsed.setup || 'Market Structure Setup',
      mainReasons: Array.isArray(parsed.mainReasons) && parsed.mainReasons.length > 0 ? parsed.mainReasons : ['تأكيد الهيكل الفني وسلوك السعر.'],
      invalidation: parsed.invalidation || `كسر منطقة وقف الخسارة`,
      noTradeReason: parsed.noTradeReason
    }, input);

    lastAnalyzed5mTimestamp = latest5mTime;
    lastAnalyzedPrice = currentPrice;
    lastAnalyzedSignal = finalSignal;

    return finalSignal;

  } catch (error: any) {
    const errorStr = String(error?.message || error || '');
    const status = error?.status || error?.response?.status;
    const is429RateLimit =
      status === 429 ||
      errorStr.includes('429') ||
      errorStr.includes('Too Many Requests') ||
      errorStr.includes('rate_limit') ||
      errorStr.includes('quota');
    const isAuthError =
      status === 401 ||
      errorStr.includes('401') ||
      errorStr.includes('UNAUTHENTICATED') ||
      errorStr.includes('API_KEY_INVALID') ||
      errorStr.includes('invalid_api_key') ||
      errorStr.includes('invalid authentication credentials');
    const isTimeout =
      errorStr.includes('timed out') ||
      errorStr.includes('timeout') ||
      errorStr.includes('ETIMEDOUT') ||
      errorStr.includes('ECONNABORTED');

    if (is429RateLimit) {
      aiCooldownUntil = Date.now() + 3 * 60 * 1000; // 3 minutes cooldown
      console.warn(`[NVIDIA AI] HTTP 429 Too Many Requests received. Activating 3-minute cooldown until ${new Date(aiCooldownUntil).toLocaleTimeString()}. Using multi-strategy candidate engine.`);
    } else if (isAuthError) {
      isKeyUnauthenticated = true;
      console.warn('[NVIDIA AI] NVIDIA API key is unauthenticated. Using multi-strategy candidate engine.');
    } else if (isTimeout) {
      console.warn('[NVIDIA AI] API request timed out. Smoothly falling back to multi-strategy candidate engine.');
    } else {
      console.warn('[NVIDIA AI] API note, falling back to multi-strategy engine:', error?.message || error);
    }

    const fallback = algorithmicScreening(input);
    return buildFinalSignal(fallback, input);
  } finally {
    isAiCallRunning = false;
  }
}

/**
 * Builds and risk-validates the final TradeSignal object
 */
function buildFinalSignal(
  raw: {
    decision: SignalDecision;
    entry: number;
    stopLoss: number;
    tp1: number;
    tp2: number;
    confidence: number;
    timeframe: string;
    setup: string;
    mainReasons: string[];
    invalidation: string;
    noTradeReason?: string;
  },
  input: MarketAnalysisInput
): TradeSignal {
  const { asset, balance, currentPrice, losingStreak, brokerSpecs } = input;
  const minRr = brokerSpecs?.minRr ?? 1.5;
  const id = `sig_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  if (raw.decision === 'NO TRADE') {
    return {
      id,
      timestamp: Date.now(),
      asset,
      signal: 'NO TRADE',
      currentPrice,
      entry: currentPrice,
      stopLoss: currentPrice,
      slPoints: 0,
      tp1: currentPrice,
      tp1Points: 0,
      tp1Rr: 0,
      tp1RrString: '1:0',
      tp2: currentPrice,
      tp2Points: 0,
      tp2Rr: 0,
      tp2RrString: '1:0',
      primaryTarget: 'TP1',
      rr: '1:0',
      rrRatio: 0,
      riskPercent: 0,
      riskAmount: 0,
      potentialProfit: 0,
      potentialLoss: 0,
      recommendedLotSize: 0,
      confidence: raw.confidence,
      timeframe: raw.timeframe,
      setup: 'No Setup',
      mainReasons: [],
      invalidation: 'N/A',
      noTradeReason: raw.noTradeReason || `عدم وجود فرصة واضحة بنسبة عائد تفوق 1:${minRr} مع وقف خسارة مناسب.`
    };
  }

  const isBuy = raw.decision.includes('BUY');
  const dynamicTp = calculateDynamicTakeProfits({
    direction: isBuy ? 'BUY' : 'SELL',
    entry: raw.entry,
    stopLoss: raw.stopLoss,
    asset,
    indicators1h: input.indicators1h,
    indicators15m: input.indicators15m,
    indicators5m: input.indicators5m,
    candles1h: input.candles1h,
    candles15m: input.candles15m,
    candles5m: input.recent5mCandles,
    minRr,
  });

  const targetTp1 = dynamicTp.valid ? dynamicTp.tp1 : raw.tp1;
  const targetTp2 = dynamicTp.valid ? dynamicTp.tp2 : raw.tp2;

  // Evaluate risk strictly with configurable broker specs and intelligent executability optimization
  const riskEval = evaluateTradeRisk({
    balance,
    entry: raw.entry,
    stopLoss: raw.stopLoss,
    tp1: targetTp1,
    tp2: targetTp2,
    confidence: raw.confidence,
    isVeryStrongSetup: raw.confidence >= 85,
    losingStreak,
    asset,
    brokerSpecs,
    direction: isBuy ? 'BUY' : 'SELL',
    allowExecutabilityOptimization: true,
  });

  if (!riskEval.valid) {
    return {
      id,
      timestamp: Date.now(),
      asset,
      signal: 'NO TRADE',
      currentPrice,
      entry: raw.entry,
      stopLoss: raw.stopLoss,
      slPoints: riskEval.slPoints,
      tp1: targetTp1,
      tp1Points: riskEval.tp1Points,
      tp1Rr: riskEval.tp1Rr,
      tp1RrString: riskEval.tp1RrString,
      tp2: targetTp2,
      tp2Points: riskEval.tp2Points,
      tp2Rr: riskEval.tp2Rr,
      tp2RrString: riskEval.tp2RrString,
      primaryTarget: riskEval.primaryTarget,
      rr: riskEval.rrString,
      rrRatio: riskEval.rrRatio,
      riskPercent: 0,
      riskAmount: 0,
      potentialProfit: 0,
      potentialLoss: 0,
      recommendedLotSize: 0,
      confidence: raw.confidence,
      timeframe: raw.timeframe,
      setup: raw.setup,
      mainReasons: [],
      invalidation: 'N/A',
      noTradeReason: riskEval.reason || 'الـSetup لا يحقق معايير إدارة المخاطر (RR >= 1.5 أو SL المناسب).'
    };
  }

  const finalEntry = riskEval.adjustedEntry ?? raw.entry;
  const finalStopLoss = riskEval.adjustedStopLoss ?? raw.stopLoss;
  const finalTp1 = riskEval.adjustedTp1 ?? targetTp1;
  const finalTp2 = riskEval.adjustedTp2 ?? targetTp2;

  const reasonsList = [...raw.mainReasons];
  if (riskEval.optimizationNote) {
    reasonsList.unshift(riskEval.optimizationNote);
  }
  reasonsList.push(`الهدف الأول TP1 (${finalTp1}) يستهدف ${dynamicTp.tp1TargetName || 'المستوى الهيكلي'} بنسبة عائد ${riskEval.tp1RrString} (${riskEval.tp1Points} نقطة ≥ ${minRr}R).`);
  if (finalTp2) {
    reasonsList.push(`الهدف الثاني TP2 (${finalTp2}) يستهدف ${dynamicTp.tp2TargetName || 'الامتداد الهيكلي'} بنسبة عائد ${riskEval.tp2RrString} (${riskEval.tp2Points} نقطة).`);
  }

  return {
    id,
    timestamp: Date.now(),
    asset,
    signal: raw.decision,
    currentPrice,
    entry: finalEntry,
    stopLoss: finalStopLoss,
    slPoints: riskEval.slPoints,
    tp1: finalTp1,
    tp1Points: riskEval.tp1Points,
    tp1Rr: riskEval.tp1Rr,
    tp1RrString: riskEval.tp1RrString,
    tp2: finalTp2,
    tp2Points: riskEval.tp2Points,
    tp2Rr: riskEval.tp2Rr,
    tp2RrString: riskEval.tp2RrString,
    primaryTarget: riskEval.primaryTarget,
    rr: riskEval.rrString,
    rrRatio: riskEval.rrRatio,
    riskPercent: riskEval.riskPercent,
    riskAmount: riskEval.riskAmount,
    potentialProfit: riskEval.potentialProfit,
    potentialLoss: riskEval.potentialLoss,
    recommendedLotSize: riskEval.recommendedLotSize,
    standardLot: riskEval.positionSizing.standardLotSize,
    miniLot: riskEval.positionSizing.miniLotSize,
    microLot: riskEval.positionSizing.microLotSize,
    isExecutable: riskEval.positionSizing.isExecutable,
    nonExecutableReason: riskEval.positionSizing.nonExecutableReason,
    positionSizing: riskEval.positionSizing,
    confidence: raw.confidence,
    timeframe: raw.timeframe,
    setup: raw.setup,
    mainReasons: reasonsList.slice(0, 4),
    invalidation: raw.invalidation
  };
}
