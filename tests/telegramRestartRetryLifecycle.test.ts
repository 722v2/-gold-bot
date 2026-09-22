import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { TelegramService, telegramService, setApplicationStartedAt } from '../server/telegram.js';

test('Telegram Restart & Retry Lifecycle Verification Suite', async (t) => {
  const testQueuePath = path.resolve(process.cwd(), 'data', 'telegram_retry_queue_lifecycle_test.json');
  const now = Date.now();
  setApplicationStartedAt(now);

  // Setup mock message interceptor
  let sentMessages: Array<{ chatId: string; text: string }> = [];
  let shouldFailSends = false;

  const originalSendMessage = (telegramService as any).sendMessageDirectly;
  (telegramService as any).sendMessageDirectly = async (chatId: string, text: string, replyMarkup?: any) => {
    if (shouldFailSends) {
      (telegramService as any).lastSendError = 'Simulated Network Failure (HTTP 500)';
      return null;
    }
    sentMessages.push({ chatId, text });
    return { message_id: 888000 + sentMessages.length };
  };

  (telegramService as any).getBotToken = () => 'MOCK_BOT_TOKEN_123';
  (telegramService as any).getPrivateChatId = () => '999111';
  ((telegramService as any).notificationQueue as Map<string, any>).clear();

  await t.test('1. Successful immediate send delivers message and records SENT status', async () => {
    sentMessages = [];
    shouldFailSends = false;

    const notifId = `sig_immediate_${Date.now()}`;
    const res = await telegramService.dispatchReliableNotification({
      notificationId: notifId,
      tradeId: 'real_trade_001',
      event: 'SIGNAL_NEW',
      message: 'Immediate signal test',
      eventTimestamp: Date.now(),
    });

    assert.equal(res.success, true, 'Immediate dispatch should succeed');
    assert.equal(sentMessages.length, 1, 'Exactly one message must be sent');
    assert.equal(sentMessages[0].text, 'Immediate signal test');

    const item = ((telegramService as any).notificationQueue as Map<string, any>).get(notifId);
    assert.equal(item?.status, 'SENT', 'Queue item status must be SENT');
  });

  await t.test('2. Failed send queues item as PENDING; retry loop delivers it when connection recovers', async () => {
    sentMessages = [];
    shouldFailSends = true;

    const notifId = `sig_failed_then_retry_${Date.now()}`;
    const res = await telegramService.dispatchReliableNotification({
      notificationId: notifId,
      tradeId: 'real_trade_002',
      event: 'SIGNAL_NEW',
      message: 'Failed then retry message',
      eventTimestamp: Date.now(),
    });

    assert.equal(res.success, false, 'Initial dispatch must fail');
    assert.equal(sentMessages.length, 0, 'Zero messages sent during failure');

    const q = (telegramService as any).notificationQueue as Map<string, any>;
    const item = q.get(notifId);
    assert.equal(item?.status, 'PENDING', 'Queue item status must be PENDING');
    assert.equal(item?.attempts, 1, 'Must have 1 recorded attempt');

    // Connection recovers
    shouldFailSends = false;
    item.nextRetryAt = 0; // ready immediately

    await telegramService.processRetryQueue();

    assert.equal(sentMessages.length, 1, 'Retry must deliver the message once connection recovers');
    assert.equal(sentMessages[0].text, 'Failed then retry message');
    assert.equal(item.status, 'SENT', 'Status must transition to SENT');
  });

  await t.test('3. Failed send survives server restart and retries successfully', async () => {
    sentMessages = [];
    shouldFailSends = true;

    const notifId = `sig_restart_survive_${Date.now()}`;
    const res = await telegramService.dispatchReliableNotification({
      notificationId: notifId,
      tradeId: 'real_trade_003',
      event: 'SIGNAL_NEW',
      message: 'Message surviving restart',
      eventTimestamp: Date.now(),
    });

    assert.equal(res.success, false, 'Initial dispatch fails');

    // Save current queue to test file
    const queueData = Array.from(((telegramService as any).notificationQueue as Map<string, any>).values());
    fs.mkdirSync(path.dirname(testQueuePath), { recursive: true });
    fs.writeFileSync(testQueuePath, JSON.stringify(queueData, null, 2), 'utf8');

    // SIMULATE SERVER RESTART: Create fresh TelegramService instance loading testQueuePath
    const restartedService = new (TelegramService as any)();
    (restartedService as any).retryQueuePath = testQueuePath;
    (restartedService as any).getBotToken = () => 'MOCK_BOT_TOKEN_123';
    (restartedService as any).getPrivateChatId = () => '999111';
    (restartedService as any).sendMessageDirectly = async (chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return { message_id: 999000 + sentMessages.length };
    };

    // Load queue on restarted service
    (restartedService as any).loadNotificationQueue();

    const restartedQueue = (restartedService as any).notificationQueue as Map<string, any>;
    const pendingItem = restartedQueue.get(notifId);

    assert.ok(pendingItem, 'Pending item must be loaded into memory on restart');
    assert.equal(pendingItem?.status, 'PENDING', 'Actionable item must remain PENDING across restart');

    // Process retry queue on restarted service
    shouldFailSends = false;
    pendingItem.nextRetryAt = 0;
    await restartedService.processRetryQueue();

    assert.equal(sentMessages.length, 1, 'Message must be delivered by restarted service');
    assert.equal(sentMessages[0].text, 'Message surviving restart');
    assert.equal(pendingItem.status, 'SENT', 'Pending item must become SENT after delivery on restarted service');
  });

  await t.test('4. Stale pending notification exceeding actionability window is SUPPRESSED on restart', async () => {
    sentMessages = [];

    const staleSignalId = `sig_stale_${Date.now()}`;
    const staleOutcomeId = `outcome_stale_${Date.now()}`;

    // Signal created 20 minutes ago (> 15 min actionability window)
    // Outcome created 45 minutes ago (> 30 min actionability window)
    const staleData = [
      {
        notificationId: staleSignalId,
        tradeId: 'real_trade_stale_1',
        event: 'SIGNAL_NEW',
        message: 'Stale 20m old signal',
        status: 'PENDING',
        attempts: 1,
        maxAttempts: 10,
        createdAt: Date.now() - 20 * 60 * 1000,
        nextRetryAt: 0,
      },
      {
        notificationId: staleOutcomeId,
        tradeId: 'real_trade_stale_2',
        event: 'OUTCOME_CLOSE',
        message: 'Stale 45m old outcome',
        status: 'PENDING',
        attempts: 2,
        maxAttempts: 10,
        createdAt: Date.now() - 45 * 60 * 1000,
        nextRetryAt: 0,
      },
    ];

    fs.writeFileSync(testQueuePath, JSON.stringify(staleData, null, 2), 'utf8');

    const service = new (TelegramService as any)();
    (service as any).retryQueuePath = testQueuePath;
    (service as any).getBotToken = () => 'MOCK_BOT_TOKEN_123';
    (service as any).getPrivateChatId = () => '999111';
    (service as any).sendMessageDirectly = async (chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return { message_id: 111 };
    };

    (service as any).loadNotificationQueue();

    const q = (service as any).notificationQueue as Map<string, any>;
    assert.equal(q.get(staleSignalId)?.status, 'SUPPRESSED', 'Stale 20m signal must be SUPPRESSED');
    assert.equal(q.get(staleOutcomeId)?.status, 'SUPPRESSED', 'Stale 45m outcome must be SUPPRESSED');

    await service.processRetryQueue();
    assert.equal(sentMessages.length, 0, 'Zero messages must be sent for stale items');
  });

  await t.test('5. Already SENT notification is NEVER resent across restarts', async () => {
    sentMessages = [];

    const sentNotifId = `sent_already_${Date.now()}`;
    const sentData = [
      {
        notificationId: sentNotifId,
        tradeId: 'real_trade_sent_1',
        event: 'SIGNAL_NEW',
        message: 'Already sent message',
        status: 'SENT',
        attempts: 1,
        maxAttempts: 10,
        createdAt: Date.now() - 5 * 60 * 1000,
        sentAt: Date.now() - 5 * 60 * 1000,
      },
    ];

    fs.writeFileSync(testQueuePath, JSON.stringify(sentData, null, 2), 'utf8');

    const service = new (TelegramService as any)();
    (service as any).retryQueuePath = testQueuePath;
    (service as any).getBotToken = () => 'MOCK_BOT_TOKEN_123';
    (service as any).getPrivateChatId = () => '999111';
    (service as any).sendMessageDirectly = async (chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return { message_id: 222 };
    };

    (service as any).loadNotificationQueue();

    const q = (service as any).notificationQueue as Map<string, any>;
    assert.equal(q.get(sentNotifId)?.status, 'SENT', 'Must remain SENT in queue');

    await service.processRetryQueue();
    assert.equal(sentMessages.length, 0, 'Zero messages sent from processRetryQueue for SENT item');

    // Attempting to dispatch again must return cached success and send 0 messages
    const res = await service.dispatchReliableNotification({
      notificationId: sentNotifId,
      tradeId: 'real_trade_sent_1',
      event: 'SIGNAL_NEW',
      message: 'Already sent message',
      eventTimestamp: Date.now(),
    });

    assert.equal(res.success, true, 'Dispatch returns cached success');
    assert.equal(sentMessages.length, 0, 'Zero additional messages sent to Telegram');
  });

  await t.test('6. Duplicate retry / double dispatch produces 0 duplicate Telegram messages', async () => {
    sentMessages = [];
    shouldFailSends = false;

    const notifId = `sig_duplicate_check_${Date.now()}`;

    // First dispatch -> sends 1 message
    const res1 = await telegramService.dispatchReliableNotification({
      notificationId: notifId,
      tradeId: 'real_trade_dup_1',
      event: 'SIGNAL_NEW',
      message: 'Unique signal alert',
      eventTimestamp: Date.now(),
    });
    assert.equal(res1.success, true);
    assert.equal(sentMessages.length, 1, 'First dispatch sends 1 message');

    // Second dispatch with same notificationId -> idempotent 0 duplicate messages
    const res2 = await telegramService.dispatchReliableNotification({
      notificationId: notifId,
      tradeId: 'real_trade_dup_1',
      event: 'SIGNAL_NEW',
      message: 'Unique signal alert',
      eventTimestamp: Date.now(),
    });
    assert.equal(res2.success, true);
    assert.equal(sentMessages.length, 1, 'Second dispatch produces 0 additional messages');

    // Process retry queue -> still 0 additional messages
    await telegramService.processRetryQueue();
    assert.equal(sentMessages.length, 1, 'Retry processor produces 0 additional messages');
  });

  await t.test('7. escapeTelegramHtml properly escapes HTML special characters in signal messages', async () => {
    sentMessages = [];
    shouldFailSends = false;

    const signalWithSpecialChars = {
      id: `sig_special_${Date.now()}`,
      signal: 'BUY NOW',
      asset: 'XAU/USD & Commodities <Gold>',
      entry: 4346.61,
      stopLoss: 4340.00,
      slPoints: 66,
      tp1: 4355.00,
      tp2: 4360.00,
      riskPercent: 1.5,
      riskAmount: 15.00,
      confidence: 95,
      setup: 'Horizontal Support Breakout & Retest "Confirmed" <M5>',
      createdAt: Date.now(),
    };

    const sent = await telegramService.sendSignalNotification(signalWithSpecialChars);
    assert.equal(sent, true, 'sendSignalNotification must succeed');
    assert.equal(sentMessages.length, 1, 'One message must be sent');
    
    const sentText = sentMessages[0].text;
    assert.ok(sentText.includes('Horizontal Support Breakout &amp; Retest &quot;Confirmed&quot; &lt;M5&gt;'), 'Special characters in setup must be safely escaped');
    assert.ok(!sentText.includes('Breakout & Retest'), 'Raw unescaped & must not exist in output');
  });

  await t.test('8. Failed send does NOT mark dispatch in persistent storage until confirmed delivery', async () => {
    sentMessages = [];
    shouldFailSends = true;

    const notifId = `sig_fail_nodedup_${Date.now()}`;
    const res = await telegramService.dispatchReliableNotification({
      notificationId: notifId,
      tradeId: 'real_trade_fail_dedup',
      event: 'SIGNAL_NEW',
      message: 'Failed notification test',
      eventTimestamp: Date.now(),
    });

    assert.equal(res.success, false, 'Initial send must fail');

    // Deduplication store MUST NOT have this notification recorded yet!
    assert.equal(
      (telegramService as any).safelyIsTelegramDispatched(notifId),
      false,
      'Failed notification must NOT be marked as dispatched in deduplication store'
    );

    // Now connection recovers and retry succeeds
    shouldFailSends = false;
    const q = (telegramService as any).notificationQueue as Map<string, any>;
    const item = q.get(notifId);
    if (item) item.nextRetryAt = 0;

    await telegramService.processRetryQueue();

    assert.equal(sentMessages.length, 1, 'Message delivered upon retry');
    assert.equal(
      (telegramService as any).safelyIsTelegramDispatched(notifId),
      true,
      'Successful retry must now record the notification in deduplication store'
    );
  });

  await t.test('9. Retry queue normalizes unescaped ampersands before retrying Telegram delivery', async () => {
    sentMessages = [];
    shouldFailSends = false;

    const malformedNotifId = `sig_malformed_amp_${Date.now()}`;
    const rawMessageWithAmp = '<b>Signal:</b> Retest & Breakout with Profit & Loss';

    const q = (telegramService as any).notificationQueue as Map<string, any>;
    q.set(malformedNotifId, {
      notificationId: malformedNotifId,
      tradeId: 'trade_amp_fix',
      event: 'SIGNAL_NEW',
      chatId: '999111',
      message: rawMessageWithAmp,
      status: 'PENDING',
      attempts: 1,
      maxAttempts: 5,
      nextRetryAt: 0,
      createdAt: Date.now(),
    });

    await telegramService.processRetryQueue();

    assert.equal(sentMessages.length, 1, 'Message should be sent on retry');
    assert.ok(sentMessages[0].text.includes('Retest &amp; Breakout with Profit &amp; Loss'), 'Unescaped & must be normalized to &amp;');
    assert.equal(q.get(malformedNotifId)?.status, 'SENT', 'Status must be updated to SENT');
  });

  // Cleanup test artifacts
  try {
    if (fs.existsSync(testQueuePath)) fs.unlinkSync(testQueuePath);
  } catch {}

  (telegramService as any).sendMessageDirectly = originalSendMessage;
  setTimeout(() => process.exit(0), 100);
});
