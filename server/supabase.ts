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



