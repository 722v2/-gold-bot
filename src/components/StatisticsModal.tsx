import { X, BarChart3, TrendingUp, ShieldAlert, Award, ArrowUpRight, ArrowDownRight, Flame } from 'lucide-react';
import { AccountStats } from '../types';

interface StatisticsModalProps {
  stats: AccountStats;
  isOpen: boolean;
  onClose: () => void;
}

export const StatisticsModal = ({ stats, isOpen, onClose }: StatisticsModalProps) => {
  if (!isOpen) return null;

  const isProfit = stats.totalPl >= 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-stone-900 border border-stone-800 rounded-2xl max-w-lg w-full p-5 space-y-4 shadow-2xl relative">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-stone-800">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-amber-500/15 text-amber-400 flex items-center justify-center">
              <BarChart3 className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-stone-100">
                إحصائيات الأداء والمخاطرة (Account Statistics)
              </h2>
              <span className="text-[11px] text-stone-400">
                تحليل علمي دقيق لحساب التحدي الصغير
              </span>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-400 hover:text-stone-200 hover:bg-stone-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Primary Balances */}
        <div className="grid grid-cols-2 gap-3 bg-stone-950/70 p-3.5 rounded-xl border border-stone-800/80">
          <div>
            <span className="text-[10px] text-stone-400 block mb-0.5">Current Balance</span>
            <span className="text-xl font-bold font-mono text-stone-100">
              ${stats.currentBalance.toFixed(2)}
            </span>
          </div>

          <div className="text-right">
            <span className="text-[10px] text-stone-400 block mb-0.5">Starting Balance</span>
            <span className="text-xl font-bold font-mono text-stone-300">
              ${stats.startingBalance.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Detailed Metrics Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs font-mono">
          {/* Total P/L */}
          <div className="bg-stone-950/40 p-2.5 rounded-xl border border-stone-800/70">
            <span className="text-[10px] text-stone-400 font-sans block mb-1">Total P/L ($ & %)</span>
            <span className={`text-sm font-bold ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
              {isProfit ? '+' : ''}${stats.totalPl.toFixed(2)} ({isProfit ? '+' : ''}{stats.plPercent}%)
            </span>
          </div>

          {/* Max Drawdown */}
          <div className="bg-stone-950/40 p-2.5 rounded-xl border border-stone-800/70">
            <span className="text-[10px] text-stone-400 font-sans block mb-1">Max Drawdown</span>
            <span className="text-sm font-bold text-amber-400">
              {stats.drawdownPercent}% (-${stats.drawdown.toFixed(2)})
            </span>
          </div>

          {/* Win Rate */}
          <div className="bg-stone-950/40 p-2.5 rounded-xl border border-stone-800/70">
            <span className="text-[10px] text-stone-400 font-sans block mb-1">Win Rate</span>
            <span className="text-sm font-bold text-emerald-400">
              {stats.winRate}%
            </span>
          </div>

          {/* Trades summary */}
          <div className="bg-stone-950/40 p-2.5 rounded-xl border border-stone-800/70">
            <span className="text-[10px] text-stone-400 font-sans block mb-1">Number of Trades</span>
            <span className="text-sm font-bold text-stone-200">
              {stats.numberOfTrades} ({stats.wins}W / {stats.losses}L)
            </span>
          </div>

          {/* Average Win */}
          <div className="bg-stone-950/40 p-2.5 rounded-xl border border-stone-800/70">
            <span className="text-[10px] text-stone-400 font-sans block mb-1">Average Win</span>
            <span className="text-sm font-bold text-emerald-400">
              +${stats.averageWin.toFixed(2)}
            </span>
          </div>

          {/* Average Loss */}
          <div className="bg-stone-950/40 p-2.5 rounded-xl border border-stone-800/70">
            <span className="text-[10px] text-stone-400 font-sans block mb-1">Average Loss</span>
            <span className="text-sm font-bold text-rose-400">
              -${stats.averageLoss.toFixed(2)}
            </span>
          </div>

          {/* Largest Win */}
          <div className="bg-stone-950/40 p-2.5 rounded-xl border border-stone-800/70">
            <span className="text-[10px] text-stone-400 font-sans block mb-1">Largest Win</span>
            <span className="text-sm font-bold text-emerald-400">
              +${stats.largestWin.toFixed(2)}
            </span>
          </div>

          {/* Largest Loss */}
          <div className="bg-stone-950/40 p-2.5 rounded-xl border border-stone-800/70">
            <span className="text-[10px] text-stone-400 font-sans block mb-1">Largest Loss</span>
            <span className="text-sm font-bold text-rose-400">
              -${stats.largestLoss.toFixed(2)}
            </span>
          </div>

          {/* Average RR */}
          <div className="bg-stone-950/40 p-2.5 rounded-xl border border-stone-800/70">
            <span className="text-[10px] text-stone-400 font-sans block mb-1">Average RR</span>
            <span className="text-sm font-bold text-amber-400">
              1:{stats.averageRR.toFixed(2)}
            </span>
          </div>

          {/* Winning Streak */}
          <div className="bg-stone-950/40 p-2.5 rounded-xl border border-stone-800/70">
            <span className="text-[10px] text-stone-400 font-sans block mb-1">Winning Streak</span>
            <span className="text-sm font-bold text-emerald-400">
              {stats.winningStreak} متتالية
            </span>
          </div>

          {/* Losing Streak */}
          <div className="bg-stone-950/40 p-2.5 rounded-xl border border-stone-800/70">
            <span className="text-[10px] text-stone-400 font-sans block mb-1">Losing Streak</span>
            <span className="text-sm font-bold text-rose-400">
              {stats.losingStreak} الحالية
            </span>
          </div>

          {/* Total Risk Taken */}
          <div className="bg-stone-950/40 p-2.5 rounded-xl border border-stone-800/70">
            <span className="text-[10px] text-stone-400 font-sans block mb-1">Total Risk Taken</span>
            <span className="text-sm font-bold text-stone-300">
              ${stats.totalRiskTaken.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Target Balance Exclusion Note */}
        <div className="bg-amber-500/10 border border-amber-500/20 p-3 rounded-xl text-xs text-amber-300/90 leading-relaxed">
          <p className="font-semibold mb-0.5">قاعدة التحدي الأساسية:</p>
          <p>
            لا يوجد Target مالي نهائي، ولا يوجد هدف $100. الهدف هو بناء عادة التداول الصحيحة، وحماية رأس المال، واختيار صفقات ذات جودة فائقة (Selective Scalping) بنمو تدريجي مستمر.
          </p>
        </div>

        <div className="pt-2 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-semibold"
          >
            إغلاق النافذة
          </button>
        </div>
      </div>
    </div>
  );
};
