import { AssetType, ScannerConfig, SignalDecision, TradeSignal } from '../src/types.js';
import { analyzeTechnicals } from './indicators.js';
import { fetchCandles, fetchLiveQuote } from './marketData.js';
import { runAIAnalysis } from './geminiTrader.js';
import { BrokerContractSpecs } from './riskManager.js';
import { storage } from './storage.js';
import { mt5Bridge } from './mt5Bridge.js';
import { telegramService } from './telegram.js';
import { tradeMonitor } from './tradeMonitor.js';

class LiveMarketScanner {
  private config: ScannerConfig = {
    enabled: true,
    intervalSeconds: 60,
    intervalMinutes: 1,
    minConfidence: 75,
    telegramEnabled: true,
    lastScanTime: null,
    nextScanTime: null,
    lastScanStatus: 'جاهز - المسح المباشر التلقائي نشط كل 60 ثانية (Background Worker)',
    dataStatus: 'Biquote XAUUSD MT5 Feed (Connecting...)',
    lastDecision: null,
    lastSignal: null,
    isScanning: false,
    duplicatePrevented: false,
    activeSetupName: null,
    scanCount: 0,
  };

  private timer: NodeJS.Timeout | null = null;
  private currentBalance: number = 10;
  private losingStreak: number = 0;
  private brokerSpecs: Partial<BrokerContractSpecs> = {};
  private onSignalFoundCallback?: (signal: TradeSignal) => void;

  // Server-side worker telemetry
  private workerStartTime: number = Date.now();
  private lastMarketDataTimestamp: number | null = null;
  private biquoteConnectionStatus: string = 'INITIALIZING';

  // Active setup tracking for strict duplicate prevention
  private activeSignal: TradeSignal | null = null;
  private isScanRunning: boolean = false;
  private scanStartTime: number = 0;
  private lastKnownPrice: number = 0;

  constructor() {
    // Automatically start the server-side scanner background worker on creation
    setTimeout(() => {
      this.start();
    }, 1500);
  }

  public getConfig(): ScannerConfig {
    return { ...this.config };
  }

  public updateConfig(newConfig: Partial<ScannerConfig>): ScannerConfig {
    const wasEnabled = this.config.enabled;
    const oldInterval = this.config.intervalSeconds;

    this.config = { ...this.config, ...newConfig };

    // Ensure intervalSeconds is 60 by default or as configured
    if (newConfig.intervalSeconds) {
      this.config.intervalMinutes = Number((newConfig.intervalSeconds / 60).toFixed(1));
    } else if (newConfig.intervalMinutes) {
      this.config.intervalSeconds = Math.round(newConfig.intervalMinutes * 60);
    }

    if (!wasEnabled && this.config.enabled) {
      this.start();
    } else if (wasEnabled && !this.config.enabled) {
      this.stop();
    } else if (this.config.enabled && oldInterval !== this.config.intervalSeconds) {
      // Restart interval with new duration
      this.start();
    }

    return { ...this.config };
  }

  public setAccountContext(balance: number, losingStreak: number, brokerSpecs?: Partial<BrokerContractSpecs>) {
    this.currentBalance = balance;
    this.losingStreak = losingStreak;
    if (brokerSpecs) {
      this.brokerSpecs = brokerSpecs;
    }
  }

  public onSignal(callback: (signal: TradeSignal) => void) {
    this.onSignalFoundCallback = callback;
  }

  public start() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.config.enabled = true;
    const intervalSec = this.config.intervalSeconds || 60;
    this.config.nextScanTime = Date.now() + intervalSec * 1000;
    this.config.lastScanStatus = `المسح المباشر نشط في الخلفية (فحص تلقائي مستقل كل ${intervalSec} ثانية)`;
    console.log(`[SCANNER] started (interval: ${intervalSec}s for XAU/USD via Biquote)`);

    // Immediate initial scan
    this.runScan('XAU/USD');

    // Recurring scan every interval seconds (default: 60s)
    this.timer = setInterval(() => {
      console.log('[SCANNER] tick');
      this.runScan('XAU/USD');
    }, intervalSec * 1000);
  }

  public stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.config.enabled = false;
    this.config.nextScanTime = null;
    this.config.lastScanStatus = 'المسح الآلي متوقف مؤقتًا';
    console.log('[SCANNER] stopped');
  }

  /**
   * Core Live Scan Execution
   * Strictly uses Biquote XAUUSD as the ONLY market-data source
   * 1. Fetch current price
   * 2. Fetch 1H, 15M, and 5M OHLCV / tick-volume
   * 3. Calculate technical and market-structure indicators
   * 4. Analyze market via trading strategy
   * 5. Return exactly one decision: BUY NOW, SELL NOW, BUY LIMIT, SELL LIMIT, NO TRADE
   * 6. Prevent duplicate signals if same setup is still active
   * 7. Store every scan and every generated signal in persistent storage
   */
  public async runScan(asset: AssetType = 'XAU/USD'): Promise<TradeSignal | null> {
    if (this.isScanRunning) {
      const runningDuration = Date.now() - (this.scanStartTime || 0);
      if (runningDuration > 35000) {
        console.warn(`[SCANNER] Warning: Previous scan hung for ${runningDuration}ms. Resetting running lock.`);
        this.isScanRunning = false;
        this.config.isScanning = false;
      } else {
        console.log('[SCANNER] Scan already in progress, skipping concurrent call');
        return this.config.lastSignal || null;
      }
    }

    this.isScanRunning = true;
    this.scanStartTime = Date.now();
    this.config.isScanning = true;
    this.config.lastScanTime = Date.now();
    const intervalSec = this.config.intervalSeconds || 60;
    this.config.nextScanTime = Date.now() + intervalSec * 1000;
    console.log(`[SCANNER] scan started for ${asset}`);

    try {
      this.config.lastScanStatus = `جارٍ فحص الذهب XAU/USD مباشرة عبر Biquote MT5...`;

      // Step 1: Fetch live quote & current price from Biquote only
      const quote = await fetchLiveQuote(asset);
      const currentPrice = Number(quote.mid.toFixed(2));
      this.lastKnownPrice = currentPrice;
      this.lastMarketDataTimestamp = Date.now();
      this.biquoteConnectionStatus = `CONNECTED (Bid: ${quote.bid} / Ask: ${quote.ask})`;
      this.config.dataStatus = `Connected (Biquote MT5 Feed - Bid: ${quote.bid} / Ask: ${quote.ask})`;

      // Evaluate active open trades lifecycle against live quote
      tradeMonitor.evaluatePrice(currentPrice).catch((err) => {
        console.error('[LiveMarketScanner] Trade monitor evaluation error:', err);
      });

      // Step 2: Fetch 1H, 15M, and 5M (and 1M) OHLCV / tick-volume from Biquote only
      const [candles1h, candles15m, candles5m, candles1m] = await Promise.all([
        fetchCandles(asset, '1h', 500),
        fetchCandles(asset, '15m', 500),
        fetchCandles(asset, '5m', 500),
        fetchCandles(asset, '1m', 100),
      ]);

      console.log(`[SCANNER] market data loaded: price=${currentPrice}, 1h=${candles1h.length}, 15m=${candles15m.length}, 5m=${candles5m.length}`);

      // Step 3: Calculate required technical/market-structure data
      const ind1h = analyzeTechnicals(candles1h);
      const ind15m = analyzeTechnicals(candles15m);
      const ind5m = analyzeTechnicals(candles5m);

      // Check active signal status against live price (TP / SL reached)
      if (this.activeSignal && this.activeSignal.signal !== 'NO TRADE') {
        const isBuy = this.activeSignal.signal.includes('BUY');
        const slHit = isBuy
          ? currentPrice <= this.activeSignal.stopLoss
          : currentPrice >= this.activeSignal.stopLoss;
        const tp2Hit = isBuy
          ? currentPrice >= this.activeSignal.tp2
          : currentPrice <= this.activeSignal.tp2;

        if (slHit) {
          console.log(`[LiveMarketScanner] Active setup ${this.activeSignal.setup} hit Stop Loss. Resetting active setup.`);
          this.activeSignal = null;
          this.config.activeSetupName = null;
        } else if (tp2Hit) {
          console.log(`[LiveMarketScanner] Active setup ${this.activeSignal.setup} reached TP2. Resetting active setup.`);
          this.activeSignal = null;
          this.config.activeSetupName = null;
        }
      }

      // Step 4: Sync with global settings and evaluate activeCapital
      const settings = storage.getSettings();
      let activeCapital = settings.manualCapital;
      let isExecutionBlocked = false;
      let blockReason = '';

      if (settings.capitalSource === 'MT5') {
        const mt5Status = await mt5Bridge.getAccountStatus();
        if (mt5Status.connected && typeof mt5Status.balance === 'number' && mt5Status.balance > 0) {
          activeCapital = mt5Status.balance;
        } else {
          isExecutionBlocked = true;
          blockReason = 'MT5 / Broker is DISCONNECTED. Execution blocked (حساب MT5 غير متصل - تم حظر فتح صفقات جديدة).';
          activeCapital = 0;
        }
      } else if (activeCapital <= 0) {
        isExecutionBlocked = true;
        blockReason = 'Manual capital must be greater than $0.00. Execution blocked.';
      }

      this.currentBalance = activeCapital;
      this.brokerSpecs = {
        accountBalance: activeCapital,
        riskPercent: settings.riskPerTrade,
        contractSizeOz: settings.contractSizeOz,
        minimumLot: settings.minimumLot,
        maximumLot: settings.maximumLot,
        lotStep: settings.lotStep,
        minGoldSlPoints: settings.minGoldSlPoints ?? 40,
        maxGoldSlPoints: settings.maxGoldSlPoints ?? 50,
        minRr: settings.minTp1RR,
      };
      this.config.minConfidence = settings.minimumConfidence;

      if (isExecutionBlocked) {
        this.config.scanCount += 1;
        const noTradeSignal: TradeSignal = {
          id: `scan_${Date.now()}`,
          timestamp: Date.now(),
          asset,
          signal: 'NO TRADE',
          currentPrice,
          entry: currentPrice,
          stopLoss: currentPrice,
          slPoints: 0,
          tp1: currentPrice,
          tp1Points: 0,
          tp1Rr: 0,
          tp1RrString: '1:0',
          tp2: currentPrice,
          tp2Points: 0,
          tp2Rr: 0,
          tp2RrString: '1:0',
          primaryTarget: 'TP1',
          rr: '1:0',
          rrRatio: 0,
          riskPercent: 0,
          riskAmount: 0,
          potentialProfit: 0,
          potentialLoss: 0,
          recommendedLotSize: 0,
          confidence: 0,
          timeframe: '5M',
          setup: 'CAPITAL_GUARD_BLOCK',
          mainReasons: [blockReason],
          invalidation: 'N/A',
          noTradeReason: blockReason,
        };

        storage.saveScan({
          id: noTradeSignal.id,
          timestamp: Date.now(),
          isoTime: new Date().toISOString(),
          currentPrice,
          signal: 'NO TRADE',
          entry: currentPrice,
          stopLoss: currentPrice,
          slPoints: 0,
          tp1: currentPrice,
          tp1Points: 0,
          tp1Rr: '1:0',
          tp2: currentPrice,
          tp2Points: 0,
          tp2Rr: '1:0',
          rr: '1:0',
          confidence: 0,
          riskPercent: 0,
          riskAmount: 0,
          lotSize: 0,
          setup: 'CAPITAL_GUARD_BLOCK',
          reasons: [blockReason],
          status: 'NO TRADE',
          invalidation: 'N/A',
          noTradeReason: blockReason,
        });

        this.config.lastDecision = 'NO TRADE';
        this.config.lastSignal = noTradeSignal;
        this.config.lastScanStatus = blockReason;

        telegramService.sendNoTradeNotification(
          noTradeSignal.id,
          blockReason,
          noTradeSignal.timestamp,
          currentPrice,
          noTradeSignal
        ).catch((tgErr) => {
          console.error('[LiveMarketScanner] Telegram Capital Guard notification error:', tgErr?.message || tgErr);
        });

        return noTradeSignal;
      }

      // Step 5: Analyze market using existing trading strategy
      console.log('[SCANNER] AI analysis started');
      const signal = await runAIAnalysis({
        asset,
        balance: this.currentBalance,
        currentPrice,
        indicators1h: ind1h,
        indicators15m: ind15m,
        indicators5m: ind5m,
        candles1h,
        candles15m,
        recent5mCandles: candles5m,
        recent1mCandles: candles1m,
        losingStreak: this.losingStreak,
        brokerSpecs: this.brokerSpecs,
      });
      console.log('[SCANNER] AI analysis completed');
      console.log(`[SCANNER] result: ${signal.signal}`);

      this.config.scanCount += 1;

      // Check if an existing active setup is already ongoing
      const isSameSetupActive =
        this.activeSignal !== null &&
        signal.signal !== 'NO TRADE' &&
        this.activeSignal.signal === signal.signal &&
        (this.activeSignal.setup === signal.setup || Math.abs(this.activeSignal.entry - signal.entry) <= 1.5);

      // Status text for storage
      let scanResultStatus = 'NO TRADE';
      if (signal.signal !== 'NO TRADE') {
        scanResultStatus = isSameSetupActive ? 'DUPLICATE_ACTIVE' : 'QUALIFIED_SIGNAL';
      }

      const scanId = `scan_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

      // Step 7 & 8: Store EVERY scan in persistent storage with all 15 required fields
      storage.saveScan({
        id: scanId,
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
        currentPrice,
        signal: signal.signal,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        slPoints: signal.slPoints,
        tp1: signal.tp1,
        tp1Points: signal.tp1Points || 0,
        tp1Rr: signal.tp1RrString || (signal.tp1Rr ? `1:${signal.tp1Rr.toFixed(2)}` : '1:1.50'),
        tp2: signal.tp2,
        tp2Points: signal.tp2Points || 0,
        tp2Rr: signal.tp2RrString || (signal.tp2Rr ? `1:${signal.tp2Rr.toFixed(2)}` : '1:3.00'),
        rr: signal.rr,
        confidence: signal.confidence,
        riskPercent: signal.riskPercent,
        riskAmount: signal.riskAmount,
        lotSize: signal.standardLot ?? signal.recommendedLotSize,
        setup: signal.setup,
        reasons: signal.mainReasons,
        status: scanResultStatus,
        invalidation: signal.invalidation,
        noTradeReason: signal.noTradeReason,
      });
      console.log(`[SCANNER] history saved: ${signal.signal} (${scanResultStatus})`);

      // Step 5 & 6: Prevent duplicate signals if same setup is still active
      if (signal.signal !== 'NO TRADE' && signal.confidence >= this.config.minConfidence) {
        if (isSameSetupActive && this.activeSignal) {
          // DUPLICATE PREVENTED: Update status without generating a new signal or spamming alerts
          this.config.duplicatePrevented = true;
          this.config.lastDecision = this.activeSignal.signal;
          this.config.lastScanStatus = `الصفقة لا تزال جارية: ${this.activeSignal.signal} (${this.activeSignal.setup}) | السعر: $${currentPrice.toFixed(2)} [تم منع تكرار الإشارة]`;
          console.log(`[LiveMarketScanner] Same setup is still active: ${this.activeSignal.setup}. Duplicate signal prevented.`);

          // Keep current price updated on active signal
          this.activeSignal.currentPrice = currentPrice;
          this.config.lastSignal = this.activeSignal;
          return this.activeSignal;
        }

        // New genuine setup qualified!
        this.activeSignal = signal;
        this.config.activeSetupName = signal.setup;
        this.config.duplicatePrevented = false;
        this.config.lastDecision = signal.signal;
        this.config.lastSignal = signal;
        this.config.lastScanStatus = `تم رصد صفقة مؤكدة: ${signal.signal} (${signal.setup}) بنسبة ثقة ${signal.confidence}%`;
        console.log(`[LiveMarketScanner] New qualified signal detected: ${signal.signal} @ ${signal.entry}`);

        // Persist new qualified signal to disk
        storage.saveSignal(signal);

        // Auto-Trading execution bridge if enabled in settings
        const currentSettings = storage.getSettings();
        if (currentSettings.autoTradingEnabled) {
          console.log(`[LiveMarketScanner] Auto-trading is ENABLED. Routing order to MT5 Bridge (Mode: ${currentSettings.accountMode || 'DEMO'})...`);
          try {
            const todayStats = storage.getTodayStats();
            const orderRiskPct = signal.riskPercent || 15;
            if (todayStats.tradesCount < 3 && (todayStats.totalRiskPercentUsed + orderRiskPct) <= 30.0) {
              const lot = signal.standardLot ?? signal.recommendedLotSize ?? 0.01;
              let resolvedAction: 'BUY' | 'SELL' | 'BUY_LIMIT' | 'SELL_LIMIT' = 'BUY';
              const sUpper = signal.signal.toUpperCase();
              if (sUpper.includes('BUY LIMIT')) resolvedAction = 'BUY_LIMIT';
              else if (sUpper.includes('SELL LIMIT')) resolvedAction = 'SELL_LIMIT';
              else if (sUpper.includes('SELL')) resolvedAction = 'SELL';
              else resolvedAction = 'BUY';

              mt5Bridge.executeOrder({
                symbol: (signal.asset || 'XAUUSD').replace('/', ''),
                action: resolvedAction,
                lot: lot,
                price: signal.entry,
                stopLoss: signal.stopLoss,
                takeProfit: signal.tp1,
                takeProfit2: signal.tp2,
                comment: `AutoTrade ${currentSettings.accountMode || 'DEMO'}`,
                accountMode: currentSettings.accountMode || 'DEMO',
              }).then((bridgeRes) => {
                if (bridgeRes.success) {
                  const autoTradeId = bridgeRes.orderId || `autotrade_${Date.now()}`;
                  storage.saveTrade({
                    id: signal.id,
                    tradeNumber: (storage.getTrades(1)[0]?.tradeNumber || 0) + 1,
                    date: new Date().toLocaleDateString('ar-EG', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                    isoTime: new Date().toISOString(),
                    asset: 'XAU/USD',
                    direction: signal.signal as any,
                    entry: bridgeRes.executionPrice || signal.entry,
                    sl: signal.stopLoss,
                    slPoints: signal.slPoints,
                    tp1: signal.tp1,
                    tp1Points: signal.tp1Points || 0,
                    tp2: signal.tp2,
                    tp2Points: signal.tp2Points || 0,
                    rr: signal.rr,
                    riskPercent: orderRiskPct,
                    riskAmount: signal.riskAmount,
                    lotSize: lot,
                    confidence: signal.confidence,
                    setup: signal.setup,
                    result: 'OPEN',
                    pl: 0,
                    balanceAfterTrade: currentSettings.manualCapital,
                    notes: `Auto-Executed via MT5 Bridge [Mode: ${currentSettings.accountMode || 'DEMO'}] - Status: ${bridgeRes.status}`,
                  });
                  console.log(`[LiveMarketScanner] Auto-trade executed successfully: ${autoTradeId}`);
                } else {
                  console.warn(`[LiveMarketScanner] Auto-trade execution failed: ${bridgeRes.message}`);
                }
              }).catch((e) => console.error('[LiveMarketScanner] Auto-trade execution error:', e));
            } else {
              console.warn('[LiveMarketScanner] Auto-trade blocked by daily trade limit or risk limit.');
            }
          } catch (autoErr) {
            console.error('[LiveMarketScanner] Error in auto-trading dispatch:', autoErr);
          }
        }

        if (this.onSignalFoundCallback) {
          this.onSignalFoundCallback(signal);
        }

        // Dispatch Telegram notification for newly qualified signal (Requirement 4 & 5)
        signal.currentPrice = currentPrice;
        telegramService.sendSignalNotification(signal, scanId).catch((tgErr) => {
          console.error('[LiveMarketScanner] Telegram notification error:', tgErr?.message || tgErr);
        });

        console.log('[SCANNER] scan completed');
        return signal;
      } else {
        // Returned NO TRADE (or confidence < minConfidence)
        // If an active trade was previously running and is still between SL and TP, maintain it
        if (this.activeSignal && this.activeSignal.signal !== 'NO TRADE') {
          this.config.duplicatePrevented = true;
          this.config.lastDecision = this.activeSignal.signal;
          this.config.lastScanStatus = `الصفقة لا تزال جارية: ${this.activeSignal.signal} (${this.activeSignal.setup}) | السعر: $${currentPrice.toFixed(2)}`;
          this.activeSignal.currentPrice = currentPrice;
          this.config.lastSignal = this.activeSignal;
          console.log('[SCANNER] scan completed (active signal preserved)');
          return this.activeSignal;
        }

        this.config.duplicatePrevented = false;
        this.config.lastDecision = 'NO TRADE';
        this.config.lastSignal = signal;
        this.config.lastScanStatus = `آخر فحص: ${new Date().toLocaleTimeString()} - القرار: NO TRADE (حماية رأس المال - عدم اكتمال الشروط الصارمة)`;

        // Resolve dynamic rejection reason based on actual scan analysis
        let dynamicRejectionReason = signal.noTradeReason;
        if (signal.signal !== 'NO TRADE' && signal.confidence < this.config.minConfidence) {
          dynamicRejectionReason = `نسبة الثقة في الإشارة (${signal.confidence}%) أقل من الحد الأدنى المطلوب (${this.config.minConfidence}%).`;
        } else if (!dynamicRejectionReason && signal.mainReasons && signal.mainReasons.length > 0) {
          dynamicRejectionReason = signal.mainReasons[0];
        } else if (!dynamicRejectionReason) {
          dynamicRejectionReason = 'لا توجد فرصة تداول حالياً: عدم اكتمال شروط الهيكل والسيولة وإدارة المخاطر.';
        }

        signal.currentPrice = currentPrice;

        // Dispatch Telegram notification for NO TRADE with exact Biquote price and dynamic analysis reasons
        telegramService.sendNoTradeNotification(
          scanId,
          dynamicRejectionReason,
          signal.timestamp || Date.now(),
          currentPrice,
          signal
        ).catch((tgErr) => {
          console.error('[LiveMarketScanner] Telegram NO TRADE notification error:', tgErr?.message || tgErr);
        });

        console.log('[SCANNER] scan completed');
        return signal;
      }
    } catch (error: any) {
      console.error('[SCANNER] Scan execution error:', error?.message || error);
      this.biquoteConnectionStatus = `ERROR: ${error?.message || 'Connection failed'}`;
      this.config.dataStatus = `Error: ${error?.message || 'Biquote connection issue'}`;
      this.config.lastScanStatus = `فشل في الاتصال بمصدر بيانات Biquote: ${error?.message || 'خطأ غير معروف'}`;

      // PART 2: EVERY REAL SCAN MUST BE RECORDED
      // If market data or AI fails, record the scan attempt with an ERROR/FAILED status and the actual error reason
      this.config.scanCount += 1;
      const fallbackPrice = this.lastKnownPrice || 0;
      const errorSignal: TradeSignal = {
        id: `scan_err_${Date.now()}`,
        timestamp: Date.now(),
        asset,
        signal: 'NO TRADE',
        currentPrice: fallbackPrice,
        entry: fallbackPrice,
        stopLoss: fallbackPrice,
        slPoints: 0,
        tp1: fallbackPrice,
        tp1Points: 0,
        tp1Rr: 0,
        tp1RrString: '1:0',
        tp2: fallbackPrice,
        tp2Points: 0,
        tp2Rr: 0,
        tp2RrString: '1:0',
        primaryTarget: 'TP1',
        rr: '1:0',
        rrRatio: 0,
        riskPercent: 0,
        riskAmount: 0,
        potentialProfit: 0,
        potentialLoss: 0,
        recommendedLotSize: 0,
        confidence: 0,
        timeframe: '5M',
        setup: 'SCAN_FAILED',
        mainReasons: [error?.message || 'Scan execution failure'],
        invalidation: 'N/A',
        noTradeReason: `فشل الفحص: ${error?.message || 'Unknown error'}`,
      };

      storage.saveScan({
        id: errorSignal.id,
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
        currentPrice: fallbackPrice,
        signal: 'NO TRADE',
        entry: fallbackPrice,
        stopLoss: fallbackPrice,
        slPoints: 0,
        tp1: fallbackPrice,
        tp1Points: 0,
        tp1Rr: '1:0',
        tp2: fallbackPrice,
        tp2Points: 0,
        tp2Rr: '1:0',
        rr: '1:0',
        confidence: 0,
        riskPercent: 0,
        riskAmount: 0,
        lotSize: 0,
        setup: 'SCAN_FAILED',
        reasons: [error?.message || 'Scan execution failure'],
        status: 'FAILED',
        invalidation: 'N/A',
        noTradeReason: error?.message || 'Scan execution failure',
      });
      console.log('[SCANNER] history saved (FAILED scan recorded)');
      console.log('[SCANNER] scan completed (with error)');

      // Dispatch Telegram notification for scan failure (Requirement 4)
      telegramService.sendErrorNotification(
        errorSignal.id,
        error?.message || 'Scan execution failure',
        errorSignal.timestamp,
        fallbackPrice
      ).catch((tgErr) => {
        console.error('[LiveMarketScanner] Telegram ERROR notification error:', tgErr?.message || tgErr);
      });

      this.config.lastDecision = 'NO TRADE';
      this.config.lastSignal = errorSignal;
      return errorSignal;
    } finally {
      this.isScanRunning = false;
      this.config.isScanning = false;
    }
  }

  /**
   * Triggers an immediate scan and resets the 60-second timer
   */
  public async triggerManualScan(): Promise<TradeSignal | null> {
    if (this.isScanRunning) {
      console.log('[SCANNER] Manual scan requested while another scan is in progress. Avoiding concurrent AI request.');
      return this.config.lastSignal || null;
    }
    const res = await this.runScan('XAU/USD');
    // Reset next scan time countdown to full interval
    const intervalSec = this.config.intervalSeconds || 60;
    this.config.nextScanTime = Date.now() + intervalSec * 1000;
    return res;
  }

  /**
   * External Cron Tick Trigger
   * Used by cloud schedulers, external cron services (cron-job.org / Cloud Scheduler)
   * to guarantee 24/7 scanning even when the browser is offline or the container sleeps.
   */
  public async triggerCronTick(): Promise<{ signal: TradeSignal | null; health: any }> {
    const signal = await this.runScan('XAU/USD');
    const health = this.getHealthReport();
    return { signal, health };
  }

  /**
   * Server Health & Worker Status Report
   * Exactly fulfills Requirement 9:
   * - scanner status
   * - last scan time
   * - next scan time
   * - Biquote connection
   * - last successful market-data timestamp
   * - worker uptime
   */
  public getHealthReport() {
    const now = Date.now();
    const uptimeSec = Math.floor((now - this.workerStartTime) / 1000);
    const nextScanMs = this.config.nextScanTime;
    const secondsToNext = nextScanMs ? Math.max(0, Math.ceil((nextScanMs - now) / 1000)) : null;

    return {
      scannerStatus: this.config.enabled ? 'ONLINE' : 'OFFLINE',
      lastScanTime: this.config.lastScanTime,
      lastScanTimeIso: this.config.lastScanTime ? new Date(this.config.lastScanTime).toISOString() : null,
      lastScanTimeFormatted: this.config.lastScanTime ? new Date(this.config.lastScanTime).toLocaleTimeString() : 'N/A',
      nextScanTime: this.config.nextScanTime,
      nextScanTimeIso: this.config.nextScanTime ? new Date(this.config.nextScanTime).toISOString() : null,
      nextScanTimeFormatted: this.config.nextScanTime ? new Date(this.config.nextScanTime).toLocaleTimeString() : 'N/A',
      secondsToNextScan: secondsToNext,
      biquoteConnection: this.biquoteConnectionStatus,
      lastSuccessfulMarketDataTimestamp: this.lastMarketDataTimestamp,
      lastSuccessfulMarketDataTimeIso: this.lastMarketDataTimestamp ? new Date(this.lastMarketDataTimestamp).toISOString() : null,
      workerUptimeSeconds: uptimeSec,
      workerUptimeFormatted: this.formatUptime(uptimeSec),
      scanCount: this.config.scanCount,
      lastDecision: this.config.lastDecision,
      duplicatePrevented: this.config.duplicatePrevented,
      activeSetupName: this.config.activeSetupName,
      isScanning: this.config.isScanning,
      intervalSeconds: this.config.intervalSeconds,
    };
  }

  private formatUptime(totalSeconds: number): string {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || days > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);

    return parts.join(' ');
  }
}

export const scanner = new LiveMarketScanner();
