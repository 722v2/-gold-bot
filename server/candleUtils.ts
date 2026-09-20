import { Candle } from '../src/types.js';

export interface CandlePartitionResult {
  isValid: boolean;
  unreliableReason?: string;
  formingCandle: Candle | null;
  closedCandles: Candle[];
  lastClosedCandle: Candle | null;
  prevClosedCandle: Candle | null;
}

const TF_1M_MS = 1 * 60 * 1000;
const TF_5M_MS = 5 * 60 * 1000; // 300,000 ms
const TF_15M_MS = 15 * 60 * 1000; // 900,000 ms
const TF_1H_MS = 60 * 60 * 1000; // 3,600,000 ms

/**
 * Generic timeframe candle partitioning engine.
 * Distinguishes forming candle from confirmed closed candles for any timeframe (1M, 5M, 15M, 1H).
 */
export function partitionCandlesByTimeframe(
  candles: Candle[],
  timeframeMs: number,
  referenceTime?: number
): CandlePartitionResult {
  if (!candles || !Array.isArray(candles) || candles.length === 0) {
    return {
      isValid: false,
      unreliableReason: 'NO_CANDLE_DATA: Candle array is missing or empty',
      formingCandle: null,
      closedCandles: [],
      lastClosedCandle: null,
      prevClosedCandle: null,
    };
  }

  const now = referenceTime !== undefined ? referenceTime : Date.now();
  if (typeof now !== 'number' || isNaN(now) || !isFinite(now) || now <= 0) {
    return {
      isValid: false,
      unreliableReason: 'UNRELIABLE_REFERENCE_TIME: Market reference time is invalid or non-positive',
      formingCandle: null,
      closedCandles: [],
      lastClosedCandle: null,
      prevClosedCandle: null,
    };
  }

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (typeof c.timestamp !== 'number' || isNaN(c.timestamp) || !isFinite(c.timestamp) || c.timestamp <= 0) {
      return {
        isValid: false,
        unreliableReason: `UNRELIABLE_TIMESTAMPS: Candle at index ${i} has invalid timestamp (${c.timestamp})`,
        formingCandle: null,
        closedCandles: [],
        lastClosedCandle: null,
        prevClosedCandle: null,
      };
    }
  }

  const lastCandle = candles[candles.length - 1];

  if (lastCandle.timestamp > now + 15000) {
    return {
      isValid: false,
      unreliableReason: `UNRELIABLE_TIMESTAMPS: Latest candle timestamp (${lastCandle.timestamp}) is in the future relative to market time (${now})`,
      formingCandle: null,
      closedCandles: [],
      lastClosedCandle: null,
      prevClosedCandle: null,
    };
  }

  let isLastCandleForming: boolean;
  if (lastCandle.isClosed === false) {
    isLastCandleForming = true;
  } else if (lastCandle.isClosed === true) {
    isLastCandleForming = false;
  } else {
    isLastCandleForming = now < lastCandle.timestamp + timeframeMs;
  }

  let formingCandle: Candle | null = null;
  let closedCandles: Candle[] = [];

  if (isLastCandleForming) {
    formingCandle = lastCandle;
    closedCandles = candles.slice(0, -1);
  } else {
    closedCandles = [...candles];
  }

  const lastClosedCandle = closedCandles.length > 0 ? closedCandles[closedCandles.length - 1] : null;
  const prevClosedCandle = closedCandles.length > 1 ? closedCandles[closedCandles.length - 2] : null;

  if (!lastClosedCandle) {
    return {
      isValid: false,
      unreliableReason: 'NO_CLOSED_CANDLE: No closed candle available after isolating forming candle',
      formingCandle,
      closedCandles: [],
      lastClosedCandle: null,
      prevClosedCandle: null,
    };
  }

  return {
    isValid: true,
    formingCandle,
    closedCandles,
    lastClosedCandle,
    prevClosedCandle,
  };
}

export function partition1mCandles(
  candles1m: Candle[],
  referenceTime?: number
): CandlePartitionResult {
  return partitionCandlesByTimeframe(candles1m, TF_1M_MS, referenceTime);
}

export function partition5mCandles(
  candles5m: Candle[],
  referenceTime?: number
): CandlePartitionResult {
  return partitionCandlesByTimeframe(candles5m, TF_5M_MS, referenceTime);
}

export function partition15mCandles(
  candles15m: Candle[],
  referenceTime?: number
): CandlePartitionResult {
  return partitionCandlesByTimeframe(candles15m, TF_15M_MS, referenceTime);
}

export function partition1hCandles(
  candles1h: Candle[],
  referenceTime?: number
): CandlePartitionResult {
  return partitionCandlesByTimeframe(candles1h, TF_1H_MS, referenceTime);
}

export function getClosed5mCandleForTrigger(
  candles5m: Candle[],
  referenceTime?: number
): Candle | null {
  const result = partition5mCandles(candles5m, referenceTime);
  return result.isValid ? result.lastClosedCandle : null;
}
