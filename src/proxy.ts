import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

const PUBLIC_PAGES = new Set(["/login", "/register"]);
const PUBLIC_API_PREFIXES = ["/api/auth/", "/api/health", "/api/v1/", "/api/files", "/api/internal/"];

function safeNext(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : null;
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname === "/members" || pathname.startsWith("/members/")) return NextResponse.redirect(new URL(pathname.replace(/^\/members/, "/teams"), request.url), 308);
  const isInvitePage = pathname.startsWith("/invite/");
  const isSharePage = pathname.startsWith("/share/");
  const isPublic = PUBLIC_PAGES.has(pathname) || pathname === "/cli" || pathname === "/cli/guide" || pathname === "/cli/skill" || pathname === "/cli/install.ps1" || pathname.startsWith("/token-usage/") || isInvitePage || isSharePage || pathname.startsWith("/api/invites/") || pathname.startsWith("/api/shares/") || PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  const userId = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);

  if (!userId && !isPublic) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const login = new URL("/login", request.url);
    login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }
  if (userId && PUBLIC_PAGES.has(pathname)) return NextResponse.redirect(new URL(safeNext(request.nextUrl.searchParams.get("next")) || "/", request.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
