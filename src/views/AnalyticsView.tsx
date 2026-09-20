import React from 'react';
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Award,
  AlertCircle,
  Percent,
  DollarSign,
  ArrowUpRight,
  ArrowDownRight,
  Layers,
  LineChart,
} from 'lucide-react';
import { AccountStats, TradeLedgerItem } from '../types';

interface AnalyticsViewProps {
  stats: AccountStats;
  ledger: TradeLedgerItem[];
  startingBalance: number;
}

export const AnalyticsView: React.FC<AnalyticsViewProps> = ({
  stats,
  ledger = [],
  startingBalance = 100,
}) => {
  const safeStats = {
    numberOfTrades: stats?.numberOfTrades ?? 0,
    wins: stats?.wins ?? 0,
    losses: stats?.losses ?? 0,
    winRate: Number(stats?.winRate ?? 0),
    totalPl: Number(stats?.totalPl ?? 0),
    averageWin: Number(stats?.averageWin ?? 0),
    averageLoss: Number(stats?.averageLoss ?? 0),
    averageRR: Number(stats?.averageRR ?? 0),
    largestWin: Number(stats?.largestWin ?? 0),
    largestLoss: Number(stats?.largestLoss ?? 0),
    winningStreak: stats?.winningStreak ?? 0,
    losingStreak: stats?.losingStreak ?? 0,
    drawdownPercent: Number(stats?.drawdownPercent ?? 0),
    drawdown: Number(stats?.drawdown ?? 0),
    totalRiskTaken: Number(stats?.totalRiskTaken ?? 0),
  };
  const safeStartingBalance = Number(startingBalance || 100);

  const closedTrades = (ledger || []).filter(
    (t) => t && (t.result === 'WIN' || t.result === 'LOSS' || t.result === 'BREAK_EVEN')
  );
  const hasData = closedTrades.length > 0;

  // Build real equity points
  const equityPoints: { tradeNum: number; balance: number }[] = [
    { tradeNum: 0, balance: safeStartingBalance },
  ];

  let runningBalance = safeStartingBalance;
  // Closed trades in chronological order (oldest to newest)
  const chronoClosed = [...closedTrades].reverse();
  chronoClosed.forEach((t, index) => {
    runningBalance += Number(t.pl || 0);
    equityPoints.push({
      tradeNum: index + 1,
      balance: runningBalance,
    });
  });

  // Calculate SVG line points for Equity Curve
  const minBal = Math.min(...equityPoints.map((p) => p.balance), safeStartingBalance * 0.9);
  const maxBal = Math.max(...equityPoints.map((p) => p.balance), safeStartingBalance * 1.1);
  const range = maxBal - minBal || 1;

  const svgWidth = 600;
  const svgHeight = 180;
  const padding = 30;

  const pointsString = equityPoints
    .map((p, i) => {
      const x = padding + (i / Math.max(1, equityPoints.length - 1)) * (svgWidth - padding * 2);
      const y =
        svgHeight -
        padding -
        ((p.balance - minBal) / range) * (svgHeight - padding * 2);
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div className="space-y-4 sm:space-y-6 animate-in fade-in duration-250">
      {/* Top Header */}
      <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3 shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-cyan-400" />
            <h3 className="text-base font-black text-stone-100 font-mono">
              إحصائيات الأداء والمحفظة (Performance Analytics)
            </h3>
          </div>
          <p className="text-xs text-stone-400 mt-0.5">
            تحليل دقيق لنتائج الصفقات ومنحنى نمو رأس المال بناءً على الصفقات المسجلة فعلياً
          </p>
        </div>

        <div className="text-left font-mono">
          <span className="text-[10px] text-stone-400 block uppercase">صافي الأرباح (Net P/L)</span>
          <span
            className={`text-lg font-black ${
              safeStats.totalPl >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {safeStats.totalPl >= 0 ? `+$${safeStats.totalPl.toFixed(2)}` : `-$${Math.abs(safeStats.totalPl).toFixed(2)}`}
          </span>
        </div>
      </div>

      {/* 15 Analytical Cards requested by user */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 font-mono text-xs">
        {/* Total Trades */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-stone-400 block uppercase">Total Trades</span>
          <span className="text-lg font-black text-stone-100 mt-0.5 block">{safeStats.numberOfTrades}</span>
          <span className="text-[10px] text-stone-400">إجمالي الصفقات</span>
        </div>

        {/* Winning Trades */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-emerald-400 block uppercase">Winning Trades</span>
          <span className="text-lg font-black text-emerald-400 mt-0.5 block">{safeStats.wins}</span>
          <span className="text-[10px] text-stone-400">صفقات رابحة</span>
        </div>

        {/* Losing Trades */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-rose-400 block uppercase">Losing Trades</span>
          <span className="text-lg font-black text-rose-400 mt-0.5 block">{safeStats.losses}</span>
          <span className="text-[10px] text-stone-400">صفقات خاسرة</span>
        </div>

        {/* Win Rate */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-amber-400 block uppercase">Win Rate</span>
          <span className="text-lg font-black text-amber-400 mt-0.5 block">{safeStats.winRate.toFixed(1)}%</span>
          <span className="text-[10px] text-stone-400">نسبة الفوز</span>
        </div>

        {/* Net P/L */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-stone-400 block uppercase">Net P/L</span>
          <span
            className={`text-lg font-black mt-0.5 block ${
              safeStats.totalPl >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            ${safeStats.totalPl.toFixed(2)}
          </span>
          <span className="text-[10px] text-stone-400">صافي الربح</span>
        </div>

        {/* Profit */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-emerald-400 block uppercase">Gross Profit</span>
          <span className="text-lg font-black text-emerald-400 mt-0.5 block">
            ${(safeStats.averageWin * safeStats.wins).toFixed(2)}
          </span>
          <span className="text-[10px] text-stone-400">إجمالي الأرباح</span>
        </div>

        {/* Loss */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-rose-400 block uppercase">Gross Loss</span>
          <span className="text-lg font-black text-rose-400 mt-0.5 block">
            ${(safeStats.averageLoss * safeStats.losses).toFixed(2)}
          </span>
          <span className="text-[10px] text-stone-400">إجمالي الخسائر</span>
        </div>

        {/* Average Win */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-stone-400 block uppercase">Average Win</span>
          <span className="text-lg font-black text-emerald-400 mt-0.5 block">
            ${safeStats.averageWin.toFixed(2)}
          </span>
          <span className="text-[10px] text-stone-400">متوسط الربح</span>
        </div>

        {/* Average Loss */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-stone-400 block uppercase">Average Loss</span>
          <span className="text-lg font-black text-rose-400 mt-0.5 block">
            ${safeStats.averageLoss.toFixed(2)}
          </span>
          <span className="text-[10px] text-stone-400">متوسط الخسارة</span>
        </div>

        {/* Average RR */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-cyan-400 block uppercase">Average RR</span>
          <span className="text-lg font-black text-cyan-400 mt-0.5 block">1:{safeStats.averageRR.toFixed(2)}</span>
          <span className="text-[10px] text-stone-400">معدل العائد للمخاطرة</span>
        </div>

        {/* Largest Win */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-emerald-400 block uppercase">Largest Win</span>
          <span className="text-lg font-black text-emerald-400 mt-0.5 block">
            ${safeStats.largestWin.toFixed(2)}
          </span>
          <span className="text-[10px] text-stone-400">أكبر صفقة رابحة</span>
        </div>

        {/* Largest Loss */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-rose-400 block uppercase">Largest Loss</span>
          <span className="text-lg font-black text-rose-400 mt-0.5 block">
            ${safeStats.largestLoss.toFixed(2)}
          </span>
          <span className="text-[10px] text-stone-400">أكبر صفقة خاسرة</span>
        </div>

        {/* Current Streak */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-stone-400 block uppercase">Current Streak</span>
          <span className="text-lg font-black text-stone-100 mt-0.5 block">
            {safeStats.winningStreak > 0
              ? `${safeStats.winningStreak} W`
              : safeStats.losingStreak > 0
              ? `${safeStats.losingStreak} L`
              : '0'}
          </span>
          <span className="text-[10px] text-stone-400">تتابع الفوز/الخسارة</span>
        </div>

        {/* Max Drawdown */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-rose-400 block uppercase">Max Drawdown</span>
          <span className="text-lg font-black text-rose-400 mt-0.5 block">
            {safeStats.drawdownPercent.toFixed(1)}% (${safeStats.drawdown.toFixed(2)})
          </span>
          <span className="text-[10px] text-stone-400">أقصى تراجع</span>
        </div>

        {/* Total Risk */}
        <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-3">
          <span className="text-[10px] text-amber-400 block uppercase">Total Risk</span>
          <span className="text-lg font-black text-amber-300 mt-0.5 block">
            ${safeStats.totalRiskTaken.toFixed(2)}
          </span>
          <span className="text-[10px] text-stone-400">إجمالي المخاطر المحجوزة</span>
        </div>
      </div>

      {/* ================================================== */}
      {/* CHARTS: Equity Curve & P/L by Trade               */}
      {/* ================================================== */}
      <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5">
        <div className="flex items-center justify-between mb-4 border-b border-stone-800 pb-2">
          <div className="flex items-center gap-2">
            <LineChart className="w-4 h-4 text-emerald-400" />
            <h4 className="text-sm font-bold text-stone-100">
              منحنى نمو رأس المال (Equity Curve)
            </h4>
          </div>
          <span className="text-xs font-mono text-stone-400">
            رصيد البداية: ${safeStartingBalance.toFixed(2)}
          </span>
        </div>

        {!hasData ? (
          /* Empty state */
          <div className="h-44 flex flex-col items-center justify-center text-center p-6 bg-stone-950/60 rounded-xl border border-dashed border-stone-800">
            <BarChart3 className="w-8 h-8 text-stone-600 mb-2" />
            <h5 className="text-xs font-bold text-stone-300 font-mono">
              لا توجد بيانات صفقات مغلقة كافية لرسم المنحنى
            </h5>
            <p className="text-[11px] text-stone-400 max-w-sm mt-1">
              قم بتنفيذ وإغلاق صفقات تجريبية من شاشة "الصفقات" ليتم إنشاء منحنى الأرباح ونسب الفوز/الخسارة فوراً دون أي بيانات وهمية.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Real SVG Chart */}
            <div className="bg-stone-950/90 p-4 rounded-xl border border-stone-800/80">
              <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="w-full h-44 overflow-visible">
                {/* Horizontal guide lines */}
                <line
                  x1={padding}
                  y1={padding}
                  x2={svgWidth - padding}
                  y2={padding}
                  stroke="#292524"
                  strokeDasharray="4"
                />
                <line
                  x1={padding}
                  y1={svgHeight / 2}
                  x2={svgWidth - padding}
                  y2={svgHeight / 2}
                  stroke="#292524"
                  strokeDasharray="4"
                />
                <line
                  x1={padding}
                  y1={svgHeight - padding}
                  x2={svgWidth - padding}
                  y2={svgHeight - padding}
                  stroke="#292524"
                  strokeDasharray="4"
                />

                {/* Equity Polyline */}
                <polyline
                  fill="none"
                  stroke="#10b981"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points={pointsString}
                />

                {/* Data Points */}
                {equityPoints.map((p, i) => {
                  const cx = padding + (i / Math.max(1, equityPoints.length - 1)) * (svgWidth - padding * 2);
                  const cy =
                    svgHeight -
                    padding -
                    ((p.balance - minBal) / range) * (svgHeight - padding * 2);
                  return (
                    <circle
                      key={i}
                      cx={cx}
                      cy={cy}
                      r="4"
                      className="fill-emerald-400 stroke-stone-950 stroke-2"
                    />
                  );
                })}
              </svg>

              <div className="flex justify-between text-[10px] text-stone-400 font-mono mt-2 px-2">
                <span>البداية: ${safeStartingBalance.toFixed(2)}</span>
                <span>الحالي: ${(Number(runningBalance) || 0).toFixed(2)}</span>
              </div>
            </div>

            {/* P/L by Trade Bars */}
            <div>
              <span className="text-xs font-bold text-stone-300 block mb-2 font-mono">
                أرباح وخسائر الصفقات (P/L by Trade):
              </span>
              <div className="flex items-end gap-2 h-20 bg-stone-950/80 p-3 rounded-xl border border-stone-800">
                {chronoClosed.map((t, idx) => {
                  const isPos = (Number(t.pl) || 0) >= 0;
                  const maxPl = Math.max(...chronoClosed.map((c) => Math.abs(Number(c.pl) || 1)), 1);
                  const heightPercent = Math.min(100, Math.max(15, (Math.abs(Number(t.pl) || 0) / maxPl) * 100));

                  return (
                    <div
                      key={t.id || idx}
                      className="flex-1 flex flex-col items-center justify-end h-full group relative"
                    >
                      <div
                        style={{ height: `${heightPercent}%` }}
                        className={`w-full rounded-xs transition-all ${
                          isPos ? 'bg-emerald-500 hover:bg-emerald-400' : 'bg-rose-500 hover:bg-rose-400'
                        }`}
                      />
                      <span className="text-[9px] font-mono text-stone-400 mt-1">#{idx + 1}</span>

                      {/* Tooltip on hover */}
                      <div className="absolute -top-7 hidden group-hover:block bg-stone-900 border border-stone-700 text-stone-200 text-[10px] font-mono py-0.5 px-1.5 rounded whitespace-nowrap z-10">
                        {isPos ? `+$${(Number(t.pl) || 0).toFixed(2)}` : `-$${Math.abs(Number(t.pl) || 0).toFixed(2)}`}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
