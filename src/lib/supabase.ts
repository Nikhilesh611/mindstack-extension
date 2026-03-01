import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
        'Missing Supabase environment variables. Please fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env'
    );
}

/**
 * Supabase client configured for Chrome extension popup use.
 *
 * We disable session persistence and auto-refresh because:
 * 1. Chrome extension popups have a transient/ephemeral localStorage — each
 *    time the popup opens it's a fresh JS context, so any previously-stored
 *    refresh token is gone.
 * 2. When the Supabase client found a stale entry and tried to refresh it,
 *    Supabase rejected the (now-invalid) refresh token with:
 *    "AuthApiError: Invalid Refresh Token: Refresh Token Not Found"
 *
 * Our extension manages its own auth state via chrome.storage.local (storing
 * only the access_token / JWT). Supabase is used purely for one-shot
 * signIn / signUp calls; everything else goes through our own API backend.
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
        persistSession: false,    // don't write to localStorage at all
        autoRefreshToken: false,  // never attempt background token refresh
        detectSessionInUrl: false, // not needed in an extension popup
    },
});
