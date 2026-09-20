import type { Priority, ProjectRole, TaskStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getProjectAccess } from "@/lib/project-permissions";
import { createsDependencyCycle, nextStartedAt, validateSchedule } from "@/lib/project-schedule";
import { currentApiActor } from "@/lib/api-request-context";

export const opaqueId = z.string().trim().min(1, "关联记录不能为空").max(191, "关联记录 ID 过长");
export const optionalOpaqueId = opaqueId.nullable().optional();

export const taskFieldsSchema = z.object({
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().max(5000).default(""),
  acceptanceCriteria: z.string().trim().min(2).max(5000),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
  status: z.enum(["TODO", "IN_PROGRESS", "PENDING_ACCEPTANCE", "NEEDS_CHANGES", "ACCEPTED", "DONE"]),
  plannedStartAt: z.string().datetime().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  requirementId: optionalOpaqueId,
  versionId: optionalOpaqueId,
  assigneeId: optionalOpaqueId,
  coordinatorId: optionalOpaqueId,
  acceptorId: optionalOpaqueId,
  dependencyIds: z.array(opaqueId).default([]),
});

export const taskPatchSchema = z.object({
  title: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(5000).optional(),
  acceptanceCriteria: z.string().trim().min(2).max(5000).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "PENDING_ACCEPTANCE", "NEEDS_CHANGES", "ACCEPTED", "DONE"]).optional(),
  plannedStartAt: z.string().datetime().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  requirementId: optionalOpaqueId,
  versionId: optionalOpaqueId,
  assigneeId: optionalOpaqueId,
  coordinatorId: optionalOpaqueId,
  acceptorId: optionalOpaqueId,
  dependencyIds: z.array(opaqueId).optional(),
}).refine((value) => Object.keys(value).length > 0, "没有可更新的字段");

export const taskQuickUpdateSchema = z.object({
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "PENDING_ACCEPTANCE"]).optional(),
}).refine((value) => value.priority !== undefined || value.status !== undefined, "没有可更新的字段");

export const taskAcceptanceSchema = z.object({
  decision: z.enum(["PASS", "NEEDS_CHANGES"]),
  conclusion: z.string().trim().min(3).max(3000),
  verificationEvidence: z.string().trim().min(3).max(5000),
});

export const taskForceCloseSchema = z.object({
  reason: z.string().trim().min(3, "强制关闭原因至少 3 个字符").max(3000),
});

type TaskWriteData = Partial<z.infer<typeof taskFieldsSchema>>;
type WorkflowResult<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

function failure(error: string, status = 400): WorkflowResult<never> {
  return { ok: false, error, status };
}

export async function prepareTaskCreate(projectId: string, userId: string, input: z.infer<typeof taskFieldsSchema>): Promise<WorkflowResult<z.infer<typeof taskFieldsSchema>>> {
  if (!["TODO", "IN_PROGRESS"].includes(input.status)) return failure("新任务只能创建为待处理或进行中状态");
  const scheduleError = validateSchedule(input.plannedStartAt, input.dueAt);
  if (scheduleError) return failure(scheduleError);
  const membership = await prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { userId: true } });
  const assigneeId = input.assigneeId || membership?.userId;
  if (!assigneeId) return failure("请选择任务负责人；当前创建人不是项目成员，不能自动设为负责人");

  const requirement = input.requirementId
    ? await prisma.requirement.findFirst({ where: { id: input.requirementId, projectId }, select: { requesterId: true } })
    : null;
  if (input.requirementId && !requirement) return failure("关联需求不存在或不属于当前项目");

  const value = {
    ...input,
    assigneeId,
    acceptorId: input.acceptorId || requirement?.requesterId || userId,
    dependencyIds: [...new Set(input.dependencyIds)],
  };
  const invalid = await validateTaskReferences(projectId, value);
  return invalid ? failure(invalid) : { ok: true, value };
}

export async function validateTaskReferences(projectId: string, data: TaskWriteData, currentTaskId?: string): Promise<string | null> {
  const scheduleError = validateSchedule(data.plannedStartAt, data.dueAt);
  if (scheduleError) return scheduleError;
  const [project, projectMembers] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { teamId: true } }),
    prisma.projectMember.findMany({ where: { projectId }, select: { userId: true } }),
  ]);
  if (!project) return "项目不存在";
  const memberIds = new Set(projectMembers.map((item) => item.userId));

  if (data.assigneeId && !memberIds.has(data.assigneeId)) return "任务负责人必须是当前项目成员";
  if (data.coordinatorId && !memberIds.has(data.coordinatorId)) return "任务对接人必须是当前项目成员";

  if (data.acceptorId) {
    const projectMember = memberIds.has(data.acceptorId);
    const teamManager = project.teamId
      ? await prisma.teamMember.findFirst({ where: { teamId: project.teamId, userId: data.acceptorId, role: { in: ["OWNER", "ADMIN"] } }, select: { id: true } })
      : null;
    if (!projectMember && !teamManager) return "任务验收人必须是项目成员或所属团队管理员";
  }

  if (data.requirementId && !(await prisma.requirement.findFirst({ where: { id: data.requirementId, projectId }, select: { id: true } })))
    return "关联需求不存在或不属于当前项目";
  if (data.versionId && !(await prisma.version.findFirst({ where: { id: data.versionId, projectId }, select: { id: true } })))
    return "目标版本不存在或不属于当前项目";

  if (data.dependencyIds !== undefined) {
    const dependencyIds = [...new Set(data.dependencyIds)];
    if (currentTaskId && dependencyIds.includes(currentTaskId)) return "任务不能依赖自身";
    const count = dependencyIds.length
      ? await prisma.task.count({ where: { id: { in: dependencyIds }, projectId } })
      : 0;
    if (count !== dependencyIds.length) return "依赖任务不存在或不属于当前项目";
    if (currentTaskId && dependencyIds.length) {
      const edges = await prisma.taskDependency.findMany({ where: { task: { projectId }, taskId: { not: currentTaskId } }, select: { taskId: true, dependsOnId: true } });
      if (createsDependencyCycle(currentTaskId, dependencyIds, edges)) return "依赖关系不能形成循环";
    }
  }
  return null;
}

export async function quickUpdateTask(taskId: string, userId: string, input: z.infer<typeof taskQuickUpdateSchema>): Promise<WorkflowResult<{ id: string; priority: Priority; status: TaskStatus; updatedAt: Date }>> {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return failure("任务不存在", 404);
  const access = await getProjectAccess(task.projectId, userId);
  if (!access?.canAccess) return failure("任务不存在或无权访问", 404);
  const canWrite = Boolean(access.canManage || (access.projectMember && access.projectMember.role !== "GUEST"));
  const isOwner = task.assigneeId === userId;

  if (input.priority && !isOwner && !canWrite) return failure("没有调整任务优先级的权限", 403);
  if (input.status && input.status !== task.status) {
    const transitionError = validateTaskStatusTransition(task, userId, canWrite, input.status);
    if (transitionError) return failure(transitionError.error, transitionError.status);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.task.update({
      where: { id: taskId },
      data: { ...input, ...(input.status ? { startedAt: nextStartedAt(task.startedAt, task.status, input.status, "task") } : {}) },
    });
    await tx.auditLog.create({
      data: {
        userId,
        projectId: task.projectId,
        actorType: "USER",
        action: input.status === "PENDING_ACCEPTANCE" ? "SUBMIT_TASK_ACCEPTANCE" : "QUICK_UPDATE_TASK",
        resource: "TASK",
        resourceId: taskId,
        channel: "WEB",
        metadata: { projectId: task.projectId, fields: Object.keys(input), fromStatus: task.status, toStatus: input.status, result: "SUCCESS" },
      },
    });
    return next;
  });
  return { ok: true, value: { id: updated.id, priority: updated.priority, status: updated.status, updatedAt: updated.updatedAt } };
}

export function validateTaskStatusTransition(
  task: { assigneeId: string | null; acceptorId: string | null; status: TaskStatus },
  userId: string,
  canWrite: boolean,
  targetStatus: TaskStatus,
) {
  const isOwner = task.assigneeId === userId;
  if (["ACCEPTED", "DONE"].includes(task.status)) return { error: "已闭环任务不能再调整状态", status: 409 };
  if (["ACCEPTED", "DONE", "NEEDS_CHANGES"].includes(targetStatus))
    return { error: "验收结果只能由指定验收人提交", status: 403 };
  if (task.status === "PENDING_ACCEPTANCE") return { error: "待验收任务只能由验收人通过或退回", status: 409 };
  if (targetStatus === "PENDING_ACCEPTANCE") {
    if (!isOwner) return { error: "只有任务负责人可以提交验收", status: 403 };
    if (!task.acceptorId) return { error: "请先设置验收人，再提交验收", status: 409 };
    if (!["TODO", "IN_PROGRESS", "NEEDS_CHANGES"].includes(task.status)) return { error: "当前状态不能提交验收", status: 409 };
  } else if (!isOwner && !canWrite) {
    return { error: "没有调整任务状态的权限", status: 403 };
  }
  return null;
}

export async function acceptTask(taskId: string, userId: string, input: z.infer<typeof taskAcceptanceSchema>): Promise<WorkflowResult<{ id: string; result: string; comment: string; verification: string; createdAt: Date }>> {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return failure("任务不存在", 404);
  if (!(await getProjectAccess(task.projectId, userId))?.canAccess) return failure("任务不存在或无权访问", 404);
  if (task.acceptorId !== userId) return failure("只有指定验收人可以验收并闭环", 403);
  if (task.status !== "PENDING_ACCEPTANCE") return failure("任务当前不处于待验收状态", 409);

  const now = new Date();
  const passed = input.decision === "PASS";
  const acceptance = await prisma.$transaction(async (tx) => {
    const created = await tx.acceptance.create({
      data: { taskId, reviewerId: userId, result: input.decision, comment: input.conclusion, verification: input.verificationEvidence },
    });
    await tx.task.update({
      where: { id: taskId },
      data: { status: passed ? "DONE" : "NEEDS_CHANGES", startedAt: task.startedAt || now, completedAt: passed ? now : null, firstCompletedAt: passed ? task.firstCompletedAt || now : task.firstCompletedAt, closedAt: passed ? now : null },
    });
    await tx.auditLog.create({
      data: {
        userId,
        projectId: task.projectId,
        actorType: "USER",
        action: passed ? "CLOSE_TASK" : "REJECT_TASK_ACCEPTANCE",
        resource: "TASK",
        resourceId: taskId,
        channel: "WEB",
        metadata: { projectId: task.projectId, decision: input.decision, result: "SUCCESS" },
      },
    });
    return created;
  });
  return { ok: true, value: acceptance };
}

export const FORCE_CLOSED_ACCEPTANCE_RESULT = "FORCE_CLOSED";

// Only the project creator — the member holding the OWNER role — may close a task
// without the handover; managers and assignees still go through acceptance.
export const canForceCloseTask = (access: { projectMember: { role: ProjectRole } | null } | null) =>
  access?.projectMember?.role === "OWNER";

// Closing without the report-and-acceptance handover still writes an acceptance
// row, under a result the normal flow never produces, so the task timeline shows
// who closed it and why instead of ending without any record.
export async function forceCloseTask(taskId: string, userId: string, input: z.infer<typeof taskForceCloseSchema>): Promise<WorkflowResult<{ id: string; status: TaskStatus; closedAt: Date }>> {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return failure("任务不存在", 404);
  const access = await getProjectAccess(task.projectId, userId);
  if (!access?.canAccess) return failure("任务不存在或无权访问", 404);
  if (!canForceCloseTask(access)) return failure("只有项目创建者（项目所有者）可以强制关闭任务", 403);
  if (["ACCEPTED", "DONE"].includes(task.status)) return failure("任务已闭环，无需强制关闭", 409);

  const now = new Date();
  const closed = await prisma.$transaction(async (tx) => {
    await tx.acceptance.create({
      data: { taskId, reviewerId: userId, result: FORCE_CLOSED_ACCEPTANCE_RESULT, comment: input.reason, verification: "" },
    });
    const updated = await tx.task.update({
      where: { id: taskId },
      data: { status: "DONE", startedAt: task.startedAt || now, completedAt: now, firstCompletedAt: task.firstCompletedAt || now, closedAt: now },
    });
    await tx.auditLog.create({
      data: {
        userId,
        projectId: task.projectId,
        actorType: "USER",
        action: "FORCE_CLOSE_TASK",
        resource: "TASK",
        resourceId: taskId,
        channel: currentApiActor() ? "API_KEY" : "WEB",
        metadata: { projectId: task.projectId, fromStatus: task.status, reason: input.reason, result: "SUCCESS" },
      },
    });
    return updated;
  });
  return { ok: true, value: { id: closed.id, status: closed.status, closedAt: closed.closedAt || now } };
}

export function taskDetailPermissions(task: { assigneeId: string | null; acceptorId: string | null; status: TaskStatus }, userId: string, canWrite: boolean) {
  const terminal = task.status === "ACCEPTED" || task.status === "DONE";
  const pending = task.status === "PENDING_ACCEPTANCE";
  return {
    canWrite,
    canEditPriority: !terminal && (canWrite || task.assigneeId === userId),
    canChangeStatus: !terminal && !pending && (canWrite || task.assigneeId === userId),
    canSubmitAcceptance: !terminal && !pending && task.assigneeId === userId,
    canAccept: pending && task.acceptorId === userId,
  };
}
