import { Shield, Sparkles, Sliders, BarChart3, Radio } from 'lucide-react';
import { AssetType } from '../types';

interface HeaderBarProps {
  asset: AssetType;
  onSelectAsset: (asset: AssetType) => void;
  onOpenStats: () => void;
  onOpenSettings: () => void;
  scannerActive: boolean;
  isLiveConnected: boolean;
}

export const HeaderBar = ({
  asset,
  onSelectAsset,
  onOpenStats,
  onOpenSettings,
  scannerActive,
  isLiveConnected,
}: HeaderBarProps) => {
  return (
    <header className="sticky top-0 z-30 bg-stone-950/90 backdrop-blur-md border-b border-stone-800/80 px-4 py-3">
      <div className="max-w-4xl mx-auto flex items-center justify-between gap-2">
        {/* Branding */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/40 flex items-center justify-center text-amber-400 shrink-0 shadow-sm shadow-amber-500/10">
            <Shield className="w-5 h-5" />
          </div>
          <div className="truncate">
            <div className="flex items-center gap-1.5">
              <h1 className="text-sm font-semibold tracking-tight text-stone-100 truncate">
                Gold AI Challenge
              </h1>
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                10$ Micro
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-stone-400">
              <span className="inline-flex items-center gap-1">
                <span className={`w-1.5 h-1.5 rounded-full ${isLiveConnected ? 'bg-emerald-400 animate-pulse' : 'bg-stone-500'}`} />
                {isLiveConnected ? 'Market Live' : 'Connecting'}
              </span>
              {scannerActive && (
                <span className="inline-flex items-center gap-0.5 text-amber-400 font-medium">
                  • <Radio className="w-2.5 h-2.5 animate-spin" /> Scanner ON
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right actions: Asset Switcher & Modals */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Asset toggle pill */}
          <div className="flex items-center bg-stone-900 p-0.5 rounded-lg border border-stone-800 text-xs font-medium">
            <button
              id="asset-btn-xau"
              onClick={() => onSelectAsset('XAU/USD')}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                asset === 'XAU/USD'
                  ? 'bg-amber-500 text-stone-950 font-semibold shadow-xs'
                  : 'text-stone-400 hover:text-stone-200'
              }`}
            >
              XAU/USD
            </button>
            <button
              id="asset-btn-btc"
              onClick={() => onSelectAsset('BTC/USD')}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                asset === 'BTC/USD'
                  ? 'bg-amber-500 text-stone-950 font-semibold shadow-xs'
                  : 'text-stone-400 hover:text-stone-200'
              }`}
            >
              BTC/USD
            </button>
          </div>

          <button
            id="open-stats-btn"
            onClick={onOpenStats}
            title="إحصائيات الحساب"
            className="p-2 rounded-lg bg-stone-900 border border-stone-800 text-stone-300 hover:text-amber-400 hover:border-amber-500/40 transition-colors"
          >
            <BarChart3 className="w-4 h-4" />
          </button>

          <button
            id="open-settings-btn"
            onClick={onOpenSettings}
            title="الإعدادات وإدارة الرصيد"
            className="p-2 rounded-lg bg-stone-900 border border-stone-800 text-stone-300 hover:text-amber-400 hover:border-amber-500/40 transition-colors"
          >
            <Sliders className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
};
