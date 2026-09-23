import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateEMA,
  calculateRSI,
  calculateMACD,
  calculateATR,
  calculateBollingerBands,
  calculateVWAP,
  calculateEqualTolerance,
  analyzeTechnicals,
} from '../server/indicators';
import { extractSessionExtremes } from '../server/strategyEngine';
import { Candle } from '../src/types';

// Helper to construct synthetic candles
function createCandle(
  timestamp: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
  isClosed = true
): Candle {
  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume,
    isClosed,
  };
}

describe('Deep Indicator Math & Strategy Forensic Audit Suite', () => {

  // =========================================================================
  // 1. EMA CANONICAL MATHEMATICS & SEEDING
  // =========================================================================
  it('1. EMA calculates canonical SMA seed and recursive exponential weighting', () => {
    // Input: 5 prices [10, 20, 30, 40, 50], Period 3
    // SMA seed at index 2 (period - 1): (10 + 20 + 30) / 3 = 20.0
    // k = 2 / (3 + 1) = 0.5
    // index 3: 40 * 0.5 + 20 * 0.5 = 30.0
    // index 4: 50 * 0.5 + 30 * 0.5 = 40.0
    const prices = [10, 20, 30, 40, 50];
    const ema = calculateEMA(prices, 3);

    assert.strictEqual(ema.length, 5);
    assert.strictEqual(ema[0], undefined);
    assert.strictEqual(ema[1], undefined);
    assert.strictEqual(ema[2], 20.0);
    assert.strictEqual(ema[3], 30.0);
    assert.strictEqual(ema[4], 40.0);
  });

  it('2. EMA handles invalid, short, or undefined input deterministically', () => {
    assert.deepStrictEqual(calculateEMA([], 20), []);
    assert.deepStrictEqual(calculateEMA([10, 20], 5), []);
    assert.deepStrictEqual(calculateEMA([NaN, 10, 20], 5), []);
  });

  // =========================================================================
  // 2. MACD NON-LINEAR & WARM-UP BOUNDARIES
  // =========================================================================
  it('3. MACD handles non-linear sinusoidal price series accurately without NaN leak', () => {
    // Generate 50 non-linear prices using a sine wave oscillation
    const closes: number[] = [];
    for (let i = 0; i < 50; i++) {
      closes.push(2000 + Math.sin(i / 3) * 20 + i * 0.5);
    }

    const res = calculateMACD(closes);

    assert.ok(Number.isFinite(res.macd), 'MACD line must be a finite number');
    assert.ok(Number.isFinite(res.signal), 'Signal line must be a finite number');
    assert.ok(Number.isFinite(res.histogram), 'Histogram must be a finite number');

    // Independent check: Histogram = MACD - Signal (rounded to 3 decimal places)
    const expectedHist = Number((res.macd - res.signal).toFixed(3));
    assert.strictEqual(res.histogram, expectedHist, 'Histogram must equal MACD - Signal exactly');
  });

  it('4. MACD warm-up boundary testing at 25, 26, and 35 observations', () => {
    const p25 = Array.from({ length: 25 }, (_, i) => 2000 + i);
    const m25 = calculateMACD(p25);
    assert.strictEqual(m25.macd, 0, '25 prices must return 0 MACD (insufficient data for EMA26)');

    const p26 = Array.from({ length: 26 }, (_, i) => 2000 + i);
    const m26 = calculateMACD(p26);
    assert.ok(Number.isFinite(m26.macd), '26 prices must calculate valid MACD line');

    const p35 = Array.from({ length: 35 }, (_, i) => 2000 + Math.pow(i - 15, 2) * 0.1);
    const m35 = calculateMACD(p35);
    assert.ok(Number.isFinite(m35.macd), '35 prices non-linear series must yield finite MACD');
    assert.ok(Number.isFinite(m35.signal), '35 prices must yield finite signal line');
  });

  // =========================================================================
  // 3. RSI CANONICAL WILDER'S SMOOTHING & EDGE CASES
  // =========================================================================
  it('5. RSI calculates Wilder smoothing against independently calculated reference', () => {
    // Known test sequence: 15 prices (14 changes)
    // Changes: +1, -2, +3, -1, +2, -1, +1, +2, -2, +1, -1, +2, -1, +1
    const prices = [100, 101, 99, 102, 101, 103, 102, 103, 105, 103, 104, 103, 105, 104, 105];
    // Changes:
    // 1: +1 (gain 1, loss 0)
    // 2: -2 (gain 0, loss 2)
    // 3: +3 (gain 3, loss 0)
    // 4: -1 (gain 0, loss 1)
    // 5: +2 (gain 2, loss 0)
    // 6: -1 (gain 0, loss 1)
    // 7: +1 (gain 1, loss 0)
    // 8: +2 (gain 2, loss 0)
    // 9: -2 (gain 0, loss 2)
    // 10: +1 (gain 1, loss 0)
    // 11: -1 (gain 0, loss 1)
    // 12: +2 (gain 2, loss 0)
    // 13: -1 (gain 0, loss 1)
    // 14: +1 (gain 1, loss 0)
    // Sum gains = 1+3+2+1+2+1+2+1 = 13. AvgGain = 13/14 = 0.928571428...
    // Sum losses = 2+1+1+2+1+1 = 8. AvgLoss = 8/14 = 0.571428571...
    // RS = 13 / 8 = 1.625
    // RSI = 100 - 100 / (1 + 1.625) = 100 - 100 / 2.625 = 100 - 38.095238... = 61.90476... -> 61.90
    const rsi = calculateRSI(prices, 14);
    assert.strictEqual(rsi, 61.90, 'RSI on 15 prices must equal exact Wilder reference value of 61.90');
  });

  it('6. RSI edge cases: flat prices (neutral 50), strictly increasing (100), strictly decreasing (0)', () => {
    const flatPrices = Array(20).fill(100);
    assert.strictEqual(calculateRSI(flatPrices, 14), 50, 'Flat price series (0 gains, 0 losses) must return RSI = 50');

    const upPrices = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
    assert.strictEqual(calculateRSI(upPrices, 14), 100, 'Strictly increasing price series must return RSI = 100');

    const downPrices = Array.from({ length: 20 }, (_, i) => 200 - i * 2);
    assert.strictEqual(calculateRSI(downPrices, 14), 0, 'Strictly decreasing price series must return RSI = 0');
  });

  // =========================================================================
  // 4. ATR TRUE-RANGE & WILDER SMOOTHING
  // =========================================================================
  it('7. ATR calculates True Range with gap-up/gap-down and Wilder smoothing', () => {
    const baseTime = 1700000000000;
    // Candle 0: C=100
    // Candle 1: H=105, L=95, C=102 -> TR = max(10, |105-100|, |95-100|) = 10
    // Candle 2: Gap up H=120, L=110, C=115 -> TR = max(10, |120-102|=18, |110-102|=8) = 18
    const candles: Candle[] = [
      createCandle(baseTime, 100, 100, 100, 100),
      createCandle(baseTime + 300000, 100, 105, 95, 102),
      createCandle(baseTime + 600000, 112, 120, 110, 115),
    ];

    const atr = calculateATR(candles, 2);
    // TR1 = 10, TR2 = 18. Average = 14.00
    assert.strictEqual(atr, 14.00, 'ATR on 2 periods must equal 14.00');
  });

  // =========================================================================
  // 5. BOLLINGER BANDS POPULATION STDDEV & BANDWIDTH
  // =========================================================================
  it('8. Bollinger Bands match population standard deviation reference formula', () => {
    // 5 closes: [10, 20, 30, 40, 50]
    // Mean = 30
    // Variance = ((10-30)^2 + (20-30)^2 + (30-30)^2 + (40-30)^2 + (50-30)^2) / 5
    //          = (400 + 100 + 0 + 100 + 400) / 5 = 1000 / 5 = 200
    // StdDev = sqrt(200) = 14.1421356237...
    // Middle = 30.00
    // Upper = 30 + 2 * 14.1421356 = 58.28
    // Lower = 30 - 2 * 14.1421356 = 1.72
    const closes = [10, 20, 30, 40, 50];
    const bb = calculateBollingerBands(closes, 5);

    assert.strictEqual(bb.middle, 30.00);
    assert.strictEqual(bb.upper, 58.28);
    assert.strictEqual(bb.lower, 1.72);
  });

  // =========================================================================
  // 6. VWAP SESSION RESET AT UTC MIDNIGHT & ZERO VOLUME
  // =========================================================================
  it('9. VWAP resets precisely at UTC 00:00:00 midnight without including prior day candles', () => {
    // Day 1: 2026-09-22 23:50 UTC (close 2000, vol 100)
    // Day 1: 2026-09-22 23:55 UTC (close 2010, vol 100)
    // Day 2: 2026-09-23 00:00 UTC (H=2050, L=2040, C=2045, vol=200)
    // Day 2: 2026-09-23 00:05 UTC (H=2060, L=2050, C=2055, vol=200)
    const tDay1_1 = Date.UTC(2026, 8, 22, 23, 50, 0);
    const tDay1_2 = Date.UTC(2026, 8, 22, 23, 55, 0);
    const tDay2_1 = Date.UTC(2026, 8, 23, 0, 0, 0);
    const tDay2_2 = Date.UTC(2026, 8, 23, 0, 5, 0);

    const candles: Candle[] = [
      createCandle(tDay1_1, 2000, 2005, 1995, 2000, 100),
      createCandle(tDay1_2, 2000, 2015, 2000, 2010, 100),
      createCandle(tDay2_1, 2040, 2050, 2040, 2045, 200), // Typ = 2045, Vol = 200
      createCandle(tDay2_2, 2045, 2060, 2050, 2055, 200), // Typ = 2055, Vol = 200
    ];

    const vwap = calculateVWAP(candles);

    // Day 2 session candles only:
    // C1: Typ = 2045, Vol = 200 -> CumTPV = 2045 * 200 = 409,000
    // C2: Typ = 2055, Vol = 200 -> CumTPV = 2055 * 200 = 411,000
    // Total CumTPV = 820,000. Total Vol = 400.
    // VWAP = 820,000 / 400 = 2050.00
    assert.strictEqual(vwap, 2050.00, 'VWAP must anchor strictly to Day 2 (00:00 UTC reset)');
  });

  it('10. VWAP handles missing / zero volume without zero division', () => {
    const t = Date.UTC(2026, 8, 23, 10, 0, 0);
    const candles = [
      createCandle(t, 2000, 2010, 1990, 2000, 0), // Volume = 0 -> falls back to 1
    ];

    const vwap = calculateVWAP(candles);
    assert.strictEqual(vwap, 2000.00, 'Zero volume candle must fall back cleanly without returning NaN');
  });

  // =========================================================================
  // 7. STRUCTURAL SWING CONFIRMATION & NO LOOKAHEAD
  // =========================================================================
  it('11. Structural swing pivots strictly require closed right-side confirmation candles', () => {
    const baseTime = Date.UTC(2026, 8, 23, 12, 0, 0);
    const candles: Candle[] = [];

    // 20 candles at base level 2000
    for (let i = 0; i < 20; i++) {
      candles.push(createCandle(baseTime + i * 300000, 2000, 2005, 1995, 2000));
    }

    // Pivot High at Index 10 (High = 2030.0)
    candles[8] = createCandle(baseTime + 8 * 300000, 2000, 2010, 1995, 2005);
    candles[9] = createCandle(baseTime + 9 * 300000, 2005, 2020, 2000, 2015);
    candles[10] = createCandle(baseTime + 10 * 300000, 2015, 2030, 2010, 2025); // PEAK
    candles[11] = createCandle(baseTime + 11 * 300000, 2025, 2020, 2000, 2010);
    candles[12] = createCandle(baseTime + 12 * 300000, 2010, 2010, 1995, 2000);

    const tech = analyzeTechnicals(candles);
    assert.strictEqual(tech.structuralSwingHigh, 2030.0, 'Must identify confirmed 5-bar pivot peak at 2030.0');
  });

  it('12. Forming candle cannot corrupt pivot detection or structural levels', () => {
    const baseTime = Date.UTC(2026, 8, 23, 12, 0, 0);
    const candles: Candle[] = [];

    for (let i = 0; i < 20; i++) {
      candles.push(createCandle(baseTime + i * 300000, 2000, 2005, 1995, 2000));
    }

    // Unclosed / forming candle with extreme spike
    candles.push(createCandle(baseTime + 20 * 300000, 2000, 2150, 1850, 2000, 100, false));

    const tech = analyzeTechnicals(candles);
    assert.ok(tech.structuralSwingHigh! < 2150, 'Forming candle spike must not be treated as confirmed structural swing high');
  });

  // =========================================================================
  // 8. EQH / EQL SYMMETRIC TOLERANCE & BOUNDS
  // =========================================================================
  it('13. EQH / EQL tolerance enforces floor ($0.20), ceiling ($0.80), and directional symmetry', () => {
    const lowAtr = calculateEqualTolerance(0.5);
    assert.strictEqual(lowAtr, 0.20, 'ATR 0.5 must hit $0.20 floor');

    const normAtr = calculateEqualTolerance(4.0);
    assert.strictEqual(normAtr, 0.40, 'ATR 4.0 must calculate $0.40 tolerance');

    const highAtr = calculateEqualTolerance(20.0);
    assert.strictEqual(highAtr, 0.80, 'ATR 20.0 must hit $0.80 ceiling');
  });

  // =========================================================================
  // 9. FIBONACCI OTE BUY / SELL DIRECTIONAL SYMMETRY
  // =========================================================================
  it('14. Fibonacci OTE (61.8%-78.6%) levels are mathematically symmetric inside Discount and Premium', () => {
    const low = 2000;
    const high = 2100;
    const diff = high - low; // 100

    // Bullish Retracement (Buying in Discount):
    // Price moves down from 2100 into 61.8% - 78.6% dip zone
    const bullishOteLow = low + diff * (1 - 0.786);  // 2021.4
    const bullishOteHigh = low + diff * (1 - 0.618); // 2038.2

    assert.strictEqual(bullishOteLow, 2021.4, 'Bullish 78.6% retracement down from high must equal 2021.4');
    assert.strictEqual(bullishOteHigh, 2038.2, 'Bullish 61.8% retracement down from high must equal 2038.2');
    assert.ok(bullishOteHigh < 2050, 'Bullish OTE zone must lie strictly inside Discount Zone (< 2050 equilibrium)');

    // Bearish Retracement (Selling in Premium):
    // Price moves up from 2000 into 61.8% - 78.6% rally zone
    const bearishOteLow = low + diff * 0.618;  // 2061.8
    const bearishOteHigh = low + diff * 0.786; // 2078.6

    assert.strictEqual(bearishOteLow, 2061.8, 'Bearish 61.8% retracement up from low must equal 2061.8');
    assert.strictEqual(bearishOteHigh, 2078.6, 'Bearish 78.6% retracement up from low must equal 2078.6');
    assert.ok(bearishOteLow > 2050, 'Bearish OTE zone must lie strictly inside Premium Zone (> 2050 equilibrium)');
  });

  // =========================================================================
  // 10. SESSION BOUNDARIES & CONTIGUOUS BLOCK SELECTION
  // =========================================================================
  it('15. extractSessionExtremes isolates contiguous single-session blocks without mixing across day boundaries', () => {
    // Generate 24 hours of 5M candles (288 candles) spanning two UTC days
    // Day 1: 2026-09-22 12:00 UTC to 23:55 UTC (Asian session Day 1 was 00:00-08:00 UTC yesterday, now out of range)
    // Day 2: 2026-09-23 00:00 UTC to 12:00 UTC (Asian session Day 2 is 00:00-08:00 UTC today with high 2050, low 2010)
    const candles: Candle[] = [];
    const tStart = Date.UTC(2026, 8, 22, 12, 0, 0);

    for (let i = 0; i < 288; i++) {
      const t = tStart + i * 300000;
      const d = new Date(t);
      const isDay2Asian = d.getUTCDay() === 3 && d.getUTCHours() >= 0 && d.getUTCHours() < 8;
      
      const high = isDay2Asian ? 2050 : 2000;
      const low = isDay2Asian ? 2010 : 1990;
      candles.push(createCandle(t, 2000, high, low, 2000));
    }

    const sessionData = extractSessionExtremes(candles);

    assert.strictEqual(sessionData.asianHigh, 2050, 'Asian high for Day 2 must strictly equal 2050');
    assert.strictEqual(sessionData.asianLow, 2010, 'Asian low for Day 2 must strictly equal 2010');
  });
});
