import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

function getSupabaseCredentials(): { url: string; key: string; keySource: string } | null {
  const rawUrl =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_PROJECT_URL;

  let rawKey: string | undefined;
  let keySource = 'NONE';

  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    rawKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    keySource = 'SUPABASE_SERVICE_ROLE_KEY';
  } else if (process.env.SUPABASE_SERVICE_KEY) {
    rawKey = process.env.SUPABASE_SERVICE_KEY;
    keySource = 'SUPABASE_SERVICE_KEY';
  } else if (process.env.SUPABASE_KEY) {
    rawKey = process.env.SUPABASE_KEY;
    keySource = 'SUPABASE_KEY';
  } else if (process.env.SUPABASE_SECRET_KEY) {
    rawKey = process.env.SUPABASE_SECRET_KEY;
    keySource = 'SUPABASE_SECRET_KEY';
  } else if (process.env.SUPABASE_API_KEY) {
    rawKey = process.env.SUPABASE_API_KEY;
    keySource = 'SUPABASE_API_KEY';
  } else if (process.env.SUPABASE_ANON_KEY) {
    rawKey = process.env.SUPABASE_ANON_KEY;
    keySource = 'SUPABASE_ANON_KEY';
  } else if (process.env.VITE_SUPABASE_ANON_KEY) {
    rawKey = process.env.VITE_SUPABASE_ANON_KEY;
    keySource = 'VITE_SUPABASE_ANON_KEY';
  } else if (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    rawKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    keySource = 'NEXT_PUBLIC_SUPABASE_ANON_KEY';
  }

  if (!rawUrl || !rawKey) {
    return null;
  }

  let url = rawUrl.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  const key = rawKey.trim().replace(/^["']|["']$/g, '');

  if (!url || !key) {
    return null;
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }

  return { url, key, keySource };
}

function createSupabaseClientInstance(): SupabaseClient | null {
  const creds = getSupabaseCredentials();
  if (!creds) {
    return null;
  }

  try {
    const client = createClient(creds.url, creds.key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    console.log(`[Supabase] Initialized Supabase client (${creds.keySource}) with URL: ${creds.url}`);
    return client;
  } catch (err: any) {
    console.error('[Supabase] Failed to initialize Supabase client:', err?.message || err);
    return null;
  }
}

// Runtime cached instance
let runtimeSupabaseInstance: SupabaseClient | null = createSupabaseClientInstance();

if (!runtimeSupabaseInstance) {
  console.log(
    '[Supabase] SUPABASE_URL or key not set in environment. PersistentStorage is operating in resilient local-backup mode and will auto-persist to Supabase once configured.'
  );
}

// Temporary connectivity & backoff state
let consecutiveNetworkFailures = 0;
let supabaseBackoffUntil = 0;
let hasLoggedBackoff = false;

/**
 * Checks whether an error is a transport/network layer failure (e.g. fetch failed, DNS, timeout)
 */
export function isSupabaseTransportError(err: any): boolean {
  if (!err) return false;
  const msg = String(err?.message || err);
  const name = String(err?.name || '');
  const code = String(err?.code || '');

  return (
    (name === 'TypeError' && msg.includes('fetch failed')) ||
    msg.includes('fetch failed') ||
    msg.includes('UND_ERR') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('EAI_AGAIN') ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT'
  );
}

/**
 * Checks if Supabase is currently available (configured and not in network backoff)
 */
export function isSupabaseAvailable(): boolean {
  if (!isSupabaseConfigured()) {
    return false;
  }
  const now = Date.now();
  if (now < supabaseBackoffUntil) {
    return false;
  }
  if (hasLoggedBackoff) {
    console.log('[Supabase] Backoff cooldown expired. Attempting to resume Supabase persistence operations.');
    hasLoggedBackoff = false;
  }
  return true;
}

/**
 * Called when a Supabase operation succeeds to reset failure counters and backoff state
 */
export function recordSupabaseSuccess(): void {
  if (consecutiveNetworkFailures > 0 || supabaseBackoffUntil > 0) {
    console.log('[Supabase] Connection verified successfully. Cloud database synchronization active.');
  }
  consecutiveNetworkFailures = 0;
  supabaseBackoffUntil = 0;
  hasLoggedBackoff = false;
}

/**
 * Called when a Supabase operation fails. If it is a transport-level failure, triggers exponential backoff.
 */
export function recordSupabaseError(err: any, context?: string): void {
  if (!isSupabaseTransportError(err)) {
    // Normal database/query error (e.g. 400 Bad Request, schema mismatch) - log without triggering network backoff
    const ctx = context ? ` [${context}]` : '';
    console.warn(`[Supabase Error]${ctx}:`, err?.message || err);
    return;
  }

  consecutiveNetworkFailures++;
  // Exponential backoff: 15s -> 30s -> 60s -> 120s -> 240s, capped at 300s (5 minutes)
  const backoffSeconds = Math.min(300, 15 * Math.pow(2, Math.min(consecutiveNetworkFailures - 1, 5)));
  supabaseBackoffUntil = Date.now() + (backoffSeconds * 1000);

  if (!hasLoggedBackoff || consecutiveNetworkFailures === 1 || consecutiveNetworkFailures % 10 === 0) {
    const ctx = context ? ` during ${context}` : '';
    console.warn(
      `[Supabase] Network transport failure${ctx} (${err?.message || 'fetch failed'}). ` +
      `Entering temporary backoff for ${backoffSeconds}s (failures: ${consecutiveNetworkFailures}). ` +
      `Local JSON persistence remains primary and 100% active.`
    );
    hasLoggedBackoff = true;
  }
}

/**
 * Safely executes a Supabase query with automatic backoff and transport failure suppression.
 * Returns null if in backoff or if network transport fails.
 */
export async function executeSupabaseQuery<T = any>(
  queryFn: (client: SupabaseClient) => PromiseLike<{ data?: T; error?: any } | any> | Promise<{ data?: T; error?: any } | any> | any,
  context?: string
): Promise<{ data?: T; error?: any } | null> {
  if (!isSupabaseAvailable()) {
    return null;
  }
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    const res = await queryFn(client);
    if (res && res.error) {
      if (isSupabaseTransportError(res.error)) {
        recordSupabaseError(res.error, context);
        return null;
      }
      if (context) {
        console.warn(`[Supabase Error] [${context}]:`, res.error?.message || res.error);
      }
      return res;
    }
    recordSupabaseSuccess();
    return res;
  } catch (err: any) {
    recordSupabaseError(err, context);
    return null;
  }
}

export function isSupabaseConfigured(): boolean {
  if (!runtimeSupabaseInstance) {
    runtimeSupabaseInstance = createSupabaseClientInstance();
  }
  return runtimeSupabaseInstance !== null;
}

export function getSupabaseClient(): SupabaseClient | null {
  if (!runtimeSupabaseInstance) {
    runtimeSupabaseInstance = createSupabaseClientInstance();
  }
  return runtimeSupabaseInstance;
}

// Export the real SupabaseClient instance or null when unconfigured
export const supabase: SupabaseClient | null = runtimeSupabaseInstance;



