import test from 'node:test';
import assert from 'node:assert/strict';
import { storage } from '../server/storage.js';
import { telegramService, applicationStartedAt, setApplicationStartedAt } from '../server/telegram.js';
import { tradeManagementEngine } from '../server/tradeManagementEngine.js';

test('Telegram Deploy Replay Prevention Suite (10-Point Verification)', async (t) => {
  storage.setTestingMode(true);

  // Define a distinct deployment timestamp boundary
  const deployTime = Date.now();
  setApplicationStartedAt(deployTime);

  // Set up test chat registration and message capture spy
  (telegramService as any).botToken = '123456:mock_token_for_tests';
  (telegramService as any).privateChatId = 'test_chat_999888';
  (telegramService as any).notificationQueue.clear();
  let sentMessages: Array<{ chatId: string; message: string; markup?: any }> = [];
  let nextMsgId = 1000;

  (telegramService as any).sendMessageDirectly = async (chatId: string, message: string, markup?: any) => {
    sentMessages.push({ chatId, message, markup });
    return { message_id: nextMsgId++ };
  };

  await t.test('Test 1: 10 historical closed trades loaded at startup -> 0 Telegram notifications sent', async () => {
    sentMessages = [];
    const historicalTrades = Array.from({ length: 10 }, (_, i) => ({
      id: `hist_trade_${i + 1}`,
      signalId: `hist_sig_${i + 1}`,
      isoTime: new Date(deployTime - 3600000 - i * 60000).toISOString(),
      direction: (i % 2 === 0 ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
      entry: 2650.0,
      sl: 2640.0,
      tp1: 2660.0,
      tp2: 2670.0,
      result: (i % 2 === 0 ? 'WIN' : 'LOSS') as 'WIN' | 'LOSS',
      isActive: false,
      exitTime: new Date(deployTime - 1800000 - i * 60000).toISOString(),
      exitPrice: i % 2 === 0 ? 2660.0 : 2640.0,
      pnl: i % 2 === 0 ? 10.0 : -10.0,
      closeReason: 'Historical closed trade test',
    }));

    // Simulate startup state restoration of historical trades
    for (const trade of historicalTrades) {
      storage.saveTrade(trade as any);
      // Attempting to emit or replay outcome for historical trades must be completely suppressed
      const res = await (telegramService as any).dispatchReliableNotification({
        notificationId: `close_${trade.id}`,
        tradeId: trade.id,
        event: 'OUTCOME_CLOSE',
        message: 'Historical close outcome',
        eventTimestamp: new Date(trade.exitTime).getTime(),
      });
      assert.equal(res.suppressed, true, `Historical trade ${trade.id} must be suppressed`);
    }

    assert.equal(sentMessages.length, 0, 'Zero Telegram notifications must be sent for historical trades');
  });

  await t.test('Test 2: Historical WIN trade in ledger -> 0 Telegram notifications sent', async () => {
    sentMessages = [];
    const winTrade = {
      id: 'hist_win_123',
      signalId: 'hist_sig_win',
      isoTime: new Date(deployTime - 500000).toISOString(),
      direction: 'BUY',
      entry: 2650.0,
      sl: 2640.0,
      tp1: 2660.0,
      result: 'WIN',
      isActive: false,
      exitTime: new Date(deployTime - 250000).toISOString(),
      exitPrice: 2660.0,
      pnl: 15.0,
      closeReason: 'TP1 Hit',
    };
    storage.saveTrade(winTrade as any);

    const outcomeRecord = {
      signalId: winTrade.signalId,
      tradeId: winTrade.id,
      outcome: 'WIN' as const,
      realizedPnl: 15.0,
      entry: winTrade.entry,
      exitPrice: winTrade.exitPrice,
      closeReason: winTrade.closeReason,
      timestamp: new Date(winTrade.exitTime).getTime(), // Prior to deployTime
      source: 'SYSTEM' as const,
    };

    const sent = await telegramService.sendOutcomeNotification(outcomeRecord, winTrade, {
      notificationId: `close_${winTrade.id}`,
      eventTimestamp: outcomeRecord.timestamp,
    });

    assert.equal(sent, false, 'Historical WIN trade notification must not be dispatched');
    assert.equal(sentMessages.length, 0, 'Zero messages must be sent for historical WIN trade');
  });

  await t.test('Test 3: Historical LOSS trade in ledger -> 0 Telegram notifications sent', async () => {
    sentMessages = [];
    const lossTrade = {
      id: 'hist_loss_456',
      signalId: 'hist_sig_loss',
      isoTime: new Date(deployTime - 400000).toISOString(),
      direction: 'SELL',
      entry: 2650.0,
      sl: 2660.0,
      tp1: 2640.0,
      result: 'LOSS',
      isActive: false,
      exitTime: new Date(deployTime - 200000).toISOString(),
      exitPrice: 2660.0,
      pnl: -10.0,
      closeReason: 'SL Hit',
    };
    storage.saveTrade(lossTrade as any);

    const outcomeRecord = {
      signalId: lossTrade.signalId,
      tradeId: lossTrade.id,
      outcome: 'LOSS' as const,
      realizedPnl: -10.0,
      entry: lossTrade.entry,
      exitPrice: lossTrade.exitPrice,
      closeReason: lossTrade.closeReason,
      timestamp: new Date(lossTrade.exitTime).getTime(), // Prior to deployTime
      source: 'SYSTEM' as const,
    };

    const sent = await telegramService.sendOutcomeNotification(outcomeRecord, lossTrade, {
      notificationId: `close_${lossTrade.id}`,
      eventTimestamp: outcomeRecord.timestamp,
    });

    assert.equal(sent, false, 'Historical LOSS trade notification must not be dispatched');
    assert.equal(sentMessages.length, 0, 'Zero messages must be sent for historical LOSS trade');
  });

  await t.test('Test 4: Historical EARLY_EXIT trade -> 0 Telegram notifications sent', async () => {
    sentMessages = [];
    const earlyExitTrade = {
      id: 'hist_early_exit_789',
      signalId: 'hist_sig_early',
      isoTime: new Date(deployTime - 300000).toISOString(),
      direction: 'BUY',
      entry: 2650.0,
      sl: 2640.0,
      tp1: 2660.0,
      result: 'LOSS',
      isActive: false,
      exitTime: new Date(deployTime - 150000).toISOString(),
      exitPrice: 2648.0,
      pnl: -2.0,
      closeReason: 'EARLY_EXIT: Momentum decay',
    };
    storage.saveTrade(earlyExitTrade as any);

    const sent = await telegramService.sendManagementNotification('EARLY_EXIT triggered historically', {
      notificationId: `early_exit_${earlyExitTrade.id}`,
      tradeId: earlyExitTrade.id,
      event: 'EARLY_EXIT',
      eventTimestamp: new Date(earlyExitTrade.exitTime).getTime(),
    });

    assert.equal(sent, false, 'Historical EARLY_EXIT notification must not be dispatched');
    assert.equal(sentMessages.length, 0, 'Zero messages must be sent for historical EARLY_EXIT trade');
  });

  await t.test('Test 5: Existing open trade restored at startup -> 0 trade opened notifications sent', async () => {
    sentMessages = [];
    const openTradeTime = deployTime - 100000;
    const existingOpenTrade = {
      id: 'active_trade_restored_001',
      signalId: 'sig_open_001',
      isoTime: new Date(openTradeTime).toISOString(),
      direction: 'BUY' as const,
      entry: 2650.0,
      sl: 2640.0,
      tp1: 2660.0,
      tp2: 2670.0,
      result: 'OPEN' as const,
      isActive: true,
      openTime: new Date(openTradeTime).toISOString(),
    };
    // Restoring open trade into ledger memory
    storage.saveTrade(existingOpenTrade as any);

    // If an attempt is made to replay or broadcast the signal for this restored trade, it must be suppressed
    const sent = await telegramService.sendSignalNotification({
      id: existingOpenTrade.signalId,
      signal: 'BUY',
      entry: existingOpenTrade.entry,
      stopLoss: existingOpenTrade.sl,
      tp1: existingOpenTrade.tp1,
      tp2: existingOpenTrade.tp2,
      confidence: 85,
      timestamp: openTradeTime, // Before deployment
    });

    assert.equal(sent, false, 'Restored active trade signal must not generate a new notification on startup');
    assert.equal(sentMessages.length, 0, 'Zero Telegram notifications must be emitted for restored active trade');
  });

  await t.test('Test 6: Existing open trade reaches TP1 after deploy -> 1 TP1 notification sent', async () => {
    sentMessages = [];
    const openTrade = storage.getTrade('active_trade_restored_001');
    assert.ok(openTrade, 'Open trade should exist in storage');

    // Trade genuinely reaches TP1 at 10 seconds AFTER deployTime
    const newEventTime = deployTime + 10000;
    const formattedMsg = '🎯 <b>تم تحقيق الهدف الأول (TP1) بنجاح!</b>\nسعر الذهب وصل إلى $2660.00';

    const sent = await telegramService.sendManagementNotification(formattedMsg, {
      notificationId: `mgmt_tp1_${openTrade.id}`,
      tradeId: openTrade.id,
      event: 'PARTIAL_CLOSE_TP1',
      eventTimestamp: newEventTime,
    });

    assert.equal(sent, true, 'Genuine new TP1 event after deploy must be successfully sent');
    assert.equal(sentMessages.length, 1, 'Exactly 1 notification must be sent for new TP1 reach');
    assert.ok(sentMessages[0].message.includes('TP1'), 'Sent message must contain TP1 content');
  });

  await t.test('Test 7: Existing open trade reaches SL after deploy -> 1 SL/close notification sent', async () => {
    sentMessages = [];
    const openTrade = storage.getTrade('active_trade_restored_001');
    assert.ok(openTrade, 'Open trade should exist in storage');

    // Trade hits SL at 20 seconds AFTER deployTime
    const slEventTime = deployTime + 20000;
    const outcomeRecord = {
      signalId: openTrade.signalId || openTrade.id,
      tradeId: openTrade.id,
      outcome: 'LOSS' as const,
      realizedPnl: -10.0,
      entry: openTrade.entry,
      exitPrice: 2640.0,
      closeReason: 'Stop Loss Hit at 2640.00',
      timestamp: slEventTime,
      source: 'SYSTEM' as const,
    };

    const sent = await telegramService.sendOutcomeNotification(outcomeRecord, openTrade, {
      notificationId: `close_${openTrade.id}`,
      eventTimestamp: slEventTime,
    });

    assert.equal(sent, true, 'Genuine new SL event after deploy must be sent');
    assert.equal(sentMessages.length, 1, 'Exactly 1 notification must be sent for new SL exit');
    assert.ok(sentMessages[0].message.includes('LOSS') || sentMessages[0].message.includes('صفقة خاسرة'), 'Notification must describe the close');
  });

  const testSigId = `sig_genuinely_new_${deployTime}`;

  await t.test('Test 8: New trade opens after deploy -> 1 signal notification sent', async () => {
    sentMessages = [];
    const newTradeTime = deployTime + 30000;
    const newSignal = {
      id: testSigId,
      signal: 'BUY NOW',
      entry: 2675.50,
      stopLoss: 2665.50,
      slPoints: 100,
      tp1: 2685.50,
      tp2: 2695.50,
      riskPercent: 15,
      riskAmount: 1.5,
      confidence: 90,
      setup: 'Bullish Continuation',
      timestamp: newTradeTime,
    };

    const sent = await telegramService.sendSignalNotification(newSignal);
    assert.equal(sent, true, 'Genuine new signal after deploy must be delivered');
    assert.equal(sentMessages.length, 1, 'Exactly 1 notification must be sent for new trade signal');
    assert.ok(sentMessages[0].message.includes('BUY NOW') || sentMessages[0].message.includes('2675.50'), 'Signal message must be accurate');
  });

  await t.test('Test 9: Duplicate notification for same event -> 0 duplicate notifications sent', async () => {
    // Current sentMessages from Test 8 has length 1.
    // Try to dispatch the exact same signal notification again:
    const duplicateSignal = {
      id: testSigId,
      signal: 'BUY NOW',
      entry: 2675.50,
      stopLoss: 2665.50,
      slPoints: 100,
      tp1: 2685.50,
      tp2: 2695.50,
      confidence: 90,
      timestamp: deployTime + 30000,
    };

    const initialSentCount = sentMessages.length;
    const sentDuplicate = await telegramService.sendSignalNotification(duplicateSignal);

    // Should return true (idempotently acknowledged) but NOT invoke sendMessageDirectly again
    assert.equal(sentMessages.length, initialSentCount, 'No additional duplicate message must be sent to Telegram');
  });

  await t.test('Test 10: Retry queue contains old sent notifications -> none resent on restart', async () => {
    sentMessages = [];
    const q = (telegramService as any).notificationQueue as Map<string, any>;

    // Inject items that were previously marked as SENT or are historical
    q.set('old_sent_signal_111', {
      notificationId: 'old_sent_signal_111',
      tradeId: 'trade_111',
      event: 'SIGNAL_NEW',
      chatId: 'test_chat_999888',
      message: 'Old signal message',
      status: 'SENT',
      attempts: 1,
      maxAttempts: 10,
      nextRetryAt: 0,
      createdAt: deployTime - 100000,
      sentAt: deployTime - 99000,
    });

    q.set('historical_pending_222', {
      notificationId: 'historical_pending_222',
      tradeId: 'trade_222',
      event: 'OUTCOME_CLOSE',
      chatId: 'test_chat_999888',
      message: 'Historical pending outcome',
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 10,
      nextRetryAt: deployTime - 50000,
      createdAt: deployTime - 50000, // Prior to deployTime!
    });

    // Run the retry loop processor
    await telegramService.processRetryQueue();

    // Verify neither the old sent notification nor the historical pending item was sent to Telegram
    assert.equal(sentMessages.length, 0, 'Zero messages must be resent for old SENT or historical PENDING items');
    const histItem = q.get('historical_pending_222');
    assert.equal(histItem?.status, 'SUPPRESSED', 'Historical pending item must be converted to SUPPRESSED');
  });

  // Clean exit after tests complete
  setTimeout(() => process.exit(0), 100);
});
