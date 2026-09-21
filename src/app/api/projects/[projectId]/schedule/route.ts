import { NextRequest, NextResponse } from "next/server";
import { loadTeamProfiles, projectNameResolver } from "@/lib/member-name";
import { getProjectAccess } from "@/lib/project-permissions";
import { naturalDays, hasDependencyConflict, scheduleHealth } from "@/lib/project-schedule";
import { getRequestUserId } from "@/lib/team-permissions";
import { prisma } from "@/lib/prisma";

const MAX_RANGE = 366 * 86_400_000;

type PersonResolver = ReturnType<typeof projectNameResolver>;

function serializeTask(task: Awaited<ReturnType<typeof loadTasks>>[number], now: Date, person: PersonResolver) {
  return {
    id: task.id,
    code: task.code,
    title: task.title,
    status: task.status,
    priority: task.priority,
    requirementId: task.requirementId,
    plannedStartAt: task.plannedStartAt?.toISOString() || null,
    dueAt: task.dueAt?.toISOString() || null,
    startedAt: task.startedAt?.toISOString() || null,
    closedAt: task.closedAt?.toISOString() || null,
    plannedDays: naturalDays(task.plannedStartAt, task.dueAt),
    actualDays: naturalDays(task.startedAt, task.closedAt || (task.startedAt ? now : null)),
    health: scheduleHealth(task, now),
    dependencyConflict: hasDependencyConflict(task),
    assignee: person(task.assignee),
    dependencyIds: task.dependencies.map((item) => item.dependsOnId),
  };
}

function loadTasks(projectId: string) {
  return prisma.task.findMany({
    where: { projectId },
    include: {
      assignee: { select: { id: true, name: true, avatarColor: true } },
      dependencies: { include: { dependsOn: { select: { dueAt: true, status: true } } } },
    },
    orderBy: [{ plannedStartAt: "asc" }, { createdAt: "asc" }],
  });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  const userId = await getRequestUserId(request);
  const { projectId } = await params;
  if (!userId) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const access = await getProjectAccess(projectId, userId);
  if (!access?.canAccess) return NextResponse.json({ error: "无权访问该项目" }, { status: 403 });

  const from = new Date(request.nextUrl.searchParams.get("from") || "");
  const to = new Date(request.nextUrl.searchParams.get("to") || "");
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from || to.getTime() - from.getTime() > MAX_RANGE)
    return NextResponse.json({ error: "排期范围无效，最长可查询一年" }, { status: 400 });

  const statuses = new Set(request.nextUrl.searchParams.getAll("status"));
  const assigneeId = request.nextUrl.searchParams.get("assigneeId");
  const includeUnscheduled = request.nextUrl.searchParams.get("includeUnscheduled") !== "false";
  const [requirements, rawTasks, members] = await Promise.all([
    prisma.requirement.findMany({
      where: { projectId },
      include: {
        requester: { select: { id: true, name: true, avatarColor: true } },
        owner: { select: { id: true, name: true, avatarColor: true } },
        participants: { include: { user: { select: { id: true, name: true, avatarColor: true } } } },
        targetVersion: { select: { id: true, name: true } },
      },
      orderBy: [{ plannedStartAt: "asc" }, { createdAt: "asc" }],
    }),
    loadTasks(projectId),
    prisma.projectMember.findMany({ where: { projectId }, select: { displayName: true, user: { select: { id: true, name: true } } }, orderBy: { user: { name: "asc" } } }),
  ]);
  const now = new Date();
  // 同工作区：负责人/提出者一律走团队档案里的中文名，别把账号名（zhimingzeng）露出来。id 不变，
  // 「全部负责人」筛选仍是按 id 过滤。
  const person = projectNameResolver(members.map((member) => ({ userId: member.user.id, displayName: member.displayName })), await loadTeamProfiles(access.project.teamId, members.map((member) => member.user.id)));
  // 只填了一端（线上绝大多数就是只填截止时间）也算已排期：按落在那一端的那一天取值，
  // 而不是当成「没排期」塞进 includeUnscheduled 的兜底里。
  const overlaps = (start: Date | null, end: Date | null) => {
    if (!start && !end) return includeUnscheduled;
    return (start || end!) < to && (end || start!) >= from;
  };
  const tasks = rawTasks.filter((task) =>
    (!statuses.size || statuses.has(task.status)) &&
    (!assigneeId || task.assigneeId === assigneeId) &&
    overlaps(task.plannedStartAt, task.dueAt),
  );
  const visibleTaskIds = new Set(tasks.map((task) => task.id));
  const result = requirements.flatMap((requirement) => {
    const children = tasks.filter((task) => task.requirementId === requirement.id);
    const visible = (!statuses.size || statuses.has(requirement.status)) && (!assigneeId || requirement.ownerId === assigneeId) && overlaps(requirement.plannedStartAt, requirement.dueAt);
    if (!visible && !children.length) return [];
    const allChildren = rawTasks.filter((task) => task.requirementId === requirement.id);
    const completed = allChildren.filter((task) => task.status === "DONE" || task.status === "ACCEPTED").length;
    return [{
      id: requirement.id,
      code: requirement.code,
      title: requirement.title,
      status: requirement.status,
      priority: requirement.priority,
      description: requirement.description,
      acceptanceCriteria: requirement.acceptanceCriteria,
      plannedStartAt: requirement.plannedStartAt?.toISOString() || null,
      dueAt: requirement.dueAt?.toISOString() || null,
      startedAt: requirement.startedAt?.toISOString() || null,
      closedAt: requirement.closedAt?.toISOString() || null,
      plannedDays: naturalDays(requirement.plannedStartAt, requirement.dueAt),
      actualDays: naturalDays(requirement.startedAt, requirement.closedAt || (requirement.startedAt ? now : null)),
      health: scheduleHealth(requirement, now),
      progress: allChildren.length ? Math.round(completed / allChildren.length * 100) : null,
      requester: person(requirement.requester),
      owner: person(requirement.owner),
      participants: requirement.participants.map(({ user }) => person(user)),
      targetVersion: requirement.targetVersion,
      tasks: children.map((task) => serializeTask(task, now, person)),
    }];
  });
  const unassignedTasks = tasks.filter((task) => !task.requirementId && visibleTaskIds.has(task.id)).map((task) => serializeTask(task, now, person));
  return NextResponse.json({
    generatedAt: now.toISOString(),
    range: { from: from.toISOString(), to: to.toISOString() },
    permissions: { canWrite: Boolean(access.canManage || (access.projectMember && access.projectMember.role !== "GUEST")) },
    members: members.map(({ user }) => user),
    requirements: result,
    unassignedTasks,
  });
}
