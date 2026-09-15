import fs from 'fs';
import path from 'path';
import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import {
  getFirestore,
  Firestore,
  setLogLevel,
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
import {
  AppSettings,
  DEFAULT_APP_SETTINGS,
  SignalDecision,
  TradeLedgerItem,
  TradeSignal,
  PoiRecord,
  CandidateLifecycleRecord,
  DuplicateDetails,
  TradeOpportunity,
} from '../src/types.js';
import { telegramService } from './telegram.js';

/**
 * Recursively strips undefined values from objects/arrays before passing to Firestore setDoc(),
 * preventing "Unsupported field value: undefined" errors.
 */
export function sanitizeFirestoreData<T>(data: T): T {
  if (data === null || data === undefined) {
    return data;
  }
  if (Array.isArray(data)) {
    return data
      .filter((item) => item !== undefined)
      .map((item) => sanitizeFirestoreData(item)) as unknown as T;
  }
  if (typeof data === 'object' && !(data instanceof Date)) {
    const cleaned: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        cleaned[key] = sanitizeFirestoreData(value);
      }
    }
    return cleaned as T;
  }
  return data;
}

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
  duplicateReason?: string;
  duplicateDetails?: DuplicateDetails;
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
  outcome: 'WIN' | 'LOSS' | 'NOT_ENTERED';
  timestamp: number;
  isoTime: string;
  chatId?: string | number;
  userId?: string | number;
  pl?: number;
  realizedPnl?: number; // Authoritative realized P&L ($)
  exitPrice?: number;
  source?: 'MANUAL' | 'MT5' | 'SYSTEM';
  brokerDealId?: string;
  brokerOrderId?: string;
  closedAt?: number;
  closeReason?: string;
  notes?: string;
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
const TERMINAL_SETUPS_FILE = path.join(DATA_DIR, 'terminal_setups.json');
const OPPORTUNITIES_FILE = path.join(DATA_DIR, 'opportunities.json');

const MAX_SCANS_TO_KEEP = 500;
const MAX_SIGNALS_TO_KEEP = 200;
const MAX_TRADES_TO_KEEP = 300;

class PersistentStorage {
  private firestoreDb: Firestore | null = null;
  private isReady = false;
  private initPromise: Promise<void>;
  private isTestMode = false;

  private inMemoryScans: ScanRecord[] = [];
  private inMemorySignals: TradeSignal[] = [];
  private inMemoryTrades: TradeLedgerItem[] = [];
  private inMemoryOutcomes: TradeOutcomeRecord[] = [];
  private inMemorySettings: AppSettings = { ...DEFAULT_APP_SETTINGS };
  private inMemoryStartingBalance = 25.0;
  private inMemoryCurrentBalance = 25.0;
  private lastScannerStatus = 'جاهز - المسح التلقائي نشط';
  private lastScannerTimestamp: number | null = null;

  private inMemoryPois: PoiRecord[] = [];
  private inMemoryLifecycles: CandidateLifecycleRecord[] = [];
  private inMemoryTerminalSetups: Set<string> = new Set();
  private inMemoryOpportunities: Map<string, TradeOpportunity> = new Map();

  constructor() {
    this.isTestMode = process.env.IS_TESTING === 'true';
    this.initPromise = this.init();
  }

  public setTestingMode(val: boolean): void {
    this.isTestMode = val;
    if (val) {
      console.log('[Storage] ENTERED TEST MODE. All writes are in-memory only and isolated from Firestore / JSON files.');
    }
  }

  private shouldPersist(): boolean {
    return !this.isTestMode && process.env.IS_TESTING !== 'true';
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
        setLogLevel('error');
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
        await setDoc(settingsRef, sanitizeFirestoreData({ ...this.inMemorySettings, updatedAt: Date.now() }));
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
        await setDoc(accountRef, sanitizeFirestoreData({
          startingBalance: this.inMemoryStartingBalance,
          currentBalance: this.inMemoryCurrentBalance,
          updatedAt: Date.now()
        }));
        console.log(`[Storage] Seeded account_state to Firestore: starting=$${starting}, current=$${current}`);
      }

      // C. Trade Ledger
      const tradesCol = collection(this.firestoreDb, 'trade_ledger');
      const tradesSnap = await getDocs(query(tradesCol, orderBy('tradeNumber', 'desc'), firestoreLimit(MAX_TRADES_TO_KEEP)));
      
      if (!tradesSnap.empty) {
        this.inMemoryTrades = tradesSnap.docs.map(d => d.data() as TradeLedgerItem);
        console.log(`[Storage] Loaded ${this.inMemoryTrades.length} trades from Firestore.`);
      } else {
        this.inMemoryTrades = [];
        console.log('[Storage] Firestore trade_ledger is empty (0 trades loaded). Production trade history is authoritative.');
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
          await setDoc(doc(this.firestoreDb, 'trade_ledger', legacy.id), sanitizeFirestoreData(legacy));
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
            await setDoc(doc(this.firestoreDb, 'trade_outcomes', o.signalId), sanitizeFirestoreData(o));
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
            await setDoc(doc(this.firestoreDb, 'signals', s.id), sanitizeFirestoreData(s));
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
            await setDoc(doc(this.firestoreDb, 'scans', s.id), sanitizeFirestoreData(s));
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

      // G. Opportunities
      try {
        const oppCol = collection(this.firestoreDb, 'opportunities');
        const oppSnap = await getDocs(query(oppCol, orderBy('lastUpdatedTime', 'desc'), firestoreLimit(200)));
        if (!oppSnap.empty) {
          oppSnap.docs.forEach(d => {
            const o = d.data() as TradeOpportunity;
            if (o.id) this.inMemoryOpportunities.set(o.id, o);
          });
          console.log(`[Storage] Loaded ${this.inMemoryOpportunities.size} opportunities from Firestore.`);
        } else if (fs.existsSync(OPPORTUNITIES_FILE)) {
          const raw = fs.readFileSync(OPPORTUNITIES_FILE, 'utf8');
          const list: TradeOpportunity[] = JSON.parse(raw || '[]');
          for (const o of list) {
            if (!o.id) continue;
            await setDoc(doc(this.firestoreDb, 'opportunities', o.id.replace(/\//g, '_')), sanitizeFirestoreData(o));
            this.inMemoryOpportunities.set(o.id, o);
          }
          console.log(`[Storage] Seeded ${this.inMemoryOpportunities.size} opportunities to Firestore.`);
        }
      } catch (e) {
        console.error('[Storage] Error seeding or loading opportunities in Firestore:', e);
      }

      // Sync local JSON files as secondary local mirrors
      this.syncJsonBackups();
    } catch (err) {
      console.error('[Storage] Error syncing Firestore data on startup, falling back to local JSON cache:', err);
      this.loadLocalJsonFallback();
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
      if (fs.existsSync(TERMINAL_SETUPS_FILE)) {
        const arr = JSON.parse(fs.readFileSync(TERMINAL_SETUPS_FILE, 'utf-8') || '[]');
        this.inMemoryTerminalSetups = new Set(arr);
      }
      if (fs.existsSync(OPPORTUNITIES_FILE)) {
        const arr = JSON.parse(fs.readFileSync(OPPORTUNITIES_FILE, 'utf-8') || '[]');
        this.inMemoryOpportunities = new Map(arr.map((o: any) => [o.id, o]));
      }
    } catch (e) {
      console.error('[Storage] JSON fallback failed:', e);
    }
  }

  private syncJsonBackups(): void {
    if (!this.shouldPersist()) {
      return;
    }
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
      fs.writeFileSync(TERMINAL_SETUPS_FILE, JSON.stringify(Array.from(this.inMemoryTerminalSetups), null, 2), 'utf-8');
      fs.writeFileSync(OPPORTUNITIES_FILE, JSON.stringify(Array.from(this.inMemoryOpportunities.values()), null, 2), 'utf-8');
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

      const existingIdx = this.inMemoryScans.findIndex((s) => s.id === record.id);
      if (existingIdx >= 0) {
        this.inMemoryScans[existingIdx] = record;
      } else {
        this.inMemoryScans.unshift(record);
      }

      if (this.inMemoryScans.length > MAX_SCANS_TO_KEEP) {
        this.inMemoryScans = this.inMemoryScans.slice(0, MAX_SCANS_TO_KEEP);
      }

      // Asynchronous non-blocking Firestore write
      if (this.firestoreDb && this.shouldPersist() && record.id) {
        setDoc(doc(this.firestoreDb, 'scans', record.id), sanitizeFirestoreData(record)).catch((err) => {
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
      if (this.firestoreDb && this.shouldPersist() && signal.id) {
        setDoc(doc(this.firestoreDb, 'signals', signal.id), sanitizeFirestoreData(signal)).catch((err) => {
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

  public async getSignalFromStorage(id: string): Promise<TradeSignal | undefined> {
    // 1. Check in-memory first
    const memorySignal = this.getSignalById(id);
    if (memorySignal) return memorySignal;

    // 2. Try Firestore if available
    if (this.firestoreDb) {
      try {
        const signalDocRef = doc(this.firestoreDb, 'signals', id);
        const signalSnap = await getDoc(signalDocRef);
        if (signalSnap.exists()) {
          const signalData = signalSnap.data() as TradeSignal;
          // Add to in-memory to speed up subsequent requests
          if (!this.inMemorySignals.some(s => s.id === signalData.id)) {
            this.inMemorySignals.unshift(signalData);
          }
          return signalData;
        }
      } catch (err) {
        console.error(`[Storage] Error fetching signal ${id} from Firestore:`, err);
      }
    }

    // 3. Try reading local saved_signals.json backup if available
    try {
      if (fs.existsSync(SIGNALS_FILE)) {
        const raw = fs.readFileSync(SIGNALS_FILE, 'utf-8');
        const list: TradeSignal[] = JSON.parse(raw || '[]');
        const fileSignal = list.find(s => s.id === id);
        if (fileSignal) {
          if (!this.inMemorySignals.some(s => s.id === fileSignal.id)) {
            this.inMemorySignals.unshift(fileSignal);
          }
          return fileSignal;
        }
      }
    } catch (err) {
      console.error(`[Storage] Error reading saved_signals.json for signal ${id}:`, err);
    }

    // 4. Try loading the corresponding opportunity if signal is not found
    const opp = this.getOpportunity(id) || this.getOpportunities().find(o => o.signalId === id);
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
      if (!this.inMemorySignals.some(s => s.id === rebuiltSignal.id)) {
        this.inMemorySignals.unshift(rebuiltSignal);
      }
      return rebuiltSignal;
    }

    return undefined;
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
      if (this.firestoreDb && this.shouldPersist() && tradeWithActive.id) {
        setDoc(doc(this.firestoreDb, 'trade_ledger', tradeWithActive.id), sanitizeFirestoreData(tradeWithActive)).catch((err) => {
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
      const existingTrade = this.inMemoryTrades.find(
        (t) => t.id === record.signalId || t.id === record.tradeId || (record.signalId && t.signalId === record.signalId)
      );

      // Requirement: If referenced trade does not exist, DO NOT create a new trade. Return TRADE_NOT_FOUND.
      if (!existingTrade) {
        console.warn(`[Storage] recordTradeOutcome rejected: referenced trade "${record.tradeId || record.signalId}" not found in trade ledger.`);
        return {
          success: false,
          isDuplicate: false,
          outcome: record,
          message: 'TRADE_NOT_FOUND',
        };
      }

      // 1. Authoritative Realized P&L Calculation (Never calculate from riskAmount * RR)
      let finalRealizedPnl: number;
      if (typeof record.realizedPnl === 'number' && !isNaN(record.realizedPnl)) {
        finalRealizedPnl = Number(record.realizedPnl.toFixed(2));
      } else if (typeof record.pl === 'number' && !isNaN(record.pl)) {
        finalRealizedPnl = Number(record.pl.toFixed(2));
      } else if (record.exitPrice !== undefined && typeof record.exitPrice === 'number' && !isNaN(record.exitPrice)) {
        // Price-action based P&L for Gold: 1 lot = 100 oz. Contract multiplier = 100
        const isBuy = String(record.direction || signalData?.signal || existingTrade.direction || '').toUpperCase().includes('BUY');
        const entryPrice = Number(record.entry || existingTrade.entry || signalData?.entry || record.exitPrice);
        const priceDiff = isBuy ? (record.exitPrice - entryPrice) : (entryPrice - record.exitPrice);
        const lotSize = existingTrade.lotSize || signalData?.recommendedLotSize || (signalData as any)?.lotSize || 0.01;
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
            trade: existingTrade,
            message: `تم توثيق نتيجة هذه الصفقة مسبقاً (${existing.outcome === 'WIN' ? '🟢 رابحة' : '🔴 خاسرة'}) بقيمة $${finalRealizedPnl}.`,
          };
        }
      }

      if (existingTrade.result === 'WIN' || existingTrade.result === 'LOSS') {
        const existingTradePnl = typeof existingTrade.realizedPnl === 'number' ? existingTrade.realizedPnl : (existingTrade.pl || 0);
        if (existingTrade.result === record.outcome && existingTradePnl === finalRealizedPnl && source !== 'MT5') {
          return {
            success: true,
            isDuplicate: true,
            outcome: { ...record, outcome: existingTrade.result, realizedPnl: existingTradePnl },
            trade: existingTrade,
            message: `تم توثيق نتيجة هذه الصفقة مسبقاً (${existingTrade.result === 'WIN' ? '🟢 رابحة' : '🔴 خاسرة'}) بقيمة $${finalRealizedPnl}.`,
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
      const lotSize = existingTrade.lotSize || signalData?.recommendedLotSize || (signalData as any)?.lotSize || 0.01;
      const entryPrice = Number(record.entry || existingTrade.entry || signalData?.entry || 0);
      const tp1Price = Number(record.tp1 || existingTrade.tp1 || signalData?.tp1 || 0);
      const tp2Price = Number(record.tp2 || existingTrade.tp2 || signalData?.tp2 || 0);
      const slPrice = Number(record.stopLoss || existingTrade.sl || signalData?.stopLoss || 0);

      const theoreticalTp1Profit = Number((Math.abs(entryPrice - tp1Price) * 100 * lotSize).toFixed(2));
      const theoreticalTp2Profit = Number((Math.abs(entryPrice - tp2Price) * 100 * lotSize).toFixed(2));

      const previousPnl = typeof existingTrade.realizedPnl === 'number'
        ? existingTrade.realizedPnl
        : (existingTrade.result === 'WIN' || existingTrade.result === 'LOSS' ? (existingTrade.pl || 0) : 0);

      const delta = Number((finalRealizedPnl - previousPnl).toFixed(2));

      existingTrade.result = record.outcome;
      existingTrade.pl = finalRealizedPnl;
      existingTrade.realizedPnl = finalRealizedPnl;
      existingTrade.source = source;
      if (record.brokerDealId) existingTrade.brokerDealId = record.brokerDealId;
      if (record.brokerOrderId) existingTrade.brokerOrderId = record.brokerOrderId;
      if (record.closedAt) existingTrade.closedAt = record.closedAt;
      if (record.closeReason) existingTrade.closeReason = record.closeReason;
      existingTrade.theoreticalTp1Profit = theoreticalTp1Profit;
      existingTrade.theoreticalTp2Profit = theoreticalTp2Profit;
      existingTrade.exitPrice = record.exitPrice !== undefined ? record.exitPrice : (isWin ? (existingTrade.tp1 || record.tp1) : (existingTrade.sl || record.stopLoss));
      existingTrade.exitTime = new Date(record.timestamp || Date.now()).toISOString();
      existingTrade.notes = `${existingTrade.notes ? existingTrade.notes + ' | ' : ''}النتيجة: ${isWin ? '🟢 رابحة' : '🔴 خاسرة'} [P&L: ${finalRealizedPnl >= 0 ? '+' : ''}$${finalRealizedPnl.toFixed(2)}] (${source})`;
      existingTrade.isActive = false;

      this.inMemoryCurrentBalance = Number((this.inMemoryCurrentBalance + delta).toFixed(2));
      existingTrade.balanceAfterTrade = this.inMemoryCurrentBalance;

      const updatedTrade = existingTrade;

      // Firestore persistence
      if (this.firestoreDb && this.shouldPersist()) {
        setDoc(doc(this.firestoreDb, 'trade_outcomes', record.signalId), sanitizeFirestoreData(record)).catch((err) => {
          console.error('[Storage] Firestore recordTradeOutcome error:', err);
        });
        setDoc(doc(this.firestoreDb, 'trade_ledger', updatedTrade.id), sanitizeFirestoreData(updatedTrade)).catch((err) => {
          console.error('[Storage] Firestore saveTrade error in outcome:', err);
        });
        setDoc(doc(this.firestoreDb, 'account_state', 'main'), sanitizeFirestoreData({
          currentBalance: this.inMemoryCurrentBalance,
          startingBalance: this.inMemoryStartingBalance,
          updatedAt: Date.now(),
        })).catch((err) => {
          console.error('[Storage] Firestore account_state update error:', err);
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
    }
  }

  public setCurrentBalance(val: number): void {
    if (typeof val === 'number' && !isNaN(val)) {
      this.inMemoryCurrentBalance = Number(val.toFixed(2));
      this.syncJsonBackups();
    }
  }

  public updateBalance(current: number, starting?: number): { currentBalance: number; startingBalance: number } {
    this.inMemoryCurrentBalance = Number(current.toFixed(2));
    if (typeof starting === 'number' && !isNaN(starting) && starting > 0) {
      this.inMemoryStartingBalance = Number(starting.toFixed(2));
      this.inMemorySettings.manualCapital = this.inMemoryStartingBalance;
      if (this.firestoreDb && this.shouldPersist()) {
        setDoc(doc(this.firestoreDb, 'app_settings', 'main'), sanitizeFirestoreData({
          ...this.inMemorySettings,
          updatedAt: Date.now(),
        })).catch((err) => {
          console.error('[Storage] Firestore updateBalance settings error:', err);
        });
      }
    }

    if (this.firestoreDb && this.shouldPersist()) {
      setDoc(doc(this.firestoreDb, 'account_state', 'main'), sanitizeFirestoreData({
        currentBalance: this.inMemoryCurrentBalance,
        startingBalance: this.inMemoryStartingBalance,
        updatedAt: Date.now(),
      })).catch((err) => {
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

      // Ensure manualCapital in settings is numeric if provided
      if (patch.manualCapital !== undefined) {
        const newCap = Number(patch.manualCapital);
        if (!isNaN(newCap) && newCap >= 0) {
          this.inMemorySettings.manualCapital = Number(newCap.toFixed(2));
        }
      }

      if (this.firestoreDb && this.shouldPersist()) {
        setDoc(doc(this.firestoreDb, 'app_settings', 'main'), sanitizeFirestoreData({
          ...this.inMemorySettings,
          updatedAt: Date.now(),
        })).catch((err) => {
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

  public getTerminalSetups(): string[] {
    return Array.from(this.inMemoryTerminalSetups);
  }

  public saveTerminalSetup(key: string): void {
    if (!key) return;
    this.inMemoryTerminalSetups.add(key);
    if (this.firestoreDb && this.shouldPersist()) {
      setDoc(doc(this.firestoreDb, 'terminal_setups', key.replace(/\//g, '_')), {
        key,
        createdAt: Date.now(),
      }).catch((err) => console.error('[Storage] Firestore saveTerminalSetup error:', err));
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

          const outcomeRecord = {
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

          // Dispatch outcome notification to Telegram
          telegramService.sendOutcomeNotification(outcomeRecord, this.inMemoryTrades[idx]).catch((err) => {
            console.error('[Storage] Telegram outcome alert dispatch error from closeTrade:', err);
          });
        }

        if (this.firestoreDb && this.shouldPersist()) {
          setDoc(doc(this.firestoreDb, 'trade_ledger', id), sanitizeFirestoreData(this.inMemoryTrades[idx])).catch((err) => {
            console.error(`[Storage] Firestore closeTrade error for ${id}:`, err);
          });
          if (isRealizedTrade) {
            setDoc(doc(this.firestoreDb, 'account_state', 'main'), sanitizeFirestoreData({
              currentBalance: this.inMemoryCurrentBalance,
              startingBalance: this.inMemoryStartingBalance,
              updatedAt: Date.now(),
            })).catch((err) => {
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

      if (this.firestoreDb && this.shouldPersist()) {
        deleteDoc(doc(this.firestoreDb, 'trade_ledger', id)).catch((err) => {
          console.error(`[Storage] Firestore deleteTrade error for ${id}:`, err);
        });
        setDoc(doc(this.firestoreDb, 'account_state', 'main'), sanitizeFirestoreData({
          currentBalance: this.inMemoryCurrentBalance,
          startingBalance: this.inMemoryStartingBalance,
          updatedAt: Date.now(),
        })).catch((err) => {
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

  // =========================================================================
  // POI Tracking & Setup Freshness Persistence
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
    if (this.firestoreDb && this.shouldPersist()) {
      setDoc(doc(this.firestoreDb, 'poi_records', poi.id), sanitizeFirestoreData(poi)).catch((err) => {
        console.error(`[Storage] Firestore savePoi error for ${poi.id}:`, err);
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
    if (this.firestoreDb && this.shouldPersist()) {
      setDoc(doc(this.firestoreDb, 'candidate_lifecycles', record.id), sanitizeFirestoreData(record)).catch((err) => {
        console.error(`[Storage] Firestore saveLifecycle error for ${record.id}:`, err);
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
    if (this.firestoreDb && this.shouldPersist()) {
      setDoc(doc(this.firestoreDb, 'opportunities', opp.id.replace(/\//g, '_')), sanitizeFirestoreData(opp)).catch((err) => {
        console.error('[Storage] Firestore saveOpportunity error:', err);
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
      if (this.firestoreDb && this.shouldPersist()) {
        setDoc(doc(this.firestoreDb, 'signals', updatedSignal.id), sanitizeFirestoreData(updatedSignal)).catch((e) => {
          console.error('[Storage] Firestore update signal NOT_ENTERED error:', e);
        });
      }
    }

    // 2. Update Opportunity in memory and storage
    const opp = this.inMemoryOpportunities.get(signalOrOppId) || (updatedSignal?.setupId ? this.inMemoryOpportunities.get(updatedSignal.setupId) : null);
    if (opp) {
      opp.status = 'NOT_ENTERED';
      opp.lastUpdatedTime = Date.now();
      this.inMemoryOpportunities.set(opp.id, opp);
      updatedOpp = opp;
      if (this.firestoreDb && this.shouldPersist()) {
        setDoc(doc(this.firestoreDb, 'opportunities', opp.id.replace(/\//g, '_')), sanitizeFirestoreData(opp)).catch((e) => {
          console.error('[Storage] Firestore update opportunity NOT_ENTERED error:', e);
        });
      }
    }

    // 3. Update candidate lifecycle if found
    const lcIdx = this.inMemoryLifecycles.findIndex((l) => l.id === signalOrOppId || l.poiId === signalOrOppId);
    if (lcIdx >= 0) {
      this.inMemoryLifecycles[lcIdx].state = 'NOT_ENTERED';
      this.inMemoryLifecycles[lcIdx].lastUpdatedTime = Date.now();
      if (this.firestoreDb && this.shouldPersist()) {
        setDoc(doc(this.firestoreDb, 'candidate_lifecycles', this.inMemoryLifecycles[lcIdx].id), sanitizeFirestoreData(this.inMemoryLifecycles[lcIdx])).catch(() => {});
      }
    }

    // 4. Also store outcome record as NOT_ENTERED so that duplicate queries know it was marked NOT_ENTERED
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
    if (this.firestoreDb && this.shouldPersist()) {
      setDoc(doc(this.firestoreDb, 'trade_outcomes', signalOrOppId), sanitizeFirestoreData(outcomeRecord)).catch(() => {});
    }

    this.syncJsonBackups();
    return { success: true, signal: updatedSignal, opportunity: updatedOpp };
  }

  public async clearAllTrades(): Promise<TradeLedgerItem[]> {
    this.inMemoryTrades = [];
    this.inMemoryCurrentBalance = this.inMemoryStartingBalance;
    if (this.firestoreDb && this.shouldPersist()) {
      try {
        const ledgerSnap = await getDocs(collection(this.firestoreDb, 'trade_ledger'));
        for (const docRef of ledgerSnap.docs) {
          await deleteDoc(docRef.ref).catch(() => {});
        }
        await setDoc(doc(this.firestoreDb, 'account_state', 'main'), sanitizeFirestoreData({
          currentBalance: this.inMemoryCurrentBalance,
          startingBalance: this.inMemoryStartingBalance,
          updatedAt: Date.now(),
        })).catch(() => {});
      } catch (e) {
        console.error('[Storage] Error clearing all trades in Firestore:', e);
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
        openTradesCount: this.inMemoryTrades.filter(t => t.result === 'OPEN').length,
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
      const completedTrades = this.inMemoryTrades.filter(t => t.result === 'WIN' || t.result === 'LOSS');
      this.inMemoryTrades = completedTrades;

      // Recalculate current balance based on preserved completed trades
      const totalPl = Number(completedTrades.reduce((acc, t) => acc + (t.pl || 0), 0).toFixed(2));
      this.inMemoryCurrentBalance = Number((this.inMemoryStartingBalance + totalPl).toFixed(2));

      // 6. Sync JSON backups to write the empty collections/cleared state to disk
      this.syncJsonBackups();

      // 7. Clear Firestore collections asynchronously if firestoreDb is defined and persistence is enabled
      if (this.firestoreDb && this.shouldPersist()) {
        try {
          const signalsSnap = await getDocs(collection(this.firestoreDb, 'signals'));
          for (const docRef of signalsSnap.docs) {
            await deleteDoc(docRef.ref).catch(() => {});
          }

          const oppsSnap = await getDocs(collection(this.firestoreDb, 'opportunities'));
          for (const docRef of oppsSnap.docs) {
            await deleteDoc(docRef.ref).catch(() => {});
          }

          const lifecyclesSnap = await getDocs(collection(this.firestoreDb, 'candidate_lifecycles'));
          for (const docRef of lifecyclesSnap.docs) {
            await deleteDoc(docRef.ref).catch(() => {});
          }

          const terminalSnap = await getDocs(collection(this.firestoreDb, 'terminal_setups'));
          for (const docRef of terminalSnap.docs) {
            await deleteDoc(docRef.ref).catch(() => {});
          }

          const ledgerSnap = await getDocs(collection(this.firestoreDb, 'trade_ledger'));
          for (const docRef of ledgerSnap.docs) {
            const data = docRef.data();
            if (data && data.result !== 'WIN' && data.result !== 'LOSS') {
              await deleteDoc(docRef.ref).catch(() => {});
            }
          }

          // Save updated account state to Firestore
          await setDoc(doc(this.firestoreDb, 'account_state', 'main'), sanitizeFirestoreData({
            currentBalance: this.inMemoryCurrentBalance,
            startingBalance: this.inMemoryStartingBalance,
            updatedAt: Date.now(),
          })).catch(() => {});
        } catch (fsErr) {
          console.warn('[Storage] Firestore deletion during reset had some non-blocking errors:', fsErr);
        }
      }

      const auditAfter = {
        signalsCount: this.inMemorySignals.length,
        tradesCount: this.inMemoryTrades.length,
        openTradesCount: this.inMemoryTrades.filter(t => t.result === 'OPEN').length,
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
