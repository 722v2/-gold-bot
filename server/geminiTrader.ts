import OpenAI from 'openai';
import { AssetType, Candle, SignalDecision, TechnicalIndicators, TradeSignal } from '../src/types.js';
import { BrokerContractSpecs, evaluateTradeRisk } from './riskManager.js';
import { calculateDynamicTakeProfits } from './tpEngine.js';
import { generateMultiStrategyCandidates, SetupCandidate } from './strategyEngine.js';
import { experienceMemoryEngine } from './experienceMemory.js';
import { validateTradeSignalCandidate, inferStrategyFamily } from './tradeQualityEngine.js';
import { partition1hCandles, partition15mCandles, partition5mCandles, partition1mCandles } from './candleUtils.js';

export const XAUUSD_TRADE_SIGNAL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    signal: {
      type: 'string',
      enum: ['BUY NOW', 'SELL NOW', 'BUY LIMIT', 'SELL LIMIT', 'NO TRADE'],
      description: 'القرار النهائي للصفقة'
    },
    entry: {
      type: 'number',
      description: 'سعر الدخول المقترح'
    },
    stopLoss: {
      type: 'number',
      description: 'مستوى وقف الخسارة الفني'
    },
    tp1: {
      type: 'number',
      description: 'الهدف الربحي الهيكلي الأول'
    },
    tp2: {
      type: 'number',
      description: 'الهدف الربحي الهيكلي الثاني إن وجد أو 0'
    },
    confidence: {
      type: 'number',
      description: 'نسبة الثقة الفنية من 0 إلى 100'
    },
    timeframe: {
      type: 'string',
      description: 'الفريم الزمني المعتمد للنموذج'
    },
    setup: {
      type: 'string',
      description: 'اسم النموذج أو الاستراتيجية المكتشفة'
    },
    mainReasons: {
      type: 'array',
      items: { type: 'string' },
      description: 'قائمة الأسباب الفنية للقرار'
    },
    invalidation: {
      type: 'string',
      description: 'شروط إلغاء الصفقة فنياً'
    },
    noTradeReason: {
      type: 'string',
      description: 'سبب عدم التداول في حال اختيار NO TRADE'
    }
  },
  required: ['signal', 'confidence', 'setup'],
  additionalProperties: false
} as const;

export function parseAndValidateAiResponse(rawContent: any): {
  signal: SignalDecision;
  entry?: number;
  stopLoss?: number;
  tp1?: number;
  tp2?: number;
  confidence: number;
  timeframe?: string;
  setup: string;
  mainReasons?: string[];
  invalidation?: string;
  noTradeReason?: string;
} {
  let parsed: any = null;
  if (typeof rawContent === 'object' && rawContent !== null) {
    parsed = rawContent;
  } else if (typeof rawContent === 'string') {
    const trimmed = rawContent.trim();
    // Strip potential markdown code block wrappers if any model outputs them
    const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } else {
    throw new Error('Non-parseable response content received from AI');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI response is not a valid JSON object');
  }

  if (!parsed.signal || typeof parsed.signal !== 'string') {
    throw new Error('Missing or invalid "signal" field in AI response');
  }

  const upperSignal = parsed.signal.toUpperCase().trim();
  const validSignals: SignalDecision[] = ['BUY NOW', 'SELL NOW', 'BUY LIMIT', 'SELL LIMIT', 'NO TRADE'];
  if (!validSignals.includes(upperSignal as SignalDecision)) {
    throw new Error(`Invalid signal value "${parsed.signal}" in AI response`);
  }

  if (parsed.confidence !== undefined && (typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 100)) {
    throw new Error('Invalid "confidence" field in AI response (must be a finite number between 0 and 100)');
  }

  if (parsed.setup !== undefined && typeof parsed.setup !== 'string') {
    throw new Error('Invalid "setup" field in AI response (must be a string)');
  }

  const normalizedConfidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
    ? Math.min(100, Math.max(0, parsed.confidence))
    : 75;

  return {
    signal: upperSignal as SignalDecision,
    entry: typeof parsed.entry === 'number' && Number.isFinite(parsed.entry) ? parsed.entry : undefined,
    stopLoss: typeof parsed.stopLoss === 'number' && Number.isFinite(parsed.stopLoss) ? parsed.stopLoss : undefined,
    tp1: typeof parsed.tp1 === 'number' && Number.isFinite(parsed.tp1) ? parsed.tp1 : undefined,
    tp2: typeof parsed.tp2 === 'number' && Number.isFinite(parsed.tp2) ? parsed.tp2 : undefined,
    confidence: normalizedConfidence,
    timeframe: typeof parsed.timeframe === 'string' ? parsed.timeframe : '15M / 5M',
    setup: typeof parsed.setup === 'string' && parsed.setup.trim().length > 0 ? parsed.setup : 'AI Market Structure Setup',
    mainReasons: Array.isArray(parsed.mainReasons) ? parsed.mainReasons.map((r: any) => String(r)) : undefined,
    invalidation: typeof parsed.invalidation === 'string' ? parsed.invalidation : undefined,
    noTradeReason: typeof parsed.noTradeReason === 'string' ? parsed.noTradeReason : undefined,
  };
}
export interface AiProviderConfig {
  provider: 'openrouter' | 'nvidia' | 'none';
  apiKey: string;
  baseURL: string;
  model: string;
}

export function resolveAiProviderConfig(): AiProviderConfig {
  const isKeyValid = (key?: string | null): boolean => {
    if (!key) return false;
    const trimmed = key.trim();
    return (
      trimmed.length >= 10 &&
      trimmed !== 'MY_OPENROUTER_API_KEY' &&
      trimmed !== 'MY_NVIDIA_API_KEY' &&
      !trimmed.includes('YOUR_API_KEY')
    );
  };

  const requestedProvider = (process.env.AI_PROVIDER || process.env.PROVIDER || '').trim().toLowerCase();
  const openRouterKey = (process.env.OPENROUTER_API_KEY || '').trim();
  const nvidiaKey = (process.env.NVIDIA_API_KEY || '').trim();

  if (requestedProvider === 'openrouter') {
    if (isKeyValid(openRouterKey)) {
      return {
        provider: 'openrouter',
        apiKey: openRouterKey,
        baseURL: (process.env.OPENROUTER_BASE_URL || '').trim() || 'https://openrouter.ai/api/v1',
        model: (process.env.OPENROUTER_MODEL || '').trim() || 'google/gemini-2.5-flash-lite',
      };
    }
    return { provider: 'none', apiKey: '', baseURL: '', model: '' };
  }

  if (requestedProvider === 'nvidia') {
    if (isKeyValid(nvidiaKey)) {
      return {
        provider: 'nvidia',
        apiKey: nvidiaKey,
        baseURL: (process.env.NVIDIA_BASE_URL || '').trim() || 'https://integrate.api.nvidia.com/v1',
        model: (process.env.NVIDIA_MODEL || '').trim() || 'deepseek-ai/deepseek-v4-flash-0731',
      };
    }
    return { provider: 'none', apiKey: '', baseURL: '', model: '' };
  }

  // Auto-detection mode
  if (isKeyValid(openRouterKey)) {
    return {
      provider: 'openrouter',
      apiKey: openRouterKey,
      baseURL: (process.env.OPENROUTER_BASE_URL || '').trim() || 'https://openrouter.ai/api/v1',
      model: (process.env.OPENROUTER_MODEL || '').trim() || 'google/gemini-2.5-flash-lite',
    };
  }

  if (isKeyValid(nvidiaKey)) {
    return {
      provider: 'nvidia',
      apiKey: nvidiaKey,
      baseURL: (process.env.NVIDIA_BASE_URL || '').trim() || 'https://integrate.api.nvidia.com/v1',
      model: (process.env.NVIDIA_MODEL || '').trim() || 'deepseek-ai/deepseek-v4-flash-0731',
    };
  }

  return {
    provider: 'none',
    apiKey: '',
    baseURL: '',
    model: '',
  };
}

let lastTestedProviderKey: string | null = null;
let isKeyUnauthenticated: boolean = false;
let aiCooldownUntil: number = 0;
let isAiCallRunning: boolean = false;
let lastAnalyzed5mTimestamp: number = 0;
let lastAnalyzedPrice: number = 0;
let lastAnalyzedSignal: TradeSignal | null = null;
let activeAiClientInstance: OpenAI | null = null;

export function getActiveAiClient(): { client: OpenAI; config: AiProviderConfig } | null {
  const config = resolveAiProviderConfig();
  if (config.provider === 'none' || !config.apiKey) {
    return null;
  }

  const cacheKey = `${config.provider}:${config.apiKey}:${config.baseURL}`;
  if (cacheKey !== lastTestedProviderKey) {
    lastTestedProviderKey = cacheKey;
    isKeyUnauthenticated = false;
    activeAiClientInstance = null;
  }

  if (isKeyUnauthenticated) {
    return null;
  }

  if (!activeAiClientInstance) {
    try {
      activeAiClientInstance = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        timeout: 10000,
        maxRetries: 0,
      });
    } catch {
      isKeyUnauthenticated = true;
      return null;
    }
  }

  return { client: activeAiClientInstance, config };
}

export function getOpenRouterClient(): OpenAI | null {
  const active = getActiveAiClient();
  return active ? active.client : null;
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
  currentSpread?: number;
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
    currentSpread: input.currentSpread,
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

  const minRr = input.brokerSpecs?.minRr ?? 1.0;
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
 * Main AI Analysis Engine using OpenRouter Gemini 2.5 Flash Lite with Multi-Strategy candidates
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
    activeTradeDirection: input.activeTradeDirection,
    currentSpread: input.currentSpread,
  });

  // 1. Check if in 429 rate-limit cooldown
  const now = Date.now();
  if (now < aiCooldownUntil) {
    const remainingSec = Math.ceil((aiCooldownUntil - now) / 1000);
    console.log(`[AI Engine] In 429 rate-limit cooldown (${remainingSec}s remaining). Using multi-strategy candidate engine.`);
    const fallback = algorithmicScreening(input);
    return buildFinalSignal(fallback, input);
  }

  // 2. Prevent concurrent AI analysis requests
  if (isAiCallRunning) {
    console.log('[AI Engine] Another AI analysis call is currently running. Using multi-strategy algorithmic engine.');
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
    console.log('[AI Engine] Market state and 5M candle unchanged. Re-using latest signal context.');
    return lastAnalyzedSignal;
  }

  const activeAi = getActiveAiClient();

  // If AI client is unavailable, use the multi-strategy candidate engine directly
  if (!activeAi) {
    const screened = algorithmicScreening(input);
    return buildFinalSignal(screened, input);
  }
  const { client: ai, config: activeConfig } = activeAi;

  // Look up relevant historical experience for top candidate if available
  let historicalExperienceContext: any = null;
  const topCandidate = candidatesContext.selectedCandidate || candidatesContext.allCandidates[0];
  if (topCandidate) {
    try {
      const prospectiveFactors = experienceMemoryEngine.normalizeFactors({
        direction: topCandidate.direction,
        setupFamily: topCandidate.strategyFamily || topCandidate.setupName,
        indicators1h,
        indicators15m,
        indicators5m,
      });
      const prospectiveKey = experienceMemoryEngine.generateCombinationKey(prospectiveFactors);
      historicalExperienceContext = experienceMemoryEngine.getExperienceContext({
        combinationKey: prospectiveKey,
        factors: prospectiveFactors,
      }, Date.now());
    } catch (expErr) {
      console.warn('[AI Engine] Non-blocking experience lookup error:', expErr);
    }
  }

  // Partition candles by timeframe to ensure Gemini receives ONLY confirmed closed candles
  const closedH1 = partition1hCandles(input.candles1h || []).closedCandles;
  const closedM15 = partition15mCandles(input.candles15m || []).closedCandles;
  const closedM5 = partition5mCandles(input.recent5mCandles || []).closedCandles;
  const closedM1 = partition1mCandles(input.recent1mCandles || []).closedCandles;

  const validClosedH1 = closedH1;
  const validClosedM15 = closedM15;
  const validClosedM5 = closedM5;
  const validClosedM1 = closedM1;

  const technicalContext: any = {
    asset,
    balance,
    currentPrice,
    marketDataIntegrity: {
      isClosedCandlesOnly: true,
      h1CandlesCount: validClosedH1.slice(-10).length,
      m15CandlesCount: validClosedM15.slice(-20).length,
      m5CandlesCount: validClosedM5.slice(-30).length,
      m1CandlesCount: validClosedM1.slice(-15).length,
    },
    topCandidatesGuidance: {
      role: 'ADVISORY_ONLY',
      note: 'topCandidates contains pre-calculated algorithmic suggestions for advisory reference only. topCandidates is NOT a prerequisite. detectedCandidatesCount = 0 does NOT mean NO TRADE. You MUST independently discover valid setups from raw multi-timeframe price action and calculated market structure.'
    },
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
    ...(historicalExperienceContext ? { historicalTradingExperience: historicalExperienceContext } : {}),
    h1: {
      macroTrend: indicators1h.structure,
      swingHigh: indicators1h.swingHigh,
      swingLow: indicators1h.swingLow,
      support: indicators1h.support,
      resistance: indicators1h.resistance,
      bsl: indicators1h.liquidityLevels?.buySideLiquidity || indicators1h.swingHigh,
      ssl: indicators1h.liquidityLevels?.sellSideLiquidity || indicators1h.swingLow,
      ema20: indicators1h.ema20,
      ema50: indicators1h.ema50,
      ema200: indicators1h.ema200,
      rsi: indicators1h.rsi14,
      atr: indicators1h.atr14,
      closedCandlesCount: validClosedH1.slice(-10).length,
      candles: validClosedH1.slice(-10).map((c) => ({
        t: c.timestamp,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
        v: c.volume
      }))
    },
    m15: {
      marketRegime: indicators15m.marketRegime,
      regimeContext: indicators15m.regimeContext,
      structure: indicators15m.structure,
      structureShift: indicators15m.structureShift || 'None',
      swingHigh: indicators15m.swingHigh,
      swingLow: indicators15m.swingLow,
      support: indicators15m.support,
      resistance: indicators15m.resistance,
      bsl: indicators15m.liquidityLevels?.buySideLiquidity || indicators15m.swingHigh,
      ssl: indicators15m.liquidityLevels?.sellSideLiquidity || indicators15m.swingLow,
      sessionHigh: indicators15m.swingHigh,
      sessionLow: indicators15m.swingLow,
      sweep: indicators15m.liquiditySweepDetected ? 'YES' : 'NO',
      premiumDiscountZone: indicators15m.premiumDiscountZone,
      orderBlock: indicators15m.orderBlock ? `${indicators15m.orderBlock.type} [${indicators15m.orderBlock.low} - ${indicators15m.orderBlock.high}]` : 'None',
      fvg: indicators15m.fvg ? `${indicators15m.fvg.type} [${indicators15m.fvg.bottom} - ${indicators15m.fvg.top}]` : 'None',
      ema20: indicators15m.ema20,
      ema50: indicators15m.ema50,
      vwap: indicators15m.vwap,
      rsi: indicators15m.rsi14,
      macd: indicators15m.macd,
      atr: indicators15m.atr14,
      bollinger: indicators15m.bollingerBands,
      closedCandlesCount: validClosedM15.slice(-20).length,
      candles: validClosedM15.slice(-20).map((c) => ({
        t: c.timestamp,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
        v: c.volume
      }))
    },
    m5: {
      structure: indicators5m.structure,
      structureShift: indicators5m.structureShift || 'None',
      localSwingHigh: indicators5m.swingHigh,
      localSwingLow: indicators5m.swingLow,
      localSupport: indicators5m.support,
      localResistance: indicators5m.resistance,
      localOrderBlock: indicators5m.orderBlock ? `${indicators5m.orderBlock.type} [${indicators5m.orderBlock.low} - ${indicators5m.orderBlock.high}]` : 'None',
      localFvg: indicators5m.fvg ? `${indicators5m.fvg.type} [${indicators5m.fvg.bottom} - ${indicators5m.fvg.top}]` : 'None',
      sweep: indicators5m.liquiditySweepDetected ? 'YES' : 'NO',
      currentPoi: indicators5m.orderBlock ? `OB_${indicators5m.orderBlock.type}` : (indicators5m.fvg ? `FVG_${indicators5m.fvg.type}` : 'None'),
      ema20: indicators5m.ema20,
      ema50: indicators5m.ema50,
      vwap: indicators5m.vwap,
      rsi: indicators5m.rsi14,
      macd: indicators5m.macd,
      atr: indicators5m.atr14,
      bollinger: indicators5m.bollingerBands,
      closedCandlesCount: validClosedM5.slice(-30).length,
      candles: validClosedM5.slice(-30).map((c) => ({
        t: c.timestamp,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
        v: c.volume
      }))
    },
    m1: {
      role: 'ENTRY_REFINEMENT_ONLY',
      note: 'Use 1M closed candles only for entry timing, local rejection wicks, and immediate price action. Do not allow 1M alone to override H1/M15 structure.',
      closedCandlesCount: validClosedM1.slice(-15).length,
      candles: validClosedM1.slice(-15).map((c) => ({
        t: c.timestamp,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
        v: c.volume
      }))
    }
  };

  const systemInstruction = `أنت محرك ذكاء اصطناعي مستقل ومحترف للغاية لاكتشاف وتحليل صفقات الذهب (Autonomous XAU/USD Market Setup Discovery & Analysis Engine) بنظام Scalping على حساب صغير (يبدأ من $10).

دورك وصلاحياتك الأساسية:
1. الاستقلالية التامة في اكتشاف الفرص (Autonomous Opportunity Discovery):
   - حلل حركة السعر الحقيقية للشموع المغلقة عبر الفريمات المتعددة (H1 / M15 / M5 / 1M) والمستويات الهيكلية المحسوبة بشكل مستقل تماماً.
   - قائمة المرشحات الخوارزمية (topCandidates) هي سياق استشاري فقط (Advisory Only) وليست شرطاً مسبقاً لأي صفقة.
   - وجود 0 مرشحات (detectedCandidatesCount = 0) أو قائمة فارغة لا يعني أبداً "NO TRADE". في هذه الحالة يجب عليك إجراء مسح وفحص مستقل وشامل لبيانات الشموع والهيكل الفني لاكتشاف النماذج الحقيقية في السوق.
   - يحق لك اقتراح صفقة مكتشفة ذاتياً حتى لو لم ترصدها الخوارزميات الحتمية المبدئية، بشرط اكتمال أركانها الفنية وشروط إدارة المخاطر.
   - يُحظر تماماً اختراع أو اصطناع صفقات غير مكتملة الأركان عندما يفتقر السوق لفرصة حقيقية أو يكون السعر في نطاق تذبذب عشوائي / منتصف رينج بدون ميزة إحصائية (في تلك الحالة اختر "NO TRADE").

2. تراتبية الفريمات الزمنية (Multi-Timeframe Hierarchy):
   - فريم H1: السياق الماكرو الكلي، الاتجاه الرئيسي، القمم والقيعان الرئيسية، ومجمعات السيولة الكبرى (BSL/SSL).
   - فريم M15: الهيكل الأساسي للنموذج، حالة السوق (Market Regime)، مناطق الـOrder Blocks وFVGs ومناطق الخصم والعلاوة (Premium/Discount).
   - فريم M5: فريم التنفيذ والزناد الأساسي (Execution & Confirmation)، سحب السيولة المحلي، تأكيد الـBOS/CHOCH، وإعادة اختبار الـPOI.
   - فريم 1M: تحسين نقطة الدخول اللحظية وتأكيد ذيول الرفض السريع فقط. لا يجوز لفريم 1M بمفرده إلغاء هيكل H1/M15 الصاعد أو الهابط القوي.

3. النماذج والاستراتيجيات ذات الأولوية العالية (Priority Setups):
   - سحب السيولة ورفض القيعان/القمم (Liquidity Sweeps & SFPs).
   - إعادة اختبار كتل الأوامر المؤكدة (Order Block Retests).
   - ملء الفجوات السعرية (FVG / Inverse FVG Rebalancing).
   - كسر الهيكل والتحول الهيكلي مع إعادة الاختبار (BOS / CHOCH Break & Retest).
   - التراجع التصحيحي مع الاتجاه القوي (Trend Pullback Confluence).
   - التفاعل مع مستويات الدعم والمقاومة التاريخية الحقيقية وسحب سيولة الأطراف (Range SFP).
   - الكسر التوسعي الحقيقي بعد تجميع سيولة (Breakout Expansion). لا تعتمد على مجرد كسر عشوائي بدون سحب سيولة أو إعادة اختبار.

4. قواعد وقف الخسارة الصارمة للسكالبينج (Scalping Stop Loss Rules):
   - للذهب: 1 point = 0.10$ حركة سعر (حساب النقاط: abs(Entry - SL) / 0.10).
   - نطاق الـStop Loss الفني المسموح به لصفقات السكالبينج هو حصرياً من 35 إلى 65 نقطة (أي ما يعادل 3.5$ إلى 6.5$ من سعر الدخول).
   - وضع وقف الخسارة الفني (Structural Local Invalidation): يجب وضع وقف الخسارة بدقة عند مستوى إبطال فني محلي ذي مغزى على فريم M5/M15 (مثل قاع/قمة الـOrder Block المحلي، أو قاع/قمة شمعة الابتلاع والتأكيد، أو أطراف الـFVG، أو السوينغ المحلي الأقرب).
   - حظر وقف الخسارة الماكرو (Macro Swing Prohibition): القمم والقيعان الكبرى على فريم H1 وH4 هي سياق اتجاهي فقط، ويُحظر تماماً وضع وقف الخسارة عند سوينغات H1 البعيدة (مثل 350 أو 566 أو 570 أو 580 أو 602 نقطة).
   - إذا كانت الصفقة تتطلب وقف خسارة أكبر من 65 نقطة ولا توجد نقطة إبطال فنية محلية صالحة ضمن نطاق [35, 65] نقطة، يجب اتخاذ قرار "NO TRADE" فوراً بدلاً من اقتراح صفقة بوقف خسارة واسع سيفشل في محرك المخاطر.

5. سياسة الأهداف الهيكلية الصارمة (Market Structure Target Policy):
   - الهدف الأول (TP1) هو أقرب هدف هيكلي حقيقي وملموس في السوق (Nearest genuine market-structure objective مثل Swings / S/R / Liquidity Pools / Order Blocks / FVG).
   - نسبة العائد إلى المخاطرة (R:R) إلى TP1 يجب أن تكون على الأقل 1.0R أي abs(TP1 - Entry) >= abs(Entry - SL).
   - الهدف الثاني (TP2): هو الهدف الهيكلي الحقيقي التالي بعد TP1 إن وجد، أو 0 إذا لم يوجد هدف واضح.

6. القرارات المسموحة:
   - "BUY NOW" أو "SELL NOW" أو "BUY LIMIT" أو "SELL LIMIT" أو "NO TRADE".
   - الثقة (Confidence): من 70 إلى 96 للصفقات الصالحة.
   - في حال عدم وجود فرصة حقيقية أو تذبذب في منتصف الرينج، اختر "NO TRADE" واذكر السبب بالتفصيل في noTradeReason.`;

  isAiCallRunning = true;
  const model = activeConfig.model;
  const timeoutMs = 10000;
  const startTime = Date.now();
  try {
    const prompt = `حلل بيانات السوق المتعددة الفريمات (H1, M15, M5, 1M) والشموع المغلقة والمستويات الهيكلية المرفقة للذهب واكتشف أفضل الفرص المتاحة بشكل مستقل، ثم قدم قرارك النهائي بصيغة JSON:\n${JSON.stringify(technicalContext, null, 2)}`;

    console.log(`[AI Engine] Provider: ${activeConfig.provider}, BaseURL: ${activeConfig.baseURL}, Model: ${model}`);
    let completion: any;
    try {
      completion = await ai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 1024,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'xauusd_trade_signal',
            strict: true,
            schema: XAUUSD_TRADE_SIGNAL_JSON_SCHEMA
          }
        }
      }, {
        timeout: timeoutMs,
      });
    } catch (schemaReqError: any) {
      // If a model rejects json_schema mode, attempt clean fallback with standard json_object
      const errorMsg = String(schemaReqError?.message || '');
      if (
        errorMsg.includes('json_schema') ||
        errorMsg.includes('response_format') ||
        errorMsg.includes('schema') ||
        schemaReqError?.status === 400
      ) {
        console.warn(`[AI Engine] json_schema rejected (${errorMsg}). Retrying with json_object format...`);
        completion = await ai.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: prompt }
          ],
          temperature: 0.2,
          max_tokens: 1024,
          response_format: { type: 'json_object' }
        }, {
          timeout: timeoutMs,
        });
      } else {
        throw schemaReqError;
      }
    }

    const durationMs = Date.now() - startTime;
    console.log(`[AI Engine] Request completed in ${durationMs}ms (model: ${model})`);

    const responseContent = completion.choices[0]?.message?.content || '{}';
    const parsed = parseAndValidateAiResponse(responseContent);

    const finalSignal = resolveAiSignalWithDeterministicFallback(parsed, candidatesContext, input);

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

    const durationMs = Date.now() - startTime;

    if (is429RateLimit) {
      aiCooldownUntil = Date.now() + 3 * 60 * 1000; // 3 minutes cooldown
      console.warn(`[AI Engine] HTTP 429 Too Many Requests received after ${durationMs}ms (model: ${model}). Activating 3-minute cooldown until ${new Date(aiCooldownUntil).toLocaleTimeString()}. Using multi-strategy candidate engine.`);
    } else if (isAuthError) {
      isKeyUnauthenticated = true;
      console.warn(`[AI Engine] API key is unauthenticated after ${durationMs}ms (model: ${model}). Using multi-strategy candidate engine.`);
    } else if (isTimeout) {
      console.warn(`[AI Engine] API request timed out after ${durationMs}ms (timeout limit: ${timeoutMs}ms, model: ${model}). Smoothly falling back to multi-strategy candidate engine.`);
    } else {
      console.warn(`[AI Engine] API note after ${durationMs}ms (model: ${model}), falling back to multi-strategy engine:`, error?.message || error);
    }

    const fallback = algorithmicScreening(input);
    return buildFinalSignal(fallback, input);
  } finally {
    isAiCallRunning = false;
  }
}

/**
 * Resolves AI Decision against deterministic candidates and executes fallback if AI votes NO TRADE
 */
export function resolveAiSignalWithDeterministicFallback(
  parsed: any,
  candidatesContext: any,
  input: MarketAnalysisInput
): TradeSignal {
  const currentPrice = input.currentPrice;
  const decision = parsed.signal;
  const isAiTrade = ['BUY NOW', 'SELL NOW', 'BUY LIMIT', 'SELL LIMIT'].includes(decision);
  let finalSignal: TradeSignal;

  if (isAiTrade) {
    const aiDirection: 'BUY' | 'SELL' = decision.includes('BUY') ? 'BUY' : 'SELL';
    const aiEntry = Number(parsed.entry !== undefined ? parsed.entry : currentPrice);
    const aiSl = Number(parsed.stopLoss !== undefined ? parsed.stopLoss : (aiDirection === 'BUY' ? aiEntry - 4.5 : aiEntry + 4.5));
    const aiTp1 = Number(parsed.tp1 !== undefined ? parsed.tp1 : (aiDirection === 'BUY' ? aiEntry + 7.0 : aiEntry - 7.0));
    const aiTp2 = parsed.tp2 !== undefined ? Number(parsed.tp2) : undefined;
    const aiSetup = parsed.setup || 'AI Market Structure Setup';
    const aiFamily = inferStrategyFamily(aiSetup);

    // Enforce strict deterministic technical validation on AI candidate
    const valResult = validateTradeSignalCandidate(
      {
        direction: aiDirection,
        entry: aiEntry,
        stopLoss: aiSl,
        tp1: aiTp1,
        tp2: aiTp2,
        setupName: aiSetup,
        strategyFamily: aiFamily,
        confidence: Number(parsed.confidence || 75),
      },
      {
        currentPrice,
        candles5m: input.recent5mCandles || [],
        candles15m: input.candles15m || [],
        candles1h: input.candles1h || [],
        candles1m: input.recent1mCandles || [],
        indicators5m: input.indicators5m,
        indicators15m: input.indicators15m,
        indicators1h: input.indicators1h,
        brokerSpecs: input.brokerSpecs,
        activeTradeDirection: input.activeTradeDirection,
        currentSpread: input.currentSpread,
      }
    );

    const minRequiredConfidence = Number((input.brokerSpecs as any)?.minConfidence ?? 70);
    const aiConfidence = Number(parsed.confidence ?? 75);

    if (aiConfidence < minRequiredConfidence) {
      console.warn(`[AI Engine] AI candidate rejected due to sub-floor confidence (${aiConfidence} < ${minRequiredConfidence})`);
      const validFallback = candidatesContext?.selectedCandidate || candidatesContext?.allCandidates?.find((c: any) => c.direction === 'BUY' || c.direction === 'SELL');
      if (validFallback) {
        console.log(`[AI Engine] Substituting low-confidence AI candidate with top qualified deterministic candidate (${validFallback.setupName || 'Qualified Deterministic Setup'})`);
        finalSignal = buildFinalSignal({
          decision: validFallback.direction === 'BUY' ? 'BUY NOW' : 'SELL NOW',
          entry: validFallback.entry,
          stopLoss: validFallback.stopLoss,
          tp1: validFallback.tp1,
          tp2: validFallback.tp2,
          confidence: validFallback.confidence,
          timeframe: validFallback.timeframe || '15M / 5M',
          setup: validFallback.setupName || 'Deterministic Structural Setup',
          mainReasons: validFallback.mainReasons || ['نموذج هيكلي مؤكد حسابياً عبر محرك الإشارات الحتمي.'],
          invalidation: validFallback.invalidation || (validFallback.direction === 'BUY' ? `Close candle below ${validFallback.stopLoss}` : `Close candle above ${validFallback.stopLoss}`),
        }, input);
      } else {
        finalSignal = buildFinalSignal({
          decision: 'NO TRADE',
          entry: currentPrice,
          stopLoss: currentPrice,
          tp1: currentPrice,
          tp2: currentPrice,
          confidence: aiConfidence,
          timeframe: '15M / 5M',
          setup: 'No Valid Setup',
          mainReasons: [],
          invalidation: 'N/A',
          noTradeReason: `تم رفض مقترح الذكاء الاصطناعي لانخفاض مؤشر الثقة الفنية (${aiConfidence}) عن الحد الأدنى (${minRequiredConfidence}).`
        }, input);
      }
    } else if (!valResult.isValid) {
      console.warn(`[AI Engine] AI candidate rejected by deterministic technical validation: ${valResult.rejectionReason}`);
      
      // Prefer highest-quality deterministic candidate that already passed validation
      const validFallback = candidatesContext?.selectedCandidate || candidatesContext?.allCandidates?.find((c: any) => c.direction === 'BUY' || c.direction === 'SELL');
      if (validFallback) {
        console.log(`[AI Engine] Substituting rejected AI candidate with top qualified deterministic candidate (${validFallback.setupName || 'Qualified Deterministic Setup'})`);
        finalSignal = buildFinalSignal({
          decision: validFallback.direction === 'BUY' ? 'BUY NOW' : 'SELL NOW',
          entry: validFallback.entry,
          stopLoss: validFallback.stopLoss,
          tp1: validFallback.tp1,
          tp2: validFallback.tp2,
          confidence: validFallback.confidence,
          timeframe: validFallback.timeframe || '15M / 5M',
          setup: validFallback.setupName || 'Deterministic Structural Setup',
          mainReasons: validFallback.mainReasons || ['نموذج هيكلي مؤكد حسابياً عبر محرك الإشارات الحتمي.'],
          invalidation: validFallback.invalidation || (validFallback.direction === 'BUY' ? `Close candle below ${validFallback.stopLoss}` : `Close candle above ${validFallback.stopLoss}`),
        }, input);
      } else {
        console.log(`[AI Engine] No qualified deterministic candidate available. Returning NO TRADE.`);
        finalSignal = buildFinalSignal({
          decision: 'NO TRADE',
          entry: currentPrice,
          stopLoss: currentPrice,
          tp1: currentPrice,
          tp2: currentPrice,
          confidence: 0,
          timeframe: '15M / 5M',
          setup: 'No Valid Setup',
          mainReasons: [],
          invalidation: 'N/A',
          noTradeReason: `تم رفض مقترح الذكاء الاصطناعي برمجياً لعدم اكتمال الشروط الفنية الحتمية: ${valResult.rejectionReason}`
        }, input);
      }
    } else {
      // AI Candidate passed deterministic validation
      finalSignal = buildFinalSignal({
        decision,
        entry: aiEntry,
        stopLoss: aiSl,
        tp1: aiTp1,
        tp2: (typeof aiTp2 === 'number' && aiTp2 > 0 && Math.abs(aiTp2 - aiEntry) > 0.01) ? aiTp2 : 0,
        confidence: Math.min(100, Math.max(0, Number(parsed.confidence || 75))),
        timeframe: parsed.timeframe || '15M / 5M',
        setup: aiSetup,
        mainReasons: Array.isArray(parsed.mainReasons) && parsed.mainReasons.length > 0 ? parsed.mainReasons : ['تأكيد الهيكل الفني وسلوك السعر.'],
        invalidation: parsed.invalidation || (aiDirection === 'BUY' ? `Close candle below ${aiSl}` : `Close candle above ${aiSl}`),
        noTradeReason: parsed.noTradeReason
      }, input);
    }
  } else {
    // AI returned NO TRADE: check if a fully-validated deterministic candidate is ready to execute
    const deterministicCandidate = candidatesContext?.selectedCandidate || candidatesContext?.allCandidates?.find((c: any) => c.direction === 'BUY' || c.direction === 'SELL');
    let fallbackCandidateToExecute: SetupCandidate | null = null;

    if (deterministicCandidate) {
      const valResult = validateTradeSignalCandidate(
        {
          direction: deterministicCandidate.direction,
          entry: deterministicCandidate.entry,
          stopLoss: deterministicCandidate.stopLoss,
          tp1: deterministicCandidate.tp1,
          tp2: deterministicCandidate.tp2,
          setupName: deterministicCandidate.setupName,
          strategyFamily: deterministicCandidate.strategyFamily,
          confidence: deterministicCandidate.confidence,
        },
        {
          currentPrice,
          candles5m: input.recent5mCandles || [],
          candles15m: input.candles15m || [],
          candles1h: input.candles1h || [],
          candles1m: input.recent1mCandles || [],
          indicators5m: input.indicators5m,
          indicators15m: input.indicators15m,
          indicators1h: input.indicators1h,
          brokerSpecs: input.brokerSpecs,
          activeTradeDirection: input.activeTradeDirection,
          currentSpread: input.currentSpread,
        }
      );

      if (valResult.isValid) {
        fallbackCandidateToExecute = deterministicCandidate;
        console.log(`[AI Engine] AI_DECISION=NO_TRADE DETERMINISTIC_CANDIDATE=VALID ACTION=EXECUTE_DETERMINISTIC_FALLBACK setup="${deterministicCandidate.setupName}"`);
      } else {
        console.log(`[AI Engine] AI returned NO TRADE and deterministic candidate rejected: ${valResult.rejectionReason}`);
      }
    }

    if (fallbackCandidateToExecute) {
      finalSignal = buildFinalSignal({
        decision: fallbackCandidateToExecute.direction === 'BUY' ? 'BUY NOW' : 'SELL NOW',
        entry: fallbackCandidateToExecute.entry,
        stopLoss: fallbackCandidateToExecute.stopLoss,
        tp1: fallbackCandidateToExecute.tp1,
        tp2: fallbackCandidateToExecute.tp2,
        confidence: fallbackCandidateToExecute.confidence,
        timeframe: fallbackCandidateToExecute.timeframe || '15M / 5M',
        setup: fallbackCandidateToExecute.setupName || 'Deterministic Structural Setup',
        mainReasons: [
          'تنفيذ احتياطي حتمي: إشارة مستوفية لكافة المعايير الفنية وشروط الجودة وتجاوزت اعتراض نموذج الذكاء الاصطناعي.',
          ...(fallbackCandidateToExecute.mainReasons || [])
        ],
        invalidation: (fallbackCandidateToExecute as any).invalidation || (fallbackCandidateToExecute.direction === 'BUY' ? `Close candle below ${fallbackCandidateToExecute.stopLoss}` : `Close candle above ${fallbackCandidateToExecute.stopLoss}`),
      }, input);
    } else {
      finalSignal = buildFinalSignal({
        decision: 'NO TRADE',
        entry: currentPrice,
        stopLoss: currentPrice,
        tp1: currentPrice,
        tp2: currentPrice,
        confidence: Math.min(100, Math.max(0, Number(parsed.confidence || 0))),
        timeframe: parsed.timeframe || '15M / 5M',
        setup: 'No Setup',
        mainReasons: [],
        invalidation: 'N/A',
        noTradeReason: parsed.noTradeReason || 'عدم وجود فرصة واضحة بنسبة عائد تفوق 1:1.0R مع وقف خسارة مناسب.'
      }, input);
    }
  }

  return finalSignal;
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
  const minRr = brokerSpecs?.minRr ?? 1.0;
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
  const targetTp2 = dynamicTp.valid ? (dynamicTp.hasValidTp2 ? dynamicTp.tp2 : 0) : (raw.tp2 && raw.tp2 !== raw.tp1 ? raw.tp2 : 0);

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
      noTradeReason: riskEval.reason || 'الـSetup لا يحقق معايير إدارة المخاطر (نسبة عائد أو وقف خسارة غير مناسب).'
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
  reasonsList.push(`الهدف الأول TP1 (${finalTp1}) يستهدف ${dynamicTp.tp1TargetName || 'المستوى الهيكلي'} بنسبة عائد ${riskEval.tp1RrString} (${riskEval.tp1Points} نقطة).`);
  if (finalTp2 && finalTp2 > 0) {
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
