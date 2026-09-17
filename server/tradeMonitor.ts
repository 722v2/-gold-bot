import { storage } from './storage.js';
import { fetchLiveQuote, fetchCandles } from './marketData.js';
import { analyzeTechnicals } from './indicators.js';
import { Candle, TechnicalIndicators, TradeLedgerItem } from '../src/types.js';
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
   * Starts background monitor cycle (every 10s by default)
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
   * Evaluates active OPEN trades against current market price and technical structure.
   * Dispatches event-driven state transitions (TP1_REACHED, BE_LOCKED, WEAKENING, INVALIDATED).
   * Normal HOLD/development produces ZERO Telegram API calls.
   */
  public async evaluatePrice(
    currentPrice: number,
    technicals?: {
      candles5m?: Candle[];
      candles15m?: Candle[];
      ind5m?: TechnicalIndicators;
      ind15m?: TechnicalIndicators;
    }
  ): Promise<void> {
    if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) return;

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
            trade.managementState = 'CLOSED';
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
          continue;
        }

        // Post-entry trade management evaluation
        await this.evaluateTradeManagement(trade, currentPrice, technicals);
      }
    } catch (error) {
      console.error('[TradeLifecycleMonitor] Error evaluating price:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Evaluates discrete post-entry trade management state transitions.
   * Guaranteed idempotent and sends at most one notification per transition event.
   */
  public async evaluateTradeManagement(
    trade: TradeLedgerItem,
    currentPrice: number,
    technicals?: {
      candles5m?: Candle[];
      candles15m?: Candle[];
      ind5m?: TechnicalIndicators;
      ind15m?: TechnicalIndicators;
    }
  ): Promise<void> {
    if (!trade || trade.result !== 'OPEN') return;

    if (!trade.managementState) {
      trade.managementState = 'ACTIVE';
    }
    if (!trade.notifiedStates) {
      trade.notifiedStates = [];
    }

    const isBuy = trade.direction.toUpperCase().includes('BUY');
    const isSell = trade.direction.toUpperCase().includes('SELL');
    const entry = Number(trade.entry);
    const sl = Number(trade.sl);
    const tp1 = Number(trade.tp1);
    const slDistance = Math.abs(entry - sl) || 1.0;

    let stateChanged = false;

    // 1. TP1 Milestone (TP1_REACHED)
    const isTp1Reached = isBuy ? currentPrice >= tp1 : currentPrice <= tp1;
    if (isTp1Reached && !trade.notifiedStates.includes('TP1_REACHED')) {
      trade.managementState = 'TP1_REACHED';
      trade.tp1HitTimestamp = Date.now();
      trade.notifiedStates.push('TP1_REACHED');
      stateChanged = true;

      const tp2Display = trade.tp2 ? `$${Number(trade.tp2).toFixed(2)}` : 'Open target';
      const msg = `🎯 <b>TP1 reached @ $${tp1.toFixed(2)}</b>\nHolding for TP2 (${tp2Display}).`;
      telegramService.sendManagementNotification(msg).catch((err) => {
        console.error('[TradeLifecycleMonitor] Telegram TP1 alert error:', err);
      });
    }

    // 2. Break-Even / Profit Protection (BE_LOCKED)
    // Trigger when TP1 was reached OR favorable progress >= 1.0R
    const favorableDist = isBuy ? (currentPrice - entry) : (entry - currentPrice);
    const hasReachedTp1 = trade.managementState === 'TP1_REACHED' || trade.notifiedStates.includes('TP1_REACHED');
    const isStrongProfit = favorableDist >= slDistance;

    if ((hasReachedTp1 || isStrongProfit) && !trade.notifiedStates.includes('BE_LOCKED')) {
      let newSL: number;
      if (isBuy) {
        newSL = Number(Math.max(sl, entry + 0.50).toFixed(2));
      } else {
        newSL = Number(Math.min(sl, entry - 0.50).toFixed(2));
      }

      trade.managementState = 'BE_LOCKED';
      trade.suggestedSL = newSL;
      trade.notifiedStates.push('BE_LOCKED');
      stateChanged = true;

      const msg = `🔒 <b>Profit protected</b>\nSL moved to $${newSL.toFixed(2)}.`;
      telegramService.sendManagementNotification(msg).catch((err) => {
        console.error('[TradeLifecycleMonitor] Telegram BE alert error:', err);
      });
    }

    // 3. Structural Weakening (L2) & Invalidation (L3)
    // Only check weakening/invalidation if trade has not already locked in TP1 / BE profit
    if (!trade.notifiedStates.includes('TP1_REACHED') && !trade.notifiedStates.includes('BE_LOCKED')) {
      const candles5m = technicals?.candles5m || [];
      const candles15m = technicals?.candles15m || [];
      const ind5m = technicals?.ind5m;
      const ind15m = technicals?.ind15m;

      let isInvalidated = false;
      let isWeakening = false;

      if (isBuy) {
        const adverseDistance = entry - currentPrice;
        // L3 Invalidation: 15M structure bearish or adverse > 0.6 SL distance with heavy momentum loss
        if (
          (candles15m.length >= 6 && ind15m?.structure === 'BEARISH' && adverseDistance > 0.5 * slDistance) ||
          (adverseDistance > 0.7 * slDistance && (ind5m?.rsi14 ?? 50) < 38)
        ) {
          isInvalidated = true;
        } else if (
          // L2 Weakening: local 5M swing breakdown or momentum loss
          (adverseDistance > 0.35 * slDistance && (ind5m?.rsi14 ?? 50) < 45) ||
          (candles5m.length >= 6 && candles5m[candles5m.length - 1].close < Math.min(...candles5m.slice(-6, -2).map((c) => c.low)) && (ind5m?.rsi14 ?? 50) < 45)
        ) {
          isWeakening = true;
        }
      } else if (isSell) {
        const adverseDistance = currentPrice - entry;
        // L3 Invalidation: 15M structure bullish or adverse > 0.6 SL distance with heavy momentum loss
        if (
          (candles15m.length >= 6 && ind15m?.structure === 'BULLISH' && adverseDistance > 0.5 * slDistance) ||
          (adverseDistance > 0.7 * slDistance && (ind5m?.rsi14 ?? 50) > 62)
        ) {
          isInvalidated = true;
        } else if (
          // L2 Weakening: local 5M swing breakdown or momentum loss
          (adverseDistance > 0.35 * slDistance && (ind5m?.rsi14 ?? 50) > 55) ||
          (candles5m.length >= 6 && candles5m[candles5m.length - 1].close > Math.max(...candles5m.slice(-6, -2).map((c) => c.high)) && (ind5m?.rsi14 ?? 50) > 55)
        ) {
          isWeakening = true;
        }
      }

      if (isInvalidated && !trade.notifiedStates.includes('INVALIDATED') && !trade.notifiedStates.includes('EXIT_RECOMMENDED')) {
        trade.managementState = 'INVALIDATED';
        trade.notifiedStates.push('INVALIDATED');
        stateChanged = true;

        const msg = `🚨 <b>Trade invalidated</b>\n${trade.asset || 'XAU/USD'} @ $${currentPrice.toFixed(2)}\nOriginal setup premise has failed. Recommended exit.`;
        telegramService.sendManagementNotification(msg).catch((err) => {
          console.error('[TradeLifecycleMonitor] Telegram Invalidation alert error:', err);
        });
      } else if (isWeakening && !isInvalidated && trade.managementState !== 'WEAKENING' && !trade.notifiedStates.includes('WEAKENING')) {
        trade.managementState = 'WEAKENING';
        trade.notifiedStates.push('WEAKENING');
        stateChanged = true;

        const msg = `⚠️ <b>Trade weakening</b>\n${trade.asset || 'XAU/USD'} @ $${currentPrice.toFixed(2)}\nStructure is deteriorating. Recommended early exit.`;
        telegramService.sendManagementNotification(msg).catch((err) => {
          console.error('[TradeLifecycleMonitor] Telegram Weakening alert error:', err);
        });
      }
      // L1: Minor weakness / normal pullback -> 0 Telegram API calls (remain in ACTIVE/HOLD)
    }

    if (stateChanged) {
      storage.saveTrade(trade);
    }
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
        ind5m?: TechnicalIndicators;
        ind15m?: TechnicalIndicators;
      } | undefined = undefined;

      try {
        const [quote, candles5m, candles15m] = await Promise.all([
          fetchLiveQuote('XAU/USD'),
          fetchCandles('XAU/USD', '5m', 30).catch(() => []),
          fetchCandles('XAU/USD', '15m', 30).catch(() => []),
        ]);

        if (quote && typeof quote.mid === 'number' && quote.mid > 0) {
          currentPrice = quote.mid;
        }

        const ind5m = candles5m.length >= 14 ? analyzeTechnicals(candles5m) : undefined;
        const ind15m = candles15m.length >= 14 ? analyzeTechnicals(candles15m) : undefined;
        technicals = { candles5m, candles15m, ind5m, ind15m };
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
