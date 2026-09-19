import { NextResponse } from "next/server";
import { TaskStatus } from "@prisma/client";
import { authenticateApi } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { auditApiCall } from "@/lib/api-audit";

const listParam = (url: URL, name: string) =>
  (url.searchParams.get(name) || "").split(",").map((value) => value.trim()).filter(Boolean);

const TASK_STATUS_VALUES = Object.values(TaskStatus) as string[];

export async function GET(request: Request) {
  const auth = await authenticateApi(request, "task:read");
  if (!auth) return NextResponse.json({ error: "无效或已过期的 API Key" }, { status: 401 });
  const url = new URL(request.url);
  const projectFilter = (url.searchParams.get("project") || "").trim();
  const statuses = listParam(url, "status");
  // Reject an unknown status rather than quietly returning an empty list, which
  // reads to the caller as "you have nothing to do".
  const unknownStatuses = statuses.filter((value) => !TASK_STATUS_VALUES.includes(value));
  if (unknownStatuses.length) return NextResponse.json({ error: `不支持的任务状态：${unknownStatuses.join("、")}`, allowed: TASK_STATUS_VALUES }, { status: 400 });
  const fields = listParam(url, "fields");
  const limit = Number(url.searchParams.get("limit"));
  const take = Number.isInteger(limit) && limit > 0 ? limit : undefined;
  const projects = await prisma.project.findMany({
    where: { OR: [
      { members: { some: { userId: auth.userId } } },
      { team: { members: { some: { userId: auth.userId, role: { in: ["OWNER", "ADMIN"] } } } } },
    ] },
    select: { id: true, code: true },
  });
  // Accept either a project id or its code; an unmatched filter yields no tasks
  // rather than silently falling back to every project.
  const matched = projectFilter
    ? projects.filter((project) => project.id === projectFilter || project.code.toLowerCase() === projectFilter.toLowerCase())
    : projects;
  const scopedIds = matched.map((project) => project.id);
  const where = { assigneeId: auth.userId, projectId: { in: scopedIds }, ...(statuses.length ? { status: { in: statuses as TaskStatus[] } } : {}) };
  const tasks = await prisma.task.findMany({
    where,
    include: { project: { select: { code: true, name: true } }, coordinator: { select: { id: true, name: true } }, acceptor: { select: { id: true, name: true } }, dependencies: { include: { dependsOn: { select: { code: true, title: true, status: true } } } }, version: { select: { name: true } } },
    orderBy: [{ dueAt: "asc" }, { priority: "desc" }],
    ...(take ? { take } : {}),
  });
  // Report the match count so a caller can ask "how many" without walking the
  // list. Only costs a second query when the caller actually limited results.
  const total = take ? await prisma.task.count({ where }) : tasks.length;
  // A task carries a lot of prose (description, acceptance criteria). Callers
  // that only need to triage can project the response down to a few keys
  // instead of pulling tens of kilobytes and filtering it themselves.
  const items = fields.length
    ? tasks.map((task) => Object.fromEntries(fields.filter((field) => field in task).map((field) => [field, (task as Record<string, unknown>)[field]])))
    : tasks;
  await auditApiCall({ auth, action: "READ_WORK_CONTEXT", resource: "TASK", request, details: { taskCount: items.length, projectCount: scopedIds.length, project: projectFilter || null, status: statuses } });
  return NextResponse.json({ user: { id: auth.user.id, name: auth.user.name }, generatedAt: new Date(), total, tasks: items });
}
