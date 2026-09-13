import { useState } from 'react';
import { X, Sliders, Shield, RotateCcw, Calculator, AlertTriangle, Check, RefreshCw } from 'lucide-react';
import { BrokerSettings, DEFAULT_BROKER_SETTINGS } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  startingBalance: number;
  currentBalance: number;
  brokerSettings: BrokerSettings;
  onSaveBalances: (starting: number, current: number) => void;
  onSaveBrokerSettings: (settings: BrokerSettings) => void;
  onResetLedger: () => void;
}

export const SettingsModal = ({
  isOpen,
  onClose,
  startingBalance,
  currentBalance,
  brokerSettings,
  onSaveBalances,
  onSaveBrokerSettings,
  onResetLedger,
}: SettingsModalProps) => {
  const [startingInput, setStartingInput] = useState<string>(startingBalance.toString());
  const [currentInput, setCurrentInput] = useState<string>(currentBalance.toString());

  const [riskPercent, setRiskPercent] = useState<string>(brokerSettings.riskPercent.toString());
  const [contractSizeOz, setContractSizeOz] = useState<string>(brokerSettings.contractSizeOz.toString());
  const [minimumLot, setMinimumLot] = useState<string>(brokerSettings.minimumLot.toString());
  const [maximumLot, setMaximumLot] = useState<string>(brokerSettings.maximumLot.toString());
  const [lotStep, setLotStep] = useState<string>(brokerSettings.lotStep.toString());
  const [maxGoldSlPoints, setMaxGoldSlPoints] = useState<string>(brokerSettings.maxGoldSlPoints.toString());
  const [minRr, setMinRr] = useState<string>(brokerSettings.minRr.toString());

  const [confirmReset, setConfirmReset] = useState(false);

  if (!isOpen) return null;

  // Live calculation preview based on current form inputs
  const parsedBalance = parseFloat(currentInput) || 10;
  const parsedRiskPct = Math.min(3.0, Math.max(0.5, parseFloat(riskPercent) || 1.5));
  const parsedContractSize = parseFloat(contractSizeOz) || 100;
  const parsedMinLot = parseFloat(minimumLot) || 0.01;

  // Example scenario: Entry 4417.25, SL 4424.15 -> Distance 6.90 (69 points)
  const previewDistance = 6.90;
  const previewRiskDollars = parsedBalance * (parsedRiskPct / 100);
  const previewRiskPerStdLot = previewDistance * parsedContractSize;
  const previewStdLot = previewRiskPerStdLot > 0 ? previewRiskDollars / previewRiskPerStdLot : 0;
  const previewMiniLot = previewStdLot * 10;
  const previewMicroLot = previewStdLot * 100;
  const isExecutableAtMinLot = previewStdLot >= parsedMinLot;

  const handleResetToDefaults = () => {
    setRiskPercent(DEFAULT_BROKER_SETTINGS.riskPercent.toString());
    setContractSizeOz(DEFAULT_BROKER_SETTINGS.contractSizeOz.toString());
    setMinimumLot(DEFAULT_BROKER_SETTINGS.minimumLot.toString());
    setMaximumLot(DEFAULT_BROKER_SETTINGS.maximumLot.toString());
    setLotStep(DEFAULT_BROKER_SETTINGS.lotStep.toString());
    setMaxGoldSlPoints(DEFAULT_BROKER_SETTINGS.maxGoldSlPoints.toString());
    setMinRr(DEFAULT_BROKER_SETTINGS.minRr.toString());
  };

  const handleSave = () => {
    const s = parseFloat(startingInput);
    const c = parseFloat(currentInput);
    if (!isNaN(s) && s > 0 && !isNaN(c) && c > 0) {
      onSaveBalances(s, c);
    }

    const updatedSettings: BrokerSettings = {
      accountBalance: c > 0 ? c : parsedBalance,
      riskPercent: Math.min(3.0, Math.max(1.0, parseFloat(riskPercent) || 1.5)),
      contractSizeOz: Math.max(1, parseFloat(contractSizeOz) || 100),
      minimumLot: Math.max(0.00001, parseFloat(minimumLot) || 0.01),
      maximumLot: Math.max(1, parseFloat(maximumLot) || 100),
      lotStep: Math.max(0.0001, parseFloat(lotStep) || 0.01),
      maxGoldSlPoints: Math.min(100, Math.max(10, parseFloat(maxGoldSlPoints) || 100)),
      minRr: Math.max(1.0, parseFloat(minRr) || 1.5),
    };

    onSaveBrokerSettings(updatedSettings);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-3 sm:p-4 overflow-y-auto">
      <div className="bg-stone-900 border border-stone-800 rounded-2xl max-w-lg w-full p-4 sm:p-6 space-y-4 shadow-2xl relative my-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-stone-800">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center border border-amber-500/20">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-stone-100">إعدادات الحساب ومواصفات وسيط التداول (Broker)</h2>
              <span className="text-[11px] text-stone-400">Position Sizing & Risk Management Engine</span>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-400 hover:text-stone-200 hover:bg-stone-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Section 1: Account Balances */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-amber-400 flex items-center gap-1.5 uppercase tracking-wider">
              <span>1. أرصدة الحساب (Account Balance)</span>
            </h3>
            <button
              onClick={handleResetToDefaults}
              className="text-[11px] text-stone-400 hover:text-amber-400 flex items-center gap-1 transition-colors"
            >
              <RefreshCw className="w-3 h-3" /> استعادة الإعدادات الافتراضية
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <label className="block text-stone-300 font-semibold mb-1">
                Starting Balance ($):
              </label>
              <input
                type="number"
                step="1"
                value={startingInput}
                onChange={(e) => setStartingInput(e.target.value)}
                className="w-full bg-stone-950 border border-stone-800 rounded-xl px-3 py-2 text-stone-100 font-mono text-sm focus:border-amber-500/60 focus:outline-none"
              />
              <span className="text-[10px] text-stone-400 block mt-0.5">
                رصيد انطلاق الحساب (افتراضي $10).
              </span>
            </div>

            <div>
              <label className="block text-stone-300 font-semibold mb-1">
                Current Balance ($):
              </label>
              <input
                type="number"
                step="0.01"
                value={currentInput}
                onChange={(e) => setCurrentInput(e.target.value)}
                className="w-full bg-stone-950 border border-stone-800 rounded-xl px-3 py-2 text-stone-100 font-mono text-sm focus:border-amber-500/60 focus:outline-none"
              />
              <span className="text-[10px] text-stone-400 block mt-0.5">
                الرصيد الفعلي الحالي لحساب الصفقات.
              </span>
            </div>
          </div>
        </div>

        {/* Section 2: Broker Contract & Lot Specs */}
        <div className="space-y-3 pt-2 border-t border-stone-800/80">
          <h3 className="text-xs font-bold text-amber-400 flex items-center gap-1.5 uppercase tracking-wider">
            <span>2. مواصفات عقد الوسيط وحجم اللوت (Broker Specs)</span>
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <label className="block text-stone-300 font-semibold mb-1">
                Contract Size (أونصة لكل عقد قياسي):
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="1"
                  value={contractSizeOz}
                  onChange={(e) => setContractSizeOz(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-800 rounded-xl px-3 py-2 text-stone-100 font-mono text-sm focus:border-amber-500/60 focus:outline-none"
                />
                <span className="absolute left-3 top-2.5 text-stone-400 text-xs font-mono">oz</span>
              </div>
              <span className="text-[10px] text-stone-400 block mt-0.5">
                معيار الذهب القياسي XAU/USD = 100 أونصة.
              </span>
            </div>

            <div>
              <label className="block text-stone-300 font-semibold mb-1">
                Risk % (نسبة المخاطرة لكل صفقة):
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="0.1"
                  min="1.0"
                  max="3.0"
                  value={riskPercent}
                  onChange={(e) => setRiskPercent(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-800 rounded-xl px-3 py-2 text-stone-100 font-mono text-sm focus:border-amber-500/60 focus:outline-none"
                />
                <span className="absolute left-3 top-2.5 text-stone-400 text-xs font-mono">%</span>
              </div>
              <span className="text-[10px] text-stone-400 block mt-0.5">
                طبيعي: 1%–2% | أقصى حد صارم: 3.0%.
              </span>
            </div>

            <div>
              <label className="block text-stone-300 font-semibold mb-1">
                Broker Minimum Lot (الحد الأدنى للوت):
              </label>
              <input
                type="number"
                step="0.001"
                min="0.0001"
                value={minimumLot}
                onChange={(e) => setMinimumLot(e.target.value)}
                className="w-full bg-stone-950 border border-stone-800 rounded-xl px-3 py-2 text-stone-100 font-mono text-sm focus:border-amber-500/60 focus:outline-none"
              />
              <span className="text-[10px] text-stone-400 block mt-0.5">
                وسطاء MT4/MT5 غالباً 0.01 لوت قياسي.
              </span>
            </div>

            <div>
              <label className="block text-stone-300 font-semibold mb-1">
                Broker Maximum Lot (الحد الأقصى للوت):
              </label>
              <input
                type="number"
                step="1"
                value={maximumLot}
                onChange={(e) => setMaximumLot(e.target.value)}
                className="w-full bg-stone-950 border border-stone-800 rounded-xl px-3 py-2 text-stone-100 font-mono text-sm focus:border-amber-500/60 focus:outline-none"
              />
              <span className="text-[10px] text-stone-400 block mt-0.5">
                أقصى حجم لوت مسموح به (افتراضي 100).
              </span>
            </div>

            <div>
              <label className="block text-stone-300 font-semibold mb-1">
                Lot Step (خطوة زيادة اللوت):
              </label>
              <input
                type="number"
                step="0.001"
                value={lotStep}
                onChange={(e) => setLotStep(e.target.value)}
                className="w-full bg-stone-950 border border-stone-800 rounded-xl px-3 py-2 text-stone-100 font-mono text-sm focus:border-amber-500/60 focus:outline-none"
              />
              <span className="text-[10px] text-stone-400 block mt-0.5">
                تدرج اللوت لدى الوسيط (افتراضي 0.01).
              </span>
            </div>

            <div>
              <label className="block text-stone-300 font-semibold mb-1">
                Max Gold SL Points (أقصى وقف بالنقاط):
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="5"
                  max="100"
                  value={maxGoldSlPoints}
                  onChange={(e) => setMaxGoldSlPoints(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-800 rounded-xl px-3 py-2 text-stone-100 font-mono text-sm focus:border-amber-500/60 focus:outline-none"
                />
                <span className="absolute left-3 top-2.5 text-stone-400 text-xs font-mono">pts</span>
              </div>
              <span className="text-[10px] text-stone-400 block mt-0.5">
                100 نقطة = 10.0$ حركة سعر الذهب (أقصى حد).
              </span>
            </div>

            <div>
              <label className="block text-stone-300 font-semibold mb-1">
                Minimum Risk:Reward (الحد الأدنى للـRR):
              </label>
              <input
                type="number"
                step="0.1"
                min="1.0"
                value={minRr}
                onChange={(e) => setMinRr(e.target.value)}
                className="w-full bg-stone-950 border border-stone-800 rounded-xl px-3 py-2 text-stone-100 font-mono text-sm focus:border-amber-500/60 focus:outline-none"
              />
              <span className="text-[10px] text-stone-400 block mt-0.5">
                الحد الأدنى الإلزامي هو 1:1.5 (أقل من ذلك مرفوض).
              </span>
            </div>
          </div>
        </div>

        {/* Live Mathematical Formula Preview Card */}
        <div className="bg-stone-950/80 border border-stone-800 p-3.5 rounded-xl space-y-2 text-xs">
          <div className="flex items-center justify-between text-amber-400 font-bold text-[11px]">
            <span className="flex items-center gap-1.5">
              <Calculator className="w-3.5 h-3.5" />
              <span>معاينة المحرك الرياضي (Live Formula Preview)</span>
            </span>
            <span className="font-mono text-stone-400 text-[10px]">
              وقف تجريبي: 6.90$ (69 نقطة)
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-[11px]">
            <div className="bg-stone-900/60 border border-stone-800/80 p-1.5 rounded-lg">
              <span className="text-stone-400 block text-[10px]">Risk Dollars</span>
              <span className="font-mono font-bold text-rose-400">${(Number(previewRiskDollars) || 0).toFixed(2)}</span>
            </div>
            <div className="bg-stone-900/60 border border-stone-800/80 p-1.5 rounded-lg">
              <span className="text-stone-400 block text-[10px]">Standard Lot</span>
              <span className="font-mono font-bold text-stone-100">{(Number(previewStdLot) || 0).toFixed(6)}</span>
            </div>
            <div className="bg-stone-900/60 border border-stone-800/80 p-1.5 rounded-lg">
              <span className="text-stone-400 block text-[10px]">Mini Lot (0.1 Std)</span>
              <span className="font-mono font-bold text-amber-400">{(Number(previewMiniLot) || 0).toFixed(5)}</span>
            </div>
            <div className="bg-stone-900/60 border border-stone-800/80 p-1.5 rounded-lg">
              <span className="text-stone-400 block text-[10px]">Micro Lot (0.01 Std)</span>
              <span className="font-mono font-bold text-emerald-400">{(Number(previewMicroLot) || 0).toFixed(4)}</span>
            </div>
          </div>

          {!isExecutableAtMinLot ? (
            <div className="bg-rose-950/25 border border-rose-900/50 p-2.5 rounded-lg text-rose-300 text-[11px] flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold block text-rose-200">
                  TRADE NOT EXECUTABLE AT THIS RISK WITH CURRENT BROKER MINIMUM LOT
                </span>
                <span>
                  اللوت المحسوب رياضياً ({(Number(previewStdLot) || 0).toFixed(5)} Standard) أقل من الحد الأدنى للوسيط ({parsedMinLot} Standard). لا يجوز رفع المخاطرة تلقائياً لحماية رأس المال الصغير.
                </span>
              </div>
            </div>
          ) : (
            <div className="bg-emerald-950/20 border border-emerald-900/40 p-2 rounded-lg text-emerald-300 text-[11px] flex items-center gap-2">
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span>اللوت المحسوب قابل للتنفيذ المباشر وفق قيود الوسيط الحالية.</span>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="pt-2 border-t border-stone-800/80 flex items-center justify-between">
          {!confirmReset ? (
            <button
              onClick={() => setConfirmReset(true)}
              className="text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1 transition-colors"
            >
              <RotateCcw className="w-3 h-3" /> إعادة ضبط سجل الصفقات
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-rose-400">تصفير السجل؟</span>
              <button
                onClick={() => {
                  onResetLedger();
                  setConfirmReset(false);
                }}
                className="px-2 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold"
              >
                نعم، تصفير
              </button>
              <button
                onClick={() => setConfirmReset(false)}
                className="px-2 py-1 rounded bg-stone-800 text-stone-300 text-xs"
              >
                إلغاء
              </button>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-300 text-xs font-medium transition-colors"
            >
              إلغاء
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 text-xs font-bold transition-colors"
            >
              حفظ جميع الإعدادات
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
