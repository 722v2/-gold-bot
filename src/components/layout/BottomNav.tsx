import React from 'react';
import { LayoutDashboard, Radio, Zap, History, TrendingUp, MoreHorizontal } from 'lucide-react';
import { NavigationTab } from '../../types';

interface BottomNavProps {
  activeTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
  onOpenMore?: () => void;
  onOpenMoreDrawer?: () => void;
  scannerOnline?: boolean;
  signalsCount?: number;
  openTradesCount?: number;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  onSelectTab,
  onOpenMore,
  onOpenMoreDrawer,
  scannerOnline = false,
  signalsCount = 0,
  openTradesCount = 0,
}) => {
  const handleOpenMore = onOpenMore || onOpenMoreDrawer || (() => {});
  const isMoreActive = ['risk', 'analytics', 'telegram', 'health', 'settings'].includes(activeTab);

  return (
    <div className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-stone-950/95 backdrop-blur-md border-t border-stone-800/90 px-1.5 py-1.5 safe-area-pb">
      <div className="flex items-center justify-around gap-0.5">
        {/* 1. Dashboard */}
        <button
          onClick={() => onSelectTab('dashboard')}
          className={`flex flex-col items-center justify-center flex-1 py-1 px-0.5 rounded-xl transition-all ${
            activeTab === 'dashboard'
              ? 'text-amber-400 font-bold'
              : 'text-stone-400 hover:text-stone-200'
          }`}
        >
          <LayoutDashboard className="w-4 h-4 sm:w-5 sm:h-5 mb-0.5" />
          <span className="text-[9px] sm:text-[10px] tracking-tight">الرئيسية</span>
        </button>

        {/* 2. Scanner */}
        <button
          onClick={() => onSelectTab('scanner')}
          className={`relative flex flex-col items-center justify-center flex-1 py-1 px-0.5 rounded-xl transition-all ${
            activeTab === 'scanner'
              ? 'text-amber-400 font-bold'
              : 'text-stone-400 hover:text-stone-200'
          }`}
        >
          <div className="relative">
            <Radio className="w-4 h-4 sm:w-5 sm:h-5 mb-0.5" />
            {scannerOnline && (
              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400 ring-2 ring-stone-950 animate-pulse" />
            )}
          </div>
          <span className="text-[9px] sm:text-[10px] tracking-tight">الماسح</span>
        </button>

        {/* 3. Signals */}
        <button
          onClick={() => onSelectTab('signals')}
          className={`relative flex flex-col items-center justify-center flex-1 py-1 px-0.5 rounded-xl transition-all ${
            activeTab === 'signals'
              ? 'text-amber-400 font-bold'
              : 'text-stone-400 hover:text-stone-200'
          }`}
        >
          <div className="relative">
            <Zap className="w-4 h-4 sm:w-5 sm:h-5 mb-0.5" />
            {signalsCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-amber-500 text-stone-950 text-[8px] font-mono font-black px-1 rounded-full">
                {signalsCount}
              </span>
            )}
          </div>
          <span className="text-[9px] sm:text-[10px] tracking-tight">الإشارات</span>
        </button>

        {/* 4. Backtest - Dedicated Mobile Tab */}
        <button
          onClick={() => onSelectTab('backtest')}
          className={`relative flex flex-col items-center justify-center flex-1 py-1 px-0.5 rounded-xl transition-all ${
            activeTab === 'backtest'
              ? 'text-purple-300 font-bold bg-purple-950/40 rounded-lg border border-purple-800/60'
              : 'text-stone-400 hover:text-stone-200'
          }`}
        >
          <div className="relative">
            <History className="w-4 h-4 sm:w-5 sm:h-5 mb-0.5 text-purple-400" />
          </div>
          <span className="text-[9px] sm:text-[10px] tracking-tight text-purple-200 font-medium">الاختبار</span>
        </button>

        {/* 5. Trades */}
        <button
          onClick={() => onSelectTab('trades')}
          className={`relative flex flex-col items-center justify-center flex-1 py-1 px-0.5 rounded-xl transition-all ${
            activeTab === 'trades'
              ? 'text-amber-400 font-bold'
              : 'text-stone-400 hover:text-stone-200'
          }`}
        >
          <div className="relative">
            <TrendingUp className="w-4 h-4 sm:w-5 sm:h-5 mb-0.5" />
            {openTradesCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-cyan-500 text-stone-950 text-[8px] font-mono font-black px-1 rounded-full">
                {openTradesCount}
              </span>
            )}
          </div>
          <span className="text-[9px] sm:text-[10px] tracking-tight">الصفقات</span>
        </button>

        {/* 6. More */}
        <button
          onClick={handleOpenMore}
          className={`flex flex-col items-center justify-center flex-1 py-1 px-0.5 rounded-xl transition-all ${
            isMoreActive
              ? 'text-amber-400 font-bold'
              : 'text-stone-400 hover:text-stone-200'
          }`}
        >
          <MoreHorizontal className="w-4 h-4 sm:w-5 sm:h-5 mb-0.5" />
          <span className="text-[9px] sm:text-[10px] tracking-tight">المزيد</span>
        </button>
      </div>
    </div>
  );
};
