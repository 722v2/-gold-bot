import fs from 'fs';
import path from 'path';
import { storage } from './storage.js';

const GLOBAL_TELEGRAM_SERVICE_KEY = Symbol.for('__GOLD_AI_TELEGRAM_SERVICE__');
const GLOBAL_TELEGRAM_POLLING_RUNNING = Symbol.for('__GOLD_AI_TELEGRAM_POLLING_RUNNING__');

export interface TelegramStatus {
  registered: boolean;
  chatId: string | null;
  botId: string | null;
}

export interface PendingPnlRequest {
  signalId: string;
  outcome: 'WIN' | 'LOSS';
  signal: any;
  messageId?: number;
  originalMessageText?: string;
  requestedAt: number;
}

export class TelegramService {
  private botToken: string | null = null;
  private privateChatId: string | null = null;
  private botId: string | null = null;
  private lastSendError: string | null = null;
  private configPath = path.join(process.cwd(), 'data', 'telegram_private_chat.json');
  private messageMappingPath = path.join(process.cwd(), 'data', 'telegram_signal_messages.json');
  private pendingPnlPath = path.join(process.cwd(), 'data', 'telegram_pending_pnl.json');
  private isRunning = false;
  private isInitializing = false;
  private abortController: AbortController | null = null;
  private lastUpdateId = 0;
  private signalMessageIds: Record<string, number> = {};
  private pendingPnlRequests: Map<string, PendingPnlRequest> = new Map();

  constructor() {
    this.botToken = this.getBotToken();
    this.botId = this.getBotIdFromToken(this.botToken);
    this.loadRegisteredChat();
    this.loadMessageMapping();
    this.loadPendingPnlRequests();
  }

  /**
   * Dynamically resolve and sanitize Telegram bot token from environment
   */
  public getBotToken(): string | null {
    const raw = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || this.botToken || '';
    if (!raw) return null;
    const sanitized = raw.trim().replace(/^["']|["']$/g, '');
    return sanitized.length > 0 ? sanitized : null;
  }

  /**
   * Get authorized user IDs from environment variables
   */
  public getAuthorizedUserIds(): string[] {
    const raw = process.env.TELEGRAM_AUTHORIZED_USER_IDS || process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_USER_ID || '';
    if (!raw) return [];
    return raw
      .split(/[,\s]+/)
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length > 0);
  }

  /**
   * Check if user/chat is authorized
   */
  public isAuthorized(userIdOrChatId: string | number): boolean {
    const authorized = this.getAuthorizedUserIds();
    if (authorized.length === 0) return true;
    const target = String(userIdOrChatId).trim();
    return authorized.includes(target);
  }

  /**
   * Load stored pending P&L requests from disk
   */
  private loadPendingPnlRequests(): void {
    try {
      if (fs.existsSync(this.pendingPnlPath)) {
        const data = JSON.parse(fs.readFileSync(this.pendingPnlPath, 'utf8'));
        if (data && typeof data === 'object') {
          for (const [chatId, req] of Object.entries(data)) {
            this.pendingPnlRequests.set(chatId, req as PendingPnlRequest);
          }
          console.log(`[Telegram] Loaded ${this.pendingPnlRequests.size} pending P&L input requests.`);
        }
      }
    } catch (err) {
      console.error('[Telegram] Error loading pending P&L requests:', err);
    }
  }

  /**
   * Save pending P&L requests to disk safely
   */
  private savePendingPnlRequests(): void {
    try {
      const dir = path.dirname(this.pendingPnlPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const obj: Record<string, PendingPnlRequest> = {};
      for (const [chatId, req] of this.pendingPnlRequests.entries()) {
        obj[chatId] = req;
      }
      fs.writeFileSync(this.pendingPnlPath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      console.error('[Telegram] Error saving pending P&L requests:', err);
    }
  }

  /**
   * Clear pending P&L request for a chat
   */
  public clearPendingPnlRequest(chatId: string): void {
    this.pendingPnlRequests.delete(chatId);
    this.savePendingPnlRequests();
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
   * Load stored private chat ID from disk or storage fallback or env vars
   */
  private loadRegisteredChat(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        if (data && data.chatId) {
          this.privateChatId = String(data.chatId);
          console.log(`[Telegram] Loaded registered private chat ID: ${this.privateChatId}`);
          return;
        }
      }
      const storageChatId = storage.getTelegramChatId();
      if (storageChatId) {
        this.privateChatId = storageChatId;
        console.log(`[Telegram] Loaded registered private chat ID from storage: ${this.privateChatId}`);
        return;
      }
      const authorizedIds = this.getAuthorizedUserIds();
      if (authorizedIds.length > 0) {
        this.privateChatId = authorizedIds[0];
        console.log(`[Telegram] Loaded private chat ID from authorized user env config: ${this.privateChatId}`);
      }
    } catch (err) {
      console.error('[Telegram] Error loading registered chat ID:', err);
    }
  }

  /**
   * Get active private chat ID with persistent storage and env fallback
   */
  public getPrivateChatId(): string | null {
    if (this.privateChatId) {
      return this.privateChatId;
    }
    const persisted = storage.getTelegramChatId();
    if (persisted) {
      this.privateChatId = persisted;
      return this.privateChatId;
    }
    if (fs.existsSync(this.configPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        if (data && data.chatId) {
          this.privateChatId = String(data.chatId);
          return this.privateChatId;
        }
      } catch {
        // ignore disk read errors
      }
    }
    const authorizedIds = this.getAuthorizedUserIds();
    if (authorizedIds.length > 0) {
      this.privateChatId = authorizedIds[0];
      return this.privateChatId;
    }
    return null;
  }

  /**
   * Save private chat ID to disk safely and permanently in Firestore
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

      // Permanently persist to Firestore
      storage.saveTelegramChatId(chatId).catch((err) => {
        console.error('[Telegram] Error saving chat ID to Firestore:', err);
      });
    } catch (err) {
      console.error('[Telegram] Error saving registered chat ID:', err);
    }
  }

  /**
   * Stop polling loop and cancel in-flight requests cleanly
   */
  public stop(): void {
    this.isRunning = false;
    (globalThis as any)[GLOBAL_TELEGRAM_POLLING_RUNNING] = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    console.log('[Telegram] Polling loop stopped cleanly.');
  }

  /**
   * Initialize long-polling to detect /start command from the user
   */
  public async init(): Promise<void> {
    const token = this.getBotToken();
    if (!token) {
      console.warn('[Telegram] TELEGRAM_BOT_TOKEN is not configured in Secrets. Telegram service is offline.');
      return;
    }
    this.botToken = token;
    this.botId = this.getBotIdFromToken(token);

    if (this.isRunning || this.isInitializing || (globalThis as any)[GLOBAL_TELEGRAM_POLLING_RUNNING]) {
      console.log('[Telegram] Polling is already active or initializing. Skipping duplicate init call.');
      return;
    }

    this.isInitializing = true;
    (globalThis as any)[GLOBAL_TELEGRAM_POLLING_RUNNING] = true;

    try {
      // Check and clear any conflicting webhook configuration on Telegram's servers
      await this.ensureWebhookRemoved();

      // Ensure persistent storage chat ID is loaded and applied immediately on startup
      try {
        await storage.waitUntilReady();
        const persistedChatId = storage.getTelegramChatId();
        if (persistedChatId) {
          this.privateChatId = persistedChatId;
          console.log(`[Telegram] Active private chat ID verified from persistent storage: ${this.privateChatId}`);
        }
      } catch (storageErr) {
        console.warn('[Telegram] Warning waiting for storage during init:', storageErr);
      }

      console.log('[Telegram] Brand-new Telegram integration initialized. Starting private chat detection polling...');
      this.isRunning = true;
      this.runPollingLoop().catch((err) => {
        console.error('[Telegram] Unexpected error in polling loop:', err);
      });
    } catch (err: any) {
      console.error('[Telegram] Error during polling initialization:', err?.message || err);
      (globalThis as any)[GLOBAL_TELEGRAM_POLLING_RUNNING] = false;
      this.isRunning = false;
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Check and remove any configured webhook before starting getUpdates long polling
   */
  private async ensureWebhookRemoved(): Promise<void> {
    const token = this.getBotToken();
    if (!token) return;

    try {
      const infoUrl = `https://api.telegram.org/bot${token}/getWebhookInfo`;
      const res = await fetch(infoUrl);
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data?.ok && data?.result?.url) {
          console.log(`[Telegram] Webhook currently configured: "${data.result.url}". Removing webhook to prevent 409 conflict...`);
          const deleteUrl = `https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`;
          const deleteRes = await fetch(deleteUrl);
          const deleteData = (await deleteRes.json()) as any;
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
        await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`);
      }
    } catch (err: any) {
      console.warn('[Telegram] Error checking/removing webhook:', err?.message || err);
    }
  }

  /**
   * Non-overlapping sequential polling loop with 409 Conflict handling and graceful backoff
   */
  private async runPollingLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const token = this.getBotToken();
        if (!token) break;

        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${this.lastUpdateId + 1}&limit=10&timeout=2`;
        const res = await fetch(url, { signal });

        if (res.status === 409) {
          // Telegram 409 Conflict: Another getUpdates request terminated this one.
          // This typically happens during Render zero-downtime deploy handover or when previous instance is draining.
          console.warn('[Telegram] 409 Conflict from getUpdates (another instance or deploy handover in progress). Waiting 5s before retrying...');
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        if (!res.ok) {
          console.warn(`[Telegram Polling Warning] HTTP error ${res.status}. Backing off 3s...`);
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }

        const body = (await res.json()) as any;
        if (body && body.ok && Array.isArray(body.result)) {
          for (const update of body.result) {
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
            await this.processUpdate(update);
          }
        }

        // Sequential rest interval between polling cycles
        if (this.isRunning) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch (err: any) {
        if (err?.name === 'AbortError' || !this.isRunning) {
          break;
        }
        console.debug(`[Telegram Polling Warning] ${err?.message || err}`);
        if (this.isRunning) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      } finally {
        this.abortController = null;
      }
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
      const currentChatId = this.getPrivateChatId();
      // Check authorization whitelist if configured
      const fromId = String(message.from?.id || '');
      if (!this.isAuthorized(chatId) && !this.isAuthorized(fromId)) {
        console.warn(`[Telegram] Unauthorized /start attempt from Chat ID: ${chatId} / User ID: ${fromId}.`);
        await this.sendMessageDirectly(chatId, '⚠️ عذراً، هذا المعرف غير مصرح له باستخدام نظام التداول الآلي.');
        return;
      }

      // Save chat ID if it's new or not yet registered
      if (currentChatId !== chatId) {
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
      return;
    }

    // Check for /cancel command
    if (text.startsWith('/cancel')) {
      if (this.pendingPnlRequests.has(chatId)) {
        this.clearPendingPnlRequest(chatId);
        await this.sendMessageDirectly(chatId, '❌ تم إلغاء عملية توثيق نتيجة الصفقة.');
      } else {
        await this.sendMessageDirectly(chatId, 'ℹ️ لا توجد عملية توثيق معلقة لإلغائها.');
      }
      return;
    }

    // Check if there is an active pending P&L input waiting for this chat
    const pending = this.pendingPnlRequests.get(chatId);
    if (pending) {
      const cleanText = text.replace(/[$€£\s]/g, '');
      const numMatch = cleanText.match(/[-+]?[0-9]*\.?[0-9]+/);
      if (!numMatch || isNaN(parseFloat(numMatch[0]))) {
        const eg = pending.outcome === 'WIN' ? '12.50' : '4.00';
        await this.sendMessageDirectly(
          chatId,
          `⚠️ <b>قيمة غير صالحة!</b>\nيرجى كتابة رقم صحيح لقيمة ${pending.outcome === 'WIN' ? 'الربح' : 'الخسارة'} بالدولار (USD).\nمثال: <code>${eg}</code>\n\n<i>أرسل /cancel لإلغاء العملية</i>`
        );
        return;
      }

      const rawAmount = parseFloat(numMatch[0]);
      // Authoritative P&L: WIN is positive profit, LOSS is negative loss
      const finalRealizedPnl = pending.outcome === 'WIN' ? Math.abs(rawAmount) : -Math.abs(rawAmount);
      const exitPrice = pending.outcome === 'WIN' ? Number(pending.signal.tp1) : Number(pending.signal.stopLoss);

      const record: any = {
        signalId: pending.signal.id,
        tradeId: pending.signal.id,
        direction: pending.signal.signal,
        orderType: 'MARKET',
        entry: Number(pending.signal.entry),
        stopLoss: Number(pending.signal.stopLoss),
        tp1: Number(pending.signal.tp1),
        tp2: pending.signal.tp2 ? Number(pending.signal.tp2) : undefined,
        outcome: pending.outcome,
        realizedPnl: finalRealizedPnl,
        pl: finalRealizedPnl,
        exitPrice: exitPrice,
        source: 'MANUAL',
        closedAt: Date.now(),
        closeReason: 'MANUAL_TELEGRAM_BUTTON',
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
      };

      const res = await storage.recordTradeOutcomeAsync(record, pending.signal);
      if (res.success) {
        delete this.signalMessageIds[pending.signalId];
        this.saveMessageMapping();

        if (pending.messageId) {
          try {
            await this.removeInlineKeyboard(chatId, pending.messageId);
            const outcomeStr = pending.outcome === 'WIN' ? '🟢 صفقة رابحة (WIN)' : '🔴 صفقة خاسرة (LOSS)';
            const updatedText = `
${pending.originalMessageText || ''}

<b>📝 النتيجة المعتمدة:</b> ${outcomeStr}
💰 <b>الـ P&L الفعلي المحقق:</b> ${finalRealizedPnl >= 0 ? '+' : ''}$${finalRealizedPnl.toFixed(2)}
            `.trim();
            await this.editMessageText(chatId, pending.messageId, updatedText);
          } catch (e) {
            console.warn('[Telegram] Could not edit original message:', e);
          }
        }

        const newBal = storage.getCurrentBalance();
        const outcomeStr = pending.outcome === 'WIN' ? '🟢 صفقة رابحة (WIN)' : '🔴 صفقة خاسرة (LOSS)';
        this.clearPendingPnlRequest(chatId);

        await this.sendMessageDirectly(
          chatId,
          `
✅ <b>تم توثيق الصفقة وتحديث رصيد الحساب بنجاح!</b>

📊 <b>الصفقة:</b> ${pending.signal.signal} (${pending.signal.asset || 'XAU/USD'})
📝 <b>النتيجة:</b> ${outcomeStr}
💵 <b>الـ P&L الفعلي المعتمد:</b> ${finalRealizedPnl >= 0 ? '+' : ''}$${finalRealizedPnl.toFixed(2)}
🏦 <b>رصيد الحساب الجديد:</b> $${Number(newBal).toFixed(2)}

⏱ <i>الوقت: ${new Date().toLocaleTimeString('ar-EG')}</i>
          `.trim()
        );
      } else {
        await this.sendMessageDirectly(chatId, `❌ <b>حدث خطأ أثناء حفظ النتيجة:</b> ${res.message || 'فشل التوثيق'}`);
      }
      return;
    }
  }

  /**
   * Send text directly to a specific chat ID
   */
  private async sendMessageDirectly(chatId: string, text: string, replyMarkup?: any): Promise<any> {
    const token = this.getBotToken();
    if (!token) {
      this.lastSendError = 'TELEGRAM_BOT_TOKEN is not configured.';
      return null;
    }

    try {
      this.lastSendError = null;
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
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
      
      const errMsg = body?.description || `HTTP ${res.status}`;
      this.lastSendError = `Telegram API Error (${res.status}): ${errMsg}`;
      console.error(`[Telegram Outbound Error] sendMessage to chat ${chatId} failed (HTTP ${res.status}): ${errMsg}`);
      return null;
    } catch (err: any) {
      this.lastSendError = `Network error: ${err?.message || err}`;
      console.error(`[Telegram Network Error] Error sending message to chat ${chatId}:`, err?.message || err);
      return null;
    }
  }

  /**
   * Edit message text on Telegram
   */
  private async editMessageText(chatId: string, messageId: number, text: string, replyMarkup?: any): Promise<boolean> {
    const token = this.getBotToken();
    if (!token) return false;

    try {
      const url = `https://api.telegram.org/bot${token}/editMessageText`;
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
      if (body && body.ok === true) {
        return true;
      }
      console.error(`[Telegram Outbound Error] editMessageText ${messageId} in chat ${chatId} failed (HTTP ${res.status}): ${body?.description || 'Unknown error'}`);
      return false;
    } catch (err: any) {
      console.error(`[Telegram Network Error] Error editing message text ${messageId} in chat ${chatId}:`, err?.message || err);
      return false;
    }
  }

  /**
   * Remove inline keyboard markup from a message
   */
  private async removeInlineKeyboard(chatId: string, messageId: number): Promise<boolean> {
    const token = this.getBotToken();
    if (!token) return false;

    try {
      const url = `https://api.telegram.org/bot${token}/editMessageReplyMarkup`;
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
      if (body && body.ok === true) {
        return true;
      }
      console.error(`[Telegram Outbound Error] removeInlineKeyboard ${messageId} in chat ${chatId} failed (HTTP ${res.status}): ${body?.description || 'Unknown error'}`);
      return false;
    } catch (err: any) {
      console.error(`[Telegram Network Error] Error removing inline keyboard for message ${messageId} in chat ${chatId}:`, err?.message || err);
      return false;
    }
  }

  /**
   * Answer a callback query to acknowledge the button press in UI
   */
  private async answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false): Promise<boolean> {
    const token = this.getBotToken();
    if (!token) return false;

    try {
      const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          ...(text ? { text, show_alert: showAlert } : {}),
        }),
      });

      const body = await res.json() as any;
      if (body && body.ok === true) {
        return true;
      }
      console.error(`[Telegram Outbound Error] answerCallbackQuery ${callbackQueryId} failed (HTTP ${res.status}): ${body?.description || 'Unknown error'}`);
      return false;
    } catch (err: any) {
      console.error(`[Telegram Network Error] Error answering callback query ${callbackQueryId}:`, err?.message || err);
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
        // Confirm trade exists in ledger (save as OPEN if not yet present)
        if (!existingTrade) {
          const newTrade: any = {
            id: signal.id,
            signalId: signal.id,
            tradeNumber: (storage.getTrades(1)[0]?.tradeNumber || 0) + 1,
            date: new Date(signal.timestamp || Date.now()).toLocaleDateString('ar-EG', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
            isoTime: new Date(signal.timestamp || Date.now()).toISOString(),
            asset: signal.asset || 'XAU/USD',
            direction: signal.signal as any,
            entry: Number(signal.entry),
            sl: Number(signal.stopLoss),
            slPoints: signal.slPoints || Math.round(Math.abs(Number(signal.entry) - Number(signal.stopLoss)) / 0.1),
            tp1: Number(signal.tp1),
            tp1Points: signal.tp1Points || Math.round(Math.abs(Number(signal.tp1) - Number(signal.entry)) / 0.1),
            tp2: signal.tp2 ? Number(signal.tp2) : undefined,
            tp2Points: signal.tp2Points || (signal.tp2 ? Math.round(Math.abs(Number(signal.tp2) - Number(signal.entry)) / 0.1) : undefined),
            lotSize: signal.standardLot ?? signal.recommendedLotSize ?? 0.01,
            riskPercent: signal.riskPercent || 15,
            riskAmount: signal.riskAmount || 1.5,
            confidence: signal.confidence || 75,
            setup: signal.setup || 'Telegram Signal',
            rr: signal.rr || '1:1.5',
            result: 'OPEN',
            pl: 0,
            isActive: true,
            source: 'MANUAL',
            notes: 'تم الدخول يدوياً عبر زر التليجرام',
          };
          await storage.saveTradeAsync(newTrade);
        }

        const outcomeVal = action === 'win' ? 'WIN' : 'LOSS';
        const lotSize = signal.standardLot ?? signal.recommendedLotSize ?? 0.01;
        const estProfit = Math.abs(Number(signal.tp1) - Number(signal.entry)) * 100 * lotSize;
        const estLoss = Math.abs(Number(signal.entry) - Number(signal.stopLoss)) * 100 * lotSize;
        const egVal = outcomeVal === 'WIN' ? estProfit.toFixed(2) : estLoss.toFixed(2);

        // Store pending P&L request awaiting user reply with USD amount
        this.pendingPnlRequests.set(chatId, {
          signalId: signal.id,
          outcome: outcomeVal,
          signal,
          messageId,
          originalMessageText: message.text,
          requestedAt: Date.now(),
        });
        this.savePendingPnlRequests();

        await this.answerCallbackQuery(
          queryId,
          outcomeVal === 'WIN' ? '🟢 يرجى إرسال قيمة الربح المحقق بالدولار' : '🔴 يرجى إرسال قيمة الخسارة المحققة بالدولار'
        );

        if (outcomeVal === 'WIN') {
          await this.sendMessageDirectly(
            chatId,
            `🟢 <b>توثيق صفقة رابحة (WIN)</b>\n\n` +
            `📊 <b>الصفقة:</b> ${signal.signal} (${signal.asset || 'XAU/USD'})\n` +
            `📈 <b>الدخول:</b> $${Number(signal.entry).toFixed(2)} | <b>الهدف TP1:</b> $${Number(signal.tp1).toFixed(2)}\n\n` +
            `✍️ <b>يرجى إرسال قيمة الربح الفعلي المحقق بالدولار (USD):</b>\n` +
            `<i>(أرسل الرقم في المحادثة مباشرة، مثال: <code>${egVal}</code> أو <code>15.00</code>)</i>\n\n` +
            `❌ <i>لإلغاء العملية أرسل: /cancel</i>`
          );
        } else {
          await this.sendMessageDirectly(
            chatId,
            `🔴 <b>توثيق صفقة خاسرة (LOSS)</b>\n\n` +
            `📊 <b>الصفقة:</b> ${signal.signal} (${signal.asset || 'XAU/USD'})\n` +
            `📈 <b>الدخول:</b> $${Number(signal.entry).toFixed(2)} | <b>وقف الخسارة SL:</b> $${Number(signal.stopLoss).toFixed(2)}\n\n` +
            `✍️ <b>يرجى إرسال قيمة الخسارة الفعلية بالدولار (USD):</b>\n` +
            `<i>(أرسل الرقم في المحادثة مباشرة، مثال: <code>${egVal}</code> أو <code>-${egVal}</code>)</i>\n\n` +
            `❌ <i>لإلغاء العملية أرسل: /cancel</i>`
          );
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
    const token = this.getBotToken();
    if (!token) {
      return { success: false, error: 'Telegram service bot token not configured.' };
    }

    const chatId = this.getPrivateChatId();
    if (!chatId) {
      return { success: false, error: 'NOT_REGISTERED' };
    }

    const result = await this.sendMessageDirectly(chatId, text);
    return {
      success: !!result,
      error: result ? undefined : (this.lastSendError || 'فشل إرسال الرسالة إلى تليجرام'),
    };
  }

  /**
   * Get the current registration status
   */
  public getStatus(): TelegramStatus {
    const chatId = this.getPrivateChatId();
    const token = this.getBotToken();
    const botId = this.getBotIdFromToken(token);
    return {
      registered: chatId !== null,
      chatId: chatId,
      botId: botId,
    };
  }

  /**
   * Sends a beautiful test notification to the detected private chat
   */
  public async sendTestNotification(): Promise<{ success: boolean; error?: string }> {
    const token = this.getBotToken();
    if (!token) {
      return { success: false, error: 'البوت غير مكوّن. يرجى إدخال TELEGRAM_BOT_TOKEN في متغيرات البيئة (Secrets).' };
    }

    const chatId = this.getPrivateChatId();
    if (!chatId) {
      return { success: false, error: 'لم يتم العثور على معرّف المحادثة الخاصة (Chat ID). يرجى فتح البوت وإرسال /start أو ضبط TELEGRAM_AUTHORIZED_USER_IDS.' };
    }

    const text = `
<b>🧪 تجربة اتصال نظام Gold AI Trader</b>

الاتصال يعمل بنجاح ومؤمّن بالكامل!
ستصلك كافة التحليلات وإشعارات الصفقات وإجراءات إدارة الصفقات (Phase 4) هنا مباشرة وبشكل آمن تماماً.

🟢 <b>حالة الاتصال:</b> ممتازة (نشط)
🔒 <b>نوع القناة:</b> محادثة خاصة مشفّرة (Private Chat)
⏱ <b>الوقت:</b> ${new Date().toLocaleTimeString('ar-EG')}
    `.trim();

    const result = await this.sendMessageDirectly(chatId, text);
    return {
      success: !!result,
      error: result ? undefined : (this.lastSendError || 'فشل إرسال الرسالة إلى تليجرام'),
    };
  }

  /**
   * Formats and delivers a mock / test trading signal alert
   */
  public async sendMockSignalNotification(): Promise<{ success: boolean; error?: string }> {
    const token = this.getBotToken();
    if (!token) {
      return { success: false, error: 'البوت غير مكوّن. يرجى إدخال TELEGRAM_BOT_TOKEN في متغيرات البيئة (Secrets).' };
    }

    const chatId = this.getPrivateChatId();
    if (!chatId) {
      return { success: false, error: 'لم يتم العثور على معرّف المحادثة الخاصة (Chat ID). يرجى فتح البوت وإرسال /start أو ضبط TELEGRAM_AUTHORIZED_USER_IDS.' };
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

    const result = await this.sendMessageDirectly(chatId, text);
    return {
      success: !!result,
      error: result ? undefined : (this.lastSendError || 'فشل إرسال الإشارة التجريبية إلى تليجرام'),
    };
  }

  /**
   * Formats and delivers a newly qualified trade signal alert
   */
  public async sendSignalNotification(signal: any): Promise<boolean> {
    const chatId = this.getPrivateChatId();
    if (!chatId) return false;

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

    const sentMessage = await this.sendMessageDirectly(chatId, text, replyMarkup);
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
    const chatId = this.getPrivateChatId();
    if (!chatId) return false;
    return this.sendMessageDirectly(chatId, formattedMessage);
  }

  /**
   * Update active signals with latest price and floating P&L on Telegram
   */
  public async updateActiveSignals(currentPrice: number): Promise<void> {
    const chatId = this.getPrivateChatId();
    if (!chatId || !this.botToken) return;

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

        await this.editMessageText(chatId, messageId, text, replyMarkup);
      } catch (err) {
        console.error(`[Telegram] Error updating active signal ${signalId}:`, err);
      }
    }
  }

  /**
   * Formats and delivers completed trade outcome alerts
   */
  public async sendOutcomeNotification(outcome: any, trade: any): Promise<boolean> {
    const chatId = this.getPrivateChatId();
    if (!chatId) return false;

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

    return this.sendMessageDirectly(chatId, text);
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

// Ensure process-wide singleton across bundled chunks and re-evaluations
const existingInstance = (globalThis as any)[GLOBAL_TELEGRAM_SERVICE_KEY] as TelegramService | undefined;
export const telegramService: TelegramService = existingInstance || new TelegramService();
(globalThis as any)[GLOBAL_TELEGRAM_SERVICE_KEY] = telegramService;

// Graceful cleanup on process exit
if (typeof process !== 'undefined' && process.on) {
  process.once('SIGTERM', () => {
    telegramService.stop();
  });
  process.once('SIGINT', () => {
    telegramService.stop();
  });
}

