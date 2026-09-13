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
}

export interface RiskCalculationParams {
  balance: number;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2?: number;
  confidence: number;
  isVeryStrongSetup?: boolean;
  losingStreak?: number;
  asset?: 'XAU/USD' | 'BTC/USD';
  brokerSpecs?: Partial<BrokerContractSpecs>;
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
  isExecutable: boolean;
  nonExecutableReason?: string;
  minimumLot: number;
  maximumLot: number;
  lotStep: number;
}

export interface RiskEvaluationResult {
  valid: boolean;
  reason?: string;
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
  minRr: 1.5,
};

/**
 * Calculates position sizing and risk parameters using the exact formula:
 *
 * risk_dollars = account_balance * (risk_percent / 100)
 * price_distance = abs(entry_price - stop_loss)
 * risk_per_standard_lot = price_distance * contract_size_oz
 * standard_lot_size = risk_dollars / risk_per_standard_lot
 *
 * mini_lot_size = standard_lot_size * 10
 * micro_lot_size = standard_lot_size * 100
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

  // Check broker lot constraints
  let isExecutable = true;
  let nonExecutableReason: string | undefined;
  let finalStandardLotSize = standardLotSize;

  if (standardLotSize > maximumLot) {
    isExecutable = false;
    nonExecutableReason = `TRADE NOT EXECUTABLE: Calculated lot (${standardLotSize.toFixed(6)}) exceeds broker maximum lot limit (${maximumLot}).`;
  } else if (standardLotSize < minimumLot) {
    // First determine whether the existing technically valid SL can be used with minimumLot (0.01) while staying within allowed risk
    if (monetaryRiskAtMinLot <= riskDollars + 0.0001) {
      isExecutable = true;
      finalStandardLotSize = minimumLot;
    } else {
      isExecutable = false;
      nonExecutableReason = `TRADE NOT EXECUTABLE: Monetary risk at minimum lot ${minimumLot} ($${monetaryRiskAtMinLot.toFixed(2)}) at existing SL exceeds allowed risk ($${riskDollars.toFixed(2)} / ${riskPercent}%).`;
    }
  } else if (standardLotSize <= 0) {
    isExecutable = false;
    nonExecutableReason = `TRADE NOT EXECUTABLE: Invalid calculated lot size (${standardLotSize.toFixed(6)}).`;
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
    isExecutable,
    nonExecutableReason,
    minimumLot,
    maximumLot,
    lotStep,
  };
}

/**
 * Validates and calculates risk parameters according to strict Gold AI Challenge rules
 */
export function evaluateTradeRisk(params: RiskCalculationParams): RiskEvaluationResult {
  const {
    balance,
    entry,
    stopLoss,
    tp1,
    tp2,
    confidence,
    isVeryStrongSetup = false,
    losingStreak = 0,
    asset = 'XAU/USD',
    brokerSpecs = {},
  } = params;

  const minGoldSlPoints = brokerSpecs.minGoldSlPoints ?? DEFAULT_BROKER_SPECS.minGoldSlPoints ?? 40;
  const maxGoldSlPoints = brokerSpecs.maxGoldSlPoints ?? DEFAULT_BROKER_SPECS.maxGoldSlPoints ?? 50;
  const minRr = brokerSpecs.minRr ?? DEFAULT_BROKER_SPECS.minRr;
  const configuredRiskPercent = brokerSpecs.riskPercent ?? DEFAULT_BROKER_SPECS.riskPercent;

  const emptyPositionSizing: PositionSizingDetails = {
    accountBalance: balance,
    riskPercent: 0,
    riskDollars: 0,
    entryPrice: entry,
    stopLossPrice: stopLoss,
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

  // Gold SL range filter: strictly 40 to 50 points (pips)
  if (asset === 'XAU/USD' && (slPoints < minGoldSlPoints || slPoints > maxGoldSlPoints)) {
    const isBelow = slPoints < minGoldSlPoints;
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
  // Minimum acceptable RR is 1:1.5
  // If TP1 RR < minRr and TP1 is the primary target, reject the setup.
  if (tp1Rr < minRr) {
    return {
      valid: false,
      reason: `نسبة العائد إلى المخاطرة للهدف الأول TP1 (${tp1RrString}) أقل من الحد الأدنى الإلزامي 1:${minRr} -> NO TRADE.`,
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
