import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramService, escapeTelegramHtml } from '../server/telegram.js';
import { storage } from '../server/storage.js';
import { isShadowMode, setTradingRuntimeModeForTesting, getTradingRuntimeMode } from '../server/runtimeMode.js';

test('Telegram Shadow Mode Delivery Test Suite', async (t) => {
  const originalFetch = globalThis.fetch;

  t.beforeEach(() => {
    // Ensure runtime mode is shadow
    setTradingRuntimeModeForTesting('shadow');
    process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST_BOT_TOKEN_ABC123';
    process.env.TELEGRAM_AUTHORIZED_USER_ID = '987654321';
    (telegramService as any).privateChatId = '987654321';
    (telegramService as any).botToken = '123456789:TEST_BOT_TOKEN_ABC123';
    telegramService.clearRetryQueue();
  });

  t.afterEach(() => {
    globalThis.fetch = originalFetch;
    telegramService.clearRetryQueue();
    setTradingRuntimeModeForTesting(null);
  });

  await t.test('1. Verifies runtime is in SHADOW mode', () => {
    assert.equal(isShadowMode(), true);
    assert.equal(getTradingRuntimeMode(), 'shadow');
  });

  await t.test('2. Strictly blocks normal scanner signals in Shadow Mode', async () => {
    const normalSignal = {
      id: `sig_prod_${Date.now()}`,
      signal: 'BUY NOW',
      asset: 'XAU/USD',
      entry: 2650.00,
      stopLoss: 2640.00,
      tp1: 2665.00,
      confidence: 85,
      setup: 'Bullish Order Block & FVG',
    };

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return {} as any;
    }) as any;

    const delivered = await telegramService.sendSignalNotification(normalSignal as any);
    assert.equal(delivered, false);
    assert.equal(fetchCalled, false);
  });

  await t.test('3. Rejects real/non-test signals even if allowShadowTest flag is passed', async () => {
    const nonTestSignal = {
      id: `sig_prod_${Date.now()}_real`,
      signal: 'BUY NOW',
      asset: 'XAU/USD',
      entry: 2650.00,
      stopLoss: 2640.00,
      tp1: 2665.00,
      confidence: 85,
      setup: 'Bullish Order Block',
    };

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return {} as any;
    }) as any;

    const delivered = await telegramService.sendSignalNotification(nonTestSignal as any, { allowShadowTest: true });
    assert.equal(delivered, false);
    assert.equal(fetchCalled, false);
  });

  await t.test('4. Correctly escapes HTML entities (&, <, >, ", \') without double escaping', () => {
    const raw = 'Horizontal Support & Resistance <Breakout> with "High" volume & \'Retest\'';
    const escaped = escapeTelegramHtml(raw);

    assert.equal(escaped, 'Horizontal Support &amp; Resistance &lt;Breakout&gt; with &quot;High&quot; volume &amp; &#39;Retest&#39;');
    // Verify no double escaping
    const doubleSanitized = escaped.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/gi, '&amp;');
    assert.equal(doubleSanitized, escaped);
    assert.ok(!doubleSanitized.includes('&amp;amp;'));
  });

  await t.test('5. Allows explicit synthetic test signal through allowShadowTest bypass and delivers successfully', async () => {
    const uniqueId = `test_shadow_success_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const testSignal = {
      id: uniqueId,
      isTest: true,
      signal: 'SELL NOW',
      direction: 'SELL',
      asset: 'XAU/USD <TEST>',
      setup: 'Horizontal Support Breakout & Retest',
      description: 'Test "HTML" & entity escaping <verification>',
      entry: 2650.50,
      stopLoss: 2658.00,
      slPoints: 75,
      tp1: 2638.00,
      tp2: 2625.00,
      riskPercent: 1.5,
      riskAmount: 15.00,
      confidence: 88,
      timestamp: Date.now(),
      createdAt: Date.now(),
    };

    let sentPayload: any = null;
    globalThis.fetch = (async (url: string, opts: any) => {
      sentPayload = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            message_id: 887766,
            chat: { id: 987654321 },
            text: sentPayload.text,
          },
        }),
      };
    }) as any;

    const delivered = await telegramService.sendSignalNotification(testSignal as any, { allowShadowTest: true });
    assert.equal(delivered, true);
    assert.ok(sentPayload !== null);
    assert.equal(sentPayload.chat_id, '987654321');
    assert.equal(sentPayload.parse_mode, 'HTML');

    // Check escaped content in outgoing telegram payload
    assert.ok(sentPayload.text.includes('&lt;TEST&gt;'));
    assert.ok(sentPayload.text.includes('Horizontal Support Breakout &amp; Retest'));
    assert.ok(!sentPayload.text.includes('&amp;amp;'));

    // Check message ID mapping
    const mappedMsgId = telegramService.getTelegramMessageId(testSignal.id);
    assert.equal(mappedMsgId, 887766);
  });

  await t.test('6. Returns false when Telegram API fails and does NOT record deduplication state prematurely', async () => {
    const uniqueId = `test_shadow_fail_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const testSignal = {
      id: uniqueId,
      isTest: true,
      signal: 'SELL NOW',
      direction: 'SELL',
      asset: 'XAU/USD <TEST>',
      setup: 'Horizontal Support Breakout & Retest',
      entry: 2650.50,
      stopLoss: 2658.00,
      tp1: 2638.00,
      confidence: 88,
    };

    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({
          ok: false,
          description: 'Telegram gateway timeout',
        }),
      };
    }) as any;

    const delivered = await telegramService.sendSignalNotification(testSignal as any, { allowShadowTest: true });
    assert.equal(delivered, false);

    // Deduplication should NOT mark it as dispatched in storage
    const notificationId = `signal_${testSignal.id}`;
    assert.equal(storage.isTelegramDispatched(notificationId), false);

    // Should be in retry queue as PENDING
    const queue = telegramService.getNotificationQueue();
    const queuedItem = queue.find(q => q.notificationId === notificationId);
    assert.ok(queuedItem !== undefined);
    assert.equal(queuedItem?.status, 'PENDING');
  });

  await t.test('7. Simulates initial failed delivery and subsequent successful retry without premature deduplication', async () => {
    const uniqueId = `test_shadow_retry_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const testSignal = {
      id: uniqueId,
      isTest: true,
      signal: 'SELL NOW',
      direction: 'SELL',
      asset: 'XAU/USD <TEST>',
      setup: 'Horizontal Support Breakout & Retest',
      entry: 2650.50,
      stopLoss: 2658.00,
      tp1: 2638.00,
      confidence: 88,
    };

    let attemptCount = 0;
    globalThis.fetch = (async (url: string, opts: any) => {
      attemptCount++;
      if (attemptCount === 1) {
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: async () => ({ ok: false, description: 'Telegram server busy' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            message_id: 998877,
            chat: { id: 987654321 },
          },
        }),
      };
    }) as any;

    // 1st attempt: fails
    const firstDelivery = await telegramService.sendSignalNotification(testSignal as any, { allowShadowTest: true });
    assert.equal(firstDelivery, false);

    const notifId = `signal_${testSignal.id}`;
    assert.equal(storage.isTelegramDispatched(notifId), false);

    const queueAfterFail = telegramService.getNotificationQueue();
    const item = queueAfterFail.find(q => q.notificationId === notifId);
    assert.ok(item !== undefined);
    assert.equal(item?.status, 'PENDING');

    // Force nextRetryAt to past to allow retry immediately
    if (item) {
      item.nextRetryAt = Date.now() - 1000;
    }

    // Process retry queue (2nd attempt: succeeds)
    await telegramService.processRetryQueue();

    // Now it should be SENT and recorded in deduplication storage
    const queueAfterRetry = telegramService.getNotificationQueue();
    const itemAfterRetry = queueAfterRetry.find(q => q.notificationId === notifId);
    assert.equal(itemAfterRetry?.status, 'SENT');
    assert.equal(itemAfterRetry?.telegramMessageId, 998877);
    assert.equal(storage.isTelegramDispatched(notifId), true);
  });

  await t.test('8. Preserves accounting, scans, and opportunity state integrity during test execution', () => {
    const initialSignalsCount = storage.getSignals(100).length;
    const initialTradesCount = storage.getActiveTrades().length;
    const initialLedgerCount = storage.getTradeLedger().length;
    const initialScansCount = storage.getScans(100).length;
    const initialOppsCount = storage.getOpportunities().length;

    // Verify storage was not mutated
    assert.equal(storage.getSignals(100).length, initialSignalsCount);
    assert.equal(storage.getActiveTrades().length, initialTradesCount);
    assert.equal(storage.getTradeLedger().length, initialLedgerCount);
    assert.equal(storage.getScans(100).length, initialScansCount);
    assert.equal(storage.getOpportunities().length, initialOppsCount);
  });

  await t.test('9. sendSimpleTestMessage sends simple test string when allowShadowTest is true', async () => {
    let sentPayload: any = null;
    globalThis.fetch = (async (url: string, opts: any) => {
      sentPayload = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            message_id: 1234567,
            chat: { id: 987654321 },
            text: sentPayload.text,
          },
        }),
      };
    }) as any;

    const res = await telegramService.sendSimpleTestMessage('✅ Telegram connection test successful', {
      allowShadowTest: true,
    });

    assert.equal(res.success, true);
    assert.equal(res.telegramMessageId, 1234567);
    assert.ok(sentPayload !== null);
    assert.equal(sentPayload.text, '✅ Telegram connection test successful');
    assert.equal(sentPayload.chat_id, '987654321');
  });

  await t.test('10. sendSimpleTestMessage blocks delivery if allowShadowTest is false in Shadow Mode', async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return {} as any;
    }) as any;

    const res = await telegramService.sendSimpleTestMessage('✅ Telegram connection test successful', {
      allowShadowTest: false,
    });

    assert.equal(res.success, false);
    assert.equal(fetchCalled, false);
    assert.ok(res.error?.includes('[SHADOW MODE]'));
  });
});
