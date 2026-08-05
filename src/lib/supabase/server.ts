import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { requireEnv } from "@/lib/env";

// Session-bearing Supabase client (anon key + the user's auth cookies) —
// distinct from src/lib/storage.ts's service-role client, which never
// touches a user session and is used for server-side asset uploads only.
export async function createClient() {
  const cookieStore = await cookies();
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = requireEnv("SUPABASE_URL", "SUPABASE_ANON_KEY");

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component render, where cookies can't
          // be mutated — harmless because middleware.ts refreshes the
          // session cookie on every request anyway.
        }
      },
    },
  });
}
