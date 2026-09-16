import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

export const COLLECTOR_VERSION = "0.3.0";

export function hashCollectorSecret(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function createCollectorSecret(prefix: "chur" | "chud") {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export function safeHashEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function authenticateCollector(request: NextRequest) {
  const raw = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!raw.startsWith("chud_")) return null;
  const hash = hashCollectorSecret(raw);
  const device = await prisma.usageCollectorDevice.findUnique({ where: { secretHash: hash } });
  if (!device || device.revokedAt || !safeHashEqual(device.secretHash, hash)) return null;
  return device;
}

export function bigintNumber(value: bigint | null | undefined) {
  const number = Number(value || BigInt(0));
  return Number.isSafeInteger(number) ? number : value?.toString() || "0";
}

export function publicBaseUrl(request: NextRequest) {
  return process.env.APP_URL || `${request.nextUrl.protocol}//${request.nextUrl.host}`;
}
