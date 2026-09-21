export type TradingRuntimeMode = 'production' | 'shadow';

export type ShadowDecision = 'SHADOW_ACCEPTED' | 'SHADOW_REJECTED' | 'SHADOW_BLOCKED' | 'NO_SETUP';

let testingModeOverride: TradingRuntimeMode | null = null;

/**
 * Returns the active trading runtime mode.
 * PRODUCTION: Only when TRADING_RUNTIME_MODE === 'production'.
 * SHADOW: Default for AI Studio, local development, staging, or testing.
 */
export function getTradingRuntimeMode(): TradingRuntimeMode {
  if (testingModeOverride) {
    return testingModeOverride;
  }
  const raw = process.env.TRADING_RUNTIME_MODE?.toLowerCase()?.trim();
  if (raw === 'production') {
    return 'production';
  }
  return 'shadow';
}

export function isShadowMode(): boolean {
  return getTradingRuntimeMode() === 'shadow';
}

export function isProductionMode(): boolean {
  return getTradingRuntimeMode() === 'production';
}

export function setTradingRuntimeModeForTesting(mode: TradingRuntimeMode | null): void {
  testingModeOverride = mode;
}

export interface ShadowScanDiagnostic {
  id: string;
  timestamp: number;
  timestampIso: string;
  price: number;
  bid: number;
  ask: number;
  spreadPoints: number;
  closedCandles: {
    '1H'?: string;
    '15M'?: string;
    '5M'?: string;
    '1M'?: string;
  };
  marketRegime: string;
  candidateStrategy?: string;
  candidateDirection?: 'BUY' | 'SELL';
  levels?: {
    entry: number;
    sl: number;
    tp1: number;
    tp2?: number;
    confidence: number;
    rr: number;
  };
  gates: {
    spread: 'PASS' | 'FAIL' | 'BLOCKED';
    quality: 'PASS' | 'FAIL';
    qualityScore?: number;
    antiChase: 'PASS' | 'FAIL' | 'CHASED';
    poiState?: string;
    risk: 'PASS' | 'FAIL';
  };
  rejectionReason?: string;
  firstRejectionReason?: string;
  finalDecision: ShadowDecision;
  telegramDispatch: 'DISABLED_SHADOW_MODE' | 'DISPATCHED_PRODUCTION';
  productionStateMutation: 'BLOCKED_SHADOW_MODE' | 'MUTATED_PRODUCTION';
}

export interface ParityComparisonResult {
  comparisonTimestamp: number;
  comparisonTimeIso: string;
  runtimeMode: TradingRuntimeMode;
  totalProductionSignals: number;
  totalShadowScans: number;
  matches: Array<{
    productionSignalId: string;
    setupName: string;
    direction: string;
    productionTimeIso: string;
    shadowTimeIso: string;
    result: 'PARITY_MATCH';
  }>;
  divergences: Array<{
    productionSignalId: string;
    setupName: string;
    direction: string;
    productionTimeIso: string;
    result: 'PARITY_DIVERGENCE';
    firstRejectionReason: string;
    details?: string;
  }>;
  summary: {
    parityMatches: number;
    parityDivergences: number;
  };
}

export function logShadowScanDiagnostic(diag: ShadowScanDiagnostic): void {
  const lines = [
    '',
    '====================================================',
    '[SHADOW SCAN]',
    `Time: ${diag.timestampIso}`,
    `Price: ${diag.price.toFixed(2)}`,
    `Spread: ${diag.spreadPoints.toFixed(1)} pts`,
    `5M Closed Candle: ${diag.closedCandles['5M'] || 'N/A'}`,
    '',
    `Candidate:`,
    `${diag.candidateStrategy || 'NONE'}`,
    `Direction: ${diag.candidateDirection || 'NONE'}`,
    '',
    `Quality: ${diag.gates.quality}`,
    `Anti-Chase: ${diag.gates.antiChase}`,
    `Spread: ${diag.gates.spread}`,
    `TP1 RR: ${diag.levels?.rr ? diag.levels.rr.toFixed(2) : 'N/A'}`,
    `Risk: ${diag.gates.risk}`,
    '',
    `Final:`,
    `${diag.finalDecision}`,
    ...(diag.rejectionReason ? [`Reason: ${diag.rejectionReason}`] : []),
    '',
    'NO TELEGRAM DISPATCH',
    'NO PRODUCTION STATE MUTATION',
    '====================================================',
    '',
  ];
  console.log(lines.join('\n'));
}

class ShadowDiagnosticsManager {
  private recentScans: ShadowScanDiagnostic[] = [];
  private readonly maxScans = 100;

  public recordScan(diag: ShadowScanDiagnostic): void {
    this.recentScans.unshift(diag);
    if (this.recentScans.length > this.maxScans) {
      this.recentScans.pop();
    }
  }

  public getRecentScans(limit = 20): ShadowScanDiagnostic[] {
    return this.recentScans.slice(0, limit);
  }

  public getLatestScan(): ShadowScanDiagnostic | null {
    return this.recentScans[0] || null;
  }

  public clear(): void {
    this.recentScans = [];
  }

  public compareWithProduction(productionSignals: any[], productionOpportunities: any[]): ParityComparisonResult {
    const matches: ParityComparisonResult['matches'] = [];
    const divergences: ParityComparisonResult['divergences'] = [];

    // Combine recent production signals and dispatched opportunities
    const prodItems: Array<{ id: string; setup: string; direction: string; timestamp: number; timeIso: string }> = [];

    for (const sig of (productionSignals || []).slice(0, 30)) {
      if (sig && sig.signal && sig.signal !== 'NO TRADE') {
        const dir = String(sig.signal).toUpperCase().includes('BUY') ? 'BUY' : 'SELL';
        prodItems.push({
          id: sig.id || 'sig',
          setup: sig.setup || 'Unknown',
          direction: dir,
          timestamp: sig.timestamp || Date.now(),
          timeIso: sig.isoTime || (sig.timestamp ? new Date(sig.timestamp).toISOString() : new Date().toISOString()),
        });
      }
    }

    for (const opp of (productionOpportunities || []).slice(0, 30)) {
      if (opp && (opp.status === 'DISPATCHED' || opp.dispatchedAt)) {
        const dir = (opp.direction || 'BUY').toUpperCase().includes('BUY') ? 'BUY' : 'SELL';
        if (!prodItems.some((p) => p.id === opp.id || p.id === opp.signalId)) {
          prodItems.push({
            id: opp.id,
            setup: opp.setupName || 'Unknown',
            direction: dir,
            timestamp: opp.dispatchedAt || opp.lastUpdatedTime || Date.now(),
            timeIso: new Date(opp.dispatchedAt || opp.lastUpdatedTime || Date.now()).toISOString(),
          });
        }
      }
    }

    // For each production signal, search in shadow scans for matching setup within +/- 15 minutes
    for (const prod of prodItems) {
      const matchingShadowScan = this.recentScans.find((s) => {
        const timeDiff = Math.abs(s.timestamp - prod.timestamp);
        const nameMatches = s.candidateStrategy?.toLowerCase() === prod.setup.toLowerCase() ||
          (s.candidateStrategy && prod.setup && s.candidateStrategy.toLowerCase().includes(prod.setup.toLowerCase().slice(0, 8)));
        const dirMatches = s.candidateDirection === prod.direction;
        return timeDiff < 15 * 60 * 1000 && (nameMatches || dirMatches);
      });

      if (matchingShadowScan) {
        if (matchingShadowScan.finalDecision === 'SHADOW_ACCEPTED') {
          matches.push({
            productionSignalId: prod.id,
            setupName: prod.setup,
            direction: prod.direction,
            productionTimeIso: prod.timeIso,
            shadowTimeIso: matchingShadowScan.timestampIso,
            result: 'PARITY_MATCH',
          });
        } else {
          divergences.push({
            productionSignalId: prod.id,
            setupName: prod.setup,
            direction: prod.direction,
            productionTimeIso: prod.timeIso,
            result: 'PARITY_DIVERGENCE',
            firstRejectionReason: matchingShadowScan.firstRejectionReason || matchingShadowScan.rejectionReason || 'REJECTED_BY_GATES',
            details: `Shadow scan rejected with reason: ${matchingShadowScan.rejectionReason || 'Unknown'}`,
          });
        }
      } else {
        divergences.push({
          productionSignalId: prod.id,
          setupName: prod.setup,
          direction: prod.direction,
          productionTimeIso: prod.timeIso,
          result: 'PARITY_DIVERGENCE',
          firstRejectionReason: 'NO_SHADOW_SCAN_IN_WINDOW',
          details: 'No shadow scan was executed during the production signal window (e.g. container sleep, process phase offset)',
        });
      }
    }

    return {
      comparisonTimestamp: Date.now(),
      comparisonTimeIso: new Date().toISOString(),
      runtimeMode: getTradingRuntimeMode(),
      totalProductionSignals: prodItems.length,
      totalShadowScans: this.recentScans.length,
      matches,
      divergences,
      summary: {
        parityMatches: matches.length,
        parityDivergences: divergences.length,
      },
    };
  }
}

export const shadowDiagnosticsStore = new ShadowDiagnosticsManager();
