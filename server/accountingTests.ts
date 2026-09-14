import { storage, TradeOutcomeRecord } from './storage.js';
import { sanitizeFirestoreData } from './storage.js';

interface TestResult {
  testNumber: number;
  name: string;
  passed: boolean;
  details: string;
}

export function runAccountingTests(): { allPassed: boolean; results: TestResult[] } {
  const results: TestResult[] = [];

  const initialStartingBalance = 100.00;
  storage.setStartingBalance(initialStartingBalance);

  // --------------------------------------------------------------------------
  // TEST 1: WIN outcome with explicit realized P&L (+$17.00 for Trade #2) updates balance by exactly +$17.00
  // --------------------------------------------------------------------------
  try {
    const balBefore = storage.getCurrentBalance();
    const tradeId = 'test-trade-1-win-explicit';
    const record: TradeOutcomeRecord = {
      signalId: tradeId,
      tradeId,
      direction: 'SELL NOW',
      orderType: 'MARKET',
      entry: 4296.49,
      stopLoss: 4300.49,
      tp1: 4278.29,
      tp2: 4276.25,
      outcome: 'WIN',
      realizedPnl: 17.00,
      exitPrice: 4279.49,
      source: 'TELEGRAM_CALLBACK',
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
    };

    const res = storage.recordTradeOutcome(record);
    const balAfter = storage.getCurrentBalance();
    const pnlMatches = res.trade?.realizedPnl === 17.00;
    const balanceDiff = Number((balAfter - balBefore).toFixed(2));
    const passed = res.success && pnlMatches && balanceDiff === 17.00;

    results.push({
      testNumber: 1,
      name: 'WIN outcome with explicit realized P&L (+17.00 USD)',
      passed,
      details: `Balance before: $${balBefore.toFixed(2)}, after: $${balAfter.toFixed(2)} (diff: +$${balanceDiff.toFixed(2)}), recorded PnL: $${res.trade?.realizedPnl}`,
    });
  } catch (err: any) {
    results.push({
      testNumber: 1,
      name: 'WIN outcome with explicit realized P&L (+17.00 USD)',
      passed: false,
      details: `Exception: ${err?.message}`,
    });
  }

  // --------------------------------------------------------------------------
  // TEST 2: WIN outcome with composite RR string does NOT fall back to 1.5R
  // --------------------------------------------------------------------------
  try {
    const balBefore = storage.getCurrentBalance();
    const tradeId = 'test-trade-2-composite-rr';
    const mockSignal = {
      id: tradeId,
      symbol: 'XAU/USD',
      signal: 'SELL NOW',
      entry: 4296.49,
      stopLoss: 4300.49,
      tp1: 4278.29,
      tp2: 4276.25,
      tp1Points: 182,
      tp2Points: 202.4,
      slPoints: 40,
      rr: 'TP1: 1:4.55 (182.0 pts) | TP2: 1:5.06 (202.4 pts)',
      lotSize: 0.01,
      riskAmount: 4.00,
      timestamp: Date.now(),
    } as any;

    const record: TradeOutcomeRecord = {
      signalId: tradeId,
      tradeId,
      direction: 'SELL NOW',
      orderType: 'MARKET',
      entry: 4296.49,
      stopLoss: 4300.49,
      tp1: 4278.29,
      tp2: 4276.25,
      outcome: 'WIN',
      exitPrice: 4278.29, // Closed at TP1
      source: 'MANUAL',
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
    };

    const res = storage.recordTradeOutcome(record, mockSignal);
    const balAfter = storage.getCurrentBalance();
    const pnl = res.trade?.realizedPnl ?? 0;
    // Calculated from price distance: (4296.49 - 4278.29) * 100 * 0.01 = $18.20
    // Old buggy calculation was riskAmount * 1.5 = $6.00 or $6.07
    const notBuggy15R = pnl > 10.00 && pnl !== 6.00 && pnl !== 6.07;
    const balanceDiff = Number((balAfter - balBefore).toFixed(2));
    const passed = res.success && notBuggy15R && balanceDiff === pnl;

    results.push({
      testNumber: 2,
      name: 'WIN outcome does NOT fall back to 1.5R on composite RR string',
      passed,
      details: `Calculated P&L: $${pnl.toFixed(2)} (expected ~$18.20 based on 182 pts * $0.10, NOT $6.00), balance diff: +$${balanceDiff.toFixed(2)}`,
    });
  } catch (err: any) {
    results.push({
      testNumber: 2,
      name: 'WIN outcome does NOT fall back to 1.5R on composite RR string',
      passed: false,
      details: `Exception: ${err?.message}`,
    });
  }

  // --------------------------------------------------------------------------
  // TEST 3: LOSS outcome records exact negative P&L and updates balance correctly
  // --------------------------------------------------------------------------
  try {
    const balBefore = storage.getCurrentBalance();
    const tradeId = 'test-trade-3-loss-exact';
    const record: TradeOutcomeRecord = {
      signalId: tradeId,
      tradeId,
      direction: 'BUY NOW',
      orderType: 'MARKET',
      entry: 4300.00,
      stopLoss: 4296.00,
      tp1: 4310.00,
      tp2: 4315.00,
      outcome: 'LOSS',
      realizedPnl: -4.00,
      exitPrice: 4296.00,
      source: 'MANUAL',
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
    };

    const res = storage.recordTradeOutcome(record);
    const balAfter = storage.getCurrentBalance();
    const balanceDiff = Number((balAfter - balBefore).toFixed(2));
    const passed = res.success && res.trade?.realizedPnl === -4.00 && balanceDiff === -4.00;

    results.push({
      testNumber: 3,
      name: 'LOSS outcome records exact negative P&L (-$4.00) and reduces balance',
      passed,
      details: `Balance before: $${balBefore.toFixed(2)}, after: $${balAfter.toFixed(2)} (diff: -$${Math.abs(balanceDiff).toFixed(2)}), recorded PnL: $${res.trade?.realizedPnl}`,
    });
  } catch (err: any) {
    results.push({
      testNumber: 3,
      name: 'LOSS outcome records exact negative P&L (-$4.00) and reduces balance',
      passed: false,
      details: `Exception: ${err?.message}`,
    });
  }

  // --------------------------------------------------------------------------
  // TEST 4: Directional sign enforcement (WIN cannot be negative, LOSS cannot be positive)
  // --------------------------------------------------------------------------
  try {
    const tradeIdWin = 'test-trade-4-win-sign-guard';
    const recordWinWithNegative: TradeOutcomeRecord = {
      signalId: tradeIdWin,
      tradeId: tradeIdWin,
      direction: 'BUY NOW',
      orderType: 'MARKET',
      entry: 4300.00,
      stopLoss: 4296.00,
      tp1: 4310.00,
      tp2: 4315.00,
      outcome: 'WIN',
      realizedPnl: -12.50, // Erroneously passed as negative
      source: 'MANUAL',
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
    };

    const resWin = storage.recordTradeOutcome(recordWinWithNegative);
    const winFixed = (resWin.trade?.realizedPnl ?? 0) > 0;

    const tradeIdLoss = 'test-trade-4-loss-sign-guard';
    const recordLossWithPositive: TradeOutcomeRecord = {
      signalId: tradeIdLoss,
      tradeId: tradeIdLoss,
      direction: 'BUY NOW',
      orderType: 'MARKET',
      entry: 4300.00,
      stopLoss: 4296.00,
      tp1: 4310.00,
      tp2: 4315.00,
      outcome: 'LOSS',
      realizedPnl: 8.00, // Erroneously passed as positive
      source: 'MANUAL',
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
    };

    const resLoss = storage.recordTradeOutcome(recordLossWithPositive);
    const lossFixed = (resLoss.trade?.realizedPnl ?? 0) < 0;

    const passed = winFixed && lossFixed;
    results.push({
      testNumber: 4,
      name: 'Directional sign enforcement for WIN (+) and LOSS (-)',
      passed,
      details: `WIN with input -12.50 normalized to: +$${resWin.trade?.realizedPnl}, LOSS with input +8.00 normalized to: $${resLoss.trade?.realizedPnl}`,
    });
  } catch (err: any) {
    results.push({
      testNumber: 4,
      name: 'Directional sign enforcement for WIN (+) and LOSS (-)',
      passed: false,
      details: `Exception: ${err?.message}`,
    });
  }

  // --------------------------------------------------------------------------
  // TEST 5: Idempotency / duplicate callback protection (prevents double counting)
  // --------------------------------------------------------------------------
  try {
    const balBefore = storage.getCurrentBalance();
    const tradeId = 'test-trade-5-duplicate-protection';
    const record: TradeOutcomeRecord = {
      signalId: tradeId,
      tradeId,
      direction: 'SELL NOW',
      orderType: 'MARKET',
      entry: 4300.00,
      stopLoss: 4305.00,
      tp1: 4290.00,
      tp2: 4285.00,
      outcome: 'WIN',
      realizedPnl: 10.00,
      source: 'TELEGRAM_CALLBACK',
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
    };

    // First submission
    const res1 = storage.recordTradeOutcome(record);
    const balAfterFirst = storage.getCurrentBalance();

    // Second duplicate submission
    const res2 = storage.recordTradeOutcome(record);
    const balAfterSecond = storage.getCurrentBalance();

    const firstPassed = res1.success && balAfterFirst === balBefore + 10.00;
    const secondBlocked = res2.isDuplicate === true && balAfterSecond === balAfterFirst;
    const passed = firstPassed && secondBlocked;

    results.push({
      testNumber: 5,
      name: 'Idempotency and duplicate submission protection',
      passed,
      details: `First submission success: ${res1.success} (bal: $${balAfterFirst.toFixed(2)}), second submission isDuplicate: ${res2.isDuplicate} (bal unchanged: $${balAfterSecond.toFixed(2)})`,
    });
  } catch (err: any) {
    results.push({
      testNumber: 5,
      name: 'Idempotency and duplicate submission protection',
      passed: false,
      details: `Exception: ${err?.message}`,
    });
  }

  // --------------------------------------------------------------------------
  // TEST 6: Gold contract calculation: 100 multiplier with 0.01 lot
  // --------------------------------------------------------------------------
  try {
    const entry = 4296.49;
    const tp1 = 4278.29; // Sell trade, 18.20 gold points
    const lotSize = 0.01;
    const expectedPnl = Number((Math.abs(entry - tp1) * 100 * lotSize).toFixed(2)); // 18.20 * 100 * 0.01 = 18.20

    const tradeId = 'test-trade-6-gold-formula';
    const record: TradeOutcomeRecord = {
      signalId: tradeId,
      tradeId,
      direction: 'SELL NOW',
      orderType: 'MARKET',
      entry,
      stopLoss: 4300.49,
      tp1,
      tp2: 4276.25,
      outcome: 'WIN',
      exitPrice: tp1,
      source: 'MANUAL',
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
    };

    const res = storage.recordTradeOutcome(record);
    const pnl = res.trade?.realizedPnl;
    const passed = res.success && pnl === expectedPnl && pnl === 18.20;

    results.push({
      testNumber: 6,
      name: 'Gold contract size calculation (|ΔPrice| * 100 * LotSize)',
      passed,
      details: `18.20 points * 100 oz * 0.01 lot = $${expectedPnl.toFixed(2)}, recorded: $${pnl}`,
    });
  } catch (err: any) {
    results.push({
      testNumber: 6,
      name: 'Gold contract size calculation (|ΔPrice| * 100 * LotSize)',
      passed: false,
      details: `Exception: ${err?.message}`,
    });
  }

  // --------------------------------------------------------------------------
  // TEST 7: Future MT5 reconciliation (reconcileMt5Trade) with brokerDealId
  // --------------------------------------------------------------------------
  try {
    const balBefore = storage.getCurrentBalance();
    const tradeId = 'test-trade-7-mt5-reconciliation';
    const brokerDealId = 'MT5_DEAL_987654321';
    const brokerOrderId = 'MT5_ORDER_123456';

    const res = storage.reconcileMt5Trade({
      signalOrTradeId: tradeId,
      brokerDealId,
      brokerOrderId,
      entryPrice: 4290.00,
      exitPrice: 4275.00,
      lotSize: 0.02,
      realizedPnl: 30.00,
      closedAt: Date.now(),
      closeReason: 'MT5_TP_HIT',
      direction: 'SELL NOW',
    });

    const balAfter = storage.getCurrentBalance();
    const balanceDiff = Number((balAfter - balBefore).toFixed(2));
    const passed =
      res.success &&
      res.trade?.source === 'MT5' &&
      res.trade?.brokerDealId === brokerDealId &&
      res.trade?.brokerOrderId === brokerOrderId &&
      res.trade?.realizedPnl === 30.00 &&
      balanceDiff === 30.00;

    results.push({
      testNumber: 7,
      name: 'Future MT5 trade reconciliation (reconcileMt5Trade)',
      passed,
      details: `Source: ${res.trade?.source}, brokerDealId: ${res.trade?.brokerDealId}, realizedPnl: $${res.trade?.realizedPnl}, balance diff: +$${balanceDiff.toFixed(2)}`,
    });
  } catch (err: any) {
    results.push({
      testNumber: 7,
      name: 'Future MT5 trade reconciliation (reconcileMt5Trade)',
      passed: false,
      details: `Exception: ${err?.message}`,
    });
  }

  // --------------------------------------------------------------------------
  // TEST 8: Source tagging distinction: MANUAL vs TELEGRAM_CALLBACK vs MT5
  // --------------------------------------------------------------------------
  try {
    const tradeManual = 'test-trade-8-src-manual';
    const resManual = storage.recordTradeOutcome({
      signalId: tradeManual,
      tradeId: tradeManual,
      direction: 'BUY NOW',
      orderType: 'MARKET',
      entry: 4300,
      stopLoss: 4295,
      tp1: 4310,
      tp2: 4315,
      outcome: 'WIN',
      realizedPnl: 5.0,
      source: 'MANUAL',
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
    });

    const tradeTelegram = 'test-trade-8-src-telegram';
    const resTelegram = storage.recordTradeOutcome({
      signalId: tradeTelegram,
      tradeId: tradeTelegram,
      direction: 'BUY NOW',
      orderType: 'MARKET',
      entry: 4300,
      stopLoss: 4295,
      tp1: 4310,
      tp2: 4315,
      outcome: 'WIN',
      realizedPnl: 5.0,
      source: 'TELEGRAM_CALLBACK',
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
    });

    const passed =
      resManual.trade?.source === 'MANUAL' &&
      resTelegram.trade?.source === 'TELEGRAM_CALLBACK';

    results.push({
      testNumber: 8,
      name: 'Multi-source attribution tags (MANUAL, TELEGRAM_CALLBACK, MT5)',
      passed,
      details: `Manual source: ${resManual.trade?.source}, Telegram source: ${resTelegram.trade?.source}`,
    });
  } catch (err: any) {
    results.push({
      testNumber: 8,
      name: 'Multi-source attribution tags (MANUAL, TELEGRAM_CALLBACK, MT5)',
      passed: false,
      details: `Exception: ${err?.message}`,
    });
  }

  // --------------------------------------------------------------------------
  // TEST 9: Firestore data sanitization (removes undefined fields)
  // --------------------------------------------------------------------------
  try {
    const dirtyData = {
      id: 'trade-clean-test',
      realizedPnl: 15.50,
      undefinedField: undefined,
      nullField: null,
      nested: {
        valid: 'ok',
        badUndefined: undefined,
      },
    };

    const cleaned: any = sanitizeFirestoreData(dirtyData);
    const hasNoUndefined = !('undefinedField' in cleaned) && !('badUndefined' in cleaned.nested);
    const keepsNullAndValues = cleaned.nullField === null && cleaned.realizedPnl === 15.50;
    const passed = hasNoUndefined && keepsNullAndValues;

    results.push({
      testNumber: 9,
      name: 'Firestore data sanitization against undefined fields',
      passed,
      details: `Removed undefinedField: ${!('undefinedField' in cleaned)}, nested undefined: ${!('badUndefined' in cleaned.nested)}, preserved null & values: ${keepsNullAndValues}`,
    });
  } catch (err: any) {
    results.push({
      testNumber: 9,
      name: 'Firestore data sanitization against undefined fields',
      passed: false,
      details: `Exception: ${err?.message}`,
    });
  }

  const allPassed = results.every((r) => r.passed);
  return { allPassed, results };
}
