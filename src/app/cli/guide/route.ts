export async function GET(request: Request) {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "");
  const origin = host ? `${protocol}://${host}` : new URL(request.url).origin;
  const guide = `# AIPMS CLI 使用说明

AIPMS CLI 让真人用户授权的 AI/Codex 通过 API Key 查询和操作项目数据。所有写操作仍归属于 API Key 所属的真人用户，并进入操作日志。

## 一键安装

Linux / macOS：

\`\`\`bash
curl -fsSL ${origin}/cli | bash
export PATH="$HOME/.local/bin:$PATH"
\`\`\`

Windows PowerShell：

\`\`\`powershell
irm ${origin}/cli/install.ps1 | iex
\`\`\`

安装器会打开 ${origin}，请在网页中创建或复制 API Key，然后粘贴到安装程序的隐藏输入中。脚本不会自动注册设备、创建租户或生成 API Key；它会把凭据保存到 \`~/.aipms/config\`（Windows 上是 \`%USERPROFILE%\\.aipms\\config\`），并把 skill 保存到当前目录的 \`.agents/skills/aipms-project-operations/SKILL.md\`。Windows 上还会在 \`%USERPROFILE%\\.local\\bin\` 生成 \`aipms.cmd\` 代理并写入用户 PATH，新开终端后 cmd.exe 与 PowerShell 都能直接调用。

凭据按 \`AIPMS_CONFIG\` 环境变量 → 当前目录 \`.aipms/config\` → \`~/.aipms/config\` 的顺序解析，因此安装一次即可在任意目录使用；需要独立 Key 的工作区放一份本地 \`.aipms/config\` 即可覆盖全局。

## 登录与能力检查

先在 AIPMS 的“系统管理 → API Key”创建 Key，选择项目和权限。完整 Key 只展示一次。

\`\`\`bash
aipms auth login --api-key 'chp_xxx'
aipms doctor --json
aipms context
\`\`\`

也可不落盘，通过环境变量运行（环境变量优先于已保存的配置文件，可用于临时切换身份）：

\`\`\`bash
export AIPMS_API_KEY='chp_xxx'
export AIPMS_BASE_URL='${origin}'
aipms context
\`\`\`

## 收窄 context 的输出

\`context\` 默认返回本人全部待办的完整字段。任务多时（几十条可以达到数十 KB）用参数收窄，避免把整份 JSON 落盘再二次处理：

\`\`\`bash
aipms context --status PENDING_ACCEPTANCE                    # 只看待验收
aipms context --project <id|code> --status TODO,IN_PROGRESS  # 按项目和状态
aipms context --fields code,title,status,dueAt --limit 20    # 只取需要的字段
\`\`\`

\`total\` 是过滤后命中的总数，\`tasks\` 是本次返回的条目（受 \`limit\` 限制）。

另外，\`aipms list tasks <project-id>\` 返回的每条任务已经带有 \`status\`、\`submittedAt\` 和 \`_count.reports\`（汇报数），所以「哪些待验收、有没有交报告」一次调用就能看完，不必逐条拉 \`task-context\`。

## 常用操作

\`\`\`bash
aipms list projects
aipms list tasks <project-id>
aipms get tasks <project-id> <task-id>
aipms create requirements <project-id> '{"title":"登录与注册","acceptanceCriteria":"可注册新账号并用密码登录","priority":"HIGH","status":"DRAFT"}'
aipms create tasks <project-id> '{"title":"实现登录页","acceptanceCriteria":"登录成功跳转工作台","priority":"HIGH"}'
aipms update tasks <project-id> <task-id> '{"status":"IN_PROGRESS"}'
aipms task-context <task-id>
aipms task-report <task-id> '{"summary":"已完成登录页","completedItems":["实现登录表单","接入短信验证码"],"verification":"构建与测试通过"}'
aipms task-accept <task-id> '{"decision":"PASS","conclusion":"验收标准已满足","verificationEvidence":"测试与交付物均已核对"}'
aipms task-force-close <task-id> '{"reason":"项目范围调整，交付物另行归档"}'
\`\`\`

支持资源：projects、requirements、tasks、bugs、versions、releases、members、milestones、files、folders、teams、notifications、audit-logs。

未封装的接口可使用：

\`\`\`bash
aipms raw GET /api/v1/me/work-context
aipms raw PATCH /api/v1/projects/<project-id> '{"description":"新的项目简介"}'
\`\`\`

## 强制关闭任务（仅项目创建者）

项目创建者需要跳过「汇报 → 验收」交接直接闭环时，使用 \`task-force-close\`。它跳过的只是交接流程，不跳过留痕：任务直接置为已完成，并在任务详情里写入一条结果为「项目创建者强制关闭」的验收记录和一条 \`FORCE_CLOSE_TASK\` 操作日志。

\`\`\`bash
aipms task-force-close <task-id> '{"reason":"项目范围调整，交付物另行归档"}'
\`\`\`

- 需要在 API Key 上勾选「强制关闭任务（仅项目所有者）」权限（\`task:force_close\`）。
- 调用者必须是该项目的所有者，即项目创建者；仅项目成员或管理员会返回 403。
- 已闭环（已完成/已通过）的任务返回 409，不重复写入记录。
- \`reason\` 必填，3–3000 个字符，用于说明为什么跳过交接。
- 属于高风险权限，限速 100 次/分钟：批量关闭多条任务时按此节奏调用，不要并发。

## 给 AI 的最短指令

> 安装 AIPMS CLI：Linux/macOS 运行 \`curl -fsSL ${origin}/cli | bash\`；Windows 运行 \`irm ${origin}/cli/install.ps1 | iex\`。然后使用我提供的 API Key 登录，先运行 \`aipms context\` 获取本人任务、对接人和项目范围。任何写操作前先确认目标项目与资源，写操作后读取结果并汇报；不得扩大权限、管理 API Key、删除项目或执行正式发布。

## 安全

- 不要把 API Key 写进仓库、任务描述或聊天公开内容。
- Key 保存在 \`~/.aipms/config\`，或工作区内的 \`.aipms/config\`（权限均为 600），可用 \`aipms auth logout\` 删除当前生效的凭据。
- 最终权限为真人用户权限、项目成员权限、Key 项目范围和 Key 权限范围的交集。
- 建议为不同 AI/设备创建不同 Key，并设置有效期；泄露时立即在网页撤销。
`;
  return new Response(guide, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
