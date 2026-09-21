import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { loadTeamProfiles, projectNameResolver } from "@/lib/member-name";
import { getRequestUserId } from "@/lib/team-permissions";
import { getProjectAccess } from "@/lib/project-permissions";
import {
  buildCompletionTrend,
  calculateProjectProgress,
  selectCurrentVersion,
} from "@/lib/project-overview";

const TERMINAL_TASKS = new Set(["ACCEPTED", "DONE"]);
const CLOSED_BUGS = new Set(["CLOSED", "REJECTED"]);
const TERMINAL_MILESTONES = new Set(["COMPLETED", "CANCELLED"]);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const userId = await getRequestUserId(request);
  const { projectId } = await params;
  if (!userId) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const access = await getProjectAccess(projectId, userId);
  if (!access?.canAccess)
    return NextResponse.json({ error: "无权访问该项目" }, { status: 403 });

  const requestedDays = Number(request.nextUrl.searchParams.get("days") || 14);
  const days = [7, 14, 30].includes(requestedDays) ? requestedDays : 14;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      team: { select: { id: true, name: true } },
      members: {
        include: { user: { select: { id: true, name: true, avatarColor: true } } },
        orderBy: { role: "asc" },
      },
      requirements: { select: { id: true, status: true, targetVersionId: true } },
      tasks: {
        select: {
          id: true,
          code: true,
          title: true,
          status: true,
          priority: true,
          dueAt: true,
          completedAt: true,
          versionId: true,
          assignee: { select: { id: true, name: true } },
        },
      },
      bugs: {
        select: { id: true, status: true, severity: true, fixedVersionId: true },
      },
      versions: {
        select: { id: true, name: true, status: true, plannedAt: true, updatedAt: true },
      },
      milestones: {
        include: {
          owner: { select: { id: true, name: true, avatarColor: true } },
          version: { select: { id: true, name: true } },
        },
        orderBy: [{ dueAt: "asc" }, { sortOrder: "asc" }],
      },
    },
  });
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  // 人员一律显示项目/团队档案里的名字，别露出账号名（见 member-name.ts）。
  const person = projectNameResolver(project.members.map((member) => ({ userId: member.userId, displayName: member.displayName })), await loadTeamProfiles(project.teamId, project.members.map((member) => member.userId)));

  const progress = calculateProjectProgress(project);
  const currentVersion = selectCurrentVersion(project.versions);
  const versionProgress = currentVersion
    ? calculateProjectProgress({
        requirements: project.requirements.filter(
          (item) => item.targetVersionId === currentVersion.id,
        ),
        tasks: project.tasks.filter((item) => item.versionId === currentVersion.id),
        bugs: project.bugs.filter((item) => item.fixedVersionId === currentVersion.id),
        milestones: project.milestones.filter(
          (item) => item.versionId === currentVersion.id,
        ),
      })
    : null;
  const openTasks = project.tasks.filter((item) => !TERMINAL_TASKS.has(item.status));
  const openBugs = project.bugs.filter((item) => !CLOSED_BUGS.has(item.status));
  const now = new Date();
  const upcomingLimit = new Date(now.getTime() + 7 * 86_400_000);
  const overdueTasks = openTasks.filter((item) => item.dueAt && item.dueAt < now);
  const overdueMilestones = project.milestones.filter(
    (item) => !TERMINAL_MILESTONES.has(item.status) && item.dueAt < now,
  );
  const upcomingMilestones = project.milestones.filter(
    (item) =>
      !TERMINAL_MILESTONES.has(item.status) &&
      item.dueAt >= now &&
      item.dueAt <= upcomingLimit,
  );
  const seriousBugs = openBugs.filter(
    (item) => item.severity === "HIGH" || item.severity === "URGENT",
  );
  const attention = [
    overdueTasks.length
      ? { type: "warning", text: `${overdueTasks.length} 项任务已超过截止时间` }
      : null,
    seriousBugs.length
      ? { type: "danger", text: `${seriousBugs.length} 个高优先级 Bug 尚未关闭` }
      : null,
    overdueMilestones.length
      ? { type: "danger", text: `${overdueMilestones.length} 个里程碑已经延期` }
      : null,
    upcomingMilestones.length
      ? { type: "info", text: `${upcomingMilestones.length} 个里程碑将在 7 天内到期` }
      : null,
  ].filter(Boolean);
  const owner =
    project.members.find((member) => member.role === "OWNER") ||
    project.members.find((member) => member.role === "MANAGER") ||
    project.members[0] ||
    null;

  return NextResponse.json({
    project: {
      id: project.id,
      code: project.code,
      name: project.name,
      description: project.description,
      background: project.background,
      status: project.status,
      startDate: project.startDate,
      endDate: project.endDate,
      team: project.team,
      owner: person(owner?.user ?? null),
    },
    members: project.members.map((member) => ({
      id: member.user.id,
      name: person(member.user).name,
      avatarColor: member.user.avatarColor,
      role: member.role,
    })),
    versions: project.versions.map((version) => ({
      id: version.id,
      name: version.name,
      status: version.status,
    })),
    permissions: { canManage: access.canManage },
    kpis: {
      requirements: {
        total: project.requirements.length,
        completed: project.requirements.filter((item) => item.status === "DONE").length,
      },
      tasks: {
        total: project.tasks.length,
        active: openTasks.length,
        pendingAcceptance: project.tasks.filter(
          (item) => item.status === "PENDING_ACCEPTANCE",
        ).length,
      },
      bugs: {
        open: openBugs.length,
        serious: seriousBugs.length,
      },
    },
    progress,
    trend: buildCompletionTrend(
      days,
      project.tasks.flatMap((item) => (item.completedAt ? [item.completedAt] : [])),
    ),
    currentVersion: currentVersion
      ? {
          id: currentVersion.id,
          name: currentVersion.name,
          status: currentVersion.status,
          plannedAt: currentVersion.plannedAt,
          progress: versionProgress?.overall || 0,
        }
      : null,
    milestones: project.milestones.map((item) => ({
      ...item,
      owner: person(item.owner),
      overdue: !TERMINAL_MILESTONES.has(item.status) && item.dueAt < now,
      upcoming:
        !TERMINAL_MILESTONES.has(item.status) &&
        item.dueAt >= now &&
        item.dueAt <= upcomingLimit,
    })),
    attention,
    recentCompleted: project.tasks
      .filter((item) => item.completedAt)
      .sort((a, b) => b.completedAt!.getTime() - a.completedAt!.getTime())
      .slice(0, 5)
      .map((item) => ({
        id: item.id,
        code: item.code,
        title: item.title,
        completedAt: item.completedAt,
        assignee: person(item.assignee),
      })),
  });
}
