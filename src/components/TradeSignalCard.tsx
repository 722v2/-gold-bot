import { useState, useEffect } from 'react';
import {
  CheckCircle2,
  Copy,
  Flame,
  ShieldAlert,
  Sparkles,
  AlertTriangle,
  PlusCircle,
  Check,
  Calculator,
  Layers,
  Scale,
  DollarSign,
  Info,
  Clock,
  Database,
  Radio,
} from 'lucide-react';
import { ScannerConfig, TradeSignal } from '../types';

interface TradeSignalCardProps {
  signal: TradeSignal | null;
  onExecuteTrade?: (signal: TradeSignal) => void;
  isLogged?: boolean;
  scannerConfig?: ScannerConfig;
}

export const TradeSignalCard = ({
  signal,
  onExecuteTrade,
  isLogged = false,
  scannerConfig,
}: TradeSignalCardProps) => {
  const [copied, setCopied] = useState(false);
  const [secondsToNext, setSecondsToNext] = useState<number | null>(null);

  // Live countdown to Next Scan
  useEffect(() => {
    const updateCountdown = () => {
      if (!scannerConfig?.enabled || !scannerConfig?.nextScanTime) {
        setSecondsToNext(null);
        return;
      }
      const diffMs = scannerConfig.nextScanTime - Date.now();
      const diffSec = Math.max(0, Math.ceil(diffMs / 1000));
      setSecondsToNext(diffSec);
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [scannerConfig?.enabled, scannerConfig?.nextScanTime]);

  // Telemetry Bar with "Last Scan", "Next Scan", "Data Status"
  const renderTelemetryBar = () => (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 bg-stone-950/80 border border-stone-800/80 rounded-xl p-2.5 text-xs font-mono mb-3.5">
      <div>
        <span className="text-[10px] text-stone-400 block font-sans font-semibold uppercase tracking-wider flex items-center gap-1">
          <Database className="w-3 h-3 text-emerald-400" />
          <span>Data Status:</span>
        </span>
        <span className="text-emerald-400 font-semibold flex items-center gap-1.5 truncate">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          {scannerConfig?.dataStatus || 'Biquote XAUUSD MT5 Live Feed'}
        </span>
      </div>

      <div>
        <span className="text-[10px] text-stone-400 block font-sans font-semibold uppercase tracking-wider flex items-center gap-1">
          <Clock className="w-3 h-3 text-stone-400" />
          <span>Last Scan:</span>
        </span>
        <span className="text-stone-200 font-bold">
          {scannerConfig?.lastScanTime
            ? new Date(scannerConfig.lastScanTime).toLocaleTimeString()
            : 'Connecting...'}
        </span>
      </div>

      <div>
        <span className="text-[10px] text-stone-400 block font-sans font-semibold uppercase tracking-wider flex items-center gap-1">
          <Radio className="w-3 h-3 text-amber-400" />
          <span>Next Scan:</span>
        </span>
        <span className="text-amber-400 font-bold">
          {scannerConfig?.enabled
            ? secondsToNext !== null
              ? `In ${secondsToNext}s (${new Date(scannerConfig.nextScanTime || 0).toLocaleTimeString()})`
              : 'Scheduled (60s cycle)'
            : 'Paused'}
        </span>
      </div>
    </div>
  );

  if (!signal) {
    return (
      <section className="bg-stone-900/90 border border-stone-800 rounded-2xl p-4 sm:p-5 text-stone-400 shadow-sm">
        {renderTelemetryBar()}
        <div className="border border-dashed border-stone-800/80 rounded-xl p-6 text-center">
          <Sparkles className="w-8 h-8 mx-auto mb-2 text-amber-400/60 animate-pulse" />
          <p className="text-sm font-semibold text-stone-200">الماسح المباشر قيد التشغيل التلقائي</p>
          <p className="text-xs text-stone-400 mt-1 max-w-md mx-auto">
            يتم فحص شارت الذهب XAU/USD مباشرة عبر Biquote كل 60 ثانية. ستظهر أي فرصة مؤكدة هنا فور اكتمال شروطها، أو اضغط [ فحص فوري ] للتحليل الفوري.
          </p>
        </div>
      </section>
    );
  }

  // Format text for one-click copy
  const copySignalText = () => {
    if (signal.signal === 'NO TRADE') {
      navigator.clipboard.writeText(`⚪ NO TRADE\nAsset: ${signal.asset}\nReason: ${signal.noTradeReason}`);
    } else {
      const ps = signal.positionSizing;
      const text = `🔥 TRADE SIGNAL
Asset: ${signal.asset}
Direction: ${signal.signal}
Entry: $${(Number(signal.entry) || 0).toFixed(2)}
SL: $${(Number(signal.stopLoss) || 0).toFixed(2)}
SL Points: ${signal.slPoints} points
TP1: $${(Number(signal.tp1) || 0).toFixed(2)} (${signal.tp1Points ?? Math.round(Math.abs((Number(signal.tp1) || 0) - (Number(signal.entry) || 0)) / 0.1)} points)
TP1 RR: ${signal.tp1RrString || '1:1.50'}
TP2: $${(Number(signal.tp2) || 0).toFixed(2)} (${signal.tp2Points ?? Math.round(Math.abs((Number(signal.tp2) || 0) - (Number(signal.entry) || 0)) / 0.1)} points)
TP2 RR: ${signal.tp2RrString || '1:3.00'}
Main RR: ${signal.rr}

RISK & POSITION SIZING:
- Account Balance: $${ps?.accountBalance ?? 10}
- Risk %: ${signal.riskPercent}%
- Risk $: $${(Number(signal.riskAmount) || 0).toFixed(2)}
- Lot Size: ${(Number(signal.standardLot ?? signal.recommendedLotSize) || 0).toFixed(4)}
- Standard Lot: ${(Number(signal.standardLot ?? signal.recommendedLotSize) || 0).toFixed(6)}
- Mini Lot: ${(Number(signal.miniLot ?? ((Number(signal.recommendedLotSize) || 0) * 10)) || 0).toFixed(6)}
- Micro Lot: ${(Number(signal.microLot ?? ((Number(signal.recommendedLotSize) || 0) * 100)) || 0).toFixed(6)}
- Price Distance: $${(Number(ps?.priceDistance ?? Math.abs((Number(signal.entry) || 0) - (Number(signal.stopLoss) || 0))) || 0).toFixed(2)}
- Contract Size: ${ps?.contractSizeOz ?? 100} oz
- Estimated Max Loss: $${(Number(signal.potentialLoss) || 0).toFixed(2)}
- Executable: ${signal.isExecutable ? 'YES' : 'NO (Below Broker Minimum Lot)'}

Confidence: ${signal.confidence}%
Timeframe: ${signal.timeframe}
Setup Type: ${signal.setup}

Short Reasons:
${signal.mainReasons.map((r) => `- ${r}`).join('\n')}

Invalidation: ${signal.invalidation}`;
      navigator.clipboard.writeText(text);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ⚪ NO TRADE DISPLAY
  if (signal.signal === 'NO TRADE') {
    return (
      <section className="bg-stone-900/90 border border-stone-800 rounded-2xl p-5 shadow-sm space-y-3.5">
        {renderTelemetryBar()}

        <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-stone-800">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚪</span>
            <span className="text-base font-bold text-stone-200 tracking-wider">
              NO TRADE
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded bg-stone-800 text-stone-400 border border-stone-700">
              {signal.asset}
            </span>
          </div>

          <button
            onClick={copySignalText}
            className="text-xs text-stone-400 hover:text-stone-200 flex items-center gap-1 p-1 rounded hover:bg-stone-800 transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'تم النسخ' : 'نسخ'}</span>
          </button>
        </div>

        <div className="bg-stone-950/70 border border-stone-800/80 rounded-xl p-3.5">
          <div className="text-[11px] font-semibold text-rose-400 mb-1 flex items-center gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>سبب حجب الصفقة (Failed Validation Reason):</span>
          </div>
          <p className="text-xs sm:text-sm text-stone-300 leading-relaxed font-sans">
            {signal.noTradeReason || 'عدم وجود فرصة واضحة بنسبة عائد تفوق 1:1.5 مع وقف خسارة مناسب.'}
          </p>
        </div>

        <div className="mt-3 flex items-center justify-between text-[11px] text-stone-400">
          <span className="flex items-center gap-1 text-emerald-400/90">
            <ShieldAlert className="w-3.5 h-3.5" /> حماية رأس المال: تجنب المخاطرة العشوائية
          </span>
          <span className="font-mono">{new Date(signal.timestamp).toLocaleTimeString()}</span>
        </div>
      </section>
    );
  }

  // 🔥 TRADE SIGNAL DISPLAY
  const isBuy = signal.signal.includes('BUY');
  const ps = signal.positionSizing;

  const priceDistance = ps?.priceDistance ?? Math.abs(signal.entry - signal.stopLoss);
  const contractSizeOz = ps?.contractSizeOz ?? 100;
  const accountBalance = ps?.accountBalance ?? 10;
  const standardLot = signal.standardLot ?? (ps ? ps.standardLotSize : signal.recommendedLotSize);
  const miniLot = signal.miniLot ?? (ps ? ps.miniLotSize : standardLot * 10);
  const microLot = signal.microLot ?? (ps ? ps.microLotSize : standardLot * 100);
  const isExecutable = signal.isExecutable ?? ps?.isExecutable ?? true;

  // Separate RR calculation values
  const tp1RrStr = signal.tp1RrString || (signal.tp1Rr ? `1:${(Number(signal.tp1Rr) || 0).toFixed(2)}` : '1:1.50');
  const tp2RrStr = signal.tp2RrString || (signal.tp2Rr ? `1:${(Number(signal.tp2Rr) || 0).toFixed(2)}` : '1:3.00');

  // Confidence Tier tag
  let confidenceLabel = 'متوسط';
  let confidenceColor = 'bg-stone-800 text-stone-300 border-stone-700';
  if (signal.confidence >= 95) {
    confidenceLabel = 'نادر جدًا (95%+)';
    confidenceColor = 'bg-purple-950/50 text-purple-300 border-purple-800/60';
  } else if (signal.confidence >= 85) {
    confidenceLabel = 'قوي جدًا';
    confidenceColor = 'bg-emerald-950/50 text-emerald-300 border-emerald-800/60';
  } else if (signal.confidence >= 75) {
    confidenceLabel = 'جيد';
    confidenceColor = 'bg-amber-950/50 text-amber-300 border-amber-800/60';
  }

  return (
    <section className="bg-stone-900/95 border border-stone-800 rounded-2xl p-4 sm:p-5 shadow-md relative overflow-hidden space-y-4">
      {/* Required Live Scanner Telemetry: Data Status, Last Scan, Next Scan */}
      {renderTelemetryBar()}

      {/* Top Banner */}
      <div className="flex items-center justify-between gap-2 pb-3 border-b border-stone-800">
        <div className="flex items-center gap-2">
          <span className="text-xl">🔥</span>
          <span className="text-base sm:text-lg font-black tracking-wide text-amber-400">
            TRADE SIGNAL
          </span>
          <span className="text-xs font-mono px-2 py-0.5 rounded bg-stone-800 text-stone-200 border border-stone-700">
            {signal.asset}
          </span>
        </div>

        <button
          onClick={copySignalText}
          className="text-xs text-stone-400 hover:text-stone-200 flex items-center gap-1 px-2.5 py-1 rounded bg-stone-800/70 border border-stone-700 hover:bg-stone-800 transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          <span>{copied ? 'تم النسخ' : 'نسخ الإشارة الكاملة'}</span>
        </button>
      </div>

      {/* Signal Type & Setup Banner */}
      <div className="flex items-center justify-between gap-3 bg-stone-950/70 border border-stone-800 p-3 rounded-xl">
        <div className="flex items-center gap-2.5">
          <div
            className={`px-3 py-1.5 rounded-lg text-sm sm:text-base font-extrabold tracking-wide border shadow-sm ${
              isBuy
                ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                : 'bg-rose-500/20 text-rose-400 border-rose-500/40'
            }`}
          >
            {signal.signal}
          </div>
          <div>
            <div className="text-[10px] text-stone-400 uppercase tracking-wider">
              Setup (النموذج)
            </div>
            <div className="text-xs font-semibold text-stone-200 truncate max-w-[200px] sm:max-w-[280px]">
              {signal.setup}
            </div>
          </div>
        </div>

        <div className="text-right">
          <div className="text-[10px] text-stone-400 uppercase tracking-wider">
            Confidence
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <span className="text-sm font-bold font-mono text-stone-100">
              {signal.confidence}%
            </span>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${confidenceColor}`}>
              {confidenceLabel}
            </span>
          </div>
        </div>
      </div>

      {/* Execution Price Matrix: Entry, Stop Loss, TP1, TP2 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {/* Entry */}
        <div className="bg-stone-950/50 border border-stone-800/80 rounded-xl p-2.5">
          <div className="flex items-center justify-between text-[10px] text-stone-400 mb-0.5">
            <span>Entry (الدخول)</span>
            <span className="font-mono">Live</span>
          </div>
          <span className="text-base font-bold font-mono text-stone-100">
            ${(Number(signal.entry) || 0).toFixed(2)}
          </span>
        </div>

        {/* Stop Loss */}
        <div className="bg-rose-950/15 border border-rose-900/40 rounded-xl p-2.5">
          <div className="flex items-center justify-between text-[10px] text-rose-400/80 mb-0.5">
            <span>Stop Loss</span>
            <span className="font-mono">{signal.slPoints} pts</span>
          </div>
          <span className="text-base font-bold font-mono text-rose-400">
            ${(Number(signal.stopLoss) || 0).toFixed(2)}
          </span>
          <span className="text-[9px] text-rose-300/70 block mt-0.5">
            المسافة: ${(Number(priceDistance) || 0).toFixed(2)} (≤ 100 pts)
          </span>
        </div>

        {/* TP1 (Primary Target) */}
        <div className="bg-emerald-950/15 border border-emerald-900/40 rounded-xl p-2.5">
          <div className="flex items-center justify-between text-[10px] text-emerald-400/80 mb-0.5">
            <span>TP1 (الهدف الأساسي)</span>
            <span className="font-mono font-bold text-emerald-300">
              {signal.tp1Points ? `${signal.tp1Points} pts` : tp1RrStr}
            </span>
          </div>
          <span className="text-base font-bold font-mono text-emerald-400">
            ${(Number(signal.tp1) || 0).toFixed(2)}
          </span>
          <span className="text-[9px] text-emerald-400/70 block mt-0.5">
            TP1 RR: {tp1RrStr} {signal.tp1Points ? `(${signal.tp1Points} pts)` : ''}
          </span>
        </div>

        {/* TP2 (Runner Target) */}
        <div className="bg-emerald-950/25 border border-emerald-800/50 rounded-xl p-2.5">
          <div className="flex items-center justify-between text-[10px] text-emerald-300/90 mb-0.5">
            <span>TP2 (هدف الامتداد)</span>
            <span className="font-mono font-bold text-emerald-200">
              {signal.tp2Points ? `${signal.tp2Points} pts` : tp2RrStr}
            </span>
          </div>
          <span className="text-base font-bold font-mono text-emerald-300">
            ${(Number(signal.tp2) || 0).toFixed(2)}
          </span>
          <span className="text-[9px] text-emerald-300/70 block mt-0.5">
            TP2 RR: {tp2RrStr} {signal.tp2Points ? `(${signal.tp2Points} pts)` : '(Runner)'}
          </span>
        </div>
      </div>

      {/* 🛡️ DEDICATED RISK CALCULATION & POSITION SIZING SECTION */}
      <div className="bg-stone-950/90 border border-stone-800 rounded-xl p-3.5 space-y-3">
        <div className="flex items-center justify-between border-b border-stone-800/80 pb-2">
          <div className="flex items-center gap-1.5 font-bold text-amber-400 text-xs uppercase tracking-wider">
            <Calculator className="w-4 h-4 text-amber-400" />
            <span>حساب المخاطرة وحجم اللوت الدقيق (Risk & Position Sizing Engine)</span>
          </div>
          <span className="text-[10px] text-stone-400 font-mono">
            {signal.rr}
          </span>
        </div>

        {/* 10 Required Metric Items */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div className="bg-stone-900/60 border border-stone-800/70 rounded-lg p-2">
            <span className="text-[10px] text-stone-400 block">Account Balance</span>
            <span className="font-mono font-bold text-stone-100">${(Number(accountBalance) || 0).toFixed(2)}</span>
          </div>

          <div className="bg-stone-900/60 border border-stone-800/70 rounded-lg p-2">
            <span className="text-[10px] text-stone-400 block">Risk %</span>
            <span className="font-mono font-bold text-amber-400">{(Number(signal.riskPercent) || 15).toFixed(2)}%</span>
          </div>

          <div className="bg-stone-900/60 border border-stone-800/70 rounded-lg p-2">
            <span className="text-[10px] text-stone-400 block">Risk $ (مبلغ المخاطرة)</span>
            <span className="font-mono font-bold text-rose-400">${(Number(signal.riskAmount) || 0).toFixed(2)}</span>
          </div>

          <div className="bg-stone-900/60 border border-stone-800/70 rounded-lg p-2">
            <span className="text-[10px] text-stone-400 block">Price Distance</span>
            <span className="font-mono font-bold text-stone-200">${(Number(priceDistance) || 0).toFixed(2)} ({signal.slPoints} pts)</span>
          </div>

          <div className="bg-stone-900/60 border border-stone-800/70 rounded-lg p-2">
            <span className="text-[10px] text-stone-400 block">Contract Size</span>
            <span className="font-mono font-bold text-stone-200">{contractSizeOz} oz / Std Lot</span>
          </div>

          <div className="bg-stone-900/60 border border-stone-800/70 rounded-lg p-2">
            <span className="text-[10px] text-stone-400 block">Estimated Max Loss</span>
            <span className="font-mono font-bold text-rose-400">${(Number(signal.potentialLoss) || 0).toFixed(2)}</span>
          </div>

          <div className="bg-stone-900/60 border border-stone-800/70 rounded-lg p-2">
            <span className="text-[10px] text-stone-400 block">TP1 Expected Profit</span>
            <span className="font-mono font-bold text-emerald-400">+${(Number(signal.potentialProfit) || 0).toFixed(2)}</span>
          </div>

          <div className="bg-stone-900/60 border border-stone-800/70 rounded-lg p-2">
            <span className="text-[10px] text-stone-400 block">Primary Target</span>
            <span className="font-mono font-bold text-emerald-300">TP1 ({tp1RrStr})</span>
          </div>
        </div>

        {/* Distinct Lot Units Display (NEVER MIX UNITS) */}
        <div className="pt-1">
          <div className="text-[11px] font-semibold text-stone-300 mb-1.5 flex items-center justify-between">
            <span className="flex items-center gap-1 text-stone-300">
              <Layers className="w-3.5 h-3.5 text-amber-400" />
              <span>أحجام اللوت المحسوبة رياضياً (Calculated Lots by Unit):</span>
            </span>
            <span className="text-[10px] text-stone-400">
              الصيغة: Risk $ / (Price Distance × Contract Size)
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {/* Standard Lot */}
            <div className="bg-stone-900 border border-stone-800 p-2.5 rounded-xl text-center">
              <div className="text-[10px] uppercase font-bold text-stone-400 mb-0.5">
                STANDARD LOT
              </div>
              <div className="text-base sm:text-lg font-black font-mono text-stone-100">
                {(Number(standardLot) || 0).toFixed(6)}
              </div>
              <div className="text-[10px] text-stone-400 mt-0.5">
                1 Std Lot = {contractSizeOz} oz
              </div>
            </div>

            {/* Mini Lot */}
            <div className="bg-stone-900 border border-stone-800 p-2.5 rounded-xl text-center">
              <div className="text-[10px] uppercase font-bold text-amber-400 mb-0.5">
                MINI LOT
              </div>
              <div className="text-base sm:text-lg font-black font-mono text-amber-400">
                {(Number(miniLot) || 0).toFixed(5)}
              </div>
              <div className="text-[10px] text-stone-400 mt-0.5">
                1 Mini Lot = 0.1 Std ({contractSizeOz * 0.1} oz)
              </div>
            </div>

            {/* Micro Lot */}
            <div className="bg-stone-900 border border-stone-800 p-2.5 rounded-xl text-center">
              <div className="text-[10px] uppercase font-bold text-emerald-400 mb-0.5">
                MICRO LOT
              </div>
              <div className="text-base sm:text-lg font-black font-mono text-emerald-400">
                {(Number(microLot) || 0).toFixed(4)}
              </div>
              <div className="text-[10px] text-stone-400 mt-0.5">
                1 Micro Lot = 0.01 Std ({contractSizeOz * 0.01} oz)
              </div>
            </div>
          </div>
        </div>

        {/* Broker Minimum Lot Constraints Alert */}
        {!isExecutable ? (
          <div className="bg-rose-950/30 border border-rose-800/80 rounded-xl p-3 text-xs space-y-1.5">
            <div className="flex items-center gap-1.5 font-bold text-rose-400 text-xs">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>TRADE NOT EXECUTABLE AT THIS RISK WITH CURRENT BROKER MINIMUM LOT</span>
            </div>
            <p className="text-[11px] text-rose-200/90 leading-relaxed font-sans">
              {signal.nonExecutableReason ||
                `اللوت المحسوب رياضياً (${(Number(standardLot) || 0).toFixed(6)} Standard Lot) أقل من الحد الأدنى للوسيط (${ps?.minimumLot ?? 0.01} Standard Lot). التداول بالحد الأدنى للوسيط (0.01) يعرض الحساب لمخاطرة ${(
                  (((ps?.minimumLot ?? 0.01) * (Number(priceDistance) || 0) * contractSizeOz) / (Number(accountBalance) || 10)) * 100
                ).toFixed(1)}% ($${(((ps?.minimumLot ?? 0.01) * (Number(priceDistance) || 0) * contractSizeOz)).toFixed(2)})، وهو انتهاك مباشر لقاعدة حماية الحساب.`}
            </p>
            <div className="text-[10px] text-stone-400 bg-stone-950/60 p-2 rounded-lg border border-stone-800">
              💡 <strong>إرشاد حماية رأس المال:</strong> لتنفيذ هذه الصفقة دون الإخلال بالمخاطرة، يمكنك التداول عبر حساب سنت (Cent Account)، أو وسيط يتيح Fractional Micro Lots، أو زيادة رصيد الحساب. لم يتم زيادة حجم اللوت تلقائياً حفاظاً على أمانك.
            </div>
          </div>
        ) : (
          <div className="bg-emerald-950/20 border border-emerald-900/50 rounded-xl p-2.5 text-xs flex items-center gap-2 text-emerald-300">
            <Check className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="text-[11px]">
              اللوت المحسوب متوافق تماماً مع قيود الحد الأدنى للوسيط الحالي وقابل للتنفيذ المباشر.
            </span>
          </div>
        )}
      </div>

      {/* Main Reasons (Bullet points) */}
      <div className="bg-stone-950/70 border border-stone-800 rounded-xl p-3">
        <div className="text-[11px] font-bold text-stone-300 mb-1.5">
          Main Reasons (أسباب الدخول الأساسية):
        </div>
        <ul className="space-y-1 text-xs text-stone-300">
          {signal.mainReasons.map((reason, idx) => (
            <li key={idx} className="flex items-start gap-1.5">
              <span className="text-amber-400 font-bold">•</span>
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Invalidation Rule */}
      <div className="bg-amber-950/15 border border-amber-900/40 rounded-xl p-3 flex items-start gap-2 text-xs text-amber-200/90">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <div>
          <span className="font-bold text-amber-300 block mb-0.5">Invalidation (منطقة الإلغاء):</span>
          <span>{signal.invalidation}</span>
        </div>
      </div>

      {/* Quick Action: Log to Trade Ledger */}
      {onExecuteTrade && (
        <button
          onClick={() => onExecuteTrade(signal)}
          disabled={isLogged}
          className={`w-full py-2.5 px-4 rounded-xl font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all ${
            isLogged
              ? 'bg-stone-800 text-emerald-400 border border-emerald-500/30 cursor-default'
              : !isExecutable
              ? 'bg-amber-950/30 hover:bg-amber-900/40 text-amber-300 border border-amber-800/60 cursor-pointer'
              : 'bg-amber-500 hover:bg-amber-400 text-stone-950 border border-amber-400 font-bold cursor-pointer'
          }`}
        >
          {isLogged ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>تم تسجيل الصفقة في سجل الصفقات (Trade Ledger)</span>
            </>
          ) : !isExecutable ? (
            <>
              <PlusCircle className="w-4 h-4 text-amber-400" />
              <span>تسجيل الصفقة في السجل للمتابعة النظرية (Paper Log Only)</span>
            </>
          ) : (
            <>
              <PlusCircle className="w-4 h-4 text-stone-950" />
              <span>تنفيذ وتسجيل الصفقة في سجل الحساب (Log Trade)</span>
            </>
          )}
        </button>
      )}
    </section>
  );
};
