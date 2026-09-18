import { storage } from './storage.js';
import { fetchLiveQuote, fetchCandles } from './marketData.js';
import { analyzeTechnicals } from './indicators.js';
import { Candle, TechnicalIndicators, TradeLedgerItem } from '../src/types.js';
import { tradeManagementEngine } from './tradeManagementEngine.js';

export interface TradeMonitorStatus {
  isRunning: boolean;
  lastCheckTimestamp: number | null;
  lastCheckedPrice: number | null;
  monitoredTradesCount: number;
  closedTradesCount: number;
}

/**
 * TradeLifecycleMonitor
 * Serves as the background scheduled runner (every 10s by default).
 * Delegates all lifecycle state transitions, deterministic evaluation, and terminal
 * closures (SL / TP2 / VOID) to the single authoritative TradeManagementEngine.
 */
export class TradeLifecycleMonitor {
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private lastCheckTimestamp: number | null = null;
  private lastCheckedPrice: number | null = null;

  constructor() {}

  /**
   * Starts background monitor cycle (every 10s by default).
   */
  public start(intervalMs = 10000): void {
    if (this.timer) return;
    console.log(`[TradeLifecycleMonitor] Started background monitor (every ${intervalMs / 1000}s)`);
    this.timer = setInterval(() => {
      this.tick();
    }, intervalMs);
    // Initial check
    this.tick();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[TradeLifecycleMonitor] Stopped background monitor');
    }
  }

  public getStatus(): TradeMonitorStatus {
    const openTrades = storage.getTrades(300).filter((t) => t.result === 'OPEN' && t.isActive !== false);
    return {
      isRunning: this.timer !== null,
      lastCheckTimestamp: this.lastCheckTimestamp,
      lastCheckedPrice: this.lastCheckedPrice,
      monitoredTradesCount: openTrades.length,
      closedTradesCount: tradeManagementEngine.getTotalClosedCount(),
    };
  }

  /**
   * Evaluates active OPEN trades against current market price and technical structure.
   * Delegates all lifecycle state transitions to authoritative TradeManagementEngine.
   */
  public async evaluatePrice(
    currentPrice: number,
    technicals?: {
      candles5m?: Candle[];
      candles15m?: Candle[];
      candles1h?: Candle[];
      candles1m?: Candle[];
      ind5m?: TechnicalIndicators;
      ind15m?: TechnicalIndicators;
      ind1h?: TechnicalIndicators;
    }
  ): Promise<void> {
    if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) return;
    if (this.isProcessing) return;

    this.isProcessing = true;
    try {
      this.lastCheckTimestamp = Date.now();
      this.lastCheckedPrice = currentPrice;

      const candles5m = technicals?.candles5m || [];
      const candles15m = technicals?.candles15m || [];
      const candles1h = technicals?.candles1h || [];
      const candles1m = technicals?.candles1m || [];
      const ind5m = technicals?.ind5m || (candles5m.length >= 14 ? analyzeTechnicals(candles5m) : undefined);
      const ind15m = technicals?.ind15m || (candles15m.length >= 14 ? analyzeTechnicals(candles15m) : undefined);
      const ind1h = technicals?.ind1h || (candles1h.length >= 14 ? analyzeTechnicals(candles1h) : undefined);

      const settings = storage.getSettings();
      const activeCapital = settings.manualCapital || 100;

      await tradeManagementEngine.evaluateActiveTrades(
        currentPrice,
        candles1h,
        candles15m,
        candles5m,
        candles1m,
        ind1h,
        ind15m,
        ind5m,
        activeCapital,
        settings
      );
    } catch (error) {
      console.error('[TradeLifecycleMonitor] Error evaluating price via TradeManagementEngine:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Evaluates discrete post-entry trade management for a single trade.
   * Delegates to authoritative TradeManagementEngine.
   */
  public async evaluateTradeManagement(
    trade: TradeLedgerItem,
    currentPrice: number,
    technicals?: {
      candles5m?: Candle[];
      candles15m?: Candle[];
      candles1h?: Candle[];
      ind5m?: TechnicalIndicators;
      ind15m?: TechnicalIndicators;
      ind1h?: TechnicalIndicators;
    }
  ): Promise<void> {
    if (!trade || trade.result !== 'OPEN') return;

    const candles5m = technicals?.candles5m || [];
    const candles15m = technicals?.candles15m || [];
    const candles1h = technicals?.candles1h || [];
    const ind5m = technicals?.ind5m || (candles5m.length >= 14 ? analyzeTechnicals(candles5m) : undefined);
    const ind15m = technicals?.ind15m || (candles15m.length >= 14 ? analyzeTechnicals(candles15m) : undefined);
    const ind1h = technicals?.ind1h || (candles1h.length >= 14 ? analyzeTechnicals(candles1h) : undefined);

    const settings = storage.getSettings();
    const activeCapital = settings.manualCapital || 100;

    const evalResult = await tradeManagementEngine.evaluateSingleTrade(
      trade,
      currentPrice,
      candles1h,
      candles15m,
      candles5m,
      [],
      ind1h as any,
      ind15m as any,
      ind5m as any,
      activeCapital,
      settings
    );

    await tradeManagementEngine.applyManagementDecision(evalResult, trade, settings);
  }

  private async tick(): Promise<void> {
    try {
      const trades = storage.getTrades(300);
      const openTrades = trades.filter((t) => t.result === 'OPEN' && t.isActive !== false);
      if (openTrades.length === 0) {
        return; // No open trades, skip fetching quote and candles
      }

      let currentPrice = 0;
      let technicals: {
        candles5m?: Candle[];
        candles15m?: Candle[];
        candles1h?: Candle[];
        ind5m?: TechnicalIndicators;
        ind15m?: TechnicalIndicators;
        ind1h?: TechnicalIndicators;
      } | undefined = undefined;

      try {
        const [quote, candles5m, candles15m, candles1h] = await Promise.all([
          fetchLiveQuote('XAU/USD'),
          fetchCandles('XAU/USD', '5m', 30).catch(() => []),
          fetchCandles('XAU/USD', '15m', 30).catch(() => []),
          fetchCandles('XAU/USD', '1h', 30).catch(() => []),
        ]);

        if (quote && typeof quote.mid === 'number' && quote.mid > 0) {
          currentPrice = quote.mid;
        }

        const ind5m = candles5m.length >= 14 ? analyzeTechnicals(candles5m) : undefined;
        const ind15m = candles15m.length >= 14 ? analyzeTechnicals(candles15m) : undefined;
        const ind1h = candles1h.length >= 14 ? analyzeTechnicals(candles1h) : undefined;
        technicals = { candles5m, candles15m, candles1h, ind5m, ind15m, ind1h };
      } catch (err) {
        // Quote or candle fetch error
      }

      if (currentPrice > 0) {
        await this.evaluatePrice(currentPrice, technicals);
      }
    } catch (err) {
      // Ignore transient errors
    }
  }
}

export const tradeMonitor = new TradeLifecycleMonitor();
