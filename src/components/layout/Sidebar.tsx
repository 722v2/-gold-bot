import React from 'react';
import {
  LayoutDashboard,
  Radio,
  Zap,
  TrendingUp,
  History,
  ShieldCheck,
  BarChart3,
  Send,
  Settings,
  Activity,
  ChevronRight,
  Server,
} from 'lucide-react';
import { NavigationTab } from '../../types';

interface SidebarProps {
  activeTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
  scannerOnline: boolean;
  marketOnline: boolean;
  signalsCount?: number;
  openTradesCount?: number;
}

interface NavItem {
  id: NavigationTab;
  label: string;
  sublabel: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string | number;
  badgeColor?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onSelectTab,
  scannerOnline,
  marketOnline,
  signalsCount = 0,
  openTradesCount = 0,
}) => {
  const navItems: NavItem[] = [
    {
      id: 'dashboard',
      label: 'لوحة التحكم',
      sublabel: 'Executive Overview',
      icon: LayoutDashboard,
    },
    {
      id: 'scanner',
      label: 'الماسح المباشر',
      sublabel: 'Live 60s Scanner',
      icon: Radio,
      badge: scannerOnline ? 'ONLINE' : 'OFFLINE',
      badgeColor: scannerOnline
        ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
        : 'bg-stone-800 text-stone-400 border-stone-700',
    },
    {
      id: 'signals',
      label: 'سجل الإشارات',
      sublabel: 'Signal History',
      icon: Zap,
      badge: signalsCount > 0 ? signalsCount : undefined,
      badgeColor: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    },
    {
      id: 'trades',
      label: 'الصفقات والتنفيذ',
      sublabel: 'Demo Trading',
      icon: TrendingUp,
      badge: openTradesCount > 0 ? `${openTradesCount} مفتوحة` : undefined,
      badgeColor: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
    },
    {
      id: 'backtest',
      label: 'الاختبار التاريخي',
      sublabel: 'Backtest Engine',
      icon: History,
      badge: 'PRO',
      badgeColor: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
    },
    {
      id: 'risk',
      label: 'إدارة المخاطر',
      sublabel: 'Risk Engine (15%)',
      icon: ShieldCheck,
      badge: '15%',
      badgeColor: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    },
    {
      id: 'analytics',
      label: 'الإحصائيات والتحليل',
      sublabel: 'Performance & Curve',
      icon: BarChart3,
    },
    {
      id: 'telegram',
      label: 'تنبيهات تلغرام',
      sublabel: 'Telegram Bot',
      icon: Send,
    },
    {
      id: 'health',
      label: 'حالة النظام',
      sublabel: 'System Health',
      icon: Activity,
    },
    {
      id: 'settings',
      label: 'الإعدادات',
      sublabel: 'System Settings',
      icon: Settings,
    },
  ];

  return (
    <aside className="hidden lg:flex flex-col w-64 xl:w-72 bg-stone-950 border-l border-stone-800/80 select-none shrink-0 h-screen sticky top-0 overflow-y-auto">
      {/* Brand Header */}
      <div className="p-4 border-b border-stone-800/80">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500/20 via-amber-500/10 to-transparent border border-amber-500/30 flex items-center justify-center text-amber-400 shadow-inner">
            <Radio className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-black tracking-wide text-stone-100 uppercase">
                AI Trading Terminal
              </h1>
              <span className="text-[9px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono font-bold">
                XAU/USD
              </span>
            </div>
            <p className="text-[11px] text-stone-400 font-mono flex items-center gap-1.5 mt-0.5">
              <span>Biquote MT5 Engine</span>
              <span className="text-stone-600">•</span>
              <span className="text-emerald-400">v2.4 Live</span>
            </p>
          </div>
        </div>

        {/* Execution Mode Banner (Requirement 5) */}
        <div className="mt-3 bg-stone-900/90 border border-cyan-500/30 rounded-lg p-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping shrink-0" />
            <span className="text-[11px] font-bold text-cyan-300">DEMO TRADING</span>
          </div>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800/80 font-mono font-bold">
            DEMO ONLY
          </span>
        </div>
      </div>

      {/* Navigation List */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;

          return (
            <button
              key={item.id}
              onClick={() => onSelectTab(item.id)}
              className={`w-full flex items-center justify-between p-2.5 rounded-xl transition-all text-right group ${
                isActive
                  ? 'bg-amber-500/15 text-stone-100 border border-amber-500/30 shadow-xs'
                  : 'text-stone-400 hover:text-stone-200 hover:bg-stone-900/60 border border-transparent'
              }`}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                    isActive
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'bg-stone-900 text-stone-400 group-hover:text-stone-200'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </div>
                <div>
                  <span className="text-xs font-bold block">{item.label}</span>
                  <span className="text-[10px] text-stone-400 block font-mono">
                    {item.sublabel}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {item.badge !== undefined && (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded-md font-mono font-bold border ${
                      item.badgeColor || 'bg-stone-800 text-stone-300 border-stone-700'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
                <ChevronRight
                  className={`w-3.5 h-3.5 transition-transform ${
                    isActive ? 'text-amber-400 rotate-180' : 'text-stone-600 group-hover:text-stone-400 rotate-180'
                  }`}
                />
              </div>
            </button>
          );
        })}
      </nav>

      {/* Bottom Telemetry Mini Box */}
      <div className="p-3 border-t border-stone-800/80 bg-stone-950/80">
        <div className="bg-stone-900/60 border border-stone-800/80 rounded-xl p-2.5 space-y-2 text-[11px] font-mono">
          <div className="flex items-center justify-between text-stone-400">
            <span className="flex items-center gap-1.5">
              <Server className="w-3 h-3 text-emerald-400" />
              <span>Background Daemon:</span>
            </span>
            <span className={scannerOnline ? 'text-emerald-400 font-bold' : 'text-stone-400 font-bold'}>
              {scannerOnline ? 'RUNNING (60s)' : 'PAUSED'}
            </span>
          </div>

          <div className="flex items-center justify-between text-stone-400">
            <span>Market Data:</span>
            <span className={marketOnline ? 'text-emerald-400 font-bold' : 'text-amber-400'}>
              {marketOnline ? 'Biquote MT5' : 'Connecting'}
            </span>
          </div>

          <div className="pt-1.5 border-t border-stone-800/60 flex items-center justify-between text-[10px] text-stone-400">
            <span>Risk Guard:</span>
            <span className="text-amber-300 font-bold">15% Max / SL ≤100p</span>
          </div>
        </div>
      </div>
    </aside>
  );
};
