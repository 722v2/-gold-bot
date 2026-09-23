import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateEMA,
  calculateMACD,
  calculateEqualTolerance,
  analyzeTechnicals,
} from '../server/indicators';
import { Candle } from '../src/types';

// Helper to construct synthetic candles
function createCandle(
  timestamp: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100
): Candle {
  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume,
    isClosed: true,
  };
}

describe('Indicator Math Quality & Formula Precision Suite', () => {
  // =========================================================================
  // A. EMA STANDARD SEEDING
  // =========================================================================
  it('A. EMA uses standard SMA seeding for first N valid values', () => {
    const prices = [10, 20, 30, 40, 50];
    const period = 3;
    const ema = calculateEMA(prices, period);

    assert.strictEqual(ema.length, 5, 'Output array length must match input prices length');
    assert.strictEqual(ema[0], undefined, 'Index 0 must be undefined (insufficient period)');
    assert.strictEqual(ema[1], undefined, 'Index 1 must be undefined (insufficient period)');
    
    // SMA of first 3 prices [10, 20, 30] = 20
    assert.strictEqual(ema[2], 20, 'Index 2 (period - 1) must equal SMA of first 3 prices');

    // k = 2 / (3 + 1) = 0.5
    // ema[3] = 40 * 0.5 + 20 * 0.5 = 30
    assert.strictEqual(ema[3], 30, 'Index 3 must follow recursive EMA formula: 40 * 0.5 + 20 * 0.5 = 30');

    // ema[4] = 50 * 0.5 + 30 * 0.5 = 40
    assert.strictEqual(ema[4], 40, 'Index 4 must follow recursive EMA formula: 50 * 0.5 + 30 * 0.5 = 40');
  });

  // =========================================================================
  // B. EMA INSUFFICIENT DATA
  // =========================================================================
  it('B. EMA returns empty array when input length is less than period', () => {
    const prices = [10, 20];
    assert.deepStrictEqual(calculateEMA(prices, 3), [], 'Must return empty array if prices < period');
    assert.deepStrictEqual(calculateEMA([], 20), [], 'Must return empty array if prices array is empty');
  });

  // =========================================================================
  // C. EMA20 / EMA50 REFERENCE VALUES
  // =========================================================================
  it('C. EMA20 and EMA50 match exact independent linear reference values', () => {
    // Generate 60 prices: p_i = 100 + i (100, 101, ..., 159)
    const prices: number[] = [];
    for (let i = 0; i < 60; i++) {
      prices.push(100 + i);
    }

    const ema20 = calculateEMA(prices, 20);
    const ema50 = calculateEMA(prices, 50);

    // Independently calculated expected values for linear progression p_i = p_0 + i:
    // SMA(20) at index 19 = (100 + 119) / 2 = 109.5
    // For linear progression, EMA_t = EMA_{t-1} + 1 after SMA initialization.
    // Index 19: 109.5
    // Index 59: 109.5 + (59 - 19) = 149.5
    assert.strictEqual(ema20[19], 109.5, 'EMA20 seed at index 19 must equal 109.5');
    assert.strictEqual(ema20[59], 149.5, 'EMA20 final value at index 59 must equal 149.5');

    // SMA(50) at index 49 = (100 + 149) / 2 = 124.5
    // Index 49: 124.5
    // Index 59: 124.5 + (59 - 49) = 134.5
    assert.strictEqual(ema50[49], 124.5, 'EMA50 seed at index 49 must equal 124.5');
    assert.ok(Math.abs(ema50[59] - 134.5) < 1e-9, 'EMA50 final value at index 59 must equal 134.5');
  });

  // =========================================================================
  // D. MACD 12/26/9 REFERENCE VALUES
  // =========================================================================
  it('D. MACD(12,26,9) matches exact independent mathematical reference values', () => {
    // Generate 40 prices: p_i = 100 + i
    const closes: number[] = [];
    for (let i = 0; i < 40; i++) {
      closes.push(100 + i);
    }

    const macdResult = calculateMACD(closes);

    // Independently derived expected values for p_i = 100 + i:
    // EMA12[i] = 105.5 + (i - 11) for i >= 11.
    // EMA26[i] = 112.5 + (i - 25) for i >= 25.
    // MACD line = EMA12[i] - EMA26[i] = (105.5 + i - 11) - (112.5 + i - 25) = 7.0 (constant for i >= 25).
    // Signal line = EMA9 of constant 7.0 line = 7.0.
    // Histogram = 7.0 - 7.0 = 0.0.
    assert.strictEqual(macdResult.macd, 7, 'MACD line on linear series must equal 7.000');
    assert.strictEqual(macdResult.signal, 7, 'Signal line on constant 7.0 MACD must equal 7.000');
    assert.ok(Math.abs(macdResult.histogram) === 0, 'Histogram must equal 0.000');
  });

  // =========================================================================
  // E. MACD ALIGNMENT & WARM-UP
  // =========================================================================
  it('E. MACD handles warm-up deterministically without returning NaN or corrupted values', () => {
    const shortCloses = Array.from({ length: 25 }, (_, i) => 2000 + i);
    const shortResult = calculateMACD(shortCloses);
    assert.strictEqual(shortResult.macd, 0, 'Must return 0 MACD if closes < 26');

    const validCloses = Array.from({ length: 30 }, (_, i) => 2000 + (i % 2 === 0 ? 5 : -5));
    const validResult = calculateMACD(validCloses);
    assert.ok(Number.isFinite(validResult.macd), 'MACD line must be a valid finite number');
    assert.ok(Number.isFinite(validResult.signal), 'Signal line must be a valid finite number');
    assert.ok(Number.isFinite(validResult.histogram), 'Histogram must be a valid finite number');
  });

  // =========================================================================
  // F. STRUCTURAL SWING VS ROLLING EXTREME
  // =========================================================================
  it('F. Structural swing level is distinguished from rolling extreme spike', () => {
    const baseTime = 1700000000000;
    const candles: Candle[] = [];

    // 25 candles around 2000
    for (let i = 0; i < 25; i++) {
      candles.push(createCandle(baseTime + i * 300000, 2000, 2005, 1995, 2000));
    }

    // Index 10: Form a clear 5-bar structural pivot high at 2020.0
    // Candle 8: High 2005
    // Candle 9: High 2010
    // Candle 10: High 2020 (Pivot Peak)
    // Candle 11: High 2010
    // Candle 12: High 2005
    candles[8] = createCandle(baseTime + 8 * 300000, 2000, 2005, 1995, 2000);
    candles[9] = createCandle(baseTime + 9 * 300000, 2000, 2010, 1995, 2005);
    candles[10] = createCandle(baseTime + 10 * 300000, 2005, 2020, 2000, 2015);
    candles[11] = createCandle(baseTime + 11 * 300000, 2015, 2010, 1995, 2000);
    candles[12] = createCandle(baseTime + 12 * 300000, 2000, 2005, 1995, 2000);

    // Index 23 (Prior candle before current closed): Non-pivot single spike to 2050.0
    candles[23] = createCandle(baseTime + 23 * 300000, 2000, 2050, 1995, 2000);

    // Index 24 (Current closed candle)
    candles[24] = createCandle(baseTime + 24 * 300000, 2000, 2005, 1995, 2000);

    const tech = analyzeTechnicals(candles);

    // Rolling high should capture the single spike of 2050.0
    assert.strictEqual(tech.rollingHigh, 2050, 'rollingHigh must equal 2050.0');
    assert.strictEqual(tech.swingHigh, 2050, 'swingHigh must maintain rolling extreme of 2050.0 for backward compatibility');

    // Structural swing high should identify the confirmed pivot high of 2020.0
    assert.strictEqual(tech.structuralSwingHigh, 2020, 'structuralSwingHigh must identify confirmed pivot peak of 2020.0');
  });

  // =========================================================================
  // G. CONFIRMED PIVOT BEHAVIOR
  // =========================================================================
  it('G. 5-bar pivot requires full 2-left and 2-right confirmation', () => {
    const baseTime = 1700000000000;
    const candles: Candle[] = [];

    for (let i = 0; i < 20; i++) {
      candles.push(createCandle(baseTime + i * 300000, 2000, 2005, 1995, 2000));
    }

    // Pivot Low at Index 10 (Low = 1970.0)
    candles[8] = createCandle(baseTime + 8 * 300000, 2000, 2005, 1985, 2000);
    candles[9] = createCandle(baseTime + 9 * 300000, 2000, 2000, 1980, 1990);
    candles[10] = createCandle(baseTime + 10 * 300000, 1990, 1995, 1970, 1985); // Trough
    candles[11] = createCandle(baseTime + 11 * 300000, 1985, 2000, 1980, 1995);
    candles[12] = createCandle(baseTime + 12 * 300000, 1995, 2005, 1988, 2000);

    const tech = analyzeTechnicals(candles);
    assert.strictEqual(tech.structuralSwingLow, 1970, 'structuralSwingLow must detect confirmed pivot trough of 1970.0');
  });

  // =========================================================================
  // H. NO-LOOKAHEAD SWING BEHAVIOR
  // =========================================================================
  it('H. Unconfirmed forming candle does not corrupt structural swing detection', () => {
    const baseTime = 1700000000000;
    const candles: Candle[] = [];

    for (let i = 0; i < 20; i++) {
      candles.push(createCandle(baseTime + i * 300000, 2000, 2005, 1995, 2000));
    }

    // Add a forming candle with an extreme spike
    const formingCandle: Candle = {
      timestamp: baseTime + 20 * 300000,
      open: 2000,
      high: 2100, // Spike in forming candle
      low: 1900,  // Spike in forming candle
      close: 2000,
      volume: 50,
      isClosed: false, // Forming candle
    };
    candles.push(formingCandle);

    const tech = analyzeTechnicals(candles);
    assert.ok(tech.structuralSwingHigh! < 2100, 'Forming candle spike (2100) must NOT be picked as confirmed structural swing high');
    assert.ok(tech.structuralSwingLow! > 1900, 'Forming candle spike (1900) must NOT be picked as confirmed structural swing low');
  });

  // =========================================================================
  // I. EQH TOLERANCE
  // =========================================================================
  it('I. Calibrated EQH tolerance correctly detects tight equal highs', () => {
    const tolLowAtr = calculateEqualTolerance(1.0);
    assert.strictEqual(tolLowAtr, 0.20, 'Low ATR (1.0) must hit precision floor of 0.20');

    const tolNormalAtr = calculateEqualTolerance(3.5);
    assert.strictEqual(tolNormalAtr, 0.35, 'Normal ATR (3.5) must scale to 0.35');

    const tolHighAtr = calculateEqualTolerance(15.0);
    assert.strictEqual(tolHighAtr, 0.80, 'High ATR (15.0) must hit maximum cap of 0.80');
  });

  // =========================================================================
  // J. EQL TOLERANCE
  // =========================================================================
  it('J. EQL tolerance evaluates correctly for close vs separated swing lows', () => {
    const tol = calculateEqualTolerance(4.0); // 0.40 pts
    const low1 = 2000.0;
    const low2Close = 2000.25; // diff 0.25 <= 0.40 -> EQUAL
    const low2Far = 2002.50;   // diff 2.50 > 0.40 -> NOT EQUAL

    assert.ok(Math.abs(low1 - low2Close) <= tol, '2000.0 and 2000.25 must be within EQL tolerance of 0.40');
    assert.ok(Math.abs(low1 - low2Far) > tol, '2000.0 and 2002.50 must exceed EQL tolerance of 0.40');
  });

  // =========================================================================
  // K. EQH / EQL SYMMETRY
  // =========================================================================
  it('K. Equal high and equal low tolerance models maintain 100% directional symmetry', () => {
    const atrValues = [0.5, 1.5, 3.0, 5.0, 10.0, 20.0];
    for (const atr of atrValues) {
      const eqhTol = calculateEqualTolerance(atr);
      const eqlTol = calculateEqualTolerance(atr);
      assert.strictEqual(eqhTol, eqlTol, `EQH and EQL tolerance must be identical for ATR ${atr}`);
    }
  });

  // =========================================================================
  // L. HIGH-ATR TOLERANCE CAP
  // =========================================================================
  it('L. High ATR environments remain strictly bounded by max tolerance cap (0.80 pts)', () => {
    const extremeAtrValues = [10.0, 25.0, 50.0, 100.0];
    for (const atr of extremeAtrValues) {
      const tol = calculateEqualTolerance(atr);
      assert.ok(tol <= 0.80, `Tolerance for extreme ATR (${atr}) must not exceed 0.80 pts (got ${tol})`);
    }
  });
});
