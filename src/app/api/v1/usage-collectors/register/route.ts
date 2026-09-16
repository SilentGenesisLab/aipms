import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { COLLECTOR_VERSION, createCollectorSecret, hashCollectorSecret } from "@/lib/usage-collector";

const inputSchema = z.object({
  registrationCode: z.string().startsWith("chur_"),
  deviceId: z.string().min(8).max(120),
  deviceName: z.string().trim().min(1).max(120),
  platform: z.enum(["windows", "macos"]),
  clientVersion: z.string().trim().min(1).max(30).default(COLLECTOR_VERSION),
});

export async function POST(request: NextRequest) {
  const input = inputSchema.safeParse(await request.json());
  if (!input.success) return NextResponse.json({ error: "注册参数不正确" }, { status: 400 });
  const codeHash = hashCollectorSecret(input.data.registrationCode);
  const registration = await prisma.usageCollectorRegistration.findUnique({ where: { codeHash } });
  if (!registration || registration.usedAt || registration.expiresAt <= new Date()) return NextResponse.json({ error: "注册码无效、已使用或已过期" }, { status: 401 });
  const secret = createCollectorSecret("chud");
  const secretHash = hashCollectorSecret(secret);
  const device = await prisma.$transaction(async (tx) => {
    const consumed = await tx.usageCollectorRegistration.updateMany({ where: { id: registration.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (consumed.count !== 1) throw new Error("REGISTRATION_CONSUMED");
    const saved = await tx.usageCollectorDevice.upsert({
      where: { userId_deviceId: { userId: registration.userId, deviceId: input.data.deviceId } },
      create: { userId: registration.userId, deviceId: input.data.deviceId, name: input.data.deviceName, platform: input.data.platform, clientVersion: input.data.clientVersion, secretPrefix: secret.slice(0, 12), secretHash },
      update: { name: input.data.deviceName, platform: input.data.platform, clientVersion: input.data.clientVersion, secretPrefix: secret.slice(0, 12), secretHash, revokedAt: null, lastStatus: "REGISTERED", lastError: null },
    });
    await tx.auditLog.create({ data: { userId: registration.userId, actorType: "USER", action: "REGISTER_USAGE_COLLECTOR_DEVICE", resource: "USAGE_COLLECTOR_DEVICE", resourceId: saved.id, channel: "COLLECTOR", metadata: { platform: saved.platform, clientVersion: saved.clientVersion } } });
    return saved;
  }).catch((cause) => cause instanceof Error && cause.message === "REGISTRATION_CONSUMED" ? null : Promise.reject(cause));
  if (!device) return NextResponse.json({ error: "注册码已被使用" }, { status: 409 });
  return NextResponse.json({ deviceId: device.id, deviceSecret: secret, collectorVersion: COLLECTOR_VERSION }, { status: 201 });
}
