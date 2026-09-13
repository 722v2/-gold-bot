import React from 'react';
import {
  X,
  History,
  ShieldCheck,
  BarChart3,
  Send,
  Activity,
  Settings,
  ChevronLeft,
} from 'lucide-react';
import { NavigationTab } from '../../types';

interface MobileMoreDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
}

export const MobileMoreDrawer: React.FC<MobileMoreDrawerProps> = ({
  isOpen,
  onClose,
  activeTab,
  onSelectTab,
}) => {
  if (!isOpen) return null;

  const items: {
    id: NavigationTab;
    label: string;
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    tag?: string;
  }[] = [
    {
      id: 'backtest',
      label: 'الاختبار التاريخي (Backtest Engine)',
      description: 'اختبار الاستراتيجية على بيانات XAU/USD الحقيقية بأرقام وإحصائيات دقيقة',
      icon: History,
      tag: 'Real Data',
    },
    {
      id: 'risk',
      label: 'إدارة المخاطر (Risk Engine)',
      description: 'حماية رأس المال بنسبة 15% وحجم اللوت ووقف الخسارة الأقصى',
      icon: ShieldCheck,
      tag: '15% Rule',
    },
    {
      id: 'analytics',
      label: 'الإحصائيات والتحليل (Analytics)',
      description: 'منحنى رأس المال ونسبة النجاح والربح الصافي ومعدل العائد',
      icon: BarChart3,
    },
    {
      id: 'telegram',
      label: 'إشعارات تلغرام (Telegram Bot)',
      description: 'إرسال الصفقات والأهداف لحسابك (اختياري)',
      icon: Send,
    },
    {
      id: 'health',
      label: 'فحص حالة النظام (System Health)',
      description: 'حالة الخادم، الذكاء الاصطناعي، خلاصة Biquote، والتخزين الدائم',
      icon: Activity,
    },
    {
      id: 'settings',
      label: 'إعدادات المنصة (Settings)',
      description: 'إعدادات الرصيد، أحجام العقود، مستويات الثقة، ورموز التداول',
      icon: Settings,
    },
  ];

  const handleSelect = (tab: NavigationTab) => {
    onSelectTab(tab);
    onClose();
  };

  return (
    <div className="lg:hidden fixed inset-0 z-50 flex flex-col justify-end bg-black/80 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="bg-stone-900 border-t border-stone-800 rounded-t-3xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl animate-in slide-in-from-bottom duration-250">
        {/* Header */}
        <div className="p-4 border-b border-stone-800 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-stone-100">أقسام المنصة الإضافية</h3>
            <p className="text-[11px] text-stone-400">اختر القسم المراد استعراضه</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-300"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* List */}
        <div className="p-3 space-y-2 overflow-y-auto">
          {items.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;

            return (
              <button
                key={item.id}
                onClick={() => handleSelect(item.id)}
                className={`w-full flex items-center justify-between p-3 rounded-2xl text-right transition-colors ${
                  isActive
                    ? 'bg-amber-500/15 border border-amber-500/30 text-amber-200'
                    : 'bg-stone-950/60 border border-stone-800/80 text-stone-300 hover:bg-stone-800/60'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                      isActive
                        ? 'bg-amber-500/20 text-amber-400'
                        : 'bg-stone-800 text-stone-400'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-stone-100">{item.label}</span>
                      {item.tag && (
                        <span className="text-[9px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono">
                          {item.tag}
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-stone-400 block mt-0.5 line-clamp-1">
                      {item.description}
                    </span>
                  </div>
                </div>

                <ChevronLeft className="w-4 h-4 text-stone-500 shrink-0" />
              </button>
            );
          })}
        </div>

        <div className="p-4 bg-stone-950 border-t border-stone-800 text-center">
          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-bold"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
