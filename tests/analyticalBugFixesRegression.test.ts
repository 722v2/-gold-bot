import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTechnicals, calculateVWAP, getSessionAnchoredCandles } from '../server/indicators';
import { assessEntryLocationQuality } from '../server/entryLocationQuality';
import { Candle, TechnicalIndicators } from '../src/types';

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

describe('Analytical Bug Fixes Regression Suite', () => {
  // =========================================================================
  // BUG 1: OB/FVG Retest Mitigation Collision
  // =========================================================================
  it('BUG 1: Current-candle OB retest is NOT marked as historically mitigated during analyzeTechnicals', () => {
    // Generate base candles where an OB is created at index 20 (candle 20: bearish, candle 21: strong bullish expansion)
    const baseTime = 1700000000000;
    const candles: Candle[] = [];
    
    // 20 flat candles around 2000
    for (let i = 0; i < 20; i++) {
      candles.push(createCandle(baseTime + i * 300000, 2000, 2002, 1998, 2000));
    }
    
    // Index 20: Bearish OB candle (Open 2000, High 2001, Low 1990, Close 1992)
    candles.push(createCandle(baseTime + 20 * 300000, 2000, 2001, 1990, 1992));
    
    // Index 21: Strong bullish expansion (Open 1993, High 2020, Low 1993, Close 2018) -> ATR ~4, expansion > 0.8 * ATR
    candles.push(createCandle(baseTime + 21 * 300000, 1993, 2020, 1993, 2018));
    
    // Index 22-24: Rallies away (Low stays above OB high of 2000)
    for (let i = 22; i <= 24; i++) {
      candles.push(createCandle(baseTime + i * 300000, 2018 + (i - 21) * 2, 2025, 2015, 2022));
    }
    
    // Index 25 (Latest closed candle): Price returns to retest the OB (Low 1995, dipping <= OB high of 2000)
    candles.push(createCandle(baseTime + 25 * 300000, 2018, 2018, 1995, 2002));

    const tech = analyzeTechnicals(candles);

    // Verify OB is detected and NOT marked as mitigated (active for retest evaluation)
    assert.ok(tech.orderBlocks, 'orderBlocks array should be defined');
    assert.strictEqual(tech.orderBlocks.length, 1, 'Should find 1 active unmitigated Order Block');
    assert.strictEqual(tech.orderBlocks[0].type, 'BULLISH');
    assert.strictEqual(tech.orderBlocks[0].mitigated, false, 'OB must be active (not historically mitigated by current retest candle)');
  });

  it('BUG 1: Historical OB mitigation correctly marks OB as mitigated if touched before current candle', () => {
    const baseTime = 1700000000000;
    const candles: Candle[] = [];
    
    for (let i = 0; i < 20; i++) {
      candles.push(createCandle(baseTime + i * 300000, 2000, 2002, 1998, 2000));
    }
    
    // Index 20: Bearish OB candle
    candles.push(createCandle(baseTime + 20 * 300000, 2000, 2001, 1990, 1992));
    // Index 21: Strong bullish expansion
    candles.push(createCandle(baseTime + 21 * 300000, 1993, 2020, 1993, 2018));
    
    // Index 22 (HISTORICAL CANDLE BEFORE CURRENT): Price dips into OB high (1995 <= 2000) -> HISTORICALLY MITIGATED
    candles.push(createCandle(baseTime + 22 * 300000, 2018, 2018, 1995, 2010));
    
    // Index 23 (Current candle)
    candles.push(createCandle(baseTime + 23 * 300000, 2010, 2015, 2008, 2012));

    const tech = analyzeTechnicals(candles);

    // OB was mitigated at index 22, so it should NOT be in active orderBlocks
    assert.strictEqual(tech.orderBlocks?.length || 0, 0, 'Historically mitigated OB must not be returned in active orderBlocks');
  });

  // =========================================================================
  // BUG 2: Market Regime Misclassification
  // =========================================================================
  it('BUG 2: HH_HL structure + Bearish EMA stack + price below EMA50 is classified as TRANSITION, NOT WEAK_UPTREND', () => {
    const baseTime = 1700000000000;
    const candles: Candle[] = [];

    // 35 candles forming clear HH_HL swings going up from 2000 to 2050
    let price = 2000;
    for (let i = 0; i < 35; i++) {
      if (i % 5 === 0) price += 6; // Swing High
      else if (i % 5 === 2) price -= 2; // Higher Low
      else price += 1;
      candles.push(createCandle(baseTime + i * 300000, price - 1, price + 1, price - 2, price));
    }
    
    // Last 10 candles: Sharp sudden drop below EMA50 / EMA200
    for (let i = 35; i < 45; i++) {
      price -= 8;
      candles.push(createCandle(baseTime + i * 300000, price + 4, price + 4, price - 2, price));
    }

    const tech = analyzeTechnicals(candles);

    // Verify regime is NOT WEAK_UPTREND when EMAs are bearishly stacked and price is below EMA50
    assert.notStrictEqual(tech.marketRegime, 'WEAK_UPTREND', 'Contradictory structure and EMA stack must NOT be classified as WEAK_UPTREND');
    assert.ok(
      tech.marketRegime === 'TRANSITION' || tech.marketRegime === 'VOLATILE_RANGE',
      `Contradictory structure and EMA stack should be classified as TRANSITION or VOLATILE_RANGE, got ${tech.marketRegime}`
    );
  });

  it('BUG 2: HH_HL structure + Bullish EMA alignment is correctly classified as WEAK_UPTREND or STRONG_UPTREND', () => {
    const baseTime = 1700000000000;
    const candles: Candle[] = [];

    let price = 2000;
    for (let i = 0; i < 50; i++) {
      price += 1.5;
      candles.push(createCandle(baseTime + i * 300000, price, price + 2, price - 1, price + 1));
    }

    const tech = analyzeTechnicals(candles);
    assert.ok(
      tech.marketRegime === 'WEAK_UPTREND' || tech.marketRegime === 'STRONG_UPTREND',
      `Valid bullish structure and EMA alignment should produce UPTREND, got ${tech.marketRegime}`
    );
  });

  // =========================================================================
  // BUG 3: Session-Anchored VWAP
  // =========================================================================
  it('BUG 3: getSessionAnchoredCandles correctly filters candles from 00:00 UTC midnight boundary', () => {
    // Yesterday 23:00 UTC
    const tYesterday = Date.UTC(2026, 8, 22, 23, 0, 0);
    // Today 00:00, 01:00, 02:00 UTC
    const t0 = Date.UTC(2026, 8, 23, 0, 0, 0);
    const t1 = Date.UTC(2026, 8, 23, 1, 0, 0);
    const t2 = Date.UTC(2026, 8, 23, 2, 0, 0);

    const candles: Candle[] = [
      createCandle(tYesterday, 1990, 1995, 1985, 1990, 100),
      createCandle(t0, 2000, 2010, 1990, 2000, 200), // Typical price = 2000
      createCandle(t1, 2000, 2020, 2000, 2010, 300), // Typical price = 2010
      createCandle(t2, 2010, 2030, 2000, 2020, 500), // Typical price = 2016.67
    ];

    const sessionCandles = getSessionAnchoredCandles(candles);
    assert.strictEqual(sessionCandles.length, 3, 'Should only include the 3 candles from today 00:00 UTC');
    assert.strictEqual(sessionCandles[0].timestamp, t0);

    // Calculate expected session VWAP manually:
    // Bar 1: TP=2000, Vol=200 -> TPV=400,000
    // Bar 2: TP=2010, Vol=300 -> TPV=603,000
    // Bar 3: TP=2016.6667, Vol=500 -> TPV=1,008,333.33
    // Total TPV = 2,011,333.33 / 1000 = 2011.33
    const vwap = calculateVWAP(candles);
    assert.strictEqual(vwap, 2011.33, 'VWAP should match exact session-anchored volume-weighted average');
  });

  // =========================================================================
  // BUG 4 / FLAW 1: ELQ Local Swing Hard Block
  // =========================================================================
  it('BUG 4: Local 15M swing level 0.9 ATR ahead does NOT hard-block entry', () => {
    const mockIndicators15m: TechnicalIndicators = {
      close: 2000,
      support: 1991, // 0.9 ATR below entry (2000 - 9 / 10)
      swingLow: 1991,
      orderBlock: undefined,
      fvg: undefined,
    } as unknown as TechnicalIndicators;

    const mockIndicators5m: TechnicalIndicators = {
      atr14: 10,
    } as unknown as TechnicalIndicators;

    const mockIndicators1h: TechnicalIndicators = {
      support: 1970, // 3 ATR below entry
      swingLow: 1970,
    } as unknown as TechnicalIndicators;

    const candles5m = [
      createCandle(Date.now() - 1200000, 2005, 2006, 2004, 2005),
      createCandle(Date.now() - 900000, 2005, 2005, 2003, 2003),
      createCandle(Date.now() - 600000, 2003, 2003, 2001, 2001),
      createCandle(Date.now() - 300000, 2001, 2002, 1999, 2000),
      createCandle(Date.now(), 2000, 2002, 1998, 2000),
    ];

    const result = assessEntryLocationQuality({
      direction: 'SELL',
      family: 'MARKET_STRUCTURE',
      entry: 2000,
      currentPrice: 2000,
      explicitRetestLevel: 2001,
      candles5m,
      indicators5m: mockIndicators5m,
      indicators15m: mockIndicators15m,
      indicators1h: mockIndicators1h,
    });

    assert.strictEqual(result.hardBlocked, false, 'Local 15M swing 0.9 ATR ahead must NOT hard-block candidate');
  });

  it('BUG 4: Entry inside unmitigated opposing OB IS hard-blocked with INSIDE_OPPOSING_STRUCTURE', () => {
    const mockIndicators15m: TechnicalIndicators = {
      close: 2000,
      orderBlock: {
        type: 'BULLISH',
        high: 2002,
        low: 1998,
      },
    } as unknown as TechnicalIndicators;

    const mockIndicators5m: TechnicalIndicators = {
      atr14: 10,
    } as unknown as TechnicalIndicators;

    const mockIndicators1h: TechnicalIndicators = {} as unknown as TechnicalIndicators;

    const candles5m = [
      createCandle(Date.now() - 1200000, 2005, 2006, 2004, 2005),
      createCandle(Date.now() - 900000, 2005, 2005, 2003, 2003),
      createCandle(Date.now() - 600000, 2003, 2003, 2001, 2001),
      createCandle(Date.now() - 300000, 2001, 2002, 1999, 2000),
      createCandle(Date.now(), 2000, 2002, 1998, 2000),
    ];

    const result = assessEntryLocationQuality({
      direction: 'SELL',
      family: 'ORDER_BLOCK',
      entry: 2000, // Inside Bullish OB [1998, 2002]
      currentPrice: 2000,
      candles5m,
      indicators5m: mockIndicators5m,
      indicators15m: mockIndicators15m,
      indicators1h: mockIndicators1h,
    });

    assert.strictEqual(result.hardBlocked, true, 'Entry inside unmitigated opposing OB must be hard-blocked');
    assert.ok(result.rejectionReason?.includes('INSIDE_OPPOSING_STRUCTURE'), 'Rejection reason should state INSIDE_OPPOSING_STRUCTURE');
  });
});
