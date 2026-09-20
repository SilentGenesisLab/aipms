export const API_TOKEN_PERMISSIONS = [
  "dashboard:read", "audit:read", "notification:read",
  "team:read", "team:create", "team:update", "team:member:manage", "team:invite:manage",
  "weekly_report:read", "weekly_report:write",
  "okr:read", "okr:write", "message:read", "message:write", "analytics:read",
  "project:read", "project:create", "project:update", "project:delete", "project:member:manage",
  "milestone:read", "milestone:create", "milestone:update", "milestone:delete",
  "requirement:read", "requirement:create", "requirement:update", "requirement:delete",
  "task:read", "task:create", "task:update", "task:delete", "task:report", "task:accept", "task:force_close",
  "bug:read", "bug:create", "bug:update", "bug:delete",
  "version:read", "version:create", "version:update", "version:delete",
  "release:read", "release:create", "release:update", "release:delete", "release:finalize",
  "file:read", "file:create", "file:update", "file:delete", "file:share", "file:link",
  "document:read", "document:write",
] as const;

export type ApiTokenPermission = typeof API_TOKEN_PERMISSIONS[number];

export const API_PERMISSION_GROUPS: ReadonlyArray<{
  key: string;
  label: string;
  permissions: readonly ApiTokenPermission[];
}> = [
  { key: "system", label: "工作台", permissions: ["dashboard:read", "notification:read", "audit:read"] },
  { key: "team", label: "团队", permissions: ["team:read", "team:create", "team:update", "team:member:manage", "team:invite:manage"] },
  { key: "collaboration", label: "团队协作", permissions: ["weekly_report:read", "weekly_report:write", "okr:read", "okr:write", "message:read", "message:write", "analytics:read"] },
  { key: "project", label: "项目", permissions: ["project:read", "project:create", "project:update", "project:delete", "project:member:manage"] },
  { key: "milestone", label: "里程碑", permissions: ["milestone:read", "milestone:create", "milestone:update", "milestone:delete"] },
  { key: "requirement", label: "需求", permissions: ["requirement:read", "requirement:create", "requirement:update", "requirement:delete"] },
  { key: "task", label: "任务", permissions: ["task:read", "task:create", "task:update", "task:delete", "task:report", "task:accept", "task:force_close"] },
  { key: "bug", label: "Bug", permissions: ["bug:read", "bug:create", "bug:update", "bug:delete"] },
  { key: "version", label: "版本与发布", permissions: ["version:read", "version:create", "version:update", "version:delete", "release:read", "release:create", "release:update", "release:delete", "release:finalize"] },
  { key: "file", label: "文件与文档", permissions: ["file:read", "file:create", "file:update", "file:delete", "file:share", "file:link", "document:read", "document:write"] },
];

export const API_PERMISSION_LABELS: Record<ApiTokenPermission, string> = {
  "dashboard:read": "查看工作台", "audit:read": "查看操作日志", "notification:read": "查看通知",
  "team:read": "查看团队", "team:create": "创建团队", "team:update": "修改团队资料", "team:member:manage": "管理团队成员", "team:invite:manage": "管理邀请链接",
  "weekly_report:read": "查看周报", "weekly_report:write": "编写本人周报",
  "okr:read": "查看 OKR", "okr:write": "管理 OKR", "message:read": "查看团队消息", "message:write": "发送和管理消息", "analytics:read": "查看团队分析",
  "project:read": "查看项目", "project:create": "创建项目", "project:update": "修改项目", "project:delete": "删除项目", "project:member:manage": "管理项目成员",
  "milestone:read": "查看里程碑", "milestone:create": "创建里程碑", "milestone:update": "修改里程碑", "milestone:delete": "删除里程碑",
  "requirement:read": "查看需求", "requirement:create": "创建需求", "requirement:update": "修改需求", "requirement:delete": "删除需求",
  "task:read": "查看任务", "task:create": "创建任务", "task:update": "修改任务", "task:delete": "删除任务", "task:report": "提交工作汇报", "task:accept": "任务验收", "task:force_close": "强制关闭任务（仅项目所有者）",
  "bug:read": "查看 Bug", "bug:create": "创建 Bug", "bug:update": "修改 Bug", "bug:delete": "删除 Bug",
  "version:read": "查看版本", "version:create": "创建版本", "version:update": "修改版本", "version:delete": "删除版本",
  "release:read": "查看发布记录", "release:create": "创建发布记录", "release:update": "修改发布记录", "release:delete": "删除发布记录", "release:finalize": "确认发布结论",
  "file:read": "查看和下载文件", "file:create": "上传文件和新建文件夹", "file:update": "修改和恢复文件", "file:delete": "删除文件", "file:share": "管理文件分享", "file:link": "管理业务引用",
  "document:read": "查看文档", "document:write": "写入文档",
};

export const HIGH_RISK_API_PERMISSIONS: ApiTokenPermission[] = [
  "team:member:manage", "team:invite:manage", "project:delete", "project:member:manage",
  "milestone:delete", "requirement:delete", "task:delete", "task:accept", "task:force_close", "bug:delete",
  "version:delete", "release:delete", "release:finalize", "file:delete", "file:share",
];

export const READ_ONLY_API_PERMISSIONS: ApiTokenPermission[] = API_TOKEN_PERMISSIONS.filter(
  (permission) => permission.endsWith(":read"),
);

export const DEFAULT_API_PERMISSIONS: ApiTokenPermission[] = [
  "dashboard:read", "notification:read", "team:read", "weekly_report:read", "weekly_report:write",
  "okr:read", "message:read", "analytics:read", "project:read", "milestone:read",
  "requirement:read", "requirement:create", "requirement:update",
  "task:read", "task:create", "task:update", "task:report",
  "bug:read", "bug:create", "bug:update", "version:read", "version:create", "version:update",
  "release:read", "file:read", "file:create", "file:update", "file:link", "document:read", "document:write",
];

export const hasApiPermission = (permissions: readonly string[], required: ApiTokenPermission) =>
  permissions.includes(required);
