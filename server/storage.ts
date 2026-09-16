import * as fs from 'fs';
import * as path from 'path';
import { supabase, isSupabaseConfigured } from './supabase.js';
import { telegramService } from './telegram.js';

import {
  AppSettings,
  DEFAULT_APP_SETTINGS,
  TradeSignal,
  TradeLedgerItem,
  PoiRecord,
  CandidateLifecycleRecord,
  TradeOpportunity,
} from '../src/types.js';

export type {
  AppSettings,
  TradeSignal,
  TradeLedgerItem,
  PoiRecord,
  CandidateLifecycleRecord,
  TradeOpportunity,
};

export interface ScanRecord {
  id: string;
  timestamp: number;
  time?: string;
  isoTime?: string;
  asset?: string;
  price?: number;
  currentPrice?: number;
  bias?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  signal: 'BUY NOW' | 'SELL NOW' | 'BUY LIMIT' | 'SELL LIMIT' | 'NO TRADE' | string;
  confidence: number;
  sl?: number;
  stopLoss?: number;
  slPoints?: number;
  tp1?: number;
  tp1Points?: number;
  tp1Rr?: any;
  tp2?: number;
  tp2Points?: number;
  tp2Rr?: any;
  rr?: string;
  riskPercent?: number;
  riskAmount?: number;
  lotSize?: number;
  setup?: string;
  setupName?: string;
  orderType?: 'MARKET' | 'LIMIT';
  status: 'PENDING' | 'EXECUTED' | 'EXPIRED' | 'CANCELLED' | 'SUCCESS' | 'NO TRADE' | 'FAILED' | string;
  reason?: string;
  strategy?: string;
  timeframe?: string;
  atr?: number;
  reasons?: string[];
  rawAnalysis?: string;
  entry?: number;
  setupId?: string;
  noTradeReason?: string;
  invalidation?: string;
  [key: string]: any;
}

export interface TradeOutcomeRecord {
  signalId: string;
  tradeId?: string;
  direction?: string;
  orderType?: string;
  entry?: number;
  stopLoss?: number;
  tp1?: number;
  tp2?: number;
  outcome: 'WIN' | 'LOSS';
  timestamp: number;
  isoTime?: string;
  chatId?: string;
  userId?: string;
  pl?: number;
  realizedPnl?: number;
  exitPrice?: number;
  source?: string;
  brokerDealId?: string;
  brokerOrderId?: string;
  closedAt?: number;
  closeReason?: string;
  notes?: string;
}

export interface DailyTradeStats {
  date: string;
  tradesCount: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPl: number;
  totalRiskPercentUsed: number;
  maxDailyTradesReached: boolean;
  maxDailyRiskReached: boolean;
}

export interface DashboardStatsResult {
  totalScans: number;
  totalSignals: number;
  buyCount: number;
  sellCount: number;
  limitCount: number;
  noTradeCount: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPl: number;
  startingBalance: number;
  currentBalance: number;
  currentRiskPercent: number;
  recentSignals: TradeSignal[];
  recentScans: ScanRecord[];
  lastScanTime: number;
  lastScanStatus: string;
  scannerHealth: string;
  todayStats: DailyTradeStats;
}



const DATA_DIR = path.join(process.cwd(), 'data');
const SCANS_FILE = path.join(DATA_DIR, 'scan_history.json');
const SIGNALS_FILE = path.join(DATA_DIR, 'saved_signals.json');
const TRADES_FILE = path.join(DATA_DIR, 'trade_ledger.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'app_settings.json');
const OUTCOMES_FILE = path.join(DATA_DIR, 'trade_outcomes.json');
const ACCOUNT_FILE = path.join(DATA_DIR, 'account_state.json');
const TERMINAL_FILE = path.join(DATA_DIR, 'terminal_setups.json');
const OPPS_FILE = path.join(DATA_DIR, 'opportunities.json');
const TELEGRAM_CHAT_FILE = path.join(DATA_DIR, 'telegram_private_chat.json');
const BACKTEST_FILE = path.join(DATA_DIR, 'backtest_history.json');

const MAX_SCANS_TO_KEEP = 100;
const MAX_SIGNALS_TO_KEEP = 50;
const MAX_TRADES_TO_KEEP = 300;

export class PersistentStorage {
  private inMemoryScans: ScanRecord[] = [];
  private inMemorySignals: TradeSignal[] = [];
  private inMemoryTrades: TradeLedgerItem[] = [];
  private inMemoryOutcomes: TradeOutcomeRecord[] = [];
  private inMemoryPois: PoiRecord[] = [];
  private inMemoryLifecycles: CandidateLifecycleRecord[] = [];
  private inMemoryOpportunities: Map<string, TradeOpportunity> = new Map();
  private inMemoryTerminalSetups: Set<string> = new Set();
  private inMemoryTelegramChatId: string | null = null;

  // CRITICAL REQUIREMENT 4: Starting balance $25.00, preserved current balance $91.00
  private inMemoryStartingBalance = 25.0;
  private inMemoryCurrentBalance = 91.0;

  private inMemorySettings: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
  };


  private lastScannerTimestamp = 0;
  private lastScannerStatus = 'IDLE';
  private isReady = false;
  private isTesting = false;
  private readyPromise: Promise<void>;

  constructor() {
    this.ensureDataDirectory();
    this.readyPromise = this.init();
  }

  public setTestingMode(val: boolean) {
    this.isTesting = val;
    if (val) {
      this.inMemoryOutcomes = this.inMemoryOutcomes.filter(
        (o) => !String(o.signalId || o.tradeId).startsWith('test-trade-') && !String(o.signalId || o.tradeId).startsWith('phantom-trade-')
      );
      this.inMemoryTrades = this.inMemoryTrades.filter(
        (t) => !String(t.id).startsWith('test-trade-') && !String(t.id).startsWith('phantom-trade-')
      );
    }
  }

  public restoreTestSnapshot(
    trades: TradeLedgerItem[],
    outcomes: TradeOutcomeRecord[],
    currentBalance: number,
    startingBalance: number
  ): void {
    this.inMemoryTrades = [...trades];
    this.inMemoryOutcomes = [...outcomes];
    this.inMemoryCurrentBalance = currentBalance;
    this.inMemoryStartingBalance = startingBalance;
  }

  private shouldPersist(): boolean {
    return !this.isTesting;
  }

  public async waitUntilReady(): Promise<void> {
    await this.readyPromise;
  }

  private ensureDataDirectory(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
    } catch (e) {
      console.error('[Storage] Error ensuring data directory exists:', e);
    }
  }

  private async init(): Promise<void> {
    console.log('[Storage] Initializing PersistentStorage persistence layer (Supabase PostgreSQL)...');

    // 1. First immediately load local JSON backups so in-memory is fully populated
    this.initLocalBackups();

    // 2. If Supabase is available, sync and load from Supabase PostgreSQL
    if (isSupabaseConfigured() && supabase && this.shouldPersist()) {
      try {
        await this.initSupabaseData();
      } catch (err: any) {
        console.warn('[Storage] Supabase initialization warning (resilient local cache will be used):', err?.message || err);
      }
    } else {
      console.log('[Storage] Supabase credentials not provided in environment. Running with verified local JSON persistence.');
    }

    this.isReady = true;
    console.log('[Storage] Initialization complete. Current balance: $' + this.inMemoryCurrentBalance);
  }

  private initLocalBackups(): void {
    try {
      if (fs.existsSync(ACCOUNT_FILE)) {
        const raw = fs.readFileSync(ACCOUNT_FILE, 'utf-8');
        const acc = JSON.parse(raw);
        if (typeof acc.currentBalance === 'number' && !isNaN(acc.currentBalance)) {
          this.inMemoryCurrentBalance = acc.currentBalance;
        }
        if (typeof acc.startingBalance === 'number' && !isNaN(acc.startingBalance)) {
          this.inMemoryStartingBalance = acc.startingBalance;
        }
      }

      if (fs.existsSync(SETTINGS_FILE)) {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        this.inMemorySettings = { ...this.inMemorySettings, ...data };
      }

      if (fs.existsSync(TRADES_FILE)) {
        const raw = fs.readFileSync(TRADES_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.inMemoryTrades = list;
        }
      }

      if (fs.existsSync(OUTCOMES_FILE)) {
        const raw = fs.readFileSync(OUTCOMES_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.inMemoryOutcomes = list;
        }
      }

      if (fs.existsSync(SIGNALS_FILE)) {
        const raw = fs.readFileSync(SIGNALS_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.inMemorySignals = list;
        }
      }

      if (fs.existsSync(SCANS_FILE)) {
        const raw = fs.readFileSync(SCANS_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.inMemoryScans = list;
        }
      }

      if (fs.existsSync(OPPS_FILE)) {
        const raw = fs.readFileSync(OPPS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          this.inMemoryOpportunities = new Map(data.map((o: any) => [o.id, o]));
        } else if (typeof data === 'object' && data !== null) {
          this.inMemoryOpportunities = new Map(Object.entries(data));
        }
      }

      if (fs.existsSync(TERMINAL_FILE)) {
        const raw = fs.readFileSync(TERMINAL_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.inMemoryTerminalSetups = new Set(list);
        }
      }

      if (fs.existsSync(TELEGRAM_CHAT_FILE)) {
        const raw = fs.readFileSync(TELEGRAM_CHAT_FILE, 'utf-8');
        const chatData = JSON.parse(raw);
        if (chatData?.chatId) {
          this.inMemoryTelegramChatId = String(chatData.chatId);
        }
      }
    } catch (e: any) {
      console.error('[Storage] Error during initLocalBackups:', e?.message || e);
    }
  }

  private async initSupabaseData(): Promise<void> {
    if (!supabase) return;

    // 1. Account State
    try {
      const { data: accData, error: accErr } = await supabase
        .from('account_state')
        .select('*')
        .eq('id', 'main')
        .maybeSingle();

      if (accErr) {
        console.warn('[Storage] Error fetching account_state from Supabase:', accErr.message);
      } else if (accData) {
        const curBal = Number(accData.current_balance ?? accData.currentBalance);
        if (!isNaN(curBal)) {
          this.inMemoryCurrentBalance = curBal;
        }
        const startBal = Number(accData.starting_balance ?? accData.startingBalance);
        if (!isNaN(startBal) && startBal > 0) {
          this.inMemoryStartingBalance = startBal;
        }
      } else {
        // Table exists but record does not: Seed with preserved balance $91.00
        await supabase.from('account_state').upsert({
          id: 'main',
          starting_balance: this.inMemoryStartingBalance,
          current_balance: this.inMemoryCurrentBalance,
          updated_at: new Date().toISOString(),
        });
      }
    } catch (e: any) {
      console.warn('[Storage] Supabase account_state query skipped:', e?.message || e);
    }

    // 2. App Settings
    try {
      const { data: setData, error: setErr } = await supabase
        .from('app_settings')
        .select('*')
        .eq('id', 'main')
        .maybeSingle();

      if (!setErr && setData?.data) {
        this.inMemorySettings = { ...this.inMemorySettings, ...setData.data };
      } else if (!setData && this.inMemorySettings) {
        // Seed settings
        await supabase.from('app_settings').upsert({
          id: 'main',
          data: this.inMemorySettings,
          updated_at: new Date().toISOString(),
        });
      }
    } catch (e: any) {
      console.warn('[Storage] Supabase app_settings query error:', e?.message || e);
    }

    // 3. Trade Ledger
    try {
      const { data: tradeRows, error: tradeErr } = await supabase
        .from('trade_ledger')
        .select('*')
        .order('trade_number', { ascending: false })
        .limit(MAX_TRADES_TO_KEEP);

      if (!tradeErr && Array.isArray(tradeRows) && tradeRows.length > 0) {
        this.inMemoryTrades = tradeRows.map((r) => this.parseTradeRow(r));
      } else if (!tradeErr && tradeRows?.length === 0 && this.inMemoryTrades.length > 0) {
        // Seed remote with existing local trades
        for (const t of this.inMemoryTrades) {
          await supabase.from('trade_ledger').upsert(this.formatTradeRow(t));
        }
      }
    } catch (e: any) {
      console.warn('[Storage] Supabase trade_ledger query error:', e?.message || e);
    }

    // 4. Trade Outcomes
    try {
      const { data: outcomeRows, error: outErr } = await supabase
        .from('trade_outcomes')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(500);

      if (!outErr && Array.isArray(outcomeRows) && outcomeRows.length > 0) {
        this.inMemoryOutcomes = outcomeRows.map((r) => this.parseOutcomeRow(r));
      } else if (!outErr && outcomeRows?.length === 0 && this.inMemoryOutcomes.length > 0) {
        for (const out of this.inMemoryOutcomes) {
          await supabase.from('trade_outcomes').upsert(this.formatOutcomeRow(out));
        }
      }
    } catch (e: any) {
      console.warn('[Storage] Supabase trade_outcomes query error:', e?.message || e);
    }

    // 5. Signals
    try {
      const { data: sigRows, error: sigErr } = await supabase
        .from('signals')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(MAX_SIGNALS_TO_KEEP);

      if (!sigErr && Array.isArray(sigRows) && sigRows.length > 0) {
        this.inMemorySignals = sigRows.map((r) => r.raw_data || r);
      } else if (!sigErr && sigRows?.length === 0 && this.inMemorySignals.length > 0) {
        for (const s of this.inMemorySignals) {
          await supabase.from('signals').upsert({ id: s.id, timestamp: s.timestamp, raw_data: s });
        }
      }
    } catch (e: any) {
      console.warn('[Storage] Supabase signals query error:', e?.message || e);
    }

    // 6. Scans
    try {
      const { data: scanRows, error: scanErr } = await supabase
        .from('scans')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(MAX_SCANS_TO_KEEP);

      if (!scanErr && Array.isArray(scanRows) && scanRows.length > 0) {
        this.inMemoryScans = scanRows.map((r) => r.raw_data || r);
      } else if (!scanErr && scanRows?.length === 0 && this.inMemoryScans.length > 0) {
        for (const sc of this.inMemoryScans) {
          await supabase.from('scans').upsert({ id: sc.id, timestamp: sc.timestamp, status: sc.status, raw_data: sc });
        }
      }
    } catch (e: any) {
      console.warn('[Storage] Supabase scans query error:', e?.message || e);
    }

    // 7. Opportunities
    try {
      const { data: oppRows, error: oppErr } = await supabase
        .from('opportunities')
        .select('*')
        .order('last_updated_time', { ascending: false })
        .limit(200);

      if (!oppErr && Array.isArray(oppRows) && oppRows.length > 0) {
        this.inMemoryOpportunities.clear();
        for (const r of oppRows) {
          const opp = r.raw_data || r;
          if (opp.id) this.inMemoryOpportunities.set(opp.id, opp);
        }
      } else if (!oppErr && oppRows?.length === 0 && this.inMemoryOpportunities.size > 0) {
        for (const opp of this.inMemoryOpportunities.values()) {
          await supabase.from('opportunities').upsert({ id: opp.id, last_updated_time: opp.lastUpdatedTime, raw_data: opp });
        }
      }
    } catch (e: any) {
      console.warn('[Storage] Supabase opportunities query error:', e?.message || e);
    }

    // 8. Telegram Config
    try {
      const { data: tgData } = await supabase
        .from('telegram_config')
        .select('*')
        .eq('id', 'main')
        .maybeSingle();

      if (tgData?.chat_id) {
        this.inMemoryTelegramChatId = String(tgData.chat_id);
      } else if (this.inMemoryTelegramChatId) {
        await supabase.from('telegram_config').upsert({
          id: 'main',
          chat_id: this.inMemoryTelegramChatId,
          registered_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
    } catch (e: any) {
      console.warn('[Storage] Supabase telegram_config query error:', e?.message || e);
    }

    // 9. Terminal Setups
    try {
      const { data: termRows } = await supabase.from('terminal_setups').select('*');
      if (Array.isArray(termRows) && termRows.length > 0) {
        for (const r of termRows) {
          if (r.setup_key) this.inMemoryTerminalSetups.add(r.setup_key);
        }
      } else if (this.inMemoryTerminalSetups.size > 0) {
        for (const key of this.inMemoryTerminalSetups) {
          await supabase.from('terminal_setups').upsert({ id: key.replace(/\//g, '_'), setup_key: key });
        }
      }
    } catch (e: any) {
      console.warn('[Storage] Supabase terminal_setups query error:', e?.message || e);
    }

    // Sync state to local files to ensure disk parity
    this.syncJsonBackups();
  }

  private formatTradeRow(trade: TradeLedgerItem): any {
    return {
      id: trade.id,
      trade_number: trade.tradeNumber ?? null,
      date: trade.date ?? null,
      iso_time: trade.isoTime ?? null,
      asset: trade.asset ?? 'XAU/USD',
      direction: trade.direction ?? null,
      entry: trade.entry !== undefined ? Number(trade.entry) : null,
      sl: trade.sl !== undefined ? Number(trade.sl) : null,
      sl_points: trade.slPoints !== undefined ? Number(trade.slPoints) : null,
      tp1: trade.tp1 !== undefined ? Number(trade.tp1) : null,
      tp1_points: trade.tp1Points !== undefined ? Number(trade.tp1Points) : null,
      tp2: trade.tp2 !== undefined ? Number(trade.tp2) : null,
      tp2_points: trade.tp2Points !== undefined ? Number(trade.tp2Points) : null,
      rr: trade.rr ?? null,
      risk_percent: trade.riskPercent !== undefined ? Number(trade.riskPercent) : null,
      risk_amount: trade.riskAmount !== undefined ? Number(trade.riskAmount) : null,
      lot_size: trade.lotSize !== undefined ? Number(trade.lotSize) : 0.01,
      confidence: trade.confidence !== undefined ? Number(trade.confidence) : null,
      setup: trade.setup ?? null,
      result: trade.result ?? null,
      is_active: trade.isActive ?? false,
      pl: trade.pl !== undefined ? Number(trade.pl) : 0,
      realized_pnl: trade.realizedPnl !== undefined ? Number(trade.realizedPnl) : (trade.pl !== undefined ? Number(trade.pl) : 0),
      balance_after_trade: trade.balanceAfterTrade !== undefined ? Number(trade.balanceAfterTrade) : null,
      exit_price: trade.exitPrice !== undefined ? Number(trade.exitPrice) : null,
      exit_time: trade.exitTime ?? null,
      closed_at: trade.closedAt ?? null,
      close_reason: trade.closeReason ?? null,
      source: trade.source ?? 'MANUAL',
      broker_deal_id: trade.brokerDealId ?? null,
      broker_order_id: trade.brokerOrderId ?? null,
      theoretical_tp1_profit: trade.theoreticalTp1Profit !== undefined ? Number(trade.theoreticalTp1Profit) : null,
      theoretical_tp2_profit: trade.theoreticalTp2Profit !== undefined ? Number(trade.theoreticalTp2Profit) : null,
      notes: trade.notes ?? null,
      signal_id: trade.signalId ?? null,
      setup_id: trade.setupId ?? null,
      raw_data: trade,
      updated_at: new Date().toISOString(),
    };
  }

  private parseTradeRow(row: any): TradeLedgerItem {
    if (row.raw_data && typeof row.raw_data === 'object') {
      return {
        ...row.raw_data,
        id: row.id,
        tradeNumber: row.trade_number ?? row.raw_data.tradeNumber,
        result: row.result ?? row.raw_data.result,
        isActive: row.is_active !== undefined ? row.is_active : row.raw_data.isActive,
        pl: row.pl !== null && row.pl !== undefined ? Number(row.pl) : row.raw_data.pl,
        realizedPnl: row.realized_pnl !== null && row.realized_pnl !== undefined ? Number(row.realized_pnl) : row.raw_data.realizedPnl,
        balanceAfterTrade: row.balance_after_trade !== null && row.balance_after_trade !== undefined ? Number(row.balance_after_trade) : row.raw_data.balanceAfterTrade,
      };
    }
    return {
      id: row.id,
      tradeNumber: row.trade_number,
      date: row.date || '',
      isoTime: row.iso_time || '',
      asset: row.asset || 'XAU/USD',
      direction: row.direction || 'BUY',
      entry: Number(row.entry || 0),
      sl: Number(row.sl || 0),
      slPoints: Number(row.sl_points || 0),
      tp1: Number(row.tp1 || 0),
      tp1Points: Number(row.tp1_points || 0),
      tp2: row.tp2 ? Number(row.tp2) : undefined,
      tp2Points: row.tp2_points ? Number(row.tp2_points) : undefined,
      rr: row.rr || '1:1.5',
      riskPercent: Number(row.risk_percent || 15),
      riskAmount: Number(row.risk_amount || 0),
      lotSize: Number(row.lot_size || 0.01),
      confidence: Number(row.confidence || 75),
      setup: row.setup || 'Manual',
      result: row.result || 'OPEN',
      isActive: Boolean(row.is_active),
      pl: Number(row.pl || 0),
      realizedPnl: Number(row.realized_pnl || 0),
      balanceAfterTrade: Number(row.balance_after_trade || 0),
      exitPrice: row.exit_price ? Number(row.exit_price) : undefined,
      exitTime: row.exit_time,
      closedAt: row.closed_at ? Number(row.closed_at) : undefined,
      closeReason: row.close_reason,
      source: row.source || 'MANUAL',
      brokerDealId: row.broker_deal_id,
      brokerOrderId: row.broker_order_id,
      theoreticalTp1Profit: row.theoretical_tp1_profit ? Number(row.theoretical_tp1_profit) : undefined,
      theoreticalTp2Profit: row.theoretical_tp2_profit ? Number(row.theoretical_tp2_profit) : undefined,
      notes: row.notes,
      signalId: row.signal_id,
      setupId: row.setup_id,
    };
  }

  private formatOutcomeRow(out: TradeOutcomeRecord): any {
    const sigId = out.signalId || out.tradeId;
    return {
      signal_id: sigId,
      trade_id: out.tradeId ?? null,
      direction: out.direction ?? null,
      order_type: out.orderType ?? null,
      entry: out.entry !== undefined ? Number(out.entry) : null,
      stop_loss: out.stopLoss !== undefined ? Number(out.stopLoss) : null,
      tp1: out.tp1 !== undefined ? Number(out.tp1) : null,
      tp2: out.tp2 !== undefined ? Number(out.tp2) : null,
      outcome: out.outcome ?? null,
      timestamp: out.timestamp ?? Date.now(),
      iso_time: out.isoTime ?? new Date().toISOString(),
      chat_id: out.chatId ?? null,
      user_id: out.userId ?? null,
      pl: out.pl !== undefined ? Number(out.pl) : 0,
      realized_pnl: out.realizedPnl !== undefined ? Number(out.realizedPnl) : (out.pl !== undefined ? Number(out.pl) : 0),
      exit_price: out.exitPrice !== undefined ? Number(out.exitPrice) : null,
      source: out.source ?? 'MANUAL',
      broker_deal_id: out.brokerDealId ?? null,
      broker_order_id: out.brokerOrderId ?? null,
      closed_at: out.closedAt ?? null,
      close_reason: out.closeReason ?? null,
      notes: out.notes ?? null,
      raw_data: out,
    };
  }

  private parseOutcomeRow(row: any): TradeOutcomeRecord {
    if (row.raw_data && typeof row.raw_data === 'object') {
      return {
        ...row.raw_data,
        signalId: row.signal_id,
        outcome: row.outcome ?? row.raw_data.outcome,
        realizedPnl: row.realized_pnl !== null && row.realized_pnl !== undefined ? Number(row.realized_pnl) : row.raw_data.realizedPnl,
        pl: row.pl !== null && row.pl !== undefined ? Number(row.pl) : row.raw_data.pl,
      };
    }
    return {
      signalId: row.signal_id,
      tradeId: row.trade_id,
      direction: row.direction,
      orderType: row.order_type,
      entry: Number(row.entry || 0),
      stopLoss: Number(row.stop_loss || 0),
      tp1: Number(row.tp1 || 0),
      tp2: row.tp2 ? Number(row.tp2) : undefined,
      outcome: row.outcome,
      timestamp: Number(row.timestamp || Date.now()),
      isoTime: row.iso_time || new Date().toISOString(),
      chatId: row.chat_id,
      userId: row.user_id,
      pl: Number(row.pl || 0),
      realizedPnl: Number(row.realized_pnl || 0),
      exitPrice: row.exit_price ? Number(row.exit_price) : undefined,
      source: row.source || 'MANUAL',
      brokerDealId: row.broker_deal_id,
      brokerOrderId: row.broker_order_id,
      closedAt: row.closed_at ? Number(row.closed_at) : undefined,
      closeReason: row.close_reason,
      notes: row.notes,
    };
  }

  private syncJsonBackups(): void {
    if (!this.shouldPersist()) return;
    try {
      this.ensureDataDirectory();
      fs.writeFileSync(SCANS_FILE, JSON.stringify(this.inMemoryScans, null, 2), 'utf-8');
      fs.writeFileSync(SIGNALS_FILE, JSON.stringify(this.inMemorySignals, null, 2), 'utf-8');
      fs.writeFileSync(TRADES_FILE, JSON.stringify(this.inMemoryTrades, null, 2), 'utf-8');
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.inMemorySettings, null, 2), 'utf-8');
      fs.writeFileSync(OUTCOMES_FILE, JSON.stringify(this.inMemoryOutcomes, null, 2), 'utf-8');
      fs.writeFileSync(
        ACCOUNT_FILE,
        JSON.stringify(
          {
            currentBalance: this.inMemoryCurrentBalance,
            startingBalance: this.inMemoryStartingBalance,
          },
          null,
          2
        ),
        'utf-8'
      );
      fs.writeFileSync(TERMINAL_FILE, JSON.stringify(Array.from(this.inMemoryTerminalSetups), null, 2), 'utf-8');
      fs.writeFileSync(OPPS_FILE, JSON.stringify(Object.fromEntries(this.inMemoryOpportunities), null, 2), 'utf-8');
      if (this.inMemoryTelegramChatId) {
        fs.writeFileSync(
          TELEGRAM_CHAT_FILE,
          JSON.stringify(
            {
              chatId: this.inMemoryTelegramChatId,
              registeredAt: new Date().toISOString(),
            },
            null,
            2
          ),
          'utf-8'
        );
      }
    } catch (e) {
      console.error('[Storage] Error during syncJsonBackups:', e);
    }
  }

  // =========================================================================
  // Telegram Chat Persistence
  // =========================================================================
  public getTelegramChatId(): string | null {
    return this.inMemoryTelegramChatId;
  }

  public async saveTelegramChatId(chatId: string): Promise<void> {
    if (!chatId) return;
    this.inMemoryTelegramChatId = String(chatId);
    this.syncJsonBackups();

    if (supabase && this.shouldPersist()) {
      try {
        await supabase.from('telegram_config').upsert({
          id: 'main',
          chat_id: String(chatId),
          registered_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      } catch (err: any) {
        console.error('[Storage] Supabase saveTelegramChatId error:', err?.message || err);
      }
    }
  }

  // =========================================================================
  // Scans Persistence
  // =========================================================================
  public saveScan(record: ScanRecord): ScanRecord[] {
    try {
      this.lastScannerTimestamp = record.timestamp || Date.now();
      this.lastScannerStatus = record.status || 'SUCCESS';

      this.inMemoryScans.unshift(record);
      if (this.inMemoryScans.length > MAX_SCANS_TO_KEEP) {
        this.inMemoryScans = this.inMemoryScans.slice(0, MAX_SCANS_TO_KEEP);
      }

      if (supabase && this.shouldPersist() && record.id) {
        supabase
          .from('scans')
          .upsert({
            id: record.id,
            timestamp: record.timestamp,
            status: record.status,
            raw_data: record,
          })
          .then(({ error }) => {
            if (error) console.error('[Storage] Supabase saveScan error:', error.message);
          });
      }

      this.syncJsonBackups();
      return [...this.inMemoryScans];
    } catch (err) {
      console.error('[Storage] Error saving scan:', err);
      return [...this.inMemoryScans];
    }
  }

  public getScans(limit = 100): ScanRecord[] {
    return this.inMemoryScans.slice(0, limit);
  }

  // =========================================================================
  // Signals Persistence
  // =========================================================================
  public saveSignal(signal: TradeSignal): TradeSignal[] {
    try {
      const existingIdx = this.inMemorySignals.findIndex((s) => s.id === signal.id);
      if (existingIdx >= 0) {
        this.inMemorySignals[existingIdx] = signal;
      } else {
        this.inMemorySignals.unshift(signal);
      }

      if (this.inMemorySignals.length > MAX_SIGNALS_TO_KEEP) {
        this.inMemorySignals = this.inMemorySignals.slice(0, MAX_SIGNALS_TO_KEEP);
      }

      if (supabase && this.shouldPersist() && signal.id) {
        supabase
          .from('signals')
          .upsert({
            id: signal.id,
            timestamp: signal.timestamp,
            raw_data: signal,
          })
          .then(({ error }) => {
            if (error) console.error('[Storage] Supabase saveSignal error:', error.message);
          });
      }

      this.syncJsonBackups();
      return [...this.inMemorySignals];
    } catch (err) {
      console.error('[Storage] Error saving signal:', err);
      return [...this.inMemorySignals];
    }
  }

  public getSignals(limit = 50): TradeSignal[] {
    return this.inMemorySignals.slice(0, limit);
  }

  public getSignal(id: string): TradeSignal | undefined {
    return this.inMemorySignals.find((s) => s.id === id);
  }

  public getSignalById(id: string): TradeSignal | undefined {
    return this.getSignal(id);
  }

  public async getSignalFromStorage(id: string): Promise<TradeSignal | undefined> {
    // 1. Check in-memory first
    const memSignal = this.getSignal(id);
    if (memSignal) return memSignal;

    // 2. Try fetching from Supabase
    if (supabase && this.shouldPersist()) {
      try {
        const { data, error } = await supabase.from('signals').select('*').eq('id', id).maybeSingle();
        if (!error && data) {
          const signalData: TradeSignal = data.raw_data || data;
          if (!this.inMemorySignals.some((s) => s.id === signalData.id)) {
            this.inMemorySignals.unshift(signalData);
          }
          return signalData;
        }
      } catch (err) {
        console.error(`[Storage] Error fetching signal ${id} from Supabase:`, err);
      }
    }

    // 3. Try reading local saved_signals.json backup if available
    try {
      if (fs.existsSync(SIGNALS_FILE)) {
        const raw = fs.readFileSync(SIGNALS_FILE, 'utf-8');
        const list: TradeSignal[] = JSON.parse(raw || '[]');
        const fileSignal = list.find((s) => s.id === id);
        if (fileSignal) {
          if (!this.inMemorySignals.some((s) => s.id === fileSignal.id)) {
            this.inMemorySignals.unshift(fileSignal);
          }
          return fileSignal;
        }
      }
    } catch (err) {
      console.error(`[Storage] Error reading saved_signals.json for signal ${id}:`, err);
    }

    // 4. Try loading the corresponding opportunity if signal is not found
    const opp = this.getOpportunity(id) || this.getOpportunities().find((o) => o.signalId === id);
    if (opp) {
      const dir = opp.direction === 'BUY' ? 'BUY NOW' : 'SELL NOW';
      const rebuiltSignal: TradeSignal = {
        id: opp.signalId || opp.id,
        timestamp: opp.firstObservedTime,
        asset: 'XAU/USD',
        signal: dir,
        currentPrice: opp.entry,
        entry: opp.entry,
        stopLoss: opp.stopLoss,
        slPoints: Math.round(Math.abs(opp.entry - opp.stopLoss) / 0.1),
        tp1: opp.tp1,
        tp1Points: Math.round(Math.abs(opp.tp1 - opp.entry) / 0.1),
        tp1Rr: 1.5,
        tp1RrString: '1:1.50',
        tp2: opp.tp2,
        tp2Points: Math.round(Math.abs(opp.tp2 - opp.entry) / 0.1),
        tp2Rr: 3.0,
        tp2RrString: '1:3.00',
        primaryTarget: 'TP1',
        rr: '1:1.50',
        rrRatio: 1.5,
        riskPercent: 15,
        riskAmount: 0,
        potentialProfit: 0,
        potentialLoss: 0,
        recommendedLotSize: 0.01,
        confidence: opp.confidence,
        timeframe: opp.timeframe,
        setup: opp.setupName,
        mainReasons: ['Rebuilt from opportunity snapshot'],
        invalidation: `Close candle below ${opp.stopLoss}`,
      };
      if (!this.inMemorySignals.some((s) => s.id === rebuiltSignal.id)) {
        this.inMemorySignals.unshift(rebuiltSignal);
      }
      return rebuiltSignal;
    }

    return undefined;
  }

  // =========================================================================
  // Trade Ledger Persistence
  // =========================================================================
  public saveTrade(trade: TradeLedgerItem): TradeLedgerItem[] {
    try {
      const isResultOpen = trade.result === 'OPEN';
      const highestNum = Math.max(0, ...this.inMemoryTrades.map((t) => t.tradeNumber || 0));
      const tradeNumber = trade.tradeNumber || highestNum + 1;
      const isoTime = trade.isoTime || new Date().toISOString();
      const date =
        trade.date ||
        new Date().toLocaleDateString('ar-EG', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });

      const tradeWithActive: TradeLedgerItem = {
        ...trade,
        tradeNumber,
        isoTime,
        date,
        isActive: trade.isActive !== undefined ? trade.isActive : isResultOpen,
      };

      const existingIdx = this.inMemoryTrades.findIndex((t) => t.id === tradeWithActive.id);
      if (existingIdx >= 0) {
        this.inMemoryTrades[existingIdx] = tradeWithActive;
      } else {
        this.inMemoryTrades.unshift(tradeWithActive);
      }

      if (this.inMemoryTrades.length > MAX_TRADES_TO_KEEP) {
        this.inMemoryTrades = this.inMemoryTrades.slice(0, MAX_TRADES_TO_KEEP);
      }

      // Asynchronous Supabase write
      if (supabase && this.shouldPersist() && tradeWithActive.id) {
        supabase
          .from('trade_ledger')
          .upsert(this.formatTradeRow(tradeWithActive))
          .then(({ error }) => {
            if (error) console.error(`[Storage] Supabase saveTrade error for ${tradeWithActive.id}:`, error.message);
          });
      }

      this.syncJsonBackups();
      return [...this.inMemoryTrades];
    } catch (err) {
      console.error('[Storage] Error saving trade:', err);
      return [...this.inMemoryTrades];
    }
  }

  public async saveTradeAsync(trade: TradeLedgerItem): Promise<TradeLedgerItem[]> {
    try {
      const isResultOpen = trade.result === 'OPEN';
      const highestNum = Math.max(0, ...this.inMemoryTrades.map((t) => t.tradeNumber || 0));
      const tradeNumber = trade.tradeNumber || highestNum + 1;
      const isoTime = trade.isoTime || new Date().toISOString();
      const date =
        trade.date ||
        new Date().toLocaleDateString('ar-EG', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });

      const tradeWithActive: TradeLedgerItem = {
        ...trade,
        tradeNumber,
        isoTime,
        date,
        isActive: trade.isActive !== undefined ? trade.isActive : isResultOpen,
      };

      const existingIdx = this.inMemoryTrades.findIndex((t) => t.id === tradeWithActive.id);
      if (existingIdx >= 0) {
        this.inMemoryTrades[existingIdx] = tradeWithActive;
      } else {
        this.inMemoryTrades.unshift(tradeWithActive);
      }

      if (this.inMemoryTrades.length > MAX_TRADES_TO_KEEP) {
        this.inMemoryTrades = this.inMemoryTrades.slice(0, MAX_TRADES_TO_KEEP);
      }

      this.syncJsonBackups();

      if (supabase && this.shouldPersist() && tradeWithActive.id) {
        try {
          const { error } = await supabase.from('trade_ledger').upsert(this.formatTradeRow(tradeWithActive));
          if (error) console.error(`[Storage] Supabase saveTradeAsync error for ${tradeWithActive.id}:`, error.message);
        } catch (err: any) {
          console.error(`[Storage] Supabase saveTradeAsync exception for ${tradeWithActive.id}:`, err?.message || err);
        }
      }

      return [...this.inMemoryTrades];
    } catch (err) {
      console.error('[Storage] Error saving trade async:', err);
      return [...this.inMemoryTrades];
    }
  }

  public async updateBalanceFromManualTrade(deltaPnl: number): Promise<number> {
    this.inMemoryCurrentBalance = Number((this.inMemoryCurrentBalance + deltaPnl).toFixed(2));
    this.syncJsonBackups();

    if (supabase && this.shouldPersist()) {
      try {
        await supabase.from('account_state').upsert({
          id: 'main',
          current_balance: this.inMemoryCurrentBalance,
          starting_balance: this.inMemoryStartingBalance,
          updated_at: new Date().toISOString(),
        });
      } catch (err: any) {
        console.error('[Storage] Supabase account_state update error:', err?.message || err);
      }
    }
    return this.inMemoryCurrentBalance;
  }

  public getTradeLedger(limit = 100): TradeLedgerItem[] {
    return this.inMemoryTrades.slice(0, limit);
  }

  public getTrades(limit = 100): TradeLedgerItem[] {
    return this.getTradeLedger(limit);
  }

  public getTrade(id: string): TradeLedgerItem | undefined {
    return this.inMemoryTrades.find((t) => t.id === id);
  }

  public getTradeOutcomes(limit = 200): TradeOutcomeRecord[] {
    return this.inMemoryOutcomes.slice(0, limit);
  }

  public getTradeOutcome(signalOrTradeId: string): TradeOutcomeRecord | undefined {
    return this.inMemoryOutcomes.find((o) => o.signalId === signalOrTradeId || o.tradeId === signalOrTradeId);
  }

  // =========================================================================
  // Trade Outcome Recording (Telegram & Manual Resolution)
  // =========================================================================
  public recordTradeOutcome(
    record: TradeOutcomeRecord,
    signalData?: Partial<TradeSignal>
  ): {
    success: boolean;
    isDuplicate: boolean;
    outcome: TradeOutcomeRecord;
    trade?: TradeLedgerItem;
    message?: string;
  } {
    try {
      const existing = this.getTradeOutcome(record.signalId) || (record.tradeId ? this.getTradeOutcome(record.tradeId) : undefined);
      const existingTrade = this.inMemoryTrades.find(
        (t) => t.id === record.signalId || t.id === record.tradeId || (record.signalId && t.signalId === record.signalId)
      );

      // If referenced trade does not exist, instantiate it from signalData if available
      let tradeToUpdate = existingTrade;
      if (!tradeToUpdate) {
        if (signalData) {
          const sig = signalData as any;
          const highestNum = Math.max(0, ...this.inMemoryTrades.map((t) => t.tradeNumber || 0));
          const newTrade: TradeLedgerItem = {
            id: record.tradeId || record.signalId || `trade_${Date.now()}`,
            signalId: record.signalId,
            tradeNumber: highestNum + 1,
            date: new Date(sig.timestamp || Date.now()).toLocaleDateString('ar-EG', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
            isoTime: new Date(sig.timestamp || Date.now()).toISOString(),
            asset: sig.asset || 'XAU/USD',
            direction: (sig.direction || sig.signal || record.direction || 'BUY') as any,
            entry: Number(sig.entry || record.entry || 0),
            sl: Number(sig.stopLoss || sig.sl || record.stopLoss || 0),
            slPoints: sig.slPoints || Math.round(Math.abs(Number(sig.entry || 0) - Number(sig.stopLoss || sig.sl || 0)) / 0.1),
            tp1: Number(sig.tp1 || record.tp1 || 0),
            tp1Points: sig.tp1Points || Math.round(Math.abs(Number(sig.tp1 || 0) - Number(sig.entry || 0)) / 0.1),
            tp2: sig.tp2 ? Number(sig.tp2) : undefined,
            tp2Points: sig.tp2Points || (sig.tp2 ? Math.round(Math.abs(Number(sig.tp2) - Number(sig.entry || 0)) / 0.1) : undefined),
            lotSize: sig.standardLot ?? sig.recommendedLotSize ?? sig.lotSize ?? 0.01,
            riskPercent: sig.riskPercent || 15,
            riskAmount: sig.riskAmount || 1.5,
            confidence: sig.confidence || 75,
            setup: sig.setup || 'Manual Trade',
            rr: sig.rr || '1:1.5',
            result: 'OPEN',
            pl: 0,
            balanceAfterTrade: this.inMemoryCurrentBalance || 91,
            isActive: false,
            source: (record.source as any) || 'MANUAL',
            notes: 'تم الدخول يدوياً عبر زر التليجرام',
          };
          this.inMemoryTrades.unshift(newTrade);
          tradeToUpdate = newTrade;
        } else {
          console.warn(`[Storage] recordTradeOutcome rejected: referenced trade "${record.tradeId || record.signalId}" not found in trade ledger.`);
          return {
            success: false,
            isDuplicate: false,
            outcome: record,
            message: 'TRADE_NOT_FOUND',
          };
        }
      }

      // 1. Authoritative Realized P&L Calculation
      let finalRealizedPnl: number;
      if (typeof record.realizedPnl === 'number' && !isNaN(record.realizedPnl)) {
        finalRealizedPnl = Number(record.realizedPnl.toFixed(2));
      } else if (typeof record.pl === 'number' && !isNaN(record.pl)) {
        finalRealizedPnl = Number(record.pl.toFixed(2));
      } else if (record.exitPrice !== undefined && typeof record.exitPrice === 'number' && !isNaN(record.exitPrice)) {
        const isBuy = String(record.direction || signalData?.signal || tradeToUpdate.direction || '').toUpperCase().includes('BUY');
        const entryPrice = Number(record.entry || tradeToUpdate.entry || signalData?.entry || record.exitPrice);
        const priceDiff = isBuy ? record.exitPrice - entryPrice : entryPrice - record.exitPrice;
        const lotSize = tradeToUpdate.lotSize || signalData?.recommendedLotSize || (signalData as any)?.lotSize || 0.01;
        finalRealizedPnl = Number((priceDiff * 100 * lotSize).toFixed(2));
      } else {
        finalRealizedPnl = 0;
      }

      // Enforce directional sign consistency with outcome if non-zero
      if (record.outcome === 'WIN' && finalRealizedPnl < 0) {
        finalRealizedPnl = Math.abs(finalRealizedPnl);
      } else if (record.outcome === 'LOSS' && finalRealizedPnl > 0) {
        finalRealizedPnl = -Math.abs(finalRealizedPnl);
      }

      record.realizedPnl = finalRealizedPnl;
      record.pl = finalRealizedPnl;
      const source = record.source || 'MANUAL';

      // 2. Idempotency Check: Avoid duplicate balance counting
      if (existing) {
        const existingPnl = typeof existing.realizedPnl === 'number' ? existing.realizedPnl : existing.pl;
        if (existing.outcome === record.outcome && existingPnl === finalRealizedPnl && source !== 'MT5') {
          return {
            success: true,
            isDuplicate: true,
            outcome: existing,
            trade: tradeToUpdate,
            message: `تم توثيق نتيجة هذه الصفقة مسبقاً (${existing.outcome === 'WIN' ? '🟢 رابحة' : '🔴 خاسرة'}) بقيمة $${finalRealizedPnl}.`,
          };
        }
      }

      if (tradeToUpdate.result === 'WIN' || tradeToUpdate.result === 'LOSS') {
        const existingTradePnl = typeof tradeToUpdate.realizedPnl === 'number' ? tradeToUpdate.realizedPnl : tradeToUpdate.pl || 0;
        if (tradeToUpdate.result === record.outcome && existingTradePnl === finalRealizedPnl && source !== 'MT5') {
          return {
            success: true,
            isDuplicate: true,
            outcome: { ...record, outcome: tradeToUpdate.result, realizedPnl: existingTradePnl },
            trade: tradeToUpdate,
            message: `تم توثيق نتيجة هذه الصفقة مسبقاً (${tradeToUpdate.result === 'WIN' ? '🟢 رابحة' : '🔴 خاسرة'}) بقيمة $${finalRealizedPnl}.`,
          };
        }
      }

      // 3. Update outcome list
      const outcomeIndex = this.inMemoryOutcomes.findIndex((o) => o.signalId === record.signalId || (record.tradeId && o.tradeId === record.tradeId));
      if (outcomeIndex >= 0) {
        this.inMemoryOutcomes[outcomeIndex] = record;
      } else {
        this.inMemoryOutcomes.unshift(record);
      }
      if (this.inMemoryOutcomes.length > 500) {
        this.inMemoryOutcomes = this.inMemoryOutcomes.slice(0, 500);
      }

      const isWin = record.outcome === 'WIN';
      const lotSize = tradeToUpdate.lotSize || signalData?.recommendedLotSize || (signalData as any)?.lotSize || 0.01;
      const entryPrice = Number(record.entry || tradeToUpdate.entry || signalData?.entry || 0);
      const tp1Price = Number(record.tp1 || tradeToUpdate.tp1 || signalData?.tp1 || 0);
      const tp2Price = Number(record.tp2 || tradeToUpdate.tp2 || signalData?.tp2 || 0);

      const theoreticalTp1Profit = Number((Math.abs(entryPrice - tp1Price) * 100 * lotSize).toFixed(2));
      const theoreticalTp2Profit = Number((Math.abs(entryPrice - tp2Price) * 100 * lotSize).toFixed(2));

      const previousPnl =
        typeof tradeToUpdate.realizedPnl === 'number'
          ? tradeToUpdate.realizedPnl
          : tradeToUpdate.result === 'WIN' || tradeToUpdate.result === 'LOSS'
          ? tradeToUpdate.pl || 0
          : 0;

      const delta = Number((finalRealizedPnl - previousPnl).toFixed(2));

      tradeToUpdate.result = record.outcome;
      tradeToUpdate.pl = finalRealizedPnl;
      tradeToUpdate.realizedPnl = finalRealizedPnl;
      tradeToUpdate.source = (source as any);
      if (record.brokerDealId) tradeToUpdate.brokerDealId = record.brokerDealId;
      if (record.brokerOrderId) tradeToUpdate.brokerOrderId = record.brokerOrderId;
      if (record.closedAt) tradeToUpdate.closedAt = record.closedAt;
      if (record.closeReason) tradeToUpdate.closeReason = record.closeReason;
      tradeToUpdate.theoreticalTp1Profit = theoreticalTp1Profit;
      tradeToUpdate.theoreticalTp2Profit = theoreticalTp2Profit;
      tradeToUpdate.exitPrice =
        record.exitPrice !== undefined ? record.exitPrice : isWin ? tradeToUpdate.tp1 || record.tp1 : tradeToUpdate.sl || record.stopLoss;
      tradeToUpdate.exitTime = new Date(record.timestamp || Date.now()).toISOString();
      tradeToUpdate.notes = `${tradeToUpdate.notes ? tradeToUpdate.notes + ' | ' : ''}النتيجة: ${isWin ? '🟢 رابحة' : '🔴 خاسرة'} [P&L: ${
        finalRealizedPnl >= 0 ? '+' : ''
      }$${finalRealizedPnl.toFixed(2)}] (${source})`;
      tradeToUpdate.isActive = false;

      this.inMemoryCurrentBalance = Number((this.inMemoryCurrentBalance + delta).toFixed(2));
      tradeToUpdate.balanceAfterTrade = this.inMemoryCurrentBalance;

      const updatedTrade = tradeToUpdate;

      // Supabase persistence
      if (supabase && this.shouldPersist()) {
        supabase
          .from('trade_outcomes')
          .upsert(this.formatOutcomeRow(record))
          .then(({ error }) => {
            if (error) console.error('[Storage] Supabase recordTradeOutcome error:', error.message);
          });
        supabase
          .from('trade_ledger')
          .upsert(this.formatTradeRow(updatedTrade))
          .then(({ error }) => {
            if (error) console.error('[Storage] Supabase saveTrade error in outcome:', error.message);
          });
        supabase
          .from('account_state')
          .upsert({
            id: 'main',
            current_balance: this.inMemoryCurrentBalance,
            starting_balance: this.inMemoryStartingBalance,
            updated_at: new Date().toISOString(),
          })
          .then(({ error }) => {
            if (error) console.error('[Storage] Supabase account_state update error:', error.message);
          });
      }

      this.syncJsonBackups();

      // Dispatch completed trade outcome notification
      telegramService.sendOutcomeNotification(record, updatedTrade).catch((err) => {
        console.error('[Storage] Telegram outcome alert dispatch error:', err);
      });

      return {
        success: true,
        isDuplicate: false,
        outcome: record,
        trade: updatedTrade,
      };
    } catch (err: any) {
      console.error('[Storage] Error recording outcome:', err);
      return {
        success: false,
        isDuplicate: false,
        outcome: record,
        message: err?.message || 'Failed to record trade outcome',
      };
    }
  }

  public async recordTradeOutcomeAsync(
    record: TradeOutcomeRecord,
    signalData?: Partial<TradeSignal>
  ): Promise<{
    success: boolean;
    isDuplicate: boolean;
    outcome: TradeOutcomeRecord;
    trade?: TradeLedgerItem;
    message?: string;
  }> {
    const res = this.recordTradeOutcome(record, signalData);
    if (res.success && res.trade && supabase && this.shouldPersist()) {
      try {
        await Promise.all([
          supabase.from('trade_outcomes').upsert(this.formatOutcomeRow(record)),
          supabase.from('trade_ledger').upsert(this.formatTradeRow(res.trade)),
          supabase.from('account_state').upsert({
            id: 'main',
            current_balance: this.inMemoryCurrentBalance,
            starting_balance: this.inMemoryStartingBalance,
            updated_at: new Date().toISOString(),
          }),
        ]);
      } catch (e: any) {
        console.error('[Storage] Supabase recordTradeOutcomeAsync write error:', e?.message || e);
      }
    }
    return res;
  }

  public reconcileMt5Trade(params: {
    signalOrTradeId: string;
    brokerDealId: string;
    brokerOrderId?: string;
    entryPrice?: number;
    exitPrice: number;
    lotSize?: number;
    realizedPnl: number;
    closedAt?: number;
    closeReason?: string;
    direction?: string;
  }): { success: boolean; trade?: TradeLedgerItem; message?: string } {
    try {
      const outcome: 'WIN' | 'LOSS' = params.realizedPnl >= 0 ? 'WIN' : 'LOSS';
      const record: TradeOutcomeRecord = {
        signalId: params.signalOrTradeId,
        tradeId: params.signalOrTradeId,
        direction: params.direction || 'BUY NOW',
        orderType: 'MARKET',
        entry: params.entryPrice || 0,
        stopLoss: 0,
        tp1: 0,
        tp2: 0,
        outcome,
        realizedPnl: params.realizedPnl,
        exitPrice: params.exitPrice,
        source: 'MT5',
        brokerDealId: params.brokerDealId,
        brokerOrderId: params.brokerOrderId,
        closedAt: params.closedAt || Date.now(),
        closeReason: params.closeReason || 'MT5_CLOSED',
        timestamp: params.closedAt || Date.now(),
        isoTime: new Date(params.closedAt || Date.now()).toISOString(),
      };
      const res = this.recordTradeOutcome(record);
      return {
        success: res.success,
        trade: res.trade,
        message: res.message,
      };
    } catch (e: any) {
      console.error('[Storage] reconcileMt5Trade error:', e);
      return { success: false, message: e?.message };
    }
  }

  // =========================================================================
  // Stats & Dashboard
  // =========================================================================
  public getDashboardStats(): DashboardStatsResult {
    const closedTrades = this.inMemoryTrades.filter((t) => t.result === 'WIN' || t.result === 'LOSS');
    const wins = closedTrades.filter((t) => t.result === 'WIN').length;
    const losses = closedTrades.filter((t) => t.result === 'LOSS').length;
    const totalClosed = wins + losses;
    const winRate = totalClosed > 0 ? Number(((wins / totalClosed) * 100).toFixed(1)) : 0;
    const totalPl = Number(closedTrades.reduce((acc, t) => acc + (t.pl || 0), 0).toFixed(2));

    const todayStats = this.getTodayStats();

    return {
      totalScans: this.inMemoryScans.length,
      totalSignals: this.inMemorySignals.length,
      buyCount: this.inMemoryScans.filter((s) => s.signal === 'BUY NOW' || s.signal === 'BUY LIMIT').length,
      sellCount: this.inMemoryScans.filter((s) => s.signal === 'SELL NOW' || s.signal === 'SELL LIMIT').length,
      limitCount: this.inMemoryScans.filter((s) => s.signal === 'BUY LIMIT' || s.signal === 'SELL LIMIT').length,
      noTradeCount: this.inMemoryScans.filter((s) => s.signal === 'NO TRADE').length,
      wins,
      losses,
      winRate,
      totalPl,
      startingBalance: this.inMemoryStartingBalance,
      currentBalance: this.inMemoryCurrentBalance,
      currentRiskPercent: this.inMemorySettings.riskPerTrade,
      recentSignals: this.inMemorySignals.slice(0, 10),
      recentScans: this.inMemoryScans.slice(0, 10),
      lastScanTime: this.lastScannerTimestamp,
      lastScanStatus: this.lastScannerStatus,
      scannerHealth: 'HEALTHY',
      todayStats,
    };
  }

  public getPerformanceStats() {
    return this.getDashboardStats();
  }

  public getTodayStats(todayDateStr?: string): DailyTradeStats {
    const today = todayDateStr || new Date().toISOString().split('T')[0];
    const todayTrades = this.inMemoryTrades.filter((t) => {
      if (t.isoTime) return t.isoTime.startsWith(today);
      return true;
    });

    const tradesCount = todayTrades.length;
    const wins = todayTrades.filter((t) => t.result === 'WIN').length;
    const losses = todayTrades.filter((t) => t.result === 'LOSS').length;
    const winRate = tradesCount > 0 ? Number(((wins / tradesCount) * 100).toFixed(1)) : 0;
    const totalPl = Number(todayTrades.reduce((acc, t) => acc + (t.pl || 0), 0).toFixed(2));
    const totalRiskPercentUsed = Number(todayTrades.reduce((acc, t) => acc + (t.riskPercent || 0), 0).toFixed(1));

    return {
      date: today,
      tradesCount,
      wins,
      losses,
      winRate,
      totalPl,
      totalRiskPercentUsed,
      maxDailyTradesReached: tradesCount >= 3,
      maxDailyRiskReached: totalRiskPercentUsed >= 30.0,
    };
  }

  public getDailyStats(dateStr?: string): DailyTradeStats {
    return this.getTodayStats(dateStr);
  }

  // =========================================================================
  // Account Balance Management (Requirement 4: Strict $91.00 Preservation)
  // =========================================================================
  public getBalance(): { currentBalance: number; startingBalance: number } {
    return {
      currentBalance: this.inMemoryCurrentBalance,
      startingBalance: this.inMemoryStartingBalance,
    };
  }

  public getCurrentBalance(): number {
    return this.inMemoryCurrentBalance;
  }

  public getStartingBalance(): number {
    return this.inMemoryStartingBalance;
  }

  public setStartingBalance(val: number): void {
    if (typeof val === 'number' && !isNaN(val) && val > 0) {
      this.inMemoryStartingBalance = Number(val.toFixed(2));
      this.inMemoryCurrentBalance = this.inMemoryStartingBalance;
      this.inMemorySettings.manualCapital = this.inMemoryStartingBalance;
      this.syncJsonBackups();

      if (supabase && this.shouldPersist()) {
        supabase
          .from('account_state')
          .upsert({
            id: 'main',
            current_balance: this.inMemoryCurrentBalance,
            starting_balance: this.inMemoryStartingBalance,
            updated_at: new Date().toISOString(),
          })
          .then(({ error }) => {
            if (error) console.error('[Storage] Supabase setStartingBalance error:', error.message);
          });
      }
    }
  }

  public setCurrentBalance(val: number): void {
    if (typeof val === 'number' && !isNaN(val)) {
      this.inMemoryCurrentBalance = Number(val.toFixed(2));
      this.syncJsonBackups();

      if (supabase && this.shouldPersist()) {
        supabase
          .from('account_state')
          .upsert({
            id: 'main',
            current_balance: this.inMemoryCurrentBalance,
            starting_balance: this.inMemoryStartingBalance,
            updated_at: new Date().toISOString(),
          })
          .then(({ error }) => {
            if (error) console.error('[Storage] Supabase setCurrentBalance error:', error.message);
          });
      }
    }
  }

  public updateBalance(current: number, starting?: number): { currentBalance: number; startingBalance: number } {
    this.inMemoryCurrentBalance = Number(current.toFixed(2));
    if (typeof starting === 'number' && !isNaN(starting) && starting > 0) {
      this.inMemoryStartingBalance = Number(starting.toFixed(2));
      this.inMemorySettings.manualCapital = this.inMemoryStartingBalance;

      if (supabase && this.shouldPersist()) {
        supabase
          .from('app_settings')
          .upsert({
            id: 'main',
            data: this.inMemorySettings,
            updated_at: new Date().toISOString(),
          })
          .then(({ error }) => {
            if (error) console.error('[Storage] Supabase updateBalance settings error:', error.message);
          });
      }
    }

    if (supabase && this.shouldPersist()) {
      supabase
        .from('account_state')
        .upsert({
          id: 'main',
          current_balance: this.inMemoryCurrentBalance,
          starting_balance: this.inMemoryStartingBalance,
          updated_at: new Date().toISOString(),
        })
        .then(({ error }) => {
          if (error) console.error('[Storage] Supabase updateBalance account error:', error.message);
        });
    }

    this.syncJsonBackups();
    return this.getBalance();
  }

  // =========================================================================
  // Settings Management
  // =========================================================================
  public getSettings(): AppSettings {
    return { ...this.inMemorySettings };
  }

  public saveSettings(patch: Partial<AppSettings>): {
    success: boolean;
    settings: AppSettings;
    startingBalance: number;
    currentBalance: number;
    error?: string;
  } {
    try {
      this.inMemorySettings = { ...this.inMemorySettings, ...patch };

      if (patch.manualCapital !== undefined) {
        const newCap = Number(patch.manualCapital);
        if (!isNaN(newCap) && newCap >= 0) {
          this.inMemorySettings.manualCapital = Number(newCap.toFixed(2));
        }
      }

      if (supabase && this.shouldPersist()) {
        supabase
          .from('app_settings')
          .upsert({
            id: 'main',
            data: this.inMemorySettings,
            updated_at: new Date().toISOString(),
          })
          .then(({ error }) => {
            if (error) console.error('[Storage] Supabase saveSettings error:', error.message);
          });
      }

      this.syncJsonBackups();
      return {
        success: true,
        settings: { ...this.inMemorySettings },
        startingBalance: this.inMemoryStartingBalance,
        currentBalance: this.inMemoryCurrentBalance,
      };
    } catch (err: any) {
      return {
        success: false,
        settings: this.inMemorySettings,
        startingBalance: this.inMemoryStartingBalance,
        currentBalance: this.inMemoryCurrentBalance,
        error: err?.message || 'Failed',
      };
    }
  }

  public saveScannerEvent(eventType: string, payload: any): void {
    // Optional scanner event logging
  }

  // =========================================================================
  // Terminal Setups (Cooldown & Invalidation Dedup)
  // =========================================================================
  public getTerminalSetups(): string[] {
    return Array.from(this.inMemoryTerminalSetups);
  }

  public saveTerminalSetup(key: string): void {
    if (!key) return;
    this.inMemoryTerminalSetups.add(key);

    if (supabase && this.shouldPersist()) {
      supabase
        .from('terminal_setups')
        .upsert({
          id: key.replace(/\//g, '_'),
          setup_key: key,
        })
        .then(({ error }) => {
          if (error) console.error('[Storage] Supabase saveTerminalSetup error:', error.message);
        });
    }

    this.syncJsonBackups();
  }

  public isTerminalSetup(key: string): boolean {
    if (!key) return false;
    return this.inMemoryTerminalSetups.has(key);
  }

  public getScannerStatus() {
    return {
      lastScanTimestamp: this.lastScannerTimestamp,
      lastScanStatus: this.lastScannerStatus,
      totalScans: this.inMemoryScans.length,
      isDbReady: this.isReady,
    };
  }

  // =========================================================================
  // Trade Closure & Ledger Mutation
  // =========================================================================
  public closeTrade(
    id: string,
    result: 'WIN' | 'LOSS' | 'CANCELLED' | 'VOID' | 'EXPIRED',
    pl: number,
    exitPrice?: number,
    notes?: string
  ): TradeLedgerItem[] {
    try {
      const idx = this.inMemoryTrades.findIndex((t) => t.id === id);
      if (idx >= 0) {
        const trade = this.inMemoryTrades[idx];
        if (trade.result !== 'OPEN') {
          return [...this.inMemoryTrades];
        }

        const isRealizedTrade = result === 'WIN' || result === 'LOSS';
        const finalPl = isRealizedTrade ? Number(pl.toFixed(2)) : 0;
        const finalExitPrice = exitPrice !== undefined ? exitPrice : trade.exitPrice || trade.entry;
        const exitTime = new Date().toISOString();
        const updatedNotes = notes ? (trade.notes ? `${trade.notes} | ${notes}` : notes) : trade.notes;

        const newBalance = isRealizedTrade
          ? Number(((trade.balanceAfterTrade || this.inMemoryCurrentBalance) + finalPl).toFixed(2))
          : this.inMemoryCurrentBalance;

        this.inMemoryTrades[idx] = {
          ...trade,
          result,
          pl: finalPl,
          exitPrice: finalExitPrice,
          exitTime,
          balanceAfterTrade: newBalance,
          notes: updatedNotes,
          isActive: false,
        };

        if (isRealizedTrade) {
          this.inMemoryCurrentBalance = newBalance;

          const outcomeRecord: TradeOutcomeRecord = {
            signalId: trade.signalId || trade.id,
            tradeId: trade.id,
            outcome: result as 'WIN' | 'LOSS',
            realizedPnl: finalPl,
            entry: trade.entry,
            exitPrice: finalExitPrice,
            closeReason: notes || trade.closeReason || 'تصفية يدوية أو نظام الوقف/الهدف',
            timestamp: Date.now(),
            source: 'SYSTEM',
          };

          telegramService.sendOutcomeNotification(outcomeRecord, this.inMemoryTrades[idx]).catch((err) => {
            console.error('[Storage] Telegram outcome alert dispatch error from closeTrade:', err);
          });
        }

        if (supabase && this.shouldPersist()) {
          supabase
            .from('trade_ledger')
            .upsert(this.formatTradeRow(this.inMemoryTrades[idx]))
            .then(({ error }) => {
              if (error) console.error(`[Storage] Supabase closeTrade error for ${id}:`, error.message);
            });

          if (isRealizedTrade) {
            supabase
              .from('account_state')
              .upsert({
                id: 'main',
                current_balance: this.inMemoryCurrentBalance,
                starting_balance: this.inMemoryStartingBalance,
                updated_at: new Date().toISOString(),
              })
              .then(({ error }) => {
                if (error) console.error('[Storage] Supabase closeTrade account error:', error.message);
              });
          }
        }
        this.syncJsonBackups();
      }
      return [...this.inMemoryTrades];
    } catch (error) {
      console.error('[Storage] Error closing trade in ledger:', error);
      return [...this.inMemoryTrades];
    }
  }

  public deleteTrade(id: string): TradeLedgerItem[] {
    try {
      this.inMemoryTrades = this.inMemoryTrades.filter((t) => t.id !== id);
      const closedTrades = this.inMemoryTrades.filter((t) => t.result === 'WIN' || t.result === 'LOSS');
      const totalPl = Number(closedTrades.reduce((acc, t) => acc + (t.pl || 0), 0).toFixed(2));
      this.inMemoryCurrentBalance =
        closedTrades.length === 0 ? this.inMemoryStartingBalance : Number((this.inMemoryStartingBalance + totalPl).toFixed(2));

      if (supabase && this.shouldPersist()) {
        supabase
          .from('trade_ledger')
          .delete()
          .eq('id', id)
          .then(({ error }) => {
            if (error) console.error(`[Storage] Supabase deleteTrade error for ${id}:`, error.message);
          });
        supabase
          .from('account_state')
          .upsert({
            id: 'main',
            current_balance: this.inMemoryCurrentBalance,
            starting_balance: this.inMemoryStartingBalance,
            updated_at: new Date().toISOString(),
          })
          .then(({ error }) => {
            if (error) console.error('[Storage] Supabase deleteTrade account error:', error.message);
          });
      }
      this.syncJsonBackups();
      return [...this.inMemoryTrades];
    } catch (error) {
      console.error('[Storage] Error deleting trade from ledger:', error);
      return [...this.inMemoryTrades];
    }
  }

  public getStats() {
    return {
      totalScansRecorded: this.inMemoryScans.length,
      totalSignalsRecorded: this.inMemorySignals.length,
      totalTradesRecorded: this.inMemoryTrades.length,
      totalOutcomesRecorded: this.inMemoryOutcomes.length,
      storageEngine: isSupabaseConfigured() ? 'Supabase PostgreSQL (Durable Cloud Storage)' : 'Local Disk Backup (Supabase Config Pending)',
      isInitialized: this.isReady,
    };
  }

  public saveBacktestResult(result: any): void {
    try {
      this.ensureDataDirectory();
      fs.writeFileSync(BACKTEST_FILE, JSON.stringify(result, null, 2), 'utf-8');
    } catch (error) {
      console.error('[PersistentStorage] Error saving backtest result:', error);
    }
  }

  public getBacktestResult(): any | null {
    try {
      if (fs.existsSync(BACKTEST_FILE)) {
        return JSON.parse(fs.readFileSync(BACKTEST_FILE, 'utf-8'));
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  // =========================================================================
  // POI Tracking
  // =========================================================================
  public savePoi(poi: PoiRecord): void {
    const idx = this.inMemoryPois.findIndex((p) => p.id === poi.id);
    if (idx >= 0) {
      this.inMemoryPois[idx] = poi;
    } else {
      this.inMemoryPois.push(poi);
      if (this.inMemoryPois.length > 200) {
        this.inMemoryPois.shift();
      }
    }
    if (supabase && this.shouldPersist()) {
      supabase
        .from('poi_records')
        .upsert({ id: poi.id, raw_data: poi })
        .then(({ error }) => {
          if (error) console.error(`[Storage] Supabase savePoi error for ${poi.id}:`, error.message);
        });
    }
  }

  public savePois(pois: PoiRecord[]): void {
    for (const p of pois) {
      this.savePoi(p);
    }
  }

  public getPois(): PoiRecord[] {
    return [...this.inMemoryPois];
  }

  // =========================================================================
  // Candidate Lifecycle State Persistence
  // =========================================================================
  public saveLifecycle(record: CandidateLifecycleRecord): void {
    const idx = this.inMemoryLifecycles.findIndex((l) => l.id === record.id);
    if (idx >= 0) {
      this.inMemoryLifecycles[idx] = record;
    } else {
      this.inMemoryLifecycles.push(record);
      if (this.inMemoryLifecycles.length > 200) {
        this.inMemoryLifecycles.shift();
      }
    }
    if (supabase && this.shouldPersist()) {
      supabase
        .from('candidate_lifecycles')
        .upsert({ id: record.id, raw_data: record })
        .then(({ error }) => {
          if (error) console.error(`[Storage] Supabase saveLifecycle error for ${record.id}:`, error.message);
        });
    }
  }

  public saveLifecycles(records: CandidateLifecycleRecord[]): void {
    for (const r of records) {
      this.saveLifecycle(r);
    }
  }

  public getLifecycles(): CandidateLifecycleRecord[] {
    return [...this.inMemoryLifecycles];
  }

  // =========================================================================
  // Trade Opportunity State Persistence
  // =========================================================================
  public saveOpportunity(opp: TradeOpportunity): void {
    if (!opp.id) return;
    this.inMemoryOpportunities.set(opp.id, opp);
    if (supabase && this.shouldPersist()) {
      supabase
        .from('opportunities')
        .upsert({
          id: opp.id,
          last_updated_time: opp.lastUpdatedTime,
          raw_data: opp,
        })
        .then(({ error }) => {
          if (error) console.error('[Storage] Supabase saveOpportunity error:', error.message);
        });
    }
    this.syncJsonBackups();
  }

  public getOpportunity(id: string): TradeOpportunity | null {
    if (!id) return null;
    return this.inMemoryOpportunities.get(id) || null;
  }

  public getOpportunities(): TradeOpportunity[] {
    return Array.from(this.inMemoryOpportunities.values());
  }

  public markSignalOrOpportunityNotEntered(signalOrOppId: string): {
    success: boolean;
    signal?: TradeSignal;
    opportunity?: TradeOpportunity;
  } {
    let updatedSignal: TradeSignal | undefined;
    let updatedOpp: TradeOpportunity | undefined;

    // 1. Update Signal in memory and storage
    const sigIdx = this.inMemorySignals.findIndex((s) => s.id === signalOrOppId || s.setupId === signalOrOppId);
    if (sigIdx >= 0) {
      this.inMemorySignals[sigIdx].lifecycleState = 'NOT_ENTERED';
      updatedSignal = this.inMemorySignals[sigIdx];
      if (supabase && this.shouldPersist()) {
        Promise.resolve(
          supabase
            .from('signals')
            .upsert({
              id: updatedSignal.id,
              timestamp: updatedSignal.timestamp,
              raw_data: updatedSignal,
            })
        ).catch((e) => console.error('[Storage] Supabase update signal NOT_ENTERED error:', e));
      }
    }

    // 2. Update Opportunity in memory and storage
    const opp = this.inMemoryOpportunities.get(signalOrOppId) || (updatedSignal?.setupId ? this.inMemoryOpportunities.get(updatedSignal.setupId) : null);
    if (opp) {
      opp.status = 'NOT_ENTERED';
      opp.lastUpdatedTime = Date.now();
      this.inMemoryOpportunities.set(opp.id, opp);
      updatedOpp = opp;
      if (supabase && this.shouldPersist()) {
        Promise.resolve(
          supabase
            .from('opportunities')
            .upsert({
              id: opp.id,
              last_updated_time: opp.lastUpdatedTime,
              raw_data: opp,
            })
        ).catch((e) => console.error('[Storage] Supabase update opportunity NOT_ENTERED error:', e));
      }
    }

    // 3. Update candidate lifecycle if found
    const lcIdx = this.inMemoryLifecycles.findIndex((l) => l.id === signalOrOppId || l.poiId === signalOrOppId);
    if (lcIdx >= 0) {
      this.inMemoryLifecycles[lcIdx].state = 'NOT_ENTERED';
      this.inMemoryLifecycles[lcIdx].lastUpdatedTime = Date.now();
      if (supabase && this.shouldPersist()) {
        Promise.resolve(
          supabase.from('candidate_lifecycles').upsert({ id: this.inMemoryLifecycles[lcIdx].id, raw_data: this.inMemoryLifecycles[lcIdx] })
        ).catch(() => {});
      }
    }

    // 4. Also store outcome record as NOT_ENTERED
    const outcomeRecord: TradeOutcomeRecord = {
      signalId: signalOrOppId,
      tradeId: signalOrOppId,
      direction: updatedSignal?.signal || 'BUY NOW',
      orderType: 'NOT_ENTERED',
      entry: updatedSignal?.entry || 0,
      stopLoss: updatedSignal?.stopLoss || 0,
      tp1: updatedSignal?.tp1 || 0,
      tp2: updatedSignal?.tp2 || 0,
      outcome: 'NOT_ENTERED' as any,
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
      source: 'MANUAL',
      realizedPnl: 0,
      pl: 0,
      notes: 'لم تُنفذ / لم يتم الدخول (NOT ENTERED)',
    };

    const outIdx = this.inMemoryOutcomes.findIndex((o) => o.signalId === signalOrOppId || o.tradeId === signalOrOppId);
    if (outIdx >= 0) {
      this.inMemoryOutcomes[outIdx] = outcomeRecord;
    } else {
      this.inMemoryOutcomes.unshift(outcomeRecord);
    }
    if (supabase && this.shouldPersist()) {
      Promise.resolve(
        supabase.from('trade_outcomes').upsert(this.formatOutcomeRow(outcomeRecord))
      ).catch(() => {});
    }

    this.syncJsonBackups();
    return { success: true, signal: updatedSignal, opportunity: updatedOpp };
  }

  public async clearAllTrades(): Promise<TradeLedgerItem[]> {
    this.inMemoryTrades = [];
    this.inMemoryCurrentBalance = this.inMemoryStartingBalance;
    if (supabase && this.shouldPersist()) {
      try {
        await supabase.from('trade_ledger').delete().neq('id', '___non_existent___');
        await supabase.from('account_state').upsert({
          id: 'main',
          current_balance: this.inMemoryCurrentBalance,
          starting_balance: this.inMemoryStartingBalance,
          updated_at: new Date().toISOString(),
        });
      } catch (e) {
        console.error('[Storage] Error clearing all trades in Supabase:', e);
      }
    }
    this.syncJsonBackups();
    return [];
  }

  public clearOpportunities(): void {
    this.inMemoryOpportunities.clear();
    this.syncJsonBackups();
  }

  public async resetTradingState(): Promise<any> {
    try {
      const auditBefore = {
        signalsCount: this.inMemorySignals.length,
        tradesCount: this.inMemoryTrades.length,
        openTradesCount: this.inMemoryTrades.filter((t) => t.result === 'OPEN').length,
        opportunitiesCount: this.inMemoryOpportunities.size,
        terminalSetupsCount: this.inMemoryTerminalSetups.size,
        currentBalance: this.inMemoryCurrentBalance,
        startingBalance: this.inMemoryStartingBalance,
      };

      // 1. Reset signals
      this.inMemorySignals = [];

      // 2. Reset opportunities
      this.inMemoryOpportunities.clear();

      // 3. Reset terminal setups
      this.inMemoryTerminalSetups.clear();

      // 4. Reset lifecycles
      this.inMemoryLifecycles = [];

      // 5. Preserving completed/realized trades in ledger (WIN/LOSS)
      const completedTrades = this.inMemoryTrades.filter((t) => t.result === 'WIN' || t.result === 'LOSS');
      this.inMemoryTrades = completedTrades;

      // Recalculate current balance based on preserved completed trades
      const totalPl = Number(completedTrades.reduce((acc, t) => acc + (t.pl || 0), 0).toFixed(2));
      this.inMemoryCurrentBalance = Number((this.inMemoryStartingBalance + totalPl).toFixed(2));

      // 6. Sync JSON backups
      this.syncJsonBackups();

      // 7. Clear Supabase tables if connected
      if (supabase && this.shouldPersist()) {
        try {
          await supabase.from('signals').delete().neq('id', '___keep___');
          await supabase.from('opportunities').delete().neq('id', '___keep___');
          await supabase.from('candidate_lifecycles').delete().neq('id', '___keep___');
          await supabase.from('terminal_setups').delete().neq('id', '___keep___');
          await supabase.from('trade_ledger').delete().eq('result', 'OPEN');
          await supabase.from('account_state').upsert({
            id: 'main',
            current_balance: this.inMemoryCurrentBalance,
            starting_balance: this.inMemoryStartingBalance,
            updated_at: new Date().toISOString(),
          });
        } catch (fsErr) {
          console.warn('[Storage] Supabase deletion during reset had non-blocking error:', fsErr);
        }
      }

      const auditAfter = {
        signalsCount: this.inMemorySignals.length,
        tradesCount: this.inMemoryTrades.length,
        openTradesCount: this.inMemoryTrades.filter((t) => t.result === 'OPEN').length,
        opportunitiesCount: this.inMemoryOpportunities.size,
        terminalSetupsCount: this.inMemoryTerminalSetups.size,
        currentBalance: this.inMemoryCurrentBalance,
        startingBalance: this.inMemoryStartingBalance,
      };

      console.log('[Storage] Total Trading State Reset Complete.', { auditBefore, auditAfter });

      return {
        success: true,
        before: auditBefore,
        after: auditAfter,
      };
    } catch (error: any) {
      console.error('[Storage] Error during resetTradingState:', error);
      throw error;
    }
  }
}

export const storage = new PersistentStorage();

export function sanitizeFirestoreData(data: any): any {
  if (data === null || data === undefined) return null;
  if (typeof data === 'number') {
    if (isNaN(data) || !isFinite(data)) return 0;
    return data;
  }
  if (typeof data !== 'object') return data;
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeFirestoreData(item)).filter((item) => item !== undefined);
  }
  const result: any = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (typeof value === 'function') continue;
    result[key] = sanitizeFirestoreData(value);
  }
  return result;
}

export const sanitizeDatabaseData = sanitizeFirestoreData;
