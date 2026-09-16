import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;

let supabaseInstance: SupabaseClient | null = null;

if (supabaseUrl && supabaseKey) {
  try {
    supabaseInstance = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    console.log('[Supabase] Initialized Supabase client with URL:', supabaseUrl);
  } catch (err) {
    console.error('[Supabase] Failed to initialize Supabase client:', err);
  }
} else {
  console.log(
    '[Supabase] SUPABASE_URL or key not set in environment. PersistentStorage is operating in resilient local-backup mode and will auto-persist to Supabase once configured.'
  );
}

export const supabase = supabaseInstance;

export function isSupabaseConfigured(): boolean {
  return supabaseInstance !== null;
}

export function getSupabaseClient(): SupabaseClient | null {
  return supabaseInstance;
}
