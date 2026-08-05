import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { requireEnv } from "@/lib/env";

const PUBLIC_PATHS = ["/login", "/auth/callback"];

// Cron endpoints authenticate themselves (Vercel Cron's CRON_SECRET
// bearer token) — they're not gated behind a user session, and never
// will be, since Vercel's scheduler can't hold a Brendan-logged-in
// browser cookie.
function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname) || pathname.startsWith("/api/cron/");
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = requireEnv("SUPABASE_URL", "SUPABASE_ANON_KEY");

  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() (not getSession()) so this is verified against Supabase,
  // not just trusting whatever's in the cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // GET covers both page routes and the OAuth start/callback routes,
    // which are reached by browser navigation (a link, then a
    // provider's redirect back) — a login redirect is the right UX for
    // both. Non-GET (e.g. the resync action) is only ever invoked
    // programmatically from an already-authenticated screen, so a 401
    // is more appropriate than bouncing a fetch() call through HTML.
    if (request.method !== "GET") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
