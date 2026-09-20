import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api-route";
import { authenticatedUserId } from "@/lib/web-auth";
import { forceCloseTask, taskForceCloseSchema } from "@/lib/task-workflow";

async function forceClose(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const userId = await authenticatedUserId(request);
  const { taskId } = await params;
  const parsed = taskForceCloseSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "请填写强制关闭原因" }, { status: 400 });
  if (!userId) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  const result = await forceCloseTask(taskId, userId, parsed.data);
  return result.ok
    ? NextResponse.json({ task: result.value })
    : NextResponse.json({ error: result.error }, { status: result.status });
}

export const POST = apiRoute("task:force_close", forceClose, { highRisk: true, idempotent: true });
