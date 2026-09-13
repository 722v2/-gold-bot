import React, { useState } from 'react';
import {
  Send,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Bell,
  BellOff,
  ShieldCheck,
  SendHorizontal,
  Info,
  Radio,
  Sliders,
} from 'lucide-react';

interface TelegramViewProps {
  onTestTelegram: () => Promise<any>;
}

export const TelegramView: React.FC<TelegramViewProps> = ({ onTestTelegram }) => {
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(true);
  const [testing, setTesting] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    configured?: boolean;
    message?: string;
    error?: string;
  } | null>(null);

  // Notification types state
  const [notificationTypes, setNotificationTypes] = useState<{ [key: string]: boolean }>({
    newSignal: true,
    tradeExecuted: true,
    tp1Hit: true,
    tp2Hit: true,
    stopLoss: true,
    scannerError: true,
    systemOffline: true,
  });

  const toggleType = (key: string) => {
    setNotificationTypes((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await onTestTelegram();
      setTestResult(res);
    } catch (e: any) {
      setTestResult({
        success: false,
        error: e.message || 'فشل الاتصال بخادم تلغرام',
      });
    } finally {
      setTesting(false);
    }
  };

  // Determine status
  const telegramStatus: 'CONNECTED' | 'DISCONNECTED' | 'NOT CONFIGURED' = testResult?.configured
    ? testResult.success
      ? 'CONNECTED'
      : 'DISCONNECTED'
    : 'NOT CONFIGURED';

  return (
    <div className="space-y-4 sm:space-y-6 animate-in fade-in duration-250">
      {/* Top Banner & Status */}
      <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-sky-500/20 text-sky-400 border border-sky-500/30 flex items-center justify-center">
            <Send className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-black text-stone-100 font-mono">
                Telegram Notifications Hub
              </h3>
              <span
                className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border ${
                  telegramStatus === 'CONNECTED'
                    ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                    : telegramStatus === 'DISCONNECTED'
                    ? 'bg-rose-950 text-rose-300 border-rose-800'
                    : 'bg-stone-800 text-stone-300 border-stone-700'
                }`}
              >
                {telegramStatus}
              </span>
            </div>
            <p className="text-xs text-stone-400 mt-0.5">
              إرسال الإشارات والأهداف الفنية وتحديثات الوقف مباشرة إلى قناتك أو حسابك
            </p>
          </div>
        </div>

        {/* Global Notifications Toggle */}
        <button
          onClick={() => setNotificationsEnabled(!notificationsEnabled)}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all border ${
            notificationsEnabled
              ? 'bg-sky-950/80 hover:bg-sky-900 border-sky-800 text-sky-200'
              : 'bg-stone-800 text-stone-400 border-stone-700'
          }`}
        >
          {notificationsEnabled ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
          <span>{notificationsEnabled ? 'التنبيهات: مفعلة (ON)' : 'التنبيهات: معطلة (OFF)'}</span>
        </button>
      </div>

      {/* Optional Service Notice (Requirement 8) */}
      <div className="bg-stone-950 border border-stone-800 rounded-2xl p-4 flex items-start gap-3 text-xs text-stone-300">
        <Info className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <span className="font-bold text-amber-300 font-mono block">
            ملاحظة معمارية: تلغرام هي خدمة تنبيه اختيارية (Auxiliary Alert Channel)
          </span>
          <p className="text-stone-400 leading-relaxed">
            إذا كان تلغرام غير مهيأ (NOT CONFIGURED)، فهذا لا يعني أن النظام غير متصل. ماسح السوق المستقل
            والذكاء الاصطناعي يعملان بكامل طاقتهما (ONLINE) على الخادم لتسجيل الصفقات وفحص بيانات الذهب.
          </p>
        </div>
      </div>

      {/* Notification Types Checklist */}
      <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5">
        <h4 className="text-sm font-bold text-stone-100 mb-3 border-b border-stone-800 pb-2">
          أنواع التنبيهات المتاحة (Notification Types):
        </h4>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {[
            { id: 'newSignal', label: 'New Signal', ar: 'إشارة تداول جديدة معتمدة (BUY / SELL)' },
            { id: 'tradeExecuted', label: 'Trade Executed', ar: 'تنفيذ صفقة جديدة في دفتر الصفقات' },
            { id: 'tp1Hit', label: 'TP1 Hit', ar: 'تحقيق الهدف الأول (2R) ونقل الوقف للدخول' },
            { id: 'tp2Hit', label: 'TP2 Hit', ar: 'تحقيق الهدف الثاني النهائي (3R)' },
            { id: 'stopLoss', label: 'Stop Loss', ar: 'ضرب وقف الخسارة وإغلاق الصفقة' },
            { id: 'scannerError', label: 'Scanner Error', ar: 'أخطاء فحص السوق أو انقطاع التغذية' },
            { id: 'systemOffline', label: 'System Offline', ar: 'تحذيرات انقطاع الخادم أو إعادة التشغيل' },
          ].map((type) => (
            <div
              key={type.id}
              onClick={() => toggleType(type.id)}
              className="flex items-center justify-between p-3 rounded-xl bg-stone-950/70 border border-stone-800/80 hover:bg-stone-950 cursor-pointer transition-colors"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-stone-200 font-mono">{type.label}</span>
                </div>
                <span className="text-[11px] text-stone-400 block mt-0.5">{type.ar}</span>
              </div>

              <input
                type="checkbox"
                checked={notificationTypes[type.id]}
                onChange={() => toggleType(type.id)}
                className="w-4 h-4 accent-sky-500 rounded cursor-pointer"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Test Telegram Action Card */}
      <div className="bg-stone-900/90 border border-stone-800/90 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h4 className="text-sm font-bold text-stone-100">فحص اتصال البوت (Test Telegram)</h4>
          <p className="text-xs text-stone-400 mt-0.5">
            يقوم بإرسال رسالة تجريبية مشفرة للتأكد من صحة التوكن ورقم المحادثة
          </p>
        </div>

        <button
          onClick={handleTest}
          disabled={testing}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-stone-950 text-xs font-black transition-all shadow-xs"
        >
          <SendHorizontal className={`w-4 h-4 ${testing ? 'animate-bounce' : ''}`} />
          <span>{testing ? 'جاري الفحص...' : 'TEST TELEGRAM'}</span>
        </button>
      </div>

      {/* Test Result Box */}
      {testResult && (
        <div
          className={`p-4 rounded-2xl border text-xs ${
            testResult.success
              ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
              : 'bg-stone-900 border-stone-700 text-stone-300'
          }`}
        >
          <div className="flex items-center gap-2 mb-1 font-bold">
            {testResult.success ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            ) : (
              <AlertCircle className="w-4 h-4 text-amber-400" />
            )}
            <span>{testResult.success ? 'نجح الاتصال بنجاح' : 'حالة الاتصال بالتليغرام:'}</span>
          </div>
          <p className="leading-relaxed">{testResult.message || testResult.error}</p>
        </div>
      )}
    </div>
  );
};
