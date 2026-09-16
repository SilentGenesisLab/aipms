import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRequestUserId, isRateLimited } from "@/lib/team-permissions";
import { createCollectorSecret, hashCollectorSecret, publicBaseUrl } from "@/lib/usage-collector";

export async function POST(request: NextRequest) {
  const userId = await getRequestUserId(request);
  if (!userId) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (await isRateLimited(userId, "CREATE_USAGE_COLLECTOR_REGISTRATION", 6)) return NextResponse.json({ error: "生成过于频繁，请稍后再试" }, { status: 429 });
  const code = createCollectorSecret("chur");
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const registration = await prisma.$transaction(async (tx) => {
    await tx.usageCollectorRegistration.deleteMany({ where: { userId, usedAt: null, expiresAt: { lt: new Date() } } });
    const created = await tx.usageCollectorRegistration.create({ data: { userId, codeHash: hashCollectorSecret(code), expiresAt } });
    await tx.auditLog.create({ data: { userId, actorType: "USER", action: "CREATE_USAGE_COLLECTOR_REGISTRATION", resource: "USAGE_COLLECTOR", resourceId: created.id, channel: "WEB", metadata: { expiresAt: expiresAt.toISOString() } } });
    return created;
  });
  const baseUrl = publicBaseUrl(request);
  const windowsCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm '${baseUrl}/token-usage/install.ps1'))) '${baseUrl}' '${code}'"`;
  const macCommand = `curl -fsSL '${baseUrl}/token-usage/install.sh' | bash -s -- '${baseUrl}' '${code}'`;
  return NextResponse.json({ registrationId: registration.id, expiresAt, installCommand: windowsCommand, windowsCommand, macCommand });
}
