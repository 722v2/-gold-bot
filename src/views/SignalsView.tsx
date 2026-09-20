import React, { useState, useEffect } from 'react';
import {
  Zap,
  CheckCircle2,
  XCircle,
  Clock,
  TrendingUp,
  TrendingDown,
  Info,
  ChevronDown,
  ChevronUp,
  Filter,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { TradeSignal, AccountExecutionMode } from '../types';

interface SignalsViewProps {
  currentSignal: TradeSignal | null;
  currentPrice: number;
  accountMode?: AccountExecutionMode;
  onExecuteDemo: (signal: TradeSignal) => void;
}

export const SignalsView: React.FC<SignalsViewProps> = ({
  currentSignal,
  currentPrice,
  accountMode = 'DEMO',
  onExecuteDemo,
}) => {
  const [signals, setSignals] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  // Fetch signals from persistent server storage (/api/scanner/signals)
  const fetchSignals = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/scanner/signals');
      if (res.ok) {
        const data = await res.json();
        let loaded = Array.isArray(data.signals) ? data.signals : [];

        // If currentSignal exists and is not already in list, prepend it
        if (currentSignal && currentSignal.signal !== 'NO TRADE') {
          const exists = loaded.some((s: any) => s.id === currentSignal.id || Math.abs(s.entry - currentSignal.entry) < 0.05);
          if (!exists) {
            loaded = [
              {
                ...currentSignal,
                status: 'NEW',
                isoTime: new Date(currentSignal.timestamp).toISOString(),
              },
              ...loaded,
            ];
          }
        }
        setSignals(loaded);
      }
    } catch (e) {
      console.warn('Failed to fetch signals:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSignals();
  }, [currentSignal]);

  // Determine dynamic status based on current price if active
  const computeSignalStatus = (s: any): string => {
    if (s.status && s.status !== 'NEW' && s.status !== 'ACTIVE') return s.status;

    const isBuy = s.signal?.includes('BUY') || s.direction?.includes('BUY');
    const entry = s.entry;
    const sl = s.stopLoss || s.sl;
    const tp1 = s.tp1;
    const tp2 = s.tp2;

    const hasTp2 = Boolean(tp2 && Number(tp2) > 0);
    const hasTp1 = Boolean(tp1 && Number(tp1) > 0);
    const hasSl = Boolean(sl && Number(sl) > 0);

    if (isBuy) {
      if (hasTp2 && currentPrice >= Number(tp2)) return 'TP2 HIT';
      if (hasTp1 && currentPrice >= Number(tp1)) return 'TP1 HIT';
      if (hasSl && currentPrice <= Number(sl)) return 'SL HIT';
    } else {
      if (hasTp2 && currentPrice <= Number(tp2)) return 'TP2 HIT';
      if (hasTp1 && currentPrice <= Number(tp1)) return 'TP1 HIT';
      if (hasSl && currentPrice >= Number(sl)) return 'SL HIT';
    }

    return s.status || 'ACTIVE';
  };

  const filteredSignals = signals.filter((s) => {
    if (statusFilter === 'ALL') return true;
    const status = computeSignalStatus(s);
    return status === statusFilter;
  });

  return (
    <div className="space-y-4 sm:space-y-6 animate-in fade-in duration-250">
      {/* Top Header & Filter Controls */}
      <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3 shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-400" />
            <h3 className="text-base font-black text-stone-100 font-mono">
              سجل إشارات التداول (Signal History)
            </h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-stone-800 text-stone-300 font-mono font-bold">
              {filteredSignals.length} إشارة
            </span>
          </div>
          <p className="text-xs text-stone-400 mt-0.5">
            جميع الإشارات المكتشفة بواسطة ماسح الذهب مع تفاصيل الدخول والأهداف ونسبة الوقف
          </p>
        </div>

        {/* Filter Badges */}
        <div className="flex flex-wrap items-center gap-1.5 text-xs font-mono">
          {['ALL', 'NEW', 'ACTIVE', 'TP1 HIT', 'TP2 HIT', 'SL HIT'].map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`px-2.5 py-1 rounded-lg transition-all text-[11px] font-bold ${
                statusFilter === f
                  ? 'bg-amber-500 text-stone-950 shadow-xs'
                  : 'bg-stone-950/80 text-stone-400 hover:text-stone-200 border border-stone-800'
              }`}
            >
              {f}
            </button>
          ))}

          <button
            onClick={fetchSignals}
            className="p-1.5 rounded-lg bg-stone-950 border border-stone-800 text-stone-400 hover:text-stone-200"
            title="تحديث الإشارات"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Signals List / Cards */}
      {filteredSignals.length === 0 ? (
        <div className="bg-stone-900/60 border border-dashed border-stone-800 rounded-2xl p-8 text-center space-y-2">
          <Zap className="w-8 h-8 text-stone-600 mx-auto" />
          <h4 className="text-sm font-bold text-stone-300 font-mono">لا توجد إشارات مطابقة للفلتر</h4>
          <p className="text-xs text-stone-400 max-w-sm mx-auto">
            النظام ينتظر استيفاء شروط نسبة العائد ونماذج السيولة بدقة دون تداول عشوائي.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredSignals.map((item, idx) => {
            const isExpanded = selectedSignalId === (item.id || String(idx));
            const status = computeSignalStatus(item);
            const isBuy = (item.signal || item.direction || '').includes('BUY');

            return (
              <div
                key={item.id || idx}
                className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 transition-all hover:border-stone-700/80"
              >
                {/* Header Row */}
                <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-stone-800/80">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center font-black ${
                        isBuy
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                      }`}
                    >
                      {isBuy ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-black font-mono text-stone-100">
                          {item.asset || 'XAU/USD'}
                        </span>
                        <span
                          className={`text-xs font-black font-mono px-2 py-0.5 rounded ${
                            isBuy ? 'bg-emerald-950 text-emerald-300' : 'bg-rose-950 text-rose-300'
                          }`}
                        >
                          {item.signal || item.direction}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-stone-800 text-stone-300 font-mono">
                          {item.setup || 'Price Action Setup'}
                        </span>
                      </div>
                      <span className="text-[11px] text-stone-400 font-mono block mt-0.5">
                        {item.isoTime
                          ? new Date(item.isoTime).toLocaleString('ar-EG', {
                              month: 'numeric',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : item.date || 'اليوم'}
                      </span>
                    </div>
                  </div>

                  {/* Status Badge */}
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[10px] font-mono font-black px-2.5 py-1 rounded-lg border ${
                        status === 'TP2 HIT' || status === 'TP1 HIT'
                          ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                          : status === 'SL HIT'
                          ? 'bg-rose-950 text-rose-300 border-rose-800'
                          : status === 'ACTIVE'
                          ? 'bg-amber-950 text-amber-300 border-amber-800 animate-pulse'
                          : 'bg-stone-800 text-stone-300 border-stone-700'
                      }`}
                    >
                      {status}
                    </span>

                    <span className="text-xs font-mono font-bold text-amber-400">
                      {item.confidence || 80}% ثقة
                    </span>
                  </div>
                </div>

                {/* Metrics Table / Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 pt-3 font-mono text-xs">
                  <div className="bg-stone-950/70 p-2 rounded-lg border border-stone-800/80">
                    <span className="text-[10px] text-stone-400 block">Entry</span>
                    <span className="font-bold text-stone-100">${(item.entry || 0).toFixed(2)}</span>
                  </div>

                  <div className="bg-stone-950/70 p-2 rounded-lg border border-rose-950/50">
                    <span className="text-[10px] text-rose-400 block">Stop Loss</span>
                    <span className="font-bold text-rose-400">${(item.stopLoss || item.sl || 0).toFixed(2)}</span>
                  </div>

                  <div className="bg-stone-950/70 p-2 rounded-lg border border-emerald-950/50">
                    <span className="text-[10px] text-emerald-400 block">TP1</span>
                    <span className="font-bold text-emerald-400">${(item.tp1 || 0).toFixed(2)}</span>
                  </div>

                  <div className="bg-stone-950/70 p-2 rounded-lg border border-emerald-950/50">
                    <span className="text-[10px] text-emerald-300 block">TP2</span>
                    <span className="font-bold text-emerald-300">{item.tp2 && Number(item.tp2) > 0 ? `$${Number(item.tp2).toFixed(2)}` : 'N/A'}</span>
                  </div>

                  <div className="bg-stone-950/70 p-2 rounded-lg border border-stone-800/80">
                    <span className="text-[10px] text-stone-400 block">Risk / Lot</span>
                    <span className="font-bold text-amber-300">
                      {item.riskPercent || 15}% • {item.recommendedLotSize || 0.01} Lot
                    </span>
                  </div>

                  <div className="bg-stone-950/70 p-2 rounded-lg border border-stone-800/80">
                    <span className="text-[10px] text-stone-400 block">RR Ratio</span>
                    <span className="font-bold text-stone-200">
                      {item.tp1RrString || (item.tp1Rr ? `1:${Number(item.tp1Rr).toFixed(2)}` : 'N/A')}
                    </span>
                  </div>
                </div>

                {/* Footer Controls: Expand Analysis & Demo Execution */}
                <div className="mt-3 pt-2 border-t border-stone-800/60 flex items-center justify-between">
                  <button
                    onClick={() =>
                      setSelectedSignalId(isExpanded ? null : item.id || String(idx))
                    }
                    className="flex items-center gap-1 text-xs text-stone-400 hover:text-stone-200 font-bold"
                  >
                    <span>{isExpanded ? 'إغلاق التحليل' : 'عرض تفاصيل التحليل'}</span>
                    {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>

                  <button
                    onClick={() => onExecuteDemo(item)}
                    className={`text-xs px-3 py-1 rounded-lg font-bold transition-all ${
                      accountMode === 'REAL'
                        ? 'bg-rose-950 hover:bg-rose-900 border border-rose-700 text-rose-300'
                        : 'bg-cyan-950 hover:bg-cyan-900 border border-cyan-800 text-cyan-300'
                    }`}
                  >
                    {accountMode === 'REAL' ? 'تنفيذ حقيقي (REAL)' : 'تنفيذ تجريبي (Demo)'}
                  </button>
                </div>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="mt-3 pt-3 border-t border-stone-800 text-xs text-stone-300 space-y-2 animate-in fade-in duration-150">
                    {item.mainReasons && item.mainReasons.length > 0 && (
                      <div className="bg-stone-950 p-2.5 rounded-lg border border-stone-800 space-y-1">
                        <span className="text-[11px] text-amber-400 font-bold block">
                          الأسباب الفنية المعتمدة:
                        </span>
                        <ul className="list-disc list-inside space-y-0.5 text-stone-400">
                          {item.mainReasons.map((r: string, rIdx: number) => (
                            <li key={rIdx}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {item.invalidation && (
                      <div className="bg-stone-950 p-2.5 rounded-lg border border-stone-800">
                        <span className="text-[11px] text-rose-400 font-bold block">
                          شرط الإلغاء الفني (Invalidation):
                        </span>
                        <p className="text-stone-400 mt-0.5">{item.invalidation}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
