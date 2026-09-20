import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { calculateProjectProgress, selectCurrentVersion, shanghaiDay } from "@/lib/project-overview";

export type ProjectActivityMetrics = Awaited<ReturnType<typeof buildProjectActivityMetrics>>;

const CLOSED_BUGS = new Set(["CLOSED", "REJECTED"]);
const TERMINAL_TASKS = new Set(["ACCEPTED", "DONE"]);
const TERMINAL_MILESTONES = new Set(["COMPLETED", "CANCELLED"]);

export function projectWeek(value: Date | string = new Date()) {
  const key = typeof value === "string" ? value.slice(0, 10) : shanghaiDay(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new Error("周日期格式无效");
  const calendar = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const offset = (calendar.getUTCDay() + 6) % 7;
  calendar.setUTCDate(calendar.getUTCDate() - offset);
  const monday = calendar.toISOString().slice(0, 10);
  const start = new Date(`${monday}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  return { key: monday, start, end };
}

function averageHours<T>(items: T[], start: (item: T) => Date, end: (item: T) => Date) {
  if (!items.length) return null;
  return Math.round(items.reduce((sum, item) => sum + Math.max(0, end(item).getTime() - start(item).getTime()), 0) / items.length / 3_600_000 * 10) / 10;
}

function isFileAction(action: string) {
  return action.includes("FILE") || action.includes("FOLDER") || action.includes("UPLOAD");
}

export async function buildProjectActivityMetrics(projectId: string, weekStart: Date, weekEnd: Date, asOf = new Date()) {
  const [project, completedRequirements, completedTasks, createdRequirements, createdBugs, closedBugs, releases, audits, manualRisks] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      include: {
        members: { include: { user: { select: { id: true, name: true, avatarColor: true } } } },
        requirements: { select: { id: true, status: true, targetVersionId: true } },
        tasks: { select: { id: true, code: true, title: true, status: true, priority: true, createdAt: true, firstCompletedAt: true, dueAt: true, versionId: true, assigneeId: true, assignee: { select: { id: true, name: true } } } },
        bugs: { select: { id: true, code: true, title: true, status: true, severity: true, fixedVersionId: true, closedAt: true } },
        versions: { select: { id: true, name: true, status: true, plannedAt: true, updatedAt: true } },
        milestones: { select: { id: true, title: true, status: true, dueAt: true, versionId: true, owner: { select: { id: true, name: true } } } },
      },
    }),
    prisma.requirement.findMany({ where: { projectId, closedAt: { gte: weekStart, lt: weekEnd } }, select: { id: true, code: true, title: true, createdAt: true, closedAt: true, requesterId: true, requester: { select: { id: true, name: true } } } }),
    prisma.task.findMany({ where: { projectId, firstCompletedAt: { gte: weekStart, lt: weekEnd } }, select: { id: true, code: true, title: true, createdAt: true, firstCompletedAt: true, assigneeId: true, assignee: { select: { id: true, name: true } } } }),
    prisma.requirement.findMany({ where: { projectId, createdAt: { gte: weekStart, lt: weekEnd } }, select: { requesterId: true, requester: { select: { id: true, name: true } } } }),
    prisma.bug.count({ where: { projectId, createdAt: { gte: weekStart, lt: weekEnd } } }),
    prisma.bug.findMany({ where: { projectId, closedAt: { gte: weekStart, lt: weekEnd } }, select: { id: true, code: true, title: true, closedAt: true } }),
    prisma.release.findMany({ where: { projectId, releasedAt: { gte: weekStart, lt: weekEnd } }, include: { version: { select: { id: true, name: true } } }, orderBy: { releasedAt: "desc" } }),
    prisma.auditLog.findMany({ where: { projectId, createdAt: { gte: weekStart, lt: weekEnd }, userId: { not: null } }, select: { userId: true, action: true } }),
    prisma.projectRisk.findMany({
      where: { projectId, createdAt: { lt: weekEnd }, OR: [{ resolvedAt: null }, { resolvedAt: { gte: weekStart } }] },
      include: { owner: { select: { id: true, name: true, avatarColor: true } }, createdBy: { select: { id: true, name: true } } },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
    }),
  ]);

  const currentVersion = selectCurrentVersion(project.versions);
  const versionProgress = currentVersion ? calculateProjectProgress({
    requirements: project.requirements.filter((item) => item.targetVersionId === currentVersion.id),
    tasks: project.tasks.filter((item) => item.versionId === currentVersion.id),
    bugs: project.bugs.filter((item) => item.fixedVersionId === currentVersion.id),
    milestones: project.milestones.filter((item) => item.versionId === currentVersion.id),
  }) : null;
  const versionScope = currentVersion ? {
    requirements: project.requirements.filter((item) => item.targetVersionId === currentVersion.id).length,
    tasks: project.tasks.filter((item) => item.versionId === currentVersion.id).length,
    bugs: project.bugs.filter((item) => item.fixedVersionId === currentVersion.id).length,
  } : { requirements: 0, tasks: 0, bugs: 0 };

  const requesterMap = new Map<string, { userId: string | null; name: string; count: number }>();
  for (const item of createdRequirements) {
    const id = item.requesterId || "unknown";
    const row = requesterMap.get(id) || { userId: item.requesterId, name: item.requester?.name || "未指定提出者", count: 0 };
    row.count++;
    requesterMap.set(id, row);
  }

  const activity = new Map(project.members.map((member) => [member.userId, {
    id: member.userId,
    userId: member.userId,
    name: member.user.name,
    avatarColor: member.user.avatarColor,
    created: 0,
    updated: 0,
    completed: 0,
    reports: 0,
    acceptances: 0,
    files: 0,
    total: 0,
  }]));
  for (const log of audits) {
    const row = log.userId ? activity.get(log.userId) : null;
    if (!row) continue;
    if (isFileAction(log.action)) row.files++;
    else if (log.action === "SUBMIT_REPORT") row.reports++;
    else if (log.action.includes("ACCEPT") || log.action === "CLOSE_TASK" || log.action === "REJECT_TASK_ACCEPTANCE" || log.action === "FORCE_CLOSE_TASK") row.acceptances++;
    else if (log.action.startsWith("CREATE_")) row.created++;
    else row.updated++;
  }
  for (const task of completedTasks) {
    const row = task.assigneeId ? activity.get(task.assigneeId) : null;
    if (row) row.completed++;
  }
  for (const row of activity.values()) row.total = row.created + row.updated + row.completed + row.reports + row.acceptances + row.files;

  const openTasks = project.tasks.filter((item) => !TERMINAL_TASKS.has(item.status));
  const openBugs = project.bugs.filter((item) => !CLOSED_BUGS.has(item.status));
  const autoRisks: Array<{ type: string; level: "info" | "warning" | "danger"; title: string; detail: string }> = [];
  const overdueTasks = openTasks.filter((item) => item.dueAt && item.dueAt < asOf);
  if (overdueTasks.length) autoRisks.push({ type: "OVERDUE_TASK", level: "warning", title: `${overdueTasks.length} 项任务逾期`, detail: overdueTasks.slice(0, 3).map((item) => `${item.code} ${item.title}`).join("、") });
  const seriousBugs = openBugs.filter((item) => item.severity === "HIGH" || item.severity === "URGENT");
  if (seriousBugs.length) autoRisks.push({ type: "SERIOUS_BUG", level: "danger", title: `${seriousBugs.length} 个高优先级 Bug 未关闭`, detail: seriousBugs.slice(0, 3).map((item) => `${item.code} ${item.title}`).join("、") });
  const delayedMilestones = project.milestones.filter((item) => !TERMINAL_MILESTONES.has(item.status) && item.dueAt < asOf);
  if (delayedMilestones.length) autoRisks.push({ type: "DELAYED_MILESTONE", level: "danger", title: `${delayedMilestones.length} 个里程碑延期`, detail: delayedMilestones.slice(0, 3).map((item) => item.title).join("、") });
  if (currentVersion?.plannedAt && currentVersion.plannedAt < asOf && !["RELEASED", "ARCHIVED", "CANCELLED"].includes(currentVersion.status)) autoRisks.push({ type: "VERSION_OVERDUE", level: "danger", title: `${currentVersion.name} 已超过计划发布日期`, detail: `当前状态 ${currentVersion.status}，范围完成度 ${versionProgress?.overall || 0}%` });
  const weekAhead = new Date(asOf.getTime() + 7 * 86_400_000);
  if (currentVersion?.plannedAt && currentVersion.plannedAt >= asOf && currentVersion.plannedAt <= weekAhead && (versionProgress?.overall || 0) < 70) autoRisks.push({ type: "VERSION_AT_RISK", level: "warning", title: `${currentVersion.name} 临近发布但进度偏低`, detail: `计划日期 ${shanghaiDay(currentVersion.plannedAt)}，范围完成度 ${versionProgress?.overall || 0}%` });
  const upcomingMilestones = project.milestones.filter((item) => !TERMINAL_MILESTONES.has(item.status) && item.dueAt >= asOf && item.dueAt <= weekAhead);
  if (upcomingMilestones.length) autoRisks.push({ type: "MILESTONE_DUE", level: "info", title: `${upcomingMilestones.length} 个里程碑将在 7 天内到期`, detail: upcomingMilestones.slice(0, 3).map((item) => item.title).join("、") });

  const timeline = [
    ...completedRequirements.map((item) => ({ type: "requirement", id: item.id, code: item.code, title: item.title, at: item.closedAt!.toISOString(), person: item.requester?.name || null })),
    ...completedTasks.map((item) => ({ type: "task", id: item.id, code: item.code, title: item.title, at: item.firstCompletedAt!.toISOString(), person: item.assignee?.name || null })),
    ...closedBugs.map((item) => ({ type: "bug", id: item.id, code: item.code, title: item.title, at: item.closedAt!.toISOString(), person: null })),
    ...releases.map((item) => ({ type: "release", id: item.id, code: item.build, title: `${item.version.name} 发布至 ${item.environment}`, at: item.releasedAt!.toISOString(), person: null })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return {
    period: { weekStart: weekStart.toISOString(), weekEnd: weekEnd.toISOString() },
    kpis: {
      completedRequirements: completedRequirements.length,
      completedTasks: completedTasks.length,
      averageTaskHours: averageHours(completedTasks, (item) => item.createdAt, (item) => item.firstCompletedAt!),
      averageRequirementHours: averageHours(completedRequirements, (item) => item.createdAt, (item) => item.closedAt!),
      createdBugs,
      closedBugs: closedBugs.length,
      seriousOpenBugs: seriousBugs.length,
    },
    currentVersion: currentVersion ? { id: currentVersion.id, name: currentVersion.name, status: currentVersion.status, plannedAt: currentVersion.plannedAt?.toISOString() || null, progress: versionProgress?.overall || 0, scope: versionScope } : null,
    releases: releases.map((item) => ({ id: item.id, build: item.build, environment: item.environment, status: item.status, releasedAt: item.releasedAt?.toISOString() || null, version: item.version })),
    requesters: [...requesterMap.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    members: [...activity.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
    autoRisks,
    manualRisks: manualRisks.map((risk) => ({ ...risk, dueAt: risk.dueAt?.toISOString() || null, resolvedAt: risk.resolvedAt?.toISOString() || null, createdAt: risk.createdAt.toISOString(), updatedAt: risk.updatedAt.toISOString() })),
    timeline: timeline.slice(0, 30),
  };
}

export function toJsonMetrics(metrics: ProjectActivityMetrics): Prisma.InputJsonValue {
  return metrics as unknown as Prisma.InputJsonValue;
}
