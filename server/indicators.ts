import { Candle, TechnicalIndicators } from '../src/types.js';

// Calculate Exponential Moving Average (EMA)
export function calculateEMA(prices: number[], period: number): number[] {
  if (prices.length === 0) return [];
  const k = 2 / (period + 1);
  const emaArray: number[] = new Array(prices.length);
  
  // Start with Simple Moving Average for the first `period` elements
  let sum = 0;
  const initialPeriod = Math.min(period, prices.length);
  for (let i = 0; i < initialPeriod; i++) {
    sum += prices[i];
    emaArray[i] = sum / (i + 1);
  }
  
  for (let i = initialPeriod; i < prices.length; i++) {
    emaArray[i] = prices[i] * k + emaArray[i - 1] * (1 - k);
  }
  return emaArray;
}

// Calculate Relative Strength Index (RSI 14)
export function calculateRSI(closes: number[], period: number = 14): number {
  if (closes.length <= period) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

// Calculate MACD (12, 26, 9)
export function calculateMACD(closes: number[]): { macd: number; signal: number; histogram: number } {
  if (closes.length < 26) {
    return { macd: 0, signal: 0, histogram: 0 };
  }
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(ema12[i] - ema26[i]);
  }
  
  const signalLine = calculateEMA(macdLine, 9);
  const latestMacd = macdLine[macdLine.length - 1];
  const latestSignal = signalLine[signalLine.length - 1];
  const histogram = latestMacd - latestSignal;
  
  return {
    macd: Number(latestMacd.toFixed(3)),
    signal: Number(latestSignal.toFixed(3)),
    histogram: Number(histogram.toFixed(3)),
  };
}

// Calculate Average True Range (ATR 14)
export function calculateATR(candles: Candle[], period: number = 14): number {
  if (candles.length < 2) return 1.0;
  const trs: number[] = [];
  
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }
  
  const initialPeriod = Math.min(period, trs.length);
  let atr = trs.slice(0, initialPeriod).reduce((a, b) => a + b, 0) / initialPeriod;
  
  for (let i = initialPeriod; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  
  return Number(atr.toFixed(2));
}

// Calculate Bollinger Bands (20, 2)
export function calculateBollingerBands(closes: number[], period: number = 20): { upper: number; middle: number; lower: number } {
  if (closes.length === 0) return { upper: 0, middle: 0, lower: 0 };
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  
  const variance = slice.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / slice.length;
  const stdDev = Math.sqrt(variance);
  
  return {
    upper: Number((mean + 2 * stdDev).toFixed(2)),
    middle: Number(mean.toFixed(2)),
    lower: Number((mean - 2 * stdDev).toFixed(2)),
  };
}

// Calculate Volume Weighted Average Price (VWAP)
export function calculateVWAP(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  let cumulativeTypicalPriceVolume = 0;
  let cumulativeVolume = 0;
  
  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumulativeTypicalPriceVolume += typicalPrice * c.volume;
    cumulativeVolume += c.volume;
  }
  
  if (cumulativeVolume === 0) return candles[candles.length - 1].close;
  return Number((cumulativeTypicalPriceVolume / cumulativeVolume).toFixed(2));
}

// Detect Price Action, SMC/ICT structure, Swing Points, OB, and FVG
export function analyzeTechnicals(candles: Candle[]): TechnicalIndicators {
  const closes = candles.map((c) => c.close);
  const latestClose = closes[closes.length - 1];
  
  const ema20Arr = calculateEMA(closes, 20);
  const ema50Arr = calculateEMA(closes, 50);
  const ema200Arr = calculateEMA(closes, 200);
  
  const ema20 = Number((ema20Arr[ema20Arr.length - 1] || latestClose).toFixed(2));
  const ema50 = Number((ema50Arr[ema50Arr.length - 1] || latestClose).toFixed(2));
  const ema200 = Number((ema200Arr[ema200Arr.length - 1] || latestClose).toFixed(2));
  
  const rsi14 = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);
  const atr14 = calculateATR(candles, 14);
  const bollingerBands = calculateBollingerBands(closes, 20);
  const vwap = calculateVWAP(candles.slice(-50)); // Last 50 candles for intraday VWAP
  
  // Find Swing Highs and Lows in last 30 candles
  const window = Math.min(30, candles.length);
  const recent = candles.slice(-window);
  
  let swingHigh = Math.max(...recent.map((c) => c.high));
  let swingLow = Math.min(...recent.map((c) => c.low));
  
  // Identify Support & Resistance from swing levels
  const resistance = swingHigh;
  const support = swingLow;
  
  // Determine Market Structure
  let structure: 'BULLISH' | 'BEARISH' | 'RANGING' = 'RANGING';
  if (latestClose > ema50 && ema20 > ema50) {
    structure = 'BULLISH';
  } else if (latestClose < ema50 && ema20 < ema50) {
    structure = 'BEARISH';
  }
  
  // Order Block detection (last opposite candle before displacement)
  let orderBlock: TechnicalIndicators['orderBlock'] = undefined;
  for (let i = recent.length - 2; i >= 3; i--) {
    const c = recent[i];
    const prev = recent[i - 1];
    const next = recent[i + 1];
    
    // Bullish OB: Bearish candle followed by strong bullish expansion
    if (c.close < c.open && next.close > c.open && (next.high - next.low) > atr14 * 0.8) {
      orderBlock = {
        type: 'BULLISH',
        high: Number(Math.max(c.open, c.close).toFixed(2)),
        low: Number(c.low.toFixed(2)),
      };
      break;
    }
    // Bearish OB: Bullish candle followed by strong bearish displacement
    if (c.close > c.open && next.close < c.low && (next.high - next.low) > atr14 * 0.8) {
      orderBlock = {
        type: 'BEARISH',
        high: Number(c.high.toFixed(2)),
        low: Number(Math.min(c.open, c.close).toFixed(2)),
      };
      break;
    }
  }
  
  // Fair Value Gap (FVG) detection
  let fvg: TechnicalIndicators['fvg'] = undefined;
  for (let i = recent.length - 2; i >= 2; i--) {
    const c1 = recent[i - 2];
    const c3 = recent[i];
    
    // Bullish FVG: candle 1 high < candle 3 low
    if (c3.low > c1.high && c3.low - c1.high > atr14 * 0.2) {
      fvg = {
        type: 'BULLISH',
        top: Number(c3.low.toFixed(2)),
        bottom: Number(c1.high.toFixed(2)),
      };
      break;
    }
    // Bearish FVG: candle 1 low > candle 3 high
    if (c1.low > c3.high && c1.low - c3.high > atr14 * 0.2) {
      fvg = {
        type: 'BEARISH',
        top: Number(c1.low.toFixed(2)),
        bottom: Number(c3.high.toFixed(2)),
      };
      break;
    }
  }
  
  // Liquidity sweep check: did the latest or recent candle pierce swing high/low and close back inside?
  const lastCandle = recent[recent.length - 1];
  const prevCandle = recent[recent.length - 2];
  const prevHigh = Math.max(...recent.slice(0, -2).map((c) => c.high));
  const prevLow = Math.min(...recent.slice(0, -2).map((c) => c.low));
  
  const sweptHigh = (lastCandle.high > prevHigh && lastCandle.close < prevHigh) || 
                    (prevCandle && prevCandle.high > prevHigh && lastCandle.close < prevHigh);
  const sweptLow = (lastCandle.low < prevLow && lastCandle.close > prevLow) ||
                   (prevCandle && prevCandle.low < prevLow && lastCandle.close > prevLow);
  const liquiditySweepDetected = sweptHigh || sweptLow;
  
  // Premium / Discount calculation
  const range = swingHigh - swingLow;
  const equilibrium = swingLow + range * 0.5;
  let premiumDiscountZone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' = 'EQUILIBRIUM';
  if (range > 0) {
    if (latestClose > equilibrium + range * 0.1) {
      premiumDiscountZone = 'PREMIUM';
    } else if (latestClose < equilibrium - range * 0.1) {
      premiumDiscountZone = 'DISCOUNT';
    }
  }
  
  let structureShift: string | undefined = undefined;
  let chochDetected = false;
  let bosDetected = false;

  // Split recent candles into prior half and current half to determine HH/HL or LH/LL
  const halfWindow = Math.floor(recent.length / 2);
  const priorHalf = recent.slice(0, halfWindow);
  const latterHalf = recent.slice(halfWindow);

  const priorHigh = Math.max(...priorHalf.map((c) => c.high));
  const priorLow = Math.min(...priorHalf.map((c) => c.low));
  const latterHigh = Math.max(...latterHalf.map((c) => c.high));
  const latterLow = Math.min(...latterHalf.map((c) => c.low));

  let trendStructure: 'HH_HL' | 'LH_LL' | 'RANGING' = 'RANGING';
  if (latterHigh > priorHigh && latterLow > priorLow) {
    trendStructure = 'HH_HL'; // Higher Highs & Higher Lows (Bullish Structure)
  } else if (latterHigh < priorHigh && latterLow < priorLow) {
    trendStructure = 'LH_LL'; // Lower Highs & Lower Lows (Bearish Structure)
  }

  // CHOCH (Change of Character): Reversal breaking the structural pivot
  if (trendStructure === 'HH_HL' && latestClose < priorLow) {
    chochDetected = true;
    structureShift = 'Bearish CHOCH (Change of Character)';
  } else if (trendStructure === 'LH_LL' && latestClose > priorHigh) {
    chochDetected = true;
    structureShift = 'Bullish CHOCH (Change of Character)';
  } else if (latestClose > swingHigh) {
    bosDetected = true;
    structureShift = 'Bullish BOS (Break of Structure)';
  } else if (latestClose < swingLow) {
    bosDetected = true;
    structureShift = 'Bearish BOS (Break of Structure)';
  } else if (sweptHigh && latestClose < ema20) {
    structureShift = 'Bearish MSS after Liquidity Sweep';
  } else if (sweptLow && latestClose > ema20) {
    structureShift = 'Bullish MSS after Liquidity Sweep';
  }

  // Liquidity levels: Buy-side liquidity (BSL) above swing highs, Sell-side liquidity (SSL) below swing lows
  const liquidityLevels = {
    buySideLiquidity: Number(swingHigh.toFixed(2)),
    sellSideLiquidity: Number(swingLow.toFixed(2)),
  };

  return {
    ema20,
    ema50,
    ema200,
    vwap,
    rsi14,
    macd,
    atr14,
    bollingerBands,
    swingHigh: Number(swingHigh.toFixed(2)),
    swingLow: Number(swingLow.toFixed(2)),
    support: Number(support.toFixed(2)),
    resistance: Number(resistance.toFixed(2)),
    structure,
    structureShift,
    trendStructure,
    chochDetected,
    bosDetected,
    liquidityLevels,
    orderBlock,
    fvg,
    liquiditySweepDetected,
    premiumDiscountZone,
  };
}
