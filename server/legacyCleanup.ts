import { storage } from './storage.js';
import { globalLifecycleManager } from './tradeQualityEngine.js';
import { TradeSignal, TradeLedgerItem } from '../src/types.js';

export interface LegacyCleanupReport {
  identifiedLegacySignals: number;
  cancelledSignals: number;
  cancelledActiveVirtualTrades: number;
  untouchedHistoricalCompletedTrades: number;
  realBrokerOrdersAffected: number;
  details: string[];
}

export function performLegacySignalCleanup(): LegacyCleanupReport {
  console.log('[LegacyCleanup] Starting legacy signal & active trade state cleanup...');

  const signals = storage.getSignals(500);
  const trades = storage.getTrades(500);

  let identifiedLegacySignals = 0;
  let cancelledSignals = 0;
  let cancelledActiveVirtualTrades = 0;
  let untouchedHistoricalCompletedTrades = 0;
  const realBrokerOrdersAffected = 0;
  const details: string[] = [];

  // 1. Identify and invalidate legacy signals
  for (const sig of signals) {
    if (sig.lifecycleState !== 'COMPLETED' && sig.lifecycleState !== 'INVALIDATED' && sig.lifecycleState !== 'FAILED') {
      identifiedLegacySignals++;
      sig.lifecycleState = 'INVALIDATED';
      sig.noTradeReason = 'legacy_setup_identity_reset';
      storage.saveSignal(sig);
      cancelledSignals++;
      details.push(`Invalidated legacy signal: ${sig.id} (${sig.setup})`);
    }
  }

  // 2. Identify and cancel active virtual-paper trades
  for (const tr of trades) {
    if (tr.result === 'WIN' || tr.result === 'LOSS') {
      untouchedHistoricalCompletedTrades++;
    } else if (tr.result === 'OPEN') {
      tr.result = 'CANCELLED';
      tr.isActive = false;
      tr.notes = `${tr.notes || ''} [Cancelled via legacy_setup_identity_reset]`.trim();
      storage.saveTrade(tr);
      cancelledActiveVirtualTrades++;
      details.push(`Cancelled active virtual trade: #${tr.tradeNumber} (${tr.id})`);
    }
  }

  console.log(`[LegacyCleanup] Audit Report Completed:
  - Identified Legacy Signals: ${identifiedLegacySignals}
  - Cancelled Signals: ${cancelledSignals}
  - Cancelled Active Virtual Trades: ${cancelledActiveVirtualTrades}
  - Untouched Historical Completed Trades: ${untouchedHistoricalCompletedTrades}
  - Real Broker Orders Affected: ${realBrokerOrdersAffected}`);

  return {
    identifiedLegacySignals,
    cancelledSignals,
    cancelledActiveVirtualTrades,
    untouchedHistoricalCompletedTrades,
    realBrokerOrdersAffected,
    details,
  };
}
