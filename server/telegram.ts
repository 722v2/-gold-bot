import fs from 'fs';
import path from 'path';
import { storage } from './storage.js';

export interface TelegramStatus {
  registered: boolean;
  chatId: string | null;
  botId: string | null;
}

export class TelegramService {
  private botToken: string | null = null;
  private privateChatId: string | null = null;
  private botId: string | null = null;
  private configPath = path.join(process.cwd(), 'data', 'telegram_private_chat.json');
  private messageMappingPath = path.join(process.cwd(), 'data', 'telegram_signal_messages.json');
  private pollingInterval: NodeJS.Timeout | null = null;
  private isPolling = false;
  private isInitializing = false;
  private lastUpdateId = 0;
  private signalMessageIds: Record<string, number> = {};

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || null;
    this.botId = this.getBotIdFromToken(this.botToken);
    this.loadRegisteredChat();
    this.loadMessageMapping();
  }

  /**
   * Load stored signal message ID mapping from disk
   */
  private loadMessageMapping(): void {
    try {
      if (fs.existsSync(this.messageMappingPath)) {
        this.signalMessageIds = JSON.parse(fs.readFileSync(this.messageMappingPath, 'utf8'));
      }
    } catch (err) {
      console.error('[Telegram] Error loading message mapping:', err);
    }
  }

  /**
   * Save signal message ID mapping to disk safely
   */
  private saveMessageMapping(): void {
    try {
      const dir = path.dirname(this.messageMappingPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.messageMappingPath, JSON.stringify(this.signalMessageIds, null, 2), 'utf8');
    } catch (err) {
      console.error('[Telegram] Error saving message mapping:', err);
    }
  }

  /**
   * Safe parser for bot ID from token
   */
  private getBotIdFromToken(token: string | null): string | null {
    if (!token) return null;
    const parts = token.split(':');
    return parts[0] || null;
  }

  /**
   * Load stored private chat ID from disk
   */
  private loadRegisteredChat(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        if (data && data.chatId) {
          this.privateChatId = String(data.chatId);
          console.log(`[Telegram] Loaded registered private chat ID: ${this.privateChatId}`);
        }
      }
    } catch (err) {
      console.error('[Telegram] Error loading registered chat ID:', err);
    }
  }

  /**
   * Save private chat ID to disk safely
   */
  private saveRegisteredChat(chatId: string): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify({ chatId, registeredAt: new Date().toISOString() }, null, 2), 'utf8');
      this.privateChatId = chatId;
      console.log(`[Telegram] Registered and saved new private chat ID: ${chatId}`);
    } catch (err) {
      console.error('[Telegram] Error saving registered chat ID:', err);
    }
  }

  /**
   * Initialize long-polling to detect /start command from the user
   */
  public async init(): Promise<void> {
    if (!this.botToken) {
      console.warn('[Telegram] TELEGRAM_BOT_TOKEN is not configured in Secrets. Telegram service is offline.');
      return;
    }

    if (this.pollingInterval || this.isInitializing) {
      console.log('[Telegram] Polling is already running or initializing. Skipping duplicate init call.');
      return;
    }

    this.isInitializing = true;

    try {
      // Check and clear any conflicting webhook configuration on Telegram's servers
      await this.ensureWebhookRemoved();

      console.log('[Telegram] Brand-new Telegram integration initialized. Starting private chat detection polling...');
      
      // Start polling interval
      this.pollingInterval = setInterval(() => {
        this.pollUpdates();
      }, 4000);
    } catch (err: any) {
      console.error('[Telegram] Error during polling initialization:', err?.message || err);
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Check and remove any configured webhook before starting getUpdates long polling
   */
  private async ensureWebhookRemoved(): Promise<void> {
    if (!this.botToken) return;

    try {
      const infoUrl = `https://api.telegram.org/bot${this.botToken}/getWebhookInfo`;
      const res = await fetch(infoUrl);
      if (res.ok) {
        const data = await res.json() as any;
        if (data?.ok && data?.result?.url) {
          console.log(`[Telegram] Webhook currently configured: "${data.result.url}". Removing webhook to prevent 409 conflict...`);
          const deleteUrl = `https://api.telegram.org/bot${this.botToken}/deleteWebhook?drop_pending_updates=false`;
          const deleteRes = await fetch(deleteUrl);
          const deleteData = await deleteRes.json() as any;
          if (deleteData?.ok) {
            console.log('[Telegram] Webhook removed successfully. getUpdates polling can proceed.');
          } else {
            console.warn('[Telegram] Failed to remove webhook:', deleteData?.description);
          }
        } else {
          console.log('[Telegram] Webhook check passed: No active webhook detected for this bot.');
        }
      } else {
        console.warn(`[Telegram] getWebhookInfo returned HTTP ${res.status}. Attempting deleteWebhook fallback...`);
        await fetch(`https://api.telegram.org/bot${this.botToken}/deleteWebhook?drop_pending_updates=false`);
      }
    } catch (err: any) {
      console.warn('[Telegram] Error checking/removing webhook:', err?.message || err);
    }
  }

  /**
   * Poll for updates from the Telegram API
   */
  private async pollUpdates(): Promise<void> {
    if (!this.botToken) return;

    // Guard: Prevent overlapping in-flight polling calls that trigger HTTP 409 conflict
    if (this.isPolling) {
      return;
    }

    this.isPolling = true;

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&limit=10&timeout=2`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}`);
      }

      const body = await res.json() as any;
      if (body && body.ok && Array.isArray(body.result)) {
        for (const update of body.result) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          await this.processUpdate(update);
        }
      }
    } catch (err: any) {
      // Quietly log error to prevent console spamming on network blips
      console.debug(`[Telegram Polling Warning] ${err?.message || err}`);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Process incoming webhook / polling updates
   */
  private async processUpdate(update: any): Promise<void> {
    if (!update) return;

    // Handle button presses / callback queries
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    if (!update.message) return;

    const message = update.message;
    const chatId = String(message.chat?.id || '');
    const chatType = message.chat?.type; // 'private' | 'group' | 'supergroup' | 'channel'
    const text = String(message.text || '').trim();

    // Constraint: ONLY allow private chats, never groups, channels, or self
    if (chatType !== 'private') {
      return;
    }

    if (this.botId && chatId === this.botId) {
      console.warn(`[Telegram] Rejecting registration attempt from bot's own self ID: ${chatId}`);
      return;
    }

    // Check for /start command
    if (text.startsWith('/start')) {
      // Save chat ID if it's new
      if (this.privateChatId !== chatId) {
        this.saveRegisteredChat(chatId);
        
        // Send a welcoming confirmation message
        await this.sendMessageDirectly(chatId, `
<b>🤖 تفعيل نظام Gold AI Trader بنجاح!</b>

السلام عليكم ورحمة الله وبركاته،
تم ربط هذا الحساب الخاص بنظام التداول الآلي والتحليل الذكي للذهب (XAU/USD).

📈 ستصلك إشعارات الصفقات وإشارات التداول والتقارير الدورية وإجراءات إدارة الصفقات مباشرة ومجاناً هنا في هذه المحادثة الخاصة الآمنة بالكامل.

⏱ <i>الوقت: ${new Date().toLocaleTimeString('ar-EG')}</i>
        `.trim());
      } else {
        // Just send a friendly response that they're already connected
        await this.sendMessageDirectly(chatId, `
<b>ℹ️ نظام Gold AI نشط بالفعل!</b>

هذا الحساب مسجّل ونشط بالفعل لتلقي كافة إشعارات صفقات الذهب وإدارة رأس المال. لا توجد حاجة لإعادة التفعيل.

⏱ <i>الوقت: ${new Date().toLocaleTimeString('ar-EG')}</i>
        `.trim());
      }
    }
  }

  /**
   * Send text directly to a specific chat ID
   */
  private async sendMessageDirectly(chatId: string, text: string, replyMarkup?: any): Promise<any> {
    if (!this.botToken) return null;

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
      });

      const body = await res.json() as any;
      if (body && body.ok === true) {
        return body.result;
      }
      return null;
    } catch (err) {
      console.error(`[Telegram] Error sending message to chat ${chatId}:`, err);
      return null;
    }
  }

  /**
   * Edit message text on Telegram
   */
  private async editMessageText(chatId: string, messageId: number, text: string, replyMarkup?: any): Promise<boolean> {
    if (!this.botToken) return false;

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/editMessageText`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
      });

      const body = await res.json() as any;
      return body && body.ok === true;
    } catch (err) {
      console.error(`[Telegram] Error editing message text ${messageId} in chat ${chatId}:`, err);
      return false;
    }
  }

  /**
   * Remove inline keyboard markup from a message
   */
  private async removeInlineKeyboard(chatId: string, messageId: number): Promise<boolean> {
    if (!this.botToken) return false;

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/editMessageReplyMarkup`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] }
        }),
      });

      const body = await res.json() as any;
      return body && body.ok === true;
    } catch (err) {
      console.error(`[Telegram] Error removing inline keyboard for message ${messageId} in chat ${chatId}:`, err);
      return false;
    }
  }

  /**
   * Answer a callback query to acknowledge the button press in UI
   */
  private async answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false): Promise<boolean> {
    if (!this.botToken) return false;

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          ...(text ? { text, show_alert: showAlert } : {}),
        }),
      });

      const body = await res.json() as any;
      return body && body.ok === true;
    } catch (err) {
      console.error(`[Telegram] Error answering callback query ${callbackQueryId}:`, err);
      return false;
    }
  }

  /**
   * Handles button clicks from users (callback_query updates)
   */
  private async handleCallbackQuery(callbackQuery: any): Promise<void> {
    const queryId = callbackQuery.id;
    const data = String(callbackQuery.data || '').trim();
    const message = callbackQuery.message;
    if (!message) return;

    const chatId = String(message.chat?.id || '');
    const messageId = message.message_id;

    // We only process queries matching our expected actions
    const parts = data.split(':');
    if (parts.length < 2) {
      await this.answerCallbackQuery(queryId, 'بيانات غير صالحة (Invalid callback data)');
      return;
    }

    const action = parts[0];
    const signalId = parts.slice(1).join(':');

    if (action !== 'win' && action !== 'loss' && action !== 'not_entered') {
      await this.answerCallbackQuery(queryId, 'إجراء غير معروف (Unknown action)');
      return;
    }

    try {
      // 1. Fetch signal to verify its existence
      const signal = await storage.getSignalFromStorage(signalId);
      if (!signal) {
        await this.answerCallbackQuery(queryId, 'الإشارة غير موجودة في الذاكرة (Signal not found)');
        return;
      }

      // Check for existing outcome to prevent duplicates
      const existingOutcome = storage.getTradeOutcome(signalId);
      const existingTrade = storage.getTrade(signalId);

      if (existingOutcome || (existingTrade && existingTrade.result !== 'OPEN')) {
        await this.removeInlineKeyboard(chatId, messageId);
        const curResult = existingOutcome?.outcome || existingTrade?.result;
        await this.answerCallbackQuery(queryId, `تم توثيق هذه الإشارة مسبقاً كـ: ${curResult}`, true);
        return;
      }

      if (action === 'win' || action === 'loss') {
        // Confirm execution first by saving it to ledger if it doesn't exist
        if (!existingTrade) {
          const newTrade: any = {
            id: signal.id,
            tradeNumber: (storage.getTrades(1)[0]?.tradeNumber || 0) + 1,
            date: new Date(signal.timestamp).toLocaleDateString('ar-EG', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
            isoTime: new Date(signal.timestamp).toISOString(),
            asset: 'XAU/USD',
            direction: signal.signal as any,
            entry: signal.entry,
            sl: signal.stopLoss,
            tp1: signal.tp1,
            tp2: signal.tp2,
            lotSize: signal.standardLot ?? signal.recommendedLotSize ?? 0.01,
            riskPercent: signal.riskPercent,
            riskAmount: signal.riskAmount,
            result: 'OPEN',
            pl: 0,
            isActive: true,
            signalId: signal.id,
            notes: 'تم الدخول يدوياً عبر زر التليجرام',
          };
          storage.saveTrade(newTrade);
        }

        const outcomeVal = action === 'win' ? 'WIN' : 'LOSS';
        const lotSize = signal.standardLot ?? signal.recommendedLotSize ?? 0.01;
        const exitPrice = action === 'win' ? signal.tp1 : signal.stopLoss;
        const entryPrice = signal.entry;
        const isBuy = String(signal.signal).toUpperCase().includes('BUY');
        const priceDiff = isBuy ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
        const profit = Number((priceDiff * 100 * lotSize).toFixed(2));

        const record: any = {
          signalId: signal.id,
          tradeId: signal.id,
          direction: signal.signal,
          orderType: 'MARKET',
          entry: entryPrice,
          stopLoss: signal.stopLoss,
          tp1: signal.tp1,
          tp2: signal.tp2,
          outcome: outcomeVal,
          realizedPnl: profit,
          exitPrice: exitPrice,
          source: 'MANUAL',
          closedAt: Date.now(),
          closeReason: 'MANUAL_TELEGRAM_BUTTON',
          timestamp: Date.now(),
          isoTime: new Date().toISOString(),
        };

        const res = storage.recordTradeOutcome(record, signal);
        if (res.success) {
          // Proactively remove from active signal tracking
          delete this.signalMessageIds[signalId];
          this.saveMessageMapping();

          await this.answerCallbackQuery(queryId, `🟢 تم التوثيق بنجاح: ${outcomeVal === 'WIN' ? 'ربح' : 'خسارة'}`);
          await this.removeInlineKeyboard(chatId, messageId);

          const outcomeStr = outcomeVal === 'WIN' ? '🟢 صفقة رابحة (WIN)' : '🔴 صفقة خاسرة (LOSS)';
          const updatedText = `
${message.text}

<b>📝 النتيجة الموثقة يدوياً:</b> ${outcomeStr}
💰 <b>الربح/الخسارة:</b> ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}
          `.trim();
          await this.editMessageText(chatId, messageId, updatedText);
        } else {
          await this.answerCallbackQuery(queryId, `خطأ: ${res.message || 'Failed to record outcome'}`);
        }

      } else if (action === 'not_entered') {
        const res = storage.markSignalOrOpportunityNotEntered(signalId);
        if (res.success) {
          // Proactively remove from active signal tracking
          delete this.signalMessageIds[signalId];
          this.saveMessageMapping();

          await this.answerCallbackQuery(queryId, '⚪ تم وضع الإشارة كـ لم يتم الدخول (NOT ENTERED)');
          await this.removeInlineKeyboard(chatId, messageId);

          const updatedText = `
${message.text}

<b>📝 النتيجة الموثقة يدوياً:</b> ⚪ لم يتم الدخول (NOT ENTERED)
          `.trim();
          await this.editMessageText(chatId, messageId, updatedText);
        } else {
          await this.answerCallbackQuery(queryId, 'فشل وضع الحالة كـ NOT ENTERED');
        }
      }
    } catch (err: any) {
      console.error('[Telegram] Callback handler error:', err);
      await this.answerCallbackQuery(queryId, 'حدث خطأ غير متوقع');
    }
  }

  /**
   * Send a general message to the registered user private chat ONLY
   */
  public async sendMessage(text: string): Promise<{ success: boolean; error?: string }> {
    if (!this.botToken) {
      return { success: false, error: 'Telegram service bot token not configured.' };
    }

    if (!this.privateChatId) {
      return { success: false, error: 'NOT_REGISTERED' };
    }

    const success = await this.sendMessageDirectly(this.privateChatId, text);
    return { success };
  }

  /**
   * Get the current registration status
   */
  public getStatus(): TelegramStatus {
    return {
      registered: this.privateChatId !== null,
      chatId: this.privateChatId,
      botId: this.botId,
    };
  }

  /**
   * Sends a beautiful test notification to the detected private chat
   */
  public async sendTestNotification(): Promise<{ success: boolean; error?: string }> {
    if (!this.botToken) {
      return { success: false, error: 'البوت غير مكوّن. يرجى إدخال TELEGRAM_BOT_TOKEN.' };
    }

    if (!this.privateChatId) {
      return { success: false, error: 'NOT_REGISTERED' };
    }

    const text = `
<b>🧪 تجربة اتصال نظام Gold AI Trader</b>

الاتصال يعمل بنجاح ومؤمّن بالكامل!
ستصلك كافة التحليلات وإشعارات الصفقات وإجراءات إدارة الصفقات (Phase 4) هنا مباشرة وبشكل آمن تماماً.

🟢 <b>حالة الاتصال:</b> ممتازة (نشط)
🔒 <b>نوع القناة:</b> محادثة خاصة مشفّرة (Private Chat)
⏱ <b>الوقت:</b> ${new Date().toLocaleTimeString('ar-EG')}
    `.trim();

    const success = await this.sendMessageDirectly(this.privateChatId, text);
    return { success, error: success ? undefined : 'فشل إرسال الرسالة إلى تليجرام' };
  }

  /**
   * Formats and delivers a mock / test trading signal alert
   */
  public async sendMockSignalNotification(): Promise<{ success: boolean; error?: string }> {
    if (!this.botToken) {
      return { success: false, error: 'البوت غير مكوّن. يرجى إدخال TELEGRAM_BOT_TOKEN.' };
    }

    if (!this.privateChatId) {
      return { success: false, error: 'NOT_REGISTERED' };
    }

    const mockSignal = {
      signal: 'BUY (TEST)',
      entry: 2515.50,
      stopLoss: 2505.00,
      slPoints: 105,
      tp1: 2530.00,
      tp2: 2545.00,
      riskPercent: 1.5,
      riskAmount: 15.00,
      confidence: 94,
      setup: 'Bullish Engulfing H4 (تجريبي - اختبار اتصال)',
    };

    const text = `
<b>⚠️ إشارة تجريبية - اختبار اتصال فقط (TEST SIGNAL — NOT A REAL TRADE)</b>

🟢 <b>الصفقة المقترحة:</b> شراء تجريبي (TEST BUY NOW)
📊 <b>الأصل:</b> XAU/USD (الذهب)
📈 <b>سعر الدخول التجريبي:</b> $${mockSignal.entry.toFixed(2)}
🛑 <b>وقف الخسارة التجريبي (SL):</b> $${mockSignal.stopLoss.toFixed(2)} (${mockSignal.slPoints} نقطة)
🎯 <b>الهدف الأول التجريبي (TP1):</b> $${mockSignal.tp1.toFixed(2)}
🎯 <b>الهدف الثاني التجريبي (TP2):</b> $${mockSignal.tp2.toFixed(2)}
⚖️ <b>المخاطرة المحاكية:</b> ${mockSignal.riskPercent}% ($${mockSignal.riskAmount.toFixed(2)})
🧠 <b>نسبة الثقة:</b> ${mockSignal.confidence}%
🛠️ <b>النموذج الفني:</b> ${mockSignal.setup}

📢 <i>هذه الرسالة تهدف فقط لاختبار جودة وسرعة تسليم إشعارات الصفقات عبر التليجرام. لم يتم فتح أو تنفيذ أي صفقات حقيقية في حسابك.</i>

⏱ <i>الوقت: ${new Date().toLocaleTimeString('ar-EG')}</i>
    `.trim();

    const success = await this.sendMessageDirectly(this.privateChatId, text);
    return { success, error: success ? undefined : 'فشل إرسال الإشارة التجريبية إلى تليجرام' };
  }

  /**
   * Formats and delivers a newly qualified trade signal alert
   */
  public async sendSignalNotification(signal: any): Promise<boolean> {
    if (!this.privateChatId) return false;

    const isBuy = String(signal.signal).toUpperCase().includes('BUY');
    const actionEmoji = isBuy ? '🟢' : '🔴';
    const actionText = isBuy ? 'شراء الآن (BUY NOW)' : 'بيع الآن (SELL NOW)';

    const text = `
<b>🔔 إشارة تداول جديدة من Gold AI Scanner!</b>

${actionEmoji} <b>الصفقة المقترحة:</b> ${actionText}
📊 <b>الأصل:</b> XAU/USD (الذهب)
📈 <b>سعر الدخول:</b> $${Number(signal.entry).toFixed(2)}
🛑 <b>وقف الخسارة (SL):</b> $${Number(signal.stopLoss).toFixed(2)} (${signal.slPoints} نقطة)
🎯 <b>الهدف الأول (TP1):</b> $${Number(signal.tp1).toFixed(2)}
🎯 <b>الهدف الثاني (TP2):</b> ${signal.tp2 ? '$' + Number(signal.tp2).toFixed(2) : 'غير محدد'}
⚖️ <b>المخاطرة:</b> ${signal.riskPercent || 15}% ($${Number(signal.riskAmount || 1.5).toFixed(2)})
🧠 <b>نسبة الثقة:</b> ${signal.confidence}%
🛠️ <b>النموذج الفني:</b> ${signal.setup || 'غير محدد'}

⏱ <i>الوقت: ${new Date().toLocaleTimeString('ar-EG')}</i>
    `.trim();

    // Attach manual outcome buttons linked to this signal ID
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '🟢 WIN', callback_data: `win:${signal.id}` },
          { text: '🔴 LOSS', callback_data: `loss:${signal.id}` },
          { text: '⚪ NOT ENTERED', callback_data: `not_entered:${signal.id}` }
        ]
      ]
    };

    const sentMessage = await this.sendMessageDirectly(this.privateChatId, text, replyMarkup);
    if (sentMessage && sentMessage.message_id) {
      this.signalMessageIds[signal.id] = sentMessage.message_id;
      this.saveMessageMapping();
    }
    return !!sentMessage;
  }

  /**
   * Formats and delivers continuous trade management notifications (Phase 4)
   */
  public async sendManagementNotification(formattedMessage: string): Promise<boolean> {
    if (!this.privateChatId) return false;
    return this.sendMessageDirectly(this.privateChatId, formattedMessage);
  }

  /**
   * Update active signals with latest price and floating P&L on Telegram
   */
  public async updateActiveSignals(currentPrice: number): Promise<void> {
    if (!this.privateChatId || !this.botToken) return;

    const signalIds = Object.keys(this.signalMessageIds);
    if (signalIds.length === 0) return;

    for (const signalId of signalIds) {
      try {
        const messageId = this.signalMessageIds[signalId];
        if (!messageId) continue;

        // Check if the signal is still active
        // It is considered inactive if:
        // 1. A trade outcome record exists for it.
        // 2. Or the trade in ledger exists and is closed.
        const existingOutcome = storage.getTradeOutcome(signalId);
        const existingTrade = storage.getTrade(signalId);
        const signal = storage.getSignal(signalId);

        if (existingOutcome || (existingTrade && existingTrade.result !== 'OPEN') || (signal && signal.lifecycleState === 'NOT_ENTERED')) {
          // No longer active, remove from tracking to stop periodic updates
          delete this.signalMessageIds[signalId];
          this.saveMessageMapping();
          continue;
        }

        if (!signal) {
          // If signal was deleted or not found, skip
          continue;
        }

        const isBuy = String(signal.signal).toUpperCase().includes('BUY');
        const actionEmoji = isBuy ? '🟢' : '🔴';
        const actionText = isBuy ? 'شراء الآن (BUY NOW)' : 'بيع الآن (SELL NOW)';

        const lotSize = signal.standardLot ?? signal.recommendedLotSize ?? 0.01;
        const priceDiff = isBuy ? (currentPrice - signal.entry) : (signal.entry - currentPrice);
        const unrealizedPnl = priceDiff * 100 * lotSize;
        const pnlSign = unrealizedPnl >= 0 ? '+' : '';

        const text = `
<b>🔔 إشارة تداول نشطة من Gold AI Scanner!</b>

${actionEmoji} <b>الصفقة المقترحة:</b> ${actionText}
📊 <b>الأصل:</b> XAU/USD (الذهب)
📈 <b>سعر الدخول:</b> $${Number(signal.entry).toFixed(2)}
🛑 <b>وقف الخسارة (SL):</b> $${Number(signal.stopLoss).toFixed(2)} (${signal.slPoints} نقطة)
🎯 <b>الهدف الأول (TP1):</b> $${Number(signal.tp1).toFixed(2)}
🎯 <b>الهدف الثاني (TP2):</b> ${signal.tp2 ? '$' + Number(signal.tp2).toFixed(2) : 'غير محدد'}
⚖️ <b>المخاطرة:</b> ${signal.riskPercent || 15}% ($${Number(signal.riskAmount || 1.5).toFixed(2)})
🧠 <b>نسبة الثقة:</b> ${signal.confidence}%
🛠️ <b>النموذج الفني:</b> ${signal.setup || 'غير محدد'}

⚡ <b>حالة الصفقة:</b> نشطة (ACTIVE)
💵 <b>السعر الحالي:</b> $${currentPrice.toFixed(2)}
💰 <b>أرباح/خسائر غير محققة (Floating P&L):</b> ${pnlSign}$${unrealizedPnl.toFixed(2)}

⏱ <i>تحديث تلقائي: ${new Date().toLocaleTimeString('ar-EG')} | Live Feed</i>
        `.trim();

        const replyMarkup = {
          inline_keyboard: [
            [
              { text: '🟢 WIN', callback_data: `win:${signal.id}` },
              { text: '🔴 LOSS', callback_data: `loss:${signal.id}` },
              { text: '⚪ NOT ENTERED', callback_data: `not_entered:${signal.id}` }
            ]
          ]
        };

        await this.editMessageText(this.privateChatId, messageId, text, replyMarkup);
      } catch (err) {
        console.error(`[Telegram] Error updating active signal ${signalId}:`, err);
      }
    }
  }

  /**
   * Formats and delivers completed trade outcome alerts
   */
  public async sendOutcomeNotification(outcome: any, trade: any): Promise<boolean> {
    if (!this.privateChatId) return false;

    const isWin = outcome.outcome === 'WIN';
    const outcomeEmoji = isWin ? '🟢' : '🔴';
    const outcomeText = isWin ? 'صفقة رابحة (WIN)' : 'صفقة خاسرة (LOSS)';
    const pnlSign = outcome.realizedPnl >= 0 ? '+' : '';

    const text = `
<b>${outcomeEmoji} توثيق نتيجة صفقة من Gold AI!</b>

📊 <b>الأصل:</b> XAU/USD (الذهب)
🎯 <b>النتيجة:</b> ${outcomeText}
💰 <b>الربح/الخسارة المحققة:</b> ${pnlSign}$${Number(outcome.realizedPnl).toFixed(2)}
📈 <b>سعر الدخول:</b> $${Number(outcome.entry || trade.entry || 0).toFixed(2)}
📉 <b>سعر الخروج:</b> $${Number(outcome.exitPrice || trade.exitPrice || 0).toFixed(2)}
ℹ️ <b>سبب الإغلاق:</b> ${outcome.closeReason || 'تصفية يدوية أو نظام الوقف'}

⏱ <i>الوقت: ${new Date().toLocaleTimeString('ar-EG')}</i>
    `.trim();

    return this.sendMessageDirectly(this.privateChatId, text);
  }

  /**
   * Check if there are active signals currently tracked
   */
  public hasActiveSignals(): boolean {
    return Object.keys(this.signalMessageIds).length > 0;
  }

  /**
   * Get the mapped Telegram message ID for a signal
   */
  public getTelegramMessageId(signalId: string): number | undefined {
    return this.signalMessageIds[signalId];
  }
}

export const telegramService = new TelegramService();
