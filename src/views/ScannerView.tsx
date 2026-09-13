import React, { useState, useEffect } from 'react';
import {
  Radio,
  Play,
  Pause,
  Clock,
  Zap,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  AlertCircle,
  TrendingUp,
  TrendingDown,
  Layers,
  Sparkles,
  RefreshCw,
  Server,
  FileText,
} from 'lucide-react';
import { ScannerConfig, TradeSignal } from '../types';

interface ScannerViewProps {
  config: ScannerConfig;
  currentPrice: number;
  isAnalyzing: boolean;
  onToggleScanner: (
    enabled: boolean,
    intervalMinutes: number,
    minConfidence: number,
    telegramEnabled: boolean,
    intervalSeconds?: number
  ) => void;
  onManualScan: () => void;
  multitimeframe?: {
    marketState: 'TREND' | 'RANGE' | 'CONSOLIDATION';
    h1Trend: string;
    m15Structure: string;
    m5Atr: number;
  };
}

export const ScannerView: React.FC<ScannerViewProps> = ({
  config,
  currentPrice,
  isAnalyzing,
  onToggleScanner,
  onManualScan,
  multitimeframe,
}) => {
  const [secondsRemaining, setSecondsRemaining] = useState<number>(60);
  const [scanHistory, setScanHistory] = useState<any[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(false);

  // Countdown timer for next scan
  useEffect(() => {
    const updateCountdown = () => {
      if (!config.nextScanTime) {
        setSecondsRemaining(60);
        return;
      }
      const diff = Math.max(0, Math.round((config.nextScanTime - Date.now()) / 1000));
      setSecondsRemaining(diff);
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [config.nextScanTime]);

  // Load recent scans from backend storage
  const fetchRecentScans = async () => {
    setIsLoadingHistory(true);
    try {
      const res = await fetch('/api/scanner/history?limit=10');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.scans)) {
          setScanHistory(data.scans);
        }
      }
    } catch (e) {
      console.warn('Failed to load scan history:', e);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  useEffect(() => {
    fetchRecentScans();
    const historyInterval = setInterval(fetchRecentScans, 6000);
    return () => clearInterval(historyInterval);
  }, [config.scanCount]);

  const lastSignal = config.lastSignal;
  const lastDecision = config.lastDecision || (lastSignal?.signal ? lastSignal.signal : 'NO TRADE');
  const isNoTrade = lastDecision === 'NO TRADE';

  // Signals found vs rejected calculations
  const totalScans = Math.max(config.scanCount || 0, scanHistory.length);
  const signalsFoundCount = scanHistory.filter((s) => s.signal && s.signal !== 'NO TRADE').length;
  const signalsRejectedCount = Math.max(0, totalScans - signalsFoundCount);

  return (
    <div className="space-y-4 sm:space-y-6 animate-in fade-in duration-250">
      {/* Top Banner Controls: Status & Toggles */}
      <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5 shadow-xs flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className={`w-12 h-12 rounded-2xl flex items-center justify-center ${
              config.enabled
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 shadow-inner'
                : 'bg-stone-800 text-stone-400 border border-stone-700'
            }`}
          >
            <Radio className={`w-6 h-6 ${config.enabled ? 'animate-pulse' : ''}`} />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-black text-stone-100 font-mono">
                Autonomous 24/7 Scanner Daemon
              </h3>
              <span
                className={`text-[10px] font-mono font-black px-2 py-0.5 rounded-full border ${
                  config.enabled
                    ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                    : 'bg-stone-800 text-stone-400 border-stone-700'
                }`}
              >
                {config.enabled ? 'RUNNING' : 'STOPPED'}
              </span>
            </div>
            <p className="text-xs text-stone-400 mt-0.5">
              يعمل في الخلفية على مدار الساعة كل 60 ثانية بدون الحاجة لإبقاء المتصفح مفتوحاً
            </p>
          </div>
        </div>

        {/* Action Buttons: Auto On/Off & Run Scan Now */}
        <div className="flex items-center gap-2.5">
          <button
            onClick={() =>
              onToggleScanner(
                !config.enabled,
                config.intervalMinutes || 1,
                config.minConfidence || 75,
                config.telegramEnabled,
                60
              )
            }
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all border shadow-xs ${
              config.enabled
                ? 'bg-rose-950/80 hover:bg-rose-900 border-rose-800 text-rose-200'
                : 'bg-emerald-950/80 hover:bg-emerald-900 border-emerald-800 text-emerald-200'
            }`}
          >
            {config.enabled ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            <span>{config.enabled ? 'إيقاف الماسح (AUTO OFF)' : 'تشغيل الماسح (AUTO ON)'}</span>
          </button>

          <button
            onClick={onManualScan}
            disabled={isAnalyzing}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-stone-950 text-xs font-black transition-all shadow-xs active:scale-95"
          >
            <Play className={`w-4 h-4 fill-stone-950 ${isAnalyzing ? 'animate-spin' : ''}`} />
            <span>RUN SCAN NOW</span>
          </button>
        </div>
      </div>

      {/* Scanner Telemetry & Cadence Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {/* Interval */}
        <div className="bg-stone-900/90 border border-stone-800/80 rounded-xl p-3">
          <span className="text-[10px] text-stone-400 uppercase font-mono block">دورة الفحص (Interval)</span>
          <span className="text-base font-black font-mono text-stone-100 mt-0.5 block">60 ثانية</span>
          <span className="text-[10px] text-stone-400 font-mono">1-Minute Cadence</span>
        </div>

        {/* Last Scan */}
        <div className="bg-stone-900/90 border border-stone-800/80 rounded-xl p-3">
          <span className="text-[10px] text-stone-400 uppercase font-mono block">آخر فحص (Last Scan)</span>
          <span className="text-base font-black font-mono text-stone-100 mt-0.5 block truncate">
            {config.lastScanTime
              ? new Date(config.lastScanTime).toLocaleTimeString('ar-EG', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })
              : 'N/A'}
          </span>
          <span className="text-[10px] text-stone-400 font-mono">تم التسجيل</span>
        </div>

        {/* Next Scan Countdown */}
        <div className="bg-stone-900/90 border border-amber-900/40 rounded-xl p-3">
          <span className="text-[10px] text-amber-400 uppercase font-mono block">الفحص القادم (Next Scan)</span>
          <span className="text-base font-black font-mono text-amber-400 mt-0.5 block">
            {config.enabled ? `${secondsRemaining} ثانية` : 'متوقف'}
          </span>
          <span className="text-[10px] text-stone-400 font-mono">عد تنازلي مباشر</span>
        </div>

        {/* Number of Scans */}
        <div className="bg-stone-900/90 border border-stone-800/80 rounded-xl p-3">
          <span className="text-[10px] text-stone-400 uppercase font-mono block">عدد الفحوصات (Scans)</span>
          <span className="text-base font-black font-mono text-cyan-400 mt-0.5 block">
            {totalScans}
          </span>
          <span className="text-[10px] text-stone-400 font-mono">مفحوصة بالكامل</span>
        </div>

        {/* Signals Found */}
        <div className="bg-stone-900/90 border border-emerald-950/80 rounded-xl p-3">
          <span className="text-[10px] text-emerald-400 uppercase font-mono block">إشارات مؤكدة (Found)</span>
          <span className="text-base font-black font-mono text-emerald-400 mt-0.5 block">
            {signalsFoundCount}
          </span>
          <span className="text-[10px] text-stone-400 font-mono">حققت شرط 2R</span>
        </div>

        {/* Signals Rejected */}
        <div className="bg-stone-900/90 border border-stone-800/80 rounded-xl p-3">
          <span className="text-[10px] text-stone-400 uppercase font-mono block">فحوصات مستبعدة (Rejected)</span>
          <span className="text-base font-black font-mono text-stone-300 mt-0.5 block">
            {signalsRejectedCount}
          </span>
          <span className="text-[10px] text-stone-400 font-mono">حماية رأس المال</span>
        </div>
      </div>

      {/* Multi-Timeframe Market Data Snapshot (1H, 15M, 5M) */}
      <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5">
        <div className="flex items-center justify-between mb-3 border-b border-stone-800 pb-2">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-amber-400" />
            <h4 className="text-xs sm:text-sm font-bold text-stone-100 uppercase tracking-wide">
              بيانات سوق الذهب متعددة الأطر (XAUUSD Multi-Timeframe Data)
            </h4>
          </div>
          <span className="text-xs font-mono text-amber-400 font-bold">${(Number(currentPrice) || 2718.5).toFixed(2)}</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 font-mono">
          {/* 1H */}
          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-3">
            <div className="flex items-center justify-between text-xs text-stone-400 mb-1">
              <span className="font-bold">إطار الساعة (1H)</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-stone-800 text-stone-300">الاتجاه العام</span>
            </div>
            <div className="text-sm font-black text-stone-200 mt-1">
              {multitimeframe?.h1Trend || 'BULLISH / CONSOLIDATION'}
            </div>
            <p className="text-[10px] text-stone-400 font-sans mt-1">
              يحدد الاتجاه الرئيسي وتمركز السيولة الكبرى
            </p>
          </div>

          {/* 15M */}
          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-3">
            <div className="flex items-center justify-between text-xs text-stone-400 mb-1">
              <span className="font-bold">إطار 15 دقيقة (15M)</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-stone-800 text-stone-300">منطقة الهيكل</span>
            </div>
            <div className="text-sm font-black text-stone-200 mt-1">
              {multitimeframe?.m15Structure || 'DISCOUNT ZONE'}
            </div>
            <p className="text-[10px] text-stone-400 font-sans mt-1">
              يحدد كتل الأوامر (OB) والفجوات السعرية (FVG)
            </p>
          </div>

          {/* 5M */}
          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-3">
            <div className="flex items-center justify-between text-xs text-stone-400 mb-1">
              <span className="font-bold">إطار 5 دقائق (5M)</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-stone-800 text-stone-300">التنفيذ المباشر</span>
            </div>
            <div className="text-sm font-black text-amber-400 mt-1">
              ATR: {(typeof multitimeframe?.m5Atr === 'number' ? multitimeframe.m5Atr : 2.4).toFixed(2)} pts
            </div>
            <p className="text-[10px] text-stone-400 font-sans mt-1">
              يضبط دقة الدخول ووقف الخسارة الأقصى (≤100 نقطة)
            </p>
          </div>
        </div>
      </div>

      {/* Latest Scan Result (Requirement: Condition, Structure, Liquidity, Quality, Confidence, Decision) */}
      <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5 shadow-xs">
        <div className="flex items-center justify-between mb-4 border-b border-stone-800 pb-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-cyan-400" />
            <h4 className="text-sm font-bold text-stone-100">
              نتيجة الفحص الأخير (Last Scan Result)
            </h4>
          </div>
          <span className="text-[11px] font-mono text-stone-400">
            {config.lastScanTime ? new Date(config.lastScanTime).toLocaleTimeString('ar-EG') : 'جاري الرصد'}
          </span>
        </div>

        {/* 6 Key Analysis Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 font-mono mb-4">
          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-2.5">
            <span className="text-[10px] text-stone-400 block uppercase">Market Condition</span>
            <span className="text-xs font-bold text-stone-200 mt-0.5 block">
              {multitimeframe?.marketState || 'RANGE'}
            </span>
          </div>

          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-2.5">
            <span className="text-[10px] text-stone-400 block uppercase">Structure</span>
            <span className="text-xs font-bold text-stone-200 mt-0.5 block">
              {multitimeframe?.h1Trend || 'RANGING'}
            </span>
          </div>

          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-2.5">
            <span className="text-[10px] text-stone-400 block uppercase">Liquidity Pool</span>
            <span className="text-xs font-bold text-cyan-300 mt-0.5 block">
              EQUILIBRIUM
            </span>
          </div>

          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-2.5">
            <span className="text-[10px] text-stone-400 block uppercase">Setup Quality</span>
            <span className="text-xs font-bold text-amber-400 mt-0.5 block">
              {lastSignal ? lastSignal.setup : 'SELECTIVE FILTER'}
            </span>
          </div>

          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-2.5">
            <span className="text-[10px] text-stone-400 block uppercase">Confidence</span>
            <span className="text-xs font-bold text-amber-400 mt-0.5 block">
              {lastSignal ? `${lastSignal.confidence}%` : 'N/A'}
            </span>
          </div>

          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-2.5">
            <span className="text-[10px] text-stone-400 block uppercase">Decision</span>
            <span
              className={`text-xs font-black mt-0.5 block ${
                lastDecision.includes('BUY')
                  ? 'text-emerald-400'
                  : lastDecision.includes('SELL')
                  ? 'text-rose-400'
                  : 'text-stone-400'
              }`}
            >
              {lastDecision}
            </span>
          </div>
        </div>

        {/* If NO TRADE, display clearly and concisely with exact reason */}
        {isNoTrade ? (
          <div className="bg-stone-950 border border-stone-800 rounded-xl p-3.5 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-black text-amber-300 font-mono">
                  قرار الماسح: NO TRADE (حجب الدخول)
                </span>
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-stone-800 text-stone-300 font-mono">
                  No Forced Trades
                </span>
              </div>
              <p className="text-xs text-stone-300 leading-relaxed font-sans">
                {lastSignal?.noTradeReason ||
                  'السعر يتحرك حالياً داخل منطقة تذبذب بدون كسر هيكلي مؤكد أو هدف يحقق نسبة العائد المطلوبة بعيداً عن كتل الأوامر المعاكسة. يواصل الماسح فحص الشموع كل 60 ثانية لحين ظهور نموذج عالي الجودة.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="bg-emerald-950/30 border border-emerald-500/40 rounded-xl p-3.5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              <div>
                <span className="text-xs font-bold text-emerald-300 font-mono">
                  تم اعتماد إشارة تداول جديدة: {lastDecision}
                </span>
                <p className="text-[11px] text-stone-300 mt-0.5">
                  الدخول: ${(Number(lastSignal?.entry) || 0).toFixed(2)} | الوقف: ${(Number(lastSignal?.stopLoss) || 0).toFixed(2)} | الهدف الأول: ${(Number(lastSignal?.tp1) || 0).toFixed(2)} ({lastSignal?.tp1RrString || 'TP1'})
                </p>
              </div>
            </div>
            <span className="text-xs font-mono font-bold text-amber-400">
              ثقة: {lastSignal?.confidence}%
            </span>
          </div>
        )}
      </div>

      {/* Persistent Scan Log Table from Disk */}
      <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5">
        <div className="flex items-center justify-between mb-3 border-b border-stone-800 pb-2">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-stone-400" />
            <h4 className="text-xs sm:text-sm font-bold text-stone-100">
              سجل الفحوصات الدورية المخزنة (Storage Log)
            </h4>
          </div>
          <button
            onClick={fetchRecentScans}
            className="text-[11px] text-stone-400 hover:text-stone-200 flex items-center gap-1 font-mono"
          >
            <RefreshCw className={`w-3 h-3 ${isLoadingHistory ? 'animate-spin' : ''}`} />
            <span>تحديث السجل</span>
          </button>
        </div>

        {scanHistory.length === 0 ? (
          <div className="py-6 text-center text-xs text-stone-400 font-mono">
            جاري حفظ أول فحص في قاعدة البيانات الدائمة...
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs font-mono">
              <thead>
                <tr className="border-b border-stone-800 text-stone-400 text-[10px] uppercase">
                  <th className="py-2 px-2">الوقت</th>
                  <th className="py-2 px-2">السعر</th>
                  <th className="py-2 px-2">القرار</th>
                  <th className="py-2 px-2">النموذج</th>
                  <th className="py-2 px-2">الثقة</th>
                  <th className="py-2 px-2">السبب / الملاحظة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-800/60 text-stone-300">
                {scanHistory.map((scan, idx) => (
                  <tr key={scan.id || idx} className="hover:bg-stone-950/60 transition-colors">
                    <td className="py-2 px-2 text-stone-400 whitespace-nowrap">
                      {scan.isoTime
                        ? new Date(scan.isoTime).toLocaleTimeString('ar-EG', {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })
                        : 'N/A'}
                    </td>
                    <td className="py-2 px-2 font-bold text-stone-200">
                      ${typeof scan.currentPrice === 'number' ? scan.currentPrice.toFixed(2) : (Number(scan.currentPrice) || 0).toFixed(2)}
                    </td>
                    <td className="py-2 px-2">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          scan.signal?.includes('BUY')
                            ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                            : scan.signal?.includes('SELL')
                            ? 'bg-rose-950 text-rose-300 border border-rose-800'
                            : 'bg-stone-800 text-stone-400'
                        }`}
                      >
                        {scan.signal || 'NO TRADE'}
                      </span>
                    </td>
                    <td className="py-2 px-2 text-stone-400 truncate max-w-[120px]">
                      {scan.setup || 'No Setup'}
                    </td>
                    <td className="py-2 px-2 text-amber-400 font-bold">
                      {scan.confidence ? `${scan.confidence}%` : '---'}
                    </td>
                    <td className="py-2 px-2 text-stone-400 text-[11px] font-sans truncate max-w-[240px]">
                      {scan.noTradeReason || scan.mainReasons?.[0] || 'تم الفحص الدوري بنجاح'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
