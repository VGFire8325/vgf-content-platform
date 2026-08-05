import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Supabase redirects here after the magic-link click, with a `code` to
// exchange for a session — see emailRedirectTo in app/login/actions.ts.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL("/review", url.origin));
    }
  }

  return NextResponse.redirect(new URL("/login?error=1", url.origin));
}
