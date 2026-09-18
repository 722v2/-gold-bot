export interface BrokerContractSpecs {
  accountBalance: number;
  riskPercent: number; // 1.0 to 3.0
  contractSizeOz: number; // default 100 oz
  minimumLot: number; // default 0.01 standard lot
  maximumLot: number; // default 100 standard lot
  lotStep: number; // default 0.01
  minGoldSlPoints?: number; // default 40 points
  maxGoldSlPoints: number; // default 50 points
  minRr: number; // default 1.5
  maxLoss?: number; // User-configured maximum loss limit in USD (e.g. $5.00)
}

export interface RiskCalculationParams {
  balance: number;
  riskPercent?: number;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2?: number;
  confidence: number;
  isVeryStrongSetup?: boolean;
  losingStreak?: number;
  asset?: 'XAU/USD' | 'BTC/USD';
  brokerSpecs?: Partial<BrokerContractSpecs>;
  direction?: 'BUY' | 'SELL';
  orderType?: 'MARKET' | 'LIMIT';
  allowExecutabilityOptimization?: boolean;
}

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
  maxLoss?: number;
  isExecutable: boolean;
  nonExecutableReason?: string;
  minimumLot: number;
  maximumLot: number;
  lotStep: number;
}

export interface RiskEvaluationResult {
  valid: boolean;
  reason?: string;
  adjustedEntry?: number;
  adjustedStopLoss?: number;
  adjustedTp1?: number;
  adjustedTp2?: number;
  wasOptimizedForExecutability?: boolean;
  optimizationNote?: string;
  riskPercent: number;
  riskAmount: number; // risk_dollars
  slPoints: number;
  priceDistance: number;
  tp1Points: number;
  tp1Distance: number;
  tp1Rr: number;
  tp1RrString: string;
  tp2Points: number;
  tp2Distance: number;
  tp2Rr: number;
  tp2RrString: string;
  primaryTarget: 'TP1' | 'TP2';
  rrRatio: number; // Primary RR (TP1)
  rrString: string; // e.g. "TP1: 1:1.50 (75.0 pts) | TP2: 1:3.20 (160.0 pts)"
  potentialProfit: number;
  potentialLoss: number;
  recommendedLotSize: number; // Standard lot size
  positionSizing: PositionSizingDetails;
}

export const DEFAULT_BROKER_SPECS: BrokerContractSpecs = {
  accountBalance: 10,
  riskPercent: 15.0, // 15% account risk rule for small challenge ($1.50 on $10)
  contractSizeOz: 100,
  minimumLot: 0.01,
  maximumLot: 100,
  lotStep: 0.01,
  minGoldSlPoints: 40,
  maxGoldSlPoints: 50,
  minRr: 1.0,
  maxLoss: 5.0,
};

/**
 * Calculates position sizing and risk parameters using the exact formula:
 *
 * risk_dollars = account_balance * (risk_percent / 100)
 * price_distance = abs(entry_price - stop_loss)
 * risk_per_standard_lot = price_distance * contract_size_oz
 * standard_lot_size = risk_dollars / risk_per_standard_lot
 *
 * Risk Precedence Order:
 * Technical SL -> minimum lot -> actual monetary risk -> Max Loss validation
 *
 * If 0.01 lot exceeds calculated Risk Budget slightly or moderately, do NOT reject automatically.
 * Allow the trade if actual loss is within the CURRENT persisted Max Loss.
 * Reject only if actual loss exceeds Max Loss or technical SL is invalid.
 */
export function calculatePositionSizing(
  balance: number,
  riskPercent: number,
  entry: number,
  stopLoss: number,
  brokerSpecs: Partial<BrokerContractSpecs> = {}
): PositionSizingDetails {
  const contractSizeOz = Number(brokerSpecs.contractSizeOz ?? DEFAULT_BROKER_SPECS.contractSizeOz);
  const minimumLot = Number(brokerSpecs.minimumLot ?? DEFAULT_BROKER_SPECS.minimumLot);
  const maximumLot = Number(brokerSpecs.maximumLot ?? DEFAULT_BROKER_SPECS.maximumLot);
  const lotStep = Number(brokerSpecs.lotStep ?? DEFAULT_BROKER_SPECS.lotStep);

  const maxLossLimit = typeof brokerSpecs.maxLoss === 'number' && brokerSpecs.maxLoss > 0
    ? brokerSpecs.maxLoss
    : (typeof brokerSpecs.maxGoldSlPoints === 'number' && brokerSpecs.maxGoldSlPoints > 0
        ? Number(((brokerSpecs.maxGoldSlPoints * contractSizeOz * 0.1) * minimumLot).toFixed(2))
        : 5.0);

  const riskDollars = Number(((balance * riskPercent) / 100).toFixed(4));
  const priceDistance = Number(Math.abs(entry - stopLoss).toFixed(4));

  if (priceDistance <= 0 || contractSizeOz <= 0) {
    return {
      accountBalance: balance,
      riskPercent,
      riskDollars,
      entryPrice: entry,
      stopLossPrice: stopLoss,
      priceDistance: 0,
      contractSizeOz,
      riskPerStandardLot: 0,
      standardLotSize: 0,
      miniLotSize: 0,
      microLotSize: 0,
      estimatedMaxLoss: 0,
      maxLoss: maxLossLimit,
      isExecutable: false,
      nonExecutableReason: 'Invalid price distance or contract size.',
      minimumLot,
      maximumLot,
      lotStep,
    };
  }

  // Exact formulas specified by user
  const riskPerStandardLot = priceDistance * contractSizeOz;
  const standardLotSize = riskDollars / riskPerStandardLot;

  // Calculate monetary risk if executed at minimumLot with existing SL distance
  const monetaryRiskAtMinLot = Number((minimumLot * riskPerStandardLot).toFixed(4));

  // Enforce Risk Precedence:
  // Technical SL -> minimum lot -> actual monetary risk -> Max Loss validation
  let isExecutable = true;
  let nonExecutableReason: string | undefined;
  let finalStandardLotSize = standardLotSize;

  if (standardLotSize > maximumLot) {
    isExecutable = false;
    nonExecutableReason = `TRADE NOT EXECUTABLE: Calculated lot (${standardLotSize.toFixed(4)}) exceeds broker maximum lot limit (${maximumLot}).`;
  } else if (standardLotSize < minimumLot) {
    // If 0.01 lot exceeds the calculated Risk Budget, do NOT reject automatically.
    // Allow the trade if actual monetary risk is within the CURRENT persisted Max Loss.
    // Reject only if actual loss exceeds Max Loss.
    if (monetaryRiskAtMinLot <= maxLossLimit + 0.0001) {
      isExecutable = true;
      finalStandardLotSize = minimumLot;
    } else {
      isExecutable = false;
      nonExecutableReason = `TRADE NOT EXECUTABLE: Actual loss at minimum lot ${minimumLot} ($${monetaryRiskAtMinLot.toFixed(2)}) exceeds configured Max Loss limit ($${maxLossLimit.toFixed(2)}).`;
    }
  } else if (standardLotSize <= 0) {
    isExecutable = false;
    nonExecutableReason = `TRADE NOT EXECUTABLE: Invalid calculated lot size (${standardLotSize.toFixed(6)}).`;
  } else {
    // standardLotSize >= minimumLot
    // If standard risk budget exceeds maxLossLimit, cap position size so actual loss never exceeds Max Loss
    if (riskDollars > maxLossLimit + 0.0001) {
      const cappedLot = Number((maxLossLimit / riskPerStandardLot).toFixed(4));
      if (cappedLot >= minimumLot) {
        finalStandardLotSize = Math.max(minimumLot, Math.floor(cappedLot / lotStep) * lotStep);
        isExecutable = true;
      } else if (monetaryRiskAtMinLot <= maxLossLimit + 0.0001) {
        finalStandardLotSize = minimumLot;
        isExecutable = true;
      } else {
        isExecutable = false;
        nonExecutableReason = `TRADE NOT EXECUTABLE: Actual loss at minimum lot ${minimumLot} ($${monetaryRiskAtMinLot.toFixed(2)}) exceeds configured Max Loss limit ($${maxLossLimit.toFixed(2)}).`;
      }
    } else {
      finalStandardLotSize = Math.max(minimumLot, Math.floor(standardLotSize / lotStep) * lotStep);
      isExecutable = true;
    }
  }

  const estimatedMaxLoss = Number((finalStandardLotSize * riskPerStandardLot).toFixed(4));

  return {
    accountBalance: balance,
    riskPercent,
    riskDollars,
    entryPrice: entry,
    stopLossPrice: stopLoss,
    priceDistance,
    contractSizeOz,
    riskPerStandardLot: Number(riskPerStandardLot.toFixed(2)),
    standardLotSize: Number(finalStandardLotSize.toFixed(6)),
    miniLotSize: Number((finalStandardLotSize * 10).toFixed(6)),
    microLotSize: Number((finalStandardLotSize * 100).toFixed(6)),
    estimatedMaxLoss: Number(estimatedMaxLoss.toFixed(2)),
    maxLoss: maxLossLimit,
    isExecutable,
    nonExecutableReason,
    minimumLot,
    maximumLot,
    lotStep,
  };
}

/**
 * Intelligent Executability Optimizer
 * 
 * Attempts to optimize Entry and Stop Loss within the existing strategy and technical structure
 * so that the setup becomes executable at minimum lot within or as close as possible to the allowed risk limit.
 */
export function optimizeSetupExecutability(params: {
  balance: number;
  riskPercent: number;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2?: number;
  direction: 'BUY' | 'SELL';
  asset: 'XAU/USD' | 'BTC/USD';
  brokerSpecs: Partial<BrokerContractSpecs>;
}): {
  wasOptimized: boolean;
  optimizedEntry: number;
  optimizedStopLoss: number;
  optimizedTp1: number;
  optimizedTp2?: number;
  priceDistance: number;
  slPoints: number;
  tp1Distance: number;
  tp1Points: number;
  tp1Rr: number;
  tp2Distance: number;
  tp2Points: number;
  tp2Rr: number;
  optimizationNote?: string;
  isExecutable: boolean;
} {
  const {
    balance,
    riskPercent,
    entry,
    stopLoss,
    tp1,
    tp2,
    direction,
    asset,
    brokerSpecs,
  } = params;

  const contractSizeOz = Number(brokerSpecs.contractSizeOz ?? DEFAULT_BROKER_SPECS.contractSizeOz);
  const minimumLot = Number(brokerSpecs.minimumLot ?? DEFAULT_BROKER_SPECS.minimumLot);
  const minGoldSlPoints = Number(brokerSpecs.minGoldSlPoints ?? DEFAULT_BROKER_SPECS.minGoldSlPoints ?? 40);
  const maxGoldSlPoints = Number(brokerSpecs.maxGoldSlPoints ?? DEFAULT_BROKER_SPECS.maxGoldSlPoints ?? 50);
  const minRr = Number(brokerSpecs.minRr ?? DEFAULT_BROKER_SPECS.minRr ?? 1.5);
  const pointValue = asset === 'XAU/USD' ? 0.1 : 1.0;

  const maxLossLimit = typeof brokerSpecs.maxLoss === 'number' && brokerSpecs.maxLoss > 0
    ? brokerSpecs.maxLoss
    : (typeof brokerSpecs.maxGoldSlPoints === 'number' && brokerSpecs.maxGoldSlPoints > 0
        ? Number(((brokerSpecs.maxGoldSlPoints * contractSizeOz * 0.1) * minimumLot).toFixed(2))
        : 5.0);

  const riskDollars = Number(((balance * riskPercent) / 100).toFixed(4));
  const initialDistance = Number(Math.abs(entry - stopLoss).toFixed(4));
  const initialSlPoints = Number((initialDistance / pointValue).toFixed(1));
  const initialRiskAtMinLot = Number((minimumLot * initialDistance * contractSizeOz).toFixed(4));

  // If already executable within risk budget or within persisted Max Loss limit, no optimization needed
  if (initialRiskAtMinLot <= riskDollars + 0.0001 || initialRiskAtMinLot <= maxLossLimit + 0.0001) {
    const tp1Dist = Number(Math.abs(tp1 - entry).toFixed(2));
    const tp1Pts = Number((tp1Dist / pointValue).toFixed(1));
    const tp1RrVal = initialDistance > 0 ? Number((tp1Dist / initialDistance).toFixed(2)) : 0;
    const tp2Dist = tp2 ? Number(Math.abs(tp2 - entry).toFixed(2)) : tp1Dist;
    const tp2Pts = Number((tp2Dist / pointValue).toFixed(1));
    const tp2RrVal = initialDistance > 0 ? Number((tp2Dist / initialDistance).toFixed(2)) : tp1RrVal;

    return {
      wasOptimized: false,
      optimizedEntry: entry,
      optimizedStopLoss: stopLoss,
      optimizedTp1: tp1,
      optimizedTp2: tp2,
      priceDistance: initialDistance,
      slPoints: initialSlPoints,
      tp1Distance: tp1Dist,
      tp1Points: tp1Pts,
      tp1Rr: tp1RrVal,
      tp2Distance: tp2Dist,
      tp2Points: tp2Pts,
      tp2Rr: tp2RrVal,
      isExecutable: true,
    };
  }

  // Target price distance to match allowed risk exactly at minimum lot
  const targetDistance = Number((riskDollars / (contractSizeOz * minimumLot)).toFixed(4));
  const targetSlPoints = Number((targetDistance / pointValue).toFixed(1));

  // Define allowable technical range with small structural tolerance
  // E.g. if minGoldSlPoints is 40, allow down to 38.0 points for minimum-lot executability optimization
  const structuralMinPoints = Math.max(30.0, Number((minGoldSlPoints - 2.0).toFixed(1)));
  const structuralMaxPoints = Number((maxGoldSlPoints + 5.0).toFixed(1));

  let candidateEntry = entry;
  let candidateStopLoss = stopLoss;
  let wasAdjusted = false;
  let optimizationReason = '';

  // 1. Optimize Stop Loss if initial SL was wider than minGoldSlPoints (e.g. 45-50 points)
  if (initialSlPoints > minGoldSlPoints) {
    const optimalPoints = Math.max(structuralMinPoints, Math.min(initialSlPoints, Math.max(targetSlPoints, minGoldSlPoints)));
    const optimalDist = Number((optimalPoints * pointValue).toFixed(2));

    candidateStopLoss = direction === 'BUY'
      ? Number((entry - optimalDist).toFixed(2))
      : Number((entry + optimalDist).toFixed(2));

    wasAdjusted = true;
    optimizationReason = `تم تقليص الوقف من ${initialSlPoints} نقطة إلى ${optimalPoints} نقطة بما يناسب أدنى لوت وإدارة المخاطر.`;
  }

  // Recalculate distance after SL adjustment
  let currentDist = Number(Math.abs(candidateEntry - candidateStopLoss).toFixed(4));
  let currentRiskAtMinLot = Number((minimumLot * currentDist * contractSizeOz).toFixed(4));

  // 2. If still slightly over risk limit, refine Entry price closer to SL
  if (currentRiskAtMinLot > riskDollars) {
    const excess = currentRiskAtMinLot - riskDollars;
    const deltaDistance = Number((excess / (contractSizeOz * minimumLot)).toFixed(4));
    
    // Refine entry if delta is a small, realistic refinement (e.g. <= 1.5 USD on Gold)
    if (deltaDistance > 0 && deltaDistance <= 1.5) {
      const refinedDist = Number(Math.max(structuralMinPoints * pointValue, currentDist - deltaDistance).toFixed(2));
      const refinedEntry = direction === 'BUY'
        ? Number((candidateStopLoss + refinedDist).toFixed(2))
        : Number((candidateStopLoss - refinedDist).toFixed(2));

      candidateEntry = refinedEntry;
      wasAdjusted = true;
      optimizationReason += (optimizationReason ? ' ' : '') + `تم تحسين سعر الدخول (${entry} -> ${candidateEntry}) لتقليل المسافة بما يتوافق مع مخاطرة $${riskDollars.toFixed(2)}.`;
    }
  }

  const finalDist = Number(Math.abs(candidateEntry - candidateStopLoss).toFixed(4));
  const finalSlPoints = Number((finalDist / pointValue).toFixed(1));
  const tp1Dist = Number(Math.abs(tp1 - candidateEntry).toFixed(2));
  const tp1Pts = Number((tp1Dist / pointValue).toFixed(1));
  const tp1RrVal = finalDist > 0 ? Number((tp1Dist / finalDist).toFixed(2)) : 0;
  const tp2Dist = tp2 ? Number(Math.abs(tp2 - candidateEntry).toFixed(2)) : tp1Dist;
  const tp2Pts = Number((tp2Dist / pointValue).toFixed(1));
  const tp2RrVal = finalDist > 0 ? Number((tp2Dist / finalDist).toFixed(2)) : tp1RrVal;

  const finalRiskAtMinLot = Number((minimumLot * finalDist * contractSizeOz).toFixed(4));
  const remainingExcess = Number((finalRiskAtMinLot - riskDollars).toFixed(4));
  const dollarPerPoint = Number(((contractSizeOz * pointValue) * minimumLot).toFixed(4));

  // Check if final configuration is executable (within risk budget or within persisted Max Loss limit)
  const effectiveMinRr = Math.min(minRr, 0.95);
  const isExecutable =
    (finalRiskAtMinLot <= riskDollars + 0.0001 || finalRiskAtMinLot <= maxLossLimit + 0.0001) &&
    finalSlPoints >= structuralMinPoints &&
    finalSlPoints <= structuralMaxPoints &&
    tp1RrVal >= effectiveMinRr;

  return {
    wasOptimized: wasAdjusted,
    optimizedEntry: candidateEntry,
    optimizedStopLoss: candidateStopLoss,
    optimizedTp1: tp1,
    optimizedTp2: tp2,
    priceDistance: finalDist,
    slPoints: finalSlPoints,
    tp1Distance: tp1Dist,
    tp1Points: tp1Pts,
    tp1Rr: tp1RrVal,
    tp2Distance: tp2Dist,
    tp2Points: tp2Pts,
    tp2Rr: tp2RrVal,
    optimizationNote: optimizationReason || undefined,
    isExecutable,
  };
}

/**
 * Validates and calculates risk parameters according to strict Gold AI Challenge rules
 */
export function evaluateTradeRisk(params: RiskCalculationParams): RiskEvaluationResult {
  const {
    balance,
    entry: initialEntry,
    stopLoss: initialStopLoss,
    tp1: initialTp1,
    tp2: initialTp2,
    confidence,
    isVeryStrongSetup = false,
    losingStreak = 0,
    asset = 'XAU/USD',
    brokerSpecs = {},
    direction,
    orderType = 'MARKET',
    allowExecutabilityOptimization = true,
  } = params;

  const minGoldSlPoints = brokerSpecs.minGoldSlPoints ?? DEFAULT_BROKER_SPECS.minGoldSlPoints ?? 40;
  const maxGoldSlPoints = brokerSpecs.maxGoldSlPoints ?? DEFAULT_BROKER_SPECS.maxGoldSlPoints ?? 50;
  const minRr = brokerSpecs.minRr ?? DEFAULT_BROKER_SPECS.minRr;
  const configuredRiskPercent = params.riskPercent ?? brokerSpecs.riskPercent ?? DEFAULT_BROKER_SPECS.riskPercent;

  const emptyPositionSizing: PositionSizingDetails = {
    accountBalance: balance,
    riskPercent: 0,
    riskDollars: 0,
    entryPrice: initialEntry,
    stopLossPrice: initialStopLoss,
    priceDistance: 0,
    contractSizeOz: brokerSpecs.contractSizeOz ?? DEFAULT_BROKER_SPECS.contractSizeOz,
    riskPerStandardLot: 0,
    standardLotSize: 0,
    miniLotSize: 0,
    microLotSize: 0,
    estimatedMaxLoss: 0,
    isExecutable: false,
    minimumLot: brokerSpecs.minimumLot ?? DEFAULT_BROKER_SPECS.minimumLot,
    maximumLot: brokerSpecs.maximumLot ?? DEFAULT_BROKER_SPECS.maximumLot,
    lotStep: brokerSpecs.lotStep ?? DEFAULT_BROKER_SPECS.lotStep,
  };

  if (balance <= 0) {
    return {
      valid: false,
      reason: 'رصيد الحساب غير صالح أو منتهي.',
      riskPercent: 0,
      riskAmount: 0,
      slPoints: 0,
      priceDistance: 0,
      tp1Points: 0,
      tp1Distance: 0,
      tp1Rr: 0,
      tp1RrString: '1:0',
      tp2Points: 0,
      tp2Distance: 0,
      tp2Rr: 0,
      tp2RrString: '1:0',
      primaryTarget: 'TP1',
      rrRatio: 0,
      rrString: '1:0',
      potentialProfit: 0,
      potentialLoss: 0,
      recommendedLotSize: 0,
      positionSizing: emptyPositionSizing,
    };
  }

  // Requirement 3: Risk Limits
  // Base risk: 15% (or configured in broker specs, default 15%). Max risk cap: 20%.
  let riskPercent = configuredRiskPercent > 0 ? configuredRiskPercent : 15.0;

  // Capital preservation: If in a losing streak of 2 or more, reduce risk to half
  if (losingStreak >= 2) {
    riskPercent = Number((riskPercent * 0.5).toFixed(1));
  }

  // Safety hard clamp at 20%
  if (riskPercent > 20.0) {
    return {
      valid: false,
      reason: `نسبة المخاطرة (${riskPercent}%) تتجاوز الحد الأقصى الصارم المسموح به (20%) -> NO TRADE.`,
      riskPercent: 0,
      riskAmount: 0,
      slPoints: 0,
      priceDistance: 0,
      tp1Points: 0,
      tp1Distance: 0,
      tp1Rr: 0,
      tp1RrString: '1:0',
      tp2Points: 0,
      tp2Distance: 0,
      tp2Rr: 0,
      tp2RrString: '1:0',
      primaryTarget: 'TP1',
      rrRatio: 0,
      rrString: '1:0',
      potentialProfit: 0,
      potentialLoss: 0,
      recommendedLotSize: 0,
      positionSizing: emptyPositionSizing,
    };
  }

  // Resolve trade direction
  const resolvedDirection: 'BUY' | 'SELL' = direction || (initialEntry >= initialStopLoss ? 'BUY' : 'SELL');

  // Executability Intelligence (Step 1 & Step 2):
  // Optimize Entry and Stop Loss within existing strategy and technical structure
  let entry = initialEntry;
  let stopLoss = initialStopLoss;
  let tp1 = initialTp1;
  let tp2 = initialTp2;
  let wasOptimizedForExecutability = false;
  let optimizationNote: string | undefined;

  if (allowExecutabilityOptimization) {
    const opt = optimizeSetupExecutability({
      balance,
      riskPercent,
      entry: initialEntry,
      stopLoss: initialStopLoss,
      tp1: initialTp1,
      tp2: initialTp2,
      direction: resolvedDirection,
      asset,
      brokerSpecs,
    });

    if (opt.wasOptimized) {
      entry = opt.optimizedEntry;
      stopLoss = opt.optimizedStopLoss;
      tp1 = opt.optimizedTp1;
      tp2 = opt.optimizedTp2;
      wasOptimizedForExecutability = true;
      optimizationNote = opt.optimizationNote;
    }
  }

  const priceDistance = Math.abs(entry - stopLoss);

  // Requirement 5: Gold Point Convention
  // 1 point = 0.10 XAU/USD price movement.
  // points = abs(entry - SL) / 0.10
  const slPoints = asset === 'XAU/USD'
    ? Number((priceDistance / 0.1).toFixed(1))
    : Number(priceDistance.toFixed(1));

  const tp1Distance = Math.abs(tp1 - entry);
  const tp1Points = asset === 'XAU/USD'
    ? Number((tp1Distance / 0.1).toFixed(1))
    : Number(tp1Distance.toFixed(1));
  const tp1Rr = priceDistance > 0 ? Number((tp1Distance / priceDistance).toFixed(2)) : 0;
  const tp1RrString = `1:${tp1Rr.toFixed(2)}`;

  let tp2Distance = tp1Distance;
  let tp2Points = tp1Points;
  let tp2Rr = tp1Rr;
  let tp2RrString = tp1RrString;
  if (tp2 && tp2 > 0) {
    tp2Distance = Math.abs(tp2 - entry);
    tp2Points = asset === 'XAU/USD'
      ? Number((tp2Distance / 0.1).toFixed(1))
      : Number(tp2Distance.toFixed(1));
    tp2Rr = priceDistance > 0 ? Number((tp2Distance / priceDistance).toFixed(2)) : 0;
    tp2RrString = `1:${tp2Rr.toFixed(2)}`;
  }

  const compositeRrString = `TP1: ${tp1RrString} (${tp1Points} pts) | TP2: ${tp2RrString} (${tp2Points} pts)`;

  // Gold SL range filter with structural executability tolerance:
  // Allow down to minGoldSlPoints - 2.0 (e.g. 38 points) for minimum-lot executability optimization
  const structuralMinSl = Math.max(30.0, Number((minGoldSlPoints - 2.0).toFixed(1)));
  const structuralMaxSl = Number((maxGoldSlPoints + 5.0).toFixed(1));

  if (asset === 'XAU/USD' && (slPoints < structuralMinSl || slPoints > structuralMaxSl)) {
    const isBelow = slPoints < structuralMinSl;
    return {
      valid: false,
      reason: isBelow
        ? `الـStop Loss المطلوب (${slPoints} نقطة) أقل من الحد الأدنى المسموح للذهب (${minGoldSlPoints} نقطة = $${(minGoldSlPoints * 0.1).toFixed(1)}). النطاق المسموح به حصراً هو ${minGoldSlPoints}-${maxGoldSlPoints} نقطة -> NO TRADE.`
        : `الـStop Loss المطلوب (${slPoints} نقطة) يتجاوز الحد الأقصى المسموح للذهب (${maxGoldSlPoints} نقطة = $${(maxGoldSlPoints * 0.1).toFixed(1)}). النطاق المسموح به حصراً هو ${minGoldSlPoints}-${maxGoldSlPoints} نقطة -> NO TRADE.`,
      riskPercent: 0,
      riskAmount: 0,
      slPoints,
      priceDistance: Number(priceDistance.toFixed(2)),
      tp1Points,
      tp1Distance: Number(tp1Distance.toFixed(2)),
      tp1Rr: 0,
      tp1RrString: '1:0',
      tp2Points,
      tp2Distance: Number(tp2Distance.toFixed(2)),
      tp2Rr: 0,
      tp2RrString: '1:0',
      primaryTarget: 'TP1',
      rrRatio: 0,
      rrString: '1:0',
      potentialProfit: 0,
      potentialLoss: 0,
      recommendedLotSize: 0,
      positionSizing: emptyPositionSizing,
    };
  }

  if (priceDistance <= 0.01) {
    return {
      valid: false,
      reason: 'الفرق بين سعر الدخول والـStop Loss غير كافٍ (أقل من 0.01$).',
      riskPercent: 0,
      riskAmount: 0,
      slPoints,
      priceDistance: Number(priceDistance.toFixed(2)),
      tp1Points,
      tp1Distance: Number(tp1Distance.toFixed(2)),
      tp1Rr: 0,
      tp1RrString: '1:0',
      tp2Points,
      tp2Distance: Number(tp2Distance.toFixed(2)),
      tp2Rr: 0,
      tp2RrString: '1:0',
      primaryTarget: 'TP1',
      rrRatio: 0,
      rrString: '1:0',
      potentialProfit: 0,
      potentialLoss: 0,
      recommendedLotSize: 0,
      positionSizing: emptyPositionSizing,
    };
  }

  // Requirement 4: RR Calculation
  // Minimum acceptable RR is 1:1.0 (0.95R)
  const minRequiredRr = Math.min(minRr, 0.95);
  if (tp1Rr < minRequiredRr) {
    return {
      valid: false,
      reason: `نسبة العائد إلى المخاطرة للهدف الأول TP1 (${tp1RrString}) أقل من الحد الأدنى الإلزامي 1:${minRequiredRr.toFixed(2)} -> NO TRADE.`,
      riskPercent: 0,
      riskAmount: 0,
      slPoints,
      priceDistance: Number(priceDistance.toFixed(2)),
      tp1Points,
      tp1Distance: Number(tp1Distance.toFixed(2)),
      tp1Rr,
      tp1RrString,
      tp2Points,
      tp2Distance: Number(tp2Distance.toFixed(2)),
      tp2Rr,
      tp2RrString,
      primaryTarget: 'TP1',
      rrRatio: tp1Rr,
      rrString: compositeRrString,
      potentialProfit: 0,
      potentialLoss: 0,
      recommendedLotSize: 0,
      positionSizing: emptyPositionSizing,
    };
  }

  if (tp2 && tp2Rr < minRr) {
    return {
      valid: false,
      reason: `نسبة العائد إلى المخاطرة للهدف الثاني TP2 (${tp2RrString}) أقل من 1:${minRr} -> NO TRADE.`,
      riskPercent: 0,
      riskAmount: 0,
      slPoints,
      priceDistance: Number(priceDistance.toFixed(2)),
      tp1Points,
      tp1Distance: Number(tp1Distance.toFixed(2)),
      tp1Rr,
      tp1RrString,
      tp2Points,
      tp2Distance: Number(tp2Distance.toFixed(2)),
      tp2Rr,
      tp2RrString,
      primaryTarget: 'TP1',
      rrRatio: tp1Rr,
      rrString: compositeRrString,
      potentialProfit: 0,
      potentialLoss: 0,
      recommendedLotSize: 0,
      positionSizing: emptyPositionSizing,
    };
  }

  // Calculate Position Sizing
  const positionSizing = calculatePositionSizing(
    balance,
    riskPercent,
    entry,
    stopLoss,
    brokerSpecs
  );

  const riskAmount = positionSizing.estimatedMaxLoss > 0 ? positionSizing.estimatedMaxLoss : positionSizing.riskDollars;
  const actualRiskPercent = Number(((riskAmount / balance) * 100).toFixed(2));
  const potentialLoss = riskAmount;
  // Potential profit based on TP1 (primary target)
  const potentialProfit = Number((riskAmount * tp1Rr).toFixed(2));

  // If position sizing is not executable with current broker specs (e.g. min lot exceeds risk), block trade
  if (!positionSizing.isExecutable) {
    return {
      valid: false,
      reason: positionSizing.nonExecutableReason || 'TRADE BLOCKED: Minimum broker lot exceeds configured risk.',
      riskPercent: actualRiskPercent,
      riskAmount: positionSizing.riskDollars,
      slPoints,
      priceDistance: positionSizing.priceDistance,
      tp1Points,
      tp1Distance: Number(tp1Distance.toFixed(2)),
      tp1Rr,
      tp1RrString,
      tp2Points,
      tp2Distance: Number(tp2Distance.toFixed(2)),
      tp2Rr,
      tp2RrString,
      primaryTarget: 'TP1',
      rrRatio: tp1Rr,
      rrString: compositeRrString,
      potentialProfit: 0,
      potentialLoss: positionSizing.riskDollars,
      recommendedLotSize: positionSizing.standardLotSize,
      positionSizing,
    };
  }

  return {
    valid: true,
    adjustedEntry: wasOptimizedForExecutability ? entry : undefined,
    adjustedStopLoss: wasOptimizedForExecutability ? stopLoss : undefined,
    adjustedTp1: wasOptimizedForExecutability ? tp1 : undefined,
    adjustedTp2: wasOptimizedForExecutability ? tp2 : undefined,
    wasOptimizedForExecutability,
    optimizationNote,
    riskPercent: actualRiskPercent,
    riskAmount,
    slPoints,
    priceDistance: positionSizing.priceDistance,
    tp1Points,
    tp1Distance: Number(tp1Distance.toFixed(2)),
    tp1Rr,
    tp1RrString,
    tp2Points,
    tp2Distance: Number(tp2Distance.toFixed(2)),
    tp2Rr,
    tp2RrString,
    primaryTarget: 'TP1',
    rrRatio: tp1Rr,
    rrString: compositeRrString,
    potentialProfit,
    potentialLoss,
    recommendedLotSize: positionSizing.standardLotSize,
    positionSizing,
  };
}

/**
 * Calculates the XAU/USD spread cost based on lot size.
 *
 * For 0.01 lot, uses a spread cost of exactly $0.30 per trade.
 * Scales proportionally with lot size:
 * - 0.01 lot = $0.30
 * - 0.02 lot = $0.60
 * - 0.10 lot = $3.00
 * - 1.00 lot = $30.00
 *
 * @param lotSize - Lot size (standard lots, e.g., 0.01, 0.02, 0.10, 1.00)
 * @param asset - Asset symbol (defaults to 'XAU/USD')
 * @returns Spread cost in USD
 */
export function calculateSpreadCost(lotSize: number = 0.01, asset: string = 'XAU/USD'): number {
  const normalizedLot = typeof lotSize === 'number' && !isNaN(lotSize) && lotSize > 0 ? lotSize : 0.01;
  return Number(((normalizedLot / 0.01) * 0.30).toFixed(2));
}

export const calculateXauusdSpreadCost = calculateSpreadCost;
export const getSpreadCost = calculateSpreadCost;
