import { describe, expect, it } from "vitest";
import { canForceCloseTask, opaqueId, taskForceCloseSchema, taskPatchSchema, taskQuickUpdateSchema, validateTaskStatusTransition } from "@/lib/task-workflow";

const task = (overrides: Partial<{ assigneeId: string | null; acceptorId: string | null; status: "TODO" | "IN_PROGRESS" | "PENDING_ACCEPTANCE" | "NEEDS_CHANGES" | "ACCEPTED" | "DONE" }> = {}) => ({
  assigneeId: "owner",
  acceptorId: "acceptor",
  status: "IN_PROGRESS" as const,
  ...overrides,
});

describe("task workflow", () => {
  it("treats migrated database ids as opaque strings", () => {
    expect(opaqueId.safeParse("legacy-task-owner-001").success).toBe(true);
    expect(opaqueId.safeParse("").success).toBe(false);
  });

  it("allows only the task owner to submit acceptance", () => {
    expect(validateTaskStatusTransition(task(), "owner", false, "PENDING_ACCEPTANCE")).toBeNull();
    expect(validateTaskStatusTransition(task(), "manager", true, "PENDING_ACCEPTANCE")?.status).toBe(403);
  });

  it("requires an acceptor before submitting acceptance", () => {
    expect(validateTaskStatusTransition(task({ acceptorId: null }), "owner", false, "PENDING_ACCEPTANCE")?.status).toBe(409);
  });

  it("protects pending and terminal states from ordinary updates", () => {
    expect(validateTaskStatusTransition(task({ status: "PENDING_ACCEPTANCE" }), "owner", true, "IN_PROGRESS")?.status).toBe(409);
    expect(validateTaskStatusTransition(task({ status: "DONE" }), "owner", true, "IN_PROGRESS")?.status).toBe(409);
    expect(validateTaskStatusTransition(task(), "owner", true, "DONE")?.status).toBe(403);
  });

  it("only accepts quick-update fields", () => {
    expect(taskQuickUpdateSchema.safeParse({ priority: "URGENT" }).success).toBe(true);
    expect(taskQuickUpdateSchema.safeParse({}).success).toBe(false);
    expect(taskQuickUpdateSchema.safeParse({ status: "DONE" }).success).toBe(false);
  });

  it("keeps omitted fields absent in partial task patches", () => {
    const parsed = taskPatchSchema.parse({ priority: "HIGH" });
    expect(parsed).toEqual({ priority: "HIGH" });
  });

  it("reads an empty optional association as 'not linked', and still keeps omitted keys absent", () => {
    expect(taskPatchSchema.parse({ requirementId: "", versionId: "" })).toEqual({ requirementId: null, versionId: null });
    expect(taskPatchSchema.parse({ requirementId: "req-1" })).toEqual({ requirementId: "req-1" });
    expect(taskPatchSchema.parse({ title: "调整后的标题" })).toEqual({ title: "调整后的标题" });
    expect(taskPatchSchema.safeParse({ requirementId: "   " }).success).toBe(false);
  });

  it("reserves force close for the project owner", () => {
    expect(canForceCloseTask({ projectMember: { role: "OWNER" } })).toBe(true);
    expect(canForceCloseTask({ projectMember: { role: "MANAGER" } })).toBe(false);
    expect(canForceCloseTask({ projectMember: { role: "MEMBER" } })).toBe(false);
    expect(canForceCloseTask({ projectMember: null })).toBe(false);
    expect(canForceCloseTask(null)).toBe(false);
  });

  it("requires a reason for force close", () => {
    expect(taskForceCloseSchema.safeParse({ reason: "项目范围调整，交付物另行归档" }).success).toBe(true);
    expect(taskForceCloseSchema.safeParse({ reason: "   " }).success).toBe(false);
    expect(taskForceCloseSchema.safeParse({}).success).toBe(false);
  });
});
