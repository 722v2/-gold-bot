import { storage } from './storage.js';
import { fetchLiveQuote } from './marketData.js';
import { TradeLedgerItem } from '../src/types.js';
import { globalLifecycleManager } from './tradeQualityEngine.js';
import { telegramService } from './telegram.js';

export interface TradeMonitorStatus {
  isRunning: boolean;
  lastCheckTimestamp: number | null;
  lastCheckedPrice: number | null;
  monitoredTradesCount: number;
  closedTradesCount: number;
}

export class TradeLifecycleMonitor {
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private inFlightTradeIds = new Set<string>();
  private lastCheckTimestamp: number | null = null;
  private lastCheckedPrice: number | null = null;
  private totalClosedByMonitor = 0;

  constructor() {}

  /**
   * Starts background monitor cycle
   * Strictly monitors existing recorded trades. Does NOT open new trades or touch MT5.
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
      closedTradesCount: this.totalClosedByMonitor,
    };
  }

  /**
   * Evaluates active OPEN trades against current market price.
   * Can be invoked directly by scanner on new ticks or by monitor interval.
   */
  public async evaluatePrice(currentPrice: number): Promise<void> {
    if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) return;

    // Trigger Telegram updates for active signals (even if ledger has no open trades yet)
    telegramService.updateActiveSignals(currentPrice).catch((err) => {
      console.error('[TradeLifecycleMonitor] Telegram active signals update error:', err);
    });

    if (this.isProcessing) return;

    this.isProcessing = true;
    try {
      this.lastCheckTimestamp = Date.now();
      this.lastCheckedPrice = currentPrice;

      const trades = storage.getTrades(300);
      const openTrades = trades.filter((t) => t.result === 'OPEN' && t.isActive !== false);

      if (openTrades.length === 0) {
        return;
      }

      for (const trade of openTrades) {
        // Idempotency: skip if currently in-flight
        if (this.inFlightTradeIds.has(trade.id)) continue;
        // Verify current state is still OPEN
        if (trade.result !== 'OPEN') continue;

        // Safety against extreme legacy/test anomalies (>30% price deviation)
        const priceDeviationPct = Math.abs(currentPrice - trade.entry) / currentPrice;
        if (priceDeviationPct > 0.30) {
          console.warn(
            `[TradeLifecycleMonitor] Anomalous trade detected: ID ${trade.id}, Entry $${trade.entry} vs Market $${currentPrice}. Marking VOID.`
          );
          this.inFlightTradeIds.add(trade.id);
          try {
            storage.closeTrade(
              trade.id,
              'VOID',
              0,
              trade.entry,
              `Auto-voided by TradeMonitor: Entry price ($${trade.entry}) differs anomalously (>30%) from market ($${currentPrice})`
            );
          } finally {
            this.inFlightTradeIds.delete(trade.id);
          }
          continue;
        }

        const isBuy = trade.direction.toUpperCase().includes('BUY');
        const isSell = trade.direction.toUpperCase().includes('SELL');

        const sl = Number(trade.sl);
        const tp2 = trade.tp2 ? Number(trade.tp2) : undefined;
        const entry = Number(trade.entry);
        const lotSize = trade.lotSize || 0.01;
        const contractSize = 100; // Standard Gold 100 oz per lot

        let exitTrigger: 'TP2' | 'SL' | null = null;
        let exitPrice = currentPrice;

        if (isBuy) {
          // BUY: SL is below entry, TP2 is above entry
          if (sl > 0 && currentPrice <= sl) {
            exitTrigger = 'SL';
            exitPrice = sl;
          } else if (tp2 && tp2 > 0 && currentPrice >= tp2) {
            exitTrigger = 'TP2';
            exitPrice = tp2;
          }
        } else if (isSell) {
          // SELL: SL is above entry, TP2 is below entry
          if (sl > 0 && currentPrice >= sl) {
            exitTrigger = 'SL';
            exitPrice = sl;
          } else if (tp2 && tp2 > 0 && currentPrice <= tp2) {
            exitTrigger = 'TP2';
            exitPrice = tp2;
          }
        }

        if (exitTrigger) {
          this.inFlightTradeIds.add(trade.id);
          try {
            const isWin = exitTrigger === 'TP2';
            const priceDiff = isBuy ? (exitPrice - entry) : (entry - exitPrice);
            let realizedPl = Number((priceDiff * contractSize * lotSize).toFixed(2));

            // Ensure mathematical sign consistency
            if (!isWin && realizedPl > 0) {
              realizedPl = -Math.abs(realizedPl);
            }
            if (isWin && realizedPl < 0) {
              realizedPl = Math.abs(realizedPl);
            }

            const resultType = isWin ? 'WIN' : 'LOSS';
            const noteSuffix = `Closed via TradeLifecycleMonitor [Trigger: ${exitTrigger} @ $${exitPrice.toFixed(2)}]`;

            console.log(
              `[TradeLifecycleMonitor] Auto-closing trade ${trade.id} -> ${resultType} (Exit: $${exitPrice}, P/L: $${realizedPl})`
            );
            storage.closeTrade(trade.id, resultType, realizedPl, exitPrice, noteSuffix);
            if (resultType === 'LOSS') {
              globalLifecycleManager.markSetupFailed(trade, 'Trade hit Stop Loss in TradeLifecycleMonitor');
            } else if (resultType === 'WIN') {
              globalLifecycleManager.markSetupCompleted(trade, 'Trade reached TP2 target in TradeLifecycleMonitor');
            }
            this.totalClosedByMonitor += 1;
          } catch (err) {
            console.error(`[TradeLifecycleMonitor] Error closing trade ${trade.id}:`, err);
          } finally {
            this.inFlightTradeIds.delete(trade.id);
          }
        }
      }
    } catch (error) {
      console.error('[TradeLifecycleMonitor] Error evaluating price:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  private async tick(): Promise<void> {
    try {
      const trades = storage.getTrades(300);
      const hasOpenTrades = trades.some((t) => t.result === 'OPEN' && t.isActive !== false);
      const hasTelegramSignals = telegramService.hasActiveSignals();
      if (!hasOpenTrades && !hasTelegramSignals) {
        return; // No open trades and no active Telegram signals, skip fetching quote
      }

      const quote = await fetchLiveQuote('XAU/USD');
      if (quote && typeof quote.mid === 'number' && quote.mid > 0) {
        await this.evaluatePrice(quote.mid);
      }
    } catch (err) {
      // Ignore transient quote fetching errors
    }
  }
}

export const tradeMonitor = new TradeLifecycleMonitor();
