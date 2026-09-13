import fs from 'fs';
import path from 'path';
import { TradeSignal } from '../src/types.js';
import { storage, TradeOutcomeRecord } from './storage.js';

interface TelegramStatus {
  status: 'CONNECTED' | 'NOT CONFIGURED' | 'ERROR';
  configured: boolean;
  deliveryMethod: 'LONG_POLLING' | 'WEBHOOK' | 'NONE';
  lastError: string | null;
  lastSentTimestamp: number | null;
  isPolling?: boolean;
  botId?: string;
  configuredChatId?: string;
  lastDetectedChatId?: string | number | null;
}

class TelegramService {
  private lastStatus: 'CONNECTED' | 'NOT CONFIGURED' | 'ERROR' = 'NOT CONFIGURED';
  private lastError: string | null = null;
  private lastSentTimestamp: number | null = null;
  private lastDetectedChatId: string | number | null = null;
  private sentNotificationIds = new Set<string>();
  private readonly sentFilePath: string;
  private readonly detectedChatPath: string;

  // Telegram update delivery mode (Strictly ONE delivery method at runtime)
  private deliveryMethod: 'LONG_POLLING' | 'WEBHOOK' | 'NONE' = 'NONE';
  private isPolling = false;
  private pollingAbortController = null;
  private lastUpdateId = 0;

  constructor() {
    this.sentFilePath = path.join(process.cwd(), 'data', 'telegram_sent_ids.json');
    this.detectedChatPath = path.join(process.cwd(), 'data', 'telegram_detected_chat.json');
    this.loadSentIds();
    this.loadDetectedChat();
    this.checkInitialConfig();
  }

  private loadDetectedChat() {
    try {
      if (fs.existsSync(this.detectedChatPath)) {
        const raw = fs.readFileSync(this.detectedChatPath, 'utf8');
        const data = JSON.parse(raw);
        if (data?.chatId) {
          this.lastDetectedChatId = data.chatId;
        }
      }
    } catch {
      // Gracefully ignore
    }
  }

  private persistDetectedChat(chatId: string | number) {
    try {
      this.lastDetectedChatId = chatId;
      const dataDir = path.join(process.cwd(), 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(this.detectedChatPath, JSON.stringify({ chatId, updatedAt: Date.now() }, null, 2), 'utf8');
    } catch {
      // Gracefully ignore
    }
  }

  private loadSentIds() {
    try {
      if (fs.existsSync(this.sentFilePath)) {
        const raw = fs.readFileSync(this.sentFilePath, 'utf8');
        const ids = JSON.parse(raw);
        if (Array.isArray(ids)) {
          ids.slice(-500).forEach((id) => this.sentNotificationIds.add(id));
        }
      }
    } catch {
      // Gracefully ignore reading errors for sent IDs cache
    }
  }

  private persistSentIds() {
    try {
      const arr = Array.from(this.sentNotificationIds).slice(-500);
      fs.writeFileSync(this.sentFilePath, JSON.stringify(arr), 'utf8');
    } catch {
      // Gracefully ignore write errors
    }
  }

  private checkInitialConfig() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      this.lastStatus = 'NOT CONFIGURED';
      this.deliveryMethod = 'NONE';
    } else {
      this.lastStatus = 'CONNECTED';
      // Automatically start background long polling worker (single delivery method)
      this.startPolling();
    }
  }

  public getStatus(): TelegramStatus {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const configured = !!(token && chatId);
    const botId = token ? token.split(':')[0] : undefined;

    if (!configured) {
      return {
        status: 'NOT CONFIGURED',
        configured: false,
        deliveryMethod: 'NONE',
        lastError: this.lastError,
        lastSentTimestamp: this.lastSentTimestamp,
        isPolling: false,
        botId,
        configuredChatId: chatId,
        lastDetectedChatId: this.lastDetectedChatId,
      };
    }

    return {
      status: this.lastStatus,
      configured: true,
      deliveryMethod: this.deliveryMethod,
      lastError: this.lastError,
      lastSentTimestamp: this.lastSentTimestamp,
      isPolling: this.isPolling,
      botId,
      configuredChatId: chatId,
      lastDetectedChatId: this.lastDetectedChatId,
    };
  }

  /**
   * Core low-level function to send a message to Telegram Bot API
   * Supports optional inline keyboard reply_markup
   * Never throws; returns success flag, message ID, and error description if any.
   */
  public async sendTelegramMessage(
    text: string,
    replyMarkup?: any
  ): Promise<{ success: boolean; error?: string; messageId?: number; chatId?: number | string }> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      this.lastStatus = 'NOT CONFIGURED';
      return {
        success: false,
        error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID environment variables are missing',
      };
    }

    const botId = token.split(':')[0];
    const cleanChatId = String(chatId).trim();
    let targetChatId = cleanChatId;

    // Guard: If TELEGRAM_CHAT_ID is set to bot ID, check if we have detected the real user chat ID
    if (cleanChatId === botId || cleanChatId === `@${botId}`) {
      if (this.lastDetectedChatId && String(this.lastDetectedChatId) !== botId) {
        targetChatId = String(this.lastDetectedChatId);
        console.log(`[TELEGRAM] Auto-routing to detected User Chat ID: ${targetChatId}`);
      } else {
        const errorDesc = `خطأ إعداد: تم تعيين TELEGRAM_CHAT_ID إلى معرف البوت نفسه (${botId}) بدلاً من معرف حسابك الشخصي (User Chat ID). البوت لا يستطيع مراسلة نفسه. يرجى إرسال أي رسالة للبوت في تلغرام لمعرفة رقم حسابك الشخصي.`;
        this.lastStatus = 'ERROR';
        this.lastError = errorDesc;
        console.warn(`[TELEGRAM] ${errorDesc}`);
        return { success: false, error: errorDesc };
      }
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const bodyPayload: any = {
        chat_id: targetChatId,
        text: text,
        disable_web_page_preview: true,
      };

      if (replyMarkup) {
        bodyPayload.reply_markup = replyMarkup;
      }

      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = (await res.json().catch(() => null)) as any;

      if (!res.ok || !data?.ok) {
        let errorDesc = data?.description || `HTTP ${res.status}: ${res.statusText}`;

        if (
          errorDesc.toLowerCase().includes("can't send messages to the bot") ||
          errorDesc.toLowerCase().includes("can't initiate conversation with a bot")
        ) {
          errorDesc = `خطأ إعداد: تم تعيين TELEGRAM_CHAT_ID إلى معرف البوت نفسه (${botId}) بدلاً من معرف حسابك الشخصي (User Chat ID). للحصول على معرفك، ابدأ محادثة مع البوت بالضغط على /start وسيعطيك رقمك الخاص لنسخه ولصقه في TELEGRAM_CHAT_ID.`;
        } else if (errorDesc.toLowerCase().includes('chat not found')) {
          errorDesc = `خطأ: المحادثة (${cleanChatId}) غير موجودة أو لم تقم ببدء محادثة مع البوت بعد. يرجى فتح البوت في تلغرام والضغط على /start أولاً.`;
        } else if (errorDesc.toLowerCase().includes('bot was blocked by the user')) {
          errorDesc = `خطأ: تم حظر البوت من قبل المستخدم (${cleanChatId}). يرجى إلغاء حظر البوت في تلغرام.`;
        }

        this.lastStatus = 'ERROR';
        this.lastError = errorDesc;
        console.error(`[TELEGRAM] Send failed: ${errorDesc}`);
        return { success: false, error: errorDesc };
      }

      this.lastStatus = 'CONNECTED';
      this.lastError = null;
      this.lastSentTimestamp = Date.now();
      console.log(`[TELEGRAM] Notification dispatched successfully (message_id: ${data.result?.message_id})`);
      return {
        success: true,
        messageId: data.result?.message_id,
        chatId: data.result?.chat?.id,
      };
    } catch (error: any) {
      const errMsg = error?.name === 'AbortError' ? 'Telegram request timed out (8s)' : (error?.message || 'Network error');
      this.lastStatus = 'ERROR';
      this.lastError = errMsg;
      console.error(`[TELEGRAM] Dispatch exception: ${errMsg}`);
      return { success: false, error: errMsg };
    }
  }

  /**
   * Responds to an inline button click (callback_query) to dismiss loading state
   * and display a toast or alert to the user.
   */
  public async answerCallbackQuery(callbackQueryId: string, text: string, showAlert = false): Promise<boolean> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return false;

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text: text,
          show_alert: showAlert,
        }),
      });
      const data = (await res.json().catch(() => null)) as any;
      return !!data?.ok;
    } catch (err) {
      console.error('[TELEGRAM] answerCallbackQuery error:', err);
      return false;
    }
  }

  /**
   * Edits the original Telegram message text and updates its inline buttons
   */
  public async editTelegramMessage(
    chatId: string | number,
    messageId: number,
    text: string,
    inlineKeyboard?: any[][]
  ): Promise<boolean> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return false;

    try {
      const bodyPayload: any = {
        chat_id: chatId,
        message_id: messageId,
        text: text,
        disable_web_page_preview: true,
      };
      if (inlineKeyboard) {
        bodyPayload.reply_markup = { inline_keyboard: inlineKeyboard };
      }

      const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
      });

      const data = (await res.json().catch(() => null)) as any;
      if (!data?.ok && data?.description?.includes('message is not modified')) {
        return true;
      }
      return !!data?.ok;
    } catch (err) {
      console.error('[TELEGRAM] editTelegramMessage error:', err);
      return false;
    }
  }

  /**
   * Updates only the inline buttons of a message without changing text
   */
  public async editTelegramMessageReplyMarkup(
    chatId: string | number,
    messageId: number,
    inlineKeyboard: any[][]
  ): Promise<boolean> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return false;

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: inlineKeyboard },
        }),
      });
      const data = (await res.json().catch(() => null)) as any;
      return !!data?.ok;
    } catch (err) {
      console.error('[TELEGRAM] editTelegramMessageReplyMarkup error:', err);
      return false;
    }
  }

  /**
   * Formats and dispatches a valid TradeSignal to Telegram with deduplication
   * Attaches two inline buttons:
   * 🟢 رابحة
   * 🔴 خاسرة
   */
  public async sendSignalNotification(signal: TradeSignal, scanId?: string): Promise<boolean> {
    const dedupeId = scanId || signal.id;
    if (this.sentNotificationIds.has(dedupeId)) {
      console.log(`[TELEGRAM] Skipping duplicate signal notification for ${dedupeId}`);
      return false;
    }

    const message = this.formatSignalMessage(signal);

    // Feature requirement: Add inline buttons for trade outcome tracking
    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '🟢 رابحة', callback_data: `out:win:${signal.id}` },
          { text: '🔴 خاسرة', callback_data: `out:loss:${signal.id}` },
        ],
      ],
    };

    const result = await this.sendTelegramMessage(message, inlineKeyboard);

    // Register as sent so it won't be repeated
    this.sentNotificationIds.add(dedupeId);
    this.persistSentIds();

    return result.success;
  }

  /**
   * Formats and dispatches a NO TRADE notification to Telegram with deduplication
   * NO TRADE notifications do NOT receive inline buttons (Requirement 9)
   */
  public async sendNoTradeNotification(scanId: string, reason: string, timestamp: number = Date.now()): Promise<boolean> {
    if (this.sentNotificationIds.has(scanId)) {
      console.log(`[TELEGRAM] Skipping duplicate NO TRADE notification for ${scanId}`);
      return false;
    }

    const message = this.formatNoTradeMessage(reason, timestamp);
    const result = await this.sendTelegramMessage(message);

    this.sentNotificationIds.add(scanId);
    this.persistSentIds();

    return result.success;
  }

  /**
   * Formats and dispatches a SCAN ERROR notification to Telegram with deduplication
   * Error notifications do NOT receive inline buttons (Requirement 9)
   */
  public async sendErrorNotification(scanId: string, error: string, timestamp: number = Date.now()): Promise<boolean> {
    if (this.sentNotificationIds.has(scanId)) {
      console.log(`[TELEGRAM] Skipping duplicate ERROR notification for ${scanId}`);
      return false;
    }

    const message = this.formatErrorMessage(error, timestamp);
    const result = await this.sendTelegramMessage(message);

    this.sentNotificationIds.add(scanId);
    this.persistSentIds();

    return result.success;
  }

  /**
   * Handles incoming updates from Telegram Webhook OR Long Polling
   * Strictly validates callback_data, updates storage, prevents duplicate submissions,
   * and edits the original Telegram message with the final result.
   */
  public async handleUpdate(update: any): Promise<{ handled: boolean; result?: string; error?: string }> {
    if (!update) {
      return { handled: false };
    }

    // Handle incoming direct messages (e.g. /start, /id, or greeting from user)
    if (update.message) {
      const msg = update.message;
      const fromChatId = msg.chat?.id;
      const fromUser = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'User');
      const text = String(msg.text || '').trim();

      if (fromChatId) {
        this.persistDetectedChat(fromChatId);
        console.log(`[TELEGRAM] Direct message received from chat_id=${fromChatId} (${fromUser}): "${text}"`);

        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (token) {
          try {
            const welcomeText = [
              `👋 مرحباً بك ${fromUser}!`,
              '',
              `🆔 <b>معرف المحادثة الخاص بك (Your Chat ID):</b>`,
              `<code>${fromChatId}</code>`,
              '',
              '📋 <b>طريقة التفعيل:</b>',
              `انسخ هذا الرقم (<b>${fromChatId}</b>) وضعه في متغير البيئة <code>TELEGRAM_CHAT_ID</code> في إعدادات التطبيق.`,
              '',
              '💡 <i>ملاحظة: تجنب وضع معرف البوت في حقل TELEGRAM_CHAT_ID؛ يجب دائماً استخدام معرف حسابك الشخصي الموضح أعلاه.</i>',
            ].join('\n');

            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: fromChatId,
                text: welcomeText,
                parse_mode: 'HTML',
              }),
            });
          } catch (replyErr) {
            console.error('[TELEGRAM] Failed to auto-reply to incoming message:', replyErr);
          }
        }
      }
      return { handled: true, result: 'MESSAGE_HANDLED' };
    }

    if (!update.callback_query) {
      return { handled: false };
    }

    const cq = update.callback_query;
    const callbackId = cq.id;
    const rawData = String(cq.data || '');
    const chatId = cq.message?.chat?.id;
    const messageId = cq.message?.message_id;
    const originalText = String(cq.message?.text || '');

    // Check for already finalized button clicks
    if (rawData.startsWith('noop:') || rawData.startsWith('recorded:')) {
      const recordedSignalId = rawData.split(':')[1] || '';
      const existing = storage.getTradeOutcome(recordedSignalId);
      const label = existing ? (existing.outcome === 'WIN' ? '🟢 رابحة' : '🔴 خاسرة') : 'مسجلة';
      await this.answerCallbackQuery(callbackId, `تم توثيق نتيجة هذه الصفقة بالفعل: ${label}`, false);
      return { handled: true, result: 'ALREADY_DOCUMENTED' };
    }

    // Validate callback_data format strictly: out:(win|loss):<signalId>
    const match = rawData.match(/^out:(win|loss):([a-zA-Z0-9_\-]+)$/i);
    if (!match) {
      return { handled: false, error: 'INVALID_CALLBACK_DATA' };
    }

    const action = match[1].toLowerCase() as 'win' | 'loss';
    const signalId = match[2];

    // Security check: Verify authorized chat or user if TELEGRAM_CHAT_ID is set (Requirement 10 & 11)
    const allowedChatId = process.env.TELEGRAM_CHAT_ID;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const botId = token ? token.split(':')[0] : null;

    if (allowedChatId) {
      const senderChatId = chatId ? String(chatId) : null;
      const senderUserId = cq.from?.id ? String(cq.from.id) : null;
      const detectedIdStr = this.lastDetectedChatId ? String(this.lastDetectedChatId) : null;

      const isDirectMatch = senderChatId === allowedChatId || senderUserId === allowedChatId;
      const isDetectedMatch = (allowedChatId === botId || allowedChatId === `@${botId}`) &&
        (senderChatId === detectedIdStr || senderUserId === detectedIdStr);

      if (!isDirectMatch && !isDetectedMatch) {
        console.warn(`[TELEGRAM] Unauthorized callback attempt from chat ${senderChatId} / user ${senderUserId}`);
        await this.answerCallbackQuery(callbackId, '⚠️ غير مصرح لك بتسجيل النتيجة لهذا الحساب.', true);
        return { handled: true, error: 'UNAUTHORIZED' };
      }
    }

    // Check for existing recorded outcome (Requirement 4: Prevent duplicate/conflicting submissions)
    const existingOutcome = storage.getTradeOutcome(signalId);
    if (existingOutcome) {
      const existingArabic = existingOutcome.outcome === 'WIN' ? '🟢 رابحة' : '🔴 خاسرة';
      await this.answerCallbackQuery(
        callbackId,
        `⚠️ تم تسجيل هذه الصفقة مسبقاً (${existingArabic}). لا يمكن تعديل النتيجة.`,
        true
      );

      // Update buttons so user sees the finalized outcome and cannot click again
      if (chatId && messageId) {
        await this.editTelegramMessageReplyMarkup(chatId, messageId, [
          [{ text: `النتيجة: ${existingArabic}`, callback_data: `noop:${signalId}` }],
        ]);
      }
      return { handled: true, result: 'ALREADY_RECORDED' };
    }

    // Retrieve signal details from memory/disk or parse from message text
    const signal = storage.getSignal(signalId);
    const outcome: 'WIN' | 'LOSS' = action === 'win' ? 'WIN' : 'LOSS';
    const outcomeArabic = outcome === 'WIN' ? '🟢 رابحة' : '🔴 خاسرة';

    // Parse fallback values from message text if signal wasn't cached in active memory
    const isBuy = /BUY/i.test(originalText);
    const isLimit = /LIMIT/i.test(originalText);
    const parsedEntry = parseFloat((originalText.match(/Entry:\s*\$?([\d\.]+)/i) || [])[1]) || 0;
    const parsedSl = parseFloat((originalText.match(/SL:\s*\$?([\d\.]+)/i) || [])[1]) || 0;
    const parsedTp1 = parseFloat((originalText.match(/TP1:\s*\$?([\d\.]+)/i) || [])[1]) || 0;
    const parsedTp2 = parseFloat((originalText.match(/TP2:\s*\$?([\d\.]+)/i) || [])[1]) || 0;

    const outcomeRecord: TradeOutcomeRecord = {
      signalId,
      tradeId: signal?.id || signalId,
      direction: signal?.signal || (isLimit ? (isBuy ? 'BUY LIMIT' : 'SELL LIMIT') : (isBuy ? 'BUY NOW' : 'SELL NOW')),
      orderType: isLimit ? (isBuy ? 'BUY LIMIT' : 'SELL LIMIT') : 'MARKET',
      entry: signal?.entry ?? parsedEntry,
      stopLoss: signal?.stopLoss ?? parsedSl,
      tp1: signal?.tp1 ?? parsedTp1,
      tp2: signal?.tp2 ?? parsedTp2,
      outcome,
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
      chatId: chatId,
      userId: cq.from?.id,
    };

    // Save persistently into trade_outcomes.json and link with Trade Log (Requirements 2, 3, 6, 7, 8)
    const saveResult = storage.recordTradeOutcome(outcomeRecord, signal);
    if (!saveResult.success && saveResult.isDuplicate) {
      const existingArabic = saveResult.outcome?.outcome === 'WIN' ? '🟢 رابحة' : '🔴 خاسرة';
      await this.answerCallbackQuery(
        callbackId,
        `⚠️ تم تسجيل هذه الصفقة مسبقاً (${existingArabic}). لا يمكن تعديل النتيجة.`,
        true
      );
      if (chatId && messageId) {
        await this.editTelegramMessageReplyMarkup(chatId, messageId, [
          [{ text: `النتيجة: ${existingArabic}`, callback_data: `noop:${signalId}` }],
        ]);
      }
      return { handled: true, result: 'ALREADY_RECORDED' };
    }

    // Answer callback query with toast confirmation
    await this.answerCallbackQuery(callbackId, `✅ تم تسجيل الصفقة بنجاح: ${outcomeArabic}`, false);

    // Edit original message to display the final result clearly (Requirement 5)
    if (chatId && messageId) {
      const outcomeHeader = `النتيجة: ${outcomeArabic}`;
      const updatedText = originalText.includes('النتيجة:')
        ? originalText
        : `${originalText}\n\n━━━━━━━━━━━━━━━\n${outcomeHeader}`;

      await this.editTelegramMessage(
        chatId,
        messageId,
        updatedText,
        [[{ text: outcomeHeader, callback_data: `noop:${signalId}` }]]
      );
    }

    console.log(`[TELEGRAM] Outcome recorded for signal ${signalId}: ${outcome}`);
    return { handled: true, result: `RECORDED_${outcome}` };
  }

  /**
   * Starts background long polling to listen for Telegram callback queries.
   * Proactively deletes any stale webhook to eliminate 409 conflict and ensure
   * Long Polling is the single, clean delivery method.
   */
  public startPolling() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || this.isPolling) return;

    this.isPolling = true;
    this.deliveryMethod = 'LONG_POLLING';
    this.pollingAbortController = new AbortController();

    const pollLoop = async () => {
      // 1. Proactively delete any stale webhook to guarantee no 409 conflict
      try {
        await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`, {
          method: 'POST',
        });
      } catch {
        // Non-blocking
      }

      console.log('[TELEGRAM] Active update delivery method: LONG_POLLING (Webhook disabled/cleared)');

      // 2. Continuous long polling loop
      while (this.isPolling) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 20000);

          const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=10&allowed_updates=["callback_query","message"]`;
          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timeoutId);

          const data = (await res.json().catch(() => null)) as any;

          if (data?.ok && Array.isArray(data.result)) {
            for (const update of data.result) {
              this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
              try {
                await this.handleUpdate(update);
              } catch (updateErr) {
                console.error('[TELEGRAM] Error handling update:', updateErr);
              }
            }
          } else if (res.status === 409) {
            // If another process recreated a webhook, retry clearing it
            try {
              await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`, { method: 'POST' });
            } catch {}
            await new Promise((r) => setTimeout(r, 5000));
          } else {
            // Short backoff if no updates or unexpected response
            await new Promise((r) => setTimeout(r, 2000));
          }
        } catch (err: any) {
          if (!this.isPolling) break;
          // Graceful backoff on network interruption
          await new Promise((r) => setTimeout(r, 4000));
        }
      }
    };

    pollLoop();
  }

  /**
   * Stops background polling
   */
  public stopPolling() {
    this.isPolling = false;
    if (this.pollingAbortController) {
      this.pollingAbortController.abort();
      this.pollingAbortController = null;
    }
  }

  /**
   * Sends a controlled test message for connectivity verification
   */
  public async sendTestNotification(): Promise<{ success: boolean; configured: boolean; message?: string; error?: string }> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      return {
        success: false,
        configured: false,
        message: 'إشعارات تلغرام غير مهيأة: يرجى ضبط TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID في متغيرات البيئة.',
      };
    }

    const testText = [
      '🔔 *Gold AI Challenge Scanner*',
      'الاتصال بتلغرام يعمل بنجاح!',
      'النظام مهيأ لإرسال إشعارات الفحص المباشر وإشارات الذهب (XAU/USD) مع أزرار توثيق النتيجة (🟢 رابحة / 🔴 خاسرة).',
      `الوقت: ${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC`,
    ].join('\n\n');

    const res = await this.sendTelegramMessage(testText);
    if (!res.success) {
      return {
        success: false,
        configured: true,
        error: res.error || 'فشل إرسال رسالة الاختبار',
      };
    }

    return {
      success: true,
      configured: true,
      message: 'تم إرسال رسالة الاختبار بنجاح إلى تلغرام!',
    };
  }

  /**
   * Format for BUY / SELL / LIMIT signals
   */
  private formatSignalMessage(signal: TradeSignal): string {
    const sUpper = signal.signal.toUpperCase();
    const isBuy = sUpper.includes('BUY');
    const isLimit = sUpper.includes('LIMIT');

    const emoji = isBuy ? '🟢' : '🔴';
    let actionHeader = '';
    let orderType = 'MARKET';

    if (isLimit) {
      if (isBuy) {
        actionHeader = 'BUY LIMIT';
        orderType = 'BUY LIMIT';
      } else {
        actionHeader = 'SELL LIMIT';
        orderType = 'SELL LIMIT';
      }
    } else {
      actionHeader = isBuy ? 'BUY' : 'SELL';
      orderType = 'MARKET';
    }

    const title = `${emoji} ${signal.asset || 'XAU/USD'} ${actionHeader}`;
    const entryFormatted = typeof signal.entry === 'number' ? `$${signal.entry.toFixed(2)}` : signal.entry;
    const slPts = signal.slPoints ? ` (${signal.slPoints} pts)` : '';
    const slFormatted = typeof signal.stopLoss === 'number' ? `$${signal.stopLoss.toFixed(2)}${slPts}` : signal.stopLoss;
    const tp1Formatted = typeof signal.tp1 === 'number' ? `$${signal.tp1.toFixed(2)}` : signal.tp1;
    const tp2Formatted = signal.tp2 && signal.tp2 > 0 ? (typeof signal.tp2 === 'number' ? `$${signal.tp2.toFixed(2)}` : signal.tp2) : 'N/A';

    const riskPercent = signal.riskPercent ? `${signal.riskPercent}%` : 'N/A';
    const riskAmount = typeof signal.riskAmount === 'number' ? `$${signal.riskAmount.toFixed(2)}` : 'N/A';
    const tp1Rr = signal.tp1RrString || (signal.tp1Rr ? `1:${signal.tp1Rr.toFixed(2)}` : (signal.rr || '1:1.50'));
    const tp2Rr = signal.tp2RrString || (signal.tp2Rr ? `1:${signal.tp2Rr.toFixed(2)}` : 'N/A');
    const confidence = signal.confidence ? `${signal.confidence}%` : 'N/A';

    const reasonsList =
      signal.mainReasons && signal.mainReasons.length > 0
        ? signal.mainReasons.map((r) => `• ${r}`).join('\n')
        : `• Setup: ${signal.setup || 'Technical structure confirmation'}`;

    const invalidation = signal.invalidation || 'N/A';
    const timeFormatted = `${new Date(signal.timestamp || Date.now()).toISOString().replace('T', ' ').substring(0, 19)} UTC`;

    return [
      title,
      `Order: ${orderType}`,
      `Entry: ${entryFormatted}`,
      `SL: ${slFormatted}`,
      `TP1: ${tp1Formatted}`,
      `TP2: ${tp2Formatted}`,
      `Risk: ${riskPercent}`,
      `Risk Amount: ${riskAmount}`,
      `RR TP1: ${tp1Rr}`,
      `RR TP2: ${tp2Rr}`,
      `Confidence: ${confidence}`,
      '',
      'Reasons:',
      reasonsList,
      '',
      'Invalidation:',
      invalidation,
      '',
      'Time:',
      timeFormatted,
    ].join('\n');
  }

  /**
   * Format for NO TRADE
   */
  private formatNoTradeMessage(reason: string, timestamp: number): string {
    const timeFormatted = `${new Date(timestamp).toISOString().replace('T', ' ').substring(0, 19)} UTC`;
    return [
      '⚪ XAU/USD — NO TRADE',
      '',
      'Reason:',
      reason || 'السوق لا يحقق شروط الدخول الصارمة لحماية رأس المال.',
      '',
      'Time:',
      timeFormatted,
    ].join('\n');
  }

  /**
   * Format for SCAN ERROR
   */
  private formatErrorMessage(error: string, timestamp: number): string {
    const timeFormatted = `${new Date(timestamp).toISOString().replace('T', ' ').substring(0, 19)} UTC`;
    return [
      '⚠️ XAU/USD — SCAN ERROR',
      '',
      'Reason:',
      error || 'تعذر استكمال فحص السوق.',
      '',
      'Time:',
      timeFormatted,
    ].join('\n');
  }
}

export const telegramService = new TelegramService();
export const sendTelegramMessage = (message: string, replyMarkup?: any) =>
  telegramService.sendTelegramMessage(message, replyMarkup);
