export type AssetType = 'XAU/USD' | 'BTC/USD';

export type NavigationTab =
  | 'dashboard'
  | 'scanner'
  | 'signals'
  | 'trades'
  | 'backtest'
  | 'risk'
  | 'analytics'
  | 'telegram'
  | 'health'
  | 'settings';

export type SignalDecision = 'BUY NOW' | 'SELL NOW' | 'BUY LIMIT' | 'SELL LIMIT' | 'NO TRADE';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalIndicators {
  ema20: number;
  ema50: number;
  ema200: number;
  vwap: number;
  rsi14: number;
  macd: {
    macd: number;
    signal: number;
    histogram: number;
  };
  atr14: number;
  bollingerBands: {
    upper: number;
    middle: number;
    lower: number;
  };
  swingHigh: number;
  swingLow: number;
  support: number;
  resistance: number;
  structure: 'BULLISH' | 'BEARISH' | 'RANGING';
  structureShift?: string;
  trendStructure?: 'HH_HL' | 'LH_LL' | 'RANGING';
  chochDetected?: boolean;
  bosDetected?: boolean;
  liquidityLevels?: {
    buySideLiquidity: number; // Swing Highs pool
    sellSideLiquidity: number; // Swing Lows pool
  };
  orderBlock?: {
    type: 'BULLISH' | 'BEARISH';
    high: number;
    low: number;
  };
  fvg?: {
    type: 'BULLISH' | 'BEARISH';
    top: number;
    bottom: number;
  };
  liquiditySweepDetected?: boolean;
  premiumDiscountZone?: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
}

export type CapitalSource = 'MANUAL' | 'MT5';

export interface MT5AccountInfo {
  connected: boolean;
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  balance: number | null;
  equity: number | null;
  freeMargin: number | null;
  currency: string;
  server?: string;
  accountNumber?: string;
  lastUpdated?: number | null;
  statusMessage?: string;
}

export type AccountExecutionMode = 'DEMO' | 'REAL';

export interface AppSettings {
  capitalSource: CapitalSource;
  manualCapital: number;
  riskPerTrade: number;
  maxRiskPerTrade: number;
  minTp1RR: number;
  targetTp2RR: number;
  minimumConfidence: number;
  executionMode: AccountExecutionMode;
  accountMode: AccountExecutionMode;
  autoTradingEnabled: boolean;
  symbol: string;
  timeframes: string[];
  allowedSignalTypes: string[];
  contractSizeOz: number;
  minimumLot: number;
  maximumLot: number;
  lotStep: number;
  minGoldSlPoints?: number;
  maxGoldSlPoints: number;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  capitalSource: 'MANUAL',
  manualCapital: 10.0,
  riskPerTrade: 15.0,
  maxRiskPerTrade: 15.0,
  minTp1RR: 1.5,
  targetTp2RR: 3.0,
  minimumConfidence: 75,
  executionMode: 'DEMO',
  accountMode: 'DEMO',
  autoTradingEnabled: false,
  symbol: 'XAUUSD',
  timeframes: ['1H', '15M', '5M', '1M'],
  allowedSignalTypes: ['BUY NOW', 'SELL NOW', 'BUY LIMIT', 'SELL LIMIT', 'NO TRADE'],
  contractSizeOz: 100,
  minimumLot: 0.01,
  maximumLot: 100,
  lotStep: 0.01,
  minGoldSlPoints: 40,
  maxGoldSlPoints: 50,
};

export interface BrokerSettings {
  accountBalance: number;
  riskPercent: number; // 1.0 to 15.0
  contractSizeOz: number; // default 100 oz
  minimumLot: number; // default 0.01 standard lot
  maximumLot: number; // default 100 standard lot
  lotStep: number; // default 0.01
  minGoldSlPoints?: number; // default 40 points
  maxGoldSlPoints: number; // default 50 points
  minRr: number; // default 1.5
  name?: string;
  accountNumber?: string;
  server?: string;
  minLot?: number;
}

export const DEFAULT_BROKER_SETTINGS: BrokerSettings = {
  accountBalance: 10,
  riskPercent: 15.0, // 15% risk rule for challenge account
  contractSizeOz: 100,
  minimumLot: 0.01,
  maximumLot: 100,
  lotStep: 0.01,
  minGoldSlPoints: 40,
  maxGoldSlPoints: 50,
  minRr: 1.5,
};

export interface PositionSizingDetails {
  accountBalance: number;
  riskPercent: number;
  riskDollars: number;
  entryPrice: number;
  stopLossPrice: number;
  priceDistance: number;
  contractSizeOz: number;
  riskPerStandardLot: number;
  standardLotSize: number;
  miniLotSize: number;
  microLotSize: number;
  estimatedMaxLoss: number;
  isExecutable: boolean;
  nonExecutableReason?: string;
  minimumLot: number;
  maximumLot: number;
  lotStep: number;
}

export interface TradeSignal {
  id: string;
  timestamp: number;
  asset: AssetType;
  signal: SignalDecision;
  currentPrice: number;
  entry: number;
  stopLoss: number;
  slPoints: number; // For XAU: difference / 0.10 (max 100 points = 10.0)
  tp1: number;
  tp1Points: number; // For XAU: abs(tp1 - entry) / 0.10
  tp1Rr?: number;
  tp1RrString?: string;
  tp2: number;
  tp2Points: number; // For XAU: abs(tp2 - entry) / 0.10
  tp2Rr?: number;
  tp2RrString?: string;
  primaryTarget?: 'TP1' | 'TP2';
  rr: string; // e.g., "TP1 (Primary): 1:1.50 | TP2: 1:2.99"
  rrRatio: number; // numeric value >= 1.5
  riskPercent: number; // 1% - 3%
  riskAmount: number; // $ based on current account balance
  potentialProfit: number; // $
  potentialLoss: number; // $
  recommendedLotSize: number; // Standard lot size
  standardLot?: number;
  miniLot?: number;
  microLot?: number;
  isExecutable?: boolean;
  nonExecutableReason?: string;
  positionSizing?: PositionSizingDetails;
  confidence: number; // 0 - 100
  timeframe: string; // "1H / 15M / 5M / 1M"
  setup: string; // Name of setup
  mainReasons: string[]; // 3 main reasons
  invalidation: string; // When the trade becomes invalid
  noTradeReason?: string; // Reason if NO TRADE
  aiAnalysisText?: string;
}

export interface Reinforcement {
  id: string;
  timestamp: number;
  entry: number;
  lots: number;
  riskAmount: number;
}

export interface TradeLedgerItem {
  id: string;
  tradeNumber: number;
  date: string;
  isoTime?: string;
  asset: AssetType;
  direction: SignalDecision;
  entry: number;
  sl: number;
  slPoints?: number;
  tp1: number;
  tp1Points?: number;
  tp2: number;
  tp2Points?: number;
  rr: string;
  riskPercent: number;
  riskAmount: number;
  lotSize?: number;
  confidence: number;
  setup: string;
  result: 'OPEN' | 'WIN' | 'LOSS' | 'CANCELLED' | 'VOID' | 'EXPIRED';
  isActive?: boolean;
  pl: number;
  balanceAfterTrade: number;
  exitPrice?: number;
  exitTime?: string;
  notes?: string;
  // Reinforcement/scale-in support
  reinforcements?: Reinforcement[];
  averageEntry?: number;
  totalRiskAmount?: number;
}

export interface AccountStats {
  currentBalance: number;
  startingBalance: number;
  totalPl: number;
  plPercent: number;
  drawdown: number;
  drawdownPercent: number;
  numberOfTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  largestWin: number;
  largestLoss: number;
  winningStreak: number;
  losingStreak: number;
  averageRR: number;
  totalRiskTaken: number;
}

export interface ScannerConfig {
  enabled: boolean;
  intervalSeconds: number; // 60 seconds
  intervalMinutes: number;
  minConfidence: number;
  telegramEnabled: boolean;
  lastScanTime: number | null;
  nextScanTime: number | null;
  lastScanStatus: string;
  dataStatus: string;
  lastDecision?: SignalDecision | null;
  lastSignal?: TradeSignal | null;
  isScanning: boolean;
  duplicatePrevented: boolean;
  activeSetupName?: string | null;
  scanCount: number;
}

export interface BacktestTradeItem {
  id: string;
  entryTime: string;
  exitTime: string;
  entryTimestamp: number;
  exitTimestamp: number;
  direction: 'BUY' | 'SELL';
  signalType: SignalDecision;
  setup: string;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  slPoints: number;
  tp1Points: number;
  riskPercent: number;
  riskAmount: number;
  lotSize: number;
  result: 'WIN' | 'LOSS' | 'AMBIGUOUS';
  pl: number;
  balanceBefore: number;
  balanceAfter: number;
  rrRatio: number;
  realRR: number;
  plannedRR_TP1?: number;
  plannedRR_TP2?: number;
  realizedR: number;
  exitReason: 'TP1' | 'TP2' | 'STOP_LOSS' | 'TIME_EXPIRATION' | 'AMBIGUOUS_SAME_CANDLE';
  confidence: number;
  durationMinutes: number;
  tpSelectionReason?: string;
  structuralTargetUsed?: string;
  targetDistance?: number;
  slDistance?: number;
  atrAtEntry?: number;
  passedVolatilitySanity?: boolean;
  noFutureDataUsed?: boolean;
  rawStructuralTarget?: number;
  targetSourceType?: string;
  isModified?: boolean;
  modificationReason?: string;
  technicalSL?: number;
  finalSL?: number;
  slBuffer?: number;
  initialLot?: number;
  addonLot?: number;
  initialEntry?: number;
  addonEntry?: number;
  finalAverageEntry?: number;
  combinedRisk?: number;
  addonUsed?: boolean;
}

export interface HistoricalDataValidationReport {
  provider: 'MT5_BRIDGE' | 'BIQUOTE';
  symbol: string;
  timeframe?: string;
  requestedPeriod: string;
  requestedStartTime: number;
  requestedEndTime: number;
  requestedStartDate: string;
  requestedEndDate: string;
  requestedCandles?: number;
  returnedCandles?: number;
  earliestTimestamp?: number;
  latestTimestamp?: number;
  actualEarliestCandleTime: number;
  actualLatestCandleTime: number;
  actualEarliestDate: string;
  actualLatestDate: string;
  candleCounts: {
    '5m': number;
    '15m': number;
    '1h': number;
    '1d'?: number;
  };
  gaps: {
    timeframe: string;
    gapStart: string;
    gapEnd: string;
    gapDurationHours: number;
    reason: string;
  }[];
  duplicatesCount: {
    '5m': number;
    '15m': number;
    '1h': number;
  };
  coverageRatio: number;
  coverage?: number;
  isFullCoverage: boolean;
  status: 'VALID' | 'INSUFFICIENT_DATA' | 'PARTIAL_DATA';
  message: string;
}

export interface BacktestResultData {
  runId?: string;
  runTimestamp?: number;
  initialCapital: number;
  finalBalance: number;
  netProfit: number;
  netProfitPercent: number;
  totalTrades: number;
  wins: number;
  losses: number;
  ambiguousTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  medianRR: number;
  averageRR: number;
  maxRR: number;
  pctTradesRrAbove5: number;
  pctTradesRrAbove10: number;
  noTradeCountSub2RR: number;
  rejectedByDailyRiskLimit?: number;
  rejectedByMinimumLotRisk?: number;
  tradesUsingAddon?: number;
  addonRejectedRiskCount?: number;
  maxDailyAggregateRisk?: number;
  maxActualPerTradeRisk?: number;
  maxBufferUsed?: number;
  avgBufferUsed?: number;
  dailyRiskTaken?: Record<string, number>;
  largestWin: number;
  largestLoss: number;
  averageWin: number;
  averageLoss: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  dailyTradesDistribution: Record<string, number>;
  timeRange: string;
  candlesEvaluated: number;
  candlesCount1h?: number;
  candlesCount15m?: number;
  candlesCount5m?: number;
  startTimestamp?: number;
  endTimestamp?: number;
  startDate: string;
  endDate: string;
  trades: BacktestTradeItem[];
  equityCurve: { time: string; timestamp: number; balance: number }[];
  validationReport?: HistoricalDataValidationReport;
}

