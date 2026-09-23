import { resolveAiProviderConfig } from '../server/geminiTrader.js';

function runTests() {
  console.log('====================================================');
  console.log('RUNNING PROVIDER API ROUTING REGRESSION TESTS');
  console.log('====================================================\n');

  const oldEnv = { ...process.env };

  try {
    // Test 1: OpenRouter provider with valid key
    process.env.AI_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-abcdef1234567890';
    process.env.OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.OPENROUTER_MODEL = 'google/gemini-2.5-flash-lite';
    delete process.env.NVIDIA_API_KEY;

    let config = resolveAiProviderConfig();
    if (config.provider !== 'openrouter' || config.baseURL !== 'https://openrouter.ai/api/v1' || config.model !== 'google/gemini-2.5-flash-lite') {
      throw new Error(`Test 1 Failed: expected openrouter config, got ${JSON.stringify(config)}`);
    }
    console.log('✔ PASS: Test 1: OpenRouter provider properly configured');

    // Test 2: NVIDIA provider with valid key
    process.env.AI_PROVIDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'nvapi-abcdef1234567890';
    process.env.NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
    process.env.NVIDIA_MODEL = 'deepseek-ai/deepseek-v4-flash-0731';
    delete process.env.OPENROUTER_API_KEY;

    config = resolveAiProviderConfig();
    if (config.provider !== 'nvidia' || config.baseURL !== 'https://integrate.api.nvidia.com/v1' || config.model !== 'deepseek-ai/deepseek-v4-flash-0731') {
      throw new Error(`Test 2 Failed: expected nvidia config, got ${JSON.stringify(config)}`);
    }
    console.log('✔ PASS: Test 2: NVIDIA provider properly configured');

    // Test 3: BaseURL/Model Cross-Contamination Prevention
    process.env.AI_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-abcdef1234567890';
    process.env.OPENROUTER_BASE_URL = 'https://integrate.api.nvidia.com/v1'; // Invalid mismatch attempt
    process.env.OPENROUTER_MODEL = 'deepseek-ai/deepseek-v4-flash-0731';

    config = resolveAiProviderConfig();
    if (config.baseURL.includes('nvidia') || config.model.includes('deepseek')) {
      throw new Error(`Test 3 Failed: cross-contamination detected in OpenRouter config: ${JSON.stringify(config)}`);
    }
    console.log('✔ PASS: Test 3: OpenRouter cross-provider mismatch sanitized');

    console.log('\n====================================================');
    console.log('ALL PROVIDER API ROUTING TESTS PASSED (3/3)');
    console.log('====================================================\n');
  } finally {
    process.env = oldEnv;
  }
}

runTests();
