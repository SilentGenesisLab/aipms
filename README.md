# Chorify Projects

> 面向真人团队与 Codex 协作的 AI Native 团队协同开发系统。

[在线体验](https://aipms.sligenai.cn) · [健康检查](https://aipms.sligenai.cn/api/health) · [完整 BP 与产品说明](docs/Chorify-Projects-BP.md)

Chorify Projects 将项目上下文、真人责任、AI 授权、成果汇报和验收发布统一到一个系统中。团队成员可以指挥 Codex 完成研发或文档工作，再通过个人 API Key 将真实结果提交回对应任务；AI 不作为独立成员，也不能替代真人作出验收或正式发布决定。

## 为什么需要 Chorify Projects

AI 辅助开发提高了执行速度，也让工作分散在多个会话、仓库和个人环境中。传统项目管理系统往往只能看到任务标题，无法确认 AI 做了什么、由谁授权、成果在哪里以及是否真正验收。

- 多个 Codex 会话与项目任务脱节；
- AI 操作缺少真人身份、项目范围和权限约束；
- “代码完成、提交汇报、验收通过、正式发布”被混为一谈；
- 个人项目与团队权限相互限制；
- 需求、任务、Bug、版本、文件和审计记录分散。

## 核心流程

```text
真人提出目标与需求
      ↓
Chorify 记录成员、任务、依赖与验收标准
      ↓
Codex 在个人 API Key 授权范围内读取和执行
      ↓
提交工作汇报、交付物与验收申请
      ↓
真人验收 → Bug 修复 → 版本发布 → 操作留痕
```

## 已实现功能

### 团队与项目

- 团队使命、介绍、职责、成员岗位和个人介绍；
- 团队邀请、所有者/管理员/成员/访客角色；
- 团队 OKR、KR、成员对齐和进度检查；
- 交付、协同、验收及近 30 日贡献趋势；
- 指定成员和全员站内消息；
- 所有用户均可创建个人项目和自己的团队；
- 个人项目、团队项目独立权限与筛选；
- 项目成员、职责、里程碑和个人项目转入团队。

### 研发交付闭环

- 仪表盘：项目健康度、待办、延期风险、待验收和版本进度；
- 需求管理：增删改查、参与人、优先级、验收条件和可选目标版本；
- 任务中心：我的任务、我派出的、负责人、对接人、验收人和依赖；
- 工作汇报与真人验收：待处理、进行中、待验收、需修改、已通过、已完成；
- Bug 管理：提出、确认、分配、修复、验证、待发布和关闭；
- 版本与发布：范围聚合、里程碑、构建、环境、结果和回滚记录；
- 文件管理：目录、上传、文件版本、标签、分享及工作项引用；
- 操作日志：统一展示网页及 API Key 对项目的操作。

### 账户与安全

- 手机号密码登录、短信验证码和用户注册；
- 默认鉴权及未登录跳转；
- 账户名、密码、改绑手机号和头像设置；
- 深色/浅色模式；
- 每位用户可创建多个 API Key；
- 多项目授权、细粒度权限、有效期、编辑和撤销；
- 密钥原文只展示一次，数据库只保存哈希；
- 权限取真人权限、项目成员权限、Key 项目范围和 Key 权限的交集。

### 项目成员档案与 AI 工具用量

- 项目成员可设置当前项目内的显示名、头像、岗位、职责和介绍，不修改全局账户资料；
- 团队“个人信息”汇总当前团队的需求提出与闭环、本周完成、当前任务和待验收任务；
- 支持 Windows 与 macOS 采集器统计 Codex 与 Claude Code 的输入、输出、缓存和推理 Token；
- 一次性安装注册码 10 分钟有效，设备凭据分别使用 Windows DPAPI 与 macOS Keychain 保护；
- 采集器每 30 分钟增量上报，只上传用量汇总，不上传提示词、聊天正文、代码、文件内容或密钥；
- Token 是成员个人全部 AI 工具用量，不归因到当前项目。

## 需求、任务与版本关系

需求不强制关联版本。临时需求可以直接拆任务、验收并完成；需要统一构建和发布的需求可以关联目标版本。

```text
临时需求：需求 → 任务 → 验收 → 完成
版本需求：需求 → 版本 → 任务 → 验收 → 测试 → 发布 → 完成
```

需求状态为“草稿 → 评审中 → 已确认 → 开发中 → 已完成”。“已确认”表示需求已经完成评审；任务验收记录由指定真人验收人提交。

## 技术栈

- Next.js 16 App Router、React 19、TypeScript
- Tailwind CSS、Lucide、Recharts
- PostgreSQL、Prisma 6
- Zod、jose、bcryptjs
- 阿里云短信、S3 兼容文件存储
- Vitest、ESLint、Docker Compose、Nginx

## 本地启动

环境要求：Node.js、npm、Docker 和 Docker Compose。

1. 复制 `.env.example` 为 `.env`，填写数据库、`AUTH_SECRET`、短信及文件存储配置。
2. 启动 PostgreSQL：`docker compose up -d postgres`。
3. 安装依赖：`npm install`。
4. 初始化数据：`npm run db:generate && npm run db:migrate -- --name init && npm run db:seed`。
5. 启动网站：`npm run dev`。

演示账户为 `13800000001`，种子密码为 `Chorify2026!`。请勿在生产环境使用演示凭据。

## Codex API

个人 API Key 使用请求头 `Authorization: Bearer chp_...`。当前管理和任务上下文接口包括：

- `GET /api/v1/tokens`：网页登录用户查询自己的令牌和可授权项目
- `POST /api/v1/tokens`：创建令牌，完整密钥只返回一次
- `PATCH /api/v1/tokens/:tokenId`：修改名称、项目范围、权限和有效期
- `DELETE /api/v1/tokens/:tokenId`：不可恢复地撤销令牌
- `GET /api/v1/me/work-context`：需要 `task:read`
- `GET /api/v1/tasks/:taskId/context`：需要 `task:read`
- `PATCH /api/v1/tasks/:taskId`：快捷调整优先级或合法状态，需要 `task:update`
- `POST /api/v1/tasks/:taskId/reports`：需要 `task:report`
- `POST /api/v1/tasks/:taskId/acceptances`：仅指定验收人可通过闭环或退回，需要 `task:accept` 和 `Idempotency-Key`

创建任务时应提交从项目成员中解析出的明确 `assigneeId`。未指定验收人时，系统优先使用关联需求的提出者，没有关联需求时使用任务创建人；验收通过后任务直接闭环为 `DONE`。

令牌支持多项目和细粒度权限。业务接口同时校验用户项目成员身份、令牌项目范围和所需权限。已预留 `project:*`、`requirement:*`、`task:*`、`bug:*`、`version:*`、`file:*` 和 `document:*` 权限命名空间。

完整 Key 不应进入仓库、日志或文档；暴露后请立即撤销并重新创建。

## Token 用量采集

登录后进入“团队管理”，打开团队详情的“个人信息”，点击“接入 Token 统计”，选择 Windows 或 macOS 后复制对应命令。一次性注册码只能在一台设备上使用一次：Windows 使用 PowerShell、DPAPI 和 `ChorifyUsageCollector` 计划任务；macOS 使用“终端”、登录钥匙串和 `~/Library/LaunchAgents/cn.sligenai.chorify-usage.plist`，两端都每 30 分钟增量上报一次。

公开安装脚本地址为 `https://aipms.sligenai.cn/token-usage/install.ps1`（Windows）和 `https://aipms.sligenai.cn/token-usage/install.sh`（macOS）。macOS 端无需 Node.js 或管理员权限，使用系统自带的 Bash、JavaScript for Automation、Keychain 与 LaunchAgent；采集程序位于 `~/.chorify-usage`，扫描 `~/.codex/sessions` 与 `~/.claude/projects`，仅上传 Token、会话数和活跃时长汇总。请始终从项目页面生成完整安装命令，不要手工共享注册码。用户可以在个人信息页面查看设备健康状态或撤销设备；撤销后该设备立即无法继续上报。

## 开发验证

```bash
npm run test
npm run lint
npm run build
```

## 预发布部署

当前预发布地址：[https://aipms.sligenai.cn](https://aipms.sligenai.cn)。

预发布环境使用 `deploy/docker-compose.staging.yml`，应用仅监听服务器回环地址 `127.0.0.1:3308`，由 Nginx 对外提供访问。健康检查地址为 [https://aipms.sligenai.cn/api/health](https://aipms.sligenai.cn/api/health)。

服务器代码目录为 `/home/donxu/webServer/aipmf`，跟踪 `uat` 分支。以后代码合并并推送到 `uat` 后，在服务器执行：

```bash
cd /home/donxu/webServer/aipmf
bash deploy/update-staging.sh
```

脚本使用 `git pull --ff-only` 拉取仓库，然后执行数据库迁移、镜像构建和容器更新；`.env.staging` 只保存在服务器，不提交到 Git。

## 产品文档

- [BP 与完整功能说明](docs/Chorify-Projects-BP.md)

## 当前阶段

项目目前处于核心流程真实可用的预发布验证阶段。下一步重点是补齐开放业务 API 和 CLI、提高稳定性，并通过目标客户访谈验证部署偏好、核心场景和商业模式。
