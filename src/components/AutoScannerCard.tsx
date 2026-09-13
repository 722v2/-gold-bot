import { useState, useEffect } from 'react';
import {
  Radio,
  CheckCircle2,
  AlertCircle,
  Clock,
  ShieldCheck,
  RotateCw,
  Zap,
  Activity,
  ShieldAlert,
  Server,
  Database,
  ArrowRightLeft,
  ExternalLink,
  History,
} from 'lucide-react';
import { ScannerConfig, SignalDecision } from '../types';
import { ScanHistoryModal } from './ScanHistoryModal';
import { WorkerInfoModal } from './WorkerInfoModal';

interface AutoScannerCardProps {
  config: ScannerConfig;
  onToggleScanner: (
    enabled: boolean,
    intervalMinutes: number,
    minConfidence: number,
    tgEnabled: boolean,
    intervalSeconds?: number
  ) => void;
  onManualScan?: () => Promise<void>;
}

export const AutoScannerCard = ({
  config,
  onToggleScanner,
  onManualScan,
}: AutoScannerCardProps) => {
  const [intervalSec, setIntervalSec] = useState<number>(config.intervalSeconds || 60);
  const [minConf, setMinConf] = useState<number>(config.minConfidence || 75);
  const [secondsToNext, setSecondsToNext] = useState<number | null>(null);
  const [isScanningManual, setIsScanningManual] = useState<boolean>(false);
  const [historyOpen, setHistoryOpen] = useState<boolean>(false);
  const [workerInfoOpen, setWorkerInfoOpen] = useState<boolean>(false);

  // Live countdown ticker to "Next Scan"
  useEffect(() => {
    const updateCountdown = () => {
      if (!config.enabled || !config.nextScanTime) {
        setSecondsToNext(null);
        return;
      }
      const diffMs = config.nextScanTime - Date.now();
      const diffSec = Math.max(0, Math.ceil(diffMs / 1000));
      setSecondsToNext(diffSec);
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [config.enabled, config.nextScanTime]);

  const handleToggle = (checked: boolean) => {
    onToggleScanner(checked, intervalSec / 60, minConf, false, intervalSec);
  };

  const handleIntervalChange = (newSec: number) => {
    setIntervalSec(newSec);
    if (config.enabled) {
      onToggleScanner(true, newSec / 60, minConf, false, newSec);
    }
  };

  const handleConfidenceChange = (newConf: number) => {
    setMinConf(newConf);
    if (config.enabled) {
      onToggleScanner(true, intervalSec / 60, newConf, false, intervalSec);
    }
  };

  const handleTriggerNow = async () => {
    if (!onManualScan || isScanningManual) return;
    setIsScanningManual(true);
    try {
      await onManualScan();
    } finally {
      setIsScanningManual(false);
    }
  };

  // Decision styling
  const getDecisionBadge = (decision?: SignalDecision | null) => {
    if (!decision) return null;
    switch (decision) {
      case 'BUY NOW':
        return (
          <span className="px-2.5 py-1 rounded-md text-xs font-black bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 font-mono tracking-wider">
            BUY NOW
          </span>
        );
      case 'SELL NOW':
        return (
          <span className="px-2.5 py-1 rounded-md text-xs font-black bg-rose-500/20 text-rose-400 border border-rose-500/40 font-mono tracking-wider">
            SELL NOW
          </span>
        );
      case 'BUY LIMIT':
        return (
          <span className="px-2.5 py-1 rounded-md text-xs font-black bg-cyan-500/20 text-cyan-400 border border-cyan-500/40 font-mono tracking-wider">
            BUY LIMIT
          </span>
        );
      case 'SELL LIMIT':
        return (
          <span className="px-2.5 py-1 rounded-md text-xs font-black bg-amber-500/20 text-amber-400 border border-amber-500/40 font-mono tracking-wider">
            SELL LIMIT
          </span>
        );
      case 'NO TRADE':
      default:
        return (
          <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-stone-800 text-stone-300 border border-stone-700 font-mono tracking-wider">
            NO TRADE
          </span>
        );
    }
  };

  return (
    <>
      <section className="bg-stone-900/90 border border-stone-800 rounded-2xl p-4 sm:p-5 shadow-sm space-y-3.5">
        {/* Header & Master Control */}
        <div className="flex items-center justify-between gap-3 pb-3 border-b border-stone-800">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
              <Radio
                className={`w-4 h-4 ${
                  config.enabled ? 'animate-pulse text-amber-400' : 'text-stone-500'
                }`}
              />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm sm:text-base font-bold text-stone-100">
                  LIVE MARKET SCANNER
                </h3>
                {/* ONLINE / OFFLINE Status Badge (Requirement 10) */}
                {config.enabled ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-mono shadow-xs">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                    ONLINE
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-stone-800 text-stone-400 border border-stone-700 font-mono">
                    <span className="w-2 h-2 rounded-full bg-stone-500 shrink-0" />
                    OFFLINE
                  </span>
                )}
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 font-mono hidden sm:inline">
                  Biquote XAUUSD
                </span>
              </div>
              <p className="text-[11px] text-stone-400">
                خادم مسح مستقل يعمل في الخلفية كل 60 ثانية لبيانات Biquote دون الاعتماد على المتصفح
              </p>
            </div>
          </div>

          {/* Master Switch & Quick Actions */}
          <div className="flex items-center gap-2.5">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => handleToggle(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-stone-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-stone-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-500"></div>
            </label>
          </div>
        </div>

        {/* Required Telemetry Section: ONLINE/OFFLINE, LAST SCAN, NEXT SCAN, DATA STATUS (Requirement 10) */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {/* 1. SCANNER STATUS */}
          <div className="bg-stone-950/70 border border-stone-800/80 rounded-xl p-3">
            <div className="text-[10px] text-stone-400 flex items-center gap-1.5 mb-1 font-semibold uppercase tracking-wider">
              <Server className="w-3 h-3 text-stone-400" />
              <span>Status:</span>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                  config.enabled ? 'bg-emerald-400 animate-pulse' : 'bg-stone-600'
                }`}
              />
              <span
                className={`text-xs font-mono font-bold ${
                  config.enabled ? 'text-emerald-400' : 'text-stone-400'
                }`}
              >
                {config.enabled ? 'ONLINE' : 'OFFLINE'}
              </span>
            </div>
            <span className="text-[10px] text-stone-500 mt-1 block">
              {config.enabled ? 'خادم خلفي مستقل' : 'متوقف مؤقتاً'}
            </span>
          </div>

          {/* 2. LAST SCAN */}
          <div className="bg-stone-950/70 border border-stone-800/80 rounded-xl p-3">
            <div className="text-[10px] text-stone-400 flex items-center gap-1.5 mb-1 font-semibold uppercase tracking-wider">
              <Clock className="w-3 h-3 text-stone-400" />
              <span>Last Scan:</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-bold text-stone-200">
                {config.lastScanTime
                  ? new Date(config.lastScanTime).toLocaleTimeString()
                  : 'لم يتم الفحص بعد'}
              </span>
              {config.isScanning && (
                <span className="text-[10px] px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 animate-pulse">
                  فحص...
                </span>
              )}
            </div>
            <span className="text-[10px] text-stone-500 mt-1 block">
              فحوصات: {config.scanCount || 0}
            </span>
          </div>

          {/* 3. NEXT SCAN */}
          <div className="bg-stone-950/70 border border-stone-800/80 rounded-xl p-3">
            <div className="text-[10px] text-stone-400 flex items-center gap-1.5 mb-1 font-semibold uppercase tracking-wider">
              <RotateCw
                className={`w-3 h-3 text-amber-400 ${
                  config.enabled ? 'animate-spin' : ''
                }`}
                style={{ animationDuration: '3s' }}
              />
              <span>Next Scan:</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-bold text-amber-400">
                {config.enabled
                  ? secondsToNext !== null
                    ? `خلال ${secondsToNext} ثانية`
                    : 'مجدول...'
                  : 'متوقف'}
              </span>
            </div>
            <span className="text-[10px] text-stone-500 mt-1 block font-mono">
              الدورة: {intervalSec} ثانية
            </span>
          </div>

          {/* 4. DATA STATUS */}
          <div className="bg-stone-950/70 border border-stone-800/80 rounded-xl p-3">
            <div className="text-[10px] text-stone-400 flex items-center gap-1.5 mb-1 font-semibold uppercase tracking-wider">
              <Database className="w-3 h-3 text-emerald-400" />
              <span>Data Status:</span>
            </div>
            <div className="flex items-center gap-1.5 truncate">
              <span className="text-xs font-mono font-medium text-emerald-300 truncate">
                {config.dataStatus?.includes('Connected') ? 'Biquote MT5 (Live)' : config.dataStatus || 'Biquote Feed'}
              </span>
            </div>
            <span className="text-[10px] text-stone-500 mt-1 block truncate">
              حقيقي (Zero Mock Data)
            </span>
          </div>
        </div>

        {/* Scanner Status Message & Decision Banner */}
        <div className="bg-stone-950/90 border border-stone-800/90 rounded-xl p-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-xs font-semibold text-stone-200">
                {config.lastScanStatus}
              </span>
            </div>
            {config.duplicatePrevented && (
              <div className="text-[11px] text-amber-300/90 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>
                  <strong>منع التكرار نشط:</strong> الـSetup الحالي لا يزال سارياً ضمن نطاق الدخول والأهداف؛ لم يتم إنشاء إشارة مكررة.
                </span>
              </div>
            )}
          </div>

          {/* Latest Decision & Actions */}
          <div className="flex items-center gap-2 self-end sm:self-center flex-wrap">
            {getDecisionBadge(config.lastDecision)}
            {onManualScan && (
              <button
                onClick={handleTriggerNow}
                disabled={isScanningManual || config.isScanning}
                className="px-3 py-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-semibold border border-stone-700 flex items-center gap-1.5 transition-colors disabled:opacity-50"
              >
                <RotateCw
                  className={`w-3.5 h-3.5 ${
                    isScanningManual || config.isScanning ? 'animate-spin text-amber-400' : ''
                  }`}
                />
                <span>{isScanningManual || config.isScanning ? 'جارٍ الفحص...' : 'فحص فوري'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Bottom bar: Scan History & 24/7 Architecture buttons */}
        <div className="flex items-center justify-between gap-2 pt-1 border-t border-stone-800/70 text-xs">
          <button
            onClick={() => setWorkerInfoOpen(true)}
            className="flex items-center gap-1.5 text-amber-400 hover:text-amber-300 transition-colors py-1 px-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] font-semibold"
          >
            <Server className="w-3.5 h-3.5" />
            <span>معمارية الخادم 24/7 ورابط الـ Webhook</span>
          </button>

          <button
            onClick={() => setHistoryOpen(true)}
            className="flex items-center gap-1.5 text-stone-300 hover:text-stone-100 transition-colors py-1 px-2 rounded-lg bg-stone-800 hover:bg-stone-700 text-[11px] font-semibold border border-stone-700"
          >
            <History className="w-3.5 h-3.5 text-stone-400" />
            <span>سجل الفحوصات في التخزين الدائم</span>
          </button>
        </div>
      </section>

      {/* Modals */}
      <WorkerInfoModal isOpen={workerInfoOpen} onClose={() => setWorkerInfoOpen(false)} />
      <ScanHistoryModal isOpen={historyOpen} onClose={() => setHistoryOpen(false)} />
    </>
  );
};

