import { telegramService } from './telegram.js';
import { TradeSignal } from '../src/types.js';

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, testName: string, details?: any) {
  if (condition) {
    console.log(`✅ [PASS] ${testName}`);
    passedCount++;
  } else {
    console.error(`❌ [FAIL] ${testName}`, details || '');
    failedCount++;
  }
}

// Global fetch mock helper for deterministic testing
const originalFetch = globalThis.fetch;

function mockFetchResponse(ok: boolean, status: number = 200, data: any = { ok: true, result: { message_id: 12345 } }) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Bad Request',
      json: async () => data,
    } as Response;
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

async function runTests() {
  console.log('======================================================================');
  console.log('RUNNING TELEGRAM DISPATCH DIAGNOSTICS & S10-S13 INTEGRATION TESTS');
  console.log('======================================================================\n');

  // Reset sent IDs for test isolation
  (telegramService as any).sentNotificationIds.clear();

  // Setup environment variables for test execution
  process.env.TELEGRAM_BOT_TOKEN = '123456789:AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqR';
  process.env.TELEGRAM_CHAT_ID = '987654321';

  // Helper builder for dummy TradeSignal
  const createTestSignal = (id: string, setup: string, signal: 'BUY NOW' | 'SELL NOW' | 'NO TRADE' = 'BUY NOW'): TradeSignal => ({
    id,
    timestamp: Date.now(),
    asset: 'XAU/USD',
    signal,
    currentPrice: 2500,
    entry: 2500,
    stopLoss: 2495,
    slPoints: 50,
    tp1: 2510,
    tp1Points: 100,
    tp1Rr: 2.0,
    tp1RrString: '1:2.0',
    tp2: 2520,
    tp2Points: 200,
    tp2Rr: 4.0,
    tp2RrString: '1:4.0',
    rr: '1:2.0',
    rrRatio: 2.0,
    riskPercent: 1.0,
    riskAmount: 10,
    potentialProfit: 20,
    potentialLoss: 10,
    recommendedLotSize: 0.01,
    confidence: 85,
    timeframe: '5M',
    setup,
    mainReasons: ['تأكيد الهيكل الفني وسلوك السعر'],
    invalidation: 'كسر القاع السابق',
  });

  // TEST 1: Valid S10 signal -> Dispatch attempted and SENT
  {
    mockFetchResponse(true, 200, { ok: true, result: { message_id: 1001 } });
    const sigS10 = createTestSignal('sig_test_s10_01', 'Double Top Reversal (M-Formation)', 'SELL NOW');
    const res = await telegramService.sendSignalNotification(sigS10, 'scan_s10_01');

    assert(
      res.success === true && res.status === 'SENT' && res.messageId === 1001,
      'TEST 1: Valid S10 signal (Double Top) -> Telegram dispatch attempted & SENT',
      { res }
    );
  }

  // TEST 2: Valid S11 signal -> Dispatch attempted and SENT
  {
    mockFetchResponse(true, 200, { ok: true, result: { message_id: 1002 } });
    const sigS11 = createTestSignal('sig_test_s11_01', 'Bare Resistance Rejection', 'SELL NOW');
    const res = await telegramService.sendSignalNotification(sigS11, 'scan_s11_01');

    assert(
      res.success === true && res.status === 'SENT' && res.messageId === 1002,
      'TEST 2: Valid S11 signal (Bare Resistance) -> Telegram dispatch attempted & SENT',
      { res }
    );
  }

  // TEST 3: Valid S12 signal -> Dispatch attempted and SENT
  {
    mockFetchResponse(true, 200, { ok: true, result: { message_id: 1003 } });
    const sigS12 = createTestSignal('sig_test_s12_01', 'Horizontal Support Breakout & Retest', 'SELL NOW');
    const res = await telegramService.sendSignalNotification(sigS12, 'scan_s12_01');

    assert(
      res.success === true && res.status === 'SENT' && res.messageId === 1003,
      'TEST 3: Valid S12 signal (Breakout & Retest) -> Telegram dispatch attempted & SENT',
      { res }
    );
  }

  // TEST 4: Valid S13 signal -> Dispatch attempted and SENT
  {
    mockFetchResponse(true, 200, { ok: true, result: { message_id: 1004 } });
    const sigS13 = createTestSignal('sig_test_s13_01', 'Bullish Engulfing Reversal at Key Structure', 'BUY NOW');
    const res = await telegramService.sendSignalNotification(sigS13, 'scan_s13_01');

    assert(
      res.success === true && res.status === 'SENT' && res.messageId === 1004,
      'TEST 4: Valid S13 signal (Structure Engulfing) -> Telegram dispatch attempted & SENT',
      { res }
    );
  }

  // TEST 5: Generic NO TRADE -> Suppressed cleanly
  {
    mockFetchResponse(true, 200, { ok: true, result: { message_id: 1005 } });
    const genericNoTrade = createTestSignal('sig_test_notrade_01', 'No Setup', 'NO TRADE');
    genericNoTrade.slPoints = 0;
    genericNoTrade.entry = 2500;
    genericNoTrade.stopLoss = 2500;

    const res = await telegramService.sendNoTradeNotification(
      'scan_test_notrade_01',
      'لا توجد فرصة تداول حالياً: عدم اكتمال الشروط',
      Date.now(),
      2500,
      genericNoTrade
    );

    assert(
      res.success === false && res.status === 'SUPPRESSED' && (res.reason || '').includes('Suppressed generic NO TRADE'),
      'TEST 5: Generic NO TRADE scan -> Telegram SUPPRESSED correctly',
      { res }
    );
  }

  // TEST 6: Duplicate signal -> Suppressed correctly
  {
    mockFetchResponse(true, 200, { ok: true, result: { message_id: 1006 } });
    const sigDup = createTestSignal('sig_test_dup_01', 'Bullish Order Block', 'BUY NOW');
    
    // First send succeeds
    const firstSend = await telegramService.sendSignalNotification(sigDup, 'scan_dup_test_id');
    assert(firstSend.status === 'SENT', 'TEST 6a: First signal send succeeded');

    // Second send with same scan/dedupe ID is suppressed
    const secondSend = await telegramService.sendSignalNotification(sigDup, 'scan_dup_test_id');

    assert(
      secondSend.success === false && secondSend.status === 'SUPPRESSED' && (secondSend.reason || '').includes('Skipping duplicate'),
      'TEST 6b: Duplicate signal send -> Telegram SUPPRESSED correctly',
      { secondSend }
    );
  }

  // TEST 7: Telegram API failure -> Status set to FAILED with explicit reason & ID not burned
  {
    // API returns HTTP 400 Bad Request
    mockFetchResponse(false, 400, { ok: false, description: 'Bad Request: chat not found' });
    const sigFail = createTestSignal('sig_test_fail_01', 'Bearish FVG Rejection', 'SELL NOW');

    const resFail = await telegramService.sendSignalNotification(sigFail, 'scan_fail_test_id');

    assert(
      resFail.success === false && resFail.status === 'FAILED' && Boolean(resFail.reason && resFail.reason.length > 0),
      'TEST 7a: Telegram API failure -> Status set to FAILED with explicit reason',
      { resFail }
    );

    // Verify dedupe ID was NOT burned on failure: retry after fixing API response works!
    mockFetchResponse(true, 200, { ok: true, result: { message_id: 1007 } });
    const resRetry = await telegramService.sendSignalNotification(sigFail, 'scan_fail_test_id');

    assert(
      resRetry.success === true && resRetry.status === 'SENT' && resRetry.messageId === 1007,
      'TEST 7b: After API failure, retry is NOT suppressed and succeeds cleanly (dedupe ID was not burned)',
      { resRetry }
    );
  }

  // TEST 8: Successful Telegram API response -> Status set to SENT
  {
    mockFetchResponse(true, 200, { ok: true, result: { message_id: 8888 } });
    const sigSent = createTestSignal('sig_test_sent_01', 'Liquidity Sweep Reversal', 'BUY NOW');

    const resSent = await telegramService.sendSignalNotification(sigSent, 'scan_sent_test_id');

    assert(
      resSent.success === true && resSent.status === 'SENT' && resSent.messageId === 8888,
      'TEST 8: Successful Telegram API response -> Status set to SENT with message ID',
      { resSent }
    );
  }

  restoreFetch();

  console.log('\n======================================================================');
  console.log(`TEST RESULTS: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('======================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Unhandled error running telegram dispatch tests:', err);
  process.exit(1);
});
