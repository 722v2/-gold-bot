import { parseAndValidateAiResponse } from '../server/geminiTrader.js';

function runTests() {
  console.log('====================================================');
  console.log('RUNNING AI CONFIDENCE VALIDATION REGRESSION TESTS');
  console.log('====================================================\n');

  // Test 1: Valid numeric confidence within range
  const validResp = parseAndValidateAiResponse({
    signal: 'BUY NOW',
    confidence: 85,
    setup: 'Bullish Order Block',
  });
  if (validResp.confidence !== 85) {
    throw new Error(`Test 1 Failed: expected 85, got ${validResp.confidence}`);
  }
  console.log('✔ PASS: Test 1: Valid numeric confidence accepted');

  // Test 2: Negative confidence rejected
  try {
    parseAndValidateAiResponse({
      signal: 'BUY NOW',
      confidence: -10,
      setup: 'Bullish OB',
    });
    throw new Error('Test 2 Failed: negative confidence should throw');
  } catch (err: any) {
    if (!err.message.includes('Invalid "confidence"')) {
      throw err;
    }
  }
  console.log('✔ PASS: Test 2: Negative confidence rejected');

  // Test 3: Over-100 confidence rejected
  try {
    parseAndValidateAiResponse({
      signal: 'BUY NOW',
      confidence: 150,
      setup: 'Bullish OB',
    });
    throw new Error('Test 3 Failed: >100 confidence should throw');
  } catch (err: any) {
    if (!err.message.includes('Invalid "confidence"')) {
      throw err;
    }
  }
  console.log('✔ PASS: Test 3: Over-100 confidence rejected');

  // Test 4: String confidence rejected
  try {
    parseAndValidateAiResponse({
      signal: 'BUY NOW',
      confidence: '85%',
      setup: 'Bullish OB',
    });
    throw new Error('Test 4 Failed: string confidence should throw');
  } catch (err: any) {
    if (!err.message.includes('Invalid "confidence"')) {
      throw err;
    }
  }
  console.log('✔ PASS: Test 4: String confidence rejected');

  // Test 5: NaN confidence rejected
  try {
    parseAndValidateAiResponse({
      signal: 'BUY NOW',
      confidence: NaN,
      setup: 'Bullish OB',
    });
    throw new Error('Test 5 Failed: NaN confidence should throw');
  } catch (err: any) {
    if (!err.message.includes('Invalid "confidence"')) {
      throw err;
    }
  }
  console.log('✔ PASS: Test 5: NaN confidence rejected');

  console.log('\n====================================================');
  console.log('ALL AI CONFIDENCE VALIDATION TESTS PASSED (5/5)');
  console.log('====================================================\n');
}

runTests();
