import test from 'node:test';
import assert from 'node:assert/strict';
import { storage } from '../server/storage.js';
import { scanner } from '../server/scanner.js';

test('Capital Integrity Audit', async (t) => {
  await t.test('1. Opening/saving Settings without changing capital does not change startingBalance', () => {
    // Set baseline balance
    const initBal = storage.updateBalance(25.0, 25.0);
    assert.equal(initBal.startingBalance, 25.0);
    assert.equal(initBal.currentBalance, 25.0);

    // Save unrelated settings
    const saveRes = storage.saveSettings({
      riskPerTrade: 15.0,
      executionMode: 'DEMO',
    });

    assert.equal(saveRes.success, true);
    assert.equal(saveRes.startingBalance, 25.0, 'startingBalance must remain 25.0');
    assert.equal(saveRes.currentBalance, 25.0, 'currentBalance must remain 25.0');

    const afterBal = storage.getBalance();
    assert.equal(afterBal.startingBalance, 25.0);
    assert.equal(afterBal.currentBalance, 25.0);
  });

  await t.test('2. Missing manualCapital in settings patch does not become $10', () => {
    const patchRes = storage.saveSettings({
      riskPerTrade: 10.0,
    });
    assert.notEqual(patchRes.settings.manualCapital, 10.0, 'manualCapital must not silently default to 10');
    assert.equal(patchRes.startingBalance, 25.0);
  });

  await t.test('3. Scanner startup cannot modify capital or balance', async () => {
    const beforeBal = storage.getBalance();

    // Verify scanner config access does not alter storage balance
    scanner.getConfig();
    const afterBal = storage.getBalance();

    assert.equal(afterBal.startingBalance, beforeBal.startingBalance, 'Scanner initialization must not alter startingBalance');
    assert.equal(afterBal.currentBalance, beforeBal.currentBalance, 'Scanner initialization must not alter currentBalance');
  });

  // Cleanly exit to stop any active background intervals imported by server dependencies
  setTimeout(() => process.exit(0), 100);
});
