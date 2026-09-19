export async function GET(request: Request) {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "");
  const origin = host ? `${protocol}://${host}` : new URL(request.url).origin;
  const guide = `# AIPMS CLI 使用说明

Chorify CLI 让真人用户授权的 AI/Codex 通过 API Key 查询和操作项目数据。所有写操作仍归属于 API Key 所属的真人用户，并进入操作日志。

## 一键安装

\`\`\`bash
curl -fsSL ${origin}/cli | bash
export PATH="$HOME/.local/bin:$PATH"
\`\`\`

安装脚本会按系统类型选择安装方式：Linux/macOS 使用 Bash，Windows 使用 PowerShell。它会打开 ${origin}，请在网页中创建或复制 API Key，然后粘贴到安装程序的隐藏输入中。脚本不会自动注册设备、创建租户或生成 API Key；它会把配置保存到执行安装命令时的当前目录 \`.aipms/config\`，并把 skill 保存到 \`.agents/skills/aipms-project-operations/SKILL.md\`。

## 登录与能力检查

先在 Chorify 的“系统管理 → API Key”创建 Key，选择项目和权限。完整 Key 只展示一次。

\`\`\`bash
aipms auth login --api-key 'chp_xxx'
aipms doctor --json
aipms context
\`\`\`

也可不落盘，通过环境变量运行：

\`\`\`bash
export AIPMS_API_KEY='chp_xxx'
export AIPMS_BASE_URL='${origin}'
aipms context
\`\`\`

## 常用操作

\`\`\`bash
aipms list projects
aipms list tasks <project-id>
aipms get tasks <project-id> <task-id>
aipms create requirements <project-id> '{"title":"登录与注册","priority":"HIGH"}'
aipms create tasks <project-id> '{"title":"实现登录页","priority":"HIGH"}'
aipms update tasks <project-id> <task-id> '{"status":"IN_PROGRESS"}'
aipms task-context <task-id>
aipms task-report <task-id> '{"summary":"已完成登录页","details":"构建与测试通过"}'
aipms task-accept <task-id> '{"decision":"PASS","conclusion":"验收标准已满足","verificationEvidence":"测试与交付物均已核对"}'
\`\`\`

支持资源：projects、requirements、tasks、bugs、versions、releases、members、milestones、files、folders、teams、notifications、audit-logs。

未封装的接口可使用：

\`\`\`bash
aipms raw GET /api/v1/me/work-context
aipms raw PATCH /api/v1/projects/<project-id> '{"description":"新的项目简介"}'
\`\`\`

## 给 AI 的最短指令

> 安装 AIPMS CLI：Linux/macOS 运行 \`curl -fsSL ${origin}/cli | bash\`；Windows 运行 \`irm ${origin}/cli/install.ps1 | iex\`。然后使用我提供的 API Key 登录，先运行 \`aipms context\` 获取本人任务、对接人和项目范围。任何写操作前先确认目标项目与资源，写操作后读取结果并汇报；不得扩大权限、管理 API Key、删除项目或执行正式发布。

## 安全

- 不要把 API Key 写进仓库、任务描述或聊天公开内容。
- Key 仅保存在当前目录的 \`.aipms/config\`（权限 600），可用 \`aipms auth logout\` 删除本机凭据。
- 最终权限为真人用户权限、项目成员权限、Key 项目范围和 Key 权限范围的交集。
- 建议为不同 AI/设备创建不同 Key，并设置有效期；泄露时立即在网页撤销。
`;
  return new Response(guide, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
