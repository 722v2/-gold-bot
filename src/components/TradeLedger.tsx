import { useState } from 'react';
import { CheckCircle2, XCircle, Ban, Plus, ChevronDown, ChevronUp, Layers, Trash2, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { Reinforcement, TradeLedgerItem } from '../types';

interface TradeLedgerProps {
  ledger: TradeLedgerItem[];
  currentBalance: number;
  onUpdateTrade: (updated: TradeLedgerItem) => void;
  onDeleteTrade: (id: string) => void;
}

export const TradeLedger = ({
  ledger,
  currentBalance,
  onUpdateTrade,
  onDeleteTrade,
}: TradeLedgerProps) => {
  const [expandedTradeId, setExpandedTradeId] = useState<string | null>(null);
  const [closeModalTrade, setCloseModalTrade] = useState<TradeLedgerItem | null>(null);
  const [reinforceModalTrade, setReinforceModalTrade] = useState<TradeLedgerItem | null>(null);

  // Reinforcement input states
  const [reinforceEntry, setReinforceEntry] = useState<string>('');
  const [reinforceLots, setReinforceLots] = useState<string>('0.01');
  const [reinforceRisk, setReinforceRisk] = useState<string>('0.20');

  // Close trade input state
  const [closeExitPrice, setCloseExitPrice] = useState<string>('');

  const toggleExpand = (id: string) => {
    setExpandedTradeId((prev) => (prev === id ? null : id));
  };

  // Close Trade logic (TP1, TP2, SL, or Custom exit)
  const handleCloseTrade = (trade: TradeLedgerItem, outcome: 'WIN_TP1' | 'WIN_TP2' | 'LOSS_SL' | 'CANCELLED' | 'CUSTOM') => {
    let result: 'WIN' | 'LOSS' | 'CANCELLED' = 'WIN';
    let pl = 0;
    const isBuy = trade.direction.includes('BUY');

    if (outcome === 'WIN_TP1') {
      result = 'WIN';
      // TP1 profit: based on RR ratio
      const parts = trade.rr.split(':');
      const ratio = parts.length === 2 ? parseFloat(parts[1]) : 1.5;
      pl = Number((trade.totalRiskAmount ? trade.totalRiskAmount * ratio : trade.riskAmount * ratio).toFixed(2));
    } else if (outcome === 'WIN_TP2') {
      result = 'WIN';
      const parts = trade.rr.split(':');
      const ratio = parts.length === 2 ? parseFloat(parts[1]) * 1.4 : 3.0;
      pl = Number((trade.totalRiskAmount ? trade.totalRiskAmount * ratio : trade.riskAmount * 3.0).toFixed(2));
    } else if (outcome === 'LOSS_SL') {
      result = 'LOSS';
      pl = -Math.abs(trade.totalRiskAmount || trade.riskAmount);
    } else if (outcome === 'CANCELLED') {
      result = 'CANCELLED';
      pl = 0;
    } else if (outcome === 'CUSTOM') {
      const exitPrice = parseFloat(closeExitPrice);
      if (isNaN(exitPrice)) return;
      const effectiveEntry = trade.averageEntry || trade.entry;
      const priceDiff = isBuy ? exitPrice - effectiveEntry : effectiveEntry - exitPrice;
      const slDistance = Math.abs(trade.entry - trade.sl) || 1;
      const calculatedPl = Number(((priceDiff / slDistance) * (trade.totalRiskAmount || trade.riskAmount)).toFixed(2));
      result = calculatedPl >= 0 ? 'WIN' : 'LOSS';
      pl = calculatedPl;
    }

    const newBalance = Number((currentBalance + pl).toFixed(2));

    const updated: TradeLedgerItem = {
      ...trade,
      result,
      pl,
      balanceAfterTrade: newBalance,
    };

    onUpdateTrade(updated);
    setCloseModalTrade(null);
  };

  // Add Reinforcement (التعزيز) logic
  const handleAddReinforcement = () => {
    if (!reinforceModalTrade) return;
    const entryPrice = parseFloat(reinforceEntry);
    const addedRisk = parseFloat(reinforceRisk);
    const lots = parseFloat(reinforceLots) || 0.01;

    if (isNaN(entryPrice) || isNaN(addedRisk) || addedRisk <= 0) return;

    const newReinforcement: Reinforcement = {
      id: `reinf_${Date.now()}`,
      timestamp: Date.now(),
      entry: entryPrice,
      lots,
      riskAmount: addedRisk,
    };

    const existingReinfs = reinforceModalTrade.reinforcements || [];
    const allReinfs = [...existingReinfs, newReinforcement];

    // Recalculate average entry and total risk
    // Initial trade entry weight = 1, reinforcements weight = lots
    const totalLots = 0.01 + allReinfs.reduce((sum, r) => sum + r.lots, 0);
    const weightedSum = reinforceModalTrade.entry * 0.01 + allReinfs.reduce((sum, r) => sum + r.entry * r.lots, 0);
    const averageEntry = Number((weightedSum / totalLots).toFixed(2));
    const totalRiskAmount = Number((reinforceModalTrade.riskAmount + allReinfs.reduce((sum, r) => sum + r.riskAmount, 0)).toFixed(2));

    const updated: TradeLedgerItem = {
      ...reinforceModalTrade,
      reinforcements: allReinfs,
      averageEntry,
      totalRiskAmount,
      notes: `${reinforceModalTrade.notes ? reinforceModalTrade.notes + ' | ' : ''}تعزيز عند ${entryPrice}`,
    };

    onUpdateTrade(updated);
    setReinforceModalTrade(null);
    setReinforceEntry('');
  };

  return (
    <section className="bg-stone-900/90 border border-stone-800 rounded-2xl p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2 mb-4 pb-2.5 border-b border-stone-800">
        <div>
          <h2 className="text-sm sm:text-base font-bold text-stone-100 flex items-center gap-2">
            <span>Trade Ledger</span>
            <span className="text-xs text-stone-400 font-normal">(سجل الصفقات)</span>
          </h2>
          <span className="text-[11px] text-stone-400">
            إجمالي الصفقات: {ledger.length} • يدعم التعزيزات وتحديث الرصيد التلقائي
          </span>
        </div>
      </div>

      {ledger.length === 0 ? (
        <div className="text-center py-8 text-stone-400 bg-stone-950/40 rounded-xl border border-dashed border-stone-800/80">
          <p className="text-xs sm:text-sm">لا توجد صفقات مسجلة بعد.</p>
          <p className="text-[11px] text-stone-400 mt-1">
            عند ظهور إشارة من الماسح اضغط "تسجيل وتنفيذ الصفقة" ليتم إضافتها هنا وتتبع نتائجها.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {ledger.map((trade) => {
            const isBuy = trade.direction.includes('BUY');
            const isExpanded = expandedTradeId === trade.id;
            const hasReinf = trade.reinforcements && trade.reinforcements.length > 0;

            let badgeColor = 'bg-amber-950/40 text-amber-400 border-amber-800/50';
            if (trade.result === 'WIN') badgeColor = 'bg-emerald-950/40 text-emerald-400 border-emerald-800/50';
            if (trade.result === 'LOSS') badgeColor = 'bg-rose-950/40 text-rose-400 border-rose-800/50';
            if (trade.result === 'CANCELLED' || trade.result === 'VOID' || trade.result === 'EXPIRED') {
              badgeColor = 'bg-stone-800 text-stone-400 border-stone-700';
            }

            return (
              <div
                key={trade.id}
                className="bg-stone-950/70 border border-stone-800/90 rounded-xl p-3 sm:p-3.5 transition-all hover:border-stone-700"
              >
                {/* Header row of card */}
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-bold text-amber-400 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
                      #{trade.tradeNumber}
                    </span>
                    <span
                      className={`text-xs font-bold px-2 py-0.5 rounded border ${
                        isBuy
                          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                          : 'bg-rose-500/15 text-rose-400 border-rose-500/30'
                      }`}
                    >
                      {trade.direction}
                    </span>
                    <span className="text-xs font-mono text-stone-300 font-semibold">
                      {trade.asset}
                    </span>
                    {hasReinf && (
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
                        معززة ({trade.reinforcements?.length})
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${badgeColor}`}>
                      {trade.result === 'OPEN' ? 'مفتوحة (OPEN)' : trade.result}
                    </span>
                    <button
                      onClick={() => toggleExpand(trade.id)}
                      className="p-1 rounded text-stone-400 hover:text-stone-200"
                    >
                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Primary numbers grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono my-2">
                  <div className="bg-stone-900/60 p-1.5 rounded">
                    <span className="text-[10px] text-stone-400 block">
                      {hasReinf ? 'Avg Entry' : 'Entry'}
                    </span>
                    <span className="text-stone-200 font-semibold">
                      ${(trade.averageEntry || trade.entry).toFixed(2)}
                    </span>
                  </div>

                  <div className="bg-stone-900/60 p-1.5 rounded">
                    <span className="text-[10px] text-stone-400 block">SL / TP1</span>
                    <span className="text-rose-400">${trade.sl.toFixed(2)}</span>
                    <span className="text-stone-400 mx-1">/</span>
                    <span className="text-emerald-400">${trade.tp1.toFixed(2)}</span>
                  </div>

                  <div className="bg-stone-900/60 p-1.5 rounded">
                    <span className="text-[10px] text-stone-400 block">Risk $ / RR</span>
                    <span className="text-stone-300">
                      ${(trade.totalRiskAmount || trade.riskAmount).toFixed(2)} ({trade.rr})
                    </span>
                  </div>

                  <div className="bg-stone-900/60 p-1.5 rounded">
                    <span className="text-[10px] text-stone-400 block">P/L (الربح/الخسارة)</span>
                    <span
                      className={`font-bold ${
                        trade.result === 'WIN'
                          ? 'text-emerald-400'
                          : trade.result === 'LOSS'
                          ? 'text-rose-400'
                          : 'text-stone-400'
                      }`}
                    >
                      {trade.result === 'OPEN' ? 'قيد التداول' : `${trade.pl >= 0 ? '+' : ''}$${trade.pl.toFixed(2)}`}
                    </span>
                  </div>
                </div>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="mt-3 pt-3 border-t border-stone-800/80 text-xs space-y-2">
                    <div className="flex flex-wrap items-center justify-between text-stone-400 text-[11px] gap-2">
                      <span>التاريخ: {trade.date}</span>
                      <span>نسبة الثقة: {trade.confidence}%</span>
                      <span>النموذج: {trade.setup}</span>
                      <span>الرصيد بعد الصفقة: ${trade.balanceAfterTrade.toFixed(2)}</span>
                    </div>

                    {/* Reinforcements section */}
                    {hasReinf && (
                      <div className="bg-stone-900/70 p-2 rounded-lg border border-purple-900/30">
                        <span className="text-[11px] font-bold text-purple-300 block mb-1">
                          تفاصيل التعزيزات (Scale-ins):
                        </span>
                        <div className="space-y-1 text-[11px] text-stone-300">
                          {trade.reinforcements?.map((r, idx) => (
                            <div key={r.id} className="flex justify-between">
                              <span>تعزيز #{idx + 1} عند: ${r.entry.toFixed(2)}</span>
                              <span>حجم: {r.lots} lot • مخاطرة إضافية: ${r.riskAmount}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Actions for OPEN trades */}
                    {trade.result === 'OPEN' && (
                      <div className="flex flex-wrap items-center gap-2 pt-2">
                        <button
                          onClick={() => handleCloseTrade(trade, 'WIN_TP1')}
                          className="px-2.5 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-600/40 text-xs font-medium transition-colors"
                        >
                          تحقيق TP1 (فوز)
                        </button>
                        <button
                          onClick={() => handleCloseTrade(trade, 'WIN_TP2')}
                          className="px-2.5 py-1.5 rounded-lg bg-emerald-700/30 hover:bg-emerald-700/40 text-emerald-200 border border-emerald-500/50 text-xs font-medium transition-colors"
                        >
                          تحقيق TP2 (فوز أقصى)
                        </button>
                        <button
                          onClick={() => handleCloseTrade(trade, 'LOSS_SL')}
                          className="px-2.5 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-600/40 text-xs font-medium transition-colors"
                        >
                          ضرب الـStop Loss
                        </button>
                        <button
                          onClick={() => {
                            setReinforceModalTrade(trade);
                            setReinforceEntry(trade.entry.toString());
                          }}
                          className="px-2.5 py-1.5 rounded-lg bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-600/40 text-xs font-medium transition-colors flex items-center gap-1"
                        >
                          <Plus className="w-3.5 h-3.5" /> إضافة تعزيز (Scale-in)
                        </button>
                        <button
                          onClick={() => handleCloseTrade(trade, 'CANCELLED')}
                          className="px-2.5 py-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-300 text-xs font-medium transition-colors"
                        >
                          إلغاء
                        </button>
                      </div>
                    )}

                    {/* Delete entry */}
                    <div className="flex justify-end pt-1">
                      <button
                        onClick={() => onDeleteTrade(trade.id)}
                        className="text-[11px] text-stone-400 hover:text-rose-400 flex items-center gap-1 transition-colors"
                      >
                        <Trash2 className="w-3 h-3" /> حذف من السجل
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Modal for Adding Reinforcement */}
      {reinforceModalTrade && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-stone-900 border border-stone-800 rounded-2xl p-5 max-w-sm w-full space-y-4 shadow-xl">
            <h3 className="text-sm font-bold text-stone-100 flex items-center gap-2">
              <Layers className="w-4 h-4 text-purple-400" />
              <span>إضافة تعزيز للصفقة #{reinforceModalTrade.tradeNumber}</span>
            </h3>
            <p className="text-xs text-stone-400">
              وفقاً لقواعدك: التعزيز لا يعتبر صفقة جديدة بل يحسب Average Entry ومجموع المخاطرة لنفس الـSetup.
            </p>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-stone-300 mb-1">سعر دخول التعزيز ($):</label>
                <input
                  type="number"
                  step="0.1"
                  value={reinforceEntry}
                  onChange={(e) => setReinforceEntry(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-800 rounded-lg px-3 py-2 text-stone-100 font-mono"
                />
              </div>

              <div>
                <label className="block text-stone-300 mb-1">حجم اللوت الإضافي (Lots):</label>
                <input
                  type="number"
                  step="0.001"
                  value={reinforceLots}
                  onChange={(e) => setReinforceLots(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-800 rounded-lg px-3 py-2 text-stone-100 font-mono"
                />
              </div>

              <div>
                <label className="block text-stone-300 mb-1">المخاطرة الإضافية ($):</label>
                <input
                  type="number"
                  step="0.05"
                  value={reinforceRisk}
                  onChange={(e) => setReinforceRisk(e.target.value)}
                  className="w-full bg-stone-950 border border-stone-800 rounded-lg px-3 py-2 text-stone-100 font-mono"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setReinforceModalTrade(null)}
                className="px-3 py-1.5 rounded-lg bg-stone-800 text-stone-300 text-xs font-medium"
              >
                إلغاء
              </button>
              <button
                onClick={handleAddReinforcement}
                className="px-4 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold"
              >
                تأكيد التعزيز
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
