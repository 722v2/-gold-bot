import { ArrowDown, ArrowUp, RefreshCw, Sparkles, Activity, Layers } from 'lucide-react';
import { AssetType } from '../types';

interface PriceActionCardProps {
  asset: AssetType;
  price: number;
  prevPrice?: number;
  bid?: number;
  ask?: number;
  spread?: number;
  high?: number;
  low?: number;
  provider?: string;
  atr?: number;
  structure?: string;
  marketRegime?: string;
  isOverextended?: boolean;
  lastBar?: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
    timestamp: number;
  };
  lastUpdated?: number;
  isConnected?: boolean;
  isAnalyzing: boolean;
  onAnalyze: () => void;
  onRefreshPrice: () => void;
}

export const PriceActionCard = ({
  asset,
  price,
  prevPrice,
  bid,
  ask,
  spread,
  high,
  low,
  provider = 'Biquote',
  atr = 2.4,
  structure = 'BULLISH',
  marketRegime,
  isOverextended,
  lastBar,
  lastUpdated,
  isConnected = true,
  isAnalyzing,
  onAnalyze,
  onRefreshPrice,
}: PriceActionCardProps) => {
  const isUp = prevPrice !== undefined ? price >= prevPrice : true;

  return (
    <section className="bg-stone-900/90 border border-stone-800 rounded-2xl p-4 shadow-sm relative overflow-hidden">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold px-2.5 py-1 rounded-md bg-stone-800 text-stone-200 border border-stone-700/60 font-mono">
            {asset}
          </span>
          <span className="text-[11px] text-stone-400">
            {asset === 'XAU/USD' ? 'Gold Spot / USD' : 'Bitcoin / USD'}
          </span>
          <span
            className={`text-[10px] font-medium px-2 py-0.5 rounded-full border flex items-center gap-1.5 ${
              isConnected
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
            {provider} {isConnected ? 'متصل ومباشر' : 'غير متصل'}
          </span>
          {lastUpdated && (
            <span className="text-[10px] text-stone-400 font-mono">
              آخر تحديث: {new Date(lastUpdated).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={onRefreshPrice}
            disabled={isAnalyzing}
            title="تحديث السعر الفوري"
            className="p-1.5 rounded-lg text-stone-400 hover:text-stone-200 hover:bg-stone-800 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isAnalyzing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Big Live Price Display & Market Metrics */}
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <span className="text-[11px] text-stone-400 block mb-0.5">
            Current Price (السعر المباشر)
          </span>
          <div className="flex items-center gap-2">
            <span className="text-3xl sm:text-4xl font-black font-mono tracking-tight text-stone-50">
              ${price > 0 ? price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '...'}
            </span>
            <span
              className={`inline-flex items-center text-xs font-medium px-1.5 py-0.5 rounded ${
                isUp
                  ? 'text-emerald-400 bg-emerald-500/10'
                  : 'text-rose-400 bg-rose-500/10'
              }`}
            >
              {isUp ? <ArrowUp className="w-3 h-3 mr-0.5" /> : <ArrowDown className="w-3 h-3 mr-0.5" />}
              {asset === 'XAU/USD' ? '0.10 pt/tick' : 'Live'}
            </span>
          </div>
          {/* Bid / Ask / Spread mini bar */}
          {bid !== undefined && ask !== undefined && (
            <div className="flex items-center gap-2.5 mt-1.5 text-[11px] font-mono text-stone-400">
              <span>Bid: <strong className="text-stone-300 font-normal">{bid.toFixed(2)}</strong></span>
              <span>•</span>
              <span>Ask: <strong className="text-stone-300 font-normal">{ask.toFixed(2)}</strong></span>
              {spread !== undefined && (
                <>
                  <span>•</span>
                  <span>Spread: <strong className="text-amber-400/90 font-normal">{spread.toFixed(2)}</strong></span>
                </>
              )}
            </div>
          )}
        </div>

        <div className="text-right flex flex-col items-end gap-1">
          <div className="flex items-center gap-1.5">
            {marketRegime && (
              <span
                className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                  marketRegime.includes('UPTREND')
                    ? 'bg-emerald-950/60 text-emerald-300 border-emerald-700/60'
                    : marketRegime.includes('DOWNTREND')
                    ? 'bg-rose-950/60 text-rose-300 border-rose-700/60'
                    : marketRegime.includes('RANGE')
                    ? 'bg-amber-950/60 text-amber-300 border-amber-700/60'
                    : 'bg-stone-800 text-stone-300 border-stone-700'
                }`}
              >
                {marketRegime}
              </span>
            )}
            <span
              className={`text-xs font-semibold px-2 py-0.5 rounded-md border ${
                structure === 'BULLISH'
                  ? 'bg-emerald-950/40 text-emerald-400 border-emerald-800/50'
                  : structure === 'BEARISH'
                  ? 'bg-rose-950/40 text-rose-400 border-rose-800/50'
                  : 'bg-stone-800 text-stone-300 border-stone-700'
              }`}
            >
              {structure}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {isOverextended && (
              <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                ممتد (Pullback Wait)
              </span>
            )}
            <span className="text-[10px] text-stone-400 font-mono">
              ATR(14): ${atr.toFixed(2)}
            </span>
          </div>

          {high !== undefined && low !== undefined && (
            <span className="text-[9px] text-stone-500 font-mono">
              H: {high.toFixed(1)} / L: {low.toFixed(1)}
            </span>
          )}
        </div>
      </div>

      {/* Last Candle Summary Box */}
      {lastBar && (
        <div className="mb-3.5 bg-stone-950/60 border border-stone-800/80 rounded-xl p-2.5 flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-stone-400 uppercase font-sans">آخر شمعة (Last Bar):</span>
            <span className="text-stone-300">O: <strong className="font-normal text-stone-200">{lastBar.open.toFixed(2)}</strong></span>
            <span className="text-stone-300">H: <strong className="font-normal text-emerald-400">{lastBar.high.toFixed(2)}</strong></span>
            <span className="text-stone-300">L: <strong className="font-normal text-rose-400">{lastBar.low.toFixed(2)}</strong></span>
            <span className="text-stone-300">C: <strong className="font-normal text-amber-400">{lastBar.close.toFixed(2)}</strong></span>
          </div>
          {lastBar.volume !== undefined && (
            <span className="text-[10px] text-stone-400">
              Vol: {lastBar.volume}
            </span>
          )}
        </div>
      )}

      {/* Main [ ANALYZE GOLD ] CTA Button */}
      <button
        id="analyze-gold-cta"
        onClick={onAnalyze}
        disabled={isAnalyzing || price <= 0}
        className={`w-full relative group overflow-hidden py-3.5 px-4 rounded-xl font-bold text-sm sm:text-base transition-all duration-200 flex items-center justify-center gap-2.5 shadow-lg ${
          isAnalyzing
            ? 'bg-stone-800 text-stone-400 cursor-not-allowed border border-stone-700'
            : 'bg-gradient-to-r from-amber-500 via-amber-400 to-amber-500 hover:from-amber-400 hover:to-amber-300 text-stone-950 shadow-amber-500/20 active:scale-[0.99] cursor-pointer'
        }`}
      >
        {isAnalyzing ? (
          <>
            <RefreshCw className="w-4 h-4 animate-spin text-amber-400" />
            <span>جارٍ التحليل العميق لبيانات السوق (1H / 15M / 5M)...</span>
          </>
        ) : (
          <>
            <Sparkles className="w-4 h-4 text-stone-950 fill-stone-950/30" />
            <span className="tracking-wide">
              {asset === 'XAU/USD' ? 'ANALYZE GOLD (فحص وتحليل الذهب)' : 'ANALYZE BITCOIN'}
            </span>
          </>
        )}
      </button>

      <div className="mt-2.5 flex items-center justify-between text-[10px] text-stone-400 px-1">
        <span className="flex items-center gap-1">
          <Layers className="w-3 h-3 text-stone-400" />
          Timeframes: 1H (Bias) • 15M (Zone) • 5M (Entry)
        </span>
        <span>Selective Scalping Engine</span>
      </div>
    </section>
  );
};
