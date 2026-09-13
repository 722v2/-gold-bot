import dotenv from 'dotenv';
dotenv.config();

import { scanner } from './scanner.js';
import { storage } from './storage.js';

console.log('====================================================');
console.log('  GOLD AI CHALLENGE - 24/7 STANDALONE WORKER DAEMON');
console.log('  Asset: XAU/USD (Gold)');
console.log('  Provider: Biquote MT5 Real-time Feed');
console.log('  Cadence: 60-Second Autonomous Scan Cycle');
console.log('====================================================');

// Listen for new qualified signals
scanner.onSignal((signal) => {
  console.log('\n----------------------------------------------------');
  console.log(`[ALERT] NEW QUALIFIED TRADE SIGNAL FOUND: ${signal.signal}`);
  console.log(`Setup: ${signal.setup} | Confidence: ${signal.confidence}%`);
  console.log(`Entry: $${signal.entry.toFixed(2)} | SL: $${signal.stopLoss.toFixed(2)} (${signal.slPoints} pts)`);
  console.log(`TP1: $${signal.tp1.toFixed(2)} (${signal.tp1RrString || '1:1.50'}) | TP2: $${signal.tp2.toFixed(2)} (${signal.tp2RrString || '1:3.00'})`);
  console.log(`Risk: ${signal.riskPercent}% ($${signal.riskAmount.toFixed(2)}) | Lot Size: ${signal.recommendedLotSize} Std Lot`);
  console.log('----------------------------------------------------\n');
});

// Periodic heartbeat logger
setInterval(() => {
  const health = scanner.getHealthReport();
  const stats = storage.getStats();
  console.log(
    `[Heartbeat ${new Date().toLocaleTimeString()}] Status: ${health.scannerStatus} | Uptime: ${health.workerUptimeFormatted} | Scans: ${health.scanCount} | Saved Scans: ${stats.totalScansRecorded} | Last: ${health.lastDecision || 'N/A'}`
  );
}, 120000); // every 2 minutes

// Graceful shutdown
const shutdown = () => {
  console.log('\n[Worker] Gracefully shutting down scanner worker...');
  scanner.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('[Worker] Standalone 24/7 worker process is now active.');
