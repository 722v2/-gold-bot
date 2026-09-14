import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, deleteDoc, setDoc } from 'firebase/firestore';
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

async function runCleanup() {
  console.log('[Cleanup] Starting cleanup of test artifacts and resetting account balances...');

  // 1. Reset local JSON files
  const filesToReset: { [key: string]: any } = {
    'trade_ledger.json': [],
    'trade_outcomes.json': [],
    'saved_signals.json': [],
    'scan_history.json': [],
    'telegram_dispatches.json': [],
    'opportunities.json': {},
    'account_state.json': {
      currentBalance: 25.0,
      startingBalance: 25.0
    }
  };

  for (const [filename, defaultValue] of Object.entries(filesToReset)) {
    const filePath = path.join(DATA_DIR, filename);
    try {
      fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), 'utf8');
      console.log(`[Cleanup] Successfully reset local file: ${filename}`);
    } catch (err: any) {
      console.error(`[Cleanup] Failed to reset file ${filename}:`, err.message);
    }
  }

  // 2. Initialize Firebase and clear Firestore collections
  let config: any = null;
  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e: any) {
      console.error('[Cleanup] Error reading firebase-applet-config.json:', e.message);
    }
  }

  if (config) {
    console.log('[Cleanup] Found Firebase configuration. Cleaning remote Firestore collections...');
    try {
      const app = initializeApp(config);
      const db = getFirestore(app, config.firestoreDatabaseId);

      const collectionsToClear = [
        'trade_ledger',
        'trade_outcomes',
        'signals',
        'opportunities',
        'candidate_lifecycles',
        'terminal_setups',
        'telegram_dispatches',
        'poi_records'
      ];

      for (const colName of collectionsToClear) {
        const colRef = collection(db, colName);
        const snapshot = await getDocs(colRef);
        console.log(`[Cleanup] Collection '${colName}' has ${snapshot.size} documents. Deleting all...`);
        for (const docSnap of snapshot.docs) {
          await deleteDoc(docSnap.ref);
        }
        console.log(`[Cleanup] Finished clearing collection '${colName}'.`);
      }

      // Reset main account state in Firestore
      const accountRef = doc(db, 'account_state', 'main');
      await setDoc(accountRef, {
        startingBalance: 25.0,
        currentBalance: 25.0,
        updatedAt: Date.now()
      });
      console.log('[Cleanup] Reset account_state/main in Firestore.');

    } catch (err: any) {
      console.error('[Cleanup] Firebase Firestore cleanup failed:', err.message);
    }
  } else {
    console.warn('[Cleanup] No firebase-applet-config.json found, skipping remote Firestore cleanup.');
  }

  console.log('[Cleanup] All cleanup operations completed successfully!');
}

runCleanup().catch((err) => {
  console.error('[Cleanup] Fatal cleanup error:', err);
});
