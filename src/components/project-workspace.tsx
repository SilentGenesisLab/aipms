"use client";

import { FormEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bug,
  ChevronRight,
  CircleDot,
  FileCheck2,
  ListChecks,
  LoaderCircle,
  Pencil,
  Plus,
  Rocket,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { SelectField } from "@/components/ui/select-field";
import { DateRangeField } from "@/components/ui/date-range-field";
import { DeploymentCenter } from "@/components/deployment-center";
import { fromScheduleInput, toScheduleInput } from "@/lib/schedule-time";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Module = "requirements" | "tasks" | "bugs" | "versions" | "releases";
type Item = Record<string, unknown> & {
  id: string;
  code?: string;
  title?: string;
  name?: string;
  status: string;
  priority?: string;
  severity?: string;
  updatedAt?: string;
  createdAt?: string;
  plannedAt?: string | null;
};
type Data = {
  currentUserId: string;
  requirements: Item[];
  tasks: Item[];
  bugs: Item[];
  versions: Item[];
  releases: Item[];
  files: Array<{ id: string; name: string; mimeType: string; size: string }>;
  members: Array<{ id: string; name: string; role: string }>;
  permissions: { canWrite: boolean; canDelete: boolean };
};
type FormState = Record<string, string | string[]>;
const empty: Data = {
  currentUserId: "",
  requirements: [],
  tasks: [],
  bugs: [],
  versions: [],
  releases: [],
  files: [],
  members: [],
  permissions: { canWrite: false, canDelete: false },
};
const moduleInfo = {
  requirements: {
    title: "需求管理",
    subtitle: "管理项目范围、优先级、目标版本与验收条件",
    action: "新建需求",
    icon: CircleDot,
  },
  tasks: {
    title: "任务管理",
    subtitle: "拆分工作，指定负责人、对接人、验收人和依赖任务",
    action: "新建任务",
    icon: ListChecks,
  },
  bugs: {
    title: "Bug 管理",
    subtitle: "跟踪问题从发现、修复、验证到随版本发布",
    action: "提交 Bug",
    icon: Bug,
  },
  versions: {
    title: "版本与发布",
    subtitle: "管理版本目标、范围进度、构建记录和回滚方案",
    action: "新建版本",
    icon: Rocket,
  },
  releases: {
    title: "发布记录",
    subtitle: "记录构建标识、环境、发布结果与回滚说明",
    action: "新建发布记录",
    icon: FileCheck2,
  },
};
const labels: Record<string, string> = {
  TODO: "待处理",
  IN_PROGRESS: "进行中",
  PENDING_ACCEPTANCE: "待验收",
  NEEDS_CHANGES: "需修改",
  ACCEPTED: "已通过",
  DONE: "已完成",
  NEW: "新建",
  CONFIRMED: "已确认",
  ASSIGNED: "已分配",
  FIXING: "修复中",
  PENDING_VERIFICATION: "待验证",
  VERIFIED: "已验证",
  PENDING_RELEASE: "待发布",
  CLOSED: "已关闭",
  REOPENED: "重新打开",
  DEFERRED: "已延期",
  REJECTED: "已拒绝",
  PLANNING: "规划中",
  DEVELOPING: "开发中",
  TESTING: "测试中",
  RELEASED: "已发布",
  ARCHIVED: "已归档",
  CANCELLED: "已取消",
  PLANNED: "计划中",
  RUNNING: "发布中",
  SUCCEEDED: "成功",
  FAILED: "失败",
  ROLLED_BACK: "已回滚",
  LOW: "低",
  MEDIUM: "中",
  HIGH: "高",
  URGENT: "紧急",
  DRAFT: "草稿",
  REVIEW: "评审中",
  APPROVED: "已确认",
};
const priorities = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const statuses: Record<Module, string[]> = {
  requirements: ["DRAFT", "REVIEW", "APPROVED", "DEVELOPING", "DONE"],
  tasks: [
    "TODO",
    "IN_PROGRESS",
    "PENDING_ACCEPTANCE",
    "NEEDS_CHANGES",
    "ACCEPTED",
    "DONE",
  ],
  bugs: [
    "NEW",
    "CONFIRMED",
    "ASSIGNED",
    "FIXING",
    "PENDING_VERIFICATION",
    "VERIFIED",
    "PENDING_RELEASE",
    "CLOSED",
    "REOPENED",
    "DEFERRED",
    "REJECTED",
  ],
  versions: [
    "PLANNING",
    "DEVELOPING",
    "TESTING",
    "PENDING_RELEASE",
    "RELEASED",
    "ARCHIVED",
    "CANCELLED",
  ],
  releases: ["PLANNED", "RUNNING", "SUCCEEDED", "FAILED", "ROLLED_BACK"],
};
const fmt = (value: unknown) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(String(value)))
    : "—";
const dateKey = (value: unknown) => {
  if (!value) return "";
  const date = new Date(String(value));
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const relatedName = (value: unknown) =>
  value && typeof value === "object" && "name" in value
    ? String((value as { name: unknown }).name)
    : "未指定";
function rowMeta(module: Module, item: Item) {
  const code = item.code ? `${item.code} · ` : "";
  if (module === "tasks")
    return `${code}负责人：${relatedName(item.assignee)} · 提交：${fmt(item.submittedAt)} · 截止：${fmt(item.dueAt)}`;
  if (module === "requirements")
    return `${code}负责人：${relatedName(item.owner)} · 需求人：${relatedName(item.requester)} · 创建：${fmt(item.createdAt)}`;
  if (module === "versions") {
    const participants = Array.isArray(item.participants) ? item.participants.length : 0;
    return `负责人：${relatedName(item.owner)} · ${participants} 位参与人 · 计划发布：${fmt(item.plannedAt)}`;
  }
  return `${code}${labels[item.status] || item.status} · 更新于 ${fmt(item.updatedAt || item.createdAt)}`;
}

function DateFilter({ label, value, set }: { label: string; value: string; set: (value: string) => void }) {
  return (
    <label className="flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs text-slate-500">
      <span className="whitespace-nowrap">{label}</span>
      <input type="date" value={value} onChange={(event) => set(event.target.value)} className="bg-transparent text-sm text-slate-700 outline-none" />
    </label>
  );
}

export function ProjectWorkspace({
  projectId,
  module,
}: {
  projectId: string;
  module: Exclude<Module, "releases">;
}) {
  const [data, setData] = useState<Data>(empty),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState("ALL"),
    [assigneeId, setAssigneeId] = useState("ALL"),
    [submittedDate, setSubmittedDate] = useState(""),
    [dueDate, setDueDate] = useState(""),
    [deploymentRefresh, setDeploymentRefresh] = useState(0),
    [dialog, setDialog] = useState<{
      module: Module;
      item: Item | null;
    } | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/workspace`);
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || "加载失败");
      setData(b);
      if (module === "requirements") {
        const itemId = new URL(window.location.href).searchParams.get("item");
        const item = itemId ? (b as Data).requirements.find((requirement) => requirement.id === itemId) : null;
        if (item) setDialog({ module: "requirements", item });
      }
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [module, projectId]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  function closeDialog() {
    const url = new URL(window.location.href);
    if (url.searchParams.has("item")) {
      url.searchParams.delete("item");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    setDialog(null);
  }
  const active: Module = module;
  const items = data[active];
  const info = moduleInfo[active];
  const Icon = info.icon;
  const filtered = useMemo(
    () =>
      items.filter(
        (x) =>
          `${x.code || ""}${x.title || x.name || ""}`
            .toLowerCase()
            .includes(query.toLowerCase()) &&
          (status === "ALL" || x.status === status) &&
          (active !== "tasks" || assigneeId === "ALL" || x.assigneeId === assigneeId) &&
          (active !== "tasks" || !submittedDate || dateKey(x.submittedAt) === submittedDate) &&
          (active !== "tasks" || !dueDate || dateKey(x.dueAt) === dueDate),
      ),
    [active, assigneeId, dueDate, items, query, status, submittedDate],
  );
  if (active === "versions")
    return (
      <>
        <DeploymentCenter
          projectId={projectId}
          refreshKey={deploymentRefresh}
          onNewVersion={() => setDialog({ module: "versions", item: null })}
          onEditVersion={(version) => setDialog({ module: "versions", item: version as unknown as Item })}
        />
        {dialog && (
          <Editor
            projectId={projectId}
            module={dialog.module}
            item={dialog.item}
            data={data}
            onClose={() => setDialog(null)}
            onSaved={async () => {
              setDialog(null);
              await load();
              setDeploymentRefresh((value) => value + 1);
            }}
          />
        )}
      </>
    );
  async function remove(item: Item) {
    if (
      !confirm(`确定删除“${item.title || item.name}”？此操作会写入审计日志。`)
    )
      return;
    const r = await fetch(
      `/api/projects/${projectId}/workspace/${active}/${item.id}`,
      { method: "DELETE" },
    );
    const b = await r.json();
    if (!r.ok) return setError(b.error || "删除失败");
    await load();
  }
  if (loading)
    return (
      <div className="grid min-h-72 place-items-center">
        <LoaderCircle className="animate-spin text-blue-600" />
      </div>
    );
  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h3 className="text-xl font-bold">{info.title}</h3>
          <p className="mt-1 text-sm text-slate-500">{info.subtitle}</p>
        </div>
        {data.permissions.canWrite && (
          <button
            onClick={() => setDialog({ module: active, item: null })}
            className="primary-button"
          >
            <Plus size={16} />
            {info.action}
          </button>
        )}
      </div>
      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <label className="flex h-10 min-w-60 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3">
          <Search size={16} className="text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索编号或标题"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
        <SelectField
          value={status}
          onChange={setStatus}
          className="min-w-36"
          options={[
            { value: "ALL", label: "全部状态" },
            ...statuses[active].map((value) => ({ value, label: labels[value] || value })),
          ]}
        />
        {active === "tasks" && (
          <>
            <SelectField
              value={assigneeId}
              onChange={setAssigneeId}
              className="min-w-36"
              options={[
                { value: "ALL", label: "全部负责人" },
                ...data.members.map((member) => ({ value: member.id, label: member.name })),
              ]}
            />
            <DateFilter label="提交日期" value={submittedDate} set={setSubmittedDate} />
            <DateFilter label="截止日期" value={dueDate} set={setDueDate} />
          </>
        )}
      </div>
      <section className="card overflow-hidden">
        {!filtered.length ? (
          <div className="p-14 text-center text-sm text-slate-400">
            <Icon className="mx-auto mb-3" />
            暂无数据，点击右上角开始创建
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filtered.map((item) => (
              <div
                key={item.id}
                className="group flex items-center gap-3 p-4 hover:bg-slate-50"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-600">
                  <Icon size={18} />
                </span>
                <button
                  onClick={() => setDialog({ module: active, item })}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-sm font-medium">
                    {String(item.title || item.name)}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    {rowMeta(active, item)}
                  </p>
                </button>
                {(item.priority || item.severity) && (
                  <Badge value={String(item.priority || item.severity)} />
                )}
                <Badge value={item.status} />
                {data.permissions.canWrite && (
                  <button
                    onClick={() => setDialog({ module: active, item })}
                    className="rounded-lg p-2 text-slate-400 hover:bg-blue-50 hover:text-blue-600"
                  >
                    <Pencil size={16} />
                  </button>
                )}
                {data.permissions.canDelete && (
                  <button
                    onClick={() => void remove(item)}
                    className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
                <ChevronRight size={17} className="text-slate-300" />
              </div>
            ))}
          </div>
        )}
      </section>
      {dialog && (
        <Editor
          projectId={projectId}
          module={dialog.module}
          item={dialog.item}
          data={data}
          onClose={closeDialog}
          onSaved={async () => {
            closeDialog();
            await load();
          }}
        />
      )}
    </div>
  );
}

function Editor({
  projectId,
  module,
  item,
  data,
  onClose,
  onSaved,
}: {
  projectId: string;
  module: Module;
  item: Item | null;
  data: Data;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => {
      const value = initial(module, item);
      return module === "tasks" && !item && data.members.some((member) => member.id === data.currentUserId)
        ? { ...value, assigneeId: data.currentUserId }
        : value;
    }),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [drawerWidth, setDrawerWidth] = useState(672);
  const resize = useRef<{ x: number; width: number } | null>(null);
  function resizeDrawer(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!resize.current) return;
    setDrawerWidth(Math.min(window.innerWidth * .92, Math.max(390, resize.current.width + resize.current.x - event.clientX)));
  }
  const set = (key: string, value: string | string[]) =>
    setForm((v) => ({ ...v, [key]: value }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const payload = { ...form };
    for (const k of ["plannedStartAt", "dueAt", "plannedAt", "releasedAt"])
      if (k in payload)
        payload[k] = fromScheduleInput(payload[k] as string) as unknown as string;
    // 未选负责人时 select 给的是 ""，而 schema 只接受 id 或 null（"" 过不了 min(1)）。
    if (payload.ownerId === "") payload.ownerId = null as unknown as string;
    try {
      const url = `/api/projects/${projectId}/workspace/${module}${item ? `/${item.id}` : ""}`;
      const r = await fetch(url, {
        method: item ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || "保存失败");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
      setSaving(false);
    }
  }
  return (
    <div
      className="fixed inset-0 z-[70] flex justify-end bg-slate-950/30 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        onSubmit={submit}
        style={{ width: `min(100vw, ${drawerWidth}px)` }}
        className="relative h-full shrink-0 overflow-y-auto border-l border-slate-200 bg-white p-6 shadow-2xl"
      >
        {module === "requirements" && <button type="button" aria-label="调整需求表单宽度" className="absolute inset-y-0 left-0 hidden w-2 cursor-col-resize touch-none hover:bg-blue-500/20 sm:block" onPointerDown={event=>{resize.current={x:event.clientX,width:drawerWidth};event.currentTarget.setPointerCapture(event.pointerId)}} onPointerMove={resizeDrawer} onPointerUp={()=>{resize.current=null}} />}
        <div className="flex items-start">
          <div>
            <h3 className="text-lg font-semibold">
              {item ? "编辑" : "新建"}
              {moduleInfo[module].title.replace("管理", "")}
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              保存后立即生效，并记录到操作日志
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-lg p-2 text-slate-400 hover:bg-slate-100"
          >
            <X size={19} />
          </button>
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Fields
            module={module}
            form={form}
            set={set}
            data={data}
            currentId={item?.id}
          />
        </div>
        {error && (
          <div className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">
            {error}
          </div>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="secondary-button">
            取消
          </button>
          <button disabled={saving} className="primary-button">
            {saving ? (
              <LoaderCircle className="animate-spin" size={16} />
            ) : null}
            保存
          </button>
        </div>
      </form>
    </div>
  );
}

function Fields({
  module,
  form,
  set,
  data,
  currentId,
}: {
  module: Module;
  form: FormState;
  set: (k: string, v: string | string[]) => void;
  data: Data;
  currentId?: string;
}) {
  if (module === "versions")
    return (
      <>
        <Input
          label="版本名称"
          value={form.name as string}
          set={(v) => set("name", v)}
        />
        <Select
          label="状态"
          value={form.status as string}
          set={(v) => set("status", v)}
          options={statuses.versions}
        />
        <Input
          label="计划发布日期"
          type="datetime-local"
          value={form.plannedAt as string}
          set={(v) => set("plannedAt", v)}
        />
        <LookupSelect
          label="负责人"
          value={form.ownerId as string}
          set={(v) => set("ownerId", v)}
          items={data.members}
          optional
        />
        <MultiSelect
          label="参与成员"
          values={form.participantIds as string[]}
          set={(v) => set("participantIds", v)}
          items={data.members}
        />
        <Area
          label="版本目标"
          value={form.goal as string}
          set={(v) => set("goal", v)}
          wide
        />
        <Area
          label="版本描述（支持 Markdown）"
          value={form.description as string}
          set={(v) => set("description", v)}
          wide
        />
        <MarkdownPreview value={form.description as string} />
        <MultiSelect
          label="引用项目文件"
          values={form.fileIds as string[]}
          set={(v) => set("fileIds", v)}
          items={data.files}
          emptyText="当前项目暂无可引用文件，请先到文件管理上传"
        />
      </>
    );
  if (module === "releases")
    return (
      <>
        <LookupSelect
          label="版本"
          value={form.versionId as string}
          set={(v) => set("versionId", v)}
          items={data.versions}
        />
        <Input
          label="构建标识"
          value={form.build as string}
          set={(v) => set("build", v)}
        />
        <Input
          label="目标环境"
          value={form.environment as string}
          set={(v) => set("environment", v)}
        />
        <Select
          label="结果"
          value={form.status as string}
          set={(v) => set("status", v)}
          options={statuses.releases}
        />
        <Input
          label="发布时间"
          type="datetime-local"
          value={form.releasedAt as string}
          set={(v) => set("releasedAt", v)}
        />
        <Area
          label="发布清单与说明"
          value={form.notes as string}
          set={(v) => set("notes", v)}
          wide
        />
        <Area
          label="回滚方案"
          value={form.rollbackPlan as string}
          set={(v) => set("rollbackPlan", v)}
          wide
        />
      </>
    );
  return (
    <>
      <Input
        label="标题"
        value={form.title as string}
        set={(v) => set("title", v)}
        wide
      />
      <Select
        label="优先级 / 严重程度"
        value={(form.priority || form.severity) as string}
        set={(v) => set(module === "bugs" ? "severity" : "priority", v)}
        options={priorities}
      />
      <Select
        label="状态"
        value={form.status as string}
        set={(v) => set("status", v)}
        options={module === "tasks" && ["PENDING_ACCEPTANCE", "ACCEPTED", "DONE"].includes(form.status as string)
          ? [form.status as string]
          : module === "tasks"
          ? [...new Set([
              form.status as string,
              "TODO",
              "IN_PROGRESS",
              ...((form.assigneeId as string) === data.currentUserId ? ["PENDING_ACCEPTANCE"] : []),
            ])]
          : statuses[module]}
      />
      {module === "requirements" && (
        <>
          <DateRangeField title="需求排期" includeTime start={form.plannedStartAt as string} end={form.dueAt as string} onChange={value=>{set("plannedStartAt",value.start);set("dueAt",value.end)}} />
          <LookupSelect
            label="负责人"
            value={form.ownerId as string}
            set={(v) => set("ownerId", v)}
            items={data.members}
            optional
          />
          <LookupSelect
            label="目标版本"
            value={form.targetVersionId as string}
            set={(v) => set("targetVersionId", v)}
            items={data.versions}
            optional
          />
          <MultiSelect
            label="需求参与成员"
            values={form.participantIds as string[]}
            set={(v) => set("participantIds", v)}
            items={data.members}
          />
        </>
      )}
      {module === "tasks" && (
        <>
          <Input label="计划开始" type="datetime-local" value={form.plannedStartAt as string} set={(v) => set("plannedStartAt", v)}/>
          <LookupSelect
            label="关联需求"
            value={form.requirementId as string}
            set={(v) => set("requirementId", v)}
            items={data.requirements}
            optional
          />
          <LookupSelect
            label="目标版本"
            value={form.versionId as string}
            set={(v) => set("versionId", v)}
            items={data.versions}
            optional
          />
          <LookupSelect
            label="负责人"
            value={form.assigneeId as string}
            set={(v) => set("assigneeId", v)}
            items={data.members}
            optional
          />
          <LookupSelect
            label="对接人"
            value={form.coordinatorId as string}
            set={(v) => set("coordinatorId", v)}
            items={data.members}
            optional
          />
          <LookupSelect
            label="验收人"
            value={form.acceptorId as string}
            set={(v) => set("acceptorId", v)}
            items={data.members}
            optional
          />
          <Input
            label="截止时间"
            type="datetime-local"
            value={form.dueAt as string}
            set={(v) => set("dueAt", v)}
          />
          <MultiSelect
            label="依赖任务"
            values={form.dependencyIds as string[]}
            set={(v) => set("dependencyIds", v)}
            items={data.tasks.filter((x) => x.id !== currentId)}
          />
        </>
      )}
      {module === "bugs" && (
        <>
          <LookupSelect
            label="关联需求"
            value={form.requirementId as string}
            set={(v) => set("requirementId", v)}
            items={data.requirements}
            optional
          />
          <LookupSelect
            label="关联任务"
            value={form.taskId as string}
            set={(v) => set("taskId", v)}
            items={data.tasks}
            optional
          />
          <LookupSelect
            label="发现版本"
            value={form.foundVersionId as string}
            set={(v) => set("foundVersionId", v)}
            items={data.versions}
            optional
          />
          <LookupSelect
            label="修复版本"
            value={form.fixedVersionId as string}
            set={(v) => set("fixedVersionId", v)}
            items={data.versions}
            optional
          />
        </>
      )}
      <Area
        label="详细说明"
        value={form.description as string}
        set={(v) => set("description", v)}
        wide
      />
      <Area
        label={module === "bugs" ? "复现步骤" : "验收条件"}
        value={
          (module === "bugs"
            ? form.reproduceSteps
            : form.acceptanceCriteria) as string
        }
        set={(v) =>
          set(module === "bugs" ? "reproduceSteps" : "acceptanceCriteria", v)
        }
        wide
      />
    </>
  );
}

function initial(module: Module, item: Item | null): FormState {
  const d: Record<string, unknown> = item || {};
  const dt = (value: unknown) => toScheduleInput(value as string | null | undefined);
  if (module === "versions")
    return {
      name: String(d.name || ""),
      goal: String(d.goal || ""),
      status: String(d.status || "PLANNING"),
      plannedAt: dt(d.plannedAt),
      description: String(d.description || ""),
      ownerId: String(d.ownerId || ""),
      participantIds: participantIds(d.participants),
      fileIds: Array.isArray(d.fileIds) ? (d.fileIds as string[]) : [],
    };
  if (module === "releases")
    return {
      versionId: String(d.versionId || ""),
      build: String(d.build || ""),
      environment: String(d.environment || "预发布"),
      notes: String(d.notes || ""),
      rollbackPlan: String(d.rollbackPlan || ""),
      status: String(d.status || "PLANNED"),
      releasedAt: dt(d.releasedAt),
    };
  return {
    title: String(d.title || ""),
    description: String(d.description || ""),
    acceptanceCriteria: String(d.acceptanceCriteria || ""),
    reproduceSteps: String(d.reproduceSteps || ""),
    priority: String(d.priority || "MEDIUM"),
    severity: String(d.severity || "MEDIUM"),
    status: String(
      d.status ||
        (module === "tasks" ? "TODO" : module === "bugs" ? "NEW" : "DRAFT"),
    ),
    targetVersionId: String(d.targetVersionId || ""),
    ownerId: String(d.ownerId || ""),
    requirementId: String(d.requirementId || ""),
    versionId: String(d.versionId || ""),
    assigneeId: String(d.assigneeId || ""),
    coordinatorId: String(d.coordinatorId || ""),
    acceptorId: String(d.acceptorId || ""),
    plannedStartAt: dt(d.plannedStartAt) || (module === "requirements" && !item ? toScheduleInput(new Date()) : ""),
    dueAt: dt(d.dueAt),
    taskId: String(d.taskId || ""),
    foundVersionId: String(d.foundVersionId || ""),
    fixedVersionId: String(d.fixedVersionId || ""),
    dependencyIds: Array.isArray(d.dependencies)
      ? (d.dependencies as Array<{ dependsOnId: string }>).map(
          (x) => x.dependsOnId,
        )
      : [],
    participantIds: participantIds(d.participants),
  };
}
function participantIds(value: unknown) {
  return Array.isArray(value)
    ? value.map((entry) => String((entry as { userId?: string }).userId || "")).filter(Boolean)
    : [];
}
function Badge({ value }: { value: string }) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-medium ${value === "URGENT" || value === "FAILED" ? "bg-rose-50 text-rose-700" : value === "HIGH" || value.includes("PENDING") ? "bg-amber-50 text-amber-700" : value === "DONE" || value === "CLOSED" || value === "SUCCEEDED" || value === "RELEASED" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}
    >
      {labels[value] || value}
    </span>
  );
}
function Input({
  label,
  value,
  set,
  type = "text",
  wide = false,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
  type?: string;
  wide?: boolean;
}) {
  return (
    <label className={wide ? "sm:col-span-2" : ""}>
      <span className="mb-2 block text-sm font-medium">{label}</span>
      <input
        required
        value={value}
        type={type}
        onChange={(e) => set(e.target.value)}
        className="field"
      />
    </label>
  );
}
function Area({
  label,
  value,
  set,
  wide = false,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
  wide?: boolean;
}) {
  return (
    <label className={wide ? "sm:col-span-2" : ""}>
      <span className="mb-2 block text-sm font-medium">{label}</span>
      <textarea
        required
        value={value}
        onChange={(e) => set(e.target.value)}
        className="field min-h-24 resize-y"
      />
    </label>
  );
}
function Select({
  label,
  value,
  set,
  options,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
  options: string[];
}) {
  return (
    <label>
      <span className="mb-2 block text-sm font-medium">{label}</span>
      <SelectField
        value={value}
        onChange={set}
        options={options.map((option) => ({
          value: option,
          label: labels[option] || option,
        }))}
      />
    </label>
  );
}
function LookupSelect({
  label,
  value,
  set,
  items,
  optional = false,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
  items: Array<Record<string, unknown>>;
  optional?: boolean;
}) {
  return (
    <label>
      <span className="mb-2 block text-sm font-medium">{label}</span>
      <SelectField
        value={value}
        onChange={set}
        placeholder={optional ? "不关联" : "请选择"}
        options={[
          { value: "", label: optional ? "不关联" : "请选择" },
          ...items.map((item) => ({
            value: String(item.id),
            label: `${String(item.code ? `${item.code} · ` : "")}${String(item.title || item.name)}`,
          })),
        ]}
      />
    </label>
  );
}
function MultiSelect({
  label,
  values,
  set,
  items,
  emptyText = "暂无可选项",
}: {
  label: string;
  values: string[];
  set: (v: string[]) => void;
  items: Array<Record<string, unknown> & { id: string }>;
  emptyText?: string;
}) {
  return (
    <label className="sm:col-span-2">
      <span className="mb-2 block text-sm font-medium">{label}</span>
      <div className="max-h-32 overflow-auto rounded-xl border border-slate-200 p-2">
        {items.length ? (
          items.map((x) => (
            <label
              key={x.id}
              className="flex items-center gap-2 rounded-lg p-2 text-sm hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={values.includes(x.id)}
                onChange={() =>
                  set(
                    values.includes(x.id)
                      ? values.filter((v) => v !== x.id)
                      : [...values, x.id],
                  )
                }
              />
              {x.code ? `${String(x.code)} · ` : ""}{String(x.title || x.name)}
            </label>
          ))
        ) : (
          <span className="block p-2 text-sm text-slate-400">{emptyText}</span>
        )}
      </div>
    </label>
  );
}

function MarkdownPreview({ value }: { value: string }) {
  return (
    <div className="sm:col-span-2">
      <span className="mb-2 block text-sm font-medium">Markdown 预览</span>
      <div className="min-h-24 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700 [&_a]:text-blue-600 [&_blockquote]:border-l-2 [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-slate-200 [&_code]:px-1 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_p+p]:mt-2">
        {value.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown> : <span className="text-slate-400">输入版本描述后在这里预览</span>}
      </div>
    </div>
  );
}
