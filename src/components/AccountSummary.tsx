import { ArrowDownRight, ArrowUpRight, Percent, TrendingUp, Wallet, ShieldAlert, Award } from 'lucide-react';
import { AccountStats } from '../types';

interface AccountSummaryProps {
  stats: AccountStats;
  onEditBalance: () => void;
}

export const AccountSummary = ({ stats, onEditBalance }: AccountSummaryProps) => {
  const isProfit = stats.totalPl >= 0;

  return (
    <section className="bg-stone-900/90 border border-stone-800 rounded-2xl p-4 shadow-sm relative overflow-hidden">
      {/* Background ambient accent */}
      <div className="absolute -top-12 -right-12 w-36 h-36 bg-amber-500/5 rounded-full blur-3xl pointer-events-none" />

      {/* Primary Balance Row */}
      <div className="flex items-start justify-between gap-4 mb-4 pb-3 border-b border-stone-800/80">
        <div>
          <span className="text-[11px] font-medium text-stone-400 block mb-0.5">
            Current Balance (الرصيد الحالي)
          </span>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold tracking-tight text-stone-50 font-mono">
              ${stats.currentBalance.toFixed(2)}
            </span>
            <button
              onClick={onEditBalance}
              className="text-[11px] text-amber-400 hover:underline transition-colors"
            >
              تعديل
            </button>
          </div>
        </div>

        <div className="text-right">
          <span className="text-[11px] font-medium text-stone-400 block mb-0.5">
            Starting Balance (البداية)
          </span>
          <span className="text-lg font-semibold text-stone-300 font-mono">
            ${stats.startingBalance.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Grid of Key Account Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {/* Total P/L */}
        <div className="bg-stone-950/60 border border-stone-800/70 rounded-xl p-2.5">
          <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
            <span>Total P/L</span>
            {isProfit ? (
              <ArrowUpRight className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <ArrowDownRight className="w-3.5 h-3.5 text-rose-400" />
            )}
          </div>
          <div className="flex items-baseline gap-1">
            <span
              className={`text-base font-bold font-mono ${
                isProfit ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {isProfit ? '+' : ''}${stats.totalPl.toFixed(2)}
            </span>
            <span
              className={`text-[11px] font-medium ${
                isProfit ? 'text-emerald-500' : 'text-rose-500'
              }`}
            >
              ({isProfit ? '+' : ''}{stats.plPercent.toFixed(1)}%)
            </span>
          </div>
        </div>

        {/* Drawdown */}
        <div className="bg-stone-950/60 border border-stone-800/70 rounded-xl p-2.5">
          <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
            <span>Drawdown</span>
            <ShieldAlert className="w-3.5 h-3.5 text-amber-400/80" />
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-base font-bold font-mono text-stone-200">
              {stats.drawdownPercent.toFixed(1)}%
            </span>
            <span className="text-[11px] text-stone-400">
              (-${stats.drawdown.toFixed(2)})
            </span>
          </div>
        </div>

        {/* Win Rate */}
        <div className="bg-stone-950/60 border border-stone-800/70 rounded-xl p-2.5">
          <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
            <span>Win Rate</span>
            <Award className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-base font-bold font-mono text-amber-400">
              {stats.winRate}%
            </span>
            <span className="text-[11px] text-stone-400">
              ({stats.wins}W / {stats.losses}L)
            </span>
          </div>
        </div>

        {/* Number of Trades */}
        <div className="bg-stone-950/60 border border-stone-800/70 rounded-xl p-2.5">
          <div className="flex items-center justify-between text-[11px] text-stone-400 mb-1">
            <span>Trades</span>
            <TrendingUp className="w-3.5 h-3.5 text-stone-400" />
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-base font-bold font-mono text-stone-200">
              {stats.numberOfTrades}
            </span>
            <span className="text-[11px] text-stone-400">
              صفقات
            </span>
          </div>
        </div>
      </div>

      {/* Safety Notice: Strict Capital Preservation */}
      <div className="mt-3 pt-2.5 border-t border-stone-800/60 flex items-center justify-between text-[10px] text-stone-400">
        <span className="flex items-center gap-1 text-emerald-400">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          Capital Preservation Mode: Risk 1% - 3% Max
        </span>
        <span className="text-stone-400">
          لا يوجد Target وهمي • نمو تدريجي
        </span>
      </div>
    </section>
  );
};
