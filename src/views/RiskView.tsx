import React, { useState } from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  Lock,
  CheckCircle2,
  XCircle,
  Percent,
  DollarSign,
  Scale,
  Calculator,
  Sliders,
  Info,
  Radio,
  ExternalLink,
} from 'lucide-react';
import { AppSettings, BrokerSettings, MT5AccountInfo } from '../types';

interface RiskViewProps {
  settings?: AppSettings;
  activeCapital?: number;
  mt5Account?: MT5AccountInfo;
  currentBalance?: number;
  brokerSettings?: BrokerSettings;
  onNavigateToSettings?: () => void;
}

export const RiskView: React.FC<RiskViewProps> = ({
  settings,
  activeCapital,
  mt5Account,
  currentBalance = 10,
  brokerSettings,
  onNavigateToSettings,
}) => {
  // Safe resolved active capital
  const effectiveCapital = typeof activeCapital === 'number'
    ? activeCapital
    : (settings?.manualCapital ?? Number(currentBalance || 10));

  const riskPercent = typeof settings?.riskPerTrade === 'number' ? settings.riskPerTrade : 15.0;
  const maxRiskPercent = typeof settings?.maxRiskPerTrade === 'number' ? settings.maxRiskPerTrade : 15.0;
  const effectiveRiskPercent = Math.min(riskPercent, maxRiskPercent);

  const riskAmount = Number(((effectiveCapital * effectiveRiskPercent) / 100).toFixed(2));
  const maxAllowedRisk = Number(((effectiveCapital * maxRiskPercent) / 100).toFixed(2));

  // Test calculator state
  const [testSlPoints, setTestSlPoints] = useState<number>(40); // default 40 points ($4.00 distance)
  const [testBalance, setTestBalance] = useState<number>(effectiveCapital);

  // Simulator calculations
  const simBalance = Number(testBalance) > 0 ? Number(testBalance) : effectiveCapital;
  const simRiskAmount = Number(((simBalance * effectiveRiskPercent) / 100).toFixed(2));
  
  // Gold calculation: contract size = 100 oz
  // 1 point = $0.10 price movement
  // 1 standard lot moves $10 per point
  // 0.01 lot moves $0.10 per point
  const dollarsLossPerMinLot = (Number(testSlPoints) || 0) * 0.1; // for 0.01 lot
  const isTradeBlockedByMinLot = simRiskAmount > 0 && dollarsLossPerMinLot > simRiskAmount;
  const isTradeBlockedByMaxSl = (Number(testSlPoints) || 0) > (settings?.maxGoldSlPoints ?? 100);

  const isSimBlocked = isTradeBlockedByMinLot || isTradeBlockedByMaxSl;
  const blockedReason = isTradeBlockedByMaxSl
    ? `Maximum Gold Stop Loss exceeded (> ${settings?.maxGoldSlPoints ?? 100} points).`
    : isTradeBlockedByMinLot
    ? `TRADE BLOCKED: Minimum broker lot (0.01) loss ($${dollarsLossPerMinLot.toFixed(2)}) exceeds configured risk ($${simRiskAmount.toFixed(2)}).`
    : '';

  // Typical lot size calculation for 40 points
  const standardPointRisk = (settings?.contractSizeOz ?? 100) * 0.1 * 40; // 400
  const typicalLot = standardPointRisk > 0 ? riskAmount / standardPointRisk : 0;

  return (
    <div className="space-y-4 sm:space-y-6 animate-in fade-in duration-250">
      {/* Top Banner: Core Risk Metrics */}
      <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between pb-3 mb-4 border-b border-stone-800/80 gap-2">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center border border-amber-500/30">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm sm:text-base font-black text-stone-100 font-mono">
                محرك إدارة المخاطر المؤسسي (Institutional Risk Engine)
              </h3>
              <p className="text-xs text-stone-400">
                قواعد حماية رأس المال الصارمة لحساب التحدي - متزامنة حياً مع الإعدادات
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
              SOURCE: {settings?.capitalSource || 'MANUAL'}
            </span>
            {onNavigateToSettings && (
              <button
                type="button"
                onClick={onNavigateToSettings}
                className="text-xs font-mono text-amber-400 hover:text-amber-300 underline flex items-center gap-1 cursor-pointer"
              >
                تعديل الإعدادات <ExternalLink className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {/* 5 Prominent Cards requested by user */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 font-mono">
          {/* 1. RISK PER TRADE */}
          <div className="bg-stone-950/80 border border-amber-500/40 rounded-xl p-3.5 shadow-inner">
            <div className="flex items-center justify-between text-stone-400 text-xs mb-1">
              <span>RISK PER TRADE</span>
              <Percent className="w-4 h-4 text-amber-400" />
            </div>
            <span className="text-xl sm:text-2xl font-black text-amber-400 block">
              {effectiveRiskPercent.toFixed(1)}%
            </span>
            <span className="text-[10px] text-stone-400 block mt-1">نسبة محددة من الـ UI</span>
          </div>

          {/* 2. ACTIVE CAPITAL */}
          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-3.5">
            <div className="flex items-center justify-between text-stone-400 text-xs mb-1">
              <span>ACTIVE CAPITAL</span>
              <DollarSign className="w-4 h-4 text-stone-400" />
            </div>
            <span className="text-xl sm:text-2xl font-black text-stone-100 block">
              ${effectiveCapital.toFixed(2)}
            </span>
            <span className="text-[10px] text-stone-400 block mt-1">
              {settings?.capitalSource === 'MT5' ? 'MT5 Feed Balance' : 'Manual Capital'}
            </span>
          </div>

          {/* 3. RISK AMOUNT */}
          <div className="bg-stone-950/80 border border-rose-950/80 rounded-xl p-3.5">
            <div className="flex items-center justify-between text-rose-400 text-xs mb-1">
              <span>RISK AMOUNT</span>
              <DollarSign className="w-4 h-4 text-rose-400" />
            </div>
            <span className="text-xl sm:text-2xl font-black text-rose-400 block">
              ${riskAmount.toFixed(2)}
            </span>
            <span className="text-[10px] text-stone-400 block mt-1">أقصى خسارة مسموح بها</span>
          </div>

          {/* 4. MAX ALLOWED RISK */}
          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-3.5">
            <div className="flex items-center justify-between text-stone-400 text-xs mb-1">
              <span>MAX ALLOWED RISK</span>
              <Lock className="w-4 h-4 text-stone-400" />
            </div>
            <span className="text-xl sm:text-2xl font-black text-stone-200 block">
              ${maxAllowedRisk.toFixed(2)}
            </span>
            <span className="text-[10px] text-stone-400 block mt-1">
              سقف الـ {maxRiskPercent}% الأقصى
            </span>
          </div>

          {/* 5. POSITION SIZE */}
          <div className="bg-stone-950/80 border border-cyan-950/80 rounded-xl p-3.5 col-span-2 sm:col-span-1">
            <div className="flex items-center justify-between text-cyan-400 text-xs mb-1">
              <span>ESTIMATED LOT</span>
              <Scale className="w-4 h-4 text-cyan-400" />
            </div>
            <span className="text-xl sm:text-2xl font-black text-cyan-300 block">
              {typicalLot > 0 ? typicalLot.toFixed(4) : '0.0100'}
            </span>
            <span className="text-[10px] text-stone-400 block mt-1">Standard Lot (40 pts SL)</span>
          </div>
        </div>
      </div>

      {/* Capital Source Status Strip */}
      <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5">
        <div className="flex items-center justify-between border-b border-stone-800 pb-2 mb-3">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-amber-400" />
            <h4 className="text-xs sm:text-sm font-bold text-stone-100 uppercase tracking-wide font-mono">
              حالة مصدر رأس المال (Capital Source Live Status)
            </h4>
          </div>
          <span className="text-xs font-mono font-bold text-stone-400">
            Current Mode: {settings?.capitalSource || 'MANUAL'}
          </span>
        </div>

        {settings?.capitalSource === 'MT5' ? (
          <div className="space-y-3 font-mono text-xs">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-stone-950/80 p-3 rounded-xl border border-stone-800">
                <span className="text-stone-400 text-[10px] block">MT5 Status</span>
                <span
                  className={`text-xs font-bold block mt-1 ${
                    mt5Account?.connected ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {mt5Account?.connected ? 'CONNECTED' : 'DISCONNECTED'}
                </span>
              </div>
              <div className="bg-stone-950/80 p-3 rounded-xl border border-stone-800">
                <span className="text-stone-400 text-[10px] block">Balance</span>
                <span className="text-sm font-bold text-stone-100 block mt-0.5">
                  {mt5Account?.connected && typeof mt5Account.balance === 'number'
                    ? `$${mt5Account.balance.toFixed(2)}`
                    : '—'}
                </span>
              </div>
              <div className="bg-stone-950/80 p-3 rounded-xl border border-stone-800">
                <span className="text-stone-400 text-[10px] block">Equity</span>
                <span className="text-sm font-bold text-stone-100 block mt-0.5">
                  {mt5Account?.connected && typeof mt5Account.equity === 'number'
                    ? `$${mt5Account.equity.toFixed(2)}`
                    : '—'}
                </span>
              </div>
              <div className="bg-stone-950/80 p-3 rounded-xl border border-stone-800">
                <span className="text-stone-400 text-[10px] block">Free Margin</span>
                <span className="text-sm font-bold text-stone-100 block mt-0.5">
                  {mt5Account?.connected && typeof mt5Account.freeMargin === 'number'
                    ? `$${mt5Account.freeMargin.toFixed(2)}`
                    : '—'}
                </span>
              </div>
            </div>
            {!mt5Account?.connected && (
              <p className="text-[11px] text-rose-400/90 bg-rose-950/40 border border-rose-800/60 p-2.5 rounded-lg">
                ⚠️ حساب MT5 غير متصل. النظام محمي تلقائيًا ولا ينفذ أي صفقات جديدة حتى يتم الاتصال، ولا يتم استخدام أي أرقام وهمية.
              </p>
            )}
          </div>
        ) : (
          <div className="p-3 bg-stone-950/80 border border-stone-800 rounded-xl flex items-center justify-between text-xs font-mono">
            <div>
              <span className="text-stone-200 font-bold block">
                رأس المال اليدوي النشط (Manual Active Capital): ${effectiveCapital.toFixed(2)}
              </span>
              <span className="text-stone-400 text-[11px]">
                يتم حسابه واعتماده في كل من الـ Scanner والـ Risk Manager والـ TP Engine
              </span>
            </div>
            <span className="px-2.5 py-1 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400 font-bold">
              MANUAL ACTIVE
            </span>
          </div>
        )}
      </div>

      {/* Gold Risk Rules Box */}
      <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5">
        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-stone-800">
          <ShieldCheck className="w-4 h-4 text-amber-400" />
          <h4 className="text-sm font-bold text-stone-100 uppercase tracking-wide">
            قواعد مخاطرة الذهب الإلزامية (XAUUSD Gold Risk Rules)
          </h4>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-3 space-y-1">
            <div className="flex items-center justify-between text-stone-300 font-bold font-mono">
              <span>Maximum SL = {settings?.maxGoldSlPoints ?? 100} points</span>
              <span className="text-rose-400 font-bold">${((settings?.maxGoldSlPoints ?? 100) * 0.1).toFixed(2)} Move</span>
            </div>
            <p className="text-stone-400 text-[11px] leading-relaxed">
              إذا تطلب النموذج الفني وقف خسارة أكبر من {settings?.maxGoldSlPoints ?? 100} نقطة، يتم رفض الصفقة تلقائياً.
            </p>
          </div>

          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-3 space-y-1">
            <div className="flex items-center justify-between text-stone-300 font-bold font-mono">
              <span>Preferred SL = 30–50 points</span>
              <span className="text-emerald-400 font-bold">$3.00–$5.00 Move</span>
            </div>
            <p className="text-stone-400 text-[11px] leading-relaxed">
              تفضيل النماذج ذات الوقف المحكم لتعظيم حجم الصفقة والعائد بالنسبة للمخاطرة (R:R).
            </p>
          </div>

          <div className="bg-stone-950/80 border border-stone-800 rounded-xl p-3 space-y-1">
            <div className="flex items-center justify-between text-stone-300 font-bold font-mono">
              <span>Dynamic TP1 ≥ {settings?.minTp1RR ?? 1.5}R</span>
              <span className="text-amber-400 font-bold">1:{settings?.minTp1RR ?? 1.5} Target</span>
            </div>
            <p className="text-stone-400 text-[11px] leading-relaxed">
              الهدف الأول 1.5x مسافة الوقف على الأقل لحساب التحدي لضمان متوسط ربح إيجابي مستدام.
            </p>
          </div>
        </div>
      </div>

      {/* Interactive Simulator Card */}
      <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-stone-800 pb-2">
          <div className="flex items-center gap-2">
            <Calculator className="w-4 h-4 text-cyan-400" />
            <h4 className="text-sm font-bold text-stone-100 font-mono">
              أداة التحقق من أحجام الصفقات وحماية الحساب (Interactive Lot & Risk Simulator)
            </h4>
          </div>
          <span className="text-xs font-mono text-cyan-400">
            {testSlPoints} Points SL | ${(testSlPoints * 0.1).toFixed(2)} Move
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-xs text-stone-400 font-mono flex items-center justify-between">
              <span>رأس المال التجريبي (Simulated Capital):</span>
              <span className="text-stone-200 font-bold">${simBalance.toFixed(2)}</span>
            </label>
            <input
              type="number"
              min="1"
              value={testBalance}
              onChange={(e) => setTestBalance(Number(e.target.value))}
              className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-stone-100 font-mono text-sm"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs text-stone-400 font-mono flex items-center justify-between">
              <span>مسافة وقف الخسارة بالنقاط (SL Points):</span>
              <span className="text-stone-200 font-bold">{testSlPoints} pts</span>
            </label>
            <input
              type="range"
              min="15"
              max="120"
              value={testSlPoints}
              onChange={(e) => setTestSlPoints(Number(e.target.value))}
              className="w-full accent-amber-500"
            />
          </div>
        </div>

        {/* Simulator Sizing Breakdown */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-xs">
          <div className="bg-stone-950 p-3 rounded-xl border border-stone-800">
            <span className="text-stone-400 text-[10px] block">Risk Allowed</span>
            <span className="text-sm font-bold text-rose-400 block mt-0.5">
              ${simRiskAmount.toFixed(2)}
            </span>
          </div>

          <div className="bg-stone-950 p-3 rounded-xl border border-stone-800">
            <span className="text-stone-400 text-[10px] block">0.01 Lot Loss</span>
            <span className="text-sm font-bold text-stone-200 block mt-0.5">
              ${dollarsLossPerMinLot.toFixed(2)}
            </span>
          </div>

          <div className="bg-stone-950 p-3 rounded-xl border border-stone-800">
            <span className="text-stone-400 text-[10px] block">Max Lots to Stay ≤ 15%</span>
            <span className="text-sm font-bold text-cyan-400 block mt-0.5">
              {dollarsLossPerMinLot > 0 ? (simRiskAmount / (dollarsLossPerMinLot * 100)).toFixed(4) : '0.0000'}
            </span>
          </div>

          <div className="bg-stone-950 p-3 rounded-xl border border-stone-800">
            <span className="text-stone-400 text-[10px] block">Verdict</span>
            <span
              className={`text-xs font-bold block mt-1 ${
                isSimBlocked ? 'text-rose-400' : 'text-emerald-400'
              }`}
            >
              {isSimBlocked ? 'BLOCKED' : 'EXECUTABLE'}
            </span>
          </div>
        </div>

        {isSimBlocked && (
          <div className="p-3 bg-rose-950/60 border border-rose-800/80 rounded-xl text-rose-300 text-xs font-mono flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
            <span>{blockedReason}</span>
          </div>
        )}
      </div>
    </div>
  );
};
