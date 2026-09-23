import { storage } from '../server/storage.js';
import { PoiRecord } from '../src/types.js';

function runTests() {
  console.log('====================================================');
  console.log('RUNNING POI PERSISTENCE REGRESSION TESTS');
  console.log('====================================================\n');

  const testPoi: PoiRecord = {
    id: `poi_test_${Date.now()}`,
    timeframe: '15M',
    type: 'ORDER_BLOCK',
    direction: 'BULLISH',
    top: 2715.0,
    bottom: 2710.0,
    createdCandleIndex: 25,
    isExhausted: false,
    tapCount: 1,
    lastTappedTimestamp: Date.now(),
  };

  // 1. Save POI
  storage.savePoi(testPoi);

  // 2. Query POI
  const loadedPois = storage.getPois();
  const found = loadedPois.find((p) => p.id === testPoi.id);

  if (!found) {
    throw new Error(`Test 1 Failed: POI ${testPoi.id} was not returned by storage.getPois()`);
  }
  if (found.top !== testPoi.top || found.bottom !== testPoi.bottom || found.tapCount !== 1) {
    throw new Error(`Test 1 Failed: POI data mismatch: ${JSON.stringify(found)}`);
  }

  console.log('✔ PASS: Test 1: POI saved and loaded in storage memory');

  console.log('\n====================================================');
  console.log('ALL POI PERSISTENCE REGRESSION TESTS PASSED (1/1)');
  console.log('====================================================\n');
}

runTests();
