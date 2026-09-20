import { NextResponse, type NextRequest } from "next/server";
import type { Prisma, Priority, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getRequestUserId } from "@/lib/team-permissions";
import { taskRoleForUser } from "@/lib/task-scope";

const completed: TaskStatus[] = ["ACCEPTED", "DONE"];

export async function GET(request: NextRequest) {
  const userId = await getRequestUserId(request);
  if (!userId) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const p = request.nextUrl.searchParams;
  const scope = p.get("scope") === "delegated" ? "delegated" : "mine";
  const [memberships, managedTeams] = await Promise.all([
    prisma.projectMember.findMany({
      where: { userId },
      select: { projectId: true },
    }),
    prisma.teamMember.findMany({
      where: { userId, role: { in: ["OWNER", "ADMIN"] } },
      select: { teamId: true },
    }),
  ]);
  const managedProjects = managedTeams.length
    ? await prisma.project.findMany({
        where: { teamId: { in: managedTeams.map((x) => x.teamId) } },
        select: { id: true },
      })
    : [];
  const projectIds = [...new Set([...memberships.map((x) => x.projectId), ...managedProjects.map((x) => x.id)])];
  const scopeWhere: Prisma.TaskWhereInput =
    scope === "delegated"
      ? {
          createdById: userId,
          assigneeId: { not: null },
          NOT: { assigneeId: userId },
        }
      : {
          OR: [{ assigneeId: userId }, { acceptorId: userId, status: "PENDING_ACCEPTANCE" }],
        };
  const where: Prisma.TaskWhereInput = {
    projectId: { in: projectIds },
    ...scopeWhere,
  };
  const state = p.get("state") || "open";
  if (state === "open") where.status = { notIn: completed };
  else if (state === "completed") where.status = { in: completed };
  const status = p.get("status");
  if (status && status !== "ALL") where.status = status as TaskStatus;
  const priority = p.get("priority");
  if (priority && priority !== "ALL") where.priority = priority as Priority;
  const projectId = p.get("projectId");
  if (projectId && projectId !== "ALL" && projectIds.includes(projectId)) where.projectId = projectId;
  const assigneeId = p.get("assigneeId");
  if (assigneeId && assigneeId !== "ALL") where.assigneeId = assigneeId;
  const due = p.get("due");
  if (due === "overdue") where.dueAt = { lt: new Date() };
  else if (due === "week")
    where.dueAt = {
      gte: new Date(),
      lte: new Date(Date.now() + 7 * 86_400_000),
    };
  const query = p.get("q")?.trim();
  if (query)
    where.AND = [
      {
        OR: [{ title: { contains: query, mode: "insensitive" } }, { code: { contains: query, mode: "insensitive" } }, { project: { name: { contains: query, mode: "insensitive" } } }],
      },
    ];
  const [tasks, mineCount, delegatedCount, projects, members] = await Promise.all([
    prisma.task.findMany({
      where,
      include: {
        project: { select: { id: true, code: true, name: true } },
        assignee: {
          select: {
            id: true,
            name: true,
            avatarColor: true,
            avatarUrl: true,
          },
        },
        acceptor: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { updatedAt: "desc" }],
    }),
    prisma.task.count({
      where: {
        projectId: { in: projectIds },
        OR: [{ assigneeId: userId }, { acceptorId: userId, status: "PENDING_ACCEPTANCE" }],
        status: { notIn: completed },
      },
    }),
    prisma.task.count({
      where: {
        projectId: { in: projectIds },
        createdById: userId,
        assigneeId: { not: null },
        NOT: { assigneeId: userId },
        status: { notIn: completed },
      },
    }),
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: {
        id: true,
        name: true,
        code: true,
        members: { where: { userId }, select: { role: true } },
        team: {
          select: {
            members: {
              where: { userId, role: { in: ["OWNER", "ADMIN"] } },
              select: { id: true },
            },
          },
        },
      },
      orderBy: { name: "asc" },
    }),
    prisma.projectMember.findMany({
      where: { projectId: { in: projectIds } },
      distinct: ["userId"],
      include: { user: { select: { id: true, name: true } } },
      orderBy: { user: { name: "asc" } },
    }),
  ]);
  return NextResponse.json({
    tasks: tasks.map((task) => ({
      ...task,
      role: taskRoleForUser(task, userId),
      overdue: Boolean(task.dueAt && task.dueAt < new Date() && !completed.includes(task.status)),
    })),
    counts: { mine: mineCount, delegated: delegatedCount },
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      code: project.code,
      canWrite: Boolean(project.team?.members.length || project.members[0]?.role !== "GUEST"),
    })),
    members: members.map((x) => x.user),
  });
}
