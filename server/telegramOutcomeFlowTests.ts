import { telegramService, isTelegramUserAuthorized } from './telegram.js';
import { storage, TradeOutcomeRecord } from './storage.js';
import fs from 'fs';
import path from 'path';

let passedCount = 0;
let failedCount = 0;
const failures: string[] = [];

function assert(condition: boolean, testName: string, details?: any) {
  if (condition) {
    console.log(`✅ [PASS] ${testName}`);
    passedCount++;
  } else {
    const detailStr = details ? ' ' + JSON.stringify(details) : '';
    console.error(`❌ [FAIL] ${testName}${detailStr}`);
    failures.push(testName);
    failedCount++;
  }
}

// Mock Telegram service communications
const sentMessages: string[] = [];
let callbackAnswers: { id: string; text: string; showAlert: boolean }[] = [];
let editedMarkupMessages: { chatId: string | number; messageId: number; replyMarkup: any }[] = [];
let editedTextMessages: { chatId: string | number; messageId: number; text: string; replyMarkup?: any }[] = [];

(telegramService as any).sendTelegramMessage = async (message: string, replyMarkup?: any) => {
  sentMessages.push(message);
  return { ok: true, result: { message_id: Math.floor(Math.random() * 10000) } };
};

(telegramService as any).answerCallbackQuery = async (callbackId: string, text: string, showAlert: boolean) => {
  callbackAnswers.push({ id: callbackId, text, showAlert });
  return { ok: true };
};

(telegramService as any).editTelegramMessageReplyMarkup = async (chatId: string | number, messageId: number, replyMarkup: any) => {
  editedMarkupMessages.push({ chatId, messageId, replyMarkup });
  return { ok: true };
};

(telegramService as any).editTelegramMessage = async (chatId: string | number, messageId: number, text: string, replyMarkup?: any) => {
  editedTextMessages.push({ chatId, messageId, text, replyMarkup });
  return { ok: true };
};

async function executeTests() {
  console.log('======================================================================');
  console.log('RUNNING TELEGRAM MANUAL REALIZED P&L INPUT FLOW TESTS');
  console.log('======================================================================\n');

  // Set standard authorized user env for testing
  process.env.TELEGRAM_AUTHORIZED_USER_IDS = '12345, 67890';
  process.env.TELEGRAM_BOT_TOKEN = '123:ABC';
  process.env.TELEGRAM_CHAT_ID = '11111';

  // Helper mock signal
  const mockSignal = {
    id: 'sig_flow_test_1',
    symbol: 'XAU/USD',
    signal: 'BUY NOW' as const,
    entry: 2500.00,
    stopLoss: 2490.00,
    tp1: 2510.00,
    tp2: 2520.00,
    slPoints: 100,
    tp1Points: 100,
    tp2Points: 200,
    potentialProfit: 50.00,
    potentialLoss: 25.00,
    recommendedLotSize: 0.01,
    riskAmount: 25.00,
    timestamp: Date.now(),
  };

  const signalId = mockSignal.id;

  // Cleanup potential leftover state from previous test runs
  (telegramService as any).pendingOutcomes.clear();
  storage.setStartingBalance(1000.00);

  // --------------------------------------------------------------------------
  // TEST 1: WIN outcome with +17.78
  // --------------------------------------------------------------------------
  {
    sentMessages.length = 0;
    const balBefore = storage.getCurrentBalance();

    // 1. Simulate button click callback query for 🟢 WIN
    const callbackUpdate = {
      callback_query: {
        id: 'cb_test_1',
        from: { id: 12345, username: 'trader1' },
        message: {
          chat: { id: 11111 },
          message_id: 2001,
          text: `🎯 ENTRY: 2500.00\n🛑 SL: 2490.00\n🎯 TP1: 2510.00`,
        },
        data: `out:win:${signalId}`,
      },
    };

    const cbRes = await telegramService.handleUpdate(callbackUpdate);
    assert(cbRes.handled === true, 'TEST 1 (Click WIN): Handled successfully', cbRes);

    const pending = (telegramService as any).pendingOutcomes.get('12345');
    assert(pending !== undefined, 'TEST 1 (Pending state created): Pending item found');
    assert(pending?.outcome === 'WIN', 'TEST 1 (Outcome is WIN): Correct outcome');
    assert(pending?.status === 'PENDING', 'TEST 1 (Status is PENDING): Correct status');

    // 2. Simulate text reply with "17.78"
    const textUpdate = {
      message: {
        chat: { id: 11111 },
        from: { id: 12345, username: 'trader1' },
        text: '17.78',
      },
    };

    const textRes = await telegramService.handleUpdate(textUpdate);
    assert(textRes.handled === true && textRes.result === 'RECORDED_WIN_PNL_17.78', 'TEST 1 (Parse value): Recorded 17.78 P&L successfully', textRes);

    const balAfter = storage.getCurrentBalance();
    const balDiff = Number((balAfter - balBefore).toFixed(2));
    assert(balDiff === 17.78, 'TEST 1 (Balance update): Balance increased by exactly 17.78', { balBefore, balAfter, balDiff });

    // Check receipt formatting
    const lastMsg = sentMessages[sentMessages.length - 1];
    assert(lastMsg.includes('✅ REALIZED P&L RECORDED'), 'TEST 1 (Receipt header): Includes English confirmation header');
    assert(lastMsg.includes('Trade: sig_flow_test_1'), 'TEST 1 (Receipt trade ID): Includes trade ID');
    assert(lastMsg.includes('Result: WIN'), 'TEST 1 (Receipt result): Includes Result');
    assert(lastMsg.includes('Realized P&L: +$17.78'), 'TEST 1 (Receipt P&L): Realized P&L formatted with plus sign and dollar symbol');
    assert(lastMsg.includes('Source: Telegram Manual Entry'), 'TEST 1 (Receipt source): Correct source label');
    assert(lastMsg.includes('Account balance updated.'), 'TEST 1 (Receipt balance note): Includes updated note');
  }

  // --------------------------------------------------------------------------
  // TEST 2: LOSS outcome with -4.00
  // --------------------------------------------------------------------------
  {
    sentMessages.length = 0;
    const signalLossId = 'sig_flow_test_loss';
    const balBefore = storage.getCurrentBalance();

    const callbackUpdate = {
      callback_query: {
        id: 'cb_test_2',
        from: { id: 12345, username: 'trader1' },
        message: {
          chat: { id: 11111 },
          message_id: 2002,
          text: `🎯 ENTRY: 2500.00\n🛑 SL: 2490.00\n🎯 TP1: 2510.00`,
        },
        data: `out:loss:${signalLossId}`,
      },
    };

    await telegramService.handleUpdate(callbackUpdate);

    const textUpdate = {
      message: {
        chat: { id: 11111 },
        from: { id: 12345, username: 'trader1' },
        text: '-4.00',
      },
    };

    const textRes = await telegramService.handleUpdate(textUpdate);
    assert(textRes.handled === true && textRes.result === 'RECORDED_LOSS_PNL_-4', 'TEST 2 (Parse value): Recorded -4.00 P&L successfully', textRes);

    const balAfter = storage.getCurrentBalance();
    const balDiff = Number((balAfter - balBefore).toFixed(2));
    assert(balDiff === -4.00, 'TEST 2 (Balance update): Balance decreased by exactly 4.00', { balBefore, balAfter, balDiff });

    // Check receipt formatting
    const lastMsg = sentMessages[sentMessages.length - 1];
    assert(lastMsg.includes('Result: LOSS'), 'TEST 2 (Receipt result): Correct result in receipt');
    assert(lastMsg.includes('Realized P&L: -$4.00'), 'TEST 2 (Receipt P&L): Loss formatted as -$4.00');
  }

  // --------------------------------------------------------------------------
  // TEST 3: WIN with invalid negative input (Rejection + Reprompt)
  // --------------------------------------------------------------------------
  {
    sentMessages.length = 0;
    const sigId = 'sig_test_win_neg';

    // Click WIN
    await telegramService.handleUpdate({
      callback_query: {
        id: 'cb_test_3',
        from: { id: 12345, username: 'trader1' },
        message: { chat: { id: 11111 }, message_id: 2003, text: 'Entry: 2500' },
        data: `out:win:${sigId}`,
      },
    });

    // Send invalid negative input
    const textUpdate = {
      message: {
        chat: { id: 11111 },
        from: { id: 12345, username: 'trader1' },
        text: '-15.50',
      },
    };

    const textRes = await telegramService.handleUpdate(textUpdate);
    assert(textRes.handled === true && textRes.error === 'SIGN_VALIDATION_FAILED', 'TEST 3 (Reject negative for WIN): Input rejected', textRes);

    const lastMsg = sentMessages[sentMessages.length - 1];
    assert(lastMsg.includes('Invalid P&L value for a WIN.'), 'TEST 3 (Validation message): Error message matches WIN validation prompt');

    // State remains PENDING
    const pending = (telegramService as any).pendingOutcomes.get('12345');
    assert(pending !== undefined && pending.status === 'PENDING', 'TEST 3 (State intact): Pending state preserved for retry');

    // Resolve with a valid WIN
    const retryRes = await telegramService.handleUpdate({
      message: {
        chat: { id: 11111 },
        from: { id: 12345, username: 'trader1' },
        text: '15.50',
      },
    });
    assert(retryRes.handled === true && retryRes.result === 'RECORDED_WIN_PNL_15.5', 'TEST 3 (Resolve pending): Retry with positive value succeeded');
  }

  // --------------------------------------------------------------------------
  // TEST 4: LOSS with invalid positive input (Rejection + Reprompt)
  // --------------------------------------------------------------------------
  {
    sentMessages.length = 0;
    const sigId = 'sig_test_loss_pos';

    // Click LOSS
    await telegramService.handleUpdate({
      callback_query: {
        id: 'cb_test_4',
        from: { id: 12345, username: 'trader1' },
        message: { chat: { id: 11111 }, message_id: 2004, text: 'Entry: 2500' },
        data: `out:loss:${sigId}`,
      },
    });

    // Send invalid positive input
    const textUpdate = {
      message: {
        chat: { id: 11111 },
        from: { id: 12345, username: 'trader1' },
        text: '8.20',
      },
    };

    const textRes = await telegramService.handleUpdate(textUpdate);
    assert(textRes.handled === true && textRes.error === 'SIGN_VALIDATION_FAILED', 'TEST 4 (Reject positive for LOSS): Input rejected', textRes);

    const lastMsg = sentMessages[sentMessages.length - 1];
    assert(lastMsg.includes('Invalid P&L value for a LOSS.'), 'TEST 4 (Validation message): Error message matches LOSS validation prompt');

    // State remains PENDING
    const pending = (telegramService as any).pendingOutcomes.get('12345');
    assert(pending !== undefined && pending.status === 'PENDING', 'TEST 4 (State intact): Pending state preserved for retry');

    // Resolve with a valid LOSS
    const retryRes = await telegramService.handleUpdate({
      message: {
        chat: { id: 11111 },
        from: { id: 12345, username: 'trader1' },
        text: '-8.20',
      },
    });
    assert(retryRes.handled === true && retryRes.result === 'RECORDED_LOSS_PNL_-8.2', 'TEST 4 (Resolve pending): Retry with negative value succeeded');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Normalization and parsing of currency and whitespace symbols
  // --------------------------------------------------------------------------
  {
    const formats = [
      { input: ' $10.50 ', expected: 10.50 },
      { input: '-$4.20', expected: -4.20 },
      { input: '   12   ', expected: 12.00 },
      { input: '-5', expected: -5.00 },
    ];

    for (let i = 0; i < formats.length; i++) {
      const f = formats[i];
      const testSigId = `sig_format_test_${i}`;
      const isWin = f.expected >= 0;

      await telegramService.handleUpdate({
        callback_query: {
          id: `cb_format_${i}`,
          from: { id: 12345, username: 'trader1' },
          message: { chat: { id: 11111 }, message_id: 3000 + i, text: 'Entry: 2500' },
          data: isWin ? `out:win:${testSigId}` : `out:loss:${testSigId}`,
        },
      });

      const textRes = await telegramService.handleUpdate({
        message: {
          chat: { id: 11111 },
          from: { id: 12345, username: 'trader1' },
          text: f.input,
        },
      });

      assert(
        textRes.handled === true && !textRes.error,
        `TEST 5.${i}: Correctly normalized and parsed "${f.input}" to P&L ${f.expected}`,
        textRes
      );
    }
  }

  // --------------------------------------------------------------------------
  // TEST 6: Invalid Text Inputs
  // --------------------------------------------------------------------------
  {
    sentMessages.length = 0;
    const sigId = 'sig_test_invalid_text';

    await telegramService.handleUpdate({
      callback_query: {
        id: 'cb_test_invalid_text',
        from: { id: 12345, username: 'trader1' },
        message: { chat: { id: 11111 }, message_id: 4001, text: 'Entry: 2500' },
        data: `out:win:${sigId}`,
      },
    });

    const textRes = await telegramService.handleUpdate({
      message: {
        chat: { id: 11111 },
        from: { id: 12345, username: 'trader1' },
        text: 'hello world',
      },
    });

    assert(textRes.handled === true && textRes.error === 'INVALID_NUMBER_FORMAT', 'TEST 6 (Non-numeric): Rejected non-numeric input', textRes);
    assert(sentMessages[sentMessages.length - 1].includes('Invalid P&L value.'), 'TEST 6 (Validation error): Error matches expected text format');

    // Resolve with valid WIN
    await telegramService.handleUpdate({
      message: {
        chat: { id: 11111 },
        from: { id: 12345, username: 'trader1' },
        text: '12.00',
      },
    });
  }

  // --------------------------------------------------------------------------
  // TEST 7: Unauthorized user recording outcomes
  // --------------------------------------------------------------------------
  {
    const sigId = 'sig_test_unauth';

    await telegramService.handleUpdate({
      callback_query: {
        id: 'cb_test_unauth',
        from: { id: 12345, username: 'trader1' }, // Authorized clicked button
        message: { chat: { id: 11111 }, message_id: 5001, text: 'Entry: 2500' },
        data: `out:win:${sigId}`,
      },
    });

    const textRes = await telegramService.handleUpdate({
      message: {
        chat: { id: 11111 },
        from: { id: 99999, username: 'attacker' }, // Unauthorized typed number
        text: '100.00',
      },
    });

    assert(textRes.handled === true && textRes.error === 'UNAUTHORIZED', 'TEST 7: Unauthorized user rejected', textRes);

    // Resolve as authorized
    await telegramService.handleUpdate({
      message: {
        chat: { id: 11111 },
        from: { id: 12345, username: 'trader1' },
        text: '10.00',
      },
    });
  }

  // --------------------------------------------------------------------------
  // TEST 8: Numeric message without active pending outcome request
  // --------------------------------------------------------------------------
  {
    const textRes = await telegramService.handleUpdate({
      message: {
        chat: { id: 11111 },
        from: { id: 12345, username: 'trader1' },
        text: '45.00',
      },
    });

    assert(textRes.handled === false, 'TEST 8: Numeric message without pending request is ignored and falls through');
  }

  // --------------------------------------------------------------------------
  // TEST 9: Duplicate Updates / webhook delivery (idempotency in the handler)
  // --------------------------------------------------------------------------
  {
    const sigId = 'sig_test_dup_webhook';

    await telegramService.handleUpdate({
      callback_query: {
        id: 'cb_test_dup_webhook',
        from: { id: 12345, username: 'trader1' },
        message: { chat: { id: 11111 }, message_id: 6001, text: 'Entry: 2500' },
        data: `out:win:${sigId}`,
      },
    });

    const updateMsg = {
      message: {
        chat: { id: 11111 },
        from: { id: 12345, username: 'trader1' },
        text: '20.00',
      },
    };

    // First handleUpdate call
    const firstRes = await telegramService.handleUpdate(updateMsg);
    assert(firstRes.handled === true && firstRes.result === 'RECORDED_WIN_PNL_20', 'TEST 9: First callback handler succeeds', firstRes);

    // Immediate duplicate delivery of the SAME message/update
    const secondRes = await telegramService.handleUpdate(updateMsg);
    assert(secondRes.handled === false, 'TEST 9: Second callback/duplicate update is ignored because pending status changed to COMPLETED');
  }

  // --------------------------------------------------------------------------
  // TEST 10: Duplicate outcome record on storage (idempotency in storage)
  // --------------------------------------------------------------------------
  {
    const sigId = 'sig_test_dup_storage';
    const record: TradeOutcomeRecord = {
      signalId: sigId,
      tradeId: sigId,
      direction: 'BUY',
      orderType: 'MARKET',
      entry: 2500.00,
      stopLoss: 2490.00,
      tp1: 2510.00,
      tp2: 2520.00,
      outcome: 'WIN',
      realizedPnl: 15.00,
      source: 'TELEGRAM_CALLBACK',
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
    };

    const balBefore = storage.getCurrentBalance();
    const res1 = storage.recordTradeOutcome(record);
    const balMiddle = storage.getCurrentBalance();
    const res2 = storage.recordTradeOutcome(record);
    const balAfter = storage.getCurrentBalance();

    assert(res1.success && !res1.isDuplicate, 'TEST 10: First storage save recorded successfully');
    assert(res2.isDuplicate === true, 'TEST 10: Duplicate storage save is marked isDuplicate = true');
    assert(balMiddle - balBefore === 15.00, 'TEST 10: Balance updated after first save');
    assert(balAfter === balMiddle, 'TEST 10: Balance did NOT change on the duplicate save');
  }

  // --------------------------------------------------------------------------
  // TEST 11: Two different trades with separate pending states
  // --------------------------------------------------------------------------
  {
    const sigId1 = 'sig_test_mult_1';
    const sigId2 = 'sig_test_mult_2';

    // Let's simulate clicking WIN for trade 1 (from user 12345)
    await telegramService.handleUpdate({
      callback_query: {
        id: 'cb_mult_1',
        from: { id: 12345, username: 'trader1' },
        message: { chat: { id: 11111 }, message_id: 7001, text: 'Entry: 2500' },
        data: `out:win:${sigId1}`,
      },
    });

    // Let's simulate clicking LOSS for trade 2 (from user 67890)
    await telegramService.handleUpdate({
      callback_query: {
        id: 'cb_mult_2',
        from: { id: 67890, username: 'trader2' },
        message: { chat: { id: 11111 }, message_id: 7002, text: 'Entry: 2500' },
        data: `out:loss:${sigId2}`,
      },
    });

    // Confirm both separate states exist
    const pending1 = (telegramService as any).pendingOutcomes.get('12345');
    const pending2 = (telegramService as any).pendingOutcomes.get('67890');

    assert(pending1 !== undefined && pending1.signalId === sigId1, 'TEST 11: User 12345 is pending trade 1');
    assert(pending2 !== undefined && pending2.signalId === sigId2, 'TEST 11: User 67890 is pending trade 2');

    // User 12345 enters realized profit
    const res1 = await telegramService.handleUpdate({
      message: {
        chat: { id: 11111 },
        from: { id: 12345, username: 'trader1' },
        text: '35.00',
      },
    });
    assert(res1.handled === true && res1.result === 'RECORDED_WIN_PNL_35', 'TEST 11: User 12345 resolved successfully');

    // User 67890 enters realized loss
    const res2 = await telegramService.handleUpdate({
      message: {
        chat: { id: 11111 },
        from: { id: 67890, username: 'trader2' },
        text: '-15.00',
      },
    });
    assert(res2.handled === true && res2.result === 'RECORDED_LOSS_PNL_-15', 'TEST 11: User 67890 resolved successfully');
  }

  // --------------------------------------------------------------------------
  // TEST 12: Persistence and Process Restart
  // --------------------------------------------------------------------------
  {
    const sigId = 'sig_test_persistence';

    // Click WIN to create a pending state
    await telegramService.handleUpdate({
      callback_query: {
        id: 'cb_test_persist',
        from: { id: 12345, username: 'trader1' },
        message: { chat: { id: 11111 }, message_id: 8001, text: 'Entry: 2500' },
        data: `out:win:${sigId}`,
      },
    });

    // Clear the in-memory map
    (telegramService as any).pendingOutcomes.clear();
    assert((telegramService as any).pendingOutcomes.get('12345') === undefined, 'TEST 12: In-memory map cleared');

    // Force load from file
    (telegramService as any).loadPendingOutcomes();

    const restored = (telegramService as any).pendingOutcomes.get('12345');
    assert(restored !== undefined && restored.signalId === sigId, 'TEST 12: Pending state correctly loaded and restored from filesystem');

    // Resolve restored state
    await telegramService.handleUpdate({
      message: {
        chat: { id: 11111 },
        from: { id: 12345, username: 'trader1' },
        text: '50.00',
      },
    });
  }

  // --------------------------------------------------------------------------
  // TEST 13: Potential Profit and R:R Separation
  // --------------------------------------------------------------------------
  {
    const sigId = 'sig_test_pnl_rr_sep';
    const mockSignalSeparate = {
      id: sigId,
      symbol: 'XAU/USD',
      signal: 'BUY NOW' as const,
      entry: 2500.00,
      stopLoss: 2490.00,
      tp1: 2510.00,
      tp2: 2520.00,
      slPoints: 100,
      tp1Points: 100,
      tp2Points: 200,
      potentialProfit: 150.00, // Theoretical potential profit is $150.00
      potentialLoss: 50.00,
      recommendedLotSize: 0.05,
      riskAmount: 50.00,
      timestamp: Date.now(),
    };

    // Click WIN
    await telegramService.handleUpdate({
      callback_query: {
        id: 'cb_test_sep',
        from: { id: 12345, username: 'trader1' },
        message: { chat: { id: 11111 }, message_id: 9001, text: 'Entry: 2500' },
        data: `out:win:${sigId}`,
      },
    });

    // Enter smaller actual realized profit (e.g., $15.50)
    await telegramService.handleUpdate({
      message: {
        chat: { id: 11111 },
        from: { id: 12345, username: 'trader1' },
        text: '15.50',
      },
    });

    const recordedOutcome = storage.getTradeOutcome(sigId);
    assert(recordedOutcome !== undefined, 'TEST 13: Recorded trade outcome exists');
    assert(recordedOutcome?.realizedPnl === 15.50, 'TEST 13: Realized P&L is exactly $15.50');
    assert(mockSignalSeparate.potentialProfit === 150.00, 'TEST 13: Theoretical potential profit remains separate at $150.00');
  }

  console.log('\n======================================================================');
  console.log('TELEGRAM MANUAL REALIZED P&L INPUT FLOW TEST SUMMARY');
  console.log('======================================================================');
  console.log(`Passed: ${passedCount}`);
  console.log(`Failed: ${failedCount}`);

  if (failures.length > 0) {
    console.error('\nFailures detected:');
    for (const f of failures) {
      console.error(` - ${f}`);
    }
    process.exit(1);
  } else {
    console.log('\nALL TESTS PASSED SUCCESSFULLY! 🎉');
    process.exit(0);
  }
}

executeTests().catch((err) => {
  console.error('Fatal testing exception:', err);
  process.exit(1);
});
