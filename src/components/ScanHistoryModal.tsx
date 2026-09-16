import { useState, useEffect } from 'react';
import { X, RefreshCw, Database, Clock, ShieldAlert, CheckCircle2, AlertTriangle } from 'lucide-react';
import { SignalDecision } from '../types';

interface StoredScan {
  id: string;
  timestamp: number;
  isoTime: string;
  currentPrice: number;
  signal: SignalDecision;
  entry: number;
  stopLoss: number;
  slPoints: number;
  tp1: number;
  tp1Points: number;
  tp1Rr: string;
  tp2: number;
  tp2Points: number;
  tp2Rr: string;
  rr: string;
  confidence: number;
  riskPercent: number;
  riskAmount: number;
  lotSize: number;
  setup: string;
  reasons: string[];
  status: string;
  invalidation?: string;
  noTradeReason?: string;
}

interface ScanHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ScanHistoryModal = ({ isOpen, onClose }: ScanHistoryModalProps) => {
  const [scans, setScans] = useState<StoredScan[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchHistory = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/scanner/history?limit=40');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.scans)) {
          setScans(data.scans);
        }
      }
    } catch (e) {
      console.error('Failed to fetch scan history:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchHistory();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const getDecisionBadge = (signal: SignalDecision) => {
    switch (signal) {
      case 'BUY NOW':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">BUY NOW</span>;
      case 'SELL NOW':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30">SELL NOW</span>;
      case 'BUY LIMIT':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">BUY LIMIT</span>;
      case 'SELL LIMIT':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">SELL LIMIT</span>;
      case 'NO TRADE':
      default:
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-stone-800 text-stone-400 border border-stone-700">NO TRADE</span>;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-xs">
      <div className="bg-stone-900 border border-stone-800 rounded-2xl w-full max-w-3xl max-h-[88vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
              <Database className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-stone-100 flex items-center gap-2">
                <span>سجل الفحوصات المحفوظة في السيرفر</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  Persistent Storage
                </span>
              </h2>
              <p className="text-[11px] text-stone-400">
                تسجيل مستمر لجميع فحوصات XAU/USD وقرارات الـ AI ومقاييس المخاطرة حتى عند إغلاق المتصفح
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={fetchHistory}
              disabled={isLoading}
              className="p-1.5 rounded-lg text-stone-400 hover:text-stone-200 hover:bg-stone-800 transition-colors"
              title="تحديث السجل"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-amber-400' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-stone-400 hover:text-stone-200 hover:bg-stone-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content list */}
        <div className="p-4 overflow-y-auto space-y-2.5 flex-1 divide-y divide-stone-800/40">
          {scans.length === 0 ? (
            <div className="text-center py-12 text-stone-500 text-xs">
              {isLoading ? 'جارٍ تحميل السجل من التخزين الدائم...' : 'لا توجد فحوصات مسجلة حتى الآن.'}
            </div>
          ) : (
            scans.map((scan, idx) => (
              <div key={`${scan.id || 'scan'}_${scan.timestamp || idx}`} className="pt-2.5 first:pt-0 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-stone-400 font-mono text-[11px]">
                      {new Date(scan.timestamp).toLocaleTimeString()}
                    </span>
                    {getDecisionBadge(scan.signal)}
                    <span className="font-mono text-stone-300 font-bold">
                      ${(Number(scan.currentPrice) || 0).toFixed(2)}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono text-stone-400">
                      ثقة: {scan.confidence}%
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-stone-800 text-stone-300 border border-stone-700">
                      {scan.status}
                    </span>
                  </div>
                </div>

                {/* Trade details if qualified signal */}
                {scan.signal !== 'NO TRADE' && (
                  <div className="bg-stone-950/70 border border-stone-800/80 rounded-lg p-2.5 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono">
                    <div>
                      <span className="text-stone-500 block text-[10px]">Entry</span>
                      <span className="text-stone-200 font-bold">${(Number(scan.entry) || 0).toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-stone-500 block text-[10px]">Stop Loss ({scan.slPoints} pts)</span>
                      <span className="text-rose-400 font-bold">${(Number(scan.stopLoss) || 0).toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-stone-500 block text-[10px]">TP1 ({scan.tp1Rr})</span>
                      <span className="text-emerald-400 font-bold">${(Number(scan.tp1) || 0).toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-stone-500 block text-[10px]">TP2 ({scan.tp2Rr})</span>
                      <span className="text-emerald-400 font-bold">${(Number(scan.tp2) || 0).toFixed(2)}</span>
                    </div>
                    <div className="col-span-2">
                      <span className="text-stone-500 block text-[10px]">المخاطرة والعقد</span>
                      <span className="text-amber-400 font-bold">{scan.riskPercent}% (${(Number(scan.riskAmount) || 0).toFixed(2)}) • {scan.lotSize} Std Lot</span>
                    </div>
                    <div className="col-span-2">
                      <span className="text-stone-500 block text-[10px]">النموذج (Setup)</span>
                      <span className="text-stone-300 truncate block">{scan.setup}</span>
                    </div>
                  </div>
                )}

                {/* Reasons or No-Trade reason */}
                {scan.reasons && scan.reasons.length > 0 && (
                  <div className="text-[10px] text-stone-400 bg-stone-950/40 p-2 rounded border border-stone-800/40">
                    <span className="text-stone-300 font-semibold">الأسباب: </span>
                    <span>{scan.reasons.join(' • ')}</span>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-stone-800 bg-stone-950/80 flex items-center justify-between text-[11px] text-stone-400">
          <span>إجمالي الفحوصات المسجلة: {scans.length}</span>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 font-semibold"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
