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

interface PendingTelegramOutcome {
  signalId: string;
  tradeId: string;
  direction: string;
  orderType: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  outcome: 'WIN' | 'LOSS';
  lotSize: number;
  chatId: string | number;
  userId?: string;
  messageId?: number;
  originalText: string;
  timestamp: number;
  createdAt: number;
  status: 'PENDING' | 'COMPLETED' | 'CANCELLED';
}

class TelegramService {
  private lastStatus: 'CONNECTED' | 'NOT CONFIGURED' | 'ERROR' = 'NOT CONFIGURED';
  private lastError: string | null = null;
  private lastSentTimestamp: number | null = null;
  private lastDetectedChatId: string | number | null = null;
  private sentNotificationIds = new Set<string>();
  private sentSetupKeys = new Set<string>();
  private pendingOutcomes = new Map<string, PendingTelegramOutcome>();
  private readonly sentFilePath: string;
  private readonly detectedChatPath: string;
  private readonly pendingOutcomesPath: string;

  // Telegram update delivery mode (Strictly ONE delivery method at runtime)
  private deliveryMethod: 'LONG_POLLING' | 'WEBHOOK' | 'NONE' = 'NONE';
  private isPolling = false;
  private pollingAbortController = null;
  private lastUpdateId = 0;

  constructor() {
    this.sentFilePath = path.join(process.cwd(), 'data', 'telegram_sent_ids.json');
    this.detectedChatPath = path.join(process.cwd(), 'data', 'telegram_detected_chat.json');
    this.pendingOutcomesPath = path.join(process.cwd(), 'data', 'telegram_pending_outcomes.json');
    this.loadSentIds();
    this.loadDetectedChat();
    this.loadPendingOutcomes();
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

  private loadPendingOutcomes() {
    try {
      if (fs.existsSync(this.pendingOutcomesPath)) {
        const raw = fs.readFileSync(this.pendingOutcomesPath, 'utf8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          for (const [key, val] of Object.entries(data)) {
            this.pendingOutcomes.set(key, val as PendingTelegramOutcome);
          }
        }
      }
    } catch {
      // Gracefully ignore
    }
  }

  private persistPendingOutcomes() {
    try {
      const dataDir = path.join(process.cwd(), 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const obj: Record<string, PendingTelegramOutcome> = {};
      for (const [key, val] of this.pendingOutcomes.entries()) {
        obj[key] = val;
      }
      fs.writeFileSync(this.pendingOutcomesPath, JSON.stringify(obj, null, 2), 'utf8');
    } catch {
      // Gracefully ignore
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
  public async sendSignalNotification(
    signal: TradeSignal,
    scanId?: string
  ): Promise<{
    success: boolean;
    status: 'NOT_ATTEMPTED' | 'SUPPRESSED' | 'SENT' | 'FAILED';
    reason?: string;
    messageId?: number;
  }> {
    const dedupeId = scanId || signal.id;
    if (this.sentNotificationIds.has(dedupeId) || storage.isTelegramDispatched(dedupeId)) {
      const suppReason = `Skipping duplicate signal notification for ${dedupeId}`;
      console.log(`[TELEGRAM] ${suppReason}`);
      return { success: false, status: 'SUPPRESSED', reason: suppReason };
    }

    const setupKey = signal.setupId
      || (signal as any).patternMetadata?.patternAnchorKey
      || (signal as any).structuralAnchorKey
      || (signal as any).setupKey
      || `tg_${signal.setup}_${signal.signal.includes('BUY') ? 'BUY' : 'SELL'}_${Math.round((signal.entry || 0) / 3)}`;

    if (this.sentSetupKeys.has(setupKey) || storage.isTelegramDispatched(setupKey)) {
      const suppReason = `Skipping duplicate telegram notification for structural setup key ${setupKey}`;
      console.log(`[TELEGRAM] ${suppReason}`);
      return { success: false, status: 'SUPPRESSED', reason: suppReason };
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

    if (result.success) {
      // ONLY register as sent if sending actually SUCCEEDED
      this.sentNotificationIds.add(dedupeId);
      this.sentSetupKeys.add(setupKey);
      storage.saveTelegramDispatch(dedupeId);
      storage.saveTelegramDispatch(setupKey);
      if (signal.setupId) {
        storage.saveTelegramDispatch(signal.setupId);
      }
      this.persistSentIds();
      console.log(`[TELEGRAM] Successfully dispatched signal ${signal.id} (${signal.setup}) to chat`);
      return {
        success: true,
        status: 'SENT',
        messageId: result.messageId,
      };
    } else {
      console.warn(`[TELEGRAM] Failed to dispatch signal ${signal.id}: ${result.error || 'Unknown error'}`);
      return {
        success: false,
        status: 'FAILED',
        reason: result.error || 'Failed to deliver message via Telegram Bot API',
      };
    }
  }

  /**
   * Distinguishes between:
   * 1. NO SETUP FOUND -> Suppress Telegram notification (returns false)
   * 2. REAL SETUP FOUND BUT REJECTED/BLOCKED -> Allow Telegram notification (returns true)
   *
   * Suppresses generic/uninformative NO TRADE notifications (neutral/ranging market conditions,
   * missing general confirmation, or simply that no valid setup exists).
   * Keeps sending notifications when a real, specific technical setup was evaluated
   * but rejected/blocked (e.g., Bullish/Bearish Order Block, FVG, Liquidity Sweep,
   * Fibonacci/OTE, Trend Continuation, Max Loss exceeded, minimum lot not executable,
   * SL constraints violated, RR validation failed, or risk rules).
   */
  public shouldSendNoTradeNotification(
    reason: string = '',
    signalDetails?: Partial<TradeSignal>
  ): boolean {
    const rawSetup = (signalDetails?.setup || '').trim();
    const cleanReason = (reason || '').trim();
    const lowerReason = cleanReason.toLowerCase();
    const lowerSetup = rawSetup.toLowerCase();

    // =========================================================================
    // 1. Unconditional exclusions: No signal metadata, capital guard, scan failures
    // =========================================================================
    if (
      !signalDetails ||
      lowerSetup === 'capital_guard_block' ||
      lowerSetup === 'scan_failed'
    ) {
      return false;
    }

    // =========================================================================
    // 2. Identify specific named technical setups from setup metadata (S1-S13)
    // =========================================================================
    const hasOrderBlock =
      lowerSetup.includes('order block') ||
      lowerSetup.includes('orderblock') ||
      lowerSetup.includes('ob bounce') ||
      lowerSetup.includes('ob rejection') ||
      lowerSetup.includes('ob retest') ||
      lowerSetup.includes('أوردر بلوك');

    const hasFvg =
      lowerSetup.includes('fvg') ||
      lowerSetup.includes('fair value gap') ||
      lowerSetup.includes('imbalance') ||
      lowerSetup.includes('فجوة سعرية');

    const hasLiquiditySweep =
      (lowerSetup.includes('liquidity sweep') ||
        lowerSetup.includes('ssl sweep') ||
        lowerSetup.includes('bsl sweep') ||
        lowerSetup.includes('turtle soup') ||
        lowerSetup.includes('sweep reversal') ||
        lowerSetup.includes('سحب سيولة')) &&
      !lowerSetup.includes('ranging');

    const hasFibonacciOte =
      lowerSetup.includes('fibonacci') ||
      lowerSetup.includes('ote') ||
      lowerSetup.includes('golden pocket') ||
      lowerSetup.includes('فيبوناتشي');

    const hasTrendContinuation =
      lowerSetup.includes('trend continuation') ||
      lowerSetup.includes('continuation pullback') ||
      lowerSetup.includes('ema pullback') ||
      lowerSetup.includes('استمرار الاتجاه');

    const hasMeanReversion =
      lowerSetup.includes('mean reversion') ||
      lowerSetup.includes('rsi extreme') ||
      lowerSetup.includes('bollinger extreme');

    const hasStructureBreak =
      lowerSetup.includes('bos') ||
      lowerSetup.includes('choch') ||
      lowerSetup.includes('structure break') ||
      lowerSetup.includes('breaker block') ||
      lowerSetup.includes('mitigation block') ||
      lowerSetup.includes('كسر هيكل');

    const hasDoubleTopBottom =
      lowerSetup.includes('double top') ||
      lowerSetup.includes('double bottom') ||
      lowerSetup.includes('m-formation') ||
      lowerSetup.includes('w-formation') ||
      lowerSetup.includes('قمة مزدوجة') ||
      lowerSetup.includes('قاع مزدوج');

    const hasBareSr =
      lowerSetup.includes('bare resistance') ||
      lowerSetup.includes('bare support') ||
      lowerSetup.includes('bare s/r') ||
      lowerSetup.includes('s/r rejection') ||
      lowerSetup.includes('رفض مقاومة') ||
      lowerSetup.includes('رفض دعم');

    const hasBreakAndRetest =
      lowerSetup.includes('breakout & retest') ||
      lowerSetup.includes('breakout and retest') ||
      lowerSetup.includes('horizontal resistance breakout') ||
      lowerSetup.includes('horizontal support breakout') ||
      lowerSetup.includes('إعادة اختبار');

    const hasStructureEngulfing =
      lowerSetup.includes('bullish engulfing') ||
      lowerSetup.includes('bearish engulfing') ||
      lowerSetup.includes('engulfing reversal') ||
      lowerSetup.includes('ابتلاع شرائي') ||
      lowerSetup.includes('ابتلاع بيعي');

    const isNamedTechnicalSetup =
      hasOrderBlock ||
      hasFvg ||
      hasLiquiditySweep ||
      hasFibonacciOte ||
      hasTrendContinuation ||
      hasMeanReversion ||
      hasStructureBreak ||
      hasDoubleTopBottom ||
      hasBareSr ||
      hasBreakAndRetest ||
      hasStructureEngulfing;

    if (isNamedTechnicalSetup) {
      return true; // REAL NAMED TECHNICAL SETUP DETECTED AND EVALUATED, BUT REJECTED -> SEND
    }

    // =========================================================================
    // 3. Check if an actual evaluated trade candidate existed
    //    A real trade candidate MUST have non-zero SL distance (slPoints > 0)
    //    or distinct entry and stop-loss levels.
    // =========================================================================
    const slPoints = typeof signalDetails.slPoints === 'number' ? signalDetails.slPoints : 0;
    const hasEvaluatedTrade =
      slPoints > 0 ||
      (typeof signalDetails.entry === 'number' &&
        typeof signalDetails.stopLoss === 'number' &&
        signalDetails.entry > 0 &&
        signalDetails.stopLoss > 0 &&
        Math.abs(signalDetails.entry - signalDetails.stopLoss) > 0.01);

    // If an actionable signal was generated (e.g. BUY NOW / SELL NOW) but rejected
    // due to confidence falling below the required minimum threshold:
    const isActionableSignalRejected = Boolean(
      signalDetails.signal && signalDetails.signal !== 'NO TRADE'
    );
    if (isActionableSignalRejected) {
      return true;
    }

    // If no candidate trade was formed/evaluated (slPoints === 0 and entry === stopLoss),
    // this is 100% a generic market scan cycle (no setup / ranging / neutral) -> DO NOT SEND.
    if (!hasEvaluatedTrade) {
      return false;
    }

    // =========================================================================
    // 4. Candidate trade was evaluated (hasEvaluatedTrade === true) but rejected
    //    by specific risk management, executability, or mathematical constraints
    // =========================================================================
    const isMaxLossBlock =
      Boolean(signalDetails.positionSizing?.nonExecutableReason?.toLowerCase().includes('max loss')) ||
      Boolean(signalDetails.nonExecutableReason?.toLowerCase().includes('max loss')) ||
      lowerReason.includes('max loss') ||
      cleanReason.includes('سقف الخسارة');

    const isMinLotBlock =
      signalDetails.isExecutable === false ||
      signalDetails.positionSizing?.isExecutable === false ||
      lowerReason.includes('minimum lot') ||
      lowerReason.includes('minimum broker lot');

    const isSlConstraintsBlock =
      slPoints < 35 ||
      slPoints > 65 ||
      lowerReason.includes('sl constraints') ||
      cleanReason.includes('الـstop loss المطلوب') ||
      cleanReason.includes('الحد الأدنى المسموح للذهب') ||
      cleanReason.includes('الحد الأقصى المسموح للذهب');

    const isRrValidationBlock =
      (typeof signalDetails.tp1Rr === 'number' && signalDetails.tp1Rr > 0 && signalDetails.tp1Rr < 1.5) ||
      lowerReason.includes('rr validation') ||
      cleanReason.includes('نسبة العائد إلى المخاطرة للهدف');

    if (isMaxLossBlock || isMinLotBlock || isSlConstraintsBlock || isRrValidationBlock) {
      return true; // REAL TRADE EVALUATED BUT BLOCKED BY RISK / LIMITS -> SEND
    }

    // Default: Any unconfirmed or generic condition -> Suppress from Telegram
    return false;
  }

  /**
   * Formats and dispatches a NO TRADE notification to Telegram with deduplication.
   * Suppresses generic "no setup" notifications while sending real setups that were rejected or blocked.
   * NO TRADE notifications do NOT receive inline buttons (Requirement 9)
   */
  public async sendNoTradeNotification(
    scanId: string,
    reason: string,
    timestamp: number = Date.now(),
    analysisPrice?: number,
    signalDetails?: Partial<TradeSignal>
  ): Promise<{
    success: boolean;
    status: 'NOT_ATTEMPTED' | 'SUPPRESSED' | 'SENT' | 'FAILED';
    reason?: string;
    messageId?: number;
  }> {
    // Suppress generic/uninformative NO TRADE notifications where no actual trade setup was identified
    if (!this.shouldSendNoTradeNotification(reason, signalDetails)) {
      const suppReason = `Suppressed generic NO TRADE notification (no setup found) for scan ${scanId}: "${reason.substring(0, 80)}..."`;
      console.log(`[TELEGRAM] ${suppReason}`);
      return { success: false, status: 'SUPPRESSED', reason: suppReason };
    }

    if (this.sentNotificationIds.has(scanId)) {
      const suppReason = `Skipping duplicate NO TRADE notification for ${scanId}`;
      console.log(`[TELEGRAM] ${suppReason}`);
      return { success: false, status: 'SUPPRESSED', reason: suppReason };
    }

    const message = this.formatNoTradeMessage(reason, timestamp, analysisPrice, signalDetails);
    const result = await this.sendTelegramMessage(message);

    if (result.success) {
      this.sentNotificationIds.add(scanId);
      this.persistSentIds();
      return {
        success: true,
        status: 'SENT',
        messageId: result.messageId,
      };
    } else {
      console.warn(`[TELEGRAM] Failed to dispatch NO TRADE notification for scan ${scanId}: ${result.error || 'Unknown error'}`);
      return {
        success: false,
        status: 'FAILED',
        reason: result.error || 'Failed to deliver NO TRADE message via Telegram Bot API',
      };
    }
  }

  /**
   * Formats and dispatches a SCAN ERROR notification to Telegram with deduplication
   * Error notifications do NOT receive inline buttons (Requirement 9)
   */
  public async sendErrorNotification(
    scanId: string,
    error: string,
    timestamp: number = Date.now(),
    analysisPrice?: number
  ): Promise<{
    success: boolean;
    status: 'NOT_ATTEMPTED' | 'SUPPRESSED' | 'SENT' | 'FAILED';
    reason?: string;
    messageId?: number;
  }> {
    if (this.sentNotificationIds.has(scanId)) {
      const suppReason = `Skipping duplicate ERROR notification for ${scanId}`;
      console.log(`[TELEGRAM] ${suppReason}`);
      return { success: false, status: 'SUPPRESSED', reason: suppReason };
    }

    const message = this.formatErrorMessage(error, timestamp, analysisPrice);
    const result = await this.sendTelegramMessage(message);

    if (result.success) {
      this.sentNotificationIds.add(scanId);
      this.persistSentIds();
      return {
        success: true,
        status: 'SENT',
        messageId: result.messageId,
      };
    } else {
      console.warn(`[TELEGRAM] Failed to dispatch ERROR notification for scan ${scanId}: ${result.error || 'Unknown error'}`);
      return {
        success: false,
        status: 'FAILED',
        reason: result.error || 'Failed to deliver ERROR message via Telegram Bot API',
      };
    }
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

    // Handle incoming direct messages (e.g. /start, /id, or manual P&L entry from user)
    if (update.message) {
      const msg = update.message;
      const fromChatId = msg.chat?.id;
      const fromUserId = msg.from?.id ? String(msg.from.id).trim() : null;
      const fromUser = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'User');
      const text = String(msg.text || '').trim();

      if (fromChatId) {
        this.persistDetectedChat(fromChatId);
        console.log(`[TELEGRAM] Direct message received from chat_id=${fromChatId} (${fromUser}): "${text}"`);

        // Check if there is an active pending outcome prompt for this user/chat
        const pendingKey = fromUserId || String(fromChatId);
        const pending = this.pendingOutcomes.get(pendingKey) || this.pendingOutcomes.get(String(fromChatId));

        if (pending && pending.status === 'PENDING' && text && !text.startsWith('/')) {
          // Check authorization for recording outcomes
          if (!isTelegramUserAuthorized(fromUserId)) {
            await this.sendTelegramMessage('⚠️ غير مصرح لك بتسجيل النتيجة لهذا الحساب.');
            return { handled: true, error: 'UNAUTHORIZED' };
          }

          let calculatedPnl: number | null = null;
          let calculatedExitPrice: number | undefined = undefined;

          // Normalize safely: trim, remove leading $, and whitespace
          const cleanText = text.replace(/[\$,\s]/g, '').trim();
          const isNumeric = /^[+-]?\d+(?:\.\d+)?$/.test(cleanText);
          const parsedNum = isNumeric ? parseFloat(cleanText) : NaN;

          if (!isNumeric || isNaN(parsedNum)) {
            await this.sendTelegramMessage([
              `❌ Invalid P&L value.`,
              `Please enter a USD amount, for example:`,
              `17.78`,
              `or`,
              `-4.00`
            ].join('\n'));
            return { handled: true, error: 'INVALID_NUMBER_FORMAT' };
          }

          calculatedPnl = parsedNum;

          // Strict Sign and Zero Validation
          if (pending.outcome === 'WIN') {
            if (calculatedPnl <= 0) {
              await this.sendTelegramMessage([
                `❌ Invalid P&L value for a WIN.`,
                `Please enter a positive value greater than zero, for example:`,
                `17.78`
              ].join('\n'));
              return { handled: true, error: 'SIGN_VALIDATION_FAILED' };
            }
          } else if (pending.outcome === 'LOSS') {
            if (calculatedPnl >= 0) {
              await this.sendTelegramMessage([
                `❌ Invalid P&L value for a LOSS.`,
                `Please enter a negative value less than zero, for example:`,
                `-4.00`
              ].join('\n'));
              return { handled: true, error: 'SIGN_VALIDATION_FAILED' };
            }
          }

          calculatedPnl = Number(calculatedPnl.toFixed(2));

          // Set status COMPLETED and delete active chat/user pointers instantly to prevent concurrent/duplicate updates
          pending.status = 'COMPLETED';
          this.pendingOutcomes.set(pending.signalId, pending);
          if (fromUserId) this.pendingOutcomes.delete(fromUserId);
          this.pendingOutcomes.delete(String(fromChatId));
          this.persistPendingOutcomes();

          const outcomeRecord: TradeOutcomeRecord = {
            signalId: pending.signalId,
            tradeId: pending.tradeId,
            direction: pending.direction,
            orderType: pending.orderType,
            entry: pending.entry,
            stopLoss: pending.stopLoss,
            tp1: pending.tp1,
            tp2: pending.tp2,
            outcome: pending.outcome,
            realizedPnl: calculatedPnl,
            exitPrice: calculatedExitPrice ?? (pending.outcome === 'WIN' ? pending.tp1 : pending.stopLoss),
            source: 'TELEGRAM_CALLBACK', // 'TELEGRAM_CALLBACK' is verified by accountingTests.ts
            closedAt: Date.now(),
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            chatId: pending.chatId,
            userId: fromUserId ? Number(fromUserId) : undefined,
          };

          const signal = storage.getSignal(pending.signalId);
          const saveResult = storage.recordTradeOutcome(outcomeRecord, signal);

          const formattedPnl = calculatedPnl >= 0 ? `+$${calculatedPnl.toFixed(2)}` : `-$${Math.abs(calculatedPnl).toFixed(2)}`;

          // Edit original message markup if available
          if (pending.chatId && pending.messageId) {
            const outcomeHeader = `النتيجة: ${pending.outcome === 'WIN' ? '🟢 رابحة' : '🔴 خاسرة'} (${formattedPnl})`;
            const updatedText = pending.originalText.includes('النتيجة:')
              ? pending.originalText
              : `${pending.originalText}\n\n━━━━━━━━━━━━━━━\n${outcomeHeader}`;

            await this.editTelegramMessage(
              pending.chatId,
              pending.messageId,
              updatedText,
              [[{ text: outcomeHeader, callback_data: `noop:${pending.signalId}` }]]
            );
          }

          // Exact required format from Section 10:
          const receiptMsg = [
            `✅ REALIZED P&L RECORDED`,
            ``,
            `Trade: ${pending.tradeId}`,
            `Result: ${pending.outcome}`,
            `Realized P&L: ${formattedPnl}`,
            `Source: Telegram Manual Entry`,
            ``,
            `Account balance updated.`
          ].join('\n');

          await this.sendTelegramMessage(receiptMsg);
          return { handled: true, result: `RECORDED_${pending.outcome}_PNL_${calculatedPnl}` };
        }

        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (token && text.startsWith('/')) {
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
            return { handled: true, result: 'WELCOME_SENT' };
          } catch (replyErr) {
            console.error('[TELEGRAM] Failed to auto-reply to incoming message:', replyErr);
          }
        }
      }
      return { handled: false };
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

    // Check for already finalized button clicks or info buttons
    if (rawData.startsWith('noop:') || rawData.startsWith('recorded:')) {
      const recordedSignalId = rawData.split(':')[1] || '';
      const existing = storage.getTradeOutcome(recordedSignalId);
      const label = existing ? (existing.outcome === 'WIN' ? '🟢 رابحة' : '🔴 خاسرة') : 'مسجلة';
      await this.answerCallbackQuery(callbackId, `تم توثيق نتيجة هذه الصفقة بالفعل: ${label}`, false);
      return { handled: true, result: 'ALREADY_DOCUMENTED' };
    }

    if (rawData.startsWith('noop_wait:')) {
      await this.answerCallbackQuery(callbackId, '✍️ اكتب قيمة الربح/الخسارة الفعلية بالدولار كرسالة في المحادثة (مثال: 17.50)', true);
      return { handled: true, result: 'WAITING_FOR_TEXT_INPUT' };
    }

    // Security check: Verify authorized user for recording trade outcomes
    const senderUserId = cq.from?.id ? String(cq.from.id).trim() : null;
    const isAuthorized = isTelegramUserAuthorized(senderUserId);

    if (!isAuthorized) {
      console.warn(`[TELEGRAM] Unauthorized outcome button click: user_id=${senderUserId || 'UNKNOWN'}, chat_id=${chatId}`);
      await this.answerCallbackQuery(callbackId, '⚠️ غير مصرح لك بتسجيل النتيجة لهذا الحساب.', true);
      return { handled: true, error: 'UNAUTHORIZED' };
    }

    // Handle Quick P&L option click: out_pnl:<signalId>:<win|loss>:<pnl>:<exitPrice>
    const pnlMatch = rawData.match(/^out_pnl:([a-zA-Z0-9_\-]+):(win|loss):([\-0-9\.]+):([0-9\.]+)$/i);
    if (pnlMatch) {
      const signalId = pnlMatch[1];
      const action = pnlMatch[2].toLowerCase() as 'win' | 'loss';
      const pnlValue = parseFloat(pnlMatch[3]);
      const exitPriceValue = parseFloat(pnlMatch[4]);
      const signal = storage.getSignal(signalId);
      const outcome: 'WIN' | 'LOSS' = action === 'win' ? 'WIN' : 'LOSS';

      const outcomeRecord: TradeOutcomeRecord = {
        signalId,
        tradeId: signal?.id || signalId,
        direction: signal?.signal || 'BUY NOW',
        orderType: 'MARKET',
        entry: signal?.entry ?? 0,
        stopLoss: signal?.stopLoss ?? 0,
        tp1: signal?.tp1 ?? 0,
        tp2: signal?.tp2 ?? 0,
        outcome,
        realizedPnl: pnlValue,
        exitPrice: exitPriceValue,
        source: 'MANUAL',
        closedAt: Date.now(),
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
        chatId: chatId,
        userId: cq.from?.id,
      };

      const saveResult = storage.recordTradeOutcome(outcomeRecord, signal);
      const formattedPnl = pnlValue >= 0 ? `+$${pnlValue.toFixed(2)}` : `-$${Math.abs(pnlValue).toFixed(2)}`;
      const outcomeHeader = `النتيجة: ${outcome === 'WIN' ? '🟢 رابحة' : '🔴 خاسرة'} (${formattedPnl})`;

      await this.answerCallbackQuery(callbackId, `✅ تم تسجيل النتيجة (${formattedPnl}) بنجاح!`, false);

      if (chatId && messageId) {
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

      if (senderUserId) this.pendingOutcomes.delete(senderUserId);
      if (chatId) this.pendingOutcomes.delete(String(chatId));

      return { handled: true, result: `RECORDED_${outcome}_QUICK` };
    }

    // Validate initial button click format: out:(win|loss):<signalId>
    const match = rawData.match(/^out:(win|loss):([a-zA-Z0-9_\-]+)$/i);
    if (!match) {
      return { handled: false, error: 'INVALID_CALLBACK_DATA' };
    }

    const action = match[1].toLowerCase() as 'win' | 'loss';
    const signalId = match[2];

    // Check for existing recorded outcome
    const existingOutcome = storage.getTradeOutcome(signalId);
    if (existingOutcome) {
      const existingArabic = existingOutcome.outcome === 'WIN' ? '🟢 رابحة' : '🔴 خاسرة';
      const existingPnl = typeof existingOutcome.realizedPnl === 'number' ? ` (${existingOutcome.realizedPnl >= 0 ? '+' : ''}$${existingOutcome.realizedPnl.toFixed(2)})` : '';
      await this.answerCallbackQuery(
        callbackId,
        `⚠️ تم تسجيل هذه الصفقة مسبقاً: ${existingArabic}${existingPnl}.`,
        true
      );

      if (chatId && messageId) {
        await this.editTelegramMessageReplyMarkup(chatId, messageId, [
          [{ text: `النتيجة: ${existingArabic}${existingPnl}`, callback_data: `noop:${signalId}` }],
        ]);
      }
      return { handled: true, result: 'ALREADY_RECORDED' };
    }

    // Retrieve signal details
    const signal = storage.getSignal(signalId);
    const outcome: 'WIN' | 'LOSS' = action === 'win' ? 'WIN' : 'LOSS';

    const isBuy = /BUY/i.test(originalText) || (signal?.signal && signal.signal.includes('BUY'));
    const isLimit = /LIMIT/i.test(originalText);
    const parsedEntry = parseFloat((originalText.match(/(?:📍\s*(?:Limit\s+)?Entry|Entry).*?:\s*\$?([\d\.]+)/i) || [])[1]) || 0;
    const parsedSl = parseFloat((originalText.match(/(?:🛑\s*(?:Stop\s+Loss|SL)|Stop\s+Loss|SL).*?:\s*\$?([\d\.]+)/i) || [])[1]) || 0;
    const parsedTp1 = parseFloat((originalText.match(/(?:🎯\s*TP1|TP1).*?:\s*\$?([\d\.]+)/i) || [])[1]) || 0;
    const parsedTp2 = parseFloat((originalText.match(/(?:🎯\s*TP2|TP2).*?:\s*\$?([\d\.]+)/i) || [])[1]) || 0;

    const entry = signal?.entry ?? parsedEntry;
    const tp1 = signal?.tp1 ?? parsedTp1;
    const tp2 = signal?.tp2 ?? parsedTp2;
    const sl = signal?.stopLoss ?? parsedSl;
    const lotSize = signal?.recommendedLotSize || (signal as any)?.lotSize || 0.01;

    // Real physical dollar calculations for Gold contract: 1 lot = 100 oz ($100 per 1.00 move)
    const tp1ProfitUsd = Number((Math.abs(tp1 - entry) * 100 * lotSize).toFixed(2));
    const tp2ProfitUsd = Number((Math.abs(tp2 - entry) * 100 * lotSize).toFixed(2));
    const slLossUsd = Number((Math.abs(sl - entry) * 100 * lotSize).toFixed(2));

    const pendingItem: PendingTelegramOutcome = {
      signalId,
      tradeId: signal?.id || signalId,
      direction: signal?.signal || (isBuy ? (isLimit ? 'BUY LIMIT' : 'BUY NOW') : (isLimit ? 'SELL LIMIT' : 'SELL NOW')),
      orderType: isLimit ? (isBuy ? 'BUY LIMIT' : 'SELL LIMIT') : 'MARKET',
      entry,
      stopLoss: sl,
      tp1,
      tp2,
      outcome,
      lotSize,
      chatId: chatId || 0,
      userId: senderUserId || undefined,
      messageId,
      originalText,
      timestamp: Date.now(),
      createdAt: Date.now(),
      status: 'PENDING',
    };

    this.pendingOutcomes.set(signalId, pendingItem);
    if (senderUserId) this.pendingOutcomes.set(senderUserId, pendingItem);
    if (chatId) this.pendingOutcomes.set(String(chatId), pendingItem);
    this.persistPendingOutcomes();

    if (outcome === 'WIN') {
      await this.answerCallbackQuery(callbackId, '🟢 Please enter the ACTUAL realized P&L in USD.', false);

      const promptKeyboard = [
        [
          { text: '✍️ Please enter P&L in USD', callback_data: `noop_wait:${signalId}` },
        ],
      ];

      if (chatId && messageId) {
        await this.editTelegramMessageReplyMarkup(chatId, messageId, promptKeyboard);
        await this.sendTelegramMessage([
          `Please enter the ACTUAL realized P&L in USD.`,
          `Example: 17.78`,
          `For a loss, enter: -4.00`
        ].join('\n'));
      }
    } else {
      await this.answerCallbackQuery(callbackId, '🔴 Please enter the ACTUAL realized P&L in USD.', false);

      const promptKeyboard = [
        [
          { text: '✍️ Please enter P&L in USD', callback_data: `noop_wait:${signalId}` },
        ],
      ];

      if (chatId && messageId) {
        await this.editTelegramMessageReplyMarkup(chatId, messageId, promptKeyboard);
        await this.sendTelegramMessage([
          `Please enter the ACTUAL realized P&L in USD.`,
          `Example: 17.78`,
          `For a loss, enter: -4.00`
        ].join('\n'));
      }
    }

    console.log(`[TELEGRAM] Outcome prompt initiated for signal ${signalId}: ${outcome} (Manual P&L Input Only)`);
    return { handled: true, result: `PROMPTED_${outcome}` };
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
   * Format for BUY NOW / SELL NOW / BUY LIMIT / SELL LIMIT signals
   * Dynamically includes real XAU/USD price at analysis moment and analysis reasons
   */
  private formatSignalMessage(signal: TradeSignal): string {
    const sUpper = signal.signal.toUpperCase();
    const isBuy = sUpper.includes('BUY');
    const isLimit = sUpper.includes('LIMIT');

    const emoji = isBuy ? '🟢' : '🔴';
    let typeHeader = '';
    let entryLabel = '📍 Entry';

    if (isLimit) {
      if (isBuy) {
        typeHeader = 'BUY LIMIT';
        entryLabel = '📍 Limit Entry';
      } else {
        typeHeader = 'SELL LIMIT';
        entryLabel = '📍 Limit Entry';
      }
    } else {
      typeHeader = isBuy ? 'BUY NOW' : 'SELL NOW';
      entryLabel = '📍 Entry';
    }

    const title = `${emoji} ${typeHeader}`;
    const analysisPrice = typeof signal.currentPrice === 'number' && !isNaN(signal.currentPrice) && signal.currentPrice > 0
      ? signal.currentPrice.toFixed(2)
      : 'N/A';

    const entryFormatted = typeof signal.entry === 'number' ? `$${signal.entry.toFixed(2)}` : signal.entry;
    const slPts = signal.slPoints ? ` (${signal.slPoints} pts)` : '';
    const slFormatted = typeof signal.stopLoss === 'number' ? `$${signal.stopLoss.toFixed(2)}${slPts}` : signal.stopLoss;
    const tp1Formatted = typeof signal.tp1 === 'number' ? `$${signal.tp1.toFixed(2)}` : signal.tp1;
    const tp2Formatted = signal.tp2 && signal.tp2 > 0 ? (typeof signal.tp2 === 'number' ? `$${signal.tp2.toFixed(2)}` : signal.tp2) : 'N/A';

    const riskPercent = signal.riskPercent ? `${signal.riskPercent}%` : 'N/A';
    const riskAmount = typeof signal.riskAmount === 'number' ? `$${signal.riskAmount.toFixed(2)}` : 'N/A';
    const tp1Rr = signal.tp1RrString || (signal.tp1Rr ? `1:${signal.tp1Rr.toFixed(2)}` : '1:1.50');
    const tp2Rr = signal.tp2RrString || (signal.tp2Rr ? `1:${signal.tp2Rr.toFixed(2)}` : 'N/A');
    const overallRr = signal.rr || (tp2Formatted !== 'N/A' ? `TP1: ${tp1Rr} | TP2: ${tp2Rr}` : tp1Rr);
    const confidence = signal.confidence ? `${signal.confidence}%` : 'N/A';

    const reasonsList =
      signal.mainReasons && signal.mainReasons.length > 0
        ? signal.mainReasons.map((r) => `• ${r}`).join('\n')
        : `• ${signal.setup || 'تأكيد الهيكل الفني وسلوك السعر'}`;

    const invalidation = signal.invalidation && signal.invalidation !== 'N/A' ? signal.invalidation : null;
    const timeFormatted = `${new Date(signal.timestamp || Date.now()).toISOString().replace('T', ' ').substring(0, 19)} UTC`;

    const lines: string[] = [
      title,
      `💰 السعر وقت التحليل: ${analysisPrice}`,
      `${entryLabel}: ${entryFormatted}`,
      `🛑 Stop Loss: ${slFormatted}`,
      `🎯 TP1: ${tp1Formatted} (عائد ${tp1Rr})`,
      `🎯 TP2: ${tp2Formatted}${tp2Formatted !== 'N/A' ? ` (عائد ${tp2Rr})` : ''}`,
      `⚖️ Risk: ${riskPercent} (${riskAmount})`,
      `📈 RR: ${overallRr}`,
      `📊 Confidence: ${confidence}`,
    ];

    if (signal.setup && signal.setup !== 'None' && signal.setup !== 'No Setup') {
      lines.push(`📐 Setup: ${signal.setup}`);
    }

    if (signal.executionQualityScore !== undefined && signal.executionQualityScore > 0) {
      lines.push(`⚡ Execution Quality: ${signal.executionQualityScore}/100 [Timing: ${signal.entryTiming || 'N/A'} | State: ${signal.setupFreshness || 'FRESH'} | Runway: ${signal.tpRunway || 'CLEAR'}]`);
    }

    lines.push('', '🧠 الأسباب:', reasonsList);

    if (invalidation) {
      lines.push('', '⚠️ شروط الإلغاء / المخاطرة:', invalidation);
    }

    lines.push('', `⏱️ وقت الفحص: ${timeFormatted}`);

    return lines.join('\n');
  }

  /**
   * Format for NO TRADE / REJECTED
   * Dynamically formats rejection reasons from actual scanner / AI analysis
   */
  private formatNoTradeMessage(
    reason: string,
    timestamp: number,
    analysisPrice?: number,
    signalDetails?: Partial<TradeSignal>
  ): string {
    const timeFormatted = `${new Date(timestamp).toISOString().replace('T', ' ').substring(0, 19)} UTC`;

    // Real XAU/USD market price at the exact moment of the scan
    const priceValue = typeof analysisPrice === 'number' && !isNaN(analysisPrice) && analysisPrice > 0
      ? analysisPrice
      : (typeof signalDetails?.currentPrice === 'number' && signalDetails.currentPrice > 0
          ? signalDetails.currentPrice
          : null);
    const priceFormatted = priceValue !== null ? priceValue.toFixed(2) : 'N/A';

    // Determine the nature of rejection
    const rawSetup = signalDetails?.setup?.trim();
    const lowerSetup = (rawSetup || '').toLowerCase();
    const isGenericSetupName =
      !rawSetup ||
      lowerSetup === 'none' ||
      lowerSetup === 'no setup' ||
      lowerSetup === 'no_setup' ||
      lowerSetup === 'market structure ranging' ||
      lowerSetup === 'ranging market' ||
      lowerSetup === 'neutral' ||
      lowerSetup === 'capital_guard_block' ||
      lowerSetup === 'scan_failed';

    const hasSpecificSetup =
      !isGenericSetupName &&
      !lowerSetup.includes('ranging') &&
      !lowerSetup.includes('no trade') &&
      !lowerSetup.includes('no setup');

    const isConfidenceFailure =
      reason.includes('نسبة الثقة') ||
      reason.includes('Confidence');

    const isRiskFailure =
      reason.includes('Risk') ||
      reason.includes('RR') ||
      reason.includes('مخاطر') ||
      reason.includes('وقف الخسارة') ||
      reason.toLowerCase().includes('max loss') ||
      reason.includes('سقف الخسارة') ||
      reason.toLowerCase().includes('minimum lot') ||
      reason.includes('أقل لوت') ||
      reason.toLowerCase().includes('sl constraints');

    let statusLine = '❌ لا توجد فرصة تداول حالياً';
    if (hasSpecificSetup) {
      statusLine = `❌ تم رفض الإعداد: ${rawSetup}`;
    } else if (isRiskFailure) {
      statusLine = '🛡️ حظر الصفقة: قواعد إدارة المخاطر';
    } else if (isConfidenceFailure) {
      statusLine = '❌ تم رفض الإعداد (ضعف نسبة التأكيد)';
    } else if (rawSetup === 'CAPITAL_GUARD_BLOCK') {
      statusLine = '🛡️ حماية رأس المال: تم حظر التداول';
    }

    const lines: string[] = [
      '⚪ NO TRADE',
      `💰 السعر وقت التحليل: ${priceFormatted}`,
      statusLine,
      `🧠 السبب: ${reason || 'لا يوجد تأكيد هيكلي كافٍ بعد.'}`,
    ];

    // Additional dynamic details from analysis if available
    if (signalDetails?.mainReasons && signalDetails.mainReasons.length > 0) {
      const extraReasons = signalDetails.mainReasons.filter(
        (r) => r && r !== reason && !reason.includes(r)
      );
      if (extraReasons.length > 0) {
        lines.push('', '📋 ملاحظات التحليل:');
        extraReasons.forEach((r) => lines.push(`• ${r}`));
      }
    }

    if ((hasSpecificSetup || isConfidenceFailure) && typeof signalDetails?.confidence === 'number' && signalDetails.confidence > 0) {
      lines.push(`📊 نسبة الثقة: ${signalDetails.confidence}%`);
    }

    if (signalDetails?.invalidation && signalDetails.invalidation !== 'N/A') {
      lines.push(`⚠️ شرط الإبطال: ${signalDetails.invalidation}`);
    }

    lines.push('', `⏱️ الوقت: ${timeFormatted}`);

    return lines.join('\n');
  }

  /**
   * Format for SCAN ERROR
   */
  private formatErrorMessage(error: string, timestamp: number, analysisPrice?: number): string {
    const timeFormatted = `${new Date(timestamp).toISOString().replace('T', ' ').substring(0, 19)} UTC`;
    const priceFormatted = typeof analysisPrice === 'number' && !isNaN(analysisPrice) && analysisPrice > 0
      ? analysisPrice.toFixed(2)
      : 'N/A';

    return [
      '⚠️ XAU/USD — SCAN ERROR',
      `💰 السعر وقت التحليل: ${priceFormatted}`,
      '❌ تعذر استكمال فحص السوق',
      `🧠 السبب: ${error || 'خطأ غير معروف في الاتصال أو التحليل.'}`,
      '',
      `⏱️ الوقت: ${timeFormatted}`,
    ].join('\n');
  }
}

export const telegramService = new TelegramService();
export const sendTelegramMessage = (message: string, replyMarkup?: any) =>
  telegramService.sendTelegramMessage(message, replyMarkup);

/**
 * Retrieves the list of authorized Telegram user IDs for trade outcome recording.
 * Parses comma-separated user IDs from process.env.TELEGRAM_AUTHORIZED_USER_IDS,
 * normalizing whitespace and ignoring empty entries.
 * Safely falls back to TELEGRAM_CHAT_ID only if it represents a personal user ID (positive integer without '-' prefix).
 */
export function getAuthorizedTelegramUserIds(customEnv?: {
  TELEGRAM_AUTHORIZED_USER_IDS?: string;
  TELEGRAM_CHAT_ID?: string;
}): string[] {
  const envUserIds = customEnv ? customEnv.TELEGRAM_AUTHORIZED_USER_IDS : process.env.TELEGRAM_AUTHORIZED_USER_IDS;
  const envChatId = customEnv ? customEnv.TELEGRAM_CHAT_ID : process.env.TELEGRAM_CHAT_ID;

  const ids: string[] = [];

  if (envUserIds !== undefined && envUserIds !== null) {
    const parts = String(envUserIds).split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed && trimmed.length > 0) {
        ids.push(trimmed);
      }
    }
  }

  // Fallback: If no TELEGRAM_AUTHORIZED_USER_IDS are configured, check TELEGRAM_CHAT_ID.
  // CRITICAL: Group/Channel destination IDs (which begin with '-') MUST NEVER be treated as authorized user IDs.
  if (ids.length === 0 && envChatId) {
    const trimmedChatId = String(envChatId).trim();
    if (/^\d+$/.test(trimmedChatId)) {
      ids.push(trimmedChatId);
    }
  }

  return ids;
}

/**
 * Validates whether a Telegram user (by senderUserId) is authorized to record trade outcomes.
 */
export function isTelegramUserAuthorized(
  senderUserId: string | number | null | undefined,
  customEnv?: { TELEGRAM_AUTHORIZED_USER_IDS?: string; TELEGRAM_CHAT_ID?: string; TELEGRAM_BOT_TOKEN?: string }
): boolean {
  if (senderUserId === null || senderUserId === undefined) {
    return false;
  }
  const userStr = String(senderUserId).trim();
  if (!userStr || userStr.length === 0) {
    return false;
  }

  const authorizedIds = getAuthorizedTelegramUserIds(customEnv);

  // If specific authorized user IDs are configured or derived, strictly validate against them
  if (authorizedIds.length > 0) {
    return authorizedIds.includes(userStr);
  }

  // If neither TELEGRAM_AUTHORIZED_USER_IDS nor a user-based TELEGRAM_CHAT_ID is set:
  // If no Telegram bot or chat is configured at all, return true in local/unrestricted mode
  const botToken = customEnv ? customEnv.TELEGRAM_BOT_TOKEN : process.env.TELEGRAM_BOT_TOKEN;
  const chatId = customEnv ? customEnv.TELEGRAM_CHAT_ID : process.env.TELEGRAM_CHAT_ID;
  if (!botToken && !chatId) {
    return true;
  }

  return false;
}

