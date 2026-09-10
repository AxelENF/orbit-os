import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { hasSupabaseBrowserConfig } from "@/lib/supabase/client";

export async function proxy(request: NextRequest) {
  if (!hasSupabaseBrowserConfig()) return NextResponse.next();

  const response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const pathname = request.nextUrl.pathname;
  if (!user && pathname.startsWith("/api/")) return response;
  if (!user && pathname !== "/login") {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    "/library",
    "/library/:path*",
    "/drafts",
    "/drafts/:path*",
    "/review",
    "/review/:path*",
    "/history",
    "/history/:path*",
    "/onboarding",
    "/onboarding/:path*",
    "/settings",
    "/settings/:path*",
    "/api/content",
    "/api/content/:path*",
    "/api/organizations",
    "/api/organizations/:path*",
  ],
};
