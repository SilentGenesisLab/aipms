const DAY_MS = 86_400_000;
export type ScheduleZoom = "week" | "month" | "quarter";
export const TERMINAL_TASK_STATUSES = new Set(["ACCEPTED", "DONE"]);
export const ACTIVE_REQUIREMENT_STATUSES = new Set(["DEVELOPING", "IN_PROGRESS"]);

export function shanghaiDateKey(value: Date | string) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(value));
}

function calendarDate(value: Date | string) {
  const key = shanghaiDateKey(value);
  const [year, month, day] = key.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

export function naturalDays(start: Date | string | null, end: Date | string | null) {
  if (!start || !end) return null;
  return Math.max(1, Math.round((calendarDate(end) - calendarDate(start)) / DAY_MS) + 1);
}

function fromShanghaiParts(year: number, month: number, day = 1) {
  return new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00+08:00`);
}

function dateParts(value: Date | string) {
  const [year, month, day] = shanghaiDateKey(value).split("-").map(Number);
  return { year, month, day };
}

export function schedulePeriod(value: Date | string, zoom: ScheduleZoom) {
  const { year, month, day } = dateParts(value);
  if (zoom === "week") {
    const calendar = new Date(Date.UTC(year, month - 1, day));
    const mondayOffset = (calendar.getUTCDay() + 6) % 7;
    calendar.setUTCDate(calendar.getUTCDate() - mondayOffset);
    const start = fromShanghaiParts(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate());
    return { start, end: new Date(start.getTime() + 7 * DAY_MS), days: 7 };
  }
  if (zoom === "month") {
    const start = fromShanghaiParts(year, month);
    const next = month === 12 ? fromShanghaiParts(year + 1, 1) : fromShanghaiParts(year, month + 1);
    return { start, end: next, days: Math.round((next.getTime() - start.getTime()) / DAY_MS) };
  }
  const firstMonth = Math.floor((month - 1) / 3) * 3 + 1;
  const start = fromShanghaiParts(year, firstMonth);
  const next = firstMonth === 10 ? fromShanghaiParts(year + 1, 1) : fromShanghaiParts(year, firstMonth + 3);
  return { start, end: next, days: Math.round((next.getTime() - start.getTime()) / DAY_MS) };
}

export function shiftSchedulePeriod(value: Date | string, zoom: ScheduleZoom, amount: number) {
  const period = schedulePeriod(value, zoom);
  const { year, month } = dateParts(period.start);
  if (zoom === "week") return new Date(period.start.getTime() + amount * 7 * DAY_MS);
  const monthDelta = zoom === "month" ? amount : amount * 3;
  const target = new Date(Date.UTC(year, month - 1 + monthDelta, 1));
  return fromShanghaiParts(target.getUTCFullYear(), target.getUTCMonth() + 1);
}

const PENDING_STATUSES = new Set(["TODO", "DRAFT", "REVIEW", "APPROVED"]);

export function scheduleHealth(input: { status: string; dueAt: Date | null; plannedStartAt?: Date | null; closedAt: Date | null }, now = new Date()) {
  if (!input.dueAt) {
    // 只填了计划开始的企业里也有（表单一端就能存）。没有截止日就判不了临期/逾期，
    // 但只要有一端就算已排期，不能报「未排期」再在旁边报个临期。
    if (!input.plannedStartAt) return "UNSCHEDULED" as const;
    if (input.closedAt) return "COMPLETED" as const;
    return PENDING_STATUSES.has(input.status) ? "NOT_STARTED" as const : "IN_PROGRESS" as const;
  }
  const dueDay = calendarDate(input.dueAt), today = calendarDate(now);
  if (input.closedAt) return calendarDate(input.closedAt) > dueDay ? "COMPLETED_LATE" as const : "COMPLETED" as const;
  if (dueDay < today) return "OVERDUE" as const;
  if (dueDay - today <= 3 * DAY_MS) return "AT_RISK" as const;
  return PENDING_STATUSES.has(input.status) ? "NOT_STARTED" as const : "IN_PROGRESS" as const;
}

export function hasDependencyConflict(task: { plannedStartAt: Date | null; dependencies: Array<{ dependsOn: { dueAt: Date | null; status: string } }> }) {
  if (!task.plannedStartAt) return false;
  return task.dependencies.some(({ dependsOn }) =>
    !TERMINAL_TASK_STATUSES.has(dependsOn.status) && Boolean(dependsOn.dueAt && calendarDate(task.plannedStartAt!) <= calendarDate(dependsOn.dueAt)),
  );
}

export function nextStartedAt(current: Date | null, previousStatus: string | null, nextStatus: string, type: "requirement" | "task", now = new Date()) {
  if (current) return current;
  if (type === "requirement") return ACTIVE_REQUIREMENT_STATUSES.has(nextStatus) || nextStatus === "DONE" ? now : null;
  return previousStatus === "TODO" && nextStatus !== "TODO" ? now : previousStatus === null && nextStatus !== "TODO" ? now : null;
}

export function validateSchedule(start: string | null | undefined, end: string | null | undefined) {
  if (start && end && new Date(end) < new Date(start)) return "计划结束时间不能早于计划开始时间";
  return null;
}

export function createsDependencyCycle(taskId: string, dependencyIds: string[], edges: Array<{ taskId: string; dependsOnId: string }>) {
  const graph = new Map<string, string[]>();
  for (const edge of edges) graph.set(edge.taskId, [...(graph.get(edge.taskId) || []), edge.dependsOnId]);
  graph.set(taskId, dependencyIds);
  const visit = (node: string, seen: Set<string>): boolean => {
    if (node === taskId && seen.size) return true;
    if (seen.has(node)) return false;
    const next = new Set(seen).add(node);
    return (graph.get(node) || []).some(dependency => visit(dependency, next));
  };
  return dependencyIds.some(dependency => visit(dependency, new Set([taskId])));
}
