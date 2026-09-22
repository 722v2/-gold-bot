import assert from 'node:assert';
import { parseAndValidateAiResponse, XAUUSD_TRADE_SIGNAL_JSON_SCHEMA } from '../server/geminiTrader.js';

console.log('Running AI Response & JSON Schema Layer tests...');

// TEST 1: Valid JSON Schema response parses successfully and returns internal signal object
{
  const validJson = JSON.stringify({
    signal: 'BUY NOW',
    entry: 4352.50,
    stopLoss: 4348.00,
    tp1: 4358.50,
    tp2: 4366.00,
    confidence: 88,
    timeframe: '15M / 5M',
    setup: 'Bullish Order Block Retest',
    mainReasons: ['تأكيد كسر القمة', 'اختبار منطقة الطلب'],
    invalidation: 'إغلاق شمعة أسفل 4348.00'
  });

  const res = parseAndValidateAiResponse(validJson);
  assert.strictEqual(res.signal, 'BUY NOW');
  assert.strictEqual(res.entry, 4352.50);
  assert.strictEqual(res.stopLoss, 4348.00);
  assert.strictEqual(res.tp1, 4358.50);
  assert.strictEqual(res.tp2, 4366.00);
  assert.strictEqual(res.confidence, 88);
  assert.strictEqual(res.setup, 'Bullish Order Block Retest');
  console.log('✅ TEST 1 passed');
}

// TEST 2: Valid JSON response containing required fields is accepted
{
  const raw = {
    signal: 'NO TRADE',
    confidence: 50,
    setup: 'Equilibrium Consolidation',
    noTradeReason: 'السوق في منتصف النطاق بدون سيولة'
  };

  const res = parseAndValidateAiResponse(raw);
  assert.strictEqual(res.signal, 'NO TRADE');
  assert.strictEqual(res.confidence, 50);
  assert.strictEqual(res.setup, 'Equilibrium Consolidation');
  assert.strictEqual(res.noTradeReason, 'السوق في منتصف النطاق بدون سيولة');
  console.log('✅ TEST 2 passed');
}

// TEST 3: Malformed JSON throws safely
{
  assert.throws(() => parseAndValidateAiResponse('{ "signal": "BUY NOW", "confidence": '));
  console.log('✅ TEST 3 passed');
}

// TEST 4: Conversational prose instead of JSON throws safely
{
  const prose = 'Here is the trading analysis: I suggest buying gold because the trend is bullish.';
  assert.throws(() => parseAndValidateAiResponse(prose));
  console.log('✅ TEST 4 passed');
}

// TEST 5: Missing required field (signal) throws safely
{
  const missingSignal = JSON.stringify({
    entry: 4350,
    stopLoss: 4345,
    confidence: 80
  });
  assert.throws(() => parseAndValidateAiResponse(missingSignal), /signal/i);
  console.log('✅ TEST 5 passed');
}

// TEST 6: Wrong field type (e.g. confidence = "high") throws safely
{
  const badType = JSON.stringify({
    signal: 'BUY NOW',
    confidence: 'high',
    setup: 'OB Setup'
  });
  assert.throws(() => parseAndValidateAiResponse(badType), /confidence/i);
  console.log('✅ TEST 6 passed');
}

// TEST 7: Handles markdown-wrapped JSON code blocks safely
{
  const wrapped = '```json\n{"signal": "SELL NOW", "confidence": 85, "setup": "SFP"}\n```';
  const res = parseAndValidateAiResponse(wrapped);
  assert.strictEqual(res.signal, 'SELL NOW');
  assert.strictEqual(res.confidence, 85);
  console.log('✅ TEST 7 passed');
}

// TEST 8: Schema definition conforms to requirements
{
  assert.strictEqual(XAUUSD_TRADE_SIGNAL_JSON_SCHEMA.type, 'object');
  assert.ok(XAUUSD_TRADE_SIGNAL_JSON_SCHEMA.required.includes('signal'));
  assert.ok(XAUUSD_TRADE_SIGNAL_JSON_SCHEMA.required.includes('confidence'));
  assert.ok(XAUUSD_TRADE_SIGNAL_JSON_SCHEMA.required.includes('setup'));
  console.log('✅ TEST 8 passed');
}

console.log('All AI Response & JSON Schema tests passed successfully!');
