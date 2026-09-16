import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

function getSupabaseCredentials(): { url: string; key: string; keySource: string } | null {
  const rawUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

  let rawKey: string | undefined;
  let keySource = 'NONE';

  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    rawKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    keySource = 'SUPABASE_SERVICE_ROLE_KEY';
  } else if (process.env.SUPABASE_KEY) {
    rawKey = process.env.SUPABASE_KEY;
    keySource = 'SUPABASE_KEY';
  } else if (process.env.SUPABASE_ANON_KEY) {
    rawKey = process.env.SUPABASE_ANON_KEY;
    keySource = 'SUPABASE_ANON_KEY';
  } else if (process.env.VITE_SUPABASE_ANON_KEY) {
    rawKey = process.env.VITE_SUPABASE_ANON_KEY;
    keySource = 'VITE_SUPABASE_ANON_KEY';
  }

  if (!rawUrl || !rawKey) {
    return null;
  }

  const url = rawUrl.trim().replace(/^["']|["']$/g, '');
  const key = rawKey.trim().replace(/^["']|["']$/g, '');

  if (!url || !key) {
    return null;
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return null;
  }

  return { url, key, keySource };
}

let supabaseInstance: SupabaseClient | null = null;
let loggedStatus = false;

function initSupabase(): SupabaseClient | null {
  if (supabaseInstance) {
    return supabaseInstance;
  }

  const creds = getSupabaseCredentials();
  if (!creds) {
    if (!loggedStatus) {
      console.log(
        '[Supabase] SUPABASE_URL or key not set in environment. PersistentStorage is operating in resilient local-backup mode and will auto-persist to Supabase once configured.'
      );
      loggedStatus = true;
    }
    return null;
  }

  try {
    supabaseInstance = createClient(creds.url, creds.key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    if (!loggedStatus) {
      console.log(`[Supabase] Initialized Supabase client (${creds.keySource}) with URL: ${creds.url}`);
      loggedStatus = true;
    }
    return supabaseInstance;
  } catch (err: any) {
    console.error('[Supabase] Failed to initialize Supabase client:', err?.message || err);
    return null;
  }
}

// Initialize on module load
initSupabase();

export function isSupabaseConfigured(): boolean {
  return initSupabase() !== null;
}

export function getSupabaseClient(): SupabaseClient | null {
  return initSupabase();
}

// Exported client proxy that always delegates to the live initialized instance
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = initSupabase();
    if (!client) {
      return undefined;
    }
    const val = (client as any)[prop];
    return typeof val === 'function' ? val.bind(client) : val;
  },
});

