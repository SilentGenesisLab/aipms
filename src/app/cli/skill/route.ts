const skill = `---
name: aipms-project-operations
description: Operate AIPMS projects through a real user's API Key for projects, tasks, reports, acceptance, files, releases, and audit.
---

# AIPMS Project Operations

Use only a real user's API Key. The installer never registers a device, creates a tenant, or creates an API Key automatically. The user must create or copy the key from https://aipms.sligenai.cn.

## Local setup

The installer stores the credential in the current directory at \`.aipms/config\` with restrictive permissions and installs this skill at \`.agents/skills/aipms-project-operations/SKILL.md\`. Never print or commit the full key.

Run \`aipms doctor --json\` before work. It checks identity, work context, projects, teams, notifications, and audit-log access. A 403 means the key lacks that capability; do not bypass the permission.

## Rules

- Read the work context and target resource before writing.
- Use IDs returned by the API; do not guess IDs from titles.
- Confirm the target project and resource before destructive actions, acceptance, or release.
- Force-closing (\`task-force-close\`) closes a task without the report-and-acceptance handover and is reserved for a project owner acting on explicit human instruction; it is never a shortcut to "done".
- After a write, read the resource again and report the result.
- Never create an AI member, impersonate an acceptor, or decide formal acceptance/release without explicit human authorization.
- Do not expose API Keys, passwords, hashes, or verification codes.

## Common commands

\`\`\`bash
aipms doctor --json
aipms context
aipms list projects
aipms list tasks <project-id>
aipms get tasks <project-id> <task-id>
aipms task-report <task-id> '{"summary":"..."}'
aipms task-accept <task-id> '{"decision":"PASS"}'
aipms task-force-close <task-id> '{"reason":"..."}'
\`\`\`
`;

export function GET() {
  return new Response(skill, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
