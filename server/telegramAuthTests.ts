import {
  getAuthorizedTelegramUserIds,
  isTelegramUserAuthorized,
} from './telegram.js';

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, testName: string, details?: any) {
  if (condition) {
    console.log(`✅ [PASS] ${testName}`);
    passedCount++;
  } else {
    console.error(`❌ [FAIL] ${testName}`, details || '');
    failedCount++;
  }
}

console.log('======================================================================');
console.log('RUNNING TELEGRAM TRADE OUTCOME BUTTON AUTHORIZATION TESTS');
console.log('======================================================================\n');

// TEST 1: Authorized user 1189889156 pressing WIN -> ALLOW
{
  const customEnv = {
    TELEGRAM_AUTHORIZED_USER_IDS: '1189889156',
    TELEGRAM_CHAT_ID: '-1003985073744',
    TELEGRAM_BOT_TOKEN: '123456:ABC-DEF',
  };

  const isAuth = isTelegramUserAuthorized(1189889156, customEnv);
  assert(
    isAuth === true,
    'TEST 1: Authorized user 1189889156 pressing WIN -> ALLOW',
    { isAuth }
  );
}

// TEST 2: Authorized user 1189889156 pressing LOSS -> ALLOW
{
  const customEnv = {
    TELEGRAM_AUTHORIZED_USER_IDS: '1189889156',
    TELEGRAM_CHAT_ID: '-1003985073744',
    TELEGRAM_BOT_TOKEN: '123456:ABC-DEF',
  };

  const isAuth = isTelegramUserAuthorized('1189889156', customEnv);
  assert(
    isAuth === true,
    'TEST 2: Authorized user 1189889156 pressing LOSS -> ALLOW',
    { isAuth }
  );
}

// TEST 3: Same authorized user pressing button on a group message -1003985073744 -> ALLOW
{
  const customEnv = {
    TELEGRAM_AUTHORIZED_USER_IDS: '1189889156',
    TELEGRAM_CHAT_ID: '-1003985073744',
    TELEGRAM_BOT_TOKEN: '123456:ABC-DEF',
  };

  // When posted in group -1003985073744, cq.from.id is the clicking user (1189889156)
  const isAuth = isTelegramUserAuthorized('1189889156', customEnv);
  assert(
    isAuth === true,
    'TEST 3: Authorized user 1189889156 on group message -1003985073744 -> ALLOW',
    { isAuth }
  );
}

// TEST 4: Unauthorized user -> BLOCK
{
  const customEnv = {
    TELEGRAM_AUTHORIZED_USER_IDS: '1189889156',
    TELEGRAM_CHAT_ID: '-1003985073744',
    TELEGRAM_BOT_TOKEN: '123456:ABC-DEF',
  };

  const unauthorizedUserId = '999888777';
  const isAuth = isTelegramUserAuthorized(unauthorizedUserId, customEnv);
  assert(
    isAuth === false,
    'TEST 4: Unauthorized user 999888777 -> BLOCK',
    { isAuth }
  );
}

// TEST 5: Multiple authorized IDs -> correct user allowed
{
  const customEnv = {
    TELEGRAM_AUTHORIZED_USER_IDS: '1189889156, 2233445566, 9988776655',
    TELEGRAM_CHAT_ID: '-1003985073744',
  };

  const isUser1Auth = isTelegramUserAuthorized('1189889156', customEnv);
  const isUser2Auth = isTelegramUserAuthorized('2233445566', customEnv);
  const isUser3Auth = isTelegramUserAuthorized('9988776655', customEnv);
  const isOtherAuth = isTelegramUserAuthorized('1234567890', customEnv);

  assert(
    isUser1Auth === true && isUser2Auth === true && isUser3Auth === true && isOtherAuth === false,
    'TEST 5: Multiple authorized IDs -> correct users allowed and unlisted blocked',
    { isUser1Auth, isUser2Auth, isUser3Auth, isOtherAuth }
  );
}

// TEST 6: Whitespace around configured IDs -> still works
{
  const customEnv = {
    TELEGRAM_AUTHORIZED_USER_IDS: '   1189889156 \n\t ,  9876543210   ',
    TELEGRAM_CHAT_ID: ' -1003985073744 ',
  };

  const parsed = getAuthorizedTelegramUserIds(customEnv);
  const isAuth = isTelegramUserAuthorized('  1189889156  ', customEnv);

  assert(
    parsed.length === 2 && parsed[0] === '1189889156' && parsed[1] === '9876543210' && isAuth === true,
    'TEST 6: Whitespace around configured IDs -> safely trimmed and authorized',
    { parsed, isAuth }
  );
}

// TEST 7: Destination group ID alone -> MUST NOT authorize a user
{
  // If TELEGRAM_AUTHORIZED_USER_IDS is empty, but TELEGRAM_CHAT_ID is a group ID (-1003985073744)
  const customEnv = {
    TELEGRAM_AUTHORIZED_USER_IDS: '',
    TELEGRAM_CHAT_ID: '-1003985073744',
    TELEGRAM_BOT_TOKEN: '123456:ABC-DEF',
  };

  const parsed = getAuthorizedTelegramUserIds(customEnv);
  const isGroupAuth = isTelegramUserAuthorized('-1003985073744', customEnv);
  const isRandomUserAuth = isTelegramUserAuthorized('1189889156', customEnv);

  assert(
    parsed.length === 0 && isGroupAuth === false && isRandomUserAuth === false,
    'TEST 7: Destination group ID alone (-1003985073744) -> MUST NOT authorize users',
    { parsed, isGroupAuth, isRandomUserAuth }
  );
}

// TEST 8: Invalid/empty authorization entries -> safely ignored
{
  const customEnv = {
    TELEGRAM_AUTHORIZED_USER_IDS: ', , ,,  1189889156 ,  , ,',
  };

  const parsed = getAuthorizedTelegramUserIds(customEnv);
  assert(
    parsed.length === 1 && parsed[0] === '1189889156',
    'TEST 8: Invalid/empty authorization entries -> safely ignored',
    { parsed }
  );
}

console.log('\n======================================================================');
console.log(`TEST SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
console.log('======================================================================\n');

process.exit(failedCount > 0 ? 1 : 0);
