---
name: aipms-project-operations
description: Operate AIPMS projects through a real user's API Key for projects, tasks, reports, acceptance, files, releases, and audit.
---

# AIPMS Project Operations

AIPMS 的责任主体始终是真人。Codex 只使用该真人的 API Key 执行明确指令，不创建 AI 成员，不伪造验收人，也不自行决定正式发布。

## 开始前

1. 优先从安全环境变量读取 API Key；若使用 CLI 安装器生成的本地配置，确保 `.aipms/config` 权限为 600，并且绝不把完整 Key 写入日志、命令输出、仓库或汇报。
2. 先读取工作上下文和目标资源，使用系统返回的 ID，不凭标题猜资源。
3. 读取可直接进行；删除、验收结论和正式发布必须有真人明确指令。
4. 权限不足时不要绕过 API 或直接修改数据库。

## 任务规则

- 读取 [references/workflows.md](references/workflows.md) 后再创建、推进或验收任务。
- 从项目成员中匹配描述里第一个被提及且最相关的人，并把明确用户 ID 作为 `assigneeId`。用户另有指定时优先；无法唯一匹配时先确认。
- 显式 `acceptorId` 优先；否则由系统使用关联需求提出者，未关联需求时使用任务创建人。
- 负责人可以把任务推进到 `PENDING_ACCEPTANCE`；只有指定验收人可以通过闭环或退回，管理员不能代验收。
- 验收和接口调用格式见 [references/api-contract.md](references/api-contract.md)。
- 写入后重新读取资源，确认状态、负责人和验收人，再汇报结果。

## 汇报

列出操作账户、项目、资源编号、负责人、验收人、成功项和失败项。不要回显完整 API Key、密码、哈希、验证码或存储凭据。
