import fs from 'node:fs';

const path = 'server/geminiTrader.ts';
let text = fs.readFileSync(path, 'utf8');

const oldContext = `    recent5mCandlesSummary: input.recent5mCandles.slice(-5).map(c => ({
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
      v: c.volume
    }))
  };`;

const newContext = `    // Rich raw multi-timeframe candle context for independent AI market discovery.
    // topCandidates remain advisory; Gemini must be able to discover setups independently.
    h1Candles: (input.candles1h || []).slice(-10).map(c => ({
      t: c.timestamp,
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
      v: c.volume
    })),
    m15Candles: (input.candles15m || []).slice(-15).map(c => ({
      t: c.timestamp,
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
      v: c.volume
    })),
    m5Candles: (input.recent5mCandles || []).slice(-20).map(c => ({
      t: c.timestamp,
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
      v: c.volume
    })),
    m1Candles: (input.recent1mCandles || []).slice(-10).map(c => ({
      t: c.timestamp,
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
      v: c.volume
    }))
  };`;

if (!text.includes(oldContext)) {
  throw new Error('Expected recent5mCandlesSummary block not found; aborting without changes.');
}
text = text.replace(oldContext, newContext);

const systemPattern = /const systemInstruction = `.*?`;\n\n  isAiCallRunning = true;/s;
const newSystem = `const systemInstruction = \`أنت AI Trading Agent فائق الذكاء ومحترف للغاية متخصص في تداول الذهب XAU/USD بنظام Scalping على حساب صغير (يبدأ من $10).
القواعد الصارمة لمحرك التداول والأهداف الربحية:
1. الهدف الأساسي: حماية رأس المال واختيار صفقات نوعية عالية الجودة بناءً على Market Regime، Structure، Liquidity Sweeps، Order Blocks، FVG، Fibonacci OTE، Trend Continuation، وRange SFP/Breakout Expansion.
2. Market Regime Awareness:
   - STRONG_UPTREND / STRONG_DOWNTREND: ابحث عن فرص استمرار الترند مع Pullbacks.
   - إذا كان السعر ممتداً بشكل مفرط (isOverextended=true)، لا تطارد السعر؛ انتظر تصحيحاً أو اختر NO TRADE مؤقتاً.
   - NORMAL_RANGE / VOLATILE_RANGE: ابحث عن sweeps/SFP عند أطراف الرينج أو Breakout Expansion حقيقي، وتجنب الدخول العشوائي في Equilibrium.
   - TRANSITION: يتطلب تأكيد BOS/CHOCH واستقرار الاتجاه الجديد.
   - UNCLEAR: اختر NO TRADE.
3. القرارات المسموحة فقط: "BUY NOW" أو "SELL NOW" أو "BUY LIMIT" أو "SELL LIMIT" أو "NO TRADE".
4. Autonomous Market Discovery:
   - حلل الشموع الخام H1 وM15 وM5 وM1 بنفسك. لا تعتمد على topCandidates لاكتشاف الفرص.
   - topCandidates اقتراحات استشارية فقط. إذا كانت فارغة أو ناقصة أو متعارضة مع السعر، تجاهلها وابحث مستقلاً.
   - detectedCandidatesCount=0 لا يعني NO TRADE؛ يعني فقط أن المحرك الحتمي لم يجد مرشحاً وفق فلاتره.
   - استخرج من تسلسل الشموع: swing highs/lows، BOS، CHOCH، displacement، liquidity pools، equal highs/lows، sweeps/SFP، Order Blocks، FVG، premium/discount، والدعم والمقاومة.
   - استخدم H1/M15 للسياق والاتجاه، ثم M5/M1 للإدخال والإبطال. لا تعتمد على مؤشر واحد أو ملخصات المؤشرات فقط.
   - لا تطارد breakout متأخراً؛ اطلب سياقاً هيكلياً وretest أو اعتبر الحركة sweep/trap إذا كان ذلك مدعوماً بالشموع.
5. Stop Loss:
   - للذهب: 1 point = 0.10$ حركة سعر (abs(Entry - SL) / 0.10).
   - SL المسموح 35–65 نقطة.
   - SL يجب أن يعتمد على إبطال محلي حقيقي قريب من الدخول: OB boundary، FVG edge، local swing، أو M5/M15 structure.
   - لا تستخدم swing H1 بعيداً كـSL إذا جعله يتجاوز 65 نقطة.
   - إذا لم يوجد إبطال محلي صالح داخل 35–65 نقطة، اختر NO TRADE بدلاً من اختراع SL.
6. TP Policy:
   - TP1 هو أقرب هدف هيكلي حقيقي: swing، S/R، liquidity pool، OB، أو FVG.
   - R:R مقياس ناتج وليس سبباً لمد الهدف اصطناعياً. هدف حقيقي حول 1.0R–1.4R مقبول إذا كانت بقية الشروط قوية.
   - TP2 هو الهدف الهيكلي التالي؛ إذا لم يوجد هدف واضح اتركه 0.
   - لا تجعل وجود أو غياب topCandidates شرطاً لاكتشاف الصفقة.
7. Confidence: 70–96 للصفقات الصالحة.
8. إذا لم توجد فرصة حقيقية أو كان السوق في Equilibrium بدون ميزة واضحة، اختر NO TRADE واشرح السبب.
9. historicalTradingExperience سياق استشاري فقط ولا يلغي التحليل الفني الحالي.
10. لا تغيّر أي قاعدة من قواعد المخاطر الحتمية. اقتراحك سيخضع بعد ذلك لـ SL/R:R/Anti-Chase/POI validation البرمجي الصارم.\`;

  isAiCallRunning = true;`;

const systemMatch = text.match(systemPattern);
if (!systemMatch) {
  throw new Error('Expected systemInstruction block not found; aborting without changes.');
}
text = text.replace(systemPattern, newSystem);

const oldPrompt = `const prompt = \`حلل بيانات السوق والمرشحات الاستراتيجية المرفقة للذهب وقدم قرارك النهائي بصيغة JSON:\\n\${JSON.stringify(technicalContext, null, 2)}\`;`;
const newPrompt = `const prompt = \`حلل سوق XAU/USD بشكل مستقل من بيانات الشموع الخام متعددة الأطر والمؤشرات المرفقة، ثم اكتشف أفضل فرصة Scalping حالية بنفسك. topCandidates مجرد اقتراحات استشارية وليست شرطاً لوجود الصفقة؛ إذا كانت فارغة فابحث مباشرة في H1/M15/M5/M1. لا تصدر صفقة إلا إذا كان لها Entry منطقي، إبطال محلي واضح، SL بين 35 و65 نقطة، وهدف هيكلي حقيقي. إذا لم توجد فرصة صالحة فاختر NO TRADE. أعد القرار النهائي بصيغة JSON فقط:\\n\${JSON.stringify(technicalContext, null, 2)}\`;`;
if (!text.includes(oldPrompt)) {
  throw new Error('Expected AI prompt not found; aborting without changes.');
}
text = text.replace(oldPrompt, newPrompt);

fs.writeFileSync(path, text);
console.log(`Updated ${path} (${text.length} bytes).`);
