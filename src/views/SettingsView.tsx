import React, { useState, useEffect } from 'react';
import {
  Settings,
  ShieldCheck,
  Lock,
  Download,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  Send,
  DollarSign,
  Percent,
  Sliders,
  Scale,
  RefreshCw,
  Cpu,
  Target,
  Zap,
  Activity,
  Layers,
  Radio,
  Flame,
  Power,
} from 'lucide-react';
import { AppSettings, CapitalSource, MT5AccountInfo, ScannerConfig, TradeLedgerItem, BrokerSettings, AccountExecutionMode } from '../types';

interface SettingsViewProps {
  settings: AppSettings;
  activeCapital: number;
  mt5Account?: MT5AccountInfo;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<boolean>;
  onResetDemoBalance?: (bal: number) => void;
  onTestTelegram?: () => Promise<any>;
  ledger?: TradeLedgerItem[];
  currentBalance?: number;
  config?: ScannerConfig;
  brokerSettings?: BrokerSettings;
  onUpdateBrokerSettings?: (settings: BrokerSettings) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  activeCapital,
  mt5Account,
  onUpdateSettings,
  onResetDemoBalance,
  onTestTelegram,
  ledger = [],
  currentBalance,
  config,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<
    'RISK' | 'CAPITAL' | 'STRATEGY' | 'BROKER' | 'TELEGRAM' | 'DATA'
  >('RISK');

  // Form local state
  const [accountMode, setAccountMode] = useState<AccountExecutionMode>(settings.accountMode || 'DEMO');
  const [autoTradingEnabled, setAutoTradingEnabled] = useState<boolean>(settings.autoTradingEnabled || false);
  const [showRealModal, setShowRealModal] = useState<boolean>(false);
  const [realAckChecked, setRealAckChecked] = useState<boolean>(false);

  const [capitalSource, setCapitalSource] = useState<CapitalSource>(settings.capitalSource || 'MANUAL');
  const [manualCapital, setManualCapital] = useState<string>(settings.manualCapital?.toString() || '10');
  const [riskPerTrade, setRiskPerTrade] = useState<string>(settings.riskPerTrade?.toString() || '15');
  const [maxRiskPerTrade, setMaxRiskPerTrade] = useState<string>(settings.maxRiskPerTrade?.toString() || '15');
  const [maxLoss, setMaxLoss] = useState<string>(settings.maxLoss !== undefined ? settings.maxLoss.toString() : '5.00');
  const [minTp1RR, setMinTp1RR] = useState<string>(settings.minTp1RR?.toString() || '1.5');
  const [targetTp2RR, setTargetTp2RR] = useState<string>(settings.targetTp2RR?.toString() || '3.0');
  const [minimumConfidence, setMinimumConfidence] = useState<string>(settings.minimumConfidence?.toString() || '75');

  // Broker contract inputs
  const [contractSizeOz, setContractSizeOz] = useState<string>(settings.contractSizeOz?.toString() || '100');
  const [minimumLot, setMinimumLot] = useState<string>(settings.minimumLot?.toString() || '0.01');
  const [maximumLot, setMaximumLot] = useState<string>(settings.maximumLot?.toString() || '100');
  const [lotStep, setLotStep] = useState<string>(settings.lotStep?.toString() || '0.01');
  const [maxGoldSlPoints, setMaxGoldSlPoints] = useState<string>(settings.maxGoldSlPoints?.toString() || '100');

  // Test lot calculator state for UI preview
  const [previewSlPoints, setPreviewSlPoints] = useState<number>(40); // 40 points = $4.00 gold distance

  // Action status state
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [telegramStatus, setTelegramStatus] = useState<string | null>(null);
  const [isTestingTg, setIsTestingTg] = useState<boolean>(false);

  // Sync state when props change (only if user hasn't made unsaved edits)
  useEffect(() => {
    if (isDirty) return;
    setAccountMode(settings.accountMode || 'DEMO');
    setAutoTradingEnabled(settings.autoTradingEnabled || false);
    setCapitalSource(settings.capitalSource || 'MANUAL');
    setManualCapital(settings.manualCapital?.toString() || '10');
    setRiskPerTrade(settings.riskPerTrade?.toString() || '15');
    setMaxRiskPerTrade(settings.maxRiskPerTrade?.toString() || '15');
    setMaxLoss(settings.maxLoss !== undefined ? settings.maxLoss.toString() : '5.00');
    setMinTp1RR(settings.minTp1RR?.toString() || '1.5');
    setTargetTp2RR(settings.targetTp2RR?.toString() || '3.0');
    setMinimumConfidence(settings.minimumConfidence?.toString() || '75');
    setContractSizeOz(settings.contractSizeOz?.toString() || '100');
    setMinimumLot(settings.minimumLot?.toString() || '0.01');
    setMaximumLot(settings.maximumLot?.toString() || '100');
    setLotStep(settings.lotStep?.toString() || '0.01');
    setMaxGoldSlPoints(settings.maxGoldSlPoints?.toString() || '100');
  }, [settings, isDirty]);

  // Derived calculations
  const parsedManualCapital = Math.max(0, parseFloat(manualCapital) || 0);
  const effectiveCapital = capitalSource === 'MT5'
    ? (mt5Account?.connected && typeof mt5Account.balance === 'number' ? mt5Account.balance : 0)
    : parsedManualCapital;

  const parsedRiskPct = Math.max(0.1, parseFloat(riskPerTrade) || 15);
  const parsedMaxRiskPct = Math.max(0.1, parseFloat(maxRiskPerTrade) || 15);
  const effectiveRiskPct = Math.min(parsedRiskPct, parsedMaxRiskPct);
  const liveRiskAmount = Number(((effectiveCapital * effectiveRiskPct) / 100).toFixed(2));
  const maxAllowedRiskAmount = Number(((effectiveCapital * parsedMaxRiskPct) / 100).toFixed(2));

  // Position sizing calculations for preview
  const previewContract = parseFloat(contractSizeOz) || 100;
  const previewMinLot = parseFloat(minimumLot) || 0.01;
  const previewPriceDistance = previewSlPoints * 0.1; // 1 point = $0.10 in gold price
  const riskPerStdLot = previewPriceDistance * previewContract;
  const calculatedLot = riskPerStdLot > 0 ? liveRiskAmount / riskPerStdLot : 0;
  const minimumLotLoss = previewMinLot * riskPerStdLot;
  const parsedMaxLoss = Math.max(0.5, parseFloat(maxLoss) || 5.00);
  const isMinLotExceedingMaxLoss = minimumLotLoss > parsedMaxLoss + 0.0001;
  const isMinLotExceedingRisk = liveRiskAmount > 0 && minimumLotLoss > liveRiskAmount;

  // Handle Save
  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus(null);

    const numManualCapital = parseFloat(manualCapital);
    const numRiskPerTrade = parseFloat(riskPerTrade);
    const numMaxRisk = parseFloat(maxRiskPerTrade);
    const numMaxLoss = parseFloat(maxLoss);
    const numMinTp1 = parseFloat(minTp1RR);
    const numTargetTp2 = parseFloat(targetTp2RR);
    const numMinConfidence = parseFloat(minimumConfidence);

    // Validation
    if (isNaN(numManualCapital) || numManualCapital < 0) {
      setSaveStatus({ type: 'error', message: 'يرجى إدخال رأس مال يدوي صحيح (أكبر من أو يساوي 0).' });
      setIsSaving(false);
      return;
    }

    if (isNaN(numRiskPerTrade) || numRiskPerTrade <= 0 || isNaN(numMaxRisk) || numMaxRisk <= 0) {
      setSaveStatus({ type: 'error', message: 'يرجى إدخال نسبة مخاطرة صحيحة أكبر من 0%.' });
      setIsSaving(false);
      return;
    }

    if (isNaN(numMaxLoss) || numMaxLoss < 0.5) {
      setSaveStatus({ type: 'error', message: 'يرجى إدخال حد أقصى صحيح للخسارة (0.5$ على الأقل).' });
      setIsSaving(false);
      return;
    }

    if (numRiskPerTrade > numMaxRisk) {
      setSaveStatus({
        type: 'error',
        message: `نسبة المخاطرة (${numRiskPerTrade}%) لا يمكن أن تتجاوز الحد الأقصى المسموح (${numMaxRisk}%).`,
      });
      setIsSaving(false);
      return;
    }

    if (isNaN(numMinTp1) || numMinTp1 < 1.0) {
      setSaveStatus({ type: 'error', message: 'الحد الأدنى لـ TP1 RR يجب أن يكون 1.0 على الأقل.' });
      setIsSaving(false);
      return;
    }

    if (isNaN(numTargetTp2) || numTargetTp2 < numMinTp1) {
      setSaveStatus({
        type: 'error',
        message: `هدف TP2 RR (${numTargetTp2}) يجب أن يكون أكبر من أو يساوي هدف TP1 (${numMinTp1}).`,
      });
      setIsSaving(false);
      return;
    }

    const patch: Partial<AppSettings> = {
      accountMode,
      executionMode: accountMode,
      autoTradingEnabled,
      capitalSource,
      manualCapital: numManualCapital,
      riskPerTrade: Math.min(numRiskPerTrade, numMaxRisk),
      maxRiskPerTrade: numMaxRisk,
      maxLoss: Math.max(0.5, parseFloat(maxLoss) || 5.00),
      minTp1RR: numMinTp1,
      targetTp2RR: numTargetTp2,
      minimumConfidence: Math.min(100, Math.max(50, numMinConfidence || 75)),
      contractSizeOz: parseFloat(contractSizeOz) || 100,
      minimumLot: parseFloat(minimumLot) || 0.01,
      maximumLot: parseFloat(maximumLot) || 100,
      lotStep: parseFloat(lotStep) || 0.01,
      maxGoldSlPoints: parseFloat(maxGoldSlPoints) || 100,
    };

    const success = await onUpdateSettings(patch);
    setIsSaving(false);
    if (success) {
      setIsDirty(false);
      setSaveStatus({
        type: 'success',
        message: 'تم حفظ وتطبيق الإعدادات بنجاح في الخادم والـ Scanner والـ Risk Manager والـ TP Engine!',
      });
      setTimeout(() => setSaveStatus(null), 5000);
    } else {
      setSaveStatus({
        type: 'error',
        message: 'فشل حفظ الإعدادات في الخادم. تأكد من صحة البيانات.',
      });
    }
  };

  // Export trade history
  const handleExportData = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(ledger, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `xauusd_trade_history_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleTestTg = async () => {
    if (!onTestTelegram) return;
    setIsTestingTg(true);
    try {
      const res = await onTestTelegram();
      setTelegramStatus(res?.message || 'تم إرسال الرسالة التجريبية');
    } catch (e: any) {
      setTelegramStatus(e.message || 'فشل الاتصال بتلغرام');
    } finally {
      setIsTestingTg(false);
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6 animate-in fade-in duration-250">
      {/* Top Banner */}
      <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center">
            <Settings className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-black text-stone-100 font-mono">
              إعدادات وإدارة المخاطر (Settings & Risk Management)
            </h3>
            <p className="text-xs text-stone-400 mt-0.5">
              تحكم حقيقي كامل في رأس المال، نسبة المخاطرة، أهداف الأرباح، وحساب أحجام العقود
            </p>
          </div>
        </div>

        {/* Live Capital & Risk Summary Chip */}
        <div className="flex items-center gap-2 bg-stone-950/80 border border-stone-800 rounded-xl px-3 py-1.5 font-mono text-xs">
          <span className="text-stone-400">Active Capital:</span>
          <span className="font-black text-amber-400">
            ${effectiveCapital > 0 ? effectiveCapital.toFixed(2) : '0.00'}
          </span>
          <span className="text-stone-600">|</span>
          <span className="text-stone-400">Risk:</span>
          <span className="font-bold text-rose-400">{effectiveRiskPct}% (${liveRiskAmount.toFixed(2)})</span>
        </div>
      </div>

      {/* Global Status Toast */}
      {saveStatus && (
        <div
          className={`p-3.5 rounded-xl border flex items-center gap-2.5 text-xs font-mono animate-in fade-in ${
            saveStatus.type === 'success'
              ? 'bg-emerald-950/80 border-emerald-800 text-emerald-300'
              : 'bg-rose-950/80 border-rose-800 text-rose-300'
          }`}
        >
          {saveStatus.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
          )}
          <span>{saveStatus.message}</span>
        </div>
      )}

      {/* Sub-Navigation Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-2 border-b border-stone-800 scrollbar-none">
        {[
          { id: 'RISK', label: 'المخاطرة وحجم العقود (Risk & Lot Sizing)' },
          { id: 'CAPITAL', label: 'مصدر رأس المال (Capital Source)' },
          { id: 'STRATEGY', label: 'الاستراتيجية والتداول (Trading Rules)' },
          { id: 'BROKER', label: 'مواصفات الوسيط (Broker Specs)' },
          { id: 'TELEGRAM', label: 'تلغرام (Telegram)' },
          { id: 'DATA', label: 'البيانات (Data / Export)' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveSubTab(tab.id as any)}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${
              activeSubTab === tab.id
                ? 'bg-amber-500 text-stone-950 shadow-xs'
                : 'bg-stone-900 text-stone-400 hover:text-stone-200 border border-stone-800'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ========================================================= */}
      {/* 1. RISK & POSITION SIZING TAB                             */}
      {/* ========================================================= */}
      {activeSubTab === 'RISK' && (
        <div className="space-y-4">
          {/* Main Risk Parameters Card */}
          <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-6 space-y-5 shadow-xs">
            <div className="flex items-center justify-between border-b border-stone-800 pb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-amber-400" />
                <h4 className="text-sm font-black text-stone-100 font-mono">
                  معايير المخاطرة (Risk Parameters)
                </h4>
              </div>
              <span className="text-[11px] text-stone-400 font-mono">
                تطبق فورياً على كل فحص آلي وحسابات الصفقات
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Starting Capital Input */}
              <div className="bg-stone-950/80 border border-stone-800/90 rounded-xl p-3.5 space-y-2">
                <label className="text-xs font-bold text-stone-200 block font-mono">
                  رأس المال الافتتاحي (Starting Capital $)
                </label>
                <div className="relative">
                  <input
                    type="number"
                    step="1"
                    min="1"
                    value={manualCapital}
                    onChange={(e) => {
                      setManualCapital(e.target.value);
                      setIsDirty(true);
                    }}
                    className="w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 text-stone-100 font-mono text-sm focus:outline-hidden focus:border-amber-400 pl-8"
                  />
                  <span className="absolute left-3 top-2.5 text-xs text-stone-400 font-mono">$</span>
                </div>
                {/* Presets */}
                <div className="flex items-center gap-1.5 pt-1">
                  <span className="text-[10px] text-stone-400 font-mono">سريع:</span>
                  {[10, 25, 50, 100, 500].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => {
                        setManualCapital(preset.toString());
                        setIsDirty(true);
                      }}
                      className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold transition-all ${
                        parseFloat(manualCapital) === preset
                          ? 'bg-amber-500 text-stone-950'
                          : 'bg-stone-900 text-stone-300 hover:bg-stone-800 border border-stone-800'
                      }`}
                    >
                      ${preset}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-stone-400">
                  رأس المال الأساسي لحساب التحدي المستخدم لحجم العقود والمخاطرة.
                </p>
              </div>

              {/* Risk Per Trade Input */}
              <div className="bg-stone-950/80 border border-stone-800/90 rounded-xl p-3.5 space-y-2">
                <label className="text-xs font-bold text-stone-200 block font-mono">
                  نسبة المخاطرة لكل صفقة (Risk Per Trade %)
                </label>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <input
                      type="number"
                      step="0.5"
                      min="0.5"
                      max={parsedMaxRiskPct}
                      value={riskPerTrade}
                      onChange={(e) => {
                        setRiskPerTrade(e.target.value);
                        setIsDirty(true);
                      }}
                      className="w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 text-stone-100 font-mono text-sm focus:outline-hidden focus:border-amber-400"
                    />
                    <span className="absolute left-3 top-2.5 text-xs text-stone-400 font-mono">%</span>
                  </div>
                </div>
                {/* Presets */}
                <div className="flex items-center gap-1.5 pt-1">
                  <span className="text-[10px] text-stone-400 font-mono">إعداد سريع:</span>
                  {[1, 2, 5, 10, 15, 20].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => {
                        setRiskPerTrade(preset.toString());
                        setIsDirty(true);
                      }}
                      className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold transition-all ${
                        parseFloat(riskPerTrade) === preset
                          ? 'bg-amber-500 text-stone-950'
                          : 'bg-stone-900 text-stone-300 hover:bg-stone-800 border border-stone-800'
                      }`}
                    >
                      {preset}%
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-stone-400">
                  القيمة الافتراضية لحساب التحدي هي 15%. لا يمكن تجاوز الحد الأقصى المحدد.
                </p>
              </div>

              {/* Maximum Allowed Risk */}
              <div className="bg-stone-950/80 border border-stone-800/90 rounded-xl p-3.5 space-y-2">
                <label className="text-xs font-bold text-stone-200 block font-mono">
                  الحد الأقصى المسموح للمخاطرة (Maximum Allowed Risk %)
                </label>
                <div className="relative">
                  <input
                    type="number"
                    step="0.5"
                    min="1"
                    max="30"
                    value={maxRiskPerTrade}
                    onChange={(e) => {
                      setMaxRiskPerTrade(e.target.value);
                      setIsDirty(true);
                    }}
                    className="w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 text-stone-100 font-mono text-sm focus:outline-hidden focus:border-amber-400"
                  />
                  <span className="absolute left-3 top-2.5 text-xs text-stone-400 font-mono">%</span>
                </div>
                <p className="text-[11px] text-stone-400">
                  سقف الأمان الصارم. يمنع الـ UI والـ Backend ضبط أي مخاطرة أعلى من هذا الحد نهائياً.
                </p>
              </div>

              {/* Max Monetary Loss Limit ($) */}
              <div className="bg-stone-950/80 border border-rose-900/60 rounded-xl p-3.5 space-y-2">
                <label className="text-xs font-bold text-rose-200 block font-mono">
                  سقف الخسارة النقدي (Max Loss Limit $)
                </label>
                <div className="relative">
                  <input
                    type="number"
                    step="0.5"
                    min="0.5"
                    max="100"
                    value={maxLoss}
                    onChange={(e) => {
                      setMaxLoss(e.target.value);
                      setIsDirty(true);
                    }}
                    className="w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 text-stone-100 font-mono text-sm focus:outline-hidden focus:border-rose-400 pl-8"
                  />
                  <span className="absolute left-3 top-2.5 text-xs text-rose-400 font-mono">$</span>
                </div>
                {/* Presets */}
                <div className="flex items-center gap-1.5 pt-1">
                  <span className="text-[10px] text-stone-400 font-mono">سريع:</span>
                  {[2, 3, 5, 10, 15].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => {
                        setMaxLoss(preset.toString());
                        setIsDirty(true);
                      }}
                      className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold transition-all ${
                        parseFloat(maxLoss) === preset
                          ? 'bg-rose-600 text-stone-50'
                          : 'bg-stone-900 text-stone-300 hover:bg-stone-800 border border-stone-800'
                      }`}
                    >
                      ${preset}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-stone-400">
                  سقف الخسارة الصارم بالدولار للصفقة. تُرفض الصفقة تلقائياً إذا تجاوزت خسارة أقل لوت (0.01) هذا السقف.
                </p>
              </div>
            </div>

            {/* Live Computed Risk Amount Display */}
            <div className="bg-amber-950/20 border border-amber-500/30 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <DollarSign className="w-5 h-5 text-amber-400" />
                <div>
                  <span className="text-xs text-stone-300 font-mono block">
                    المخاطرة المحسوبة بالدولار (Risk Amount):
                  </span>
                  <span className="text-lg font-black text-amber-400 font-mono">
                    ${liveRiskAmount.toFixed(2)}{' '}
                    <span className="text-xs text-stone-400 font-normal">
                      ({effectiveRiskPct}% من ${effectiveCapital.toFixed(2)})
                    </span>
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-4 text-right font-mono text-xs">
                <div>
                  <span className="text-stone-400 block text-[11px]">أقصى نسبة مسموحة:</span>
                  <span className="font-bold text-amber-400">${maxAllowedRiskAmount.toFixed(2)}</span>
                </div>
                <div className="pl-3 border-l border-stone-800">
                  <span className="text-stone-400 block text-[11px]">سقف الخسارة النقدي (Max Loss):</span>
                  <span className="font-bold text-rose-400">${parsedMaxLoss.toFixed(2)}</span>
                </div>
              </div>
            </div>

            {/* Take Profit Target Rules */}
            <div className="pt-2 border-t border-stone-800 space-y-3">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 text-emerald-400" />
                <h5 className="text-xs font-bold text-stone-200 uppercase tracking-wider font-mono">
                  أهداف الأرباح الديناميكية (Dynamic Take Profit Engine)
                </h5>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Min TP1 RR */}
                <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-3 space-y-1.5">
                  <label className="text-xs font-bold text-stone-300 block font-mono">
                    Minimum TP1 RR Ratio
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      step="0.1"
                      min="1.0"
                      max="10.0"
                      value={minTp1RR}
                      onChange={(e) => setMinTp1RR(e.target.value)}
                      className="w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-1.5 text-stone-100 font-mono text-sm focus:outline-hidden focus:border-amber-400"
                    />
                    <span className="text-xs text-stone-400 font-mono whitespace-nowrap">
                      (1:{parseFloat(minTp1RR) || 1.5})
                    </span>
                  </div>
                  <p className="text-[10px] text-stone-400">
                    الافتراضي 1.5. يُرفض الـ Setup تلقائياً إذا كان هناك حاجز سيولة أو مقاومة/دعم أقرب من هذا الهدف.
                  </p>
                </div>

                {/* Target TP2 RR */}
                <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-3 space-y-1.5">
                  <label className="text-xs font-bold text-stone-300 block font-mono">
                    Target TP2 RR Ratio
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      step="0.1"
                      min={parseFloat(minTp1RR) || 1.5}
                      max="15.0"
                      value={targetTp2RR}
                      onChange={(e) => setTargetTp2RR(e.target.value)}
                      className="w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-1.5 text-stone-100 font-mono text-sm focus:outline-hidden focus:border-amber-400"
                    />
                    <span className="text-xs text-stone-400 font-mono whitespace-nowrap">
                      (1:{parseFloat(targetTp2RR) || 3.0})
                    </span>
                  </div>
                  <p className="text-[10px] text-stone-400">
                    الافتراضي 3.0. يستهدف مسابح السيولة الرئيسية وأقرب كتل أوامر متضادة على فريم الساعة وفريم الـ 15 دقيقة.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Position Sizing Simulator & Protection Card */}
          <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-6 space-y-4 shadow-xs">
            <div className="flex items-center justify-between border-b border-stone-800 pb-2">
              <div className="flex items-center gap-2">
                <Scale className="w-5 h-5 text-cyan-400" />
                <h4 className="text-sm font-black text-stone-100 font-mono">
                  حساب أحجام العقود وحماية أقل لوت (Position Sizing & Lot Protection)
                </h4>
              </div>
              <span className="text-[11px] text-stone-400 font-mono">
                حجم العقد القياسي: {contractSizeOz} أونصة ذهب
              </span>
            </div>

            {/* Interactive SL points simulator */}
            <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-3.5 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-stone-200 font-mono">
                  تجربة وقف خسارة افتراضي (Test SL Distance):
                </label>
                <span className="text-xs font-mono font-bold text-amber-400">
                  {previewSlPoints} نقطة (${(previewSlPoints * 0.1).toFixed(2)})
                </span>
              </div>
              <input
                type="range"
                min="10"
                max={parseFloat(maxGoldSlPoints) || 100}
                step="5"
                value={previewSlPoints}
                onChange={(e) => setPreviewSlPoints(Number(e.target.value))}
                className="w-full accent-amber-500"
              />

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2 text-xs font-mono">
                <div className="bg-stone-900 p-2.5 rounded-lg border border-stone-800">
                  <span className="text-stone-400 text-[10px] block">Estimated Lot Size</span>
                  <span className="text-sm font-bold text-cyan-400 block mt-0.5">
                    {calculatedLot.toFixed(4)} Lot
                  </span>
                </div>

                <div className="bg-stone-900 p-2.5 rounded-lg border border-stone-800">
                  <span className="text-stone-400 text-[10px] block">Broker Minimum Lot</span>
                  <span className="text-sm font-bold text-stone-200 block mt-0.5">
                    {previewMinLot} Lot
                  </span>
                </div>

                <div className="bg-stone-900 p-2.5 rounded-lg border border-stone-800">
                  <span className="text-stone-400 text-[10px] block">Loss at 0.01 Lot</span>
                  <span className="text-sm font-bold text-stone-200 block mt-0.5">
                    ${minimumLotLoss.toFixed(2)}
                  </span>
                </div>

                <div className="bg-stone-900 p-2.5 rounded-lg border border-stone-800">
                  <span className="text-stone-400 text-[10px] block">Max Loss Ceiling</span>
                  <span className="text-sm font-bold text-amber-400 block mt-0.5">
                    ${parsedMaxLoss.toFixed(2)}
                  </span>
                </div>

                <div className="bg-stone-900 p-2.5 rounded-lg border border-stone-800">
                  <span className="text-stone-400 text-[10px] block">Execution Verdict</span>
                  <span
                    className={`text-xs font-bold block mt-1 ${
                      isMinLotExceedingMaxLoss
                        ? 'text-rose-400'
                        : isMinLotExceedingRisk
                        ? 'text-amber-400'
                        : 'text-emerald-400'
                    }`}
                  >
                    {isMinLotExceedingMaxLoss
                      ? 'BLOCKED'
                      : isMinLotExceedingRisk
                      ? 'ALLOWED (Max Loss)'
                      : 'EXECUTABLE'}
                  </span>
                </div>
              </div>

              {/* Warning condition matching riskManager logic */}
              {isMinLotExceedingMaxLoss ? (
                <div className="p-3 bg-rose-950/60 border border-rose-800/80 rounded-lg text-rose-300 text-xs font-mono flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
                  <div>
                    <span className="font-bold block">
                      TRADE BLOCKED: Minimum lot loss (${minimumLotLoss.toFixed(2)}) exceeds Max Loss limit (${parsedMaxLoss.toFixed(2)}).
                    </span>
                    <span className="text-[11px] text-rose-300/80 mt-0.5 block">
                      خسارة أقل لوت مسموح ({previewMinLot}) عند وقف {previewSlPoints} نقطة تعادل ${minimumLotLoss.toFixed(2)}، وهي أعلى من سقف الخسارة النقدي (${parsedMaxLoss.toFixed(2)}). النظام يرفض فتح الصفقة آلياً لمنع خرق المخاطرة.
                    </span>
                  </div>
                </div>
              ) : isMinLotExceedingRisk ? (
                <div className="p-3 bg-amber-950/40 border border-amber-800/60 rounded-lg text-amber-300 text-xs font-mono flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
                  <div>
                    <span className="font-bold block">
                      ALLOWED VIA MAX LOSS: Loss at 0.01 lot (${minimumLotLoss.toFixed(2)}) is within Max Loss limit (${parsedMaxLoss.toFixed(2)}).
                    </span>
                    <span className="text-[11px] text-amber-300/80 mt-0.5 block">
                      خسارة أقل لوت (${minimumLotLoss.toFixed(2)}) تفوق نسبة الـ {effectiveRiskPct}% (${liveRiskAmount.toFixed(2)}) ولكنها ضمن سقف الخسارة النقدي المحدد (${parsedMaxLoss.toFixed(2)}). تُنفذ الصفقة بأقل لوت (0.01) لحسابات التحدي الصغيرة دون رفض.
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* Execution & Account Mode Card (DEMO vs REAL) */}
          <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-6 space-y-4 shadow-xs">
            <div className="flex items-center justify-between border-b border-stone-800 pb-3">
              <div className="flex items-center gap-2">
                <Power className="w-5 h-5 text-amber-400" />
                <h4 className="text-sm font-black text-stone-100 font-mono">
                  وضع حساب التنفيذ وجسر MT5 (Account Mode & MT5 Execution Bridge)
                </h4>
              </div>
              <span
                className={`px-3 py-1 rounded-full text-xs font-black font-mono border ${
                  accountMode === 'REAL'
                    ? 'bg-rose-950 text-rose-300 border-rose-600 animate-pulse'
                    : 'bg-cyan-950 text-cyan-300 border-cyan-700'
                }`}
              >
                {accountMode === 'REAL' ? '● REAL ACCOUNT ACTIVE' : '● DEMO ACCOUNT (SAFE)'}
              </span>
            </div>

            {/* Account Mode Quick Toggle Header & Selection Switch */}
            <div className="bg-stone-950/90 border border-stone-800 rounded-xl p-3 sm:p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-800/80 pb-2.5">
                <span className="text-xs font-bold text-stone-200 font-mono">
                  اختر نوع الحساب النشط للتنفيذ (Execution Mode Toggle):
                </span>
                {/* Visual Direct Switcher Pill Buttons */}
                <div className="flex items-center gap-1.5 bg-stone-900 border border-stone-800 p-1 rounded-xl">
                  <button
                    type="button"
                    onClick={() => setAccountMode('DEMO')}
                    className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-black font-mono transition-all cursor-pointer ${
                      accountMode === 'DEMO'
                        ? 'bg-cyan-500 text-stone-950 shadow-sm'
                        : 'text-stone-400 hover:text-stone-200'
                    }`}
                  >
                    <span>🟢</span>
                    <span>DEMO</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      if (accountMode !== 'REAL') {
                        setShowRealModal(true);
                      }
                    }}
                    className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-black font-mono transition-all cursor-pointer ${
                      accountMode === 'REAL'
                        ? 'bg-rose-600 text-white shadow-sm animate-pulse'
                        : 'text-stone-400 hover:text-stone-200'
                    }`}
                  >
                    <span>🔴</span>
                    <span>REAL</span>
                  </button>
                </div>
              </div>

              {/* Account Mode Detailed Selection Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                {/* DEMO CARD */}
                <button
                  type="button"
                  onClick={() => setAccountMode('DEMO')}
                  className={`p-3.5 rounded-xl border text-right transition-all cursor-pointer ${
                    accountMode === 'DEMO'
                      ? 'bg-cyan-950/50 border-cyan-500/80 text-stone-100 shadow-md ring-1 ring-cyan-500/30'
                      : 'bg-stone-950/70 border-stone-800 text-stone-400 hover:border-stone-700'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-base">🟢</span>
                      <span className="font-bold text-xs sm:text-sm font-mono text-cyan-300">DEMO MODE (تجريبي)</span>
                    </div>
                    <span
                      className={`w-3.5 h-3.5 rounded-full border ${
                        accountMode === 'DEMO' ? 'bg-cyan-400 border-cyan-300' : 'bg-stone-800 border-stone-700'
                      }`}
                    />
                  </div>
                  <p className="text-[11px] text-stone-400 mt-1">
                    الوضع الافتراضي الآمن. يتم تنفيذ وتتبع الصفقات داخل الـ Ledger المعتمد بدون إرسال صفقات مالية حقيقية.
                  </p>
                  <div className="mt-2 flex items-center gap-2 text-[10px] text-cyan-300 font-mono">
                    <span>✓ إدارة مخاطر نشطة</span>
                    <span>✓ مسح حي للأسعار</span>
                  </div>
                </button>

                {/* REAL CARD */}
                <button
                  type="button"
                  onClick={() => {
                    if (accountMode !== 'REAL') {
                      setShowRealModal(true);
                    }
                  }}
                  className={`p-3.5 rounded-xl border text-right transition-all cursor-pointer relative ${
                    accountMode === 'REAL'
                      ? 'bg-rose-950/50 border-rose-500/80 text-stone-100 shadow-md ring-1 ring-rose-500/30'
                      : 'bg-stone-950/70 border-stone-800 text-stone-400 hover:border-rose-900/50'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-base">🔴</span>
                      <span className="font-bold text-xs sm:text-sm font-mono text-rose-300">REAL MODE (حساب حقيقي)</span>
                    </div>
                    <span
                      className={`w-3.5 h-3.5 rounded-full border ${
                        accountMode === 'REAL' ? 'bg-rose-500 border-rose-300' : 'bg-stone-800 border-stone-700'
                      }`}
                    />
                  </div>
                  <p className="text-[11px] text-stone-400 mt-1">
                    تنفيذ فعلي مباشر على حسابك الحقيقي عبر MT5 Execution Bridge. يتطلب تأكيداً صريحاً ويخضع لقواعد المخاطرة.
                  </p>
                  <div className="mt-2 flex items-center gap-2 text-[10px] text-rose-300 font-mono">
                    <span>⚠ أموال حقيقية</span>
                    <span>⚠ Lot Protection</span>
                  </div>
                </button>
              </div>
            </div>

            {/* Auto Trading Switch (Default OFF) */}
            <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center border ${
                  autoTradingEnabled
                    ? 'bg-amber-500/20 border-amber-500/40 text-amber-400'
                    : 'bg-stone-900 border-stone-800 text-stone-500'
                }`}>
                  <Zap className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-stone-200 font-mono">التداول الآلي التلقائي (Auto-Trading Execution):</span>
                    <span className={`px-2 py-0.2 rounded text-[10px] font-mono font-bold ${
                      autoTradingEnabled
                        ? 'bg-amber-950 text-amber-300 border border-amber-800'
                        : 'bg-stone-900 text-stone-400 border border-stone-800'
                    }`}>
                      {autoTradingEnabled ? 'ENABLED' : 'OFF (الافتراضي)'}
                    </span>
                  </div>
                  <p className="text-[11px] text-stone-400 mt-0.5">
                    عند التفعيل، يقوم الـ Scanner بإرسال الأوامر المؤهلة آلياً لـ MT5 Bridge بدون انتظار ضغط زر التنفيذ اليدوي.
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setAutoTradingEnabled(!autoTradingEnabled)}
                className={`px-4 py-1.5 rounded-lg text-xs font-bold font-mono transition-all border cursor-pointer ${
                  autoTradingEnabled
                    ? 'bg-amber-500 text-stone-950 border-amber-400'
                    : 'bg-stone-900 text-stone-300 border-stone-700 hover:bg-stone-800'
                }`}
              >
                {autoTradingEnabled ? 'إيقاف التداول الآلي (Disable)' : 'تفعيل التداول الآلي (Enable)'}
              </button>
            </div>

            {/* Live MT5 Bridge Connection Status Panel */}
            <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-3.5 space-y-2 font-mono text-xs">
              <div className="flex items-center justify-between border-b border-stone-800/60 pb-2">
                <span className="text-stone-300 font-bold">حالة ربط جسر MT5 التنفيذي:</span>
                <span className={`px-2.5 py-0.5 rounded text-[11px] font-bold border flex items-center gap-1.5 ${
                  mt5Account?.connected
                    ? 'bg-emerald-950/80 border-emerald-800 text-emerald-400'
                    : 'bg-rose-950/80 border-rose-800 text-rose-400'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${mt5Account?.connected ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                  {mt5Account?.connected ? 'CONNECTED (متصل)' : 'DISCONNECTED (غير متصل)'}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1 text-[11px]">
                <div className="bg-stone-900/90 p-2 rounded-lg border border-stone-800">
                  <span className="text-stone-400 text-[10px] block">Account Mode</span>
                  <span className={`font-bold mt-0.5 block ${accountMode === 'REAL' ? 'text-rose-400' : 'text-cyan-400'}`}>
                    {accountMode}
                  </span>
                </div>
                <div className="bg-stone-900/90 p-2 rounded-lg border border-stone-800">
                  <span className="text-stone-400 text-[10px] block">Account Number</span>
                  <span className="font-bold text-stone-200 mt-0.5 block truncate">
                    {mt5Account?.accountNumber || (accountMode === 'DEMO' ? 'DEMO-SIM-01' : 'N/A')}
                  </span>
                </div>
                <div className="bg-stone-900/90 p-2 rounded-lg border border-stone-800">
                  <span className="text-stone-400 text-[10px] block">Balance (الرصيد)</span>
                  <span className="font-bold text-amber-400 mt-0.5 block">
                    {mt5Account?.connected && typeof mt5Account.balance === 'number'
                      ? `$${mt5Account.balance.toFixed(2)}`
                      : accountMode === 'DEMO'
                      ? `$${effectiveCapital.toFixed(2)}`
                      : '—'}
                  </span>
                </div>
                <div className="bg-stone-900/90 p-2 rounded-lg border border-stone-800">
                  <span className="text-stone-400 text-[10px] block">Equity (السيولة)</span>
                  <span className="font-bold text-emerald-400 mt-0.5 block">
                    {mt5Account?.connected && typeof mt5Account.equity === 'number'
                      ? `$${mt5Account.equity.toFixed(2)}`
                      : accountMode === 'DEMO'
                      ? `$${effectiveCapital.toFixed(2)}`
                      : '—'}
                  </span>
                </div>
                <div className="bg-stone-900/90 p-2 rounded-lg border border-stone-800 col-span-2 sm:col-span-1">
                  <span className="text-stone-400 text-[10px] block">Free Margin</span>
                  <span className="font-bold text-stone-200 mt-0.5 block">
                    {mt5Account?.connected && typeof mt5Account.freeMargin === 'number'
                      ? `$${mt5Account.freeMargin.toFixed(2)}`
                      : accountMode === 'DEMO'
                      ? `$${effectiveCapital.toFixed(2)}`
                      : '—'}
                  </span>
                </div>
              </div>

              {accountMode === 'REAL' && !mt5Account?.connected && (
                <div className="p-2.5 bg-rose-950/60 border border-rose-800 rounded-lg text-rose-300 text-[11px] flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
                  <div>
                    <span className="font-bold block">تنبيه الحساب الحقيقي: جسر MT5 غير متصل!</span>
                    <span>عند انقطاع جسر MT5 يتم حظر إرسال أو تنفيذ أي أمر حقيقي آلياً لحماية رصيدك حتى عودة الاتصال.</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Save Action Bar */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              disabled={isSaving}
              onClick={handleSave}
              className="px-6 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 font-mono font-black text-xs flex items-center gap-2 transition-all shadow-md disabled:opacity-50 cursor-pointer"
            >
              {isSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              <span>حفظ وتطبيق إعدادات المخاطرة (Save Risk Settings)</span>
            </button>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* 2. CAPITAL SOURCE TAB                                     */}
      {/* ========================================================= */}
      {activeSubTab === 'CAPITAL' && (
        <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-6 space-y-5 shadow-xs">
          <div className="flex items-center justify-between border-b border-stone-800 pb-3">
            <div className="flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-amber-400" />
              <h4 className="text-sm font-black text-stone-100 font-mono">
                مصدر رأس المال والحساب النشط (Capital Source Configuration)
              </h4>
            </div>
            <span className="text-[11px] text-stone-400 font-mono">
              رأس المال الموحد عبر جميع أقسام النظام
            </span>
          </div>

          {/* Capital Source Switcher */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-stone-200 block font-mono">
              اختر مصدر رأس المال (Capital Source):
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setCapitalSource('MANUAL')}
                className={`p-4 rounded-xl border text-right transition-all cursor-pointer ${
                  capitalSource === 'MANUAL'
                    ? 'bg-amber-500/10 border-amber-500/80 text-stone-100 shadow-sm'
                    : 'bg-stone-950/70 border-stone-800 text-stone-400 hover:border-stone-700'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-bold text-sm font-mono text-stone-100">MANUAL (يدوي)</span>
                  <span
                    className={`w-3 h-3 rounded-full ${
                      capitalSource === 'MANUAL' ? 'bg-amber-400' : 'bg-stone-700'
                    }`}
                  />
                </div>
                <p className="text-xs text-stone-400">
                  تحديد رأس المال الافتتاحي يدوياً من واجهة المستخدم (الافتراضي $10.00).
                </p>
              </button>

              <button
                type="button"
                onClick={() => setCapitalSource('MT5')}
                className={`p-4 rounded-xl border text-right transition-all cursor-pointer ${
                  capitalSource === 'MT5'
                    ? 'bg-amber-500/10 border-amber-500/80 text-stone-100 shadow-sm'
                    : 'bg-stone-950/70 border-stone-800 text-stone-400 hover:border-stone-700'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-bold text-sm font-mono text-stone-100">MT5 / BROKER (وسيط MT5)</span>
                  <span
                    className={`w-3 h-3 rounded-full ${
                      capitalSource === 'MT5' ? 'bg-amber-400' : 'bg-stone-700'
                    }`}
                  />
                </div>
                <p className="text-xs text-stone-400">
                  قراءة الرصيد الفعلي مباشرة وبشكل حي من حساب منصة MetaTrader 5 المتصلة.
                </p>
              </button>
            </div>
          </div>

          {/* Conditional View: MANUAL */}
          {capitalSource === 'MANUAL' && (
            <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-4 space-y-3">
              <label className="text-xs font-bold text-stone-200 block font-mono">
                رأس المال الافتتاحي اليدوي (Starting Capital)
              </label>
              <div className="relative max-w-sm">
                <input
                  type="number"
                  step="1"
                  min="1"
                  value={manualCapital}
                  onChange={(e) => {
                    setManualCapital(e.target.value);
                    setIsDirty(true);
                  }}
                  className="w-full bg-stone-900 border border-stone-700 rounded-lg px-3 py-2 text-stone-100 font-mono text-sm focus:outline-hidden focus:border-amber-400 pl-8"
                />
                <span className="absolute left-3 top-2.5 text-xs text-stone-400 font-mono">$</span>
              </div>
              <div className="flex items-center gap-1.5 pt-1">
                <span className="text-[10px] text-stone-400 font-mono">سريع:</span>
                {[10, 25, 50, 100, 500].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => {
                      setManualCapital(preset.toString());
                      setIsDirty(true);
                    }}
                    className={`px-2.5 py-1 rounded text-xs font-mono font-bold transition-all cursor-pointer ${
                      parseFloat(manualCapital) === preset
                        ? 'bg-amber-500 text-stone-950 shadow-sm'
                        : 'bg-stone-900 text-stone-300 hover:bg-stone-800 border border-stone-800'
                    }`}
                  >
                    ${preset}
                  </button>
                ))}
              </div>
              <p className="text-xs text-stone-400">
                قيمة رأس المال المستخدمة في حساب أحجام الصفقات والـ Risk Amount. عند تغييرها إلى $50 يتغير الـ Risk Amount إلى $7.50 فورياً.
              </p>
            </div>
          )}

          {/* Conditional View: MT5 */}
          {capitalSource === 'MT5' && (
            <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-4 space-y-4 font-mono">
              <div className="flex items-center justify-between border-b border-stone-800/80 pb-2.5">
                <span className="text-xs font-bold text-stone-200">MT5 Account Status Feed</span>
                <span
                  className={`px-2.5 py-1 rounded text-xs font-bold flex items-center gap-1.5 border ${
                    mt5Account?.connected
                      ? 'bg-emerald-950/80 border-emerald-800 text-emerald-400'
                      : 'bg-rose-950/80 border-rose-800 text-rose-400'
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      mt5Account?.connected ? 'bg-emerald-400' : 'bg-rose-400'
                    }`}
                  />
                  {mt5Account?.connected ? 'CONNECTED' : 'DISCONNECTED'}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div className="bg-stone-900/90 p-3 rounded-lg border border-stone-800">
                  <span className="text-stone-400 text-[10px] block">MT5 Balance</span>
                  <span className="text-sm font-black text-stone-100 block mt-0.5">
                    {mt5Account?.connected && typeof mt5Account.balance === 'number'
                      ? `$${mt5Account.balance.toFixed(2)}`
                      : '—'}
                  </span>
                </div>

                <div className="bg-stone-900/90 p-3 rounded-lg border border-stone-800">
                  <span className="text-stone-400 text-[10px] block">MT5 Equity</span>
                  <span className="text-sm font-black text-stone-100 block mt-0.5">
                    {mt5Account?.connected && typeof mt5Account.equity === 'number'
                      ? `$${mt5Account.equity.toFixed(2)}`
                      : '—'}
                  </span>
                </div>

                <div className="bg-stone-900/90 p-3 rounded-lg border border-stone-800">
                  <span className="text-stone-400 text-[10px] block">Free Margin</span>
                  <span className="text-sm font-black text-stone-100 block mt-0.5">
                    {mt5Account?.connected && typeof mt5Account.freeMargin === 'number'
                      ? `$${mt5Account.freeMargin.toFixed(2)}`
                      : '—'}
                  </span>
                </div>

                <div className="bg-stone-900/90 p-3 rounded-lg border border-stone-800">
                  <span className="text-stone-400 text-[10px] block">Broker / Server</span>
                  <span className="text-xs font-bold text-stone-300 block mt-0.5 truncate">
                    {mt5Account?.connected ? mt5Account.server || 'MetaQuotes' : 'None'}
                  </span>
                </div>
              </div>

              {/* Disconnected safety guard notice */}
              {!mt5Account?.connected && (
                <div className="p-3 bg-amber-950/40 border border-amber-800/60 rounded-lg text-amber-300 text-xs flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
                  <div>
                    <span className="font-bold block">
                      حساب MT5 غير متصل (DISCONNECTED) - إيقاف التنفيذ التلقائي نشط:
                    </span>
                    <span className="text-[11px] text-amber-200/80 mt-0.5 block">
                      لا يتم استخدام أي بيانات وهمية أو أرصدة مفبركة. نظراً لعدم وجود اتصال نشط بالمنصة،
                      فإن الـ Scanner يحظر فتح أي صفقات جديدة لحماية رأس المال حتى يتم الاتصال.
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Save Button */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              disabled={isSaving}
              onClick={handleSave}
              className="px-6 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 font-mono font-black text-xs flex items-center gap-2 transition-all shadow-md disabled:opacity-50 cursor-pointer"
            >
              {isSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              <span>حفظ وتطبيق مصدر رأس المال (Apply Capital Source)</span>
            </button>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* 3. TRADING & STRATEGY RULES TAB                           */}
      {/* ========================================================= */}
      {activeSubTab === 'STRATEGY' && (
        <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-6 space-y-4 shadow-xs">
          <div className="flex items-center justify-between border-b border-stone-800 pb-2">
            <div className="flex items-center gap-2">
              <Cpu className="w-5 h-5 text-purple-400" />
              <h4 className="text-sm font-black text-stone-100 font-mono">
                قواعد التداول واستراتيجية المسح (Trading Rules & Confidence)
              </h4>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
            {/* Symbol */}
            <div className="p-3.5 bg-stone-950/70 border border-stone-800 rounded-xl space-y-1">
              <span className="text-stone-400 text-[11px] block">Trading Symbol</span>
              <span className="text-sm font-bold text-amber-400 block">XAUUSD (الذهب مقابل الدولار الأمريكي)</span>
              <span className="text-[10px] text-stone-400">التغذية الحية: Biquote MT5 Feed</span>
            </div>

            {/* Timeframes */}
            <div className="p-3.5 bg-stone-950/70 border border-stone-800 rounded-xl space-y-1">
              <span className="text-stone-400 text-[11px] block">Timeframes Analyzed</span>
              <div className="flex items-center gap-1.5 pt-1">
                {['1H (الاتجاه العام)', '15M (هيكل السوق)', '5M (منطقة الدخول)', '1M (التأكيد)'].map((tf) => (
                  <span key={tf} className="px-2 py-0.5 rounded bg-stone-900 border border-stone-700 text-[10px] text-stone-300">
                    {tf}
                  </span>
                ))}
              </div>
            </div>

            {/* Allowed Signal Types */}
            <div className="p-3.5 bg-stone-950/70 border border-stone-800 rounded-xl space-y-1 md:col-span-2">
              <span className="text-stone-400 text-[11px] block">Allowed Signal Types (أنواع الإشارات المسموحة)</span>
              <div className="flex flex-wrap gap-2 pt-1">
                {[
                  { name: 'BUY NOW', desc: 'دخول شراء فوري بسعر السوق' },
                  { name: 'SELL NOW', desc: 'دخول بيع فوري بسعر السوق' },
                  { name: 'BUY LIMIT', desc: 'أمر معلق للشراء عند Discount FVG / OB' },
                  { name: 'SELL LIMIT', desc: 'أمر معلق للبيع عند Premium FVG / OB' },
                  { name: 'NO TRADE', desc: 'حماية رأس المال عند عدم اكتمال الشروط' },
                ].map((s) => (
                  <span
                    key={s.name}
                    className="px-2.5 py-1 rounded-lg bg-stone-900 border border-stone-700 text-stone-200 text-[11px] font-bold"
                  >
                    {s.name} <span className="text-[9px] text-stone-400 font-normal">({s.desc})</span>
                  </span>
                ))}
              </div>
            </div>

            {/* Minimum Confidence Input */}
            <div className="p-3.5 bg-stone-950/70 border border-stone-800 rounded-xl space-y-2 md:col-span-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-stone-200 block">
                  الحد الأدنى لنسبة الثقة (Minimum Confidence Threshold):
                </label>
                <span className="text-sm font-bold text-amber-400">{minimumConfidence}%</span>
              </div>
              <input
                type="range"
                min="50"
                max="95"
                step="5"
                value={minimumConfidence}
                onChange={(e) => setMinimumConfidence(e.target.value)}
                className="w-full accent-amber-500"
              />
              <div className="flex items-center justify-between text-[10px] text-stone-400 pt-1">
                <span>70-74%: ثقة متوسطة</span>
                <span>75-84%: ثقة جيدة (الافتراضي)</span>
                <span>85-94%: صفقة قوية جداً</span>
                <span>95%+: استثنائية ونادرة</span>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end pt-2">
            <button
              type="button"
              disabled={isSaving}
              onClick={handleSave}
              className="px-6 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 font-mono font-black text-xs flex items-center gap-2 transition-all shadow-md disabled:opacity-50 cursor-pointer"
            >
              {isSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              <span>حفظ وتطبيق قواعد التداول (Save Trading Rules)</span>
            </button>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* 4. BROKER SPECIFICATIONS TAB                              */}
      {/* ========================================================= */}
      {activeSubTab === 'BROKER' && (
        <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-6 space-y-4 shadow-xs">
          <div className="flex items-center justify-between border-b border-stone-800 pb-2">
            <div className="flex items-center gap-2">
              <Sliders className="w-5 h-5 text-amber-400" />
              <h4 className="text-sm font-black text-stone-100 font-mono">
                مواصفات عقد الوسيط والذهب (Broker Contract Specifications)
              </h4>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs font-mono">
            {/* Contract Size */}
            <div className="bg-stone-950/70 border border-stone-800 rounded-xl p-3 space-y-1">
              <label className="text-stone-400 text-[11px] block">Contract Size (أونصة لكل عقد)</label>
              <input
                type="number"
                value={contractSizeOz}
                onChange={(e) => setContractSizeOz(e.target.value)}
                className="w-full bg-stone-900 border border-stone-700 rounded-lg px-2.5 py-1.5 text-stone-100 font-bold"
              />
              <span className="text-[10px] text-stone-400">قياسي = 100 أونصة ذهب</span>
            </div>

            {/* Minimum Lot */}
            <div className="bg-stone-950/70 border border-stone-800 rounded-xl p-3 space-y-1">
              <label className="text-stone-400 text-[11px] block">Minimum Lot (أقل لوت)</label>
              <input
                type="number"
                step="0.01"
                value={minimumLot}
                onChange={(e) => setMinimumLot(e.target.value)}
                className="w-full bg-stone-900 border border-stone-700 rounded-lg px-2.5 py-1.5 text-stone-100 font-bold"
              />
              <span className="text-[10px] text-stone-400">0.01 لوت (Micro Lot)</span>
            </div>

            {/* Maximum Lot */}
            <div className="bg-stone-950/70 border border-stone-800 rounded-xl p-3 space-y-1">
              <label className="text-stone-400 text-[11px] block">Maximum Lot (أقصى لوت)</label>
              <input
                type="number"
                value={maximumLot}
                onChange={(e) => setMaximumLot(e.target.value)}
                className="w-full bg-stone-900 border border-stone-700 rounded-lg px-2.5 py-1.5 text-stone-100 font-bold"
              />
              <span className="text-[10px] text-stone-400">سقف حجم العقد المسموح</span>
            </div>

            {/* Lot Step */}
            <div className="bg-stone-950/70 border border-stone-800 rounded-xl p-3 space-y-1">
              <label className="text-stone-400 text-[11px] block">Lot Step (خطوة التدرج)</label>
              <input
                type="number"
                step="0.01"
                value={lotStep}
                onChange={(e) => setLotStep(e.target.value)}
                className="w-full bg-stone-900 border border-stone-700 rounded-lg px-2.5 py-1.5 text-stone-100 font-bold"
              />
              <span className="text-[10px] text-stone-400">عادة 0.01</span>
            </div>

            {/* Max Gold SL Points */}
            <div className="bg-stone-950/70 border border-stone-800 rounded-xl p-3 space-y-1 sm:col-span-2">
              <label className="text-stone-400 text-[11px] block">Max Gold SL Points (سقف وقف الخسارة)</label>
              <input
                type="number"
                value={maxGoldSlPoints}
                onChange={(e) => setMaxGoldSlPoints(e.target.value)}
                className="w-full bg-stone-900 border border-stone-700 rounded-lg px-2.5 py-1.5 text-stone-100 font-bold"
              />
              <span className="text-[10px] text-stone-400">
                100 نقطة ($10.00 مسافة سعرية). أي صفقة تتطلب وقفاً أكبر يتم رفضها تلقائياً.
              </span>
            </div>
          </div>

          <div className="flex items-center justify-end pt-2">
            <button
              type="button"
              disabled={isSaving}
              onClick={handleSave}
              className="px-6 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 font-mono font-black text-xs flex items-center gap-2 transition-all shadow-md disabled:opacity-50 cursor-pointer"
            >
              {isSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              <span>حفظ مواصفات البروكر (Save Broker Specs)</span>
            </button>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* 5. TELEGRAM TAB                                           */}
      {/* ========================================================= */}
      {activeSubTab === 'TELEGRAM' && (
        <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-6 space-y-4 shadow-xs">
          <h4 className="text-sm font-bold text-stone-100 border-b border-stone-800 pb-2">
            Telegram Notifications Status
          </h4>
          <div className="p-4 bg-stone-950 border border-stone-800 rounded-xl text-xs space-y-2">
            <div className="flex items-center gap-2 text-amber-400 font-bold">
              <Lock className="w-4 h-4" />
              <span>إشعار هام: إرسال تنبيهات التلغرام متوقف حالياً (Disabled by Default)</span>
            </div>
            <p className="text-stone-400 text-[11px]">
              بناءً على تعليمات المستخدم، يتم فحص السوق وتخزين الإشارات في الـ Database والخادم دون إرسال رسائل تلغرام حتى يتم تفعيلها صراحة.
            </p>
          </div>
          {onTestTelegram && (
            <div className="pt-2 flex items-center gap-3">
              <button
                onClick={handleTestTg}
                disabled={isTestingTg}
                className="px-4 py-2 bg-stone-800 hover:bg-stone-700 text-stone-200 rounded-xl text-xs font-bold flex items-center gap-2 cursor-pointer disabled:opacity-50"
              >
                <Send className="w-4 h-4" />
                <span>{isTestingTg ? 'جارٍ الفحص...' : 'فحص الاتصال (Test Telegram Connection)'}</span>
              </button>
              {telegramStatus && <span className="text-xs text-stone-300 font-mono">{telegramStatus}</span>}
            </div>
          )}
        </div>
      )}

      {/* ========================================================= */}
      {/* 6. DATA & RESET TAB                                       */}
      {/* ========================================================= */}
      {activeSubTab === 'DATA' && (
        <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-6 space-y-4 shadow-xs">
          <h4 className="text-sm font-bold text-stone-100 border-b border-stone-800 pb-2">
            Data Export & Reset
          </h4>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleExportData}
              className="px-4 py-2 bg-stone-800 hover:bg-stone-700 text-stone-200 rounded-xl text-xs font-bold flex items-center gap-2 border border-stone-700 cursor-pointer"
            >
              <Download className="w-4 h-4 text-amber-400" />
              <span>تصدير سجل الصفقات (Export Trades JSON)</span>
            </button>
            {onResetDemoBalance && (
              <button
                onClick={() => onResetDemoBalance(effectiveCapital)}
                className="px-4 py-2 bg-rose-950/60 hover:bg-rose-900/60 text-rose-300 rounded-xl text-xs font-bold flex items-center gap-2 border border-rose-800/80 cursor-pointer"
              >
                <RotateCcw className="w-4 h-4 text-rose-400" />
                <span>إعادة تعيين رصيد الحساب التجريبي إلى ${effectiveCapital}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* REAL ACCOUNT ACTIVATION CONFIRMATION MODAL */}
      {showRealModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs animate-fade-in">
          <div className="bg-stone-900 border border-rose-600/80 rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center gap-3 border-b border-stone-800 pb-3">
              <div className="w-10 h-10 rounded-xl bg-rose-950 border border-rose-700 text-rose-400 flex items-center justify-center">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-black text-rose-200 font-mono">
                  تحذير تفعيل وضع الحساب الحقيقي (REAL MODE)
                </h3>
                <span className="text-xs text-rose-400 font-mono">تنبيه المخاطرة وأموال حقيقية</span>
              </div>
            </div>

            <div className="space-y-3 text-xs text-stone-300 leading-relaxed font-sans">
              <p className="p-3 bg-rose-950/40 border border-rose-900/80 rounded-xl text-rose-200 font-mono">
                أنت على وشك تفعيل وضع التنفيذ الحقيقي (REAL ACCOUNT). عند تفعيل هذا الوضع:
              </p>
              <ul className="space-y-2 list-disc list-inside text-stone-300 pr-2">
                <li>سيتم إرسال الصفقات المؤكدة مباشرة إلى وسيطك عبر MT5 Execution Bridge بأموال حقيقية.</li>
                <li>تظل قواعد إدارة المخاطر الصارمة فعّالة (أقصى مخاطرة 15% للصفقة، 30% يومياً، 3 صفقات كحد أقصى).</li>
                <li>يتم حظر أي أمر يتجاوز وقف الخسارة 100 نقطة ذهب أو يخالف قواعد حماية الـ Lot.</li>
                <li>في حال انقطاع اتصال الـ MT5 Bridge يتم رفض التنفيذ تلقائياً لحماية رصيدك.</li>
              </ul>

              <label className="flex items-start gap-2.5 p-3 bg-stone-950 rounded-xl border border-stone-800 cursor-pointer select-none mt-2">
                <input
                  type="checkbox"
                  checked={realAckChecked}
                  onChange={(e) => setRealAckChecked(e.target.checked)}
                  className="mt-0.5 rounded border-stone-700 accent-rose-500 w-4 h-4 cursor-pointer"
                />
                <span className="text-xs text-stone-200 font-bold">
                  أقر بأنني على دراية تامة بمخاطر التداول المالي الحقيقي وأوافق على تفعيل وضع REAL على منصة MT5.
                </span>
              </label>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-stone-800">
              <button
                type="button"
                onClick={() => {
                  setShowRealModal(false);
                  setRealAckChecked(false);
                }}
                className="px-4 py-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-300 font-mono text-xs font-bold cursor-pointer"
              >
                إلغاء والعودة لـ DEMO
              </button>
              <button
                type="button"
                disabled={!realAckChecked}
                onClick={() => {
                  setAccountMode('REAL');
                  setShowRealModal(false);
                  setRealAckChecked(false);
                }}
                className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-mono text-xs font-black flex items-center gap-2 cursor-pointer shadow-lg shadow-rose-950"
              >
                <Flame className="w-4 h-4" />
                <span>تأكيد تفعيل REAL MODE</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
