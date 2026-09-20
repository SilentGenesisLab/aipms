import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateApiIdentity, type ApiPrincipal } from "@/lib/api-auth";
import { hasApiPermission, type ApiTokenPermission } from "@/lib/api-token-permissions";
import { runAsApiActor } from "@/lib/api-request-context";

type RouteHandler<TContext = unknown> = (request: never, context: TContext) => Response | undefined | Promise<Response | undefined>;
type PermissionResolver = ApiTokenPermission | ((request: Request) => ApiTokenPermission | Promise<ApiTokenPermission>);

type ApiRouteOptions = {
  idempotent?: boolean;
  highRisk?: boolean;
  confirm?: (body: unknown, context: unknown) => string | null | Promise<string | null>;
  paginateKey?: string;
};

export function apiError(message: string, status: number, code: string, requestId = randomUUID(), details?: unknown) {
  return NextResponse.json(
    { error: message, code, requestId, ...(details === undefined ? {} : { details }) },
    { status, headers: { "X-Request-Id": requestId } },
  );
}

async function auditDenied(auth: ApiPrincipal | null, request: Request, message: string, status: number) {
  await prisma.auditLog.create({
    data: {
      userId: auth?.userId,
      actorType: "USER",
      action: "API_REQUEST_DENIED",
      resource: "API",
      channel: "API_KEY",
      metadata: {
        tokenId: auth?.id,
        tokenName: auth?.name,
        tokenPrefix: auth?.prefix,
        result: "DENIED",
        reason: message,
        status,
        requestMethod: request.method,
        requestPath: new URL(request.url).pathname,
      },
    },
  });
}

async function rateLimited(auth: ApiPrincipal, request: Request, highRisk: boolean) {
  const limit = highRisk ? 100 : request.method === "GET" || request.method === "HEAD" ? 120 : 30;
  const count = await prisma.auditLog.count({
    where: {
      userId: auth.userId,
      channel: "API_KEY",
      createdAt: { gte: new Date(Date.now() - 60_000) },
      metadata: { path: ["tokenId"], equals: auth.id },
    },
  });
  return count >= limit ? limit : null;
}

function requestHash(request: Request, body: string) {
  const path = new URL(request.url).pathname;
  return createHash("sha256").update(`${request.method}\n${path}\n${body}`).digest("hex");
}

function parseCursor(value: string | null) {
  if (!value) return 0;
  try {
    const parsed = Number(Buffer.from(value, "base64url").toString("utf8"));
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  } catch { return 0; }
}

async function paginate(response: Response, request: Request, key: string) {
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return response;
  const body = await response.clone().json() as Record<string, unknown>;
  const rows = body[key];
  if (!Array.isArray(rows)) return response;
  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const offset = parseCursor(url.searchParams.get("cursor"));
  const items = rows.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return NextResponse.json(
    { ...body, [key]: items, pagination: { limit, nextCursor: nextOffset < rows.length ? Buffer.from(String(nextOffset)).toString("base64url") : null } },
    { status: response.status, headers: response.headers },
  );
}

export function apiRoute<TContext>(permission: PermissionResolver, handler: RouteHandler<TContext>, options: ApiRouteOptions = {}) {
  return async (request: Request, context: TContext) => {
    const requestId = randomUUID();
    const auth = await authenticateApiIdentity(request);
    if (!auth) {
      await auditDenied(null, request, "无效、过期或已撤销的 API Key", 401).catch(() => undefined);
      return apiError("无效、过期或已撤销的 API Key", 401, "INVALID_API_KEY", requestId);
    }
    const required = typeof permission === "function" ? await permission(request) : permission;
    if (!hasApiPermission(auth.permissions, required)) {
      await auditDenied(auth, request, `缺少权限 ${required}`, 403).catch(() => undefined);
      return apiError(`API Key 缺少权限：${required}`, 403, "INSUFFICIENT_TOKEN_PERMISSION", requestId);
    }
    if (await rateLimited(auth, request, Boolean(options.highRisk))) {
      await auditDenied(auth, request, "请求频率超过限制", 429).catch(() => undefined);
      const response = apiError("请求过于频繁，请稍后重试", 429, "RATE_LIMITED", requestId);
      response.headers.set("Retry-After", "60");
      return response;
    }

    const bodyText = request.method === "GET" || request.method === "HEAD" ? "" : await request.clone().text();
    let body: unknown = undefined;
    if (bodyText) {
      try { body = JSON.parse(bodyText); } catch { body = undefined; }
    }
    if (options.confirm) {
      const error = await options.confirm(body, context);
      if (error) return apiError(error, 400, "CONFIRMATION_REQUIRED", requestId);
    }

    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
    const hash = requestHash(request, bodyText);
    if (options.idempotent) {
      if (idempotencyKey.length < 8 || idempotencyKey.length > 128)
        return apiError("该操作需要 8–128 个字符的 Idempotency-Key", 400, "IDEMPOTENCY_KEY_REQUIRED", requestId);
      const existing = await prisma.apiIdempotencyRecord.findUnique({
        where: { tokenId_key: { tokenId: auth.id, key: idempotencyKey } },
      });
      if (existing && existing.expiresAt > new Date()) {
        if (existing.requestHash !== hash)
          return apiError("同一 Idempotency-Key 不能用于不同请求", 409, "IDEMPOTENCY_KEY_CONFLICT", requestId);
        return NextResponse.json(existing.response, {
          status: existing.status,
          headers: { "Idempotency-Replayed": "true", "X-Request-Id": requestId },
        });
      }
      if (existing) await prisma.apiIdempotencyRecord.delete({ where: { id: existing.id } });
    }

    const startedAt = new Date();
    let response = await runAsApiActor({
      id: auth.id,
      userId: auth.userId,
      name: auth.name,
      prefix: auth.prefix,
      requestMethod: request.method,
      requestPath: new URL(request.url).pathname,
    }, () => handler(request as never, context));
    if (!response) response = apiError("接口未返回有效响应", 500, "EMPTY_HANDLER_RESPONSE", requestId);
    if (options.paginateKey) response = await paginate(response, request, options.paginateKey);

    const businessAudit = await prisma.auditLog.count({
      where: {
        userId: auth.userId,
        channel: "API_KEY",
        createdAt: { gte: startedAt },
        metadata: { path: ["tokenId"], equals: auth.id },
      },
    });
    if (!businessAudit) {
      await prisma.auditLog.create({
        data: {
          userId: auth.userId,
          actorType: "USER",
          action: response.ok ? (request.method === "GET" ? "API_READ" : "API_WRITE") : "API_REQUEST_FAILED",
          resource: "API",
          channel: "API_KEY",
          metadata: {
            tokenId: auth.id,
            tokenName: auth.name,
            tokenPrefix: auth.prefix,
            result: response.ok ? "SUCCESS" : "FAILED",
            status: response.status,
            requestMethod: request.method,
            requestPath: new URL(request.url).pathname,
          },
        },
      });
    }

    if (options.idempotent && response.headers.get("content-type")?.includes("application/json") && response.status < 500) {
      const responseBody = await response.clone().json();
      await prisma.apiIdempotencyRecord.create({
        data: {
          tokenId: auth.id,
          userId: auth.userId,
          key: idempotencyKey,
          method: request.method,
          path: new URL(request.url).pathname,
          requestHash: hash,
          status: response.status,
          response: responseBody,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      }).catch(() => undefined);
    }
    response.headers.set("X-Request-Id", requestId);
    return response;
  };
}
