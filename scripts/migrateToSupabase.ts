import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';

const DATA_DIR = path.join(process.cwd(), 'data');

async function runMigration() {
  console.log('[Migration] Starting migration of local state to Supabase PostgreSQL...');

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn(
      '[Migration] Warning: SUPABASE_URL or SUPABASE_KEY is not defined in environment variables.\n' +
      'Please supply SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY) to execute remote synchronization.\n' +
      'Local JSON backups in /data remain fully verified and preserved.'
    );
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Helper to read JSON
  const readJson = (filename: string, fallback: any = null) => {
    const p = path.join(DATA_DIR, filename);
    if (!fs.existsSync(p)) return fallback;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return fallback;
    }
  };

  // 1. Account State: CRITICAL - PRESERVE $91.00
  console.log('[Migration] Migrating account_state...');
  const accountData = readJson('account_state.json', { currentBalance: 91.0, startingBalance: 25.0 });
  const currentBalance = Number(accountData.currentBalance ?? 91.0);
  const startingBalance = Number(accountData.startingBalance ?? 25.0);

  const { error: accErr } = await supabase.from('account_state').upsert({
    id: 'main',
    current_balance: currentBalance,
    starting_balance: startingBalance,
    updated_at: new Date().toISOString(),
  });
  if (accErr) {
    console.error('[Migration] Error migrating account_state:', accErr.message);
  } else {
    console.log(`[Migration] Successfully migrated account_state. Current balance: $${currentBalance}`);
  }

  // 2. App Settings
  console.log('[Migration] Migrating app_settings...');
  const settingsData = readJson('app_settings.json', null);
  if (settingsData) {
    const { error: setErr } = await supabase.from('app_settings').upsert({
      id: 'main',
      data: settingsData,
      updated_at: new Date().toISOString(),
    });
    if (setErr) console.error('[Migration] Error migrating app_settings:', setErr.message);
    else console.log('[Migration] Successfully migrated app_settings.');
  }

  // 3. Trade Ledger
  console.log('[Migration] Migrating trade_ledger...');
  const trades: any[] = readJson('trade_ledger.json', []);
  if (Array.isArray(trades) && trades.length > 0) {
    let successCount = 0;
    for (const trade of trades) {
      if (!trade.id) continue;
      const row = {
        id: trade.id,
        trade_number: trade.tradeNumber || null,
        date: trade.date || null,
        iso_time: trade.isoTime || null,
        asset: trade.asset || 'XAU/USD',
        direction: trade.direction || null,
        entry: trade.entry !== undefined ? Number(trade.entry) : null,
        sl: trade.sl !== undefined ? Number(trade.sl) : null,
        sl_points: trade.slPoints !== undefined ? Number(trade.slPoints) : null,
        tp1: trade.tp1 !== undefined ? Number(trade.tp1) : null,
        tp1_points: trade.tp1Points !== undefined ? Number(trade.tp1Points) : null,
        tp2: trade.tp2 !== undefined ? Number(trade.tp2) : null,
        tp2_points: trade.tp2Points !== undefined ? Number(trade.tp2Points) : null,
        rr: trade.rr || null,
        risk_percent: trade.riskPercent !== undefined ? Number(trade.riskPercent) : null,
        risk_amount: trade.riskAmount !== undefined ? Number(trade.riskAmount) : null,
        lot_size: trade.lotSize !== undefined ? Number(trade.lotSize) : 0.01,
        confidence: trade.confidence !== undefined ? Number(trade.confidence) : null,
        setup: trade.setup || null,
        result: trade.result || null,
        is_active: trade.isActive ?? false,
        pl: trade.pl !== undefined ? Number(trade.pl) : 0,
        realized_pnl: trade.realizedPnl !== undefined ? Number(trade.realizedPnl) : (trade.pl !== undefined ? Number(trade.pl) : 0),
        balance_after_trade: trade.balanceAfterTrade !== undefined ? Number(trade.balanceAfterTrade) : null,
        exit_price: trade.exitPrice !== undefined ? Number(trade.exitPrice) : null,
        exit_time: trade.exitTime || null,
        closed_at: trade.closedAt || null,
        close_reason: trade.closeReason || null,
        source: trade.source || 'MANUAL',
        broker_deal_id: trade.brokerDealId || null,
        broker_order_id: trade.brokerOrderId || null,
        theoretical_tp1_profit: trade.theoreticalTp1Profit !== undefined ? Number(trade.theoreticalTp1Profit) : null,
        theoretical_tp2_profit: trade.theoreticalTp2Profit !== undefined ? Number(trade.theoreticalTp2Profit) : null,
        notes: trade.notes || null,
        signal_id: trade.signalId || null,
        setup_id: trade.setupId || null,
        raw_data: trade,
        updated_at: new Date().toISOString(),
      };
      const { error: tErr } = await supabase.from('trade_ledger').upsert(row);
      if (tErr) console.error(`[Migration] Error upserting trade ${trade.id}:`, tErr.message);
      else successCount++;
    }
    console.log(`[Migration] Successfully migrated ${successCount}/${trades.length} trade ledger items.`);
  }

  // 4. Trade Outcomes
  console.log('[Migration] Migrating trade_outcomes...');
  const outcomes: any[] = readJson('trade_outcomes.json', []);
  if (Array.isArray(outcomes) && outcomes.length > 0) {
    let outCount = 0;
    for (const out of outcomes) {
      const sigId = out.signalId || out.tradeId;
      if (!sigId) continue;
      const row = {
        signal_id: sigId,
        trade_id: out.tradeId || null,
        direction: out.direction || null,
        order_type: out.orderType || null,
        entry: out.entry !== undefined ? Number(out.entry) : null,
        stop_loss: out.stopLoss !== undefined ? Number(out.stopLoss) : null,
        tp1: out.tp1 !== undefined ? Number(out.tp1) : null,
        tp2: out.tp2 !== undefined ? Number(out.tp2) : null,
        outcome: out.outcome || null,
        timestamp: out.timestamp || Date.now(),
        iso_time: out.isoTime || new Date().toISOString(),
        chat_id: out.chatId || null,
        user_id: out.userId || null,
        pl: out.pl !== undefined ? Number(out.pl) : 0,
        realized_pnl: out.realizedPnl !== undefined ? Number(out.realizedPnl) : (out.pl !== undefined ? Number(out.pl) : 0),
        exit_price: out.exitPrice !== undefined ? Number(out.exitPrice) : null,
        source: out.source || 'MANUAL',
        broker_deal_id: out.brokerDealId || null,
        broker_order_id: out.brokerOrderId || null,
        closed_at: out.closedAt || null,
        close_reason: out.closeReason || null,
        notes: out.notes || null,
        raw_data: out,
      };
      const { error: oErr } = await supabase.from('trade_outcomes').upsert(row);
      if (oErr) console.error(`[Migration] Error upserting outcome ${sigId}:`, oErr.message);
      else outCount++;
    }
    console.log(`[Migration] Successfully migrated ${outCount}/${outcomes.length} trade outcomes.`);
  }

  // 5. Signals
  console.log('[Migration] Migrating signals...');
  const signals: any[] = readJson('saved_signals.json', []);
  if (Array.isArray(signals) && signals.length > 0) {
    let sigCount = 0;
    for (const sig of signals) {
      if (!sig.id) continue;
      const { error: sErr } = await supabase.from('signals').upsert({
        id: sig.id,
        timestamp: sig.timestamp || Date.now(),
        raw_data: sig,
      });
      if (sErr) console.error(`[Migration] Error upserting signal ${sig.id}:`, sErr.message);
      else sigCount++;
    }
    console.log(`[Migration] Successfully migrated ${sigCount}/${signals.length} signals.`);
  }

  // 6. Scans
  console.log('[Migration] Migrating scans...');
  const scans: any[] = readJson('scan_history.json', []);
  if (Array.isArray(scans) && scans.length > 0) {
    let scanCount = 0;
    for (const sc of scans) {
      if (!sc.id) continue;
      const { error: scErr } = await supabase.from('scans').upsert({
        id: sc.id,
        timestamp: sc.timestamp || Date.now(),
        status: sc.status || 'SUCCESS',
        raw_data: sc,
      });
      if (scErr) console.error(`[Migration] Error upserting scan ${sc.id}:`, scErr.message);
      else scanCount++;
    }
    console.log(`[Migration] Successfully migrated ${scanCount}/${scans.length} scans.`);
  }

  // 7. Opportunities
  console.log('[Migration] Migrating opportunities...');
  const oppsObj = readJson('opportunities.json', {});
  const oppsList = Array.isArray(oppsObj) ? oppsObj : Object.values(oppsObj);
  if (oppsList.length > 0) {
    let oppCount = 0;
    for (const opp of oppsList as any[]) {
      if (!opp || !opp.id) continue;
      const { error: oppErr } = await supabase.from('opportunities').upsert({
        id: opp.id,
        last_updated_time: opp.lastUpdatedTime || Date.now(),
        raw_data: opp,
      });
      if (oppErr) console.error(`[Migration] Error upserting opportunity ${opp.id}:`, oppErr.message);
      else oppCount++;
    }
    console.log(`[Migration] Successfully migrated ${oppCount}/${oppsList.length} opportunities.`);
  }

  // 8. Telegram Chat
  console.log('[Migration] Migrating telegram config...');
  const tgData = readJson('telegram_private_chat.json', null);
  if (tgData && tgData.chatId) {
    const { error: tgErr } = await supabase.from('telegram_config').upsert({
      id: 'main',
      chat_id: String(tgData.chatId),
      registered_at: tgData.registeredAt || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (tgErr) console.error('[Migration] Error migrating telegram_config:', tgErr.message);
    else console.log('[Migration] Successfully migrated telegram_config.');
  }

  // 9. Terminal Setups
  console.log('[Migration] Migrating terminal setups...');
  const terminalSetups: string[] = readJson('terminal_setups.json', []);
  if (Array.isArray(terminalSetups) && terminalSetups.length > 0) {
    let termCount = 0;
    for (const key of terminalSetups) {
      if (!key) continue;
      const { error: termErr } = await supabase.from('terminal_setups').upsert({
        id: key.replace(/\//g, '_'),
        setup_key: key,
      });
      if (termErr) console.error(`[Migration] Error upserting terminal setup ${key}:`, termErr.message);
      else termCount++;
    }
    console.log(`[Migration] Successfully migrated ${termCount}/${terminalSetups.length} terminal setups.`);
  }

  // 10. Experience Records
  console.log('[Migration] Migrating experience records...');
  const expRecords: any[] = readJson('experience_records.json', []);
  if (Array.isArray(expRecords) && expRecords.length > 0) {
    let expCount = 0;
    for (const rec of expRecords) {
      if (!rec || !rec.id) continue;
      const { error: expErr } = await supabase.from('experience_records').upsert({
        id: rec.id,
        signal_id: rec.signalId,
        trade_id: rec.tradeId || null,
        combination_key: rec.combinationKey,
        factors: rec.factors,
        direction: rec.direction,
        setup_family: rec.setupFamily,
        outcome: rec.outcome,
        realized_pnl: rec.realizedPnl,
        rr: rec.rr || null,
        completed_at: rec.completedAt,
        raw_data: rec,
      });
      if (expErr) console.error(`[Migration] Error upserting experience record ${rec.id}:`, expErr.message);
      else expCount++;
    }
    console.log(`[Migration] Successfully migrated ${expCount}/${expRecords.length} experience records.`);
  }

  console.log('[Migration] Migration routine finished successfully!');
}

runMigration().catch((err) => {
  console.error('[Migration] Fatal error in migration script:', err);
});
