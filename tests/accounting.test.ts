import { runAccountingTests } from '../server/accountingTests.js';

async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING ACCOUNTING & RECREATION REGRESSION TESTS (1-13)');
  console.log('====================================================\n');

  const report = runAccountingTests();

  for (const r of report.results) {
    if (r.passed) {
      console.log(`✅ [PASS] Test ${r.testNumber}: ${r.name}`);
      console.log(`   ${r.details}`);
    } else {
      console.error(`❌ [FAIL] Test ${r.testNumber}: ${r.name}`);
      console.error(`   ${r.details}`);
    }
  }

  console.log('\n====================================================');
  console.log(`SUMMARY: ${report.results.filter((r) => r.passed).length}/${report.results.length} PASSED (allPassed=${report.allPassed})`);
  console.log('====================================================\n');

  if (!report.allPassed) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
