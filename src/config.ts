const env = import.meta.env;

export const config = {
  supabaseUrl: (env.VITE_SUPABASE_URL as string | undefined) ?? '',
  supabaseAnonKey: (env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '',
  demo: env.VITE_DEMO === '1' || !env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY,
};
