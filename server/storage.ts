import fs from 'fs';
import path from 'path';
import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import {
  getFirestore,
  Firestore,
  doc,
  getDoc,
  setDoc,
  getDocs,
  collection,
  query,
  orderBy,
  limit as firestoreLimit,
  deleteDoc,
  writeBatch
} from 'firebase/firestore';
import { AppSettings, DEFAULT_APP_SETTINGS, SignalDecision, TradeLedgerItem, TradeSignal } from '../src/types.js';

export interface ScanRecord {
  id: string;
  timestamp: number;
  isoTime: string;
  currentPrice: number;
  signal: SignalDecision;
  entry: number;
  stopLoss: number;
  slPoints: number;
  tp1: number;
  tp1Points: number;
  tp1Rr: string;
  tp2: number;
  tp2Points: number;
  tp2Rr: string;
  rr: string;
  confidence: number;
  riskPercent: number;
  riskAmount: number;
  lotSize: number;
  setup: string;
  reasons: string[];
  status: string; // e.g., 'NO TRADE', 'QUALIFIED', 'DUPLICATE_ACTIVE'
  invalidation?: string;
  noTradeReason?: string;
}

export interface DailyTradeStats {
  date: string; // YYYY-MM-DD
  tradesCount: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPl: number;
  totalRiskPercentUsed: number;
  maxDailyTradesReached: boolean; // >= 3
  maxDailyRiskReached: boolean; // >= 30%
}

export interface TradeOutcomeRecord {
  signalId: string;
  tradeId: string;
  direction: string;
  orderType: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  outcome: 'WIN' | 'LOSS';
  timestamp: number;
  isoTime: string;
  chatId?: string | number;
  userId?: string | number;
  pl?: number;
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
  lastScanTime: number | null;
  lastScanStatus: string;
  scannerHealth: 'HEALTHY' | 'DEGRADED' | 'STANDBY';
  todayStats: DailyTradeStats;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const SCANS_FILE = path.join(DATA_DIR, 'scan_history.json');
const SIGNALS_FILE = path.join(DATA_DIR, 'saved_signals.json');
const TRADES_FILE = path.join(DATA_DIR, 'trade_ledger.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'app_settings.json');
const OUTCOMES_FILE = path.join(DATA_DIR, 'trade_outcomes.json');
const BACKTEST_FILE = path.join(DATA_DIR, 'backtest_results.json');
const ACCOUNT_FILE = path.join(DATA_DIR, 'account_state.json');

const MAX_SCANS_TO_KEEP = 500;
const MAX_SIGNALS_TO_KEEP = 200;
const MAX_TRADES_TO_KEEP = 300;

class PersistentStorage {
  private firestoreDb: Firestore | null = null;
  private isReady = false;
  private initPromise: Promise<void>;

  private inMemoryScans: ScanRecord[] = [];
  private inMemorySignals: TradeSignal[] = [];
  private inMemoryTrades: TradeLedgerItem[] = [];
  private inMemoryOutcomes: TradeOutcomeRecord[] = [];
  private inMemorySettings: AppSettings = { ...DEFAULT_APP_SETTINGS };
  private inMemoryStartingBalance = 25.0;
  private inMemoryCurrentBalance = 25.0;
  private lastScannerStatus = 'جاهز - المسح التلقائي نشط';
  private lastScannerTimestamp: number | null = null;

  constructor() {
    this.initPromise = this.init();
  }

  public async waitUntilReady(): Promise<void> {
    await this.initPromise;
  }

  private async init(): Promise<void> {
    try {
      // 1. Initialize Firestore client from FIREBASE_CONFIG env or firebase-applet-config.json
      let config: any = null;
      if (process.env.FIREBASE_CONFIG) {
        try {
          config = JSON.parse(process.env.FIREBASE_CONFIG);
        } catch (e) {
          console.error('[Storage] Error parsing FIREBASE_CONFIG environment variable:', e);
        }
      }
      if (!config) {
        const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
        if (fs.existsSync(configPath)) {
          const configRaw = fs.readFileSync(configPath, 'utf8');
          config = JSON.parse(configRaw);
        }
      }

      if (config) {
        let app: FirebaseApp;
        if (getApps().length === 0) {
          app = initializeApp(config);
        } else {
          app = getApps()[0];
        }

        const databaseId = process.env.FIREBASE_DATABASE_ID || config.firestoreDatabaseId;
        this.firestoreDb = getFirestore(app, databaseId);
        console.log(`[Storage] Connected to Google Firestore database: ${databaseId}`);
      } else {
        console.warn('[Storage] Neither FIREBASE_CONFIG env nor firebase-applet-config.json found, proceeding with local fallback.');
      }

      if (this.firestoreDb) {
        // 2. Load or seed data from/to Firestore
        await this.initFirestoreData();
      } else {
        this.loadLocalJsonFallback();
      }

      this.isReady = true;
      console.log('[Storage] Durable Firestore storage initialized successfully.');
    } catch (err) {
      console.error('[Storage] Error initializing Firestore storage, falling back to local JSON cache:', err);
      this.loadLocalJsonFallback();
      this.isReady = true;
    }
  }

  /**
   * Initializes state from Firestore, or seeds existing JSON files if Firestore is empty.
   */
  private async initFirestoreData(): Promise<void> {
    if (!this.firestoreDb) return;

    try {
      // A. Settings: check if 'main' doc exists
      const settingsRef = doc(this.firestoreDb, 'app_settings', 'main');
      const settingsSnap = await getDoc(settingsRef);

      if (settingsSnap.exists()) {
        const data = settingsSnap.data() as Partial<AppSettings>;
        this.inMemorySettings = { ...DEFAULT_APP_SETTINGS, ...data };
        console.log('[Storage] Loaded app_settings from Firestore.');
      } else {
        // Seed from data/app_settings.json if present, otherwise DEFAULT
        let initialSettings = { ...DEFAULT_APP_SETTINGS };
        if (fs.existsSync(SETTINGS_FILE)) {
          try {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
            initialSettings = { ...initialSettings, ...JSON.parse(raw || '{}') };
          } catch (e) {
            console.error('[Storage] Error reading initial settings file:', e);
          }
        }
        this.inMemorySettings = initialSettings;
        await setDoc(settingsRef, { ...this.inMemorySettings, updatedAt: Date.now() });
        console.log('[Storage] Seeded app_settings to Firestore.');
      }

      // B. Account State: check if 'main' doc exists
      const accountRef = doc(this.firestoreDb, 'account_state', 'main');
      const accountSnap = await getDoc(accountRef);

      if (accountSnap.exists()) {
        const data = accountSnap.data() as { currentBalance?: number; startingBalance?: number };
        this.inMemoryCurrentBalance = Number(data.currentBalance ?? 25.0);
        this.inMemoryStartingBalance = Number(data.startingBalance ?? 25.0);
        console.log(`[Storage] Loaded account_state from Firestore: starting=$${this.inMemoryStartingBalance}, current=$${this.inMemoryCurrentBalance}`);
      } else {
        // Seed from data/account_state.json if present, otherwise default to manualCapital or $25.0
        let starting = this.inMemorySettings.manualCapital || 25.0;
        let current = starting;
        if (fs.existsSync(ACCOUNT_FILE)) {
          try {
            const raw = fs.readFileSync(ACCOUNT_FILE, 'utf8');
            const parsed = JSON.parse(raw || '{}');
            if (typeof parsed.startingBalance === 'number') starting = parsed.startingBalance;
            if (typeof parsed.currentBalance === 'number') current = parsed.currentBalance;
          } catch (e) {
            console.error('[Storage] Error reading initial account file:', e);
          }
        }
        this.inMemoryStartingBalance = starting;
        this.inMemoryCurrentBalance = current;
        await setDoc(accountRef, {
          startingBalance: this.inMemoryStartingBalance,
          currentBalance: this.inMemoryCurrentBalance,
          updatedAt: Date.now()
        });
        console.log(`[Storage] Seeded account_state to Firestore: starting=$${starting}, current=$${current}`);
      }

      // C. Trade Ledger
      const tradesCol = collection(this.firestoreDb, 'trade_ledger');
      const tradesSnap = await getDocs(query(tradesCol, orderBy('tradeNumber', 'desc'), firestoreLimit(MAX_TRADES_TO_KEEP)));
      
      if (!tradesSnap.empty) {
        this.inMemoryTrades = tradesSnap.docs.map(d => d.data() as TradeLedgerItem);
        console.log(`[Storage] Loaded ${this.inMemoryTrades.length} trades from Firestore.`);
      } else {
        // Seed from data/trade_ledger.json
        if (fs.existsSync(TRADES_FILE)) {
          try {
            const raw = fs.readFileSync(TRADES_FILE, 'utf8');
            const list: TradeLedgerItem[] = JSON.parse(raw || '[]');
            for (const t of list) {
              if (!t.id) continue;
              await setDoc(doc(this.firestoreDb, 'trade_ledger', t.id), t);
            }
            this.inMemoryTrades = list;
            console.log(`[Storage] Seeded ${list.length} trades to Firestore.`);
          } catch (e) {
            console.error('[Storage] Error seeding trades:', e);
          }
        }
      }

      // Safeguard: Ensure legacy test trade is permanently VOID and inactive
      const legacyIdx = this.inMemoryTrades.findIndex(t => t.id === 'trade_1788789672022');
      if (legacyIdx >= 0) {
        const legacy = this.inMemoryTrades[legacyIdx];
        if (legacy.result !== 'VOID' || legacy.isActive) {
          legacy.result = 'VOID';
          legacy.pl = 0;
          legacy.isActive = false;
          legacy.notes = 'Executed via MT5 Bridge [Mode: DEMO] - Status: SIMULATED_DEMO (Voided legacy test record)';
          await setDoc(doc(this.firestoreDb, 'trade_ledger', legacy.id), legacy);
          console.log('[Storage] Enforced VOID status on legacy trade_1788789672022 in Firestore.');
        }
      }

      // D. Trade Outcomes
      const outcomesCol = collection(this.firestoreDb, 'trade_outcomes');
      const outcomesSnap = await getDocs(query(outcomesCol, orderBy('timestamp', 'desc'), firestoreLimit(200)));
      if (!outcomesSnap.empty) {
        this.inMemoryOutcomes = outcomesSnap.docs.map(d => d.data() as TradeOutcomeRecord);
        console.log(`[Storage] Loaded ${this.inMemoryOutcomes.length} outcomes from Firestore.`);
      } else if (fs.existsSync(OUTCOMES_FILE)) {
        try {
          const raw = fs.readFileSync(OUTCOMES_FILE, 'utf8');
          const list: TradeOutcomeRecord[] = JSON.parse(raw || '[]');
          for (const o of list) {
            if (!o.signalId) continue;
            await setDoc(doc(this.firestoreDb, 'trade_outcomes', o.signalId), o);
          }
          this.inMemoryOutcomes = list;
        } catch (e) {
          console.error('[Storage] Error seeding outcomes:', e);
        }
      }

      // E. Signals
      const signalsCol = collection(this.firestoreDb, 'signals');
      const signalsSnap = await getDocs(query(signalsCol, orderBy('timestamp', 'desc'), firestoreLimit(MAX_SIGNALS_TO_KEEP)));
      if (!signalsSnap.empty) {
        this.inMemorySignals = signalsSnap.docs.map(d => d.data() as TradeSignal);
        console.log(`[Storage] Loaded ${this.inMemorySignals.length} signals from Firestore.`);
      } else if (fs.existsSync(SIGNALS_FILE)) {
        try {
          const raw = fs.readFileSync(SIGNALS_FILE, 'utf8');
          const list: TradeSignal[] = JSON.parse(raw || '[]');
          for (const s of list) {
            if (!s.id) continue;
            await setDoc(doc(this.firestoreDb, 'signals', s.id), s);
          }
          this.inMemorySignals = list;
        } catch (e) {
          console.error('[Storage] Error seeding signals:', e);
        }
      }

      // F. Scans
      const scansCol = collection(this.firestoreDb, 'scans');
      const scansSnap = await getDocs(query(scansCol, orderBy('timestamp', 'desc'), firestoreLimit(MAX_SCANS_TO_KEEP)));
      if (!scansSnap.empty) {
        this.inMemoryScans = scansSnap.docs.map(d => d.data() as ScanRecord);
        if (this.inMemoryScans.length > 0) {
          this.lastScannerTimestamp = this.inMemoryScans[0].timestamp;
          this.lastScannerStatus = this.inMemoryScans[0].status || 'جاهز - المسح التلقائي نشط';
        }
        console.log(`[Storage] Loaded ${this.inMemoryScans.length} scans from Firestore.`);
      } else if (fs.existsSync(SCANS_FILE)) {
        try {
          const raw = fs.readFileSync(SCANS_FILE, 'utf8');
          const list: ScanRecord[] = JSON.parse(raw || '[]');
          for (const s of list) {
            if (!s.id) continue;
            await setDoc(doc(this.firestoreDb, 'scans', s.id), s);
          }
          this.inMemoryScans = list;
          if (list.length > 0) {
            this.lastScannerTimestamp = list[0].timestamp;
            this.lastScannerStatus = list[0].status;
          }
        } catch (e) {
          console.error('[Storage] Error seeding scans:', e);
        }
      }

      // Sync local JSON files as secondary local mirrors
      this.syncJsonBackups();
    } catch (err) {
      console.error('[Storage] Error syncing Firestore data on startup:', err);
    }
  }

  private loadLocalJsonFallback(): void {
    try {
      if (fs.existsSync(SCANS_FILE)) {
        this.inMemoryScans = JSON.parse(fs.readFileSync(SCANS_FILE, 'utf-8') || '[]');
      }
      if (fs.existsSync(SIGNALS_FILE)) {
        this.inMemorySignals = JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf-8') || '[]');
      }
      if (fs.existsSync(TRADES_FILE)) {
        this.inMemoryTrades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf-8') || '[]');
      }
      if (fs.existsSync(OUTCOMES_FILE)) {
        this.inMemoryOutcomes = JSON.parse(fs.readFileSync(OUTCOMES_FILE, 'utf-8') || '[]');
      }
      if (fs.existsSync(SETTINGS_FILE)) {
        this.inMemorySettings = { ...DEFAULT_APP_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8') || '{}') };
      }
      if (fs.existsSync(ACCOUNT_FILE)) {
        const acc = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf-8') || '{}');
        this.inMemoryCurrentBalance = acc.currentBalance ?? 25;
        this.inMemoryStartingBalance = acc.startingBalance ?? 25;
      }
    } catch (e) {
      console.error('[Storage] JSON fallback failed:', e);
    }
  }

  private syncJsonBackups(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(SCANS_FILE, JSON.stringify(this.inMemoryScans, null, 2), 'utf-8');
      fs.writeFileSync(SIGNALS_FILE, JSON.stringify(this.inMemorySignals, null, 2), 'utf-8');
      fs.writeFileSync(TRADES_FILE, JSON.stringify(this.inMemoryTrades, null, 2), 'utf-8');
      fs.writeFileSync(OUTCOMES_FILE, JSON.stringify(this.inMemoryOutcomes, null, 2), 'utf-8');
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.inMemorySettings, null, 2), 'utf-8');
      fs.writeFileSync(
        ACCOUNT_FILE,
        JSON.stringify({ currentBalance: this.inMemoryCurrentBalance, startingBalance: this.inMemoryStartingBalance }, null, 2),
        'utf-8'
      );
    } catch (e) {
      // Non-fatal local mirror sync
    }
  }

  // ==========================================
  // PUBLIC PERSISTENT API METHODS
  // (Synchronous in-memory API with async Firestore persistence)
  // ==========================================

  public createScan(record: ScanRecord): void {
    this.saveScan(record);
  }

  public saveScan(record: ScanRecord): void {
    try {
      this.lastScannerTimestamp = record.timestamp;
      this.lastScannerStatus = record.status || 'مسح مكتمل';

      this.inMemoryScans.unshift(record);
      if (this.inMemoryScans.length > MAX_SCANS_TO_KEEP) {
        this.inMemoryScans = this.inMemoryScans.slice(0, MAX_SCANS_TO_KEEP);
      }

      // Asynchronous non-blocking Firestore write
      if (this.firestoreDb && record.id) {
        setDoc(doc(this.firestoreDb, 'scans', record.id), record).catch((err) => {
          console.error(`[Storage] Firestore saveScan error for ${record.id}:`, err?.message || err);
        });
      }

      this.syncJsonBackups();
    } catch (err) {
      console.error('[Storage] Error saving scan:', err);
    }
  }

  public getRecentScans(limit = 50): ScanRecord[] {
    return this.inMemoryScans.slice(0, limit);
  }

  public getScans(limit = 50): ScanRecord[] {
    return this.getRecentScans(limit);
  }

  public getScan(id: string): ScanRecord | undefined {
    return this.inMemoryScans.find((s) => s.id === id);
  }

  public saveSignal(signal: TradeSignal): void {
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

      // Asynchronous non-blocking Firestore write
      if (this.firestoreDb && signal.id) {
        setDoc(doc(this.firestoreDb, 'signals', signal.id), signal).catch((err) => {
          console.error(`[Storage] Firestore saveSignal error for ${signal.id}:`, err?.message || err);
        });
      }

      this.syncJsonBackups();
    } catch (err) {
      console.error('[Storage] Error saving signal:', err);
    }
  }

  public getSignals(limit = 50): TradeSignal[] {
    return this.inMemorySignals.slice(0, limit);
  }

  public getSignalById(id: string): TradeSignal | undefined {
    return this.inMemorySignals.find((s) => s.id === id);
  }

  public getSignal(id: string): TradeSignal | undefined {
    return this.getSignalById(id);
  }

  public saveTrade(trade: TradeLedgerItem): TradeLedgerItem[] {
    try {
      const isResultOpen = trade.result === 'OPEN';
      const tradeWithActive: TradeLedgerItem = {
        ...trade,
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

      // Asynchronous Firestore write
      if (this.firestoreDb && tradeWithActive.id) {
        setDoc(doc(this.firestoreDb, 'trade_ledger', tradeWithActive.id), tradeWithActive).catch((err) => {
          console.error(`[Storage] Firestore saveTrade error for ${tradeWithActive.id}:`, err?.message || err);
        });
      }

      this.syncJsonBackups();
      return [...this.inMemoryTrades];
    } catch (err) {
      console.error('[Storage] Error saving trade:', err);
      return [...this.inMemoryTrades];
    }
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
      if (existing) {
        return {
          success: false,
          isDuplicate: true,
          outcome: existing,
          message: `تم تسجيل نتيجة هذه الصفقة مسبقاً (${existing.outcome === 'WIN' ? '🟢 رابحة' : '🔴 خاسرة'}). لا يمكن تعديلها.`,
        };
      }

      const existingTrade = this.inMemoryTrades.find((t) => t.id === record.signalId || t.id === record.tradeId);
      if (existingTrade && (existingTrade.result === 'WIN' || existingTrade.result === 'LOSS')) {
        return {
          success: false,
          isDuplicate: true,
          outcome: { ...record, outcome: existingTrade.result },
          trade: existingTrade,
          message: `تم تسجيل نتيجة هذه الصفقة مسبقاً (${existingTrade.result === 'WIN' ? '🟢 رابحة' : '🔴 خاسرة'}). لا يمكن تعديلها.`,
        };
      }

      this.inMemoryOutcomes.unshift(record);
      if (this.inMemoryOutcomes.length > 500) {
        this.inMemoryOutcomes = this.inMemoryOutcomes.slice(0, 500);
      }

      const isWin = record.outcome === 'WIN';
      const riskAmount = Number(
        (existingTrade?.riskAmount || signalData?.riskAmount || (this.inMemorySettings.manualCapital * (this.inMemorySettings.riskPerTrade / 100))).toFixed(2)
      );

      let updatedTrade: TradeLedgerItem;

      if (existingTrade) {
        const rrRatio = parseFloat(String(existingTrade.rr || signalData?.rr || '1.5').replace('1:', '')) || 1.5;
        const pl = isWin ? Number((existingTrade.riskAmount * rrRatio).toFixed(2)) : -Number(existingTrade.riskAmount.toFixed(2));

        existingTrade.result = record.outcome;
        existingTrade.pl = pl;
        existingTrade.exitPrice = isWin ? (existingTrade.tp1 || record.tp1) : (existingTrade.sl || record.stopLoss);
        existingTrade.exitTime = new Date(record.timestamp).toISOString();
        existingTrade.notes = `${existingTrade.notes ? existingTrade.notes + ' | ' : ''}النتيجة: ${isWin ? '🟢 رابحة' : '🔴 خاسرة'} (عبر تلغرام)`;
        existingTrade.balanceAfterTrade = Number(((existingTrade.balanceAfterTrade || this.inMemoryCurrentBalance) + pl).toFixed(2));

        this.inMemoryCurrentBalance = existingTrade.balanceAfterTrade;
        updatedTrade = existingTrade;
      } else {
        const rrRatio = parseFloat(String(signalData?.rr || '1.5').replace('1:', '')) || 1.5;
        const pl = isWin ? Number((riskAmount * rrRatio).toFixed(2)) : -riskAmount;

        this.inMemoryCurrentBalance = Number((this.inMemoryCurrentBalance + pl).toFixed(2));

        const newTrade: TradeLedgerItem = {
          id: record.signalId,
          tradeNumber: (this.inMemoryTrades[0]?.tradeNumber || 0) + 1,
          date: new Date(record.timestamp).toLocaleDateString('ar-EG', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
          isoTime: new Date(record.timestamp).toISOString(),
          asset: (signalData?.asset as any) || 'XAU/USD',
          direction: (signalData?.signal as any) || (record.direction as any) || 'BUY NOW',
          entry: record.entry,
          sl: record.stopLoss,
          slPoints: signalData?.slPoints || Math.round(Math.abs(record.entry - record.stopLoss) / 0.1),
          tp1: record.tp1,
          tp1Points: signalData?.tp1Points || Math.round(Math.abs(record.entry - record.tp1) / 0.1),
          tp2: record.tp2,
          tp2Points: signalData?.tp2Points || Math.round(Math.abs(record.entry - record.tp2) / 0.1),
          rr: signalData?.rr || '1:1.5',
          riskPercent: signalData?.riskPercent || this.inMemorySettings.riskPerTrade,
          riskAmount: riskAmount,
          lotSize: signalData?.recommendedLotSize || (signalData as any)?.lotSize || 0.01,
          confidence: signalData?.confidence || 80,
          setup: signalData?.setup || 'SMC Liquidity Engine',
          result: record.outcome,
          pl: pl,
          balanceAfterTrade: this.inMemoryCurrentBalance,
          exitPrice: isWin ? record.tp1 : record.stopLoss,
          exitTime: new Date(record.timestamp).toISOString(),
          notes: `سجلت يدوياً (${isWin ? '🟢 رابحة' : '🔴 خاسرة'}) عبر تلغرام`,
        };

        this.inMemoryTrades.unshift(newTrade);
        updatedTrade = newTrade;
      }

      // Firestore persistence
      if (this.firestoreDb) {
        setDoc(doc(this.firestoreDb, 'trade_outcomes', record.signalId), record).catch((err) => {
          console.error('[Storage] Firestore recordTradeOutcome error:', err);
        });
        setDoc(doc(this.firestoreDb, 'trade_ledger', updatedTrade.id), updatedTrade).catch((err) => {
          console.error('[Storage] Firestore saveTrade error in outcome:', err);
        });
        setDoc(doc(this.firestoreDb, 'account_state', 'main'), {
          currentBalance: this.inMemoryCurrentBalance,
          startingBalance: this.inMemoryStartingBalance,
          updatedAt: Date.now(),
        }).catch((err) => {
          console.error('[Storage] Firestore account_state update error:', err);
        });
      }

      this.syncJsonBackups();
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
        message: err?.message || 'Error recording outcome',
      };
    }
  }

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
    const totalRiskPercentUsed = Number(
      todayTrades.reduce((acc, t) => acc + (t.riskPercent || 0), 0).toFixed(1)
    );

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

  public getBalance(): { currentBalance: number; startingBalance: number } {
    return {
      currentBalance: this.inMemoryCurrentBalance,
      startingBalance: this.inMemoryStartingBalance,
    };
  }

  public updateBalance(current: number, starting?: number): { currentBalance: number; startingBalance: number } {
    this.inMemoryCurrentBalance = Number(current.toFixed(2));
    if (typeof starting === 'number' && !isNaN(starting) && starting > 0) {
      this.inMemoryStartingBalance = Number(starting.toFixed(2));
      this.inMemorySettings.manualCapital = this.inMemoryStartingBalance;
      if (this.firestoreDb) {
        setDoc(doc(this.firestoreDb, 'app_settings', 'main'), {
          ...this.inMemorySettings,
          updatedAt: Date.now(),
        }).catch((err) => {
          console.error('[Storage] Firestore updateBalance settings error:', err);
        });
      }
    }

    if (this.firestoreDb) {
      setDoc(doc(this.firestoreDb, 'account_state', 'main'), {
        currentBalance: this.inMemoryCurrentBalance,
        startingBalance: this.inMemoryStartingBalance,
        updatedAt: Date.now(),
      }).catch((err) => {
        console.error('[Storage] Firestore updateBalance account error:', err);
      });
    }

    this.syncJsonBackups();
    return this.getBalance();
  }

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

      // When manualCapital is changed by the user, update starting balance and recalculate currentBalance
      if (patch.manualCapital !== undefined) {
        const newCap = Number(patch.manualCapital);
        if (!isNaN(newCap) && newCap > 0) {
          this.inMemoryStartingBalance = Number(newCap.toFixed(2));
          this.inMemorySettings.manualCapital = this.inMemoryStartingBalance;

          const closedTrades = this.inMemoryTrades.filter((t) => t.result === 'WIN' || t.result === 'LOSS');
          const totalPl = Number(closedTrades.reduce((acc, t) => acc + (t.pl || 0), 0).toFixed(2));

          if (closedTrades.length === 0) {
            this.inMemoryCurrentBalance = this.inMemoryStartingBalance;
          } else {
            this.inMemoryCurrentBalance = Number((this.inMemoryStartingBalance + totalPl).toFixed(2));
          }

          if (this.firestoreDb) {
            setDoc(doc(this.firestoreDb, 'account_state', 'main'), {
              currentBalance: this.inMemoryCurrentBalance,
              startingBalance: this.inMemoryStartingBalance,
              updatedAt: Date.now(),
            }).catch((err) => {
              console.error('[Storage] Firestore saveSettings account update error:', err);
            });
          }
        }
      }

      if (this.firestoreDb) {
        setDoc(doc(this.firestoreDb, 'app_settings', 'main'), {
          ...this.inMemorySettings,
          updatedAt: Date.now(),
        }).catch((err) => {
          console.error('[Storage] Firestore saveSettings app_settings error:', err);
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

  public getScannerStatus() {
    return {
      lastScanTimestamp: this.lastScannerTimestamp,
      lastScanStatus: this.lastScannerStatus,
      totalScans: this.inMemoryScans.length,
      isDbReady: this.isReady,
    };
  }

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
          // Idempotent: already closed, skip duplicate processing
          return [...this.inMemoryTrades];
        }

        const isRealizedTrade = result === 'WIN' || result === 'LOSS';
        const finalPl = isRealizedTrade ? Number(pl.toFixed(2)) : 0;
        const finalExitPrice = exitPrice !== undefined ? exitPrice : (trade.exitPrice || trade.entry);
        const exitTime = new Date().toISOString();
        const updatedNotes = notes
          ? (trade.notes ? `${trade.notes} | ${notes}` : notes)
          : trade.notes;

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
        }

        if (this.firestoreDb) {
          setDoc(doc(this.firestoreDb, 'trade_ledger', id), this.inMemoryTrades[idx]).catch((err) => {
            console.error(`[Storage] Firestore closeTrade error for ${id}:`, err);
          });
          if (isRealizedTrade) {
            setDoc(doc(this.firestoreDb, 'account_state', 'main'), {
              currentBalance: this.inMemoryCurrentBalance,
              startingBalance: this.inMemoryStartingBalance,
              updatedAt: Date.now(),
            }).catch((err) => {
              console.error('[Storage] Firestore closeTrade account error:', err);
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
      this.inMemoryCurrentBalance = closedTrades.length === 0 ? this.inMemoryStartingBalance : Number((this.inMemoryStartingBalance + totalPl).toFixed(2));

      if (this.firestoreDb) {
        deleteDoc(doc(this.firestoreDb, 'trade_ledger', id)).catch((err) => {
          console.error(`[Storage] Firestore deleteTrade error for ${id}:`, err);
        });
        setDoc(doc(this.firestoreDb, 'account_state', 'main'), {
          currentBalance: this.inMemoryCurrentBalance,
          startingBalance: this.inMemoryStartingBalance,
          updatedAt: Date.now(),
        }).catch((err) => {
          console.error('[Storage] Firestore deleteTrade account error:', err);
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
      storageEngine: 'Google Firestore (Durable Cloud Storage)',
      isInitialized: this.isReady,
    };
  }

  public saveBacktestResult(result: any): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
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
}

export const storage = new PersistentStorage();
